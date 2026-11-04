import { z } from "zod";
import { idSchema } from "./common.ts";
import { LocatedBoxSchema } from "./visual.ts";

/** Keyframes kept per screen recording, spaced evenly in time (the first and the last included). */
export const RECORDING_MAX_FRAMES = 12;
/** Recordings per bug report that are read. */
export const RECORDING_MAX_PER_REPORT = 3;
/** Keyframes the segmentation model is asked about. */
export const RECORDING_LOCATE_FRAMES = 6;

/**
 * Where in a screen recording a screenshot was taken. A recording never leaves the browser: it sends up
 * to twelve still frames through the ordinary screenshot upload, each carrying this tag in the `meta`
 * part. The server groups frames by `recording_id`.
 */
export const RecordingFrameTagSchema = z
	.strictObject({
		recording_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
		name: z.string().trim().max(150).default(""),
		index: z
			.number()
			.int()
			.min(0)
			.max(RECORDING_MAX_FRAMES - 1),
		count: z.number().int().min(1).max(RECORDING_MAX_FRAMES),
		timestamp_ms: z.number().int().min(0).max(86_400_000),
		duration_ms: z.number().int().min(0).max(86_400_000),
	})
	.refine((tag) => tag.index < tag.count, {
		path: ["index"],
		message: "index must be below count",
	});
export type RecordingFrameTag = z.infer<typeof RecordingFrameTagSchema>;

/** `POST /api/v1/bug-reports/{id}/recordings`: read the frames of one recording again. */
export const RecordingRetryRequestSchema = z.strictObject({
	recording_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});

/**
 * Structured output of task analyze_recording, a text-only task over the per-frame readings. What the
 * frames show stays apart from what is guessed between them. Timestamps are seconds from the start.
 */
export const RecordingAnalysisOutputSchema = z.object({
	summary: z.string().max(2000),
	timeline: z
		.array(
			z.object({
				timestamp_seconds: z.number().min(0).max(100_000).nullable(),
				statement: z.string().max(1000),
				basis: z.enum(["visible", "inferred"]),
			}),
		)
		.max(60),
	error_messages: z
		.array(
			z.object({
				text: z.string().max(1000),
				timestamp_seconds: z.number().min(0).max(100_000).nullable(),
			}),
		)
		.max(30),
	/** A short noun phrase with a visible attribute, such as "red banner", for the segmentation model. */
	failing_element: z.string().max(80).nullable(),
	reproduction_steps: z.array(z.object({ step: z.string().max(600) })).max(30),
	missing_information: z.array(z.string().max(600)).max(30),
});
export type RecordingAnalysisOutput = z.infer<
	typeof RecordingAnalysisOutputSchema
>;

const ErrorInfoSchema = z.object({ code: z.string(), message: z.string() });

export const RecordingFrameStateSchema = z.object({
	/** The screenshot evidence holding this frame; its image is served by the evidence content route. */
	id: idSchema("evd"),
	index: z.number().int().nonnegative(),
	timestamp_ms: z.number().int().nonnegative(),
	observation: z.enum(["succeeded", "failed", "pending"]),
	/** Where the segmentation model found the named element in this frame; display aids only. */
	regions: z.array(LocatedBoxSchema),
});

export const RecordingAnalysisSchema = z.object({
	id: idSchema("evd"),
	status: z.enum(["succeeded", "failed"]),
	model: z.string(),
	provider: z.string(),
	mode: z.enum(["live", "mock"]),
	placeholder_provider: z.boolean(),
	model_execution_id: idSchema("mex").nullable(),
	/** How many of the frames were read when the analysis ran. */
	frames_read: z.number().int().nonnegative(),
	output: RecordingAnalysisOutputSchema.nullable(),
	error: ErrorInfoSchema.nullable(),
	created_at: z.iso.datetime(),
});

export const RecordingStateSchema = z.object({
	recording_id: z.string(),
	name: z.string(),
	duration_ms: z.number().int().nonnegative(),
	/** Frames expected, as the browser announced them. */
	frame_count: z.number().int().positive(),
	status: z.enum(["receiving", "queued", "processing", "succeeded", "failed"]),
	error: ErrorInfoSchema.nullable(),
	frames: z.array(RecordingFrameStateSchema),
	/** The noun phrase the regions were searched for. */
	region_phrase: z.string().nullable(),
	analysis: RecordingAnalysisSchema.nullable(),
});

/** `GET /api/v1/bug-reports/{id}/recordings`. */
export const RecordingsResponseSchema = z.object({
	recordings: z.array(RecordingStateSchema),
});

export type RecordingState = z.infer<typeof RecordingStateSchema>;
export type RecordingAnalysis = z.infer<typeof RecordingAnalysisSchema>;
export type RecordingFrameState = z.infer<typeof RecordingFrameStateSchema>;
