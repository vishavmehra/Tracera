import type { PixelRect } from "@tracera/contracts";

export type Rect = { x: number; y: number; width: number; height: number };
export type MarkKind = "box" | "redact";
export type Mark = { kind: MarkKind; rect: PixelRect };
/** RGBA pixels, row-major, 4 bytes per pixel (the layout of ImageData). */
export type Rgba = {
	width: number;
	height: number;
	data: Uint8ClampedArray<ArrayBuffer>;
};

const BLACK = [0, 0, 0] as const;
/** Annotation outline; reads on light and dark pages. */
export const ANNOTATION_RGB = [255, 59, 107] as const;

/**
 * The whole-pixel rectangle covering `rect` (drawn in any direction), rounded outward so no partly
 * covered pixel escapes a redaction, and clipped to the image. Null when nothing is left.
 */
export function toPixelRect(
	rect: Rect,
	width: number,
	height: number,
): PixelRect | null {
	const left = Math.max(0, Math.floor(Math.min(rect.x, rect.x + rect.width)));
	const top = Math.max(0, Math.floor(Math.min(rect.y, rect.y + rect.height)));
	const right = Math.min(
		width,
		Math.ceil(Math.max(rect.x, rect.x + rect.width)),
	);
	const bottom = Math.min(
		height,
		Math.ceil(Math.max(rect.y, rect.y + rect.height)),
	);
	if (!(right > left && bottom > top)) return null; // also false for NaN
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A region selected in CSS pixels of the viewport, mapped onto the captured image (zoom and DPR included). */
export function regionToImageRect(
	region: Rect,
	viewport: { width: number; height: number },
	image: { width: number; height: number },
): PixelRect | null {
	const sx = image.width / viewport.width;
	const sy = image.height / viewport.height;
	return toPixelRect(
		{
			x: region.x * sx,
			y: region.y * sy,
			width: region.width * sx,
			height: region.height * sy,
		},
		image.width,
		image.height,
	);
}

/** Opaque fill, one row at a time through a 32-bit view (byte order follows the platform's). */
function fill(
	image: Rgba,
	rect: PixelRect | null,
	rgb: readonly [number, number, number],
) {
	if (!rect) return;
	const pixel = new Uint32Array(
		new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]).buffer,
	)[0] as number;
	const pixels = new Uint32Array(
		image.data.buffer,
		image.data.byteOffset,
		image.width * image.height,
	);
	for (let y = rect.y; y < rect.y + rect.height; y++) {
		const row = y * image.width;
		pixels.fill(pixel, row + rect.x, row + rect.x + rect.width);
	}
}

/**
 * The pixels that are uploaded: annotation outlines first, then redactions, so a blacked-out area stays
 * black even where an outline crosses it. Returns a new image; `base` is left intact (undo needs it).
 */
export function renderMarks(base: Rgba, marks: readonly Mark[]): Rgba {
	const out: Rgba = {
		width: base.width,
		height: base.height,
		data: new Uint8ClampedArray(base.data),
	};
	const clip = (rect: Rect) => toPixelRect(rect, out.width, out.height);
	const t = Math.max(2, Math.round(Math.max(out.width, out.height) / 500));
	for (const { kind, rect } of marks) {
		if (kind !== "box") continue;
		const { x, y, width, height } = rect;
		fill(
			out,
			clip({ x, y, width, height: Math.min(t, height) }),
			ANNOTATION_RGB,
		);
		fill(
			out,
			clip({ x, y: y + height - t, width, height: Math.min(t, height) }),
			ANNOTATION_RGB,
		);
		fill(
			out,
			clip({ x, y, width: Math.min(t, width), height }),
			ANNOTATION_RGB,
		);
		fill(
			out,
			clip({ x: x + width - t, y, width: Math.min(t, width), height }),
			ANNOTATION_RGB,
		);
	}
	for (const { kind, rect } of marks)
		if (kind === "redact") fill(out, clip(rect), BLACK);
	return out;
}
