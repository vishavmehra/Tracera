import type {
	RepositorySyncSummary,
	RepositoryUpdate,
	WebhookDelivery,
} from "@tracera/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { repositoryUpdates, type webhookDeliveries } from "../db/schema.ts";

// Read side of repository synchronization: views and summaries. A leaf module (database
// only), so the repository and profile APIs can include it without import cycles.

export type UpdateRow = typeof repositoryUpdates.$inferSelect;
export type DeliveryRow = typeof webhookDeliveries.$inferSelect;

export function toUpdateView(row: UpdateRow): RepositoryUpdate {
	return {
		id: row.id,
		repository_id: row.repositoryId,
		trigger: row.trigger,
		ref: row.ref,
		target_sha: row.targetSha,
		indexed_sha: row.indexedSha,
		status: row.status,
		snapshot_id: row.snapshotId,
		patch_analysis_id: row.patchAnalysisId,
		pull_request: row.pullRequest ?? null,
		delivery_id: row.deliveryId,
		attempts: row.attempts,
		coalesced: row.coalesced,
		error: row.error ?? null,
		created_at: row.createdAt.toISOString(),
		started_at: row.startedAt?.toISOString() ?? null,
		finished_at: row.finishedAt?.toISOString() ?? null,
	};
}

export function toDeliveryView(row: DeliveryRow): WebhookDelivery {
	return {
		id: row.id,
		delivery_guid: row.deliveryGuid,
		event: row.event,
		action: row.action,
		status: row.status,
		reason: row.reason,
		error: row.error ?? null,
		attempts: row.attempts,
		next_attempt_at: row.nextAttemptAt?.toISOString() ?? null,
		received_at: row.receivedAt.toISOString(),
		processed_at: row.processedAt?.toISOString() ?? null,
	};
}

const EMPTY: RepositorySyncSummary = {
	pending: 0,
	failed: 0,
	failed_deliveries: 0,
	latest_known_commit: null,
	last_failure: null,
};

/** The compact sync state of each repository (one query; indexed by repository and creation time). */
export async function syncSummaries(
	db: Db,
	repositoryIds: readonly string[],
): Promise<Map<string, RepositorySyncSummary>> {
	if (repositoryIds.length === 0) return new Map();
	const { rows } = await db.execute<{
		repository_id: string;
		pending: number;
		failed: number;
		failed_deliveries: number;
		latest_known_commit: string | null;
		last_failure: {
			id: string;
			error: { code?: string; message?: string } | null;
			at: string;
		} | null;
	}>(sql`
		SELECT r.id AS repository_id,
		  (SELECT count(*)::int FROM repository_updates u
		    WHERE u.repository_id = r.id AND u.status IN ('pending', 'syncing', 'indexing')) AS pending,
		  (SELECT count(*)::int FROM repository_updates u
		    WHERE u.repository_id = r.id AND u.status = 'failed') AS failed,
		  (SELECT count(*)::int FROM webhook_deliveries d
		    WHERE d.repository_id = r.id AND d.status = 'failed') AS failed_deliveries,
		  (SELECT u.target_sha FROM repository_updates u
		    WHERE u.repository_id = r.id AND u.ref = r.default_branch AND u.target_sha IS NOT NULL
		    ORDER BY u.created_at DESC LIMIT 1) AS latest_known_commit,
		  (SELECT json_build_object('id', u.id, 'error', u.error, 'at', coalesce(u.finished_at, u.updated_at))
		     FROM repository_updates u
		    WHERE u.repository_id = r.id AND u.status = 'failed'
		    ORDER BY u.created_at DESC LIMIT 1) AS last_failure
		FROM repositories r
		WHERE r.id IN (${sql.join(
			repositoryIds.map((id) => sql`${id}`),
			sql`, `,
		)})`);
	return new Map(
		rows.map((row) => [
			row.repository_id,
			{
				pending: row.pending,
				failed: row.failed,
				failed_deliveries: row.failed_deliveries,
				latest_known_commit: row.latest_known_commit,
				last_failure: row.last_failure
					? {
							update_id: row.last_failure.id,
							code: row.last_failure.error?.code ?? "sync_failed",
							message: row.last_failure.error?.message ?? "",
							at: new Date(row.last_failure.at).toISOString(),
						}
					: null,
			},
		]),
	);
}

export const emptySyncSummary = (): RepositorySyncSummary => ({ ...EMPTY });

/**
 * For a GitHub repository, the newest commit reported for `ref` that Tracera's source cache may not
 * have yet: the target of the ref's newest update while it is pending, fetching, or after it failed.
 * Once an update has fetched (indexing or indexed), the cache itself is the latest known state.
 */
export async function latestKnownCommit(
	db: Db,
	repositoryId: string,
	ref: string,
): Promise<{ sha: string; reason: "update_pending" | "update_failed" } | null> {
	const [newest] = await db
		.select({
			status: repositoryUpdates.status,
			targetSha: repositoryUpdates.targetSha,
		})
		.from(repositoryUpdates)
		.where(
			and(
				eq(repositoryUpdates.repositoryId, repositoryId),
				eq(repositoryUpdates.ref, ref),
			),
		)
		.orderBy(desc(repositoryUpdates.createdAt))
		.limit(1);
	if (!newest?.targetSha) return null;
	if (newest.status === "failed")
		return { sha: newest.targetSha, reason: "update_failed" };
	if (newest.status === "pending" || newest.status === "syncing")
		return { sha: newest.targetSha, reason: "update_pending" };
	return null;
}
