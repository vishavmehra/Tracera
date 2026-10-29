import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	bugReports,
	investigationSteps,
	investigations,
	modelExecutions,
} from "../src/db/schema.ts";
import { ProviderError } from "../src/inference/providers.ts";
import { createUnavailableExecutor } from "../src/sandbox/executor.ts";
import {
	handleNormalizeJob,
	handleStageJob,
	type WorkerDeps,
} from "../src/worker/handlers.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	fixedProvider,
	login,
	makeGitRepo,
	normalizationOutput,
	repositoryBody,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

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

const deps = (
	provider: ReturnType<typeof fixedProvider>,
	overrides: Partial<WorkerDeps["config"]["inference"]> = {},
): WorkerDeps => ({
	config: {
		...ctx.config,
		inference: {
			...ctx.config.inference,
			reasoningModel: "muse-spark-1.3",
			taskModels: {
				normalize_bug_report: "muse-spark-1.3",
				plan_reproduction: "muse-spark-1.3",
				generate_hypotheses: "muse-spark-1.3",
				generate_patch: "muse-spark-1.3",
				assess_feasibility: "muse-spark-1.3",
				answer_question: "muse-spark-1.3",
			},
			...overrides,
		},
	},
	db: ctx.db,
	pool: ctx.pool,
	boss: ctx.boss,
	provider,
	executor: createUnavailableExecutor("sandbox_disabled"),
	workerId: "test-worker",
});

async function queuedStages(investigationId: string) {
	const { rows } = await ctx.pool.query<{ stage: string; attempt: number }>(
		"SELECT data->>'stage' AS stage, (data->>'attempt')::int AS attempt FROM pgboss.job WHERE name = 'investigation.stage' AND state = 'created' AND data->>'investigationId' = $1 ORDER BY created_on",
		[investigationId],
	);
	return rows;
}

async function createReport(body: Record<string, unknown> = {}) {
	const response = await session("POST", "/api/v1/bug-reports", {
		title: "Average order value is wrong",
		description: "Dashboard shows $12.40.",
		expected_behavior: "$24.80 for two orders totaling $49.60",
		...body,
	});
	return response.json().bug_report as { id: string; workspace_id?: string };
}

async function workspaceOf(bugReportId: string) {
	const [row] = await ctx.db
		.select()
		.from(bugReports)
		.where(eq(bugReports.id, bugReportId));
	return row?.workspaceId ?? "";
}

describe("intake normalization", () => {
	it("fills only empty fields, marks them AI-inferred, and records the model execution", async () => {
		const bug = await createReport();
		const provider = fixedProvider(normalizationOutput);
		await handleNormalizeJob(deps(provider), {
			bugReportId: bug.id,
			workspaceId: await workspaceOf(bug.id),
		});
		const body = (await session("GET", `/api/v1/bug-reports/${bug.id}`)).json()
			.bug_report;
		expect(provider.calls).toBe(1);
		expect(body.normalization.status).toBe("done");
		expect(body.normalization.summary).toContain("$12.40");
		expect(body.expected_behavior).toBe(
			"$24.80 for two orders totaling $49.60",
		);
		expect(body.field_provenance.expected_behavior.source).toBe(
			"user_provided",
		);
		expect(body.actual_behavior).toBe("Average order value shows $12.40");
		expect(body.field_provenance.actual_behavior).toMatchObject({
			source: "ai_inferred",
			basis: "stated_by_user",
		});
		expect(body.field_provenance.steps).toMatchObject({
			source: "ai_inferred",
			basis: "inferred",
		});
		expect(body.severity).toBe("unknown");
		expect(body.normalization.severity_suggestion).toBe("medium");
		expect(body.suspected_components[0]).toEqual({
			label: "dashboard metrics",
			source: "ai_inferred",
		});
		const executions = await ctx.db
			.select()
			.from(modelExecutions)
			.where(eq(modelExecutions.bugReportId, bug.id));
		expect(executions).toHaveLength(1);
		expect(executions[0]).toMatchObject({
			status: "succeeded",
			task: "normalize_bug_report",
			provider: "fixed",
			model: "muse-spark-1.3",
		});
		expect(Number(executions[0]?.estimatedCostUsd)).toBeGreaterThan(0);
	});

	it("records a precise failure when the provider rejects the call", async () => {
		const bug = await createReport();
		const provider = fixedProvider(
			new ProviderError(
				"provider_billing_not_configured",
				"Model provider billing is not configured",
				false,
			),
		);
		await handleNormalizeJob(deps(provider), {
			bugReportId: bug.id,
			workspaceId: await workspaceOf(bug.id),
		});
		const body = (await session("GET", `/api/v1/bug-reports/${bug.id}`)).json()
			.bug_report;
		expect(body.normalization).toMatchObject({
			status: "failed",
			error: { code: "provider_billing_not_configured" },
		});
		expect(body.actual_behavior).toBeNull();
		const [execution] = await ctx.db
			.select()
			.from(modelExecutions)
			.where(eq(modelExecutions.bugReportId, bug.id));
		expect(execution?.status).toBe("failed");
	});

	it("stops calling the model once the daily budget is spent", async () => {
		const bug = await createReport();
		const provider = fixedProvider(normalizationOutput);
		await handleNormalizeJob(deps(provider, { dailyBudgetUsd: 0 }), {
			bugReportId: bug.id,
			workspaceId: await workspaceOf(bug.id),
		});
		expect(provider.calls).toBe(0);
		const body = (await session("GET", `/api/v1/bug-reports/${bug.id}`)).json()
			.bug_report;
		expect(body.normalization.error.code).toBe("inference_budget_exceeded");
	});
});

describe("investigation lifecycle (orchestration)", () => {
	async function startInvestigation() {
		const repo = makeGitRepo(ctx.repoRoot);
		const repository = (
			await session("POST", "/api/v1/repositories", repositoryBody(repo))
		).json().repository;
		const bug = await createReport({
			repository_id: repository.id,
			normalize: false,
		});
		const investigation = (
			await session("POST", "/api/v1/investigations", { bug_report_id: bug.id })
		).json().investigation;
		return { bug, investigation, repo };
	}

	async function steps(investigationId: string) {
		const rows = await ctx.db
			.select()
			.from(investigationSteps)
			.where(eq(investigationSteps.investigationId, investigationId));
		return rows.map((row) => ({
			stage: row.stage,
			attempt: row.attempt,
			status: row.status,
			code: row.error?.code ?? null,
		}));
	}

	it("runs normalize, records it, and hands off to collect_context in the same transaction", async () => {
		const { bug, investigation } = await startInvestigation();
		const provider = fixedProvider(normalizationOutput);
		await handleStageJob(deps(provider), {
			investigationId: investigation.id,
			stage: "normalize",
			attempt: 1,
		});
		const body = (
			await session("GET", `/api/v1/investigations/${investigation.id}`)
		).json().investigation;
		expect(provider.calls).toBe(1);
		expect(await steps(investigation.id)).toEqual([
			{ stage: "normalize", attempt: 1, status: "succeeded", code: null },
		]);
		expect(await queuedStages(investigation.id)).toContainEqual({
			stage: "collect_context",
			attempt: 1,
		});
		expect(body).toMatchObject({
			status: "running",
			current_stage: "normalize",
			failure: null,
			latest_verification: null,
		});
		expect(body.state_version).toBeGreaterThanOrEqual(2);
		expect(
			(await session("GET", `/api/v1/bug-reports/${bug.id}`)).json().bug_report
				.status,
		).toBe("investigating");
		const usage = (
			await session(
				"GET",
				`/api/v1/investigations/${investigation.id}/model-executions`,
			)
		).json();
		expect(usage.items).toHaveLength(1);
		expect(usage.totals.estimated_cost_usd).toBeGreaterThan(0);
	});

	it("ignores a redelivered job for a step that already finished", async () => {
		const { investigation } = await startInvestigation();
		const provider = fixedProvider(normalizationOutput);
		const job = {
			investigationId: investigation.id,
			stage: "normalize" as const,
			attempt: 1,
		};
		await handleStageJob(deps(provider), job);
		await handleStageJob(deps(provider), job);
		expect(provider.calls).toBe(1);
		expect(
			(await queuedStages(investigation.id)).filter(
				(queued) => queued.stage === "collect_context",
			),
		).toHaveLength(1);
	});

	it("skips normalization that already happened at intake", async () => {
		const { bug, investigation } = await startInvestigation();
		await handleNormalizeJob(deps(fixedProvider(normalizationOutput)), {
			bugReportId: bug.id,
			workspaceId: await workspaceOf(bug.id),
		});
		const provider = fixedProvider(normalizationOutput);
		await handleStageJob(deps(provider), {
			investigationId: investigation.id,
			stage: "normalize",
			attempt: 1,
		});
		expect(provider.calls).toBe(0);
		expect((await steps(investigation.id))[0]).toMatchObject({
			stage: "normalize",
			status: "skipped",
		});
	});

	it("treats a normalization failure as non-fatal, records it, and continues", async () => {
		const { investigation } = await startInvestigation();
		const provider = fixedProvider(
			new ProviderError(
				"provider_unavailable",
				"Model provider error 503",
				true,
			),
		);
		await handleStageJob(deps(provider), {
			investigationId: investigation.id,
			stage: "normalize",
			attempt: 1,
		});
		expect((await steps(investigation.id))[0]).toMatchObject({
			stage: "normalize",
			status: "failed",
			code: "provider_unavailable",
		});
		const [row] = await ctx.db
			.select()
			.from(investigations)
			.where(eq(investigations.id, investigation.id));
		expect(row).toMatchObject({ status: "running", failure: null });
		expect(await queuedStages(investigation.id)).toContainEqual({
			stage: "collect_context",
			attempt: 1,
		});
	});

	it("does not call the model for an investigation cancelled before it ran", async () => {
		const { investigation } = await startInvestigation();
		await session("POST", `/api/v1/investigations/${investigation.id}/cancel`);
		const provider = fixedProvider(normalizationOutput);
		await handleStageJob(deps(provider), {
			investigationId: investigation.id,
			stage: "normalize",
			attempt: 1,
		});
		expect(provider.calls).toBe(0);
		expect(
			(
				await session("GET", `/api/v1/investigations/${investigation.id}`)
			).json().investigation.status,
		).toBe("cancelled");
	});

	it("fails with a typed error when the repository disappears, and retries from the failed stage with a new attempt", async () => {
		const { investigation, repo } = await startInvestigation();
		const worker = deps(fixedProvider(normalizationOutput));
		await handleStageJob(worker, {
			investigationId: investigation.id,
			stage: "normalize",
			attempt: 1,
		});
		rmSync(repo, { recursive: true, force: true });
		await handleStageJob(worker, {
			investigationId: investigation.id,
			stage: "collect_context",
			attempt: 1,
		});
		const failed = (
			await session("GET", `/api/v1/investigations/${investigation.id}`)
		).json().investigation;
		expect(failed).toMatchObject({
			status: "failed",
			failure: { stage: "collect_context", code: "repository_unavailable" },
		});
		const retried = await session(
			"POST",
			`/api/v1/investigations/${investigation.id}/retry`,
		);
		expect(retried.statusCode).toBe(202);
		expect(retried.json().investigation).toMatchObject({
			status: "queued",
			failure: null,
		});
		expect(await queuedStages(investigation.id)).toContainEqual({
			stage: "collect_context",
			attempt: 2,
		});
		await handleStageJob(worker, {
			investigationId: investigation.id,
			stage: "collect_context",
			attempt: 2,
		});
		expect(await steps(investigation.id)).toContainEqual({
			stage: "collect_context",
			attempt: 2,
			status: "failed",
			code: "repository_unavailable",
		});
		expect(
			(
				await session("GET", `/api/v1/investigations/${investigation.id}`)
			).json().investigation.status,
		).toBe("failed");
	});
});
