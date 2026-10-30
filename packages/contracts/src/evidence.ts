import { z } from "zod";

/** Images accepted as evidence. The stored type comes from the file's magic bytes, never the client. */
export const IMAGE_EVIDENCE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
] as const;
export const MAX_IMAGE_EVIDENCE_BYTES = 10 * 1024 * 1024;

/** A rectangle in pixels of the uploaded image. */
export const PixelRectSchema = z.strictObject({
	x: z.number().int().min(0).max(100_000),
	y: z.number().int().min(0).max(100_000),
	width: z.number().int().min(1).max(100_000),
	height: z.number().int().min(1).max(100_000),
});

/**
 * The `meta` part of `POST /api/v1/bug-reports/{id}/evidence`. Screenshots only so far; recordings
 * and log files are not supported yet. Every field is client-reported.
 */
export const ScreenshotEvidenceMetaSchema = z.strictObject({
	kind: z.literal("screenshot"),
	captured_at: z.iso.datetime().optional(),
	page_url: z
		.string()
		.trim()
		.max(2048)
		.pipe(z.url({ protocol: /^https?$/ }))
		.optional(),
	page_title: z.string().trim().max(300).optional(),
	viewport: z
		.strictObject({
			width: z.number().int().min(1).max(20_000),
			height: z.number().int().min(1).max(20_000),
		})
		.optional(),
	device_pixel_ratio: z.number().min(0.1).max(10).optional(),
	/** Regions the client blacked out in the pixels before upload (the server cannot check this). */
	client_redactions: z.array(PixelRectSchema).max(100).optional(),
	/** Outlines the user drew: marks in the image, not page content. */
	client_annotations: z.array(PixelRectSchema).max(100).optional(),
});

export type PixelRect = z.infer<typeof PixelRectSchema>;
export type ScreenshotEvidenceMeta = z.infer<
	typeof ScreenshotEvidenceMetaSchema
>;
export type ImageEvidenceMimeType = (typeof IMAGE_EVIDENCE_MIME_TYPES)[number];
