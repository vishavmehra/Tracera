import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/http.ts";
import {
	assembleTranscript,
	checkTranscriptFile,
	decodeTranscript,
	MAX_SEGMENT_CHARS,
	MAX_SEGMENTS,
	parseTranscript,
	type TranscriptExtension,
} from "../src/modules/meeting-parse.ts";

const fixture = (name: string) =>
	readFileSync(new URL(`./fixtures/meetings/${name}`, import.meta.url));

/** Decode then parse, as the upload path does. */
const parse = (bytes: Uint8Array, extension: TranscriptExtension) =>
	parseTranscript(decodeTranscript(bytes).text, extension);

function rejection(run: () => unknown): { status: number; code: string } {
	try {
		run();
	} catch (error) {
		if (error instanceof AppError)
			return { status: error.status, code: error.code };
		throw error;
	}
	throw new Error("expected a rejection");
}

describe("WebVTT (Teams)", () => {
	it("keeps cue times and voice-tag speakers, skips NOTE blocks, decodes entities", () => {
		const parsed = parse(fixture("teams.vtt"), ".vtt");
		expect(parsed.format).toBe("webvtt");
		expect(parsed.timing).toBe("exact");
		expect(parsed.speakers).toEqual(["Priya Sharma", "Alex Kim", "Jordan Lee"]);
		expect(parsed.segments).toHaveLength(6);
		expect(parsed.segments[1]).toEqual({
			index: 2,
			speaker: "Alex Kim",
			startMs: 4900,
			endMs: 11_350,
			text: "I tested the cart this morning. When I add two items and apply the SAVE10 coupon, the total shows NaN instead of the discounted price.",
		});
		expect(parsed.segments[4]?.text).toContain("plan that & size it?");
		// A two-line cue is one segment.
		expect(parsed.segments[5]?.text).toBe(
			"Sure, let's discuss it on Thursday. And how was everyone's weekend?",
		);
		expect(parsed.durationMs).toBe(31_000);
		expect(parsed.warnings).toEqual([]);
	});

	it("splits a cue with several voices and handles hour-less timestamps", () => {
		const parsed = parse(
			Buffer.from(
				"WEBVTT\n\n01:02.500 --> 01:04.000\n<v.loud Ana>Is it fixed?</v> <v Ben>Not yet.</v>\n",
			),
			".vtt",
		);
		expect(
			parsed.segments.map(({ speaker, text, startMs }) => ({
				speaker,
				text,
				startMs,
			})),
		).toEqual([
			{ speaker: "Ana", text: "Is it fixed?", startMs: 62_500 },
			{ speaker: "Ben", text: "Not yet.", startMs: 62_500 },
		]);
	});

	it("skips malformed cues with a warning and keeps the rest", () => {
		const parsed = parse(fixture("malformed.vtt"), ".vtt");
		expect(parsed.segments.map((s) => s.text)).toEqual([
			"First cue is fine.",
			"Ends before it starts.",
		]);
		expect(parsed.segments[1]).toMatchObject({ startMs: 9000, endMs: null });
		expect(parsed.warnings).toHaveLength(3);
		expect(parsed.warnings.join("\n")).toMatch(/no valid timing/);
	});

	it("refuses a .vtt file without the WEBVTT header", () => {
		expect(
			rejection(() =>
				parse(Buffer.from("00:00:01.000 --> 00:00:02.000\nhello\n"), ".vtt"),
			),
		).toEqual({ status: 422, code: "transcript_invalid" });
	});

	it("strips markup inside cues", () => {
		const parsed = parse(
			Buffer.from(
				"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Kai><c.yellow>Click</c> <b>Save</b> &lt;twice&gt;</v>\n",
			),
			".vtt",
		);
		expect(parsed.segments[0]?.text).toBe("Click Save <twice>");
	});
});

describe("SRT", () => {
	it("parses cues, repeated name prefixes as speakers, and styling", () => {
		const parsed = parse(fixture("captions.srt"), ".srt");
		expect(parsed.format).toBe("srt");
		expect(parsed.speakers).toEqual(["Priya", "Alex"]);
		expect(parsed.segments[1]).toEqual({
			index: 2,
			speaker: "Alex",
			startMs: 4000,
			endMs: 9250,
			text: "Yes. The export button gives an empty CSV file when the date filter is set.",
		});
		expect(parsed.segments[3]?.text).toBe(
			"It started after Tuesday's release.",
		);
	});

	it("gives the same result with Windows line endings", () => {
		const lf = parse(fixture("captions.srt"), ".srt");
		const crlf = parse(
			Buffer.from(
				fixture("captions.srt").toString("utf8").replace(/\n/g, "\r\n"),
			),
			".srt",
		);
		expect(crlf).toEqual(lf);
	});

	it("refuses an .srt file without cue timings", () => {
		expect(
			rejection(() => parse(Buffer.from("just some words\n"), ".srt")),
		).toEqual({ status: 422, code: "transcript_invalid" });
	});
});

describe("speaker-line text (Google Meet export) and plain text", () => {
	it("reads the export header, block time markers, and speaker turns", () => {
		const parsed = parse(fixture("meet-export.txt"), ".txt");
		expect(parsed.format).toBe("speaker_text");
		expect(parsed.timing).toBe("block");
		expect(parsed.speakers).toEqual(["Priya Sharma", "Dana Cruz", "Alex Kim"]);
		expect(parsed.warnings).toEqual(["Skipped the 4-line export header"]);
		const [first, second, , , fifth, sixth, seventh] = parsed.segments;
		expect(first).toMatchObject({
			speaker: "Priya Sharma",
			startMs: 0,
			endMs: 300_000,
		});
		expect(second?.text).toMatch(/^The order summary card overflows/);
		expect(fifth).toMatchObject({
			speaker: "Alex Kim",
			startMs: 300_000,
			endMs: null,
		});
		// A wrapped line continues the turn; a one-off "Total:" prefix is text, not a speaker.
		expect(sixth?.text).toMatch(
			/after the last deploy, even on the newest build\.$/,
		);
		expect(seventh).toMatchObject({
			speaker: null,
			text: "Total: we have two bugs to file.",
		});
		// Meet's footer lines are not segments.
		expect(parsed.segments).toHaveLength(7);
	});

	it("treats unlabelled lines as one segment each", () => {
		const parsed = parse(fixture("plain.txt"), ".txt");
		expect(parsed).toMatchObject({
			format: "plain_text",
			timing: "none",
			durationMs: null,
			speakers: [],
		});
		expect(parsed.segments.map((s) => s.text)).toEqual([
			"Notes from the release sync",
			"The login page spinner never stops when the password is wrong.",
			"Search results are duplicated after paging back.",
		]);
	});

	it("does not mistake labels such as Error: for speakers", () => {
		const parsed = parse(
			Buffer.from(
				"Kim: the export fails\nError: Cannot read properties of undefined\nKim: every time\nError: again\n",
			),
			".txt",
		);
		expect(parsed.speakers).toEqual(["Kim"]);
		expect(parsed.segments[1]).toMatchObject({
			speaker: null,
			text: "Error: Cannot read properties of undefined",
		});
	});

	it("recognizes WebVTT content uploaded as .txt", () => {
		expect(parse(fixture("teams.vtt"), ".txt").format).toBe("webvtt");
	});
});

describe("decoding and content checks", () => {
	const text =
		"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Zoë>Größe stimmt nicht</v>\n";

	it("decodes UTF-8 with or without a byte-order mark and UTF-16 with one", () => {
		const utf8 = Buffer.from(text, "utf8");
		const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
		const le = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from(text, "utf16le"),
		]);
		const be = Buffer.from(le);
		be.swap16();
		for (const [bytes, encoding] of [
			[utf8, "utf-8"],
			[bom, "utf-8"],
			[le, "utf-16le"],
			[be, "utf-16be"],
		] as const) {
			const decoded = decodeTranscript(bytes);
			expect(decoded.encoding).toBe(encoding);
			expect(parseTranscript(decoded.text, ".vtt").segments[0]).toMatchObject({
				speaker: "Zoë",
				text: "Größe stimmt nicht",
			});
		}
	});

	it("refuses invalid UTF-8 and UTF-16 without a byte-order mark", () => {
		expect(
			rejection(() => decodeTranscript(Buffer.from([0x48, 0x69, 0xc3, 0x28]))),
		).toEqual({ status: 422, code: "transcript_encoding_invalid" });
		expect(
			rejection(() => decodeTranscript(Buffer.from(text, "utf16le"))),
		).toEqual({ status: 422, code: "transcript_encoding_invalid" });
	});

	it("refuses binary files, recordings, and markup documents", () => {
		const png = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
		]);
		const docx = Buffer.from("PK\u0003\u0004word/document.xml", "latin1");
		const mp4 = Buffer.concat([
			Buffer.from([0, 0, 0, 0x18]),
			Buffer.from("ftypmp42isom"),
		]);
		for (const bytes of [
			png,
			docx,
			mp4,
			Buffer.from("plain text with a NUL\u0000 byte"),
			Buffer.from("<!DOCTYPE html><html><body>hi</body></html>"),
			Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
		])
			expect(rejection(() => decodeTranscript(bytes))).toEqual({
				status: 415,
				code: "unsupported_media_type",
			});
	});

	it("checks size, extension, and declared type before reading", () => {
		const ok = { filename: "standup.VTT", contentType: "text/vtt", size: 10 };
		expect(checkTranscriptFile(ok)).toBe(".vtt");
		expect(
			checkTranscriptFile({ ...ok, filename: "c.srt", contentType: "" }),
		).toBe(".srt");
		expect(
			checkTranscriptFile({
				...ok,
				filename: "notes.txt",
				contentType: "text/plain; charset=utf-8",
			}),
		).toBe(".txt");
		expect(
			rejection(() =>
				checkTranscriptFile({ ...ok, size: 5 * 1024 * 1024 + 1 }),
			),
		).toEqual({ status: 413, code: "payload_too_large" });
		for (const bad of [
			{ ...ok, filename: "meeting.docx" },
			{ ...ok, filename: "recording.mp4", contentType: "video/mp4" },
			{ ...ok, filename: "page.vtt.html" },
			{ ...ok, contentType: "text/html" },
		])
			expect(rejection(() => checkTranscriptFile(bad))).toEqual({
				status: 415,
				code: "unsupported_media_type",
			});
	});

	it("refuses empty transcripts and too many segments; cuts oversized segments", () => {
		expect(rejection(() => parse(Buffer.from("WEBVTT\n\n"), ".vtt"))).toEqual({
			status: 422,
			code: "transcript_empty",
		});
		expect(rejection(() => parse(Buffer.from("\n \n"), ".txt"))).toEqual({
			status: 422,
			code: "transcript_empty",
		});
		const many = Array.from({ length: MAX_SEGMENTS + 1 }, () => ({
			speaker: null,
			startMs: null,
			endMs: null,
			text: "x",
		}));
		expect(
			rejection(() => assembleTranscript("plain_text", "none", many)),
		).toEqual({ status: 422, code: "transcript_too_many_segments" });
		const long = assembleTranscript("plain_text", "none", [
			{
				speaker: null,
				startMs: null,
				endMs: null,
				text: "y".repeat(MAX_SEGMENT_CHARS + 5),
			},
		]);
		expect(long.segments[0]?.text).toHaveLength(MAX_SEGMENT_CHARS);
		expect(long.warnings).toHaveLength(1);
	});
});
