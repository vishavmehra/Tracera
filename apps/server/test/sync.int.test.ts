import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	RepositorySyncStatusSchema,
	RepositoryUpdateSchema,
} from "@tracera/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../src/db/client.ts";
import type { ChatRequest } from "../src/inference/providers.ts";
import { runAssessJob } from "../src/modules/assessment.ts";
import { WORKER_ACTOR } from "../src/modules/audit.ts";
import { runIndexJob } from "../src/modules/graph.ts";
import {
	recoverLostSyncs,
	requestSync,
	runReconcileJob,
	runSyncJob,
	settleUpdates,
} from "../src/modules/sync.ts";
import { QUEUES } from "../src/queue.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	login,
	makeGitRepo,
	repositoryBody,
	resetDatabase,
	scriptedProvider,
	type TestContext,
} from "./helpers.ts";

// Repository synchronization without any provider: local repositories,
// reconciliation through git plumbing, failed-update tracking and recovery. Repository code never runs.

let ctx: TestContext;
let session: ReturnType<typeof asSession>;
const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
const deps = () => ({
	db: ctx.db,
	pool: ctx.pool,
	boss: ctx.boss,
	config: ctx.config,
	log: (message: string, fields: Record<string, unknown>) =>
		logs.push({ message, fields }),
});

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await ctx.pool.query("DELETE FROM pgboss.job WHERE name = ANY($1)", [
		[QUEUES.sync, QUEUES.reconcile, QUEUES.assess],
	]);
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
	logs.length = 0;
});

/** Runs a queue's created jobs in-process, in order, as a worker would. */
async function drain(
	queue: string,
	run: (data: Record<string, string>) => Promise<void>,
): Promise<number> {
	let handled = 0;
	for (;;) {
		const { rows } = await ctx.pool.query<{
			id: string;
			data: Record<string, string>;
		}>(
			"SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' ORDER BY created_on LIMIT 1",
			[queue],
		);
		const job = rows[0];
		if (!job) return handled;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [job.id]);
		await run(job.data);
		handled += 1;
	}
}
const drainIndex = () =>
	drain(QUEUES.index, (data) =>
		runIndexJob({ db: ctx.db, config: ctx.config }, data.snapshotId ?? ""),
	);
const drainSync = () =>
	drain(QUEUES.sync, (data) => runSyncJob(deps(), data.updateId ?? ""));

function commit(dir: string, files: Record<string, string>, message: string) {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), content);
	}
	git("add", "-A");
	git(
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"-m",
		message,
	);
	return git("rev-parse", "HEAD").trim();
}

async function registerLocal(name: string, files: Record<string, string>) {
	const dir = makeGitRepo(ctx.repoRoot, name);
	commit(dir, files, "add sources");
	const response = await session(
		"POST",
		"/api/v1/repositories",
		repositoryBody(dir, name),
	);
	expect(response.statusCode).toBe(201);
	expect(await drainIndex()).toBe(1);
	return { dir, id: response.json().repository.id as string };
}

const updatesOf = async (repositoryId: string) =>
	(
		await ctx.pool.query(
			"SELECT * FROM repository_updates WHERE repository_id = $1 ORDER BY created_at",
			[repositoryId],
		)
	).rows;

describe("scheduled reconciliation [git plumbing, no execution]", () => {
	it("detects a moved ref, indexes the new head once, and stays idempotent", async () => {
		const { dir, id } = await registerLocal("moving", {
			"src/a.js": "export const a = 1;\n",
			// Writes a marker if anything ever executed it; indexing and sync only parse text.
			"src/run.js":
				"require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'EXECUTED'), '1');\n",
		});
		expect(await runReconcileJob(deps())).toEqual({
			checked: 1,
			requested: 0,
			skipped: 0,
			failed: 0,
		});

		const moved = commit(dir, { "src/b.js": "export const b = 2;\n" }, "add b");
		const profile = (
			await session("GET", `/api/v1/repositories/${id}/profile`)
		).json();
		expect(profile.freshness).toMatchObject({
			stale: true,
			reasons: ["ref_moved"],
			current_commit: moved,
		});

		expect(await runReconcileJob(deps())).toMatchObject({ requested: 1 });
		// While the update is in flight, another run requests nothing.
		expect(await runReconcileJob(deps())).toMatchObject({
			requested: 0,
			checked: 1,
		});
		const [update] = await updatesOf(id);
		expect(update).toMatchObject({
			trigger: "reconcile",
			ref: "main",
			target_sha: moved,
			status: "pending",
		});

		expect(await drainSync()).toBe(1);
		expect(await drainIndex()).toBe(1);
		await settleUpdates(ctx.db);
		const status = RepositorySyncStatusSchema.parse(
			(await session("GET", `/api/v1/repositories/${id}/sync`)).json(),
		);
		expect(status).toMatchObject({
			source: "local",
			tracked_ref: "main",
			freshness: { stale: false, indexed_commit: moved, reasons: [] },
			latest_indexed: { commit_sha: moved, status: "ready" },
			summary: { pending: 0, failed: 0, latest_known_commit: moved },
			pending: [],
			failed: [],
		});
		expect(status.recent[0]).toMatchObject({
			trigger: "reconcile",
			status: "indexed",
			target_sha: moved,
			indexed_sha: moved,
		});
		expect(await runReconcileJob(deps())).toMatchObject({
			requested: 0,
			checked: 1,
		});
		expect(await updatesOf(id)).toHaveLength(1);
		expect(existsSync(path.join(dir, "EXECUTED"))).toBe(false);
	});

	it("bounds automatic retries of a failing head", async () => {
		const { dir, id } = await registerLocal("retries", {
			"src/a.js": "export const a = 1;\n",
		});
		commit(dir, { "src/b.js": "export const b = 2;\n" }, "add b");
		// Each sync of this head fails with a retryable error (the job is lost before it runs).
		for (let round = 0; round < 5; round++) {
			await runReconcileJob(deps());
			await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
				QUEUES.sync,
			]);
			await ctx.pool.query(
				"UPDATE repository_updates SET updated_at = now() - interval '10 minutes' WHERE status = 'pending'",
			);
			await recoverLostSyncs(ctx.db);
		}
		const updates = await updatesOf(id);
		expect(updates).toHaveLength(3);
		expect(
			updates.every(
				(update) =>
					update.status === "failed" && update.error.code === "job_lost",
			),
		).toBe(true);
		const audits = await ctx.pool.query(
			"SELECT count(*)::int AS n FROM audit_events WHERE action = 'repository.sync_recovered'",
		);
		expect(audits.rows[0].n).toBe(3);
	});
});

describe("pending and failed updates", () => {
	it("records a failed update, exposes it per repository, and recovers with a manual sync", async () => {
		const { dir, id } = await registerLocal("fragile", {
			"src/a.js": "export const a = 1;\n",
		});
		const away = `${dir}-away`;
		renameSync(dir, away);

		const requested = await session("POST", `/api/v1/repositories/${id}/sync`);
		expect(requested.statusCode).toBe(202);
		const update = RepositoryUpdateSchema.parse(requested.json().update);
		expect(update).toMatchObject({
			trigger: "manual",
			status: "pending",
			ref: "main",
		});
		// A second request joins the pending update instead of queueing more work.
		const again = await session("POST", `/api/v1/repositories/${id}/sync`);
		expect(again.statusCode).toBe(200);
		expect(again.json().update).toMatchObject({ id: update.id, coalesced: 1 });
		const pendingView = (
			await session("GET", `/api/v1/repositories/${id}`)
		).json().repository;
		expect(pendingView.sync).toMatchObject({ pending: 1, failed: 0 });

		expect(await drainSync()).toBe(1);
		const failedView = (
			await session("GET", `/api/v1/repositories/${id}`)
		).json().repository;
		expect(failedView.sync).toMatchObject({
			pending: 0,
			failed: 1,
			failed_deliveries: 0,
			last_failure: { update_id: update.id, code: "repository_unavailable" },
		});
		const listed = (await session("GET", "/api/v1/repositories")).json().items;
		expect(listed[0].sync).toMatchObject({ failed: 1 });
		const status = RepositorySyncStatusSchema.parse(
			(await session("GET", `/api/v1/repositories/${id}/sync`)).json(),
		);
		expect(status.failed).toHaveLength(1);
		expect(status.failed[0]).toMatchObject({
			id: update.id,
			attempts: 1,
			error: { code: "repository_unavailable" },
		});
		expect(status.freshness).toMatchObject({
			stale: null,
			reasons: ["source_unavailable"],
		});
		// Reconciliation cannot read the source either: it skips instead of piling up failures.
		expect(await runReconcileJob(deps())).toMatchObject({
			requested: 0,
			skipped: 1,
		});

		// Recovery: the source is back with a new commit, and the owner retries.
		renameSync(away, dir);
		const fixed = commit(dir, { "src/c.js": "export const c = 3;\n" }, "c");
		const retry = await session("POST", `/api/v1/repositories/${id}/sync`);
		expect(retry.statusCode).toBe(202);
		expect(await drainSync()).toBe(1);
		expect(await drainIndex()).toBe(1);
		await settleUpdates(ctx.db);
		const recovered = (
			await session("GET", `/api/v1/repositories/${id}`)
		).json().repository;
		expect(recovered.sync).toMatchObject({
			pending: 0,
			failed: 0,
			last_failure: null,
		});
		expect(recovered.index).toMatchObject({
			commit_sha: fixed,
			status: "ready",
		});
		const history = RepositorySyncStatusSchema.parse(
			(await session("GET", `/api/v1/repositories/${id}/sync`)).json(),
		);
		expect(history.recent.map((item) => item.status)).toEqual([
			"indexed",
			"superseded",
		]);
		// The earlier failure stays on record with its reason.
		expect(history.recent[1]?.error).toMatchObject({
			code: "repository_unavailable",
		});
	});

	it("settles updates from their snapshot and recovers lost sync jobs", async () => {
		const { dir, id } = await registerLocal("settle", {
			"src/a.js": "export const a = 1;\n",
		});
		const head = commit(dir, { "src/b.js": "export const b = 2;\n" }, "b");
		const { rows } = await ctx.pool.query(
			"SELECT workspace_id FROM repositories WHERE id = $1",
			[id],
		);
		const workspaceId = rows[0].workspace_id as string;
		const request = () =>
			withTransaction(ctx.pool, (tx) =>
				requestSync(
					ctx,
					tx,
					{
						workspaceId,
						repositoryId: id,
						ref: "main",
						trigger: "reconcile",
						targetSha: head,
						actor: WORKER_ACTOR,
					},
					null,
				),
			);
		const first = await request();
		const second = await request();
		expect(first.created).toBe(true);
		expect(second).toMatchObject({
			created: false,
			update: { id: first.update.id, coalesced: 1 },
		});
		const jobs = await ctx.pool.query(
			"SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1",
			[QUEUES.sync],
		);
		expect(jobs.rows[0].n).toBe(1);

		// The snapshot fails to index: the update settles as failed with the snapshot's error.
		expect(await drainSync()).toBe(1);
		expect((await updatesOf(id))[0]).toMatchObject({ status: "indexing" });
		await ctx.pool.query(
			`UPDATE repository_snapshots SET status = 'failed', error = '{"code":"index_timeout","message":"Indexing exceeded its time budget","retryable":true}', finished_at = now() WHERE commit_sha = $1`,
			[head],
		);
		await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
			QUEUES.index,
		]);
		expect(await settleUpdates(ctx.db)).toBe(1);
		expect((await updatesOf(id))[0]).toMatchObject({
			status: "failed",
			error: { code: "index_timeout", retryable: true },
		});
		// A retryable failure is retried by reconciliation, which re-queues the failed snapshot.
		expect(await runReconcileJob(deps())).toMatchObject({ requested: 1 });
		expect(await drainSync()).toBe(1);
		expect(await drainIndex()).toBe(1);
		await settleUpdates(ctx.db);
		const statuses = (await updatesOf(id)).map((update) => update.status);
		expect(statuses).toEqual(["superseded", "indexed"]);
	});
});

describe("stale snapshots in answers [scripted model]", () => {
	it("discloses that an answer comes from a stale snapshot", async () => {
		const { dir, id } = await registerLocal("stale", {
			"src/pricing.js":
				"export function shippingCents(total) {\n  return total >= 5000 ? 0 : 499;\n}\n",
		});
		// The ref moves after indexing; the answer still comes from the indexed snapshot.
		commit(
			dir,
			{
				"src/pricing.js":
					"export function shippingCents(total) {\n  return total >= 7500 ? 0 : 499;\n}\n",
			},
			"raise the threshold",
		);
		const provider = scriptedProvider({
			answer_question: (request: ChatRequest) => {
				const user =
					request.messages.filter((m) => m.role === "user").at(-1)?.content ??
					"";
				const handle =
					/<untrusted source="(CODE-\d+)"[^>]*path="src\/pricing\.js"/.exec(
						user,
					)?.[1] ?? "CODE-missing";
				return {
					status: "ANSWERED",
					answer: "shippingCents in src/pricing.js decides free shipping.",
					claims: [
						{
							statement: "shippingCents returns 0 above the threshold.",
							citations: [{ handle, start_line: null, end_line: null }],
						},
					],
					unknowns: [],
					follow_up_questions: [],
					confidence: "high",
					confidence_rationale: "The function is in the excerpt.",
				};
			},
		});
		const asked = await session(
			"POST",
			`/api/v1/repositories/${id}/questions`,
			{
				question: "Where is the free shipping threshold decided?",
			},
		);
		expect(asked.statusCode).toBe(202);
		const assessmentId = asked.json().assessment.id as string;
		await runAssessJob(
			{ db: ctx.db, config: ctx.config, provider },
			assessmentId,
		);
		const { assessment } = (
			await session("GET", `/api/v1/assessments/${assessmentId}`)
		).json();
		expect(assessment.status).toBe("completed");
		expect(assessment.result.snapshot.freshness).toMatchObject({
			stale: true,
			reasons: ["ref_moved"],
		});
		expect(assessment.result.limitations).toContain(
			"The snapshot is stale (ref_moved); the code may have changed since it was indexed.",
		);
		// The model said "high"; a stale snapshot caps it.
		expect(assessment.result).toMatchObject({
			model_confidence: "high",
			confidence: "medium",
		});
		expect(assessment.result.downgrades).toContain("stale_snapshot");
		expect(assessment.result.claims[0]).toMatchObject({ supported: true });
	});
});

describe("workspace isolation", () => {
	it("hides another workspace's sync status and refuses its manual sync", async () => {
		const { id } = await registerLocal("private", {
			"src/a.js": "export const a = 1;\n",
		});
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		expect(
			(await other("GET", `/api/v1/repositories/${id}/sync`)).statusCode,
		).toBe(404);
		expect(
			(await other("POST", `/api/v1/repositories/${id}/sync`)).statusCode,
		).toBe(404);
		expect(await updatesOf(id)).toHaveLength(0);
	});
});
