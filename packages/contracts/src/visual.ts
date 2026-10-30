import { z } from "zod";
import { ConfidenceSchema } from "./analysis.ts";
import { idSchema } from "./common.ts";

/** Image types the vision task accepts; the stored type is the one named by the file's magic bytes. */
export const VISION_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
] as const;
export type VisionImageMimeType = (typeof VISION_IMAGE_MIME_TYPES)[number];

/** Default for TRACERA_MAX_IMAGE_BYTES. */
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const located = z.object({
	text: z.string().max(1000),
	location: z.string().max(300),
});

/**
 * Structured output of task observe_screenshot. Four kinds of claim stay in four places: what is
 * visible (`visible_text`, `error_messages`, `ui_elements`, `observed_failure`, `observations`), what the
 * model infers (`inferences`), and what it could not tell (`missing_information`). Repository facts and
 * executed checks never come from this task.
 */
export const ScreenshotObservationOutputSchema = z.object({
	summary: z.string().max(2000),
	visible_text: z.array(located).max(200),
	error_messages: z.array(located).max(40),
	ui_elements: z
		.array(
			z.object({
				kind: z.string().max(80),
				label: z.string().max(300),
				state: z.string().max(300).nullable(),
				location: z.string().max(300),
			}),
		)
		.max(80),
	observed_failure: z.string().max(1500).nullable(),
	observations: z
		.array(
			z.object({ statement: z.string().max(1000), basis: z.enum(["visible"]) }),
		)
		.max(60),
	inferences: z
		.array(
			z.object({
				statement: z.string().max(1000),
				confidence: ConfidenceSchema,
			}),
		)
		.max(30),
	missing_information: z.array(z.string().max(600)).max(30),
});
export type ScreenshotObservationOutput = z.infer<
	typeof ScreenshotObservationOutputSchema
>;

/** Where one observation came from. `mode` is `mock` only when the mock adapter produced it. */
export const ObservationProvenanceSchema = z.object({
	task: z.literal("observe_screenshot"),
	prompt_version: z.string(),
	model: z.string(),
	provider: z.string(),
	mode: z.enum(["live", "mock"]),
	/** True when the provider is not Meta's own API (the same rule as the investigation flag). */
	placeholder_provider: z.boolean(),
	model_execution_id: idSchema("mex").nullable(),
	source_evidence_id: idSchema("evd"),
	source_sha256: z.string(),
	redaction_count: z.number().int().nonnegative(),
});

const ErrorInfoSchema = z.object({ code: z.string(), message: z.string() });

export const EvidenceObservationSchema = z.object({
	/** The derived evidence asset that stores this observation. */
	id: idSchema("evd"),
	status: z.enum(["succeeded", "failed"]),
	provenance: ObservationProvenanceSchema,
	output: ScreenshotObservationOutputSchema.nullable(),
	error: ErrorInfoSchema.nullable(),
	created_at: z.iso.datetime(),
});

/** `GET /api/v1/evidence/{id}/observations`: newest first; the first succeeded entry is the one in use. */
export const EvidenceObservationsResponseSchema = z.object({
	evidence_id: idSchema("evd"),
	kind: z.string(),
	mime_type: z.string(),
	observations: z.array(EvidenceObservationSchema),
});

export type ObservationProvenance = z.infer<typeof ObservationProvenanceSchema>;
export type EvidenceObservation = z.infer<typeof EvidenceObservationSchema>;
export type EvidenceObservationsResponse = z.infer<
	typeof EvidenceObservationsResponseSchema
>;

/** `POST /api/v1/evidence/{id}/locate`: a short noun phrase for the element, such as "button" or "table". */
export const LocateRequestSchema = z.strictObject({
	phrase: z.string().trim().min(1).max(80),
});
export type LocateRequest = z.infer<typeof LocateRequestSchema>;

/** A region in pixels of the screenshot it was found in; x2 and y2 are inclusive. */
export const LocatedBoxSchema = z.object({
	x1: z.number().int().nonnegative(),
	y1: z.number().int().nonnegative(),
	x2: z.number().int().nonnegative(),
	y2: z.number().int().nonnegative(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	confidence: z.number().min(0).max(1).nullable(),
});

export const LocationProvenanceSchema = z.object({
	task: z.literal("locate_ui_element"),
	prompt_version: z.string(),
	model: z.string(),
	provider: z.string(),
	mode: z.enum(["live", "mock"]),
	placeholder_provider: z.boolean(),
	model_execution_id: idSchema("mex").nullable(),
	source_evidence_id: idSchema("evd"),
	source_sha256: z.string(),
	phrase: z.string(),
});

/** One AI-located region set. No boxes means the model found nothing for the phrase. It is a display aid, never evidence. */
export const EvidenceLocationSchema = z.object({
	id: idSchema("evd"),
	phrase: z.string(),
	status: z.enum(["succeeded", "failed"]),
	provenance: LocationProvenanceSchema,
	boxes: z.array(LocatedBoxSchema),
	error: ErrorInfoSchema.nullable(),
	created_at: z.iso.datetime(),
});

/** `GET /api/v1/evidence/{id}/locations`, newest first. */
export const EvidenceLocationsResponseSchema = z.object({
	evidence_id: idSchema("evd"),
	locations: z.array(EvidenceLocationSchema),
});

export type LocatedBox = z.infer<typeof LocatedBoxSchema>;
export type LocationProvenance = z.infer<typeof LocationProvenanceSchema>;
export type EvidenceLocation = z.infer<typeof EvidenceLocationSchema>;
export type EvidenceLocationsResponse = z.infer<
	typeof EvidenceLocationsResponseSchema
>;
