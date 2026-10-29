import { unlink } from "node:fs/promises";
import path from "node:path";
import {
	type ConfirmMeetingCandidateRequest,
	CreateBugReportRequestSchema,
	type InvestigationStatus,
	MEETING_CONSENT_STATEMENT,
	type Meeting,
	type MeetingCandidate,
	type MeetingCandidateCounts,
	type MeetingProvider,
	type MeetingSource,
	type MeetingSummary,
	type TranscriptEncoding,
	type TranscriptInfo,
	type UpdateMeetingCandidateRequest,
	type UpdateMeetingRequest,
	type UploadMeetingTranscriptRequest,
	type ValueSource,
	type VerificationOutcome,
} from "@tracera/contracts";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, pgErrorCode, withTransaction } from "../db/client.ts";
import {
	bugReports,
	type CandidateCitationRecord,
	evidenceAssets,
	investigations,
	meetingCandidates,
	meetingSessions,
	transcriptSegments,
	verificationRuns,
} from "../db/schema.ts";
import { putBlob } from "../lib/fs.ts";
import { AppError, decodeCursor, encodeCursor } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { audit } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import { createBugReport } from "./bug-reports.ts";
import { idempotent } from "./idempotency.ts";
import { createInvestigation } from "./investigations.ts";
import {
	EXTRACTION_EXPIRE_SECONDS,
	enqueueMeetingExtraction,
	ensureMeetingQueue,
	formatClock,
} from "./meeting-extract.ts";
import {
	checkTranscriptFile,
	decodeTranscript,
	type ParsedTranscript,
	parseTranscript,
} from "./meeting-parse.ts";
import { getRepositoryRow } from "./repositories.ts";

// The shared meeting engine's API side: every source, uploaded or imported, goes
// through ingestTranscript; review actions use the existing bug-report and investigation services.

type Deps = { pool: pg.Pool; db: Db; boss: PgBoss; config: Config };
type SessionContext = Extract<AuthContext, { kind: "session" }>;
type MeetingRow = typeof meetingSessions.$inferSelect;
type CandidateRow = typeof meetingCandidates.$inferSelect;
type SegmentRow = typeof transcriptSegments.$inferSelect;

const SEGMENT_INSERT_CHUNK = 2000;

export type IngestInput = {
	provider: MeetingProvider;
	source: MeetingSource;
	title: string | null;
	occurredAt: Date | null;
	repositoryId: string | null;
	providerRef: string | null;
	integrationConnectionId: string | null;
	/** The original artifact as received; stored as a content-addressed blob. */
	original: {
		bytes: Buffer;
		filename: string | null;
		contentType: string | null;
		encoding: TranscriptEncoding | null;
	};
	parsed: ParsedTranscript;
};

/** The single entry of the meeting engine: store the original, the segments, and queue extraction. */
export async function ingestTranscript(
	deps: Deps,
	ctx: SessionContext,
	input: IngestInput,
	meta: {
		requestId: string;
		idempotencyKey: string | undefined;
		methodPath: string;
		body: unknown;
	},
) {
	if (input.repositoryId)
		await getRepositoryRow(deps.db, ctx.workspaceId, input.repositoryId);
	const blob = await putBlob(
		path.join(deps.config.dataDir, "blobs"),
		input.original.bytes,
	);
	await ensureMeetingQueue(deps.boss);
	return idempotent(
		deps,
		{
			workspaceId: ctx.workspaceId,
			actorId: ctx.userId,
			key: meta.idempotencyKey,
			methodPath: meta.methodPath,
			body: meta.body,
		},
		async ({ db, queueDb }) => {
			const id = newId("mtg");
			const consentAttestedAt = new Date();
			const transcript: TranscriptInfo = {
				format: input.parsed.format,
				timing: input.parsed.timing,
				filename: input.original.filename,
				content_type: input.original.contentType,
				encoding: input.original.encoding,
				size_bytes: input.original.bytes.length,
				sha256: blob.sha256,
				segment_count: input.parsed.segments.length,
				speaker_labels: input.parsed.speakers,
				duration_ms: input.parsed.durationMs,
				warnings: input.parsed.warnings,
			};
			await db
				.insert(meetingSessions)
				.values({
					id,
					workspaceId: ctx.workspaceId,
					provider: input.provider,
					source: input.source,
					status: "transcribed",
					title: input.title,
					occurredAt: input.occurredAt,
					repositoryId: input.repositoryId,
					providerRef: input.providerRef,
					integrationConnectionId: input.integrationConnectionId,
					blobSha256: blob.sha256,
					transcript,
					consentStatement: MEETING_CONSENT_STATEMENT.version,
					consentAttestedAt,
					createdBy: ctx.userId,
				})
				.catch((error: unknown) => {
					// Unique (workspace, provider_ref): a provider transcript is imported once.
					if (pgErrorCode(error) === "23505")
						throw new AppError(
							409,
							"conflict",
							"This transcript was already imported",
						);
					throw error;
				});
			for (
				let start = 0;
				start < input.parsed.segments.length;
				start += SEGMENT_INSERT_CHUNK
			)
				await db.insert(transcriptSegments).values(
					input.parsed.segments
						.slice(start, start + SEGMENT_INSERT_CHUNK)
						.map((segment) => ({
							id: newId("seg"),
							meetingSessionId: id,
							workspaceId: ctx.workspaceId,
							segmentIndex: segment.index,
							speakerLabel: segment.speaker,
							startMs: segment.startMs,
							endMs: segment.endMs,
							text: segment.text,
						})),
				);
			await audit(db, {
				workspaceId: ctx.workspaceId,
				actor: actorOf(ctx),
				action:
					input.source === "provider_api"
						? "meeting.imported"
						: "meeting.uploaded",
				targetType: "meeting",
				targetId: id,
				metadata: {
					provider: input.provider,
					source: input.source,
					format: transcript.format,
					segments: transcript.segment_count,
					size_bytes: transcript.size_bytes,
					sha256: transcript.sha256,
					provider_ref: input.providerRef,
					consent_statement: MEETING_CONSENT_STATEMENT.version,
					consent_attested_at: consentAttestedAt.toISOString(),
				},
				requestId: meta.requestId,
			});
			await enqueueMeetingExtraction(deps.boss, queueDb, { meetingId: id });
			return {
				status: 202,
				body: { meeting: await getMeetingView(db, ctx.workspaceId, id) },
			};
		},
	);
}

export function requireConsent(attested: boolean | undefined): void {
	if (attested !== true)
		throw new AppError(
			422,
			"consent_required",
			`Confirm before uploading: "${MEETING_CONSENT_STATEMENT.text}"`,
		);
}

/** POST /api/v1/meetings: checks the attestation, then the bytes, then parses them. */
export async function uploadMeetingTranscript(
	deps: Deps,
	ctx: SessionContext,
	input: UploadMeetingTranscriptRequest,
	meta: { requestId: string; idempotencyKey: string | undefined },
) {
	requireConsent(input.consent_attested);
	const bytes = Buffer.from(input.transcript.data_base64, "base64");
	// The client's file name is display metadata only; it is never used as a path.
	const filename =
		input.transcript.filename.split(/[\\/]/).pop()?.trim() || "transcript";
	const extension = checkTranscriptFile({
		filename,
		contentType: input.transcript.content_type,
		size: bytes.length,
	});
	const decoded = decodeTranscript(bytes);
	return ingestTranscript(
		deps,
		ctx,
		{
			provider: input.provider,
			source: "upload_transcript",
			title: input.title ?? null,
			occurredAt: input.occurred_at ? new Date(input.occurred_at) : null,
			repositoryId: input.repository_id ?? null,
			providerRef: null,
			integrationConnectionId: null,
			original: {
				bytes,
				filename,
				contentType: input.transcript.content_type || null,
				encoding: decoded.encoding,
			},
			parsed: parseTranscript(decoded.text, extension),
		},
		{ ...meta, methodPath: "POST /api/v1/meetings", body: input },
	);
}

// ---- Views ------------------------------------------------------------------------------------

async function requireMeeting(
	db: Db,
	workspaceId: string,
	id: string,
): Promise<MeetingRow> {
	const [row] = await db
		.select()
		.from(meetingSessions)
		.where(
			and(
				eq(meetingSessions.id, id),
				eq(meetingSessions.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row) throw new AppError(404, "not_found", `Meeting ${id} was not found`);
	return row;
}

async function requireCandidate(
	db: Db,
	workspaceId: string,
	meetingId: string,
	id: string,
): Promise<CandidateRow> {
	const [row] = await db
		.select()
		.from(meetingCandidates)
		.where(
			and(
				eq(meetingCandidates.id, id),
				eq(meetingCandidates.meetingSessionId, meetingId),
				eq(meetingCandidates.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(404, "not_found", `Candidate ${id} was not found`);
	return row;
}

const NO_COUNTS: MeetingCandidateCounts = {
	bugs_pending: 0,
	bugs_confirmed: 0,
	dismissed: 0,
	rejected: 0,
	other_discussion: 0,
	possible_duplicates: 0,
};

async function candidateCounts(
	db: Db,
	meetingIds: string[],
): Promise<Map<string, MeetingCandidateCounts>> {
	if (meetingIds.length === 0) return new Map();
	const c = meetingCandidates;
	const rows = await db
		.select({
			meetingId: c.meetingSessionId,
			bugs_pending: sql<number>`count(*) filter (where ${c.kind} = 'bug' and ${c.status} = 'pending_review')::int`,
			bugs_confirmed: sql<number>`count(*) filter (where ${c.kind} = 'bug' and ${c.status} = 'confirmed')::int`,
			dismissed: sql<number>`count(*) filter (where ${c.status} = 'dismissed')::int`,
			rejected: sql<number>`count(*) filter (where ${c.status} = 'rejected')::int`,
			other_discussion: sql<number>`count(*) filter (where ${c.kind} <> 'bug' and ${c.status} = 'pending_review')::int`,
			possible_duplicates: sql<number>`count(*) filter (where ${c.duplicateOf} is not null and ${c.status} = 'pending_review')::int`,
		})
		.from(c)
		.where(inArray(c.meetingSessionId, meetingIds))
		.groupBy(c.meetingSessionId);
	return new Map(rows.map(({ meetingId, ...counts }) => [meetingId, counts]));
}

function meetingView(row: MeetingRow, counts: MeetingCandidateCounts): Meeting {
	return {
		id: row.id,
		provider: row.provider,
		source: row.source,
		title: row.title,
		occurred_at: row.occurredAt?.toISOString() ?? null,
		status: row.status,
		repository_id: row.repositoryId,
		provider_ref: row.providerRef,
		transcript: row.transcript,
		speaker_map: row.speakerMap,
		flags: row.flags,
		candidate_counts: counts,
		extraction: row.extraction ?? null,
		failure: row.failure ?? null,
		consent: {
			attested_by: row.createdBy,
			attested_at: row.consentAttestedAt.toISOString(),
			statement: row.consentStatement,
		},
		created_by: row.createdBy,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

export async function getMeetingView(
	db: Db,
	workspaceId: string,
	id: string,
): Promise<Meeting> {
	const row = await requireMeeting(db, workspaceId, id);
	const counts = await candidateCounts(db, [id]);
	return meetingView(row, counts.get(id) ?? NO_COUNTS);
}

export async function listMeetings(
	db: Db,
	workspaceId: string,
	query: {
		limit: number;
		cursor?: string | undefined;
		status?: MeetingRow["status"] | undefined;
		provider?: MeetingProvider | undefined;
	},
) {
	const cursor = decodeCursor(query.cursor);
	const rows = await db
		.select()
		.from(meetingSessions)
		.where(
			and(
				eq(meetingSessions.workspaceId, workspaceId),
				query.status ? eq(meetingSessions.status, query.status) : undefined,
				query.provider
					? eq(meetingSessions.provider, query.provider)
					: undefined,
				cursor
					? or(
							lt(meetingSessions.createdAt, cursor.createdAt),
							and(
								eq(meetingSessions.createdAt, cursor.createdAt),
								lt(meetingSessions.id, cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(meetingSessions.createdAt), desc(meetingSessions.id))
		.limit(query.limit + 1);
	const page = rows.slice(0, query.limit);
	const counts = await candidateCounts(
		db,
		page.map((row) => row.id),
	);
	const last = page.at(-1);
	return {
		items: page.map((row) => meetingView(row, counts.get(row.id) ?? NO_COUNTS)),
		next_cursor:
			rows.length > query.limit && last
				? encodeCursor(last.createdAt, last.id)
				: null,
	};
}

const speakerName = (meeting: MeetingRow, label: string | null) =>
	label ? (meeting.speakerMap[label] ?? null) : null;

export async function listSegments(
	db: Db,
	workspaceId: string,
	meetingId: string,
	query: { limit: number; cursor?: string | undefined },
) {
	const meeting = await requireMeeting(db, workspaceId, meetingId);
	const rows = await db
		.select()
		.from(transcriptSegments)
		.where(
			and(
				eq(transcriptSegments.meetingSessionId, meetingId),
				eq(transcriptSegments.workspaceId, workspaceId),
				gt(transcriptSegments.segmentIndex, Number(query.cursor ?? 0)),
			),
		)
		.orderBy(asc(transcriptSegments.segmentIndex))
		.limit(query.limit + 1);
	const page = rows.slice(0, query.limit);
	return {
		items: page.map((row) => ({
			id: row.id,
			index: row.segmentIndex,
			speaker_label: row.speakerLabel,
			speaker_name: speakerName(meeting, row.speakerLabel),
			start_ms: row.startMs,
			end_ms: row.endMs,
			text: row.text,
		})),
		next_cursor:
			rows.length > query.limit ? String(page.at(-1)?.segmentIndex ?? 0) : null,
	};
}

/** Candidates with resolved citations, their bug reports, and the latest investigation of each. */
async function candidateViews(
	db: Db,
	meeting: MeetingRow,
	rows: CandidateRow[],
): Promise<MeetingCandidate[]> {
	const segmentIds = [
		...new Set(rows.flatMap((row) => row.citations.map((c) => c.segment_id))),
	];
	const segments = new Map(
		(segmentIds.length === 0
			? []
			: await db
					.select()
					.from(transcriptSegments)
					.where(
						and(
							eq(transcriptSegments.meetingSessionId, meeting.id),
							inArray(transcriptSegments.id, segmentIds),
						),
					)
		).map((segment) => [segment.id, segment]),
	);
	const bugIds = rows.flatMap((row) =>
		row.bugReportId ? [row.bugReportId] : [],
	);
	const reports = new Map(
		(bugIds.length === 0
			? []
			: await db
					.select({ id: bugReports.id, status: bugReports.status })
					.from(bugReports)
					.where(
						and(
							inArray(bugReports.id, bugIds),
							eq(bugReports.workspaceId, meeting.workspaceId),
						),
					)
		).map((report) => [report.id, report]),
	);
	const latest = new Map(
		(bugIds.length === 0
			? []
			: await db
					.selectDistinctOn([investigations.bugReportId], {
						bugReportId: investigations.bugReportId,
						id: investigations.id,
						status: investigations.status,
					})
					.from(investigations)
					.where(inArray(investigations.bugReportId, bugIds))
					.orderBy(investigations.bugReportId, desc(investigations.createdAt))
		).map((investigation) => [investigation.bugReportId, investigation]),
	);
	const investigationIds = [...latest.values()].map((i) => i.id);
	const outcomes = new Map(
		(investigationIds.length === 0
			? []
			: await db
					.selectDistinctOn([verificationRuns.investigationId], {
						investigationId: verificationRuns.investigationId,
						outcome: verificationRuns.outcome,
					})
					.from(verificationRuns)
					.where(inArray(verificationRuns.investigationId, investigationIds))
					.orderBy(
						verificationRuns.investigationId,
						desc(verificationRuns.createdAt),
					)
		).map((run) => [run.investigationId, run.outcome]),
	);
	return rows.map((row) => {
		const report = row.bugReportId ? reports.get(row.bugReportId) : undefined;
		const investigation = report ? latest.get(report.id) : undefined;
		return {
			id: row.id,
			meeting_id: row.meetingSessionId,
			ordinal: row.ordinal,
			kind: row.kind,
			status: row.status,
			title: row.title,
			description: row.description,
			expected_behavior: row.expectedBehavior,
			actual_behavior: row.actualBehavior,
			steps: row.steps,
			severity: row.severity,
			affected_area: row.affectedArea,
			citations: row.citations.flatMap((citation) => {
				const segment = segments.get(citation.segment_id);
				return segment
					? [
							{
								segment_id: segment.id,
								index: segment.segmentIndex,
								speaker_label: segment.speakerLabel,
								speaker_name: speakerName(meeting, segment.speakerLabel),
								start_ms: segment.startMs,
								end_ms: segment.endMs,
								quote: citation.quote,
								text: segment.text,
							},
						]
					: [];
			}),
			support: row.support,
			duplicate_of: row.duplicateOf ?? null,
			field_sources: row.fieldSources,
			repository_id: row.repositoryId ?? meeting.repositoryId,
			model_execution_id: row.modelExecutionId,
			bug_report: report ? { id: report.id, status: report.status } : null,
			investigation: investigation
				? {
						id: investigation.id,
						status: investigation.status,
						verification_outcome: outcomes.get(investigation.id) ?? null,
					}
				: null,
			review: row.review ?? null,
			created_at: row.createdAt.toISOString(),
			updated_at: row.updatedAt.toISOString(),
		};
	});
}

export async function listCandidates(
	db: Db,
	workspaceId: string,
	meetingId: string,
) {
	const meeting = await requireMeeting(db, workspaceId, meetingId);
	const rows = await db
		.select()
		.from(meetingCandidates)
		.where(
			and(
				eq(meetingCandidates.meetingSessionId, meetingId),
				eq(meetingCandidates.workspaceId, workspaceId),
			),
		)
		.orderBy(asc(meetingCandidates.ordinal));
	return { items: await candidateViews(db, meeting, rows) };
}

async function candidateView(
	db: Db,
	workspaceId: string,
	meetingId: string,
	candidateId: string,
): Promise<MeetingCandidate> {
	const meeting = await requireMeeting(db, workspaceId, meetingId);
	const row = await requireCandidate(db, workspaceId, meetingId, candidateId);
	const [view] = await candidateViews(db, meeting, [row]);
	if (!view) throw new AppError(500, "internal_error", "Candidate view failed");
	return view;
}

// ---- Meeting changes --------------------------------------------------------------------------

export async function updateMeeting(
	deps: Deps,
	ctx: SessionContext,
	meetingId: string,
	input: UpdateMeetingRequest,
	requestId: string,
) {
	const meeting = await requireMeeting(deps.db, ctx.workspaceId, meetingId);
	if (input.repository_id)
		await getRepositoryRow(deps.db, ctx.workspaceId, input.repository_id);
	const speakerMap = { ...meeting.speakerMap };
	for (const [label, name] of Object.entries(input.speaker_map ?? {})) {
		if (!meeting.transcript.speaker_labels.includes(label))
			throw new AppError(422, "validation_failed", "Unknown speaker label", {
				errors: [
					{
						path: "speaker_map",
						message: `${label} is not a speaker of this meeting`,
					},
				],
			});
		if (name === null) delete speakerMap[label];
		else speakerMap[label] = name;
	}
	await deps.db
		.update(meetingSessions)
		.set({
			...(input.title !== undefined ? { title: input.title } : {}),
			...(input.repository_id !== undefined
				? { repositoryId: input.repository_id }
				: {}),
			speakerMap,
			updatedAt: new Date(),
		})
		.where(eq(meetingSessions.id, meetingId));
	// Names are personal data: the audit records which fields changed, not the values.
	await audit(deps.db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: "meeting.updated",
		targetType: "meeting",
		targetId: meetingId,
		metadata: { fields: Object.keys(input) },
		requestId,
	});
	return { meeting: await getMeetingView(deps.db, ctx.workspaceId, meetingId) };
}

/** Re-runs extraction: unreviewed candidates are replaced, confirmed and dismissed ones stay. */
export async function requestExtraction(
	deps: Deps,
	ctx: SessionContext,
	meetingId: string,
	requestId: string,
) {
	await ensureMeetingQueue(deps.boss);
	return withTransaction(deps.pool, async ({ db, queueDb }) => {
		const stale = new Date(Date.now() - EXTRACTION_EXPIRE_SECONDS * 1000);
		const [row] = await db
			.update(meetingSessions)
			.set({ status: "transcribed", failure: null, updatedAt: new Date() })
			.where(
				and(
					eq(meetingSessions.id, meetingId),
					eq(meetingSessions.workspaceId, ctx.workspaceId),
					or(
						inArray(meetingSessions.status, [
							"transcribed",
							"extracted",
							"reviewed",
							"failed",
						]),
						and(
							eq(meetingSessions.status, "processing"),
							lt(meetingSessions.extractionStartedAt, stale),
						),
					),
				),
			)
			.returning({ id: meetingSessions.id });
		if (!row) {
			const meeting = await requireMeeting(db, ctx.workspaceId, meetingId);
			throw new AppError(
				409,
				"invalid_state",
				"Extraction is already running",
				{
					extra: { status: meeting.status },
				},
			);
		}
		await enqueueMeetingExtraction(deps.boss, queueDb, { meetingId });
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "meeting.extraction_requested",
			targetType: "meeting",
			targetId: meetingId,
			requestId,
		});
		return { meeting: await getMeetingView(db, ctx.workspaceId, meetingId) };
	});
}

/** Deletes the meeting, its segments and candidates, and its transcript; filed reports stay. */
export async function deleteMeeting(
	deps: Deps,
	ctx: SessionContext,
	meetingId: string,
	requestId: string,
): Promise<void> {
	const meeting = await requireMeeting(deps.db, ctx.workspaceId, meetingId);
	if (ctx.role !== "owner" && meeting.createdBy !== ctx.userId)
		throw new AppError(
			403,
			"forbidden",
			"Only the uploader or a workspace owner can delete this meeting",
		);
	await withTransaction(deps.pool, async ({ db }) => {
		const [counts] = await db
			.select({
				candidates: sql<number>`count(*)::int`,
				confirmed: sql<number>`count(*) filter (where ${meetingCandidates.status} = 'confirmed')::int`,
			})
			.from(meetingCandidates)
			.where(eq(meetingCandidates.meetingSessionId, meetingId));
		await db.delete(meetingSessions).where(eq(meetingSessions.id, meetingId));
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "meeting.deleted",
			targetType: "meeting",
			targetId: meetingId,
			metadata: {
				provider: meeting.provider,
				source: meeting.source,
				segments: meeting.transcript.segment_count,
				candidates: counts?.candidates ?? 0,
				reports_kept: counts?.confirmed ?? 0,
			},
			requestId,
		});
	});
	// The same bytes may back another meeting or an evidence item; delete them only when unused.
	const sha = meeting.blobSha256;
	const [usage] = await deps.db
		.execute<{ used: boolean }>(
			sql`select exists (select 1 from ${meetingSessions} where ${meetingSessions.blobSha256} = ${sha})
		    or exists (select 1 from ${evidenceAssets} where ${evidenceAssets.blobSha256} = ${sha}) as used`,
		)
		.then((result) => result.rows);
	if (!usage?.used && /^[0-9a-f]{64}$/.test(sha))
		await unlink(
			path.join(
				deps.config.dataDir,
				"blobs",
				"sha256",
				sha.slice(0, 2),
				sha.slice(2, 4),
				sha,
			),
		).catch(() => undefined);
}

// ---- Review: correction, dismissal, confirmation ----------------------------------------------

/** extracted while a bug candidate awaits review, reviewed once none does. */
async function refreshReviewStatus(db: Db, meetingId: string): Promise<void> {
	await db
		.update(meetingSessions)
		.set({
			status: sql`case when exists (
				select 1 from ${meetingCandidates}
				 where ${meetingCandidates.meetingSessionId} = ${meetingId}
				   and ${meetingCandidates.kind} = 'bug'
				   and ${meetingCandidates.status} = 'pending_review')
				then 'extracted'::meeting_status else 'reviewed'::meeting_status end`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(meetingSessions.id, meetingId),
				inArray(meetingSessions.status, ["extracted", "reviewed"]),
			),
		);
}

const EDITABLE_FIELDS = [
	["kind", "kind"],
	["title", "title"],
	["description", "description"],
	["expected_behavior", "expectedBehavior"],
	["actual_behavior", "actualBehavior"],
	["steps", "steps"],
	["severity", "severity"],
] as const;

/**
 * A reviewer's correction. Edited fields become user_edited. Citing segments by hand also revives a
 * rejected candidate: the reviewer, not the model, is then the source of the citation.
 */
export async function updateCandidate(
	deps: Deps,
	ctx: SessionContext,
	meetingId: string,
	candidateId: string,
	input: UpdateMeetingCandidateRequest,
	requestId: string,
) {
	await requireMeeting(deps.db, ctx.workspaceId, meetingId);
	const candidate = await requireCandidate(
		deps.db,
		ctx.workspaceId,
		meetingId,
		candidateId,
	);
	const revive =
		candidate.status === "rejected" && input.segment_ids !== undefined;
	if (candidate.status !== "pending_review" && !revive)
		throw new AppError(
			409,
			"invalid_state",
			`This candidate is ${candidate.status}; only candidates awaiting review can be changed`,
		);
	const changes: Partial<CandidateRow> = {};
	const edited: string[] = [];
	for (const [field, column] of EDITABLE_FIELDS) {
		const value = input[field];
		if (value === undefined) continue;
		Object.assign(changes, { [column]: value });
		edited.push(field);
	}
	if (input.segment_ids) {
		const ids = [...new Set(input.segment_ids)];
		const segments = await deps.db
			.select({
				id: transcriptSegments.id,
				index: transcriptSegments.segmentIndex,
			})
			.from(transcriptSegments)
			.where(
				and(
					eq(transcriptSegments.meetingSessionId, meetingId),
					inArray(transcriptSegments.id, ids),
				),
			)
			.orderBy(asc(transcriptSegments.segmentIndex));
		if (segments.length !== ids.length)
			throw new AppError(
				422,
				"validation_failed",
				"Cite segments of this meeting",
				{
					errors: [
						{
							path: "segment_ids",
							message: "Unknown segment for this meeting",
						},
					],
				},
			);
		const quotes = new Map(
			candidate.citations.map((c) => [c.segment_id, c.quote]),
		);
		changes.citations = segments.map(
			(segment): CandidateCitationRecord => ({
				segment_id: segment.id,
				index: segment.index,
				quote: quotes.get(segment.id) ?? null,
			}),
		);
		changes.support = {
			status: "supported",
			citations_valid: segments.length,
			citations_dropped: 0,
			reasons: ["cited_by_reviewer"],
		};
		changes.status = "pending_review";
		edited.push("segment_ids");
	}
	if (input.repository_id !== undefined) {
		if (input.repository_id)
			await getRepositoryRow(deps.db, ctx.workspaceId, input.repository_id);
		changes.repositoryId = input.repository_id;
	}
	if (input.not_duplicate) changes.duplicateOf = null;
	changes.fieldSources = {
		...candidate.fieldSources,
		...Object.fromEntries(
			edited.map((field) => [field, "user_edited" as ValueSource]),
		),
	};
	await withTransaction(deps.pool, async ({ db }) => {
		const updated = await db
			.update(meetingCandidates)
			.set({ ...changes, updatedAt: new Date() })
			.where(
				and(
					eq(meetingCandidates.id, candidateId),
					eq(meetingCandidates.status, candidate.status),
				),
			)
			.returning({ id: meetingCandidates.id });
		if (updated.length === 0)
			throw new AppError(
				409,
				"invalid_state",
				"The candidate was reviewed meanwhile",
			);
		await refreshReviewStatus(db, meetingId);
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "meeting.candidate_edited",
			targetType: "meeting_candidate",
			targetId: candidateId,
			metadata: {
				meeting_id: meetingId,
				fields: edited,
				repository_changed: input.repository_id !== undefined,
				duplicate_cleared: input.not_duplicate === true,
				revived: revive,
			},
			requestId,
		});
	});
	return {
		candidate: await candidateView(
			deps.db,
			ctx.workspaceId,
			meetingId,
			candidateId,
		),
	};
}

export async function dismissCandidate(
	deps: Deps,
	ctx: SessionContext,
	meetingId: string,
	candidateId: string,
	reason: string | null,
	requestId: string,
) {
	await requireCandidate(deps.db, ctx.workspaceId, meetingId, candidateId);
	await withTransaction(deps.pool, async ({ db }) => {
		const updated = await db
			.update(meetingCandidates)
			.set({
				status: "dismissed",
				review: {
					decided_by: ctx.userId,
					decided_at: new Date().toISOString(),
					reason,
				},
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(meetingCandidates.id, candidateId),
					eq(meetingCandidates.status, "pending_review"),
				),
			)
			.returning({ id: meetingCandidates.id });
		if (updated.length === 0)
			throw new AppError(
				409,
				"invalid_state",
				"Only candidates awaiting review can be dismissed",
			);
		await refreshReviewStatus(db, meetingId);
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "meeting.candidate_dismissed",
			targetType: "meeting_candidate",
			targetId: candidateId,
			metadata: { meeting_id: meetingId, reason_given: reason !== null },
			requestId,
		});
	});
	return {
		candidate: await candidateView(
			deps.db,
			ctx.workspaceId,
			meetingId,
			candidateId,
		),
	};
}

const REPORT_FIELDS = [
	"title",
	"description",
	"expected_behavior",
	"actual_behavior",
	"steps",
	"severity",
] as const;

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)} [truncated]` : text;

/** The cited segments, verbatim, as a text note on the report (the report's meeting provenance). */
function excerptNote(
	meeting: MeetingRow,
	candidate: CandidateRow,
	segments: SegmentRow[],
): string {
	const line = (segment: SegmentRow) => {
		const time =
			segment.startMs === null
				? ""
				: ` · ${formatClock(segment.startMs)}${segment.endMs === null ? "" : `–${formatClock(segment.endMs)}`}`;
		const name = speakerName(meeting, segment.speakerLabel);
		const speaker = segment.speakerLabel
			? ` · ${segment.speakerLabel}${name ? ` (${name})` : ""}`
			: "";
		return `[SEG-${segment.segmentIndex}${time}${speaker}] ${clip(segment.text, 4000)}`;
	};
	return clip(
		[
			`Transcript excerpt from meeting ${meeting.id}${meeting.title ? ` ("${meeting.title}")` : ""}: ${meeting.provider}, ${meeting.source === "provider_api" ? "provider import" : "upload"} (${meeting.transcript.format}), transcript sha256 ${meeting.transcript.sha256}.`,
			`A model extracted candidate ${candidate.id} from these segments and a reviewer confirmed it. The segments are quoted as transcribed; speaker labels are not identities.`,
			"",
			...segments.map(line),
		].join("\n"),
		100_000,
	);
}

/**
 * Confirmation creates the bug report through the bug-report service (with meeting provenance, and
 * the candidate marked confirmed in the same transaction, so two confirmations cannot both create
 * one) and then starts an investigation through the investigation service.
 */
export async function confirmCandidate(
	deps: Deps,
	ctx: SessionContext,
	meetingId: string,
	candidateId: string,
	input: ConfirmMeetingCandidateRequest,
	requestId: string,
) {
	const meeting = await requireMeeting(deps.db, ctx.workspaceId, meetingId);
	const candidate = await requireCandidate(
		deps.db,
		ctx.workspaceId,
		meetingId,
		candidateId,
	);
	if (candidate.status !== "pending_review")
		throw new AppError(
			409,
			"invalid_state",
			`This candidate is ${candidate.status}`,
			{
				extra: { bug_report_id: candidate.bugReportId },
			},
		);
	if (candidate.kind !== "bug")
		throw new AppError(
			409,
			"invalid_state",
			`This candidate is classified as ${candidate.kind}; change its kind to bug to file it`,
		);
	if (candidate.citations.length === 0)
		throw new AppError(
			422,
			"citation_required",
			"Cite at least one transcript segment first",
		);
	if (candidate.duplicateOf && input.acknowledge_duplicate !== true)
		throw new AppError(
			409,
			"duplicate_unacknowledged",
			"This candidate may duplicate an existing item; confirm with acknowledge_duplicate or clear the flag",
			{ extra: { duplicate_of: candidate.duplicateOf } },
		);
	const repositoryId =
		input.repository_id ?? candidate.repositoryId ?? meeting.repositoryId;
	const start = input.start_investigation ?? true;
	if (start && !repositoryId)
		throw new AppError(
			422,
			"repository_required",
			"Choose a repository for the investigation, or confirm without starting one",
		);
	const segments = await deps.db
		.select()
		.from(transcriptSegments)
		.where(
			and(
				eq(transcriptSegments.meetingSessionId, meetingId),
				inArray(
					transcriptSegments.id,
					candidate.citations.map((c) => c.segment_id),
				),
			),
		)
		.orderBy(asc(transcriptSegments.segmentIndex));
	const report = CreateBugReportRequestSchema.parse({
		title: candidate.title,
		description: candidate.description,
		...(candidate.expectedBehavior
			? { expected_behavior: candidate.expectedBehavior }
			: {}),
		...(candidate.actualBehavior
			? { actual_behavior: candidate.actualBehavior }
			: {}),
		...(candidate.steps.length > 0 ? { steps: candidate.steps } : {}),
		...(candidate.severity !== "unknown"
			? { severity: candidate.severity }
			: {}),
		...(repositoryId ? { repository_id: repositoryId } : {}),
		logs: [
			{ kind: "text_note", content: excerptNote(meeting, candidate, segments) },
		],
		// The investigation's normalize stage runs normalization; no second model call here.
		normalize: false,
	});
	const created = await createBugReport(
		deps,
		ctx,
		report,
		{ requestId, idempotencyKey: undefined },
		{
			channel: "meeting",
			fieldSources: Object.fromEntries(
				REPORT_FIELDS.map((field) => [
					field,
					candidate.fieldSources[field] ?? "meeting_extracted",
				]),
			),
			evidenceProvenance: {
				meeting_session_id: meeting.id,
				meeting_candidate_id: candidate.id,
				meeting_provider: meeting.provider,
				meeting_source: meeting.source,
				provider_ref: meeting.providerRef,
				transcript_sha256: meeting.transcript.sha256,
				segment_ids: segments.map((s) => s.id),
				segments: segments.map((s) => ({
					id: s.id,
					index: s.segmentIndex,
					start_ms: s.startMs,
					end_ms: s.endMs,
					speaker_label: s.speakerLabel,
				})),
				model_execution_id: candidate.modelExecutionId,
				consent_attested_at: meeting.consentAttestedAt.toISOString(),
			},
			onCreated: async (db, bugReportId) => {
				const confirmed = await db
					.update(meetingCandidates)
					.set({
						status: "confirmed",
						bugReportId,
						repositoryId: input.repository_id ?? candidate.repositoryId,
						review: {
							decided_by: ctx.userId,
							decided_at: new Date().toISOString(),
							reason: null,
						},
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(meetingCandidates.id, candidateId),
							eq(meetingCandidates.status, "pending_review"),
						),
					)
					.returning({ id: meetingCandidates.id });
				if (confirmed.length === 0)
					throw new AppError(
						409,
						"invalid_state",
						"This candidate was already reviewed",
					);
				await refreshReviewStatus(db, meetingId);
				await audit(db, {
					workspaceId: ctx.workspaceId,
					actor: actorOf(ctx),
					action: "meeting.candidate_confirmed",
					targetType: "meeting_candidate",
					targetId: candidateId,
					metadata: {
						meeting_id: meetingId,
						bug_report_id: bugReportId,
						segments: segments.length,
						duplicate_acknowledged: candidate.duplicateOf !== null,
						start_investigation: start,
					},
					requestId,
				});
			},
		},
	);
	const bugReport = created.body.bug_report;
	let investigation: unknown = null;
	let investigationError: { code: string; message: string } | null = null;
	if (start) {
		try {
			investigation = (
				await createInvestigation(
					deps,
					ctx,
					{
						bug_report_id: bugReport.id,
						...(input.commit ? { commit: input.commit } : {}),
					},
					{ requestId, idempotencyKey: undefined },
				)
			).body.investigation;
		} catch (error) {
			if (!(error instanceof AppError)) throw error;
			investigationError = { code: error.code, message: error.message };
		}
	}
	return {
		candidate: await candidateView(
			deps.db,
			ctx.workspaceId,
			meetingId,
			candidateId,
		),
		bug_report: bugReport,
		investigation,
		investigation_error: investigationError,
	};
}

// ---- Status summary ---------------------------------------------------------------------------

const INVESTIGATION_PHRASES: Record<InvestigationStatus, string> = {
	queued: "investigation queued",
	running: "investigation in progress",
	needs_input: "investigation needs input",
	awaiting_approval: "investigation awaiting review",
	completed: "investigation completed",
	failed: "investigation failed",
	cancelled: "investigation cancelled",
};
/** The canonical verification labels; nothing else may say "verified". */
const OUTCOME_LABELS: Record<VerificationOutcome, string> = {
	verified: "Fix verified against the original reproduction",
	partially_verified:
		"Checks passed, but the original failure was not confirmed",
	failed: "Verification failed",
	inconclusive: "Verification inconclusive",
	blocked: "Verification could not run",
	not_attempted: "Not verified",
};

/** Model or user text in chat Markdown: no links, emphasis, or headings can be injected. */
const markdownText = (text: string) =>
	text.replace(/\s+/g, " ").replace(/[\\`*_{}[\]()<>#+|!~]/g, "\\$&");

/** A deterministic summary to paste into the meeting chat; every status comes from stored rows. */
export async function meetingSummary(
	db: Db,
	config: Config,
	workspaceId: string,
	meetingId: string,
): Promise<MeetingSummary> {
	const meeting = await requireMeeting(db, workspaceId, meetingId);
	const counts =
		(await candidateCounts(db, [meetingId])).get(meetingId) ?? NO_COUNTS;
	const rows = await db
		.select()
		.from(meetingCandidates)
		.where(
			and(
				eq(meetingCandidates.meetingSessionId, meetingId),
				eq(meetingCandidates.status, "confirmed"),
			),
		)
		.orderBy(asc(meetingCandidates.ordinal));
	const confirmed = (await candidateViews(db, meeting, rows)).flatMap((view) =>
		view.bug_report
			? [
					{
						candidate_id: view.id,
						bug_report_id: view.bug_report.id,
						title: view.title,
						investigation: view.investigation,
						link: view.investigation
							? `${config.api.publicUrl.replace(/\/+$/, "")}/investigations/${view.investigation.id}`
							: null,
					},
				]
			: [],
	);
	const mock = meeting.extraction?.mock ?? false;
	const generatedAt = new Date().toISOString();
	const lines = [
		`**Tracera meeting summary: ${markdownText(meeting.title ?? "Untitled meeting")}**${meeting.occurredAt ? ` (${meeting.occurredAt.toISOString().slice(0, 10)})` : ""}`,
		...(mock
			? [
					"[mock] Candidates were extracted with mock inference; no model analysed this transcript.",
				]
			: []),
		...(meeting.extraction ? [] : ["Bug extraction has not finished."]),
		"",
		...(confirmed.length > 0
			? [
					"Bug reports filed from this meeting:",
					...confirmed.map((item) => {
						const state = item.investigation
							? `${INVESTIGATION_PHRASES[item.investigation.status]}${
									item.investigation.verification_outcome
										? `; ${OUTCOME_LABELS[item.investigation.verification_outcome]}`
										: ""
								}`
							: "not investigated yet";
						return `- ${markdownText(item.title)} (${item.bug_report_id}): ${state}${item.link ? ` ${item.link}` : ""}`;
					}),
				]
			: ["No bug reports have been filed from this meeting yet."]),
		"",
		`Awaiting review: ${counts.bugs_pending} bug candidate(s). Dismissed: ${counts.dismissed}. Other topics (not bugs): ${counts.other_discussion}.`,
		"",
		`Generated by Tracera from stored statuses at ${generatedAt}; open a link for the current state.`,
	];
	return {
		meeting_id: meeting.id,
		title: meeting.title,
		generated_at: generatedAt,
		mock,
		counts,
		confirmed,
		markdown: lines.join("\n"),
	};
}
