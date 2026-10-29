import path from "node:path";
import type { CreateBugReportRequest, ValueSource } from "@tracera/contracts";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
	bugReports,
	evidenceAssets,
	type FieldProvenance,
	investigations,
	repositories,
} from "../db/schema.ts";
import { putBlob } from "../lib/fs.ts";
import { AppError, decodeCursor, encodeCursor } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { enqueueNormalize } from "../queue.ts";
import { audit } from "./audit.ts";
import { type AuthContext, actorOf, sourceChannelOf } from "./auth.ts";
import { idempotent } from "./idempotency.ts";

type BugReportRow = typeof bugReports.$inferSelect;
const EVIDENCE_RETENTION_DAYS = 90;

export function stripUrl(raw: string, keepQuery: boolean): string {
	const url = new URL(raw);
	if (!keepQuery) url.search = "";
	url.hash = "";
	return url.toString();
}

/**
 * Set only by the meeting pipeline when a reviewer confirms a candidate (meetings.ts): the report
 * keeps its meeting provenance, and `onCreated` runs in the report's transaction (exactly once).
 */
export type ReportOrigin = {
	channel: "meeting";
	fieldSources: Readonly<Record<string, ValueSource>>;
	evidenceProvenance: Record<string, unknown>;
	onCreated(db: Db, bugReportId: string): Promise<void>;
};

export async function createBugReport(
	deps: { pool: pg.Pool; db: Db; boss: PgBoss; config: Config },
	ctx: AuthContext,
	input: CreateBugReportRequest,
	meta: { requestId: string; idempotencyKey: string | undefined },
	origin?: ReportOrigin,
) {
	const channel = origin?.channel ?? sourceChannelOf(ctx);
	if (input.repository_id)
		await requireRepository(deps.db, ctx.workspaceId, input.repository_id);
	// Blobs are content-addressed and written before the transaction; a rollback can only leave an unreferenced blob.
	const blobs = await Promise.all(
		(input.logs ?? []).map(async (log) => ({
			log,
			blob: await putBlob(
				path.join(deps.config.dataDir, "blobs"),
				Buffer.from(log.content, "utf8"),
			),
		})),
	);
	const actor = actorOf(ctx);
	return idempotent(
		deps,
		{
			workspaceId: ctx.workspaceId,
			actorId: actor.id ?? ctx.userId,
			key: meta.idempotencyKey,
			methodPath: "POST /api/v1/bug-reports",
			body: input,
		},
		async ({ db, queueDb }) => {
			const id = newId("bug");
			const provided = (value: unknown) =>
				value !== undefined && !(Array.isArray(value) && value.length === 0);
			const provenance: Record<string, FieldProvenance> = {};
			for (const [field, value] of Object.entries({
				title: input.title,
				description: input.description,
				expected_behavior: input.expected_behavior,
				actual_behavior: input.actual_behavior,
				steps: input.steps,
				environment: input.environment,
				affected_url: input.affected_url,
				severity: input.severity,
				priority: input.priority,
			})) {
				if (provided(value))
					provenance[field] = {
						source: origin?.fieldSources[field] ?? "user_provided",
					};
			}
			const normalize = input.normalize ?? true;
			await db.insert(bugReports).values({
				id,
				workspaceId: ctx.workspaceId,
				repositoryId: input.repository_id ?? null,
				sourceChannel: channel,
				title: input.title,
				description: input.description,
				expectedBehavior: input.expected_behavior || null,
				actualBehavior: input.actual_behavior || null,
				steps: input.steps ?? [],
				environment: input.environment ?? {},
				affectedUrl: input.affected_url
					? stripUrl(input.affected_url, input.keep_query ?? false)
					: null,
				severity: input.severity ?? "unknown",
				priority: input.priority ?? "unknown",
				fieldProvenance: provenance,
				normalizationStatus: normalize ? "queued" : "not_requested",
				createdBy: ctx.userId,
			});
			for (const { log, blob } of blobs) {
				await db.insert(evidenceAssets).values({
					id: newId("evd"),
					workspaceId: ctx.workspaceId,
					bugReportId: id,
					kind: log.kind,
					origin: "user_provided",
					blobSha256: blob.sha256,
					mimeType: "text/plain; charset=utf-8",
					sizeBytes: blob.size,
					provenance: {
						channel,
						captured_by_user_id: ctx.userId,
						...origin?.evidenceProvenance,
					},
					retentionUntil: new Date(
						Date.now() + EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
					),
				});
			}
			await origin?.onCreated(db, id);
			await audit(db, {
				workspaceId: ctx.workspaceId,
				actor,
				action: "bug_report.created",
				targetType: "bug_report",
				targetId: id,
				metadata: {
					source_channel: channel,
					evidence_count: blobs.length,
					normalize,
				},
				requestId: meta.requestId,
			});
			if (normalize)
				await enqueueNormalize(deps.boss, queueDb, {
					bugReportId: id,
					workspaceId: ctx.workspaceId,
				});
			const report = await getBugReport(db, ctx.workspaceId, id);
			return { status: 201, body: { bug_report: report } };
		},
	);
}

async function requireRepository(
	db: Db,
	workspaceId: string,
	repositoryId: string,
) {
	const [repo] = await db
		.select({ id: repositories.id })
		.from(repositories)
		.where(
			and(
				eq(repositories.id, repositoryId),
				eq(repositories.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!repo)
		throw new AppError(
			404,
			"not_found",
			`Repository ${repositoryId} was not found`,
		);
}

export async function getBugReport(db: Db, workspaceId: string, id: string) {
	const [row] = await db
		.select()
		.from(bugReports)
		.where(and(eq(bugReports.id, id), eq(bugReports.workspaceId, workspaceId)))
		.limit(1);
	if (!row)
		throw new AppError(404, "not_found", `Bug report ${id} was not found`);
	const evidence = await db
		.select()
		.from(evidenceAssets)
		.where(eq(evidenceAssets.bugReportId, id))
		.orderBy(evidenceAssets.createdAt);
	const [latest] = await db
		.select({ id: investigations.id, status: investigations.status })
		.from(investigations)
		.where(eq(investigations.bugReportId, id))
		.orderBy(desc(investigations.createdAt))
		.limit(1);
	return {
		...toView(row),
		evidence: evidence.map((asset) => ({
			id: asset.id,
			kind: asset.kind,
			origin: asset.origin,
			mime_type: asset.mimeType,
			size_bytes: asset.sizeBytes,
			captured_at: asset.capturedAt?.toISOString() ?? null,
			captured_at_client_reported: asset.capturedAt !== null,
			provenance: asset.provenance,
			content_url: null, // no download endpoint yet
			created_at: asset.createdAt.toISOString(),
		})),
		latest_investigation: latest
			? { id: latest.id, status: latest.status, verification_outcome: null }
			: null,
	};
}

export async function listBugReports(
	db: Db,
	workspaceId: string,
	query: {
		limit: number;
		cursor?: string | undefined;
		status?: string | undefined;
		repository_id?: string | undefined;
	},
) {
	const cursor = decodeCursor(query.cursor);
	const rows = await db
		.select()
		.from(bugReports)
		.where(
			and(
				eq(bugReports.workspaceId, workspaceId),
				query.status
					? eq(bugReports.status, query.status as BugReportRow["status"])
					: undefined,
				query.repository_id
					? eq(bugReports.repositoryId, query.repository_id)
					: undefined,
				cursor
					? or(
							lt(bugReports.createdAt, cursor.createdAt),
							and(
								eq(bugReports.createdAt, cursor.createdAt),
								lt(bugReports.id, cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(bugReports.createdAt), desc(bugReports.id))
		.limit(query.limit + 1);
	const page = rows.slice(0, query.limit);
	const last = page.at(-1);
	return {
		items: page.map(toView),
		next_cursor:
			rows.length > query.limit && last
				? encodeCursor(last.createdAt, last.id)
				: null,
	};
}

function toView(row: BugReportRow) {
	const result = row.normalizationResult as Record<string, unknown> | null;
	return {
		id: row.id,
		status: row.status,
		source_channel: row.sourceChannel,
		title: row.title,
		description: row.description,
		expected_behavior: row.expectedBehavior,
		actual_behavior: row.actualBehavior,
		steps: row.steps,
		environment: row.environment,
		affected_url: row.affectedUrl,
		severity: row.severity,
		priority: row.priority,
		field_provenance: row.fieldProvenance,
		suspected_components: row.suspectedComponents,
		unresolved_questions: row.unresolvedQuestions,
		normalization: {
			status: row.normalizationStatus,
			normalized_at: row.normalizedAt?.toISOString() ?? null,
			summary: (result?.summary as string | undefined) ?? null,
			severity_suggestion:
				(result?.severity_suggestion as string | undefined) ?? null,
			search_terms: (result?.search_terms as string[] | undefined) ?? [],
			error: row.normalizationError ?? null,
		},
		repository_id: row.repositoryId,
		meeting_session_id: null,
		source_segment_ids: [],
		created_by: row.createdBy,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}
