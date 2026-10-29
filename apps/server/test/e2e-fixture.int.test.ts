import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAssessJob } from "../src/modules/assessment.ts";
import { runIndexJob } from "../src/modules/graph.ts";
import { workspacesRoot } from "../src/modules/workspace.ts";
import { QUEUES } from "../src/queue.ts";
import type { SandboxRunRequest } from "../src/sandbox/executor.ts";
import type { WorkerDeps } from "../src/worker/handlers.ts";
import { BUG, createFixtureRepository, SCENARIO } from "./e2e/fixture.ts";
import { createFixtureProvider } from "./e2e/fixture-provider.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	driveInvestigation,
	type FakeRun,
	fakeExecutor,
	login,
	repositoryBody,
	resetDatabase,
	type TestContext,
	tapOutput,
} from "./helpers.ts";

// The E2E fixture provider through the real API, rules, and pipeline [mock, fake executor]. Browser
// E2E (apps/web/e2e) runs the same provider with the real Docker sandbox; this test checks fast that
// its outputs fit the contracts and that every outcome still comes from the product's own rules.

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

async function registerFixture(name: string) {
	const dir = createFixtureRepository(path.join(ctx.repoRoot, name));
	const repository = (
		await session("POST", "/api/v1/repositories", repositoryBody(dir, name))
	).json().repository;
	for (;;) {
		const { rows } = await ctx.pool.query<{
			id: string;
			data: { snapshotId: string };
		}>(
			"SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' LIMIT 1",
			[QUEUES.index],
		);
		const job = rows[0];
		if (!job) break;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [job.id]);
		await runIndexJob({ db: ctx.db, config: ctx.config }, job.data.snapshotId);
	}
	return repository as { id: string };
}

/** node:test simulated without executing code: the bug marker in the run copy decides the result. */
function script(request: SandboxRunRequest): FakeRun {
	const buggy = readFileSync(
		path.join(request.workspace, "src", "math.js"),
		"utf8",
	).includes(BUG.marker);
	if (request.argv.includes(".tracera/repro/repro.mjs"))
		return {
			exitCode: buggy ? 1 : 0,
			stdout: tapOutput([
				{ name: "string prices are added as numbers", ok: !buggy },
			]),
		};
	return {
		exitCode: 0,
		stdout: tapOutput([{ name: "total sums prices", ok: true }]),
	};
}

async function investigate(
	repositoryId: string,
	title: string,
	mode: "full" | "analysis_only" = "full",
) {
	const bug = (
		await session("POST", "/api/v1/bug-reports", {
			title,
			description: 'total() returns "023" for prices "2" and 3.',
			expected_behavior: "total([{price: '2'}, {price: 3}]) is 5",
			repository_id: repositoryId,
			normalize: false,
		})
	).json().bug_report;
	const investigation = (
		await session("POST", "/api/v1/investigations", {
			bug_report_id: bug.id,
			mode,
		})
	).json().investigation;
	const executor = fakeExecutor(workspacesRoot(ctx.config), script);
	const deps: WorkerDeps = {
		config: ctx.config,
		db: ctx.db,
		pool: ctx.pool,
		boss: ctx.boss,
		provider: createFixtureProvider(),
		executor,
		workerId: "test-worker",
	};
	await driveInvestigation(ctx, deps, investigation.id);
	return (
		await session("GET", `/api/v1/investigations/${investigation.id}`)
	).json().investigation;
}

describe("E2E fixture provider [mock]", () => {
	it("answers with one supported and one unsupported claim, labelled mock", async () => {
		const repository = await registerFixture("tiny-answer");
		const created = await session(
			"POST",
			`/api/v1/repositories/${repository.id}/questions`,
			{ question: "Where is the order total computed?" },
		);
		expect(created.statusCode).toBe(202);
		const id = created.json().assessment.id as string;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
			QUEUES.assess,
		]);
		await runAssessJob(
			{ db: ctx.db, config: ctx.config, provider: createFixtureProvider() },
			id,
		);
		const { assessment } = (
			await session("GET", `/api/v1/assessments/${id}`)
		).json();
		expect(assessment.status).toBe("completed");
		expect(
			assessment.result.claims.map((c: { supported: boolean }) => c.supported),
		).toEqual([true, false]);
		expect(assessment.result.claims[0].statement).toContain("[mock fixture]");
	});

	it("reaches verified only through a reproduction that fails before and passes after the patch", async () => {
		const repository = await registerFixture("tiny-verified");
		const view = await investigate(
			repository.id,
			`${SCENARIO.verified} String prices are concatenated`,
		);
		expect(view).toMatchObject({
			status: "awaiting_approval",
			baseline_reproduction: { status: "reproduced" },
			latest_verification: { outcome: "verified", outcome_reasons: [] },
		});
	});

	it("leaves the same patch unverified when nothing reproduced the bug", async () => {
		const repository = await registerFixture("tiny-unverified");
		const view = await investigate(
			repository.id,
			`${SCENARIO.unverified} String prices are concatenated`,
		);
		expect(view.status).toBe("awaiting_approval");
		expect(view.latest_verification.outcome).toBe("partially_verified");
		expect(view.latest_verification.outcome_reasons).toContain(
			"baseline_not_attempted",
		);
	});

	it("blocks verification in analysis-only mode", async () => {
		const repository = await registerFixture("tiny-blocked");
		const view = await investigate(
			repository.id,
			`${SCENARIO.unverified} String prices are concatenated`,
			"analysis_only",
		);
		expect(view.latest_verification.outcome).toBe("blocked");
		expect(view.latest_verification.outcome_reasons).toContain(
			"analysis_only_requested",
		);
	});
});
