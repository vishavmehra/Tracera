import { mkdir, stat } from "node:fs/promises";
import {
	PatchImpactRequestSchema,
	type RepositorySyncStatus,
	type RepositoryUpdateTrigger,
} from "@tracera/contracts";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, type QueueDb, withTransaction } from "../db/client.ts";
import {
	githubInstallations,
	githubRepositories,
	repositories,
	repositorySnapshots,
	repositoryUpdates,
	webhookDeliveries,
} from "../db/schema.ts";
import { git, resolveCommit } from "../lib/git.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { redactSecrets } from "../lib/redact.ts";
import { enqueueSync, QUEUES } from "../queue.ts";
import { type Actor, audit, WORKER_ACTOR } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import { ContextError, verifySourcePath } from "./context.ts";
import {
	branchHead,
	defaultGitHubClient,
	evaluatePermissions,
	fetchInvocation,
	type GitHubClient,
	GitHubError,
	installationToken,
} from "./github-app.ts";
import { queueSnapshot, toSnapshotView } from "./graph.ts";
import { EXTRACTOR_VERSION } from "./graph-extract.ts";
import { snapshotFreshness } from "./graph-queries.ts";
import { createPatchAnalysis } from "./patch-analysis.ts";
import {
	syncSummaries,
	toDeliveryView,
	toUpdateView,
	type UpdateRow,
} from "./sync-status.ts";
import { sourceCachePath, sourcesRoot } from "./workspace.ts";

// Repository synchronization. A trigger (connection, webhook,
// reconciliation, manual sync) records a `repository_updates` row; the `repository.sync` job brings the
// ref's head into reach (a `git fetch` into Tracera's bare cache for GitHub repositories, nothing for
// local ones, which are read in place) and hands that exact commit to the indexing service, or to
// patch impact for a pull request. Webhooks are signals to look, not proof of anything: what gets
// indexed is always the head the sync observed.

export const RECONCILE_INTERVAL_SECONDS = 300;
const RECONCILE_LIMIT = 200;
const RECONCILE_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 600_000;
/** A sync claimed longer ago than its queue's expiry belongs to a dead worker; pg-boss retries it. */
const STALE_SYNC_MS = 15 * 60_000;
const MAX_AUTOMATIC_ATTEMPTS = 3;

export type SyncDeps = {
	db: Db;
	pool: pg.Pool;
	boss: PgBoss;
	config: Config;
	github?: GitHubClient;
	log?: (message: string, fields: Record<string, unknown>) => void;
};

type RepositoryRow = typeof repositories.$inferSelect;
type Failure = { code: string; message: string; retryable: boolean };

export type SyncRequest = {
	workspaceId: string;
	repositoryId: string;
	ref: string;
	trigger: RepositoryUpdateTrigger;
	/** The commit the trigger reported; null asks for whatever the ref points to. */
	targetSha?: string | null;
	deliveryId?: string | null;
	pullRequest?: { number: number; base_ref: string } | null;
	requestedBy?: string | null;
	actor: Actor;
};

/**
 * Records a request to bring a ref up to date and queues its sync job, inside the caller's
 * transaction. While an update for the ref is still pending, later triggers merge into it (the job
 * reads the ref's head when it runs), so a burst of pushes costs one fetch and one index.
 */
export async function requestSync(
	deps: { boss: PgBoss },
	tx: { db: Db; queueDb: QueueDb },
	input: SyncRequest,
	requestId: string | null,
): Promise<{ update: UpdateRow; created: boolean }> {
	const id = newId("rup");
	const [row] = await tx.db
		.insert(repositoryUpdates)
		.values({
			id,
			workspaceId: input.workspaceId,
			repositoryId: input.repositoryId,
			trigger: input.trigger,
			ref: input.ref,
			targetSha: input.targetSha ?? null,
			deliveryId: input.deliveryId ?? null,
			pullRequest: input.pullRequest ?? null,
			status: "pending",
			requestedBy: input.requestedBy ?? null,
		})
		.onConflictDoUpdate({
			target: [repositoryUpdates.repositoryId, repositoryUpdates.ref],
			targetWhere: sql`status = 'pending'`,
			set: {
				targetSha: sql`coalesce(excluded.target_sha, ${repositoryUpdates.targetSha})`,
				deliveryId: sql`coalesce(excluded.delivery_id, ${repositoryUpdates.deliveryId})`,
				pullRequest: sql`coalesce(excluded.pull_request, ${repositoryUpdates.pullRequest})`,
				coalesced: sql`${repositoryUpdates.coalesced} + 1`,
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!row) throw new Error("repository update vanished during its request");
	const created = row.id === id;
	if (created) {
		await enqueueSync(deps.boss, tx.queueDb, { updateId: id });
		await audit(tx.db, {
			workspaceId: input.workspaceId,
			actor: input.actor,
			action: "repository.sync_requested",
			targetType: "repository_update",
			targetId: id,
			metadata: {
				repository_id: input.repositoryId,
				trigger: input.trigger,
				ref: input.ref,
				target_sha: input.targetSha ?? null,
				delivery_id: input.deliveryId ?? null,
			},
			requestId,
		});
	}
	return { update: row, created };
}

/** A repository's GitHub link and installation (null for local repositories). */
export async function githubSourceOf(db: Db, repositoryId: string) {
	const [row] = await db
		.select({ link: githubRepositories, installation: githubInstallations })
		.from(githubRepositories)
		.innerJoin(
			githubInstallations,
			eq(githubInstallations.id, githubRepositories.installationId),
		)
		.where(eq(githubRepositories.repositoryId, repositoryId))
		.limit(1);
	return row ?? null;
}
type GitHubSource = NonNullable<Awaited<ReturnType<typeof githubSourceOf>>>;

/** Permissions and access are checked before any token is minted or anything is fetched. */
function assertSyncable({ installation, link }: GitHubSource): void {
	if (installation.status === "removed")
		throw new GitHubError(
			"github_installation_removed",
			"The GitHub App installation was removed",
		);
	if (installation.status === "suspended")
		throw new GitHubError(
			"github_installation_suspended",
			"The GitHub App installation is suspended",
		);
	if (link.accessRemovedAt)
		throw new GitHubError(
			"github_repository_access_removed",
			"The installation no longer grants access to this repository",
		);
	const { problems } = evaluatePermissions(installation.permissions);
	if (problems.length > 0)
		throw new GitHubError(
			"github_permission_missing",
			`The installation lacks required permissions (${problems.join(", ")})`,
		);
}

/** Serializes fetches into one cache across workers: a session advisory lock on one connection. */
async function withRepositoryLock<T>(
	pool: pg.Pool,
	repositoryId: string,
	fn: () => Promise<T>,
): Promise<T> {
	const key = `tracera.sync:${repositoryId}`;
	const client = await pool.connect();
	let healthy = true;
	try {
		await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
			key,
		]);
		try {
			return await fn();
		} finally {
			await client
				.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
				.catch(() => {
					healthy = false;
				});
		}
	} finally {
		// A connection that may still hold the lock is closed rather than returned to the pool.
		client.release(!healthy);
	}
}

/**
 * Fetches the repository's branches (and a pull request's head) from GitHub into Tracera's bare cache
 * with a token scoped to this one repository and read-only permissions.
 */
async function fetchFromGitHub(
	deps: SyncDeps,
	repo: RepositoryRow,
	update: UpdateRow,
): Promise<void> {
	const gh = deps.config.github;
	if (!gh)
		throw new GitHubError(
			"capability_unavailable",
			"The GitHub App is not configured",
		);
	const source = await githubSourceOf(deps.db, repo.id);
	if (!source)
		throw new GitHubError(
			"github_link_missing",
			"The repository is not linked to a GitHub App installation",
		);
	assertSyncable(source);
	const client = deps.github ?? defaultGitHubClient();
	const token = await installationToken(client, gh, {
		installationId: source.installation.installationId,
		repositoryId: source.link.githubRepositoryId,
	});
	const root = sourcesRoot(deps.config);
	const cache = sourceCachePath(deps.config, repo.id);
	await mkdir(root, { recursive: true });
	await withRepositoryLock(deps.pool, repo.id, async () => {
		if (!(await stat(cache).catch(() => null))) {
			const init = await git(root, ["init", "--bare", "--quiet", cache]);
			if (!init.ok)
				throw new ContextError(
					"clone_failed",
					"Tracera could not create the repository's source cache",
					true,
				);
		}
		const refspecs = ["+refs/heads/*:refs/heads/*"];
		const pr = update.pullRequest?.number;
		if (pr) refspecs.push(`+refs/pull/${pr}/head:refs/pull/${pr}/head`);
		const { args, env } = fetchInvocation(
			client.remote,
			source.link.fullName,
			token,
			refspecs,
		);
		const fetched = await git(cache, args, {
			timeoutMs: FETCH_TIMEOUT_MS,
			env,
		});
		if (fetched.timedOut)
			throw new ContextError(
				"fetch_timeout",
				"Fetching from GitHub timed out",
				true,
			);
		if (!fetched.ok)
			throw new ContextError(
				"fetch_failed",
				`git fetch from GitHub failed (exit ${fetched.code ?? "unknown"})`,
				true,
			);
		// Clones of the cache check out the default branch name; keep HEAD pointing at it.
		await git(cache, [
			"symbolic-ref",
			"HEAD",
			`refs/heads/${repo.defaultBranch}`,
		]);
	});
}

function toFailure(error: unknown): Failure {
	if (error instanceof ContextError || error instanceof GitHubError)
		return {
			code: error.code,
			message: error.message,
			retryable: error.retryable,
		};
	if (error instanceof AppError)
		return {
			code: error.code,
			message: error.message,
			retryable: error.status >= 500,
		};
	return {
		code: "sync_failed",
		message: "Synchronization failed unexpectedly",
		retryable: true,
	};
}

/** Older failures of a ref are resolved once a newer update for it is indexed. */
async function supersedeFailures(
	db: Db,
	update: Pick<UpdateRow, "repositoryId" | "ref" | "createdAt">,
): Promise<void> {
	await db
		.update(repositoryUpdates)
		.set({ status: "superseded", updatedAt: new Date() })
		.where(
			and(
				eq(repositoryUpdates.repositoryId, update.repositoryId),
				eq(repositoryUpdates.ref, update.ref),
				eq(repositoryUpdates.status, "failed"),
				lt(repositoryUpdates.createdAt, update.createdAt),
			),
		);
}

/**
 * A pull request's head is analysed against its base with patch impact, so pull
 * requests never replace the repository's current snapshot. The analysis is recorded for the user who
 * connected the repository; the audit names the worker as the actor.
 */
async function queuePullRequestAnalysis(
	deps: SyncDeps,
	repo: RepositoryRow,
	update: UpdateRow,
	head: string,
): Promise<void> {
	const pr = update.pullRequest;
	if (!pr)
		throw new ContextError(
			"invalid_update",
			"The pull-request update has no pull request",
		);
	const source = await githubSourceOf(deps.db, repo.id);
	const { analysis } = await createPatchAnalysis(
		deps,
		{
			workspaceId: repo.workspaceId,
			userId: source?.link.createdBy ?? repo.createdBy,
			actor: WORKER_ACTOR,
		},
		repo.id,
		PatchImpactRequestSchema.parse({
			base: pr.base_ref,
			head: update.ref,
			merge_base: true,
		}),
		null,
	);
	const done = analysis.status === "completed" || analysis.status === "partial";
	await deps.db
		.update(repositoryUpdates)
		.set({
			indexedSha: head,
			patchAnalysisId: analysis.id,
			status: done ? "indexed" : "indexing",
			finishedAt: done ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(eq(repositoryUpdates.id, update.id));
}

/** The `repository.sync` job. Finished or foreign updates are ignored (idempotent redelivery). */
export async function runSyncJob(
	deps: SyncDeps,
	updateId: string,
): Promise<void> {
	const now = new Date();
	const [update] = await deps.db
		.update(repositoryUpdates)
		.set({
			status: "syncing",
			attempts: sql`${repositoryUpdates.attempts} + 1`,
			startedAt: now,
			error: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(repositoryUpdates.id, updateId),
				or(
					eq(repositoryUpdates.status, "pending"),
					and(
						eq(repositoryUpdates.status, "syncing"),
						lt(
							repositoryUpdates.startedAt,
							new Date(now.getTime() - STALE_SYNC_MS),
						),
					),
				),
			),
		)
		.returning();
	if (!update) return;
	try {
		const [repo] = await deps.db
			.select()
			.from(repositories)
			.where(eq(repositories.id, update.repositoryId))
			.limit(1);
		if (!repo) return;
		if (repo.sourceType === "git_url")
			await fetchFromGitHub(deps, repo, update);
		const source = await verifySourcePath(deps.config, repo);
		const head = await resolveCommit(source, update.ref);
		if (!head)
			throw new ContextError(
				"commit_not_found",
				`${update.ref} does not resolve to a commit`,
			);
		if (update.trigger === "pull_request") {
			await queuePullRequestAnalysis(deps, repo, update, head);
			return;
		}
		await withTransaction(deps.pool, async (tx) => {
			const { snapshot } = await queueSnapshot(
				deps,
				tx,
				{
					workspaceId: repo.workspaceId,
					userId: update.requestedBy,
					actor: WORKER_ACTOR,
				},
				{ repositoryId: repo.id, ref: update.ref, commitSha: head },
				null,
				{ update_id: update.id, trigger: update.trigger },
			);
			const indexed =
				snapshot.status === "ready" || snapshot.status === "partial";
			await tx.db
				.update(repositoryUpdates)
				.set({
					indexedSha: head,
					snapshotId: snapshot.id,
					status: indexed ? "indexed" : "indexing",
					finishedAt: indexed ? new Date() : null,
					updatedAt: new Date(),
				})
				.where(eq(repositoryUpdates.id, update.id));
			if (indexed) await supersedeFailures(tx.db, update);
		});
	} catch (error) {
		const failure = toFailure(error);
		await deps.db
			.update(repositoryUpdates)
			.set({
				status: "failed",
				error: failure,
				finishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(repositoryUpdates.id, updateId));
		deps.log?.("repository sync failed", {
			update_id: updateId,
			code: failure.code,
			...(failure.code === "sync_failed"
				? {
						error: redactSecrets((error as Error).message ?? "", {
							redactEmails: true,
						}).text,
					}
				: {}),
		});
	}
}

/**
 * Moves updates whose indexing or analysis finished to `indexed` or `failed` (with the snapshot's or
 * analysis's error) and resolves older failures of refs that reached a newer commit. Runs in worker
 * maintenance, and for one repository before its status is read.
 */
export async function settleUpdates(
	db: Db,
	repositoryId?: string,
): Promise<number> {
	const scope = repositoryId
		? sql`AND u.repository_id = ${repositoryId}`
		: sql``;
	const fromSnapshots = await db.execute<SettledRow>(sql`
		UPDATE repository_updates u
		   SET status = (CASE WHEN s.status IN ('ready', 'partial') THEN 'indexed' ELSE 'failed' END)::repository_update_status,
		       error = CASE WHEN s.status IN ('ready', 'partial') THEN NULL
		                    ELSE coalesce(s.error, jsonb_build_object('code', 'index_failed', 'message', 'Indexing failed')) END,
		       finished_at = coalesce(s.finished_at, now()), updated_at = now()
		  FROM repository_snapshots s
		 WHERE u.snapshot_id = s.id AND u.status = 'indexing'
		   AND s.status IN ('ready', 'partial', 'failed', 'cancelled') ${scope}
		RETURNING u.repository_id, u.ref, u.created_at, u.status`);
	const fromAnalyses = await db.execute<SettledRow>(sql`
		UPDATE repository_updates u
		   SET status = (CASE WHEN p.status IN ('completed', 'partial') THEN 'indexed' ELSE 'failed' END)::repository_update_status,
		       error = CASE WHEN p.status IN ('completed', 'partial') THEN NULL
		                    ELSE coalesce(p.error, jsonb_build_object('code', 'patch_impact_failed', 'message', 'The pull-request analysis failed')) END,
		       finished_at = coalesce(p.finished_at, now()), updated_at = now()
		  FROM patch_analyses p
		 WHERE u.patch_analysis_id = p.id AND u.status = 'indexing'
		   AND p.status IN ('completed', 'partial', 'failed', 'cancelled') ${scope}
		RETURNING u.repository_id, u.ref, u.created_at, u.status`);
	// The snapshot or analysis it waited for was deleted (pruned, or its repository is going away).
	const orphaned = await db.execute(sql`
		UPDATE repository_updates u
		   SET status = 'failed', finished_at = now(), updated_at = now(),
		       error = jsonb_build_object('code', 'job_lost', 'retryable', true,
		         'message', 'The snapshot or analysis this update waited for no longer exists')
		 WHERE u.status = 'indexing' AND u.snapshot_id IS NULL AND u.patch_analysis_id IS NULL ${scope}`);
	const settled = [...fromSnapshots.rows, ...fromAnalyses.rows];
	for (const row of settled)
		if (row.status === "indexed")
			await supersedeFailures(db, {
				repositoryId: row.repository_id,
				ref: row.ref,
				createdAt: new Date(row.created_at),
			});
	return settled.length + (orphaned.rowCount ?? 0);
}
type SettledRow = {
	repository_id: string;
	ref: string;
	created_at: string;
	status: string;
};

/**
 * Worker-loss recovery: a pending or syncing update whose queue job no longer exists in a live state
 * will never run. It fails as `job_lost` (retryable), so reconciliation or a manual sync retries it.
 */
export async function recoverLostSyncs(db: Db): Promise<number> {
	const result = await db.execute<{ id: string; workspace_id: string }>(sql`
		UPDATE repository_updates u
		   SET status = 'failed', finished_at = now(), updated_at = now(),
		       error = jsonb_build_object('code', 'job_lost', 'retryable', true,
		         'message', 'The synchronization job was lost (worker crash or queue expiry)')
		 WHERE u.status IN ('pending', 'syncing')
		   AND u.updated_at < now() - interval '2 minutes'
		   AND NOT EXISTS (
		     SELECT 1 FROM pgboss.job j
		      WHERE j.name = ${QUEUES.sync} AND j.data->>'updateId' = u.id
		        AND j.state IN ('created', 'retry', 'active'))
		RETURNING u.id, u.workspace_id`);
	for (const row of result.rows)
		await audit(db, {
			workspaceId: row.workspace_id,
			actor: WORKER_ACTOR,
			action: "repository.sync_recovered",
			targetType: "repository_update",
			targetId: row.id,
			metadata: { code: "job_lost" },
		});
	return result.rows.length;
}

/** Worker maintenance for synchronization: recovery, settlement, and the throttled reconciliation. */
export async function syncMaintenance(deps: SyncDeps): Promise<number> {
	const recovered = await recoverLostSyncs(deps.db);
	await settleUpdates(deps.db);
	// At most one reconciliation per interval across all workers (pg-boss throttling by key).
	await deps.boss.sendThrottled(
		QUEUES.reconcile,
		{},
		null,
		RECONCILE_INTERVAL_SECONDS,
		"reconcile",
	);
	return recovered;
}

/** The ref's head as its source sees it now: the local repository, or GitHub's API. */
async function currentHead(
	deps: SyncDeps,
	repo: RepositoryRow,
	ref: string,
): Promise<string | null> {
	if (repo.sourceType !== "git_url") {
		const source = await verifySourcePath(deps.config, repo).catch(() => null);
		return source ? resolveCommit(source, ref) : null;
	}
	const gh = deps.config.github;
	const source = gh ? await githubSourceOf(deps.db, repo.id) : null;
	if (!gh || !source) return null;
	try {
		assertSyncable(source);
	} catch {
		// Installation and access problems surface through syncs and the status view, not by polling.
		return null;
	}
	const client = deps.github ?? defaultGitHubClient();
	const token = await installationToken(client, gh, {
		installationId: source.installation.installationId,
		repositoryId: source.link.githubRepositoryId,
	});
	return branchHead(client, gh, token, source.link.fullName, ref);
}

/**
 * Whether a head still needs work: not when a snapshot of it exists or is under way at the current
 * extractor version, not while an update for the ref is in flight, and not after its failures: a
 * failed commit is retried automatically only when the failure was retryable, at most three times.
 */
async function needsSync(
	db: Db,
	repositoryId: string,
	ref: string,
	head: string,
): Promise<boolean> {
	const [snapshot] = await db
		.select({ id: repositorySnapshots.id })
		.from(repositorySnapshots)
		.where(
			and(
				eq(repositorySnapshots.repositoryId, repositoryId),
				eq(repositorySnapshots.commitSha, head),
				eq(repositorySnapshots.extractorVersion, EXTRACTOR_VERSION),
				inArray(repositorySnapshots.status, [
					"queued",
					"indexing",
					"ready",
					"partial",
				]),
			),
		)
		.limit(1);
	if (snapshot) return false;
	const updates = await db
		.select({
			status: repositoryUpdates.status,
			error: repositoryUpdates.error,
		})
		.from(repositoryUpdates)
		.where(
			and(
				eq(repositoryUpdates.repositoryId, repositoryId),
				eq(repositoryUpdates.ref, ref),
				or(
					inArray(repositoryUpdates.status, ["pending", "syncing", "indexing"]),
					and(
						eq(repositoryUpdates.status, "failed"),
						or(
							eq(repositoryUpdates.targetSha, head),
							eq(repositoryUpdates.indexedSha, head),
						),
					),
				),
			),
		);
	if (updates.some((update) => update.status !== "failed")) return false;
	return (
		updates.length < MAX_AUTOMATIC_ATTEMPTS &&
		updates.every((update) => update.error?.retryable === true)
	);
}

/**
 * The `repository.reconcile` job: compares each repository's tracked ref with what is indexed
 * and requests a sync where it moved, catching up on missed or failed webhook deliveries and on local
 * repositories, which have no webhooks. Bounded (at most 200 repositories per run, four at a time) and
 * idempotent (a head that is indexed, in flight, or failed for good is left alone).
 */
export async function runReconcileJob(deps: SyncDeps): Promise<{
	checked: number;
	requested: number;
	skipped: number;
	failed: number;
}> {
	// ponytail: first 200 repositories by ID per run; add a rotating cursor if one installation grows past that.
	const rows = await deps.db
		.select()
		.from(repositories)
		.orderBy(repositories.id)
		.limit(RECONCILE_LIMIT);
	const counts = { checked: 0, requested: 0, skipped: 0, failed: 0 };
	let next = 0;
	const worker = async () => {
		for (let repo = rows[next++]; repo; repo = rows[next++]) {
			try {
				const ref = repo.defaultBranch;
				const head = await currentHead(deps, repo, ref);
				if (!head) counts.skipped += 1;
				else if (!(await needsSync(deps.db, repo.id, ref, head)))
					counts.checked += 1;
				else {
					await withTransaction(deps.pool, (tx) =>
						requestSync(
							deps,
							tx,
							{
								workspaceId: repo.workspaceId,
								repositoryId: repo.id,
								ref,
								trigger: "reconcile",
								targetSha: head,
								actor: WORKER_ACTOR,
							},
							null,
						),
					);
					counts.requested += 1;
				}
			} catch (error) {
				counts.failed += 1;
				deps.log?.("reconciliation check failed", {
					repository_id: repo.id,
					code: toFailure(error).code,
				});
			}
		}
	};
	await Promise.all(Array.from({ length: RECONCILE_CONCURRENCY }, worker));
	if (counts.requested > 0 || counts.failed > 0)
		deps.log?.("reconciliation finished", counts);
	return counts;
}

async function repositoryRow(
	db: Db,
	workspaceId: string,
	repositoryId: string,
): Promise<RepositoryRow> {
	const [row] = await db
		.select()
		.from(repositories)
		.where(
			and(
				eq(repositories.id, repositoryId),
				eq(repositories.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(
			404,
			"not_found",
			`Repository ${repositoryId} was not found`,
		);
	return row;
}

/**
 * Manual sync and recovery: requests an update of the tracked ref now. When it is indexed,
 * the ref's earlier failed updates are resolved. Joins an update that is already pending.
 */
export async function requestManualSync(
	deps: SyncDeps,
	ctx: AuthContext,
	repositoryId: string,
	requestId: string,
) {
	const repo = await repositoryRow(deps.db, ctx.workspaceId, repositoryId);
	const { update, created } = await withTransaction(deps.pool, (tx) =>
		requestSync(
			deps,
			tx,
			{
				workspaceId: repo.workspaceId,
				repositoryId: repo.id,
				ref: repo.defaultBranch,
				trigger: "manual",
				requestedBy: ctx.userId,
				actor: actorOf(ctx),
			},
			requestId,
		),
	);
	return {
		status: created ? (202 as const) : (200 as const),
		update: toUpdateView(update),
	};
}

/** GET /repositories/{id}/sync: freshness, pending and failed updates, and webhook deliveries. */
export async function getSyncStatus(
	deps: { db: Db; config: Config },
	workspaceId: string,
	repositoryId: string,
): Promise<RepositorySyncStatus> {
	const repo = await repositoryRow(deps.db, workspaceId, repositoryId);
	await settleUpdates(deps.db, repo.id);
	const [updates, deliveries, usable, source, summaries] = await Promise.all([
		deps.db
			.select()
			.from(repositoryUpdates)
			.where(eq(repositoryUpdates.repositoryId, repo.id))
			.orderBy(desc(repositoryUpdates.createdAt))
			.limit(50),
		deps.db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.repositoryId, repo.id))
			.orderBy(desc(webhookDeliveries.receivedAt))
			.limit(50),
		deps.db
			.select()
			.from(repositorySnapshots)
			.where(
				and(
					eq(repositorySnapshots.repositoryId, repo.id),
					inArray(repositorySnapshots.status, ["ready", "partial"]),
				),
			)
			.orderBy(desc(repositorySnapshots.createdAt))
			.limit(1),
		githubSourceOf(deps.db, repo.id),
		syncSummaries(deps.db, [repo.id]),
	]);
	const [latest] = usable;
	const freshness = latest
		? await snapshotFreshness(deps.config, repo, latest, deps.db)
		: null;
	const views = updates.map(toUpdateView);
	return {
		repository_id: repo.id,
		source: repo.sourceType === "git_url" ? "github" : "local",
		tracked_ref: repo.defaultBranch,
		freshness,
		latest_indexed: latest
			? {
					snapshot_id: latest.id,
					commit_sha: latest.commitSha,
					status: latest.status,
					finished_at: toSnapshotView(latest).finished_at,
				}
			: null,
		last_synced_at: latest?.finishedAt?.toISOString() ?? null,
		summary: summaries.get(repo.id) ?? {
			pending: 0,
			failed: 0,
			failed_deliveries: 0,
			latest_known_commit: null,
			last_failure: null,
		},
		pending: views.filter((update) =>
			["pending", "syncing", "indexing"].includes(update.status),
		),
		failed: views.filter((update) => update.status === "failed"),
		recent: views.slice(0, 10),
		deliveries: {
			failed: deliveries
				.filter((delivery) => delivery.status === "failed")
				.map(toDeliveryView),
			recent: deliveries.slice(0, 10).map(toDeliveryView),
		},
		github: source
			? {
					installation: source.installation.id,
					full_name: source.link.fullName,
					private: source.link.private,
					access:
						source.installation.status === "removed"
							? "installation_removed"
							: source.installation.status === "suspended"
								? "installation_suspended"
								: source.link.accessRemovedAt
									? "repository_removed"
									: "active",
				}
			: null,
		reconciliation: { interval_seconds: RECONCILE_INTERVAL_SECONDS },
	};
}
