import { describe, expect, it } from "vitest";
import {
	clockLabel,
	describeSampling,
	extractKeyframes,
	type FrameSource,
	keyframeTimes,
	type OpenFrameSource,
	RECORDING_LIMITS,
	RecordingError,
	validateRecording,
} from "../src/keyframes.ts";

// TEST DOUBLES ONLY: a frame source stands in for the browser's video element, which jsdom cannot play.

const bytes = (size: number, type: string) =>
	new Blob([new Uint8Array(size)], { type });

function source(
	durationSeconds: number,
	sizes: { png?: number; jpeg?: number } = {},
) {
	const taken: Array<{ seconds: number; type: string }> = [];
	let closed = 0;
	const open: OpenFrameSource = async () =>
		({
			durationSeconds,
			frameAt: async (seconds, format) => {
				taken.push({ seconds, type: format.type });
				return bytes(
					format.type === "image/png" ? (sizes.png ?? 100) : (sizes.jpeg ?? 50),
					format.type,
				);
			},
			close: () => {
				closed += 1;
			},
		}) satisfies FrameSource;
	return { open, taken, closed: () => closed };
}

const file = (type = "video/webm") =>
	new File([new Uint8Array(1000)], "demo.webm", { type });

describe("which frames are taken", () => {
	it("takes the first, the last, and ten evenly spaced frames between", () => {
		const times = keyframeTimes(7.5);
		expect(times).toHaveLength(RECORDING_LIMITS.innerFrames + 2);
		expect(times[0]).toBe(0);
		// The very end of a file often has no picture yet.
		expect(times.at(-1)).toBe(7.4);
		const gaps = times.slice(1).map((t, i) => t - (times[i] as number));
		for (const gap of gaps) expect(gap).toBeCloseTo(7.4 / 11, 2);
	});

	it("takes fewer frames from a short recording and one from an empty or unknown one", () => {
		expect(keyframeTimes(2)).toHaveLength(8);
		expect(keyframeTimes(0.3)).toEqual([0]);
		expect(keyframeTimes(0)).toEqual([0]);
		expect(keyframeTimes(Number.POSITIVE_INFINITY)).toEqual([0]);
		expect(keyframeTimes(Number.NaN)).toEqual([0]);
	});

	it("writes timestamps as minutes, seconds, and tenths", () => {
		expect(clockLabel(0)).toBe("0:00.0");
		expect(clockLabel(3.8)).toBe("0:03.8");
		expect(clockLabel(61.25)).toBe("1:01.3");
		// Rounding up must carry into the minute, never print 60 seconds.
		expect(clockLabel(59.96)).toBe("1:00.0");
	});

	it("says keyframes were analyzed at stated times, never that a video was watched", () => {
		const text = describeSampling([0, 3.8, 7.4]);
		expect(text).toBe(
			"Analyzed 3 keyframes sampled at these timestamps: 0:00.0, 0:03.8, 0:07.4. The video itself was not read, so what happened between frames is inferred.",
		);
		expect(text).not.toMatch(/watched/i);
		expect(describeSampling([0])).toContain("Analyzed 1 keyframe sampled");
	});
});

describe("which recordings are accepted", () => {
	it.each([
		[{ type: "video/webm", size: 10 }, null],
		[{ type: "video/mp4", size: 10 }, null],
		[{ type: "video/quicktime", size: 10 }, null],
		[
			{ type: "image/png", size: 10 },
			"Use a video file such as WebM, MP4, or MOV.",
		],
		[{ type: "", size: 10 }, "Use a video file such as WebM, MP4, or MOV."],
		[{ type: "video/webm", size: 0 }, "The file is empty."],
		[
			{ type: "video/webm", size: 201 * 1024 * 1024 },
			"The recording is 201.0 MB; the limit is 200.0 MB.",
		],
	])("checks %j", (candidate, expected) => {
		expect(validateRecording(candidate)).toBe(expected);
	});

	it("refuses a recording over 200 MB before opening it", async () => {
		const big = file();
		Object.defineProperty(big, "size", { value: 201 * 1024 * 1024 });
		const { open, closed } = source(5);
		await expect(extractKeyframes(big, { open })).rejects.toMatchObject({
			code: "too_large",
		});
		expect(closed()).toBe(0);
	});

	it("refuses a recording longer than five minutes without taking a frame", async () => {
		const { open, taken, closed } = source(301);
		const error = await extractKeyframes(file(), { open }).catch((e) => e);
		expect(error).toBeInstanceOf(RecordingError);
		expect(error).toMatchObject({
			code: "too_long",
			message: "The recording is 5:01.0 long; the limit is 5:00.0.",
		});
		expect(taken).toHaveLength(0);
		expect(closed()).toBe(1);
		const exactly = source(300);
		await expect(
			extractKeyframes(file(), { open: exactly.open }),
		).resolves.toMatchObject({ durationMs: 300_000 });
	});
});

describe("taking the frames", () => {
	it("takes twelve PNG frames with their timestamps, reports progress, and closes the recording", async () => {
		const { open, taken, closed } = source(7.5);
		const progress: Array<[number, number]> = [];
		const result = await extractKeyframes(file(), {
			open,
			onProgress: (done, total) => progress.push([done, total]),
		});
		expect(result.durationMs).toBe(7500);
		expect(result.frames).toHaveLength(12);
		expect(result.frames.map((f) => f.index)).toEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
		]);
		expect(result.frames[0]).toMatchObject({
			timestampMs: 0,
			mimeType: "image/png",
		});
		expect(result.frames[11]?.timestampMs).toBe(7400);
		for (const frame of result.frames)
			expect(Number.isInteger(frame.timestampMs)).toBe(true);
		expect(taken.every((t) => t.type === "image/png")).toBe(true);
		expect(progress.at(0)).toEqual([1, 12]);
		expect(progress.at(-1)).toEqual([12, 12]);
		expect(closed()).toBe(1);
	});

	it("sends a frame as a JPEG when its PNG is too large, and refuses one that is too large either way", async () => {
		const jpeg = await extractKeyframes(file(), {
			open: source(1, { png: 5 * 1024 * 1024, jpeg: 1000 }).open,
		});
		expect(jpeg.frames.every((f) => f.mimeType === "image/jpeg")).toBe(true);
		const { open, closed } = source(1, {
			png: 5 * 1024 * 1024,
			jpeg: 5 * 1024 * 1024,
		});
		await expect(extractKeyframes(file(), { open })).rejects.toMatchObject({
			code: "frame_too_large",
		});
		expect(closed()).toBe(1);
	});

	it("stops when it is cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const { open, taken, closed } = source(5);
		await expect(
			extractKeyframes(file(), { open, signal: controller.signal }),
		).rejects.toMatchObject({ code: "aborted" });
		expect(taken).toHaveLength(0);
		expect(closed()).toBe(1);
	});
});
