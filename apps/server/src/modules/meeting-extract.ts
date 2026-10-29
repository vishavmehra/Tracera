import type {
	CitationSupport,
	MeetingCandidateKind,
	MeetingExtractionInfo,
	MeetingExtractionOutput,
	Severity,
	ValueSource,
} from "@tracera/contracts";
import {
	and,
	desc,
	eq,
	inArray,
	lt,
	max,
	ne,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, type QueueDb, withTransaction } from "../db/client.ts";
import {
	bugReports,
	type CandidateCitationRecord,
	type CandidateSupportRecord,
	type DuplicateRecord,
	meetingCandidates,
	meetingSessions,
	transcriptSegments,
} from "../db/schema.ts";
import { InferenceError } from "../inference/gateway.ts";
import type { ChatProvider } from "../inference/providers.ts";
import { extractMeetingBugsTask } from "../inference/tasks.ts";
import { newId } from "../lib/ids.ts";
import { detectInjection } from "./analysis.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import { workspaceGateway } from "./normalization.ts";

// The shared meeting engine's extraction stage: a deterministic pre-filter chooses
// what the model sees, one extract_meeting_bugs call proposes candidates, and code decides what is
// stored. Every citation must name a segment that was sent and quote it verbatim; candidates without
// one are rejected; duplicates are flagged for the reviewer. The model sets no status.

export type ExtractionSegment = {
	id: string;
	index: number;
	speaker: string | null;
	startMs: number | null;
	endMs: number | null;
	text: string;
};

// ---- Deterministic pre-filter -------------------------------------------------------------------

/** Characters of transcript sent per call (about 15k tokens); larger meetings send signal windows. */
export const TRANSCRIPT_BUDGET_CHARS = 60_000;
const LINE_OVERHEAD = 50;
const CONTEXT_SEGMENTS = 2;
const SIGNALS =
	/\b(?:bugs?|broken|breaks?|breaking|crash(?:es|ed|ing)?|errors?|exceptions?|fails?|failed|failing|failures?|wrong|incorrect|nan|undefined|regress(?:ion|ed)|glitch(?:es)?|freez(?:e|es|ing)|frozen|hangs?|stuck|slow|time[sd]? ?out|blank|empty|missing|disappear(?:s|ed)?|overflows?|cut off|off-?screen|duplicated?|not (?:working|loading|showing|saving|updating|responding)|doesn'?t work|does not work|can'?t|cannot|unable|won'?t|issues?|problems?|unexpected(?:ly)?|instead of|supposed to|should (?:be|show|have)|[45]\d\d)\b/gi;

/** Number of bug-signal terms in a text (an explainable selection score, not a classification). */
export const signalScore = (text: string) => text.match(SIGNALS)?.length ?? 0;

/**
 * Everything fits → send everything. Otherwise send the segments with bug signals plus two neighbours
 * on each side, strongest signals first, until the budget is spent. No signals → no model call.
 */
export function selectSegments(
	segments: readonly ExtractionSegment[],
	budget = TRANSCRIPT_BUDGET_CHARS,
): {
	selected: ExtractionSegment[];
	selection: MeetingExtractionInfo["selection"];
	withSignals: number;
} {
	const scores = segments.map((segment) => signalScore(segment.text));
	const withSignals = scores.filter((score) => score > 0).length;
	const cost = (segment: ExtractionSegment) =>
		segment.text.length + LINE_OVERHEAD;
	if (segments.reduce((sum, segment) => sum + cost(segment), 0) <= budget)
		return { selected: [...segments], selection: "all", withSignals };
	if (withSignals === 0)
		return { selected: [], selection: "none", withSignals };
	const strongest = scores
		.map((score, i) => ({ score, i }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.i - b.i);
	const chosen = new Set<number>();
	let used = 0;
	const take = (i: number) => {
		const segment = segments[i];
		if (!segment || chosen.has(i) || used + cost(segment) > budget)
			return false;
		chosen.add(i);
		used += cost(segment);
		return true;
	};
	for (const { i } of strongest) {
		if (!chosen.has(i) && !take(i)) continue;
		for (let j = i - CONTEXT_SEGMENTS; j <= i + CONTEXT_SEGMENTS; j++) take(j);
	}
	return {
		selected: [...chosen]
			.sort((a, b) => a - b)
			.flatMap((i) => (segments[i] ? [segments[i]] : [])),
		selection: "signal_windows",
		withSignals,
	};
}

/** Speakers become S1, S2, … in order of first appearance: the model never sees names. */
export function speakerPseudonyms(
	segments: readonly { speaker: string | null }[],
): Map<string, string> {
	const pseudonyms = new Map<string, string>();
	for (const { speaker } of segments)
		if (speaker && !pseudonyms.has(speaker))
			pseudonyms.set(speaker, `S${pseudonyms.size + 1}`);
	return pseudonyms;
}

/** hh:mm:ss.mmm */
export const formatClock = (ms: number) => {
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};

/** Transcript text must not be able to close or open the untrusted block it is wrapped in. */
const neutralize = (text: string) =>
	text.replace(/<\s*(\/?)\s*untrusted/gi, "[$1untrusted");

export function buildMeetingExtractionInput(input: {
	title: string | null;
	selected: readonly ExtractionSegment[];
	total: number;
	selection: MeetingExtractionInfo["selection"];
	pseudonyms: ReadonlyMap<string, string>;
}): string {
	const lines: string[] = [];
	let previous = 0;
	const gap = (missing: number) =>
		missing > 0 ? [`[${missing} segment(s) not shown]`] : [];
	for (const segment of input.selected) {
		lines.push(...gap(segment.index - previous - 1));
		const time =
			segment.startMs === null
				? ""
				: ` [${formatClock(segment.startMs)}${segment.endMs === null ? "" : `-${formatClock(segment.endMs)}`}]`;
		const speaker = segment.speaker
			? ` ${input.pseudonyms.get(segment.speaker) ?? "S?"}:`
			: "";
		lines.push(
			`SEG-${segment.index}${time}${speaker} ${neutralize(segment.text)}`,
		);
		previous = segment.index;
	}
	lines.push(...gap(input.total - previous));
	const scope =
		input.selection === "signal_windows"
			? " Only segments with bug signals and their neighbours are shown."
			: "";
	return [
		`Meeting transcript: ${input.selected.length} of ${input.total} segments.${scope}`,
		`<untrusted source="MEETING" kind="meeting_transcript">\n${input.title ? `Title: ${neutralize(input.title)}\n` : ""}${lines.join("\n")}\n</untrusted>`,
	].join("\n\n");
}

// ---- Validation of model output -----------------------------------------------------------------

const fold = (text: string) =>
	text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[‘’‚‛′]/g, "'")
		.replace(/[“”„‟″]/g, '"')
		.replace(/[‐‑‒–—―]/g, "-")
		.replace(/…/g, "...")
		.replace(/\s+/g, " ")
		.trim();

/**
 * A quote supports a segment when, ignoring case, whitespace, typographic quotes and dashes, and
 * outer punctuation, it occurs in the segment's text and is at least 12 characters long (or the
 * whole text of a shorter segment).
 */
export function quoteMatches(quote: string, text: string): boolean {
	const trim = (value: string) =>
		fold(value).replace(/^["'\s]+|["'.,;:!?\s]+$/g, "");
	const q = trim(quote);
	return (
		q.length > 0 &&
		q.length >= Math.min(12, trim(text).length) &&
		fold(text).includes(q)
	);
}

export type SettledCandidate = {
	kind: MeetingCandidateKind;
	status: "pending_review" | "rejected";
	title: string;
	description: string;
	expectedBehavior: string | null;
	actualBehavior: string | null;
	steps: string[];
	severity: Severity;
	affectedArea: string | null;
	citations: CandidateCitationRecord[];
	support: CandidateSupportRecord;
	fieldSources: Record<string, ValueSource>;
};

const orNull = (text: string | null) => text?.trim() || null;

/** Applies the citation rules to every proposed item; what fails them is rejected, never stored as fact. */
export function settleExtraction(
	items: MeetingExtractionOutput["items"],
	pack: ReadonlyMap<string, Pick<ExtractionSegment, "id" | "index" | "text">>,
): {
	candidates: SettledCandidate[];
	citationsTotal: number;
	citationsInvalid: number;
} {
	let citationsTotal = 0;
	let citationsInvalid = 0;
	const candidates = items.map((item): SettledCandidate => {
		const citations: CandidateCitationRecord[] = [];
		const reasons = new Set<string>();
		let dropped = 0;
		for (const citation of item.citations) {
			citationsTotal += 1;
			const segment = pack.get(citation.handle.trim().toUpperCase());
			const reason = !segment
				? "unknown_segment"
				: !quoteMatches(citation.quote, segment.text)
					? "quote_not_in_segment"
					: null;
			if (reason || !segment) {
				dropped += 1;
				reasons.add(reason ?? "unknown_segment");
				continue;
			}
			if (citations.some((c) => c.segment_id === segment.id)) continue;
			citations.push({
				segment_id: segment.id,
				index: segment.index,
				quote: citation.quote.trim().slice(0, 500),
			});
		}
		citationsInvalid += dropped;
		const status: CitationSupport =
			citations.length === 0
				? "unsupported"
				: dropped > 0
					? "partially_supported"
					: "supported";
		if (citations.length === 0) reasons.add("no_valid_citation");
		const description = item.description.trim();
		const title =
			item.title.trim() || description.slice(0, 120) || "Untitled topic";
		const candidate = {
			kind: item.kind,
			status: citations.length === 0 ? "rejected" : "pending_review",
			title,
			description: description || title,
			expectedBehavior: orNull(item.expected_behavior),
			actualBehavior: orNull(item.actual_behavior),
			steps: item.steps.map((step) => step.trim()).filter(Boolean),
			severity: item.severity_suggestion,
			affectedArea: orNull(item.affected_area),
			citations,
			support: {
				status,
				citations_valid: citations.length,
				citations_dropped: dropped,
				reasons: [...reasons].sort(),
			},
		} satisfies Omit<SettledCandidate, "fieldSources">;
		return { ...candidate, fieldSources: extractedSources(candidate) };
	});
	return { candidates, citationsTotal, citationsInvalid };
}

/** Every field the extraction filled is marked meeting_extracted (model output from the transcript). */
function extractedSources(
	candidate: Omit<SettledCandidate, "fieldSources">,
): Record<string, ValueSource> {
	const filled: Record<string, boolean> = {
		kind: true,
		title: true,
		description: true,
		expected_behavior: candidate.expectedBehavior !== null,
		actual_behavior: candidate.actualBehavior !== null,
		steps: candidate.steps.length > 0,
		severity: candidate.severity !== "unknown",
		segment_ids: true,
	};
	return Object.fromEntries(
		Object.entries(filled)
			.filter(([, value]) => value)
			.map(([field]) => [field, "meeting_extracted" as const]),
	);
}

// ---- Duplicates -------------------------------------------------------------------------------------

const STOPWORDS = new Set(
	"the and for with that this from when what which have has had are was were not but can cant cannot does doesnt dont into then than there their they them our you your its also only just very after before while about again some any all more most less each still even".split(
		" ",
	),
);

export function tokens(text: string): Set<string> {
	return new Set(
		text
			.normalize("NFKC")
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
	);
}

/** Jaccard similarity of two token sets. */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>) {
	let shared = 0;
	for (const token of a) if (b.has(token)) shared += 1;
	const union = a.size + b.size - shared;
	return union === 0 ? 0 : shared / union;
}

export const comparableText = (item: {
	title: string;
	actualBehavior: string | null;
	description: string;
}) => `${item.title} ${item.actualBehavior ?? item.description.slice(0, 300)}`;

export type Comparable = {
	type: DuplicateRecord["type"];
	id: string;
	title: string;
	tokens: ReadonlySet<string>;
	segmentIds: ReadonlySet<string>;
};

/**
 * The most similar earlier item at or above the threshold: 0.5 lexical similarity, or 0.25 when
 * both cite a segment in common. ponytail: lexical Jaccard over at most 500 reports and 500
 * candidates; use full-text or embedding search when workspaces outgrow it.
 */
export function findDuplicate(
	item: { tokens: ReadonlySet<string>; segmentIds: ReadonlySet<string> },
	others: readonly Comparable[],
): DuplicateRecord | null {
	let best: DuplicateRecord | null = null;
	for (const other of others) {
		const score = similarity(item.tokens, other.tokens);
		const sharesSegment = [...item.segmentIds].some((id) =>
			other.segmentIds.has(id),
		);
		if (
			score < (sharesSegment ? 0.25 : 0.5) ||
			(best && score <= best.similarity)
		)
			continue;
		best = {
			type: other.type,
			id: other.id,
			title: other.title,
			similarity: Math.round(score * 100) / 100,
		};
	}
	return best;
}

// ---- The extraction job -------------------------------------------------------------------------

export const MEETING_EXTRACT_QUEUE = "meeting.extract";
/** pg-boss redelivers a job whose worker died after this long; a claim older than this is stale. */
export const EXTRACTION_EXPIRE_SECONDS = 600;
export type MeetingExtractJob = { meetingId: string };
type ExtractionDeps = {
	db: Db;
	pool: pg.Pool;
	config: Config;
	provider: ChatProvider;
};

const ensured = new WeakMap<PgBoss, Promise<void>>();

/** Creates the queue on first use (queue.ts is untouched; the lead may move it into QUEUES). */
export function ensureMeetingQueue(boss: PgBoss): Promise<void> {
	let ready = ensured.get(boss);
	if (!ready) {
		ready = (async () => {
			if (await boss.getQueue(MEETING_EXTRACT_QUEUE)) return;
			await boss
				.createQueue(MEETING_EXTRACT_QUEUE, {
					retryLimit: 1,
					retryDelay: 5,
					expireInSeconds: EXTRACTION_EXPIRE_SECONDS,
				})
				.catch(async (error: unknown) => {
					if (!(await boss.getQueue(MEETING_EXTRACT_QUEUE))) throw error;
				});
		})();
		ready.catch(() => ensured.delete(boss));
		ensured.set(boss, ready);
	}
	return ready;
}

/** Enqueue inside the caller's transaction; the queue must exist (ensureMeetingQueue) beforehand. */
export const enqueueMeetingExtraction = (
	boss: PgBoss,
	db: QueueDb,
	job: MeetingExtractJob,
) => boss.send(MEETING_EXTRACT_QUEUE, job, { db, singletonKey: job.meetingId });

export async function registerMeetingWorker(
	deps: ExtractionDeps & { boss: PgBoss },
): Promise<void> {
	await ensureMeetingQueue(deps.boss);
	await deps.boss.work<MeetingExtractJob>(
		MEETING_EXTRACT_QUEUE,
		{ batchSize: 1 },
		async ([job]) => {
			if (job) await runMeetingExtraction(deps, job.data.meetingId);
		},
	);
}

/** Loads what new candidates are compared with: recent reports and other reviewable candidates. */
async function comparables(
	db: Db,
	meeting: { id: string; workspaceId: string },
): Promise<Comparable[]> {
	const reports = await db
		.select({
			id: bugReports.id,
			title: bugReports.title,
			actualBehavior: bugReports.actualBehavior,
			description: sql<string>`left(${bugReports.description}, 300)`,
		})
		.from(bugReports)
		.where(
			and(
				eq(bugReports.workspaceId, meeting.workspaceId),
				notInArray(bugReports.status, ["dismissed", "closed"]),
			),
		)
		.orderBy(desc(bugReports.createdAt))
		.limit(500);
	const candidates = await db
		.select({
			id: meetingCandidates.id,
			title: meetingCandidates.title,
			actualBehavior: meetingCandidates.actualBehavior,
			description: sql<string>`left(${meetingCandidates.description}, 300)`,
			citations: meetingCandidates.citations,
		})
		.from(meetingCandidates)
		.where(
			and(
				eq(meetingCandidates.workspaceId, meeting.workspaceId),
				eq(meetingCandidates.kind, "bug"),
				or(
					and(
						ne(meetingCandidates.meetingSessionId, meeting.id),
						eq(meetingCandidates.status, "pending_review"),
					),
					// This meeting's decided candidates survive a re-extraction.
					and(
						eq(meetingCandidates.meetingSessionId, meeting.id),
						inArray(meetingCandidates.status, ["confirmed", "dismissed"]),
					),
				),
			),
		)
		.orderBy(desc(meetingCandidates.createdAt))
		.limit(500);
	return [
		...reports.map((report) => ({
			type: "bug_report" as const,
			id: report.id,
			title: report.title,
			tokens: tokens(comparableText(report)),
			segmentIds: new Set<string>(),
		})),
		...candidates.map((candidate) => ({
			type: "candidate" as const,
			id: candidate.id,
			title: candidate.title,
			tokens: tokens(comparableText(candidate)),
			segmentIds: new Set(candidate.citations.map((c) => c.segment_id)),
		})),
	];
}

/**
 * Runs one extraction for a meeting in `transcribed` state (or a stale `processing` claim, when the
 * previous worker died). Model failures are recorded on the meeting, never thrown.
 */
export async function runMeetingExtraction(
	deps: ExtractionDeps,
	meetingId: string,
): Promise<void> {
	const startedAt = new Date();
	const [meeting] = await deps.db
		.update(meetingSessions)
		.set({
			status: "processing",
			extractionStartedAt: startedAt,
			failure: null,
			updatedAt: startedAt,
		})
		.where(
			and(
				eq(meetingSessions.id, meetingId),
				or(
					eq(meetingSessions.status, "transcribed"),
					and(
						eq(meetingSessions.status, "processing"),
						lt(
							meetingSessions.extractionStartedAt,
							new Date(startedAt.getTime() - EXTRACTION_EXPIRE_SECONDS * 1000),
						),
					),
				),
			),
		)
		.returning();
	if (!meeting) return; // deleted, already extracted, or claimed by a live worker
	const rows = await deps.db
		.select()
		.from(transcriptSegments)
		.where(eq(transcriptSegments.meetingSessionId, meetingId))
		.orderBy(transcriptSegments.segmentIndex);
	const segments: ExtractionSegment[] = rows.map((row) => ({
		id: row.id,
		index: row.segmentIndex,
		speaker: row.speakerLabel,
		startMs: row.startMs,
		endMs: row.endMs,
		text: row.text,
	}));
	const { selected, selection, withSignals } = selectSegments(segments);
	const flags = new Set(
		meeting.flags.filter((f) => f !== "injection_suspected"),
	);
	if (detectInjection(selected.map((segment) => segment.text)))
		flags.add("injection_suspected");
	const gateway = workspaceGateway(
		deps,
		{ workspaceId: meeting.workspaceId },
		{ model: deps.config.meetings.model },
	);
	let output: MeetingExtractionOutput = { items: [] };
	let modelExecutionId: string | null = null;
	if (selected.length > 0) {
		try {
			const result = await gateway.run(extractMeetingBugsTask, {
				user: buildMeetingExtractionInput({
					title: meeting.title,
					selected,
					total: segments.length,
					selection,
					pseudonyms: speakerPseudonyms(segments),
				}),
				cacheKey: meetingId,
			});
			output = result.output;
			modelExecutionId = result.modelExecutionId;
		} catch (error) {
			const failure =
				error instanceof InferenceError
					? {
							code: error.code,
							message: error.message,
							retryable: error.retryable,
						}
					: {
							code: "extraction_failed",
							message: "Bug extraction failed unexpectedly",
							retryable: true,
						};
			await deps.db
				.update(meetingSessions)
				.set({
					status: "failed",
					failure,
					flags: [...flags],
					updatedAt: new Date(),
				})
				.where(eq(meetingSessions.id, meetingId));
			await audit(deps.db, {
				workspaceId: meeting.workspaceId,
				actor: WORKER_ACTOR,
				action: "meeting.extraction_failed",
				targetType: "meeting",
				targetId: meetingId,
				metadata: {
					code: failure.code,
					model_execution_id:
						error instanceof InferenceError ? error.modelExecutionId : null,
				},
			});
			if (!(error instanceof InferenceError)) throw error;
			return;
		}
	}
	const pack = new Map(
		selected.map((segment) => [`SEG-${segment.index}`, segment]),
	);
	const settled = settleExtraction(output.items, pack);
	const known = await comparables(deps.db, meeting);
	await withTransaction(deps.pool, async ({ db }) => {
		const [current] = await db
			.select({ status: meetingSessions.status })
			.from(meetingSessions)
			.where(eq(meetingSessions.id, meetingId))
			.for("update");
		if (current?.status !== "processing") return; // deleted or finished by another worker
		// Unreviewed candidates are replaced; confirmed and dismissed ones stay.
		await db
			.delete(meetingCandidates)
			.where(
				and(
					eq(meetingCandidates.meetingSessionId, meetingId),
					inArray(meetingCandidates.status, ["pending_review", "rejected"]),
				),
			);
		const [last] = await db
			.select({ ordinal: max(meetingCandidates.ordinal) })
			.from(meetingCandidates)
			.where(eq(meetingCandidates.meetingSessionId, meetingId));
		const earlier: Comparable[] = [];
		const values = settled.candidates.map((candidate, i) => {
			const id = newId("cand");
			const reviewable =
				candidate.kind === "bug" && candidate.status !== "rejected";
			const item = {
				tokens: tokens(comparableText(candidate)),
				segmentIds: new Set(candidate.citations.map((c) => c.segment_id)),
			};
			const duplicateOf = reviewable
				? findDuplicate(item, [...earlier, ...known])
				: null;
			if (reviewable)
				earlier.push({
					type: "candidate",
					id,
					title: candidate.title,
					...item,
				});
			return {
				...candidate,
				id,
				workspaceId: meeting.workspaceId,
				meetingSessionId: meetingId,
				ordinal: (last?.ordinal ?? 0) + i + 1,
				duplicateOf,
				modelExecutionId,
			};
		});
		if (values.length > 0) await db.insert(meetingCandidates).values(values);
		const extraction: MeetingExtractionInfo = {
			provider: gateway.providerName,
			model: gateway.model,
			mock: gateway.providerKind === "mock",
			prompt_version: extractMeetingBugsTask.promptVersion,
			model_execution_id: modelExecutionId,
			selection,
			segments_total: segments.length,
			segments_sent: selected.length,
			segments_with_signals: withSignals,
			items_proposed: output.items.length,
			candidates: values.filter((v) => v.status !== "rejected").length,
			rejected: values.filter((v) => v.status === "rejected").length,
			citations_total: settled.citationsTotal,
			citations_invalid: settled.citationsInvalid,
			skipped_reason: selected.length === 0 ? "no_bug_signals" : null,
			started_at: startedAt.toISOString(),
			finished_at: new Date().toISOString(),
		};
		await db
			.update(meetingSessions)
			.set({
				status: "extracted",
				extraction,
				flags: [...flags],
				failure: null,
				updatedAt: new Date(),
			})
			.where(eq(meetingSessions.id, meetingId));
		await audit(db, {
			workspaceId: meeting.workspaceId,
			actor: WORKER_ACTOR,
			action: "meeting.extracted",
			targetType: "meeting",
			targetId: meetingId,
			metadata: {
				candidates: extraction.candidates,
				rejected: extraction.rejected,
				citations_invalid: extraction.citations_invalid,
				selection,
				model_execution_id: modelExecutionId,
				mock: extraction.mock,
			},
		});
	});
}
