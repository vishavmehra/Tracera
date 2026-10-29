// Bench Shop evaluator. Runs each case through the real API (HTTP on
// 127.0.0.1), the real worker and queue, the configured inference provider, and the Docker sandbox,
// then grades the stored results against the answer key in eval/bench-shop. Hidden tests run in the
// same sandbox against the exact stored diff. The evaluator never reports results without Docker.
// It uses its own database (tracera_eval, recreated per run) and data directory (<data dir>/eval).
//
//   npm run bench:eval                      all cases, provider from .env
//   npm run bench:eval -- --cases B1,N1     selected cases
//   npm run bench:eval -- --fixture-check   sandbox self-check of the benchmark itself (no model calls)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { buildApp } from "../apps/server/src/api/app.ts";
import {
	type Config,
	describeConfig,
	loadConfig,
	resolveDataDir,
} from "../apps/server/src/config.ts";
import {
	assertDisposableDatabase,
	createDb,
	createPool,
} from "../apps/server/src/db/client.ts";
import { runMigrations } from "../apps/server/src/db/migrate.ts";
import { seedOwner } from "../apps/server/src/db/seed.ts";
import { parseTap } from "../apps/server/src/modules/verification.ts";
import {
	applyStoredDiff,
	cloneAtCommit,
	removeWorkspace,
	workspacePath,
} from "../apps/server/src/modules/workspace.ts";
import { startQueue } from "../apps/server/src/queue.ts";
import {
	createExecutor,
	createProvider,
	startWorker,
} from "../apps/server/src/worker/handlers.ts";
import {
	type BenchManifest,
	loadManifest,
	setupBenchShop,
} from "./bench-setup.ts";

type Case = BenchManifest["cases"][number];
type Criterion = { criterion: string; passed: boolean; evidence: string };

const ROOT = path.resolve(import.meta.dirname, "..");
const TERMINAL = new Set([
	"awaiting_approval",
	"completed",
	"failed",
	"cancelled",
]);
const CASE_TIMEOUT_MS = 20 * 60_000;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const { values: args } = parseArgs({
	options: {
		cases: { type: "string" },
		"fixture-check": { type: "boolean", default: false },
	},
});

function fail(message: string, code = 1): never {
	console.error(`bench:eval: ${message}`);
	process.exit(code);
}

// ---- Configuration: a fresh evaluation database and data directory, the Docker sandbox ------------

// The evaluation database is dropped and recreated per run, so it lives on the local Postgres.
const baseUrl =
	process.env.EVAL_DATABASE_URL ??
	process.env.TEST_DATABASE_URL ??
	process.env.DATABASE_URL;
if (!baseUrl)
	fail("EVAL_DATABASE_URL or DATABASE_URL is not set (see .env.example)");
try {
	assertDisposableDatabase(baseUrl, "bench:eval");
} catch (error) {
	fail((error as Error).message);
}
const evalUrl = new URL(baseUrl);
evalUrl.pathname = "/tracera_eval";
let config: Config;
try {
	config = loadConfig({
		...process.env,
		DATABASE_URL: evalUrl.toString(),
		TRACERA_DATA_DIR: path.join(resolveDataDir(process.env), "eval"),
		TRACERA_SANDBOX_MODE: "docker",
		// Request logs would drown the evaluation report; warnings and errors still print.
		LOG_LEVEL: "warn",
	});
} catch (error) {
	fail((error as Error).message);
}
const manifest = loadManifest();
const wanted = args.cases?.split(",");
const selected = wanted
	? manifest.cases.filter((c) => wanted.includes(c.id))
	: manifest.cases;
if (selected.length === 0) fail(`no cases match --cases ${args.cases}`);

const workerId = `bench-eval-${os.hostname()}-${process.pid}`;
const executor = createExecutor(config, workerId);
const sandbox = await executor.status();
if (executor.kind !== "docker" || !sandbox.available)
	fail(
		`BLOCKED: sandbox_unavailable (${sandbox.detail ?? executor.kind}). The evaluator never reports results without the Docker sandbox.`,
		2,
	);
const bench = setupBenchShop(config.dataDir);
const live = config.inference.provider !== "mock";
const label = live ? "[live]" : "[mock]";

/** Clones a branch into an evaluator workspace (inside the workspaces root, never the fixture). */
async function evaluatorCopy(scope: string, name: string, branch: string) {
	const dir = workspacePath(config, scope, name);
	const sha = bench.branches[branch];
	if (!sha) throw new Error(`branch ${branch} was not materialized`);
	const clone = await cloneAtCommit(config, bench.path, dir, sha);
	if (!clone.ok) throw new Error(`evaluator clone failed: ${clone.message}`);
	return dir;
}

/** Runs the case's hidden tests in the sandbox, after applying `diff` exactly when one is given. */
async function runHidden(
	scope: string,
	testCase: Case,
	branch: string,
	diff: string | null,
) {
	const dir = await evaluatorCopy(scope, `${testCase.id}-hidden`, branch);
	if (diff !== null && !(await applyStoredDiff(dir, diff)).ok)
		return { applied: false, result: null, tap: null };
	mkdirSync(path.join(dir, "eval-hidden"), { recursive: true });
	const files = testCase.hidden_tests.map((file) => {
		copyFileSync(
			path.join(ROOT, file),
			path.join(dir, "eval-hidden", path.basename(file)),
		);
		return `eval-hidden/${path.basename(file)}`;
	});
	const result = await executor.run({
		runId: `${scope}-${testCase.id}-hidden`,
		investigationId: scope,
		workspace: dir,
		argv: ["node", "--test", "--test-reporter=tap", ...files],
		env: { CI: "1" },
		timeoutMs: 120_000,
	});
	return { applied: true, result, tap: parseTap(result.stdout) };
}

// ---- Fixture self-check: the benchmark behaves as specified, inside the sandbox ------------------

if (args["fixture-check"]) {
	const scope = `bench-check-${process.pid}`;
	const rows: string[] = [];
	let ok = true;
	for (const testCase of selected) {
		const dir = await evaluatorCopy(
			scope,
			`${testCase.id}-visible`,
			testCase.branch,
		);
		const visible = await executor.run({
			runId: `${scope}-${testCase.id}-visible`,
			investigationId: scope,
			workspace: dir,
			argv: ["npm", "test"],
			env: { CI: "1", NODE_OPTIONS: "--test-reporter=tap" },
			timeoutMs: 120_000,
		});
		const visibleTap = parseTap(visible.stdout);
		const visibleOk = visible.exitCode === 0 && visibleTap.fail === 0;
		let onBug = "n/a";
		let onMain = "n/a";
		if (testCase.hidden_tests.length > 0) {
			const bug = await runHidden(scope, testCase, testCase.branch, null);
			const main = await runHidden(`${scope}-main`, testCase, "main", null);
			onBug =
				bug.tap && bug.tap.fail > 0
					? "fails (expected)"
					: "PASSES (unexpected)";
			onMain =
				main.tap && main.tap.fail === 0 && main.tap.pass > 0
					? "passes (expected)"
					: "FAILS (unexpected)";
			ok &&= onBug.endsWith("(expected)") && onMain.endsWith("(expected)");
		}
		ok &&= visibleOk;
		rows.push(
			`| ${testCase.id} | ${testCase.branch} | ${visibleTap.pass}/${visibleTap.tests} ${visibleOk ? "pass" : "FAIL"} | ${onBug} | ${onMain} |`,
		);
	}
	await removeWorkspace(config, scope);
	await removeWorkspace(config, `${scope}-main`);
	console.log(
		[
			`Bench Shop fixture check (Docker sandbox: ${sandbox.detail})`,
			"",
			"| Case | Branch | Visible suite | Hidden tests on the bug branch | Hidden tests on main |",
			"|---|---|---|---|---|",
			...rows,
			"",
			ok ? "Fixture check passed." : "Fixture check FAILED.",
		].join("\n"),
	);
	process.exit(ok ? 0 : 1);
}

// ---- Full evaluation through the real API, worker, provider, and sandbox -------------------------

const admin = new pg.Client({ connectionString: baseUrl });
await admin
	.connect()
	.catch((error: Error) => fail(`cannot reach Postgres: ${error.message}`));
await admin.query("DROP DATABASE IF EXISTS tracera_eval WITH (FORCE)");
await admin.query("CREATE DATABASE tracera_eval");
await admin.end();
const pool = createPool(config.databaseUrl, "tracera-bench-eval");
await runMigrations(pool);
const db = createDb(pool);
const boss = await startQueue(config.databaseUrl, { role: "worker" });
const app = await buildApp({ config, pool, db, boss });
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const stopWorker = await startWorker({
	config,
	db,
	pool,
	boss,
	provider: createProvider(config),
	executor,
	workerId,
	log: (message, fields) =>
		console.error(`worker: ${message} ${JSON.stringify(fields)}`),
});

const email = "bench-eval@tracera.local";
const password = randomBytes(24).toString("base64url");
await seedOwner(db, {
	email,
	password,
	workspaceName: "Bench evaluation",
	costLog2: 10,
});
const csrf = { "x-tracera-csrf": "1", origin: config.api.publicOrigin };
const loginResponse = await fetch(`${address}/api/v1/auth/login`, {
	method: "POST",
	headers: { ...csrf, "content-type": "application/json" },
	body: JSON.stringify({ email, password }),
});
if (loginResponse.status !== 200)
	fail(`login failed with ${loginResponse.status}`);
const cookie =
	String(loginResponse.headers.get("set-cookie")).split(";")[0] ?? "";
async function api(
	method: "GET" | "POST",
	url: string,
	body?: unknown,
	// biome-ignore lint/suspicious/noExplicitAny: API responses are read structurally by the grader below.
): Promise<any> {
	const response = await fetch(`${address}${url}`, {
		method,
		headers: {
			cookie,
			...(method === "POST"
				? { ...csrf, "content-type": "application/json" }
				: {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400)
		throw new Error(
			`${method} ${url} returned ${response.status}: ${text.slice(0, 300)}`,
		);
	return text ? JSON.parse(text) : null;
}

const repository = (
	await api("POST", "/api/v1/repositories", {
		name: manifest.repository.name,
		source: { type: "fixture", fixture: manifest.fixture },
		commands: manifest.repository.commands,
	})
).repository;

/** 1-based lines of the gold marker in the bug branch (read from Tracera's fixture, not the model). */
function goldLines(testCase: Case): number[] {
	const gold = testCase.gold;
	if (!gold) return [];
	return execFileSync("git", ["show", `${testCase.branch}:${gold.path}`], {
		cwd: bench.path,
		encoding: "utf8",
	})
		.split("\n")
		.flatMap((line, i) => (line.includes(gold.marker) ? [i + 1] : []));
}

type Location = {
	handle: string;
	start_line: number | null;
	end_line: number | null;
};
const results: Array<Record<string, unknown>> = [];
for (const testCase of selected) {
	const started = Date.now();
	console.error(`${label} ${testCase.id}: ${testCase.report.title}`);
	const record: Record<string, unknown> = {
		case: testCase.id,
		branch: testCase.branch,
	};
	try {
		const bug = (
			await api("POST", "/api/v1/bug-reports", {
				...testCase.report,
				repository_id: repository.id,
				normalize: false,
			})
		).bug_report;
		let investigation = (
			await api("POST", "/api/v1/investigations", {
				bug_report_id: bug.id,
				commit: testCase.branch,
			})
		).investigation;
		while (
			!TERMINAL.has(investigation.status) &&
			Date.now() - started < CASE_TIMEOUT_MS
		)
			investigation = (
				await api(
					"GET",
					`/api/v1/investigations/${investigation.id}?wait_seconds=20&known_version=${investigation.state_version}`,
				)
			).investigation;
		const id = investigation.id;
		const findings = await api("GET", `/api/v1/investigations/${id}/findings`);
		const executions = await api(
			"GET",
			`/api/v1/investigations/${id}/model-executions`,
		);
		const report = await api(
			"GET",
			`/api/v1/investigations/${id}/report`,
		).catch(() => null);
		const patches = await api("GET", `/api/v1/investigations/${id}/patches`);
		const verification = investigation.latest_verification
			? (
					await api(
						"GET",
						`/api/v1/verifications/${investigation.latest_verification.id}`,
					)
				).verification
			: null;
		const baseline: string =
			investigation.baseline_reproduction?.status ?? "not_attempted";
		const outcome: string = verification?.outcome ?? "not_attempted";
		const criteria: Criterion[] = [];
		const check = (criterion: string, passed: boolean, evidence: string) =>
			criteria.push({ criterion, passed, evidence });

		if (testCase.gold) {
			const gold = testCase.gold;
			const codePaths = new Map<string, string>(
				findings.code_references.map(
					(c: { handle: string; locator: { path?: string } }) => [
						c.handle,
						c.locator.path ?? "",
					],
				),
			);
			check(
				`Collected context includes ${gold.path}`,
				[...codePaths.values()].includes(gold.path),
				`excerpts: ${[...new Set(codePaths.values())].join(", ") || "none"}`,
			);
			const lines = goldLines(testCase);
			const near = findings.hypotheses
				.filter((h: { rank: number }) => h.rank <= 3)
				.some((h: { locations: Location[] }) =>
					h.locations.some(
						(l) =>
							codePaths.get(l.handle) === gold.path &&
							lines.some(
								(line) =>
									(l.start_line ?? 0) - 10 <= line &&
									line <= (l.end_line ?? 0) + 10,
							),
					),
				);
			check(
				"Top-3 hypotheses include a location within 10 lines of the gold marker",
				near,
				`gold line(s) ${lines.join(", ")}; hypotheses: ${
					findings.hypotheses
						.map(
							(h: { rank: number; title: string }) => `#${h.rank} ${h.title}`,
						)
						.join(" | ") || "none"
				}`,
			);
			check(
				"Baseline reproduction is reproduced",
				baseline === "reproduced",
				`baseline: ${baseline}`,
			);
			const latest = patches.items.at(-1);
			let hidden = "no patch was proposed";
			let hiddenPassed = false;
			if (latest) {
				const diff = (await api("GET", `/api/v1/patches/${latest.id}/diff`))
					.diff as string;
				const run = await runHidden(
					`bench-eval-${process.pid}`,
					testCase,
					testCase.branch,
					diff,
				);
				hiddenPassed =
					run.applied &&
					run.result?.status === "exited" &&
					run.result.exitCode === 0 &&
					run.tap !== null &&
					run.tap.tests > 0 &&
					run.tap.fail === 0;
				hidden = run.applied
					? `${run.tap?.pass}/${run.tap?.tests} passed (${run.result?.status}, exit ${run.result?.exitCode})`
					: "the stored diff does not apply";
			}
			check("Hidden tests pass on the proposed patch", hiddenPassed, hidden);
			const reproCheck = verification?.checks.find(
				(c: { kind: string }) => c.kind === "reproduction",
			);
			const suiteCheck = verification?.checks.find(
				(c: { kind: string }) => c.kind === "unit_tests",
			);
			check(
				"Post-patch reproduction passes twice and the visible suite has no newly failing tests",
				reproCheck?.status === "passed" && suiteCheck?.status === "passed",
				`reproduction: ${reproCheck?.status ?? "none"} ${JSON.stringify(reproCheck?.summary?.runs ?? [])}; suite: ${suiteCheck?.status ?? "none"} (${suiteCheck?.summary?.passed ?? "?"}/${suiteCheck?.summary?.tests ?? "?"})`,
			);
		} else {
			check(
				"Baseline reproduction is never reported as reproduced",
				baseline !== "reproduced",
				`baseline: ${baseline}`,
			);
			check(
				"The verification outcome is never verified",
				outcome !== "verified",
				`outcome: ${outcome}`,
			);
		}
		check(
			"The report copies the stored reproduction and verification statuses",
			report !== null &&
				report.report.reproduction.baseline === baseline &&
				report.report.verification.outcome === outcome,
			report
				? `report: baseline ${report.report.reproduction.baseline}, outcome ${report.report.verification.outcome}`
				: "no report",
		);
		Object.assign(record, {
			investigation_id: id,
			status: investigation.status,
			error: investigation.error ?? null,
			baseline,
			outcome,
			verdict: criteria.every((c) => c.passed) ? "PASS" : "FAIL",
			criteria,
			hypotheses: findings.hypotheses.map(
				(h: { rank: number; title: string; state: string }) => ({
					rank: h.rank,
					title: h.title,
					state: h.state,
				}),
			),
			patches: patches.items.map((p: { attempt: number; status: string }) => ({
				attempt: p.attempt,
				status: p.status,
			})),
			model_calls: executions.totals.requests,
			tokens: {
				input: executions.totals.input_tokens,
				output: executions.totals.output_tokens,
			},
			cost_usd: executions.totals.estimated_cost_usd,
			model_latency_ms: executions.items.reduce(
				(sum: number, e: { latency_ms: number }) => sum + e.latency_ms,
				0,
			),
			models: [
				...new Set(
					executions.items.map(
						(e: { task: string; model: string }) => `${e.task}=${e.model}`,
					),
				),
			],
			wall_ms: Date.now() - started,
		});
	} catch (error) {
		Object.assign(record, {
			verdict: "ERROR",
			error: (error as Error).message,
			wall_ms: Date.now() - started,
		});
	}
	results.push(record);
	console.error(
		`${label} ${testCase.id}: ${record.verdict} (${record.outcome ?? record.error})`,
	);
}

await removeWorkspace(config, `bench-eval-${process.pid}`);
await stopWorker();
await app.close();
await boss.stop({ graceful: false });
await pool.end();

// ---- Results ---------------------------------------------------------------------------------------

const outDir = path.join(ROOT, "eval", "results", stamp);
mkdirSync(outDir, { recursive: true });
const summary = {
	label,
	generated_at: new Date().toISOString(),
	inference: describeConfig(config).inference,
	sandbox,
	cases: results,
	totals: {
		cases: results.length,
		passed: results.filter((r) => r.verdict === "PASS").length,
		model_calls: results.reduce(
			(sum, r) => sum + Number(r.model_calls ?? 0),
			0,
		),
		cost_usd:
			Math.round(
				results.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0) * 1e6,
			) / 1e6,
	},
};
writeFileSync(
	path.join(outDir, "results.json"),
	`${JSON.stringify(summary, null, 2)}\n`,
);
const seconds = (ms: unknown) =>
	ms === undefined ? "-" : (Number(ms) / 1000).toFixed(1);
const lines = [
	`# Bench Shop evaluation ${label}`,
	"",
	`Generated ${summary.generated_at}. Inference: ${summary.inference.name} (${summary.inference.provider}). Sandbox: ${sandbox.kind}, ${sandbox.detail}, image ${sandbox.image}.`,
	...(live
		? []
		: [
				"",
				"**Mock inference: these results say nothing about model quality.**",
			]),
	"",
	"| Case | Verdict | Baseline | Outcome | Model calls | Cost (USD) | Model latency (s) | Wall time (s) |",
	"|---|---|---|---|---|---|---|---|",
	...results.map(
		(r) =>
			`| ${r.case} | ${r.verdict} | ${r.baseline ?? "-"} | ${r.outcome ?? "-"} | ${r.model_calls ?? "-"} | ${r.cost_usd ?? "-"} | ${seconds(r.model_latency_ms)} | ${seconds(r.wall_ms)} |`,
	),
	"",
	...results.flatMap((r) => [
		`## ${r.case}`,
		"",
		...(r.verdict === "ERROR" ? [`Error: ${r.error}`] : []),
		...((r.criteria as Criterion[] | undefined) ?? []).map(
			(c) => `- ${c.passed ? "PASS" : "FAIL"}: ${c.criterion} (${c.evidence})`,
		),
		...(r.models ? [`- Models: ${(r.models as string[]).join(", ")}`] : []),
		"",
	]),
	`Totals: ${summary.totals.passed}/${summary.totals.cases} cases passed; ${summary.totals.model_calls} model calls; estimated cost $${summary.totals.cost_usd}.`,
];
writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`\nResults written to ${path.relative(ROOT, outDir)}`);
process.exit(summary.totals.passed === summary.totals.cases ? 0 : 1);
