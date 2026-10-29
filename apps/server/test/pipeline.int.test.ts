import { execFileSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupBenchShop } from "../../../scripts/bench-setup.ts";
import {
	investigationSteps,
	patchProposals,
	repositories,
	workspaces,
} from "../src/db/schema.ts";
import { createMockProvider } from "../src/inference/mock.ts";
import {
	type ChatProvider,
	ProviderError,
} from "../src/inference/providers.ts";
import { recoverStaleSteps } from "../src/modules/investigations.ts";
import { workspacesRoot } from "../src/modules/workspace.ts";
import { QUEUES } from "../src/queue.ts";
import type {
	SandboxExecutor,
	SandboxRunRequest,
} from "../src/sandbox/executor.ts";
import { handleStageJob, type WorkerDeps } from "../src/worker/handlers.ts";
import {
	B3,
	hypothesesCiting,
	patchOutput,
	plan,
	SUITE,
} from "./bench-scenarios.ts";
import {
	asSession,
	asToken,
	createOwner,
	createTestContext,
	createToken,
	driveInvestigation,
	type FakeRun,
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

let ctx: TestContext;
let session: ReturnType<typeof asSession>;
let bench: { path: string; branches: Record<string, string> };

beforeAll(async () => {
	ctx = await createTestContext();
	bench = setupBenchShop(ctx.config.dataDir);
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
});

// ---- Scenario building blocks (B3 scripts are shared in bench-scenarios.ts) -------------------

/** Simulates node:test without executing code: the bug marker in the run copy decides the result. */
function benchScript(file: string, marker: string) {
	return (request: SandboxRunRequest): FakeRun => {
		const source = readFileSync(
			path.join(request.workspace, ...file.split("/")),
			"utf8",
		);
		const buggy = source.includes(marker);
		if (request.argv.includes(".tracera/repro/repro.mjs")) {
			if (
				!existsSync(
					path.join(request.workspace, ".tracera", "repro", "repro.mjs"),
				)
			)
				return { exitCode: 1, stdout: "no repro file" };
			return {
				exitCode: buggy ? 1 : 0,
				stdout: tapOutput([
					{ name: "two orders totaling $49.60 average $24.80", ok: !buggy },
				]),
			};
		}
		return {
			exitCode: 0,
			stdout: tapOutput(SUITE.map((name) => ({ name, ok: true }))),
		};
	};
}

function worker(provider: ChatProvider, executor: SandboxExecutor): WorkerDeps {
	return {
		config: ctx.config,
		db: ctx.db,
		pool: ctx.pool,
		boss: ctx.boss,
		provider,
		executor,
		workerId: "test-worker",
	};
}

async function start(
	branch: string,
	report: Record<string, unknown> = B3.report,
	extra: Record<string, unknown> = {},
) {
	const repository = (
		await session("POST", "/api/v1/repositories", {
			name: "bench-shop",
			source: { type: "fixture", fixture: "bench-shop" },
			commands: { install: "npm ci --ignore-scripts", test: "npm test" },
		})
	).json().repository;
	const bug = (
		await session("POST", "/api/v1/bug-reports", {
			...report,
			repository_id: repository.id,
		})
	).json().bug_report;
	const investigation = (
		await session("POST", "/api/v1/investigations", {
			bug_report_id: bug.id,
			commit: branch,
			...extra,
		})
	).json().investigation;
	expect(investigation?.id).toBeTruthy();
	return { repository, bug, investigation };
}

const get = async (url: string) => (await session("GET", url)).json();
const view = async (id: string) =>
	(await get(`/api/v1/investigations/${id}`)).investigation;
const purposes = (executor: { runs: SandboxRunRequest[] }) =>
	executor.runs.map((run) => run.runId.split("-").slice(-2, -1)[0] ?? "");
const gitState = () =>
	execFileSync("git", ["status", "--porcelain", "--branch"], {
		cwd: bench.path,
	}).toString();

// ---- Scenarios -------------------------------------------------------------------------------

describe("bug repair pipeline over the Bench Shop fixture [mock inference, fake executor]", () => {
	it("reproduces, patches, and verifies the exact stored diff on fresh copies; approval changes no files", async () => {
		const before = gitState();
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
			generate_patch: patchOutput(),
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript(B3.file, B3.marker),
		);
		const { investigation } = await start(B3.branch);
		await driveInvestigation(ctx, worker(provider, executor), investigation.id);

		const done = await view(investigation.id);
		expect(done).toMatchObject({
			status: "awaiting_approval",
			baseline_reproduction: { status: "reproduced" },
			latest_verification: { outcome: "verified", outcome_reasons: [] },
			counts: { hypotheses: 1, patches: 1 },
		});
		expect(
			done.steps.map(
				(s: { stage: string; status: string }) => `${s.stage}:${s.status}`,
			),
		).toEqual([
			"normalize:succeeded",
			"collect_context:succeeded",
			// Bench Shop has no dependencies: nothing is prepared, and runs mount nothing.
			"prepare_dependencies:skipped",
			"plan_reproduction:succeeded",
			"reproduce_baseline:succeeded",
			"generate_hypotheses:succeeded",
			"rank_hypotheses:succeeded",
			"generate_patch:succeeded",
			"verify:succeeded",
			"write_report:succeeded",
		]);
		expect(
			done.steps.find((s: { stage: string }) => s.stage === "collect_context")
				.specialists,
		).toEqual(["repository_mapping", "code_exploration"]);
		// Every execution went through the executor, with fixed argv and an allowlisted environment.
		expect(purposes(executor).sort()).toEqual(
			[
				"repro_baseline",
				"repro_baseline",
				"suite_baseline",
				"repro_post_patch",
				"repro_post_patch",
				"unit_tests_post_patch",
			].sort(),
		);
		for (const run of executor.runs) {
			expect(["node", "npm"]).toContain(run.argv[0]);
			expect(
				Object.keys(run.env).every((key) =>
					["CI", "NODE_OPTIONS"].includes(key),
				),
			).toBe(true);
		}

		const findings = await get(
			`/api/v1/investigations/${investigation.id}/findings`,
		);
		expect(findings.hypotheses[0]).toMatchObject({
			handle: "HYP-1",
			state: "confirmed",
			label: "Confirmed by verification",
		});
		expect(findings.confirmed_findings).toHaveLength(1);
		expect(findings.reported_claims[0].handle).toBe("EV-1");
		expect(
			findings.code_references.some(
				(c: { locator: { path?: string } }) => c.locator.path === B3.file,
			),
		).toBe(true);
		expect(findings.experiments[0]).toMatchObject({
			handle: "REPRO-1",
			basis: "observed",
		});
		expect(findings.commits.length).toBeGreaterThan(0);
		expect(findings.model_observations).toHaveLength(1);

		const patches = (
			await get(`/api/v1/investigations/${investigation.id}/patches`)
		).items;
		expect(patches).toHaveLength(1);
		const diff = await get(`/api/v1/patches/${patches[0].id}/diff`);
		expect(diff.diff).toContain("-\tconst count = lineItemCount(orders);");
		expect(diff.diff).toContain("+\tif (orders.length === 0) return 0;");
		// The generated patch's static impact: the changed function and the tests linked to it.
		expect(patches[0].impact).toMatchObject({ available: true });
		expect(patches[0].impact.symbols).toEqual([
			expect.objectContaining({
				name: "averageOrderValueCents",
				path: B3.file,
				change: "modified",
				tests: "relevant",
			}),
		]);
		const verification = await get(
			`/api/v1/verifications/${patches[0].verification.id}`,
		);
		expect(
			verification.verification.checks.map(
				(c: { kind: string; status: string }) => `${c.kind}:${c.status}`,
			),
		).toEqual(["reproduction:passed", "unit_tests:passed"]);
		// The static graph linked the suspected file to its tests; their results are reported, not decisive.
		const graphFact = findings.observed_facts.find(
			(f: { label: string }) => f.label === `Static graph: ${B3.file}`,
		);
		expect(graphFact.content).toContain("Linked tests: test/metrics.test.js");
		const suite = verification.verification.checks.find(
			(c: { kind: string }) => c.kind === "unit_tests",
		);
		expect(suite.summary.graph_linked_tests).toMatchObject({
			failed: [],
			not_reported: [],
		});
		expect(suite.summary.graph_linked_tests.passed.length).toBeGreaterThan(0);

		const report = (
			await get(`/api/v1/investigations/${investigation.id}/report`)
		).report;
		expect(report).toMatchObject({
			version: 1,
			reproduction: { baseline: "reproduced" },
			verification: {
				outcome: "verified",
				label: "Fix verified against the original reproduction",
			},
		});
		expect(report.limitations.join(" ")).toContain("Tracera never modified");
		const markdown = await session(
			"GET",
			`/api/v1/investigations/${investigation.id}/report?format=markdown`,
		);
		expect(markdown.headers["content-type"]).toContain("text/markdown");
		expect(markdown.body).toContain(
			"Fix verified against the original reproduction",
		);
		expect(report.proposed_change.impact).toMatchObject({
			available: true,
			changed: [{ name: "averageOrderValueCents", tests: "relevant" }],
		});
		expect(markdown.body).toContain(
			`- averageOrderValueCents (\`${B3.file}\`): modified; tests: relevant`,
		);

		// Workspaces are gone and the registered repository is untouched.
		expect(
			existsSync(path.join(workspacesRoot(ctx.config), investigation.id)),
		).toBe(false);
		expect(gitState()).toBe(before);

		// Approval: a human, in a session, citing the run they saw. Tokens (including MCP) are refused.
		const token = await createToken(ctx, await login(ctx), {
			name: "agent",
			client_kind: "mcp",
		});
		expect(
			(
				await asToken(ctx, token)(
					"POST",
					`/api/v1/patches/${patches[0].id}/approval`,
					{
						decision: "approved",
						verification_id: patches[0].verification.id,
					},
				)
			).json().code,
		).toBe("session_required");
		const approved = await session(
			"POST",
			`/api/v1/patches/${patches[0].id}/approval`,
			{ decision: "approved", verification_id: patches[0].verification.id },
		);
		expect(approved.statusCode).toBe(201);
		expect(approved.json().investigation.status).toBe("completed");
		const after = (
			await get(`/api/v1/investigations/${investigation.id}/report`)
		).report;
		expect(after.version).toBe(2);
		expect(after.decisions[0]).toMatchObject({ decision: "approved" });
		expect(gitState()).toBe(before);
		expect(
			execFileSync("git", ["show", `${B3.branch}:src/metrics.js`], {
				cwd: bench.path,
			}).toString(),
		).toContain(B3.marker);
	});

	it("maps a reported stack trace onto the commit as a located lead, never as the cause", async () => {
		const line =
			execFileSync("git", ["show", `${B3.branch}:${B3.file}`], {
				cwd: bench.path,
			})
				.toString()
				.split("\n")
				.findIndex((text) => text.includes(B3.marker)) + 1;
		expect(line).toBeGreaterThan(0);
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
			generate_patch: patchOutput(),
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript(B3.file, B3.marker),
		);
		const { investigation } = await start(B3.branch, {
			...B3.report,
			description: [
				B3.report.description,
				"",
				"RangeError: average out of range",
				`    at averageOrderValueCents (/srv/shop/${B3.file}:${line}:30)`,
				"    at render (/srv/shop/node_modules/chart/index.js:1:1)",
			].join("\n"),
		});
		await driveInvestigation(ctx, worker(provider, executor), investigation.id);

		const done = await view(investigation.id);
		expect(
			done.steps.find((s: { stage: string }) => s.stage === "collect_context")
				.summary.stack_frames,
		).toEqual({ traces: 1, frames: 2, resolved: 1, leads: [B3.file] });
		const findings = await get(
			`/api/v1/investigations/${investigation.id}/findings`,
		);
		const fact = findings.observed_facts.find(
			(f: { provenance: { method?: string } }) =>
				f.provenance.method === "stack_frame_mapping",
		);
		expect(fact).toMatchObject({
			label: `Stack frame: ${B3.file}:${line}`,
			provenance: { source: "EV-1", frame: 1, path: B3.file, line },
		});
		expect(fact.content).toContain("averageOrderValueCents");
		expect(fact.content).toContain("not the root cause");
		// The frame's own text is untrusted and is not quoted back as a fact.
		expect(fact.content).not.toContain("/srv/shop");
		const handle = /CODE-\d+/.exec(fact.content)?.[0];
		const excerpt = findings.code_references.find(
			(c: { handle: string }) => c.handle === handle,
		);
		expect(excerpt.locator.path).toBe(B3.file);
		expect(excerpt.content).toContain(B3.marker);
		// Locating the frame decides nothing: the outcome still comes from execution.
		expect(done.latest_verification).toMatchObject({ outcome: "verified" });
	});

	it("reports a bug that does not reproduce honestly and never verifies", async () => {
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(
				[
					'import assert from "node:assert/strict";',
					'import { test } from "node:test";',
					'import { taxCents } from "../../src/pricing.js";',
					'test("tax on $40.00 is $3.20", () => { assert.equal(taxCents(4000), 320); });',
				].join("\n"),
			),
			generate_hypotheses: {
				insufficient_evidence: true,
				insufficient_evidence_reason:
					"The reproduction passed: tax is computed on merchandise only",
				hypotheses: [],
				observations: [],
				missing_information: [
					{
						question: "Which order showed $3.60 of tax?",
						why_it_matters:
							"The behavior did not occur with the reported amounts",
					},
				],
			},
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript("src/pricing.js", "THIS MARKER IS NOT IN THE FILE"),
		);
		const { investigation } = await start("main", {
			title: "Sales tax is calculated on shipping",
			description:
				"For a $40.00 order with $4.99 shipping, the tax line showed $3.60.",
			expected_behavior: "Tax on a $40.00 order is $3.20",
			normalize: false,
		});
		await driveInvestigation(ctx, worker(provider, executor), investigation.id);
		const done = await view(investigation.id);
		expect(done).toMatchObject({
			status: "completed",
			baseline_reproduction: { status: "not_reproduced" },
			latest_verification: null,
			counts: { patches: 0, hypotheses: 0 },
		});
		const report = (
			await get(`/api/v1/investigations/${investigation.id}/report`)
		).report;
		expect(report.reproduction.baseline).toBe("not_reproduced");
		expect(report.verification.outcome).toBe("not_attempted");
		expect(report.limitations.join(" ")).toContain("not reproduced");
		expect(report.recommended_next_step).toContain("did not occur");
		const findings = await get(
			`/api/v1/investigations/${investigation.id}/findings`,
		);
		expect(findings.insufficient_evidence.reason).toContain("merchandise only");
	});

	it("never calls a patch that leaves the reproduction failing a fix: it retries once, then rules the hypothesis out", async () => {
		const wrongEdit = {
			path: "src/metrics.js",
			search:
				"// Sales metrics for the Bench Shop dashboard. All amounts are integer cents.",
			replace: "// Sales metrics for the Bench Shop dashboard (integer cents).",
		};
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
			generate_patch: patchOutput(wrongEdit),
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript(B3.file, B3.marker),
		);
		const { investigation } = await start(B3.branch);
		await driveInvestigation(ctx, worker(provider, executor), investigation.id);
		const done = await view(investigation.id);
		expect(done).toMatchObject({
			status: "awaiting_approval",
			latest_verification: {
				outcome: "failed",
				outcome_reasons: ["repro_still_failing"],
			},
			counts: { patches: 2 },
		});
		const patches = (
			await get(`/api/v1/investigations/${investigation.id}/patches`)
		).items;
		expect(
			patches.map(
				(p: { status: string; verification: { outcome: string } }) => [
					p.status,
					p.verification.outcome,
				],
			),
		).toEqual([
			["superseded", "failed"],
			["proposed", "failed"],
		]);
		const findings = await get(
			`/api/v1/investigations/${investigation.id}/findings`,
		);
		expect(findings.hypotheses[0].state).toBe("rejected");
		expect(findings.confirmed_findings).toHaveLength(0);
		const patchCalls = provider.calls.filter(
			(call) => call.task === "generate_patch",
		);
		expect(patchCalls).toHaveLength(2);
		expect(patchCalls[1]?.user).toContain("verification_failed");
		const report = (
			await get(`/api/v1/investigations/${investigation.id}/report`)
		).report;
		expect(report.verification.label).toBe("Verification failed");
		expect(report.confirmed_findings).toHaveLength(0);
	});

	it("refuses to verify a stored diff whose bytes no longer match the reviewed patch hash", async () => {
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
			generate_patch: patchOutput(),
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript(B3.file, B3.marker),
		);
		const deps = worker(provider, executor);
		const { investigation } = await start(B3.branch);
		// Run the stages until verification is next, then change the stored diff behind its hash.
		for (;;) {
			const { rows } = await ctx.pool.query<{
				id: string;
				data: { stage: string; investigationId: string; attempt: number };
			}>(
				"SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' AND data->>'investigationId' = $2 ORDER BY created_on LIMIT 1",
				[QUEUES.stage, investigation.id],
			);
			const job = rows[0];
			if (!job) throw new Error("verification was never queued");
			if (job.data.stage === "verify") break;
			await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [job.id]);
			await handleStageJob(
				deps,
				job.data as Parameters<typeof handleStageJob>[1],
			);
		}
		const [patch] = await ctx.db
			.select()
			.from(patchProposals)
			.where(eq(patchProposals.investigationId, investigation.id));
		const sha = patch?.diffSha256 ?? "";
		const blob = path.join(
			ctx.config.dataDir,
			"blobs",
			"sha256",
			sha.slice(0, 2),
			sha.slice(2, 4),
			sha,
		);
		writeFileSync(blob, `${readFileSync(blob, "utf8")}\n`);
		const runsBefore = executor.runs.length;
		await driveInvestigation(ctx, deps, investigation.id);
		expect(executor.runs).toHaveLength(runsBefore);
		expect(await view(investigation.id)).toMatchObject({
			latest_verification: {
				outcome: "blocked",
				outcome_reasons: ["diff_integrity_failed"],
			},
		});
	});

	it("records blocked sandbox stages instead of executing anything when the sandbox is unavailable", async () => {
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: hypothesesCiting(B3.file, B3.marker, ["COMMIT"]),
			generate_patch: patchOutput(),
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			() => {
				throw new Error("must not run");
			},
			{ available: false },
		);
		const { investigation } = await start(B3.branch);
		await driveInvestigation(ctx, worker(provider, executor), investigation.id);
		expect(executor.runs).toHaveLength(0);
		const done = await view(investigation.id);
		expect(done).toMatchObject({
			status: "awaiting_approval",
			baseline_reproduction: {
				status: "blocked",
				reason: "sandbox_unavailable",
			},
			latest_verification: {
				outcome: "blocked",
				outcome_reasons: ["sandbox_unavailable"],
			},
		});
		const report = (
			await get(`/api/v1/investigations/${investigation.id}/report`)
		).report;
		expect(report.verification.label).toBe("Verification could not run");
	});

	it("treats a sandbox timeout as inconclusive, never as reproduced or verified", async () => {
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: hypothesesCiting(B3.file, B3.marker, ["COMMIT"]),
			generate_patch: patchOutput(),
		});
		const realistic = benchScript(B3.file, B3.marker);
		const executor = fakeExecutor(workspacesRoot(ctx.config), (request) =>
			request.argv.includes(".tracera/repro/repro.mjs")
				? { status: "timed_out", exitCode: null }
				: realistic(request),
		);
		const { investigation } = await start(B3.branch);
		await driveInvestigation(ctx, worker(provider, executor), investigation.id);
		const done = await view(investigation.id);
		expect(done.baseline_reproduction).toMatchObject({
			status: "inconclusive",
			reason: "sandbox_timeout",
		});
		expect(done.latest_verification).toMatchObject({
			outcome: "partially_verified",
			outcome_reasons: ["baseline_inconclusive"],
		});
	});

	it("fails the investigation with the provider's error code when hypothesis generation cannot reach the model", async () => {
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: new ProviderError(
				"provider_auth_failed",
				"Model provider rejected the API key",
				false,
			),
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript(B3.file, B3.marker),
		);
		const { investigation, bug } = await start(B3.branch);
		await driveInvestigation(ctx, worker(provider, executor), investigation.id);
		expect(await view(investigation.id)).toMatchObject({
			status: "failed",
			failure: {
				stage: "generate_hypotheses",
				code: "provider_auth_failed",
				retryable: false,
			},
		});
		expect((await get(`/api/v1/bug-reports/${bug.id}`)).bug_report.status).toBe(
			"open",
		);
		expect(
			existsSync(path.join(workspacesRoot(ctx.config), investigation.id)),
		).toBe(false);
	});

	it("cancels a running sandbox stage, stops the run, and records the cancellation", async () => {
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
		});
		let started = 0;
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			(_request, signal) =>
				new Promise<FakeRun>((resolve) => {
					started += 1;
					signal?.addEventListener("abort", () =>
						resolve({ status: "cancelled", exitCode: null }),
					);
				}),
		);
		const deps = worker(provider, executor);
		const { investigation } = await start(B3.branch);
		for (const stage of [
			"normalize",
			"collect_context",
			"plan_reproduction",
		] as const)
			await handleStageJob(deps, {
				investigationId: investigation.id,
				stage,
				attempt: 1,
			});
		const running = handleStageJob(deps, {
			investigationId: investigation.id,
			stage: "reproduce_baseline",
			attempt: 1,
		});
		for (let i = 0; i < 200 && started === 0; i++)
			await new Promise((resolve) => setTimeout(resolve, 50));
		expect(started).toBeGreaterThan(0);
		const cancel = await session(
			"POST",
			`/api/v1/investigations/${investigation.id}/cancel`,
		);
		expect(cancel.statusCode).toBe(202);
		await running;
		const done = await view(investigation.id);
		expect(done.status).toBe("cancelled");
		expect(
			done.steps.find(
				(s: { stage: string }) => s.stage === "reproduce_baseline",
			)?.status,
		).toBe("cancelled");
		expect(
			existsSync(path.join(workspacesRoot(ctx.config), investigation.id)),
		).toBe(false);
	});

	it("recovers a step whose worker died without marking it successful, and ignores the stale job", async () => {
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
			generate_patch: patchOutput(),
		});
		const deps = worker(
			provider,
			fakeExecutor(workspacesRoot(ctx.config), benchScript(B3.file, B3.marker)),
		);
		const { investigation } = await start(B3.branch);
		for (const stage of ["normalize", "collect_context"] as const)
			await handleStageJob(deps, {
				investigationId: investigation.id,
				stage,
				attempt: 1,
			});
		// A worker claimed plan_reproduction and died: the step stays `running` past its timeout.
		await ctx.db.insert(investigationSteps).values({
			id: `stp_${"0".repeat(26)}`,
			investigationId: investigation.id,
			stage: "plan_reproduction",
			attempt: 1,
			status: "running",
			startedAt: new Date(Date.now() - 30 * 60_000),
		});
		await ctx.pool.query(
			"DELETE FROM pgboss.job WHERE name = $1 AND data->>'investigationId' = $2",
			[QUEUES.stage, investigation.id],
		);
		expect(await recoverStaleSteps(deps)).toBe(1);
		const [lost] = await ctx.db
			.select()
			.from(investigationSteps)
			.where(
				and(
					eq(investigationSteps.investigationId, investigation.id),
					eq(investigationSteps.stage, "plan_reproduction"),
					eq(investigationSteps.attempt, 1),
				),
			);
		expect(lost).toMatchObject({
			status: "failed",
			error: { code: "worker_lost", retryable: true },
		});
		const calls = provider.calls.length;
		await handleStageJob(deps, {
			investigationId: investigation.id,
			stage: "plan_reproduction",
			attempt: 1,
		});
		expect(provider.calls.length).toBe(calls); // the stale attempt does nothing
		await driveInvestigation(ctx, deps, investigation.id);
		const done = await view(investigation.id);
		expect(done.status).toBe("awaiting_approval");
		expect(
			done.steps.find(
				(s: { stage: string; attempt: number }) =>
					s.stage === "plan_reproduction" && s.attempt === 2,
			)?.status,
		).toBe("succeeded");
	});

	it("runs end to end with mock inference, stamps the report, and claims nothing", async () => {
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript(B3.file, B3.marker),
		);
		const { investigation } = await start(B3.branch);
		await driveInvestigation(
			ctx,
			worker(createMockProvider(), executor),
			investigation.id,
		);
		const done = await view(investigation.id);
		expect(done.status).toBe("completed");
		expect(done.counts.patches).toBe(0);
		const report = (
			await get(`/api/v1/investigations/${investigation.id}/report`)
		).report;
		expect(report.generated_with.mock).toBe(true);
		expect(report.verification.outcome).toBe("not_attempted");
		expect(report.confirmed_findings).toEqual([]);
		const markdown = await session(
			"GET",
			`/api/v1/investigations/${investigation.id}/report?format=markdown`,
		);
		expect(
			markdown.body.startsWith("> **Generated with mock inference.**"),
		).toBe(true);
	});

	it("drops citations to evidence that was never collected and stops when nothing remains", async () => {
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: {
				insufficient_evidence: false,
				insufficient_evidence_reason: null,
				hypotheses: [
					{
						title: "The database driver rounds badly",
						mechanism: "db.js truncates decimals",
						locations: [{ handle: "CODE-99", start_line: 1, end_line: 3 }],
						supporting: [
							{ handle: "TEST-RUN-7", start_line: null, end_line: null },
						],
						contradicting: [],
						alternatives: [],
						next_check: "Inspect db.js",
						confidence: "high",
						confidence_rationale: "I read db.js",
					},
				],
				observations: [],
				missing_information: [],
			},
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript(B3.file, B3.marker),
		);
		const { investigation } = await start(B3.branch);
		await driveInvestigation(ctx, worker(provider, executor), investigation.id);
		const done = await view(investigation.id);
		expect(done).toMatchObject({
			status: "completed",
			counts: { hypotheses: 0 },
		});
		const step = done.steps.find(
			(s: { stage: string }) => s.stage === "generate_hypotheses",
		);
		expect(step.summary).toMatchObject({
			kept: 0,
			discarded: 1,
			invalid_citations: 2,
		});
		const report = (
			await get(`/api/v1/investigations/${investigation.id}/report`)
		).report;
		expect(report.limitations.join(" ")).toContain(
			"never collected were removed",
		);
	});

	it("rejects patches that touch package manifests before anything is applied", async () => {
		const provider = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
			generate_patch: patchOutput({
				path: "package.json",
				search: '"test": "node --test"',
				replace: '"test": "exit 0"',
			}),
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript(B3.file, B3.marker),
		);
		const { investigation } = await start(B3.branch);
		await driveInvestigation(ctx, worker(provider, executor), investigation.id);
		const done = await view(investigation.id);
		expect(done).toMatchObject({
			status: "completed",
			latest_verification: null,
		});
		const patches = (
			await get(`/api/v1/investigations/${investigation.id}/patches`)
		).items;
		expect(
			patches.map((p: { status: string; apply_error: { code: string } }) => [
				p.status,
				p.apply_error.code,
			]),
		).toEqual([
			["apply_failed", "patch_rejected_by_policy"],
			["apply_failed", "patch_rejected_by_policy"],
		]);
		expect(purposes(executor).some((p) => p.includes("post_patch"))).toBe(
			false,
		);
	});
});

describe("repository authorization at collection time", () => {
	const provider = () =>
		scriptedProvider({ normalize_bug_report: normalizationOutput });
	const unavailable = () =>
		fakeExecutor(workspacesRoot(ctx.config), () => ({}), {
			available: false,
		});

	it("refuses a repository that now belongs to another workspace", async () => {
		const { investigation, repository } = await start(B3.branch);
		const other = `wsp_${"Z".repeat(26)}`;
		await ctx.db.insert(workspaces).values({ id: other, name: "other" });
		await ctx.db
			.update(repositories)
			.set({ workspaceId: other })
			.where(eq(repositories.id, repository.id));
		const deps = worker(provider(), unavailable());
		for (const stage of ["normalize", "collect_context"] as const)
			await handleStageJob(deps, {
				investigationId: investigation.id,
				stage,
				attempt: 1,
			});
		expect((await view(investigation.id)).failure).toMatchObject({
			stage: "collect_context",
			code: "repository_access_denied",
		});
	});

	it("refuses a registered path that was replaced by a link", async () => {
		const repo = makeGitRepo(ctx.repoRoot, "swapped");
		const repository = (
			await session(
				"POST",
				"/api/v1/repositories",
				repositoryBody(repo, "swapped"),
			)
		).json().repository;
		const bug = (
			await session("POST", "/api/v1/bug-reports", {
				...B3.report,
				repository_id: repository.id,
			})
		).json().bug_report;
		const investigation = (
			await session("POST", "/api/v1/investigations", {
				bug_report_id: bug.id,
			})
		).json().investigation;
		const moved = `${repo}-moved`;
		renameSync(repo, moved);
		symlinkSync(moved, repo, "junction");
		const deps = worker(provider(), unavailable());
		for (const stage of ["normalize", "collect_context"] as const)
			await handleStageJob(deps, {
				investigationId: investigation.id,
				stage,
				attempt: 1,
			});
		expect((await view(investigation.id)).failure).toMatchObject({
			stage: "collect_context",
			code: "repository_path_not_allowed",
		});
	});

	it("hides another workspace's results (404 on every result route and on approval)", async () => {
		const provider2 = scriptedProvider({
			normalize_bug_report: normalizationOutput,
			plan_reproduction: plan(),
			generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
			generate_patch: patchOutput(),
		});
		const executor = fakeExecutor(
			workspacesRoot(ctx.config),
			benchScript(B3.file, B3.marker),
		);
		const { investigation } = await start(B3.branch);
		await driveInvestigation(
			ctx,
			worker(provider2, executor),
			investigation.id,
		);
		const patch = (
			await get(`/api/v1/investigations/${investigation.id}/patches`)
		).items[0];
		await createOwner(ctx.db, "intruder@example.com");
		const intruder = asSession(ctx, await login(ctx, "intruder@example.com"));
		for (const url of [
			`/api/v1/investigations/${investigation.id}/findings`,
			`/api/v1/investigations/${investigation.id}/reproductions`,
			`/api/v1/investigations/${investigation.id}/patches`,
			`/api/v1/investigations/${investigation.id}/report`,
			`/api/v1/patches/${patch.id}`,
			`/api/v1/patches/${patch.id}/diff`,
			`/api/v1/verifications/${patch.verification.id}`,
		])
			expect((await intruder("GET", url)).statusCode).toBe(404);
		expect(
			(
				await intruder("POST", `/api/v1/patches/${patch.id}/approval`, {
					decision: "approved",
					verification_id: patch.verification.id,
				})
			).statusCode,
		).toBe(404);
	});
});
