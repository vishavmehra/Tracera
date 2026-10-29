import { z } from "zod";
import { VerificationOutcomeSchema } from "./analysis.ts";
import { BugReportStatusSchema } from "./bug-reports.ts";
import {
	idSchema,
	PaginationQuerySchema,
	RefNameSchema,
	SeveritySchema,
	SourceChannelSchema,
	ValueSourceSchema,
} from "./common.ts";
import { InvestigationStatusSchema } from "./investigations.ts";

// Meetings: a transcript is uploaded or imported, parsed into
// segments, mined for bug candidates that must cite those segments, reviewed by a person, and a
// confirmed candidate becomes a bug report and an investigation through the existing services.

export const MeetingProviderSchema = z.enum(["teams", "google_meet", "other"]);
export const MeetingSourceSchema = z.enum([
	"upload_transcript",
	"provider_api",
]);
/**
 * transcribed: segments stored, extraction queued · processing: extraction running · extracted:
 * candidates await review · reviewed: no bug candidate awaits review · failed: see `failure`.
 */
export const MeetingStatusSchema = z.enum([
	"transcribed",
	"processing",
	"extracted",
	"reviewed",
	"failed",
]);
/** speaker_text: "Name: text" lines, optionally with hh:mm:ss markers (a Google Meet export). */
export const TranscriptFormatSchema = z.enum([
	"webvtt",
	"srt",
	"speaker_text",
	"plain_text",
	"meet_entries",
]);
/**
 * exact: every segment has its own start and end · block: segments carry the interval between two
 * time markers of the source (Meet exports mark time every few minutes) · none: no times.
 */
export const TranscriptTimingSchema = z.enum(["exact", "block", "none"]);
export const TranscriptEncodingSchema = z.enum([
	"utf-8",
	"utf-16le",
	"utf-16be",
]);
/** bug = a defect in existing behavior; the other kinds are non-bug discussion. */
export const MeetingCandidateKindSchema = z.enum([
	"bug",
	"feature_request",
	"question",
	"other",
]);
/** rejected = no citation survived validation (set by code, never by the model or a reviewer). */
export const MeetingCandidateStatusSchema = z.enum([
	"pending_review",
	"confirmed",
	"dismissed",
	"rejected",
]);
export const CitationSupportSchema = z.enum([
	"supported",
	"partially_supported",
	"unsupported",
]);

/** The statement an uploader confirms (`consent_attested: true`); its version is stored. */
export const MEETING_CONSENT_STATEMENT = {
	version: "meeting-consent.v1",
	text: "I am authorized to share this meeting's transcript with Tracera, and the participants were informed that the meeting was transcribed.",
} as const;

/** Upload limits. */
export const TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;
export const TRANSCRIPT_EXTENSIONS = [".vtt", ".srt", ".txt"] as const;
/** Declared types accepted with those extensions; the content is still sniffed and decoded. */
export const TRANSCRIPT_CONTENT_TYPES = [
	"text/vtt",
	"text/plain",
	"application/x-subrip",
	"text/srt",
	"application/octet-stream",
	"",
] as const;

const timestamp = z.iso.datetime();
const count = z.number().int().nonnegative();
const nullableText = (max: number) => z.string().trim().max(max).nullable();
const ErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
	retryable: z.boolean().optional(),
});

// ---- Requests ---------------------------------------------------------------------------------

/**
 * POST /api/v1/meetings (session only, JSON, body ≤ 7.5 MB). The file travels as base64 so the
 * server checks the exact bytes (encoding, signature, size ≤ TRANSCRIPT_MAX_BYTES). A missing or
 * false `consent_attested` is `422 consent_required`.
 */
export const UploadMeetingTranscriptRequestSchema = z.strictObject({
	provider: MeetingProviderSchema,
	consent_attested: z.boolean().optional(),
	title: z.string().trim().min(1).max(200).optional(),
	occurred_at: z.iso.datetime({ offset: true }).optional(),
	/** Default repository for investigations started from this meeting's candidates. */
	repository_id: idSchema("repo").optional(),
	transcript: z.strictObject({
		filename: z.string().trim().min(1).max(255),
		content_type: z.string().trim().toLowerCase().max(100),
		data_base64: z.base64(),
	}),
});

export const MeetingListQuerySchema = PaginationQuerySchema.extend({
	status: MeetingStatusSchema.optional(),
	provider: MeetingProviderSchema.optional(),
});

/** `cursor` is the `next_cursor` of the previous page (segments are ordered by index). */
export const MeetingSegmentsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(500).default(200),
	cursor: z
		.string()
		.regex(/^\d{1,7}$/)
		.optional(),
});

/** PATCH /api/v1/meetings/{id} (session only). Speaker names are display names chosen by people. */
export const UpdateMeetingRequestSchema = z
	.strictObject({
		title: z.string().trim().min(1).max(200).nullable().optional(),
		speaker_map: z
			.record(
				z.string().min(1).max(200),
				z.string().trim().min(1).max(100).nullable(),
			)
			.optional(),
		repository_id: idSchema("repo").nullable().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to change",
	});

/** PATCH /api/v1/meetings/{id}/candidates/{candidate_id} (session only, pending candidates only). */
export const UpdateMeetingCandidateRequestSchema = z
	.strictObject({
		kind: MeetingCandidateKindSchema.optional(),
		title: z.string().trim().min(1).max(200).optional(),
		description: z.string().trim().min(1).max(20_000).optional(),
		expected_behavior: nullableText(5000).optional(),
		actual_behavior: nullableText(5000).optional(),
		steps: z.array(z.string().trim().min(1).max(1000)).max(50).optional(),
		severity: SeveritySchema.optional(),
		/** Replaces the citations: segments of this meeting, in any order. */
		segment_ids: z.array(idSchema("seg")).min(1).max(20).optional(),
		repository_id: idSchema("repo").nullable().optional(),
		/** Clears the duplicate flag after a person checked it. */
		not_duplicate: z.literal(true).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one field to change",
	});

/**
 * POST …/candidates/{candidate_id}/confirm (session only). Creates the bug report through the bug
 * report service and, unless `start_investigation` is false, an investigation through the
 * investigation service. A flagged duplicate needs `acknowledge_duplicate: true`.
 */
export const ConfirmMeetingCandidateRequestSchema = z.strictObject({
	repository_id: idSchema("repo").optional(),
	commit: RefNameSchema.optional(),
	start_investigation: z.boolean().optional(),
	acknowledge_duplicate: z.boolean().optional(),
});

export const DismissMeetingCandidateRequestSchema = z.strictObject({
	reason: z.string().trim().min(1).max(500).optional(),
});

/** A Meet transcript resource name, as listed by GET /api/v1/integrations/{id}/meetings. */
export const ProviderMeetingRefSchema = z
	.string()
	.regex(
		/^conferenceRecords\/[A-Za-z0-9_-]{1,200}\/transcripts\/[A-Za-z0-9_-]{1,200}$/,
		"Expected conferenceRecords/{id}/transcripts/{id}",
	);

/** POST /api/v1/integrations/{connection_id}/import (session only). */
export const ImportMeetingRequestSchema = z.strictObject({
	provider_meeting_ref: ProviderMeetingRefSchema,
	consent_attested: z.boolean().optional(),
	title: z.string().trim().min(1).max(200).optional(),
	repository_id: idSchema("repo").optional(),
});

// ---- Responses --------------------------------------------------------------------------------

export const TranscriptInfoSchema = z.object({
	format: TranscriptFormatSchema,
	timing: TranscriptTimingSchema,
	/** Null for provider imports. */
	filename: z.string().nullable(),
	content_type: z.string().nullable(),
	encoding: TranscriptEncodingSchema.nullable(),
	size_bytes: count,
	/** SHA-256 of the stored original (the uploaded file, or the fetched provider artifact). */
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	segment_count: count,
	speaker_labels: z.array(z.string()),
	duration_ms: count.nullable(),
	/** Parser notes: skipped blocks, truncated segments, and similar. */
	warnings: z.array(z.string()),
});

export const MeetingExtractionInfoSchema = z.object({
	provider: z.string(),
	model: z.string(),
	/** True when the mock provider ran: no model analysed the transcript. */
	mock: z.boolean(),
	prompt_version: z.string(),
	model_execution_id: idSchema("mex").nullable(),
	/** all: every segment was sent · signal_windows: bug-signal segments with context · none: no call. */
	selection: z.enum(["all", "signal_windows", "none"]),
	segments_total: count,
	segments_sent: count,
	segments_with_signals: count,
	items_proposed: count,
	candidates: count,
	rejected: count,
	citations_total: count,
	citations_invalid: count,
	skipped_reason: z.enum(["no_bug_signals"]).nullable(),
	started_at: timestamp,
	finished_at: timestamp,
});

export const MeetingCandidateCountsSchema = z.object({
	bugs_pending: count,
	bugs_confirmed: count,
	dismissed: count,
	rejected: count,
	other_discussion: count,
	possible_duplicates: count,
});

export const MeetingSchema = z.object({
	id: idSchema("mtg"),
	provider: MeetingProviderSchema,
	source: MeetingSourceSchema,
	title: z.string().nullable(),
	occurred_at: timestamp.nullable(),
	status: MeetingStatusSchema,
	repository_id: idSchema("repo").nullable(),
	/** e.g. conferenceRecords/…/transcripts/… for a Meet import. */
	provider_ref: z.string().nullable(),
	transcript: TranscriptInfoSchema,
	speaker_map: z.record(z.string(), z.string()),
	/** e.g. injection_suspected (advisory; changes no rule). */
	flags: z.array(z.string()),
	candidate_counts: MeetingCandidateCountsSchema,
	extraction: MeetingExtractionInfoSchema.nullable(),
	failure: ErrorSchema.nullable(),
	consent: z.object({
		attested_by: idSchema("usr"),
		attested_at: timestamp,
		statement: z.string(),
	}),
	created_by: idSchema("usr"),
	created_at: timestamp,
	updated_at: timestamp,
});

export const TranscriptSegmentSchema = z.object({
	id: idSchema("seg"),
	/** 1-based position in the transcript. */
	index: z.number().int().min(1),
	/** As written in the source; a label, not an identity. */
	speaker_label: z.string().nullable(),
	/** The display name a person mapped to the label, if any. */
	speaker_name: z.string().nullable(),
	start_ms: count.nullable(),
	end_ms: count.nullable(),
	text: z.string(),
});

export const MeetingSegmentPageSchema = z.object({
	items: z.array(TranscriptSegmentSchema),
	next_cursor: z.string().nullable(),
});

/** A citation checked by code: the segment exists in the meeting and contains the quote. */
export const CandidateCitationSchema = z.object({
	segment_id: idSchema("seg"),
	index: z.number().int().min(1),
	speaker_label: z.string().nullable(),
	speaker_name: z.string().nullable(),
	start_ms: count.nullable(),
	end_ms: count.nullable(),
	/** The words the model quoted (verified to occur in the segment), or null when a person cited it. */
	quote: z.string().nullable(),
	text: z.string(),
});

export const MeetingCandidateSchema = z.object({
	id: idSchema("cand"),
	meeting_id: idSchema("mtg"),
	ordinal: z.number().int().min(1),
	kind: MeetingCandidateKindSchema,
	status: MeetingCandidateStatusSchema,
	title: z.string(),
	description: z.string(),
	expected_behavior: z.string().nullable(),
	actual_behavior: z.string().nullable(),
	steps: z.array(z.string()),
	severity: SeveritySchema,
	affected_area: z.string().nullable(),
	citations: z.array(CandidateCitationSchema),
	support: z.object({
		status: CitationSupportSchema,
		citations_valid: count,
		citations_dropped: count,
		reasons: z.array(z.string()),
	}),
	/** A lexical-similarity signal for a reviewer, never an automatic merge. */
	duplicate_of: z
		.object({
			type: z.enum(["candidate", "bug_report"]),
			id: z.string(),
			title: z.string(),
			similarity: z.number(),
		})
		.nullable(),
	/** meeting_extracted (model output from the transcript) or user_edited, per field. */
	field_sources: z.record(z.string(), ValueSourceSchema),
	repository_id: idSchema("repo").nullable(),
	model_execution_id: idSchema("mex").nullable(),
	bug_report: z
		.object({ id: idSchema("bug"), status: BugReportStatusSchema })
		.nullable(),
	investigation: z
		.object({
			id: idSchema("inv"),
			status: InvestigationStatusSchema,
			verification_outcome: VerificationOutcomeSchema.nullable(),
		})
		.nullable(),
	review: z
		.object({
			decided_by: idSchema("usr"),
			decided_at: timestamp,
			reason: z.string().nullable(),
		})
		.nullable(),
	created_at: timestamp,
	updated_at: timestamp,
});

export const ConfirmMeetingCandidateResponseSchema = z.object({
	candidate: MeetingCandidateSchema,
	/** The bug report view of GET /api/v1/bug-reports/{id} (fields used by clients). */
	bug_report: z.object({
		id: idSchema("bug"),
		status: BugReportStatusSchema,
		title: z.string(),
		source_channel: SourceChannelSchema,
	}),
	investigation: z
		.object({ id: idSchema("inv"), status: InvestigationStatusSchema })
		.nullable(),
	/** Why the investigation did not start (the report exists; start it with POST /investigations). */
	investigation_error: ErrorSchema.nullable(),
});

/** GET /api/v1/meetings/{id}/summary: a deterministic status summary to share in the meeting chat. */
export const MeetingSummarySchema = z.object({
	meeting_id: idSchema("mtg"),
	title: z.string().nullable(),
	generated_at: timestamp,
	mock: z.boolean(),
	counts: MeetingCandidateCountsSchema,
	confirmed: z.array(
		z.object({
			candidate_id: idSchema("cand"),
			bug_report_id: idSchema("bug"),
			title: z.string(),
			investigation: z
				.object({
					id: idSchema("inv"),
					status: InvestigationStatusSchema,
					verification_outcome: VerificationOutcomeSchema.nullable(),
				})
				.nullable(),
			link: z.string().nullable(),
		}),
	),
	markdown: z.string(),
});

export const IntegrationProviderSchema = z.enum(["google", "microsoft"]);
export const IntegrationStatusSchema = z.enum([
	"active",
	"expired",
	"revoked",
	"error",
]);

/** GET /api/v1/integrations: what the server can do and what this user has connected. */
export const IntegrationSchema = z.object({
	provider: IntegrationProviderSchema,
	meeting_provider: MeetingProviderSchema,
	availability: z.enum(["available", "not_configured", "not_implemented"]),
	/** Names of the missing server variables (never values). */
	missing: z.array(z.string()),
	scopes: z.array(z.string()),
	connection: z
		.object({
			id: idSchema("int"),
			status: IntegrationStatusSchema,
			scopes: z.array(z.string()),
			connected_at: timestamp,
			last_error: ErrorSchema.nullable(),
		})
		.nullable(),
});

/** GET /api/v1/integrations/{id}/meetings: recent Meet conferences and their transcripts. */
export const ProviderMeetingSchema = z.object({
	conference_ref: z.string(),
	started_at: timestamp.nullable(),
	ended_at: timestamp.nullable(),
	/** The provider deletes the record (and its transcript entries) at this time. */
	expires_at: timestamp.nullable(),
	transcripts: z.array(
		z.object({
			provider_meeting_ref: z.string(),
			state: z.string(),
			started_at: timestamp.nullable(),
			ended_at: timestamp.nullable(),
			/** Entries are importable once the transcript has ended. */
			importable: z.boolean(),
		}),
	),
});

// ---- Model output (strict-schema subset: every property required, optional values nullable) ----

/** Task extract_meeting_bugs: cites SEG-n handles with a verbatim quote from each segment. */
export const MeetingExtractionOutputSchema = z.strictObject({
	items: z
		.array(
			z.strictObject({
				kind: MeetingCandidateKindSchema,
				title: z.string().max(200),
				description: z.string().max(4000),
				expected_behavior: z.string().max(2000).nullable(),
				actual_behavior: z.string().max(2000).nullable(),
				steps: z.array(z.string().max(500)).max(20),
				severity_suggestion: SeveritySchema,
				affected_area: z.string().max(200).nullable(),
				citations: z
					.array(
						z.strictObject({
							handle: z.string().max(20),
							quote: z.string().max(500),
						}),
					)
					.max(10),
			}),
		)
		.max(25),
});

export type MeetingProvider = z.infer<typeof MeetingProviderSchema>;
export type MeetingSource = z.infer<typeof MeetingSourceSchema>;
export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;
export type TranscriptFormat = z.infer<typeof TranscriptFormatSchema>;
export type TranscriptTiming = z.infer<typeof TranscriptTimingSchema>;
export type TranscriptEncoding = z.infer<typeof TranscriptEncodingSchema>;
export type MeetingCandidateKind = z.infer<typeof MeetingCandidateKindSchema>;
export type MeetingCandidateStatus = z.infer<
	typeof MeetingCandidateStatusSchema
>;
export type CitationSupport = z.infer<typeof CitationSupportSchema>;
export type UploadMeetingTranscriptRequest = z.infer<
	typeof UploadMeetingTranscriptRequestSchema
>;
export type UpdateMeetingRequest = z.infer<typeof UpdateMeetingRequestSchema>;
export type UpdateMeetingCandidateRequest = z.infer<
	typeof UpdateMeetingCandidateRequestSchema
>;
export type ConfirmMeetingCandidateRequest = z.infer<
	typeof ConfirmMeetingCandidateRequestSchema
>;
export type ImportMeetingRequest = z.infer<typeof ImportMeetingRequestSchema>;
export type TranscriptInfo = z.infer<typeof TranscriptInfoSchema>;
export type MeetingExtractionInfo = z.infer<typeof MeetingExtractionInfoSchema>;
export type MeetingCandidateCounts = z.infer<
	typeof MeetingCandidateCountsSchema
>;
export type Meeting = z.infer<typeof MeetingSchema>;
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type MeetingCandidate = z.infer<typeof MeetingCandidateSchema>;
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
export type ProviderMeeting = z.infer<typeof ProviderMeetingSchema>;
export type MeetingExtractionOutput = z.infer<
	typeof MeetingExtractionOutputSchema
>;
