import {
	type RecordingAnalysis,
	type RecordingAnalysisOutput,
	RecordingAnalysisOutputSchema,
	RecordingFrameTagSchema,
	ScreenshotEvidenceMetaSchema,
} from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import {
	analyzeRecordingTask,
	buildRecordingInput,
} from "../src/inference/tasks.ts";
import {
	cleanAnalysis,
	howSeen,
	pickEvenly,
	renderRecordingInferred,
	renderRecordingObserved,
} from "../src/modules/visual-recording.ts";

describe("recording keyframe tags", () => {
	const tag = {
		recording_id: "rec_abcdefgh1234",
		name: "demo.webm",
		index: 2,
		count: 5,
		timestamp_ms: 4500,
		duration_ms: 9000,
	};
	const meta = (source_recording: unknown) =>
		ScreenshotEvidenceMetaSchema.safeParse({
			kind: "screenshot",
			source_recording,
		});

	it("rides in the meta of the screenshot upload and bounds every field", () => {
		const parsed = meta(tag);
		expect(parsed.success && parsed.data.source_recording).toEqual(tag);
		expect(
			RecordingFrameTagSchema.parse({ ...tag, name: undefined }).name,
		).toBe("");
		for (const bad of [
			{ count: 13 },
			{ index: 12 },
			{ index: -1 },
			{ index: 5 },
			{ recording_id: "short" },
			{ recording_id: "has space in it" },
			{ timestamp_ms: 1.5 },
			{ timestamp_ms: "4500" },
			{ elsewhere: true },
		])
			expect(meta({ ...tag, ...bad }).success).toBe(false);
	});

	it("picks evenly spaced frames, the first and the last included", () => {
		const items = Array.from({ length: 12 }, (_, i) => i);
		expect(pickEvenly(items, 6)).toEqual([0, 2, 4, 7, 9, 11]);
		expect(pickEvenly([1, 2, 3], 6)).toEqual([1, 2, 3]);
		expect(pickEvenly(items, 2)).toEqual([0, 11]);
	});
});

describe("recording analysis input", () => {
	it("gives every frame reading its own untrusted block and says which frames could not be read", () => {
		const text = buildRecordingInput({
			durationSeconds: 7.5,
			frames: [
				{ index: 0, timestampSeconds: 0, reading: "Summary: a cart" },
				{
					index: 1,
					timestampSeconds: 3.8,
					reading: null,
					unreadReason: "provider_bad_request",
				},
			],
		});
		expect(text).toContain(
			"2 keyframes sampled evenly from a 7.5 second screen recording",
		);
		expect(text).toContain("You do not have the recording itself");
		expect(text).toContain(
			'<untrusted source="FRAME-1" kind="frame_reading" time="0.0 s">\nSummary: a cart\n</untrusted>',
		);
		expect(text).toContain(
			"Frame 2 at 3.8 s could not be read (provider_bad_request)",
		);
	});

	it("has a strict text-only task that never lets the model claim to have watched the video", () => {
		expect(analyzeRecordingTask.name).toBe("analyze_recording");
		expect(JSON.stringify(analyzeRecordingTask.jsonSchema)).toContain(
			'"additionalProperties":false',
		);
		expect(analyzeRecordingTask.systemPrompt).toContain(
			"never see the recording itself",
		);
		expect(analyzeRecordingTask.systemPrompt).toContain(
			"Never say that anyone watched the recording",
		);
		const output = {
			summary: "s",
			timeline: [
				{ timestamp_seconds: null, statement: "x", basis: "inferred" },
			],
			error_messages: [],
			failing_element: null,
			reproduction_steps: [],
			missing_information: [],
		};
		expect(RecordingAnalysisOutputSchema.safeParse(output).success).toBe(true);
		expect(
			RecordingAnalysisOutputSchema.safeParse({
				...output,
				timeline: [{ ...output.timeline[0], basis: "observed" }],
			}).success,
		).toBe(false);
	});

	it("words what was sent as keyframes at stated times, never as a watched video", () => {
		const text = howSeen([0, 3.8, 7.4]);
		expect(text).toBe(
			"Analyzed 3 keyframes sampled at these timestamps: 0:00.0, 0:03.8, 0:07.4. The video itself was not read, so what happened between frames is inferred.",
		);
		expect(text).not.toMatch(/watched/i);
	});
});

describe("recording timeline", () => {
	const output: RecordingAnalysisOutput = {
		summary: "The total turns into NaN.",
		timeline: [
			{
				timestamp_seconds: 6,
				statement: "The total reads NaN",
				basis: "visible",
			},
			{ timestamp_seconds: 0, statement: "A $49.60 total", basis: "visible" },
			{
				timestamp_seconds: 3,
				statement: "A user clicked Apply",
				basis: "inferred",
			},
			{ timestamp_seconds: 900, statement: "Past the end", basis: "visible" },
			{
				timestamp_seconds: -2,
				statement: "Before the start",
				basis: "inferred",
			},
		],
		error_messages: [
			{ text: "Error: coupon rejected", timestamp_seconds: 3 },
			{ text: "Error: later", timestamp_seconds: 7.9 },
		],
		failing_element:
			"  red <b>banner</b>\n\u0007 with   extra words that run on and on and on and on and on and on and on  ",
		reproduction_steps: [{ step: "Open the checkout page" }],
		missing_information: ["What happened between frames"],
	};
	const analysis = (mode: "live" | "mock"): RecordingAnalysis => ({
		id: "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B4F",
		status: "succeeded",
		model: "muse-spark-1.3",
		provider: "meta",
		mode,
		placeholder_provider: false,
		model_execution_id: null,
		frames_read: 3,
		output,
		error: null,
		created_at: "2026-01-01T00:00:00.000Z",
	});

	it("keeps only times inside the recording and a clean, short phrase for the segmentation model", () => {
		const cleaned = cleanAnalysis(output, 7.5, false).output;
		expect(cleaned.timeline.map((e) => e.timestamp_seconds)).toEqual([
			6,
			0,
			3,
			null,
			null,
		]);
		// A frame one second past the stated length is still the end of it.
		expect(cleaned.error_messages.map((e) => e.timestamp_seconds)).toEqual([
			3, 7.9,
		]);
		expect(cleaned.failing_element).toBe(
			"red b banner /b with extra words that run on and on and on and on and on and on and on"
				.slice(0, 80)
				.trim(),
		);
		expect(cleaned.failing_element?.length).toBeLessThanOrEqual(80);
		expect(cleaned.failing_element).not.toMatch(/[<>\n]/);
	});

	it("redacts a secret that the frames showed before anything is stored", () => {
		const leaked = {
			...output,
			summary: "Signed in as ada@example.com with sk-live-abcdefghijklmnop1234",
		};
		const cleaned = cleanAnalysis(leaked, 7.5, true);
		expect(cleaned.output.summary).not.toContain("ada@example.com");
		expect(cleaned.output.summary).not.toContain(
			"sk-live-abcdefghijklmnop1234",
		);
		expect(cleaned.count).toBeGreaterThan(0);
	});

	it("puts what a frame states in the observed text and what is guessed in the inferred text, each in time order", () => {
		const seconds = [0, 3, 6];
		const observed = renderRecordingObserved(analysis("live"), output, seconds);
		const inferred = renderRecordingInferred(analysis("live"), output, seconds);
		expect(observed).toContain("[live]");
		expect(observed).toContain(
			"Analyzed 3 keyframes sampled at these timestamps",
		);
		expect(observed).toContain("[0:06.0] The total reads NaN");
		expect(observed).not.toContain("A user clicked Apply");
		expect(observed).toContain("Element that looks wrong: red");
		expect(inferred).toContain("[0:03.0] A user clicked Apply");
		expect(inferred).toContain("1. Open the checkout page");
		expect(inferred).toContain(
			"None of this is directly visible and none of it has been verified",
		);
		expect(inferred).not.toContain("The total reads NaN");
		for (const text of [observed, inferred])
			expect(text).not.toMatch(/watched|confirmed|verified a fix/i);
	});

	it("labels a mock analysis as a mock", () => {
		expect(renderRecordingObserved(analysis("mock"), output, [0])).toContain(
			"[mock]",
		);
	});
});
