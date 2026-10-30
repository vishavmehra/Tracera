import {
	DEFAULT_MAX_IMAGE_BYTES,
	type VisionImageMimeType,
} from "@tracera/contracts";

export { DEFAULT_MAX_IMAGE_BYTES };

/** One image attached to a user message: raw base64 (no `data:` prefix) and the type its bytes prove. */
export type ImagePart = { mimeType: VisionImageMimeType; data: string };

/** Bytes a caller wants the model to see; the declared type, when given, must agree with the bytes. */
export type ImageInput = { bytes: Uint8Array; declaredType?: string | null };

export class ImageError extends Error {
	readonly code: "image_empty" | "image_too_large" | "image_type_unsupported";

	constructor(code: ImageError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
	bytes.length >= offset + signature.length &&
	signature.every((byte, i) => bytes[offset + i] === byte);

/** The type named by the file's magic bytes; null for anything else (SVG, GIF, HTML, executables). */
export function sniffImageType(bytes: Uint8Array): VisionImageMimeType | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (
		startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
		startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
	)
		return "image/webp";
	return null;
}

/**
 * Checks an image before it leaves for a provider: png, jpeg, or webp only, by content and not by
 * file name or declared type, within the byte limit. Throws ImageError otherwise.
 */
export function prepareImage(
	input: ImageInput,
	maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ImagePart {
	if (input.bytes.length === 0)
		throw new ImageError("image_empty", "The image is empty");
	if (input.bytes.length > maxBytes)
		throw new ImageError(
			"image_too_large",
			`The image is ${input.bytes.length} bytes; the limit is ${maxBytes}`,
		);
	const mimeType = sniffImageType(input.bytes);
	const declared = input.declaredType?.split(";")[0]?.trim().toLowerCase();
	if (
		!mimeType ||
		(declared &&
			declared !== "application/octet-stream" &&
			declared !== mimeType)
	)
		throw new ImageError(
			"image_type_unsupported",
			"Only PNG, JPEG, and WebP images are accepted, and the content must match the declared type",
		);
	return { mimeType, data: Buffer.from(input.bytes).toString("base64") };
}
