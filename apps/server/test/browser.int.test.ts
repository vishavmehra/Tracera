import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { BrowserStep } from "@tracera/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evidenceAssets, sandboxRuns } from "../src/db/schema.ts";
import { workspacesRoot } from "../src/modules/workspace.ts";
import type { BrowserRunRequest } from "../src/sandbox/executor.ts";
import type { WorkerDeps } from "../src/worker/handlers.ts";
import { hypothesesCiting, patchOutput } from "./bench-scenarios.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	driveInvestigation,
	type FakeBrowserRun,
	fakeExecutor,
	login,
	makeGitRepo,
	normalizationOutput,
	repositoryBody,
	resetDatabase,
	scriptedProvider,
	type TestContext,
	tapOutput,
} from "./helpers.ts";
import { TINY_PNG, TINY_PNG_BASE64 } from "./png.ts";

// Browser reproduction through the investigation pipeline [mock inference, fake executor]:
// routing by declared app and named page, step validation before anything runs, two baseline and two
// post-patch browser runs, records, and the report. Real Chromium isolation is in browser.docker.test.ts.

let ctx: TestContext;
let session: ReturnType<typeof asSession>;

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
});

const MARKER = "count * 4 * 0";
const FILES: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "shop", version: "1.0.0", type: "module", scripts: { start: "node server.js", test: "node --test" } }, null, 2)}\n`,
	"public/cart.js": `export function totalLabel(count) {\n\treturn \`Total: $\${${MARKER}}\`;\n}\n`,
	"server.js":
		'import http from "node:http";\nhttp.createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT));\n',
	"test/cart.test.js":
		'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { totalLabel } from "../public/cart.js";\n\ntest("label starts with Total", () => {\n\tassert.match(totalLabel(0), /^Total: /);\n});\n',
};

function shopRepo(name: string) {
	const dir = makeGitRepo(ctx.repoRoot, name);
	for (const [file, content] of Object.entries(FILES)) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), content);
	}
	execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
	execFileSync(
		"git",
		[
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"-m",
			"shop",
		],
		{ cwd: dir, stdio: "pipe" },
	);
	return dir;
}

const step = (partial: Partial<BrowserStep>): BrowserStep => ({
	action: "goto",
	target: null,
	value: null,
	path: null,
	key: null,
	width: null,
	height: null,
	match: null,
	timeout_ms: null,
	...partial,
});
const STEPS: BrowserStep[] = [
	step({ action: "goto", path: "/cart" }),
	step({
		action: "click",
		target: { by: "role", value: "button", name: "Add item", exact: null },
	}),
	step({
		action: "expect_text",
		target: { by: "test_id", value: "total", name: null, exact: null },
		value: "Total: $4",
		match: "contains",
	}),
];
const browserPlan = (steps = STEPS) => ({
	feasible: true,
	infeasible_reason: null,
	steps,
	expected_observation: "After adding one item the total reads Total: $4",
	reported_observation: "The total stays at Total: $0",
});
const REPORT = {
	title: "Cart total stays at $0 after Add item",
	description:
		"On /cart, clicking Add item leaves the total at Total: $0. totalLabel should show Total: $4 for one item.",
	expected_behavior: "The total reads Total: $4 after adding one item",
	actual_behavior: "The total stays at Total: $0",
	affected_url: "http://localhost:4173/cart?ref=email",
	normalize: false,
};

/** Simulates the browser without executing code: the bug marker in the run copy decides the result. */
function browserScript(request: BrowserRunRequest): FakeBrowserRun {
	const buggy = readFileSync(
		path.join(request.workspace, "public", "cart.js"),
		"utf8",
	).includes(MARKER);
	return {
		report: {
			ready: true,
			startup: {
				health_path: request.app.readyPath,
				health_ok: true,
				health_status: 200,
				health_attempts: 1,
				health_waited_ms: 120,
				health_error: null,
				page_loaded: true,
				page_error: null,
			},
			steps: request.steps.map((s, index) => ({
				index,
				action: s.action,
				status: index === 2 && buggy ? "failed" : "passed",
				assertion: s.action.startsWith("expect_"),
				message:
					index === 2 && buggy
						? "expected the text to contain the expected value"
						: null,
				expected: index === 2 ? "Total: $4" : null,
				actual: index === 2 ? (buggy ? "Total: $0" : "Total: $4") : null,
				duration_ms: 5,
			})),
			console_errors: [],
			page_errors: [],
			blocked_requests: [],
			failed_requests: [],
			final_path: "/cart",
			screenshot: TINY_PNG_BASE64,
			duration_ms: 50,
		},
	};
}

async function investigate(
	repository: Record<string, unknown>,
	provider: ReturnType<typeof scriptedProvider>,
	executor: ReturnType<typeof fakeExecutor>,
	report: Record<string, unknown> = REPORT,
) {
	const repo = (
		await session("POST", "/api/v1/repositories", repository)
	).json().repository;
	const bug = (
		await session("POST", "/api/v1/bug-reports", {
			...report,
			repository_id: repo.id,
		})
	).json().bug_report;
	const investigation = (
		await session("POST", "/api/v1/investigations", { bug_report_id: bug.id })
	).json().investigation;
	const deps: WorkerDeps = {
		config: ctx.config,
		db: ctx.db,
		pool: ctx.pool,
		boss: ctx.boss,
		provider,
		executor,
		workerId: "test-worker",
	};
	await driveInvestigation(ctx, deps, investigation.id);
	const view = (
		await session("GET", `/api/v1/investigations/${investigation.id}`)
	).json().investigation;
	const stepOf = (stage: string) =>
		view.steps.find((s: { stage: string }) => s.stage === stage);
	return { id: investigation.id as string, view, stepOf };
}
const withApp = (dir: string) => ({
	...repositoryBody(dir, "shop"),
	commands: { install: "npm ci", test: "npm test", start: "npm run start" },
	app: { port: 4173, ready_path: "/health" },
});
const suite = () => ({
	exitCode: 0,
	stdout: tapOutput([{ name: "label starts with Total", ok: true }]),
});
const fix = () =>
	patchOutput({ path: "public/cart.js", search: MARKER, replace: "count * 4" });

describe("browser reproduction in investigations", () => {
	it("plans browser steps for a UI report on a declared app, reproduces, patches, and verifies", async () => {
		const executor = fakeExecutor(workspacesRoot(ctx.config), suite, {
			browser: browserScript,
		});
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_browser_reproduction: browserPlan(),
			generate_hypotheses: hypothesesCiting("public/cart.js", MARKER, [
				"REPRO",
			]),
			generate_patch: fix(),
		});
		const { id, view, stepOf } = await investigate(
			withApp(shopRepo("shop-browser")),
			provider,
			executor,
		);
		expect(stepOf("plan_reproduction")).toMatchObject({
			status: "succeeded",
			summary: {
				mode: "browser",
				step_count: 3,
				start: "npm run start",
				// The bug-report API strips the query (keep_query is false), so it never reaches a prompt.
				reported_path: "/cart",
			},
		});
		expect(stepOf("reproduce_baseline")).toMatchObject({
			status: "succeeded",
			summary: { baseline: "reproduced", mode: "browser" },
		});
		expect(view).toMatchObject({
			status: "awaiting_approval",
			baseline_reproduction: { status: "reproduced" },
			latest_verification: { outcome: "verified" },
		});
		expect(provider.calls.map((call) => call.task)).not.toContain(
			"plan_reproduction",
		);

		// Two baseline runs on the original code, two after the patch; each with the validated steps.
		expect(executor.browserRuns).toHaveLength(4);
		for (const run of executor.browserRuns)
			expect(run).toMatchObject({
				start: ["npm", "run", "start"],
				app: { port: 4173, readyPath: "/health", basePath: "/" },
				steps: STEPS,
			});
		const verification = (
			await session(
				"GET",
				`/api/v1/verifications/${view.latest_verification.id}`,
			)
		).json().verification;
		expect(
			verification.checks.find(
				(c: { kind: string }) => c.kind === "reproduction",
			),
		).toMatchObject({
			status: "passed",
			summary: { mode: "browser", runs: ["not_reproduced", "not_reproduced"] },
		});

		// Every browser run is recorded with its screenshot.
		const runs = await ctx.db
			.select()
			.from(sandboxRuns)
			.where(eq(sandboxRuns.investigationId, id));
		const browserRows = runs.filter((run) =>
			Object.hasOwn(run.result, "browser"),
		);
		expect(browserRows).toHaveLength(4);
		for (const row of browserRows)
			expect(row.result).toMatchObject({
				browser: {
					ready: true,
					steps: 3,
					screenshot_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				},
			});
		const markdown = (
			await session(
				"GET",
				`/api/v1/investigations/${id}/report?format=markdown`,
			)
		).body;
		expect(markdown).toContain("browser steps (3) against npm run start");
	});

	it("keeps the node test plan when the repository declares no app", async () => {
		const executor = fakeExecutor(workspacesRoot(ctx.config), suite, {
			browser: browserScript,
		});
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: {
				feasible: false,
				infeasible_reason: "needs a browser",
				test_source: "",
				expected_observation: "",
				reported_observation: "",
			},
			generate_hypotheses: hypothesesCiting("public/cart.js", MARKER, []),
			generate_patch: fix(),
		});
		const { stepOf } = await investigate(
			repositoryBody(shopRepo("shop-node"), "shop"),
			provider,
			executor,
		);
		const tasks = provider.calls.map((call) => call.task);
		expect(tasks).toContain("plan_reproduction");
		expect(tasks).not.toContain("plan_browser_reproduction");
		expect(stepOf("plan_reproduction")).toMatchObject({
			status: "skipped",
			summary: { reason: "reproduction_not_feasible" },
		});
		expect(executor.browserRuns).toHaveLength(0);
	});

	it("refuses unsafe steps: one repair round, then the stage fails and nothing runs", async () => {
		const executor = fakeExecutor(workspacesRoot(ctx.config), suite, {
			browser: browserScript,
		});
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_browser_reproduction: browserPlan([
				step({ action: "goto", path: "https://evil.example/steal" }),
				step({ action: "expect_no_console_errors" }),
			]),
			generate_hypotheses: hypothesesCiting("public/cart.js", MARKER, []),
			generate_patch: fix(),
		});
		const { stepOf } = await investigate(
			withApp(shopRepo("shop-unsafe")),
			provider,
			executor,
		);
		expect(
			provider.calls.filter(
				(call) => call.task === "plan_browser_reproduction",
			),
		).toHaveLength(2);
		expect(stepOf("plan_reproduction")).toMatchObject({
			status: "failed",
			error: { code: "repro_plan_invalid" },
		});
		expect(executor.browserRuns).toHaveLength(0);
	});

	it("lists before and after screenshots with provenance, serves them safely, and only to the owning workspace", async () => {
		const executor = fakeExecutor(workspacesRoot(ctx.config), suite, {
			browser: browserScript,
		});
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_browser_reproduction: browserPlan(),
			generate_hypotheses: hypothesesCiting("public/cart.js", MARKER, [
				"REPRO",
			]),
			generate_patch: fix(),
		});
		const { id, view } = await investigate(
			withApp(shopRepo("shop-evidence")),
			provider,
			executor,
		);
		const patch = (await session("GET", `/api/v1/investigations/${id}/patches`))
			.json()
			.items.at(-1);
		const evidence = (
			await session("GET", `/api/v1/patches/${patch.id}/runtime-evidence`)
		).json();
		expect(evidence).toMatchObject({
			patch_id: patch.id,
			investigation_id: id,
			verification: {
				id: view.latest_verification.id,
				outcome: "verified",
				reproduction_check: { status: "passed", reason: null },
			},
			visual_fix: { claimable: true, reason: "post_patch_assertions_passed" },
		});
		expect(evidence.before).toHaveLength(2);
		expect(evidence.after).toHaveLength(2);
		for (const run of evidence.before)
			expect(run).toMatchObject({
				phase: "before",
				patch_id: null,
				status: "exited",
				reproduction: { status: "reproduced" },
				sandbox: { kind: "fake" },
				startup: {
					state: "started",
					start: "npm run start",
					port: 4173,
					health: { ok: true, status: 200 },
				},
				assertions: { passed: 0, failed: 1, skipped: 0 },
				screenshot: { mime: "image/png", bytes: TINY_PNG.length },
			});
		for (const run of evidence.after)
			expect(run).toMatchObject({
				phase: "after",
				patch_id: patch.id,
				reproduction: { status: "not_reproduced" },
				assertions: { passed: 1, failed: 0, skipped: 0 },
				screenshot: { mime: "image/png" },
			});
		expect(
			evidence.before[0].steps.map((s: { label: string }) => s.label),
		).toEqual([
			"Open /cart",
			'Click button "Add item"',
			'Expect test id "total" to contain "Total: $4"',
		]);
		expect(evidence.before[0].steps[2]).toMatchObject({
			status: "failed",
			assertion: true,
			expected: "Total: $4",
			actual: "Total: $0",
		});
		expect(
			(
				await session(
					"GET",
					`/api/v1/verifications/${view.latest_verification.id}/runtime-evidence`,
				)
			).json(),
		).toEqual(evidence);

		// Each screenshot is an evidence asset that says which run, phase, patch, sandbox, and images made it.
		const assets = (
			await ctx.db
				.select()
				.from(evidenceAssets)
				.where(eq(evidenceAssets.investigationId, id))
		).filter((asset) => asset.kind === "repro_screenshot");
		expect(assets).toHaveLength(4);
		for (const asset of assets)
			expect(asset).toMatchObject({
				origin: "generated_by_tool",
				mimeType: "image/png",
				sizeBytes: TINY_PNG.length,
				bugReportId: null,
				provenance: {
					method: "browser_sandbox",
					executor: "fake",
					image: expect.stringMatching(/^fake@sha256:/),
					browser_image: expect.stringMatching(/^fake@sha256:/),
				},
			});
		const runs = [...evidence.before, ...evidence.after];
		for (const run of runs) {
			const asset = assets.find(
				(item) => item.id === run.screenshot.evidence_id,
			);
			expect(asset?.provenance).toMatchObject({
				sandbox_run_id: run.run_id,
				phase: run.phase,
				patch_id: run.patch_id,
			});
		}

		// The bytes: a PNG that cannot be sniffed into anything else.
		const image = await session("GET", evidence.before[0].screenshot.url);
		expect(image.statusCode).toBe(200);
		expect(image.headers["content-type"]).toBe("image/png");
		expect(image.headers["x-content-type-options"]).toBe("nosniff");
		expect(image.headers["content-security-policy"]).toContain(
			"default-src 'none'",
		);
		expect(image.rawPayload.equals(TINY_PNG)).toBe(true);

		// Another workspace sees none of it, and unknown or malformed IDs are 404 too.
		await createOwner(ctx.db, "intruder@example.com");
		const intruder = asSession(ctx, await login(ctx, "intruder@example.com"));
		for (const url of [
			`/api/v1/patches/${patch.id}/runtime-evidence`,
			`/api/v1/verifications/${view.latest_verification.id}/runtime-evidence`,
			evidence.before[0].screenshot.url,
		])
			expect((await intruder("GET", url)).statusCode).toBe(404);
		for (const url of [
			`/api/v1/repro-screenshots/evd_00000000000000000000000000`,
			`/api/v1/repro-screenshots/not-an-id`,
			`/api/v1/patches/pat_00000000000000000000000000/runtime-evidence`,
		])
			expect((await session("GET", url)).statusCode).toBe(404);

		// A blob whose bytes no longer match its hash is never served.
		const sha = evidence.before[0].screenshot.sha256 as string;
		writeFileSync(
			path.join(
				ctx.config.dataDir,
				"blobs",
				"sha256",
				sha.slice(0, 2),
				sha.slice(2, 4),
				sha,
			),
			"<html><script>alert(1)</script></html>",
		);
		expect(
			(await session("GET", evidence.before[0].screenshot.url)).statusCode,
		).toBe(404);
	});

	it("makes no visual fix claim while an assertion still fails after the patch", async () => {
		const executor = fakeExecutor(workspacesRoot(ctx.config), suite, {
			browser: browserScript,
		});
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_browser_reproduction: browserPlan(),
			generate_hypotheses: hypothesesCiting("public/cart.js", MARKER, [
				"REPRO",
			]),
			// The edit keeps the bug in place: the same assertion fails after it.
			generate_patch: patchOutput({
				path: "public/cart.js",
				search: MARKER,
				replace: `${MARKER} + 0`,
			}),
		});
		const { id } = await investigate(
			withApp(shopRepo("shop-still-failing")),
			provider,
			executor,
		);
		const patch = (await session("GET", `/api/v1/investigations/${id}/patches`))
			.json()
			.items.at(-1);
		const evidence = (
			await session("GET", `/api/v1/patches/${patch.id}/runtime-evidence`)
		).json();
		expect(evidence.verification).toMatchObject({
			outcome: "failed",
			reproduction_check: { status: "failed", reason: "repro_still_failing" },
		});
		expect(evidence.before.length).toBeGreaterThan(0);
		for (const run of evidence.after) {
			expect(run.assertions.failed).toBe(1);
			expect(run.screenshot).not.toBeNull();
		}
		expect(evidence.visual_fix).toEqual({
			claimable: false,
			reason: "post_patch_assertion_failed",
		});
	});

	it("reports a disabled sandbox as such, with a blocked verification and no runs", async () => {
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			() => {
				throw new Error("must not run");
			},
			{ available: false },
		);
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_browser_reproduction: browserPlan(),
			generate_hypotheses: hypothesesCiting("public/cart.js", MARKER, [
				"COMMIT",
			]),
			generate_patch: fix(),
		});
		// Without a reproduction the hypothesis rests on the commit that last touched the file.
		const dir = shopRepo("shop-no-sandbox");
		appendFileSync(path.join(dir, "public/cart.js"), "// label\n");
		execFileSync(
			"git",
			[
				"-c",
				"user.email=t@example.com",
				"-c",
				"user.name=t",
				"commit",
				"-aqm",
				"label",
			],
			{ cwd: dir, stdio: "pipe" },
		);
		const { id } = await investigate(withApp(dir), provider, executor);
		const patch = (await session("GET", `/api/v1/investigations/${id}/patches`))
			.json()
			.items.at(-1);
		const evidence = (
			await session("GET", `/api/v1/patches/${patch.id}/runtime-evidence`)
		).json();
		expect(evidence).toMatchObject({
			patch_id: patch.id,
			sandbox_mode: "disabled",
			verification: {
				outcome: "blocked",
				reproduction_check: {
					status: "blocked",
					reason: "sandbox_unavailable",
				},
			},
			before: [],
			after: [],
			visual_fix: { claimable: false, reason: "no_post_patch_run" },
		});
		expect(executor.browserRuns).toHaveLength(0);
	});
});
