import { describe, expect, it } from "vitest";
import {
	ANNOTATION_RGB,
	type Mark,
	type Rgba,
	regionToImageRect,
	renderMarks,
	toPixelRect,
} from "../src/image.ts";

/** A deterministic, never-black test image: every pixel differs from its neighbours. */
function pattern(width: number, height: number): Rgba {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data[i * 4] = 50 + (i % 200);
		data[i * 4 + 1] = 60 + ((i * 7) % 190);
		data[i * 4 + 2] = 70 + ((i * 13) % 180);
		data[i * 4 + 3] = 255;
	}
	return { width, height, data };
}

const pixel = (image: Rgba, x: number, y: number) =>
	Array.from(
		image.data.subarray(
			(y * image.width + x) * 4,
			(y * image.width + x) * 4 + 4,
		),
	);
const inside = (
	r: { x: number; y: number; width: number; height: number },
	x: number,
	y: number,
) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

describe("toPixelRect", () => {
	it.each([
		[
			"a plain rectangle",
			{ x: 2, y: 3, width: 4, height: 5 },
			{ x: 2, y: 3, width: 4, height: 5 },
		],
		[
			"rounded outward",
			{ x: 1.6, y: 2.2, width: 2.1, height: 0.5 },
			{ x: 1, y: 2, width: 3, height: 1 },
		],
		[
			"dragged up and left",
			{ x: 8, y: 9, width: -3, height: -4 },
			{ x: 5, y: 5, width: 3, height: 4 },
		],
		[
			"clipped to the image",
			{ x: -5, y: 15, width: 10, height: 20 },
			{ x: 0, y: 15, width: 5, height: 5 },
		],
	])("%s", (_, rect, expected) => {
		expect(toPixelRect(rect, 20, 20)).toEqual(expected);
	});

	it.each([
		["empty", { x: 3, y: 3, width: 0, height: 4 }],
		["outside", { x: 25, y: 1, width: 4, height: 4 }],
		["not a number", { x: Number.NaN, y: 1, width: 4, height: 4 }],
	])("returns null when %s", (_, rect) => {
		expect(toPixelRect(rect, 20, 20)).toBeNull();
	});
});

describe("regionToImageRect", () => {
	it("maps CSS pixels onto the captured image using its real size (DPR and zoom)", () => {
		expect(
			regionToImageRect(
				{ x: 100, y: 50, width: 200, height: 100.3 },
				{ width: 1280, height: 720 },
				{ width: 2560, height: 1440 },
			),
		).toEqual({ x: 200, y: 100, width: 400, height: 201 });
	});
});

describe("renderMarks (redaction burned into the pixels)", () => {
	const base = pattern(40, 30);
	const original = new Uint8ClampedArray(base.data);
	const redact = { x: 5, y: 4, width: 10, height: 6 };
	const box = { x: 20, y: 10, width: 15, height: 12 };
	const marks: Mark[] = [
		{ kind: "redact", rect: redact },
		{ kind: "box", rect: box },
	];
	const out = renderMarks(base, marks);

	it("leaves no original pixel inside a redaction and changes nothing outside the marks", () => {
		for (let y = 0; y < base.height; y++)
			for (let x = 0; x < base.width; x++) {
				if (inside(redact, x, y))
					expect(pixel(out, x, y)).toEqual([0, 0, 0, 255]);
				else if (!inside(box, x, y))
					expect(pixel(out, x, y)).toEqual(pixel(base, x, y));
			}
	});

	it("draws an annotation outline and keeps its interior", () => {
		expect(pixel(out, box.x, box.y + 5)).toEqual([...ANNOTATION_RGB, 255]);
		expect(pixel(out, box.x + box.width - 1, box.y + 5)).toEqual([
			...ANNOTATION_RGB,
			255,
		]);
		expect(pixel(out, box.x + 7, box.y + 6)).toEqual(
			pixel(base, box.x + 7, box.y + 6),
		);
	});

	it("never modifies the base image, so undo can start again from it", () => {
		expect(base.data).toEqual(original);
		expect(out.data.buffer).not.toBe(base.data.buffer);
	});

	it("keeps a redaction black where an outline crosses it, in any order", () => {
		const overlap = { x: 0, y: 0, width: 20, height: 20 };
		for (const order of [
			[
				{ kind: "redact", rect: overlap },
				{ kind: "box", rect: { x: 0, y: 0, width: 30, height: 30 } },
			],
			[
				{ kind: "box", rect: { x: 0, y: 0, width: 30, height: 30 } },
				{ kind: "redact", rect: overlap },
			],
		] as Mark[][]) {
			const image = renderMarks(base, order);
			for (let y = 0; y < 20; y++)
				for (let x = 0; x < 20; x++)
					expect(pixel(image, x, y)).toEqual([0, 0, 0, 255]);
		}
	});

	it("covers a full-size capture quickly enough to re-render on every mark", () => {
		const large = pattern(2560, 1440);
		const started = performance.now();
		const image = renderMarks(large, [
			{ kind: "redact", rect: { x: 0, y: 0, width: 2560, height: 1440 } },
		]);
		expect(performance.now() - started).toBeLessThan(500);
		expect(image.data.some((value, i) => i % 4 !== 3 && value !== 0)).toBe(
			false,
		);
	});
});
