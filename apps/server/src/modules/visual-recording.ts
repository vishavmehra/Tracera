import {
	type LocatedBox,
	LocatedBoxSchema,
	RECORDING_LOCATE_FRAMES,
	RECORDING_MAX_PER_REPORT,
	type RecordingAnalysis,
	type RecordingAnalysisOutput,
	RecordingAnalysisOutputSchema,
	type RecordingFrameTag,
	type RecordingState,
} from "@tracera/contracts";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, type QueueDb, withTransaction } from "../db/client.ts";
import { evidenceAssets } from "../db/schema.ts";
import { InferenceError } from "../inference/gateway.ts";
import type { ChatProvider } from "../inference/providers.ts";
import {
	analyzeRecordingTask,
	buildRecordingInput,
} from "../inference/tasks.ts";
import { putBlob, readBlobUtf8 } from "../lib/fs.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { enqueueRecording, QUEUES, type RecordingJob } from "../queue.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import type { PackItem } from "./context.ts";
import { workspaceGateway } from "./normalization.ts";
import {
	blobsDir,
	observeEvidenceAsset,
	redactOutput,
	renderObserved,
	withReadLock,
} from "./visual-evidence.ts";
import { locateInEvidence, segmentationAvailable } from "./visual-locate.ts";

export type RecordingDeps = {
	db: Db;
	pool: pg.Pool;
	config: Config;
	provider: ChatProvider;
};

type Asset = typeof evidenceAssets.$inferSelect;
type ErrorInfo = { code: string; message: string };
type Meta = RecordingFrameTag;

const ANALYZE = "analyze_recording";
/** How long an investigation stage waits for a recording that is still being read. */
const SETTLE_MS = 150_000;

const clock = (seconds: number | null) => {
	if (seconds === null) return "time unknown";
	const tenths = Math.round(seconds * 10);
	return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
};

const metaOf = (asset: Asset) =>
	asset.provenance.source_recording as Meta | undefined;

/** Every recording frame of a bug report, in upload order. */
async function framesOf(db: Db, workspaceId: string, bugReportId: string) {
	return db
		.select()
		.from(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.workspaceId, workspaceId),
				eq(evidenceAssets.bugReportId, bugReportId),
				eq(evidenceAssets.kind, "screenshot"),
				sql`${evidenceAssets.provenance}->'source_recording' is not null`,
			),
		)
		.orderBy(asc(evidenceAssets.createdAt), asc(evidenceAssets.id));
}

function group(assets: Asset[]) {
	const byRecording = new Map<string, Asset[]>();
	for (const asset of assets) {
		const meta = metaOf(asset);
		if (!meta) continue;
		byRecording.set(meta.recording_id, [
			...(byRecording.get(meta.recording_id) ?? []),
			asset,
		]);
	}
	return [...byRecording.values()]
		.map((frames) =>
			frames.sort((a, b) => (metaOf(a)?.index ?? 0) - (metaOf(b)?.index ?? 0)),
		)
		.slice(0, RECORDING_MAX_PER_REPORT);
}

// ---- Upload -----------------------------------------------------------------------------------------

/** The name stored for a keyframe: the recording and where in it the frame was taken. */
export const frameFilename = (tag: RecordingFrameTag) =>
	`${tag.name || "recording"} at ${clock(tag.timestamp_ms / 1000)}`.slice(
		0,
		200,
	);

/**
 * Called inside the upload transaction before a keyframe is stored. Returns the frame already held for
 * that slot (a resent frame is not stored twice) or refuses a frame that does not fit its recording.
 */
export async function heldFrame(
	db: Db,
	workspaceId: string,
	bugReportId: string,
	tag: RecordingFrameTag,
): Promise<Asset | null> {
	// One upload at a time per recording, so two requests cannot both find the slot free.
	await db.execute(
		sql`select pg_advisory_xact_lock(hashtext(${`recording:${bugReportId}:${tag.recording_id}`}))`,
	);
	const existing = group(await framesOf(db, workspaceId, bugReportId));
	const same = existing.find(
		(frames) => metaOf(frames[0] as Asset)?.recording_id === tag.recording_id,
	);
	const duplicate = same?.find((frame) => metaOf(frame)?.index === tag.index);
	if (duplicate) return duplicate;
	if (same && metaOf(same[0] as Asset)?.count !== tag.count)
		throw new AppError(
			409,
			"recording_mismatch",
			"This recording was announced with a different number of frames",
		);
	if (!same && existing.length >= RECORDING_MAX_PER_REPORT)
		throw new AppError(
			409,
			"too_many_recordings",
			`At most ${RECORDING_MAX_PER_REPORT} recordings are read per bug report`,
		);
	return null;
}

/** Queues the analysis when the frame just stored was the last one the recording announced. */
export async function queueWhenComplete(
	boss: PgBoss,
	tx: { db: Db; queueDb: QueueDb },
	scope: { workspaceId: string; bugReportId: string },
	tag: RecordingFrameTag,
): Promise<void> {
	const stored = (
		await framesOf(tx.db, scope.workspaceId, scope.bugReportId)
	).filter((frame) => metaOf(frame)?.recording_id === tag.recording_id);
	if (stored.length === tag.count)
		await enqueueRecording(boss, tx.queueDb, {
			...scope,
			recordingId: tag.recording_id,
		});
}

/** Reads the frames of one recording again (after a failure). */
export async function retryRecording(
	deps: { pool: pg.Pool; db: Db; boss: PgBoss },
	ctx: AuthContext,
	bugReportId: string,
	recordingId: string,
	requestId: string,
) {
	const frames = (await framesOf(deps.db, ctx.workspaceId, bugReportId)).filter(
		(frame) => metaOf(frame)?.recording_id === recordingId,
	);
	if (frames.length === 0)
		throw new AppError(
			404,
			"not_found",
			`Recording ${recordingId} was not found`,
		);
	if (frames.length < (metaOf(frames[0] as Asset)?.count ?? 0))
		throw new AppError(
			409,
			"recording_incomplete",
			"Not every frame of this recording has arrived",
		);
	await withTransaction(deps.pool, async ({ db, queueDb }) => {
		await enqueueRecording(deps.boss, queueDb, {
			workspaceId: ctx.workspaceId,
			bugReportId,
			recordingId,
		});
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "evidence.recording_requested",
			targetType: "bug_report",
			targetId: bugReportId,
			metadata: { recording_id: recordingId },
			requestId,
		});
	});
}

// ---- Stored results ---------------------------------------------------------------------------------

async function jsonOf<T>(
	config: Pick<Config, "dataDir">,
	row: Asset,
): Promise<T | null> {
	try {
		return JSON.parse(
			(await readBlobUtf8(blobsDir(config), row.blobSha256)) ?? "null",
		) as T | null;
	} catch {
		return null;
	}
}

const str = (value: unknown, fallback = "") =>
	typeof value === "string" ? value : fallback;

/** The job's state; pg-boss keeps it in the same database. */
async function pendingJob(
	pool: pg.Pool,
	scope: { workspaceId: string; bugReportId: string },
	recordingId: string,
): Promise<"queued" | "processing" | null> {
	const { rows } = await pool.query<{ state: string }>(
		"select state from pgboss.job where name = $1 and data->>'workspaceId' = $2 and data->>'bugReportId' = $3 and data->>'recordingId' = $4 and state in ('created', 'retry', 'active') order by created_on desc limit 1",
		[QUEUES.recording, scope.workspaceId, scope.bugReportId, recordingId],
	);
	const state = rows[0]?.state;
	return !state ? null : state === "active" ? "processing" : "queued";
}

async function analysisRows(
	deps: Pick<RecordingDeps, "db">,
	workspaceId: string,
	bugReportId: string,
) {
	return deps.db
		.select()
		.from(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.workspaceId, workspaceId),
				eq(evidenceAssets.bugReportId, bugReportId),
				eq(evidenceAssets.kind, "ai_annotation"),
				sql`${evidenceAssets.provenance}->>'task' = ${ANALYZE}`,
			),
		)
		.orderBy(desc(evidenceAssets.createdAt), desc(evidenceAssets.id));
}

async function toAnalysis(
	config: Pick<Config, "dataDir">,
	row: Asset,
): Promise<RecordingAnalysis> {
	const p = row.provenance;
	const failed = p.status === "failed";
	const stored = failed
		? null
		: await jsonOf<{ output?: unknown }>(config, row);
	const parsed = RecordingAnalysisOutputSchema.safeParse(stored?.output);
	const output = parsed.success ? parsed.data : null;
	return {
		id: row.id,
		status: failed || !output ? "failed" : "succeeded",
		model: str(p.model),
		provider: str(p.provider),
		mode: p.mode === "mock" ? "mock" : "live",
		placeholder_provider: p.placeholder_provider === true,
		model_execution_id:
			typeof p.model_execution_id === "string" ? p.model_execution_id : null,
		frames_read: typeof p.frames_read === "number" ? p.frames_read : 0,
		output,
		error: failed
			? ((p.error as ErrorInfo | null) ?? {
					code: "analysis_failed",
					message: "The analysis failed",
				})
			: output
				? null
				: {
						code: "analysis_unavailable",
						message: "The stored analysis could not be read",
					},
		created_at: row.createdAt.toISOString(),
	};
}

/** `GET /api/v1/bug-reports/{id}/recordings`: each recording with its frames, readings, and regions. */
export async function getRecordings(
	deps: Pick<RecordingDeps, "db" | "pool" | "config">,
	workspaceId: string,
	bugReportId: string,
): Promise<RecordingState[]> {
	const recordings = group(await framesOf(deps.db, workspaceId, bugReportId));
	if (recordings.length === 0) return [];
	const ids = recordings.flatMap((frames) => frames.map((frame) => frame.id));
	const derived = await deps.db
		.select()
		.from(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.workspaceId, workspaceId),
				eq(evidenceAssets.kind, "ai_annotation"),
				inArray(evidenceAssets.derivedFromEvidenceId, ids),
			),
		)
		.orderBy(desc(evidenceAssets.createdAt), desc(evidenceAssets.id));
	const latest = (frameId: string, task: string, phrase?: string) =>
		derived.find(
			(row) =>
				row.derivedFromEvidenceId === frameId &&
				row.provenance.task === task &&
				(phrase === undefined || row.provenance.phrase === phrase),
		);
	const analyses = await analysisRows(deps, workspaceId, bugReportId);
	const states: RecordingState[] = [];
	for (const frames of recordings) {
		const first = metaOf(frames[0] as Asset) as Meta;
		const row = analyses.find(
			(a) => a.provenance.recording_id === first.recording_id,
		);
		const analysis = row ? await toAnalysis(deps.config, row) : null;
		const phrase = analysis?.output?.failing_element ?? null;
		const pending = await pendingJob(
			deps.pool,
			{ workspaceId, bugReportId },
			first.recording_id,
		);
		const frameStates = await Promise.all(
			frames.map(async (frame) => {
				const meta = metaOf(frame) as Meta;
				const read = latest(frame.id, "observe_screenshot");
				const located = phrase
					? latest(frame.id, "locate_ui_element", phrase)
					: undefined;
				let regions: LocatedBox[] = [];
				if (located && located.provenance.status === "succeeded") {
					const stored = await jsonOf<{ boxes?: unknown }>(
						deps.config,
						located,
					);
					const parsed = LocatedBoxSchema.array().safeParse(stored?.boxes);
					if (parsed.success) regions = parsed.data;
				}
				return {
					id: frame.id,
					index: meta.index,
					timestamp_ms: meta.timestamp_ms,
					observation: !read
						? ("pending" as const)
						: read.provenance.status === "failed"
							? ("failed" as const)
							: ("succeeded" as const),
					regions,
				};
			}),
		);
		const complete = frames.length >= first.count;
		const failure = analysis?.status === "failed" ? analysis.error : null;
		states.push({
			recording_id: first.recording_id,
			name: first.name,
			duration_ms: first.duration_ms,
			frame_count: first.count,
			status: pending
				? pending
				: !complete
					? "receiving"
					: analysis?.status === "succeeded"
						? "succeeded"
						: "failed",
			error:
				pending || !complete
					? null
					: (failure ??
						(analysis
							? null
							: {
									code: "not_analyzed",
									message: "The frames have not been analyzed yet; try again",
								})),
			frames: frameStates,
			region_phrase: phrase,
			analysis,
		});
	}
	return states;
}

// ---- Processing ----------------------------------------------------------------------------------

/** At most `limit` tasks run at once; results keep their order. */
async function mapLimit<T, R>(
	items: T[],
	limit: number,
	task: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const run = async () => {
		for (let at = next++; at < items.length; at = next++)
			results[at] = await task(items[at] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
	return results;
}

/** Evenly spaced picks, the first and the last included. */
export function pickEvenly<T>(items: T[], k: number): T[] {
	if (items.length <= k) return items;
	const at = new Set(
		Array.from({ length: k }, (_, i) =>
			Math.round((i * (items.length - 1)) / (k - 1)),
		),
	);
	return [...at].map((i) => items[i] as T);
}

/** Seconds beyond the recording's length are not a time in it. */
export function cleanAnalysis(
	output: RecordingAnalysisOutput,
	durationSeconds: number,
	redactEmails: boolean,
) {
	const redacted = redactOutput(output, redactEmails);
	const inside = (t: number | null) =>
		t !== null && t >= 0 && t <= durationSeconds + 1 ? t : null;
	const phrase = redacted.output.failing_element
		?.replace(/[<>\p{Cc}]/gu, " ")
		.replace(/\s+/g, " ")
		.slice(0, 80)
		.trim();
	return {
		count: redacted.count,
		output: {
			...redacted.output,
			timeline: redacted.output.timeline.map((e) => ({
				...e,
				timestamp_seconds: inside(e.timestamp_seconds),
			})),
			error_messages: redacted.output.error_messages.map((e) => ({
				...e,
				timestamp_seconds: inside(e.timestamp_seconds),
			})),
			failing_element: phrase ? phrase : null,
		},
	};
}

async function storeAnalysis(
	deps: RecordingDeps,
	frames: Asset[],
	extra: Record<string, unknown>,
	output: RecordingAnalysisOutput | null,
	redactionCount: number,
) {
	const meta = metaOf(frames[0] as Asset) as Meta;
	const first = frames[0] as Asset;
	const blob = await putBlob(
		blobsDir(deps.config),
		Buffer.from(JSON.stringify({ schema: "recording_analysis.v1", output })),
	);
	await deps.db.insert(evidenceAssets).values({
		id: newId("evd"),
		workspaceId: first.workspaceId,
		bugReportId: first.bugReportId,
		derivedFromEvidenceId: first.id,
		kind: "ai_annotation",
		origin: "generated_by_model",
		blobSha256: blob.sha256,
		mimeType: "application/json",
		sizeBytes: blob.size,
		provenance: {
			task: ANALYZE,
			prompt_version: analyzeRecordingTask.promptVersion,
			recording_id: meta.recording_id,
			name: meta.name,
			frame_ids: frames.map((f) => f.id),
			frames_total: frames.length,
			...extra,
		},
		redactions:
			redactionCount > 0 ? { applied_by: "server", count: redactionCount } : {},
		retentionUntil: first.retentionUntil,
	});
}

/**
 * Reads every keyframe of a recording as a screenshot, then analyzes the readings together (text only),
 * then asks the segmentation model where the named element is in a few frames. Failures are stored; a
 * succeeded analysis is reused.
 */
export async function processRecording(
	deps: RecordingDeps,
	job: RecordingJob,
): Promise<void> {
	await withReadLock(
		deps.pool,
		`recording:${job.recordingId}`,
		undefined,
		async () => {
			const frames = (
				await framesOf(deps.db, job.workspaceId, job.bugReportId)
			).filter((frame) => metaOf(frame)?.recording_id === job.recordingId);
			frames.sort((a, b) => (metaOf(a)?.index ?? 0) - (metaOf(b)?.index ?? 0));
			const first = frames[0];
			const meta = first ? metaOf(first) : undefined;
			if (!first || !meta || frames.length < meta.count) return;
			const known = (
				await analysisRows(deps, job.workspaceId, job.bugReportId)
			).find((r) => r.provenance.recording_id === job.recordingId);
			if (known && known.provenance.status !== "failed") return;

			const readings = await mapLimit(frames, 4, (frame) =>
				observeEvidenceAsset(deps, {
					workspaceId: job.workspaceId,
					evidenceId: frame.id,
				}),
			);
			const framesRead = readings.filter(
				(r) => r?.status === "succeeded" && r.output,
			).length;
			const gateway = workspaceGateway(
				deps,
				{ workspaceId: job.workspaceId, bugReportId: job.bugReportId },
				{ model: deps.config.inference.reasoningModel },
			);
			const kind = gateway.providerKind;
			const base = {
				model: gateway.model,
				provider: gateway.providerName,
				provider_kind: kind,
				mode: kind === "mock" ? "mock" : "live",
				placeholder_provider: kind === "openai_compatible",
				frames_read: framesRead,
			};
			const fail = async (error: ErrorInfo, executionId: string | null) => {
				await storeAnalysis(
					deps,
					frames,
					{ ...base, model_execution_id: executionId, status: "failed", error },
					null,
					0,
				);
				await audit(deps.db, {
					workspaceId: job.workspaceId,
					actor: WORKER_ACTOR,
					action: "evidence.recording_analyzed",
					targetType: "bug_report",
					targetId: job.bugReportId,
					metadata: {
						recording_id: job.recordingId,
						status: "failed",
						code: error.code,
					},
				});
			};
			if (framesRead === 0) {
				await fail(
					{
						code: "frames_unreadable",
						message: "None of the keyframes could be read",
					},
					null,
				);
				return;
			}
			const duration = meta.duration_ms / 1000;
			let output: RecordingAnalysisOutput | null = null;
			let executionId: string | null = null;
			try {
				const result = await gateway.run(analyzeRecordingTask, {
					user: buildRecordingInput({
						durationSeconds: duration,
						frames: frames.map((frame, i) => {
							const reading = readings[i];
							return {
								index: metaOf(frame)?.index ?? i,
								timestampSeconds: (metaOf(frame)?.timestamp_ms ?? 0) / 1000,
								reading:
									reading?.status === "succeeded" && reading.output
										? renderObserved(reading.output, reading.provenance)
										: null,
								unreadReason: reading?.error?.code ?? "not_read",
							};
						}),
					}),
					cacheKey: job.recordingId,
				});
				output = result.output;
				executionId = result.modelExecutionId;
			} catch (caught) {
				if (!(caught instanceof InferenceError) || caught.code === "cancelled")
					throw caught;
				await fail(
					{ code: caught.code, message: caught.message },
					caught.modelExecutionId,
				);
				return;
			}
			const cleaned = cleanAnalysis(
				output,
				duration,
				deps.config.inference.redactEmails,
			);
			await storeAnalysis(
				deps,
				frames,
				{
					...base,
					model_execution_id: executionId,
					status: "succeeded",
					error: null,
				},
				cleaned.output,
				cleaned.count,
			);
			await audit(deps.db, {
				workspaceId: job.workspaceId,
				actor: WORKER_ACTOR,
				action: "evidence.recording_analyzed",
				targetType: "bug_report",
				targetId: job.bugReportId,
				metadata: {
					recording_id: job.recordingId,
					status: "succeeded",
					frames_read: framesRead,
					model: gateway.model,
					provider: gateway.providerName,
					model_execution_id: executionId,
				},
			});

			const phrase = cleaned.output.failing_element;
			if (phrase && segmentationAvailable(deps.config)) {
				const readable = frames.filter(
					(_, i) => readings[i]?.status === "succeeded" && readings[i]?.output,
				);
				await mapLimit(
					pickEvenly(readable, RECORDING_LOCATE_FRAMES),
					3,
					(frame) =>
						locateInEvidence(deps, {
							workspaceId: job.workspaceId,
							evidenceId: frame.id,
							phrase,
						}),
				);
			}
		},
	);
}

// ---- Feeding the investigation ------------------------------------------------------------------

const oneLine = (text: string, max = 300) => {
	const flat = text
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/<\s*(\/?)\s*untrusted/gi, "[$1untrusted");
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const lines = (title: string, items: string[]) =>
	items.length > 0 ? [`${title}:`, ...items.map((i) => `- ${i}`)] : [];

/** What was sent, in words: keyframes, never a watched video. */
export const howSeen = (frameSeconds: number[]) =>
	`Analyzed ${frameSeconds.length} keyframe${frameSeconds.length === 1 ? "" : "s"} sampled at these timestamps: ${frameSeconds.map((s) => clock(s)).join(", ")}. The video itself was not read, so what happened between frames is inferred.`;

const sourceOf = (a: RecordingAnalysis) =>
	`${a.model} via ${a.provider}, ${a.mode === "mock" ? "[mock]" : "[live]"}${a.placeholder_provider ? ", placeholder provider" : ""}`;

/** "Observed in recording": what the readings of the frames state. */
export function renderRecordingObserved(
	a: RecordingAnalysis,
	output: RecordingAnalysisOutput,
	frameSeconds: number[],
): string {
	return [
		`Read from a screen recording as keyframes by a vision model (${sourceOf(a)}). ${howSeen(frameSeconds)} This was read from pixels, can contain errors, and has not been checked against the repository or by running anything.`,
		`Summary: ${oneLine(output.summary, 600)}`,
		...lines(
			"Timeline (visible)",
			output.timeline
				.filter((e) => e.basis === "visible")
				.slice(0, 30)
				.map(
					(e) => `[${clock(e.timestamp_seconds)}] ${oneLine(e.statement, 400)}`,
				),
		),
		...lines(
			"Error messages",
			output.error_messages
				.slice(0, 20)
				.map(
					(e) =>
						`"${oneLine(e.text)}" (first in the frame at ${clock(e.timestamp_seconds)})`,
				),
		),
		output.failing_element
			? `Element that looks wrong: ${oneLine(output.failing_element, 80)}`
			: "Element that looks wrong: none named",
		...lines(
			"Not determinable from the frames",
			output.missing_information.slice(0, 15).map((m) => oneLine(m, 300)),
		),
	].join("\n");
}

/** "Model inference": guesses about what happened. Not visible, not verified. */
export function renderRecordingInferred(
	a: RecordingAnalysis,
	output: RecordingAnalysisOutput,
	frameSeconds: number[],
): string {
	return [
		`Guesses by a vision model about a screen recording read as keyframes (${sourceOf(a)}). ${howSeen(frameSeconds)} None of this is directly visible and none of it has been verified.`,
		...output.timeline
			.filter((e) => e.basis === "inferred")
			.slice(0, 20)
			.map(
				(e) => `- [${clock(e.timestamp_seconds)}] ${oneLine(e.statement, 400)}`,
			),
		...lines(
			"Candidate reproduction steps (a guess, not a verified procedure)",
			output.reproduction_steps
				.slice(0, 20)
				.map((s, i) => `${i + 1}. ${oneLine(s.step, 400)}`),
		),
	].join("\n");
}

/** Waits (bounded) while a recording is still being read, then returns where every recording stands. */
async function settle(
	deps: Pick<RecordingDeps, "db" | "pool" | "config">,
	scope: { workspaceId: string; bugReportId: string },
) {
	const deadline = Date.now() + SETTLE_MS;
	for (;;) {
		const states = await getRecordings(
			deps,
			scope.workspaceId,
			scope.bugReportId,
		);
		if (
			!states.some((s) => s.status === "queued" || s.status === "processing") ||
			Date.now() >= deadline
		)
			return states;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}

const describe = (s: RecordingState) =>
	s.status === "failed"
		? `could not be analyzed (${s.error?.code ?? "failed"})`
		: s.status === "receiving"
			? "has not fully arrived"
			: "was still being read";

const nameOf = (s: RecordingState) => oneLine(s.name, 60) || s.recording_id;
/** The times of the frames that were read: only those were analyzed. */
const secondsOf = (s: RecordingState) =>
	s.frames
		.filter((f) => f.observation === "succeeded")
		.map((f) => f.timestamp_ms / 1000);

/** Prompt blocks for bug report normalization: REC-n (visible) and RECINFER-n (inferred) per recording. */
export async function recordingEvidenceForNormalization(
	deps: Pick<RecordingDeps, "db" | "pool" | "config">,
	scope: { workspaceId: string; bugReportId: string },
): Promise<{
	evidence: Array<{ handle: string; kind: string; text: string }>;
	unread: number;
}> {
	const evidence: Array<{ handle: string; kind: string; text: string }> = [];
	let unread = 0;
	let n = 0;
	for (const state of await settle(deps, scope)) {
		const output = state.analysis?.output;
		if (state.status !== "succeeded" || !state.analysis || !output) {
			unread += 1;
			continue;
		}
		n += 1;
		evidence.push({
			handle: `REC-${n}`,
			kind: "recording_observation",
			text: renderRecordingObserved(state.analysis, output, secondsOf(state)),
		});
		if (
			output.reproduction_steps.length > 0 ||
			output.timeline.some((e) => e.basis === "inferred")
		)
			evidence.push({
				handle: `RECINFER-${n}`,
				kind: "recording_inference",
				text: renderRecordingInferred(state.analysis, output, secondsOf(state)),
			});
	}
	return { evidence, unread };
}

/**
 * Investigation evidence for collect_context. REC-n is basis `reported` (the user supplied the frames, a
 * model read them) and RECINFER-n is basis `inferred`; neither is `observed`, so neither can move a
 * hypothesis to supported or contradicted.
 */
export async function recordingEvidenceItems(
	deps: Pick<RecordingDeps, "db" | "pool" | "config">,
	scope: { workspaceId: string; bugReportId: string },
): Promise<{ items: PackItem[]; limitations: string[] }> {
	const items: PackItem[] = [];
	const limitations: string[] = [];
	let n = 0;
	for (const state of await settle(deps, scope)) {
		const analysis = state.analysis;
		const output = analysis?.output;
		if (state.status !== "succeeded" || !analysis || !output) {
			limitations.push(`Recording ${nameOf(state)} ${describe(state)}`);
			continue;
		}
		n += 1;
		const where = {
			recording_id: state.recording_id,
			evidence_asset_ids: state.frames.map((f) => f.id),
			derived_evidence_id: analysis.id,
		};
		const how = {
			method: "vision_model",
			task: ANALYZE,
			model: analysis.model,
			provider: analysis.provider,
			mode: analysis.mode,
			placeholder_provider: analysis.placeholder_provider,
			frames: secondsOf(state).length,
			model_execution_id: analysis.model_execution_id,
		};
		const tag = `${analysis.mode === "mock" ? "[mock]" : "[live]"} ${analysis.model}, ${secondsOf(state).length} keyframes`;
		items.push({
			handle: `REC-${n}`,
			kind: "model_observation",
			basis: "reported",
			label: `Observed in recording: ${nameOf(state)} (${tag})`,
			content: renderRecordingObserved(analysis, output, secondsOf(state)),
			locator: where,
			provenance: how,
		});
		if (
			output.reproduction_steps.length > 0 ||
			output.timeline.some((e) => e.basis === "inferred")
		)
			items.push({
				handle: `RECINFER-${n}`,
				kind: "model_observation",
				basis: "inferred",
				label: `Model inference about recording: ${nameOf(state)} (${tag})`,
				content: renderRecordingInferred(analysis, output, secondsOf(state)),
				locator: where,
				provenance: how,
			});
	}
	return { items, limitations };
}
