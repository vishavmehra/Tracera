import {
	TRANSCRIPT_CONTENT_TYPES,
	TRANSCRIPT_EXTENSIONS,
	TRANSCRIPT_MAX_BYTES,
	type TranscriptEncoding,
	type TranscriptFormat,
	type TranscriptTiming,
} from "@tracera/contracts";
import { AppError } from "../lib/http.ts";

// The shared meeting engine's parsers: bytes → text → segments. Pure and deterministic, with
// no I/O and no provider knowledge. Provider adapters either hand their files to parseTranscript or
// map their structured artifacts through assembleTranscript, so every source yields the same shape.

export type TranscriptExtension = (typeof TRANSCRIPT_EXTENSIONS)[number];
export type ParsedSegment = {
	index: number;
	speaker: string | null;
	startMs: number | null;
	endMs: number | null;
	text: string;
};
export type ParsedTranscript = {
	format: TranscriptFormat;
	timing: TranscriptTiming;
	segments: ParsedSegment[];
	speakers: string[];
	durationMs: number | null;
	warnings: string[];
};
type RawSegment = Omit<ParsedSegment, "index">;

export const MAX_SEGMENTS = 20_000;
export const MAX_SEGMENT_CHARS = 20_000;
const MAX_WARNINGS = 20;

/** Size, extension, and declared type of an upload; returns the extension that selects the parser. */
export function checkTranscriptFile(file: {
	filename: string;
	contentType: string;
	size: number;
}): TranscriptExtension {
	if (file.size > TRANSCRIPT_MAX_BYTES)
		throw new AppError(
			413,
			"payload_too_large",
			`Transcripts are limited to ${TRANSCRIPT_MAX_BYTES} bytes`,
		);
	const extension = file.filename.toLowerCase().match(/\.[a-z0-9]{1,10}$/)?.[0];
	const declared = file.contentType.split(";")[0]?.trim() ?? "";
	if (
		!(TRANSCRIPT_EXTENSIONS as readonly string[]).includes(extension ?? "") ||
		!(TRANSCRIPT_CONTENT_TYPES as readonly string[]).includes(declared)
	)
		throw new AppError(
			415,
			"unsupported_media_type",
			"Upload a .vtt, .srt, or .txt transcript; recordings and .docx files are not supported",
		);
	return extension as TranscriptExtension;
}

// Recognized by signature only to explain a rejection; acceptance never depends on this list.
const SIGNATURES: Array<{ bytes: number[]; offset?: number; what: string }> = [
	{ bytes: [0x50, 0x4b, 0x03, 0x04], what: "a ZIP archive or .docx document" },
	{ bytes: [0xd0, 0xcf, 0x11, 0xe0], what: "a legacy Office document" },
	{ bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], what: "a PDF document" },
	{ bytes: [0x89, 0x50, 0x4e, 0x47], what: "a PNG image" },
	{ bytes: [0xff, 0xd8, 0xff], what: "a JPEG image" },
	{ bytes: [0x47, 0x49, 0x46, 0x38], what: "a GIF image" },
	{ bytes: [0x4d, 0x5a], what: "a Windows executable" },
	{ bytes: [0x7f, 0x45, 0x4c, 0x46], what: "an ELF executable" },
	{ bytes: [0x1f, 0x8b], what: "a gzip archive" },
	{ bytes: [0x52, 0x49, 0x46, 0x46], what: "a RIFF recording (WAV, AVI)" },
	{ bytes: [0x1a, 0x45, 0xdf, 0xa3], what: "a WebM or Matroska recording" },
	{ bytes: [0x49, 0x44, 0x33], what: "an MP3 recording" },
	{ bytes: [0x4f, 0x67, 0x67, 0x53], what: "an Ogg recording" },
	{
		bytes: [0x66, 0x74, 0x79, 0x70],
		offset: 4,
		what: "an MP4, M4A, or MOV recording",
	},
];

function binaryKind(bytes: Uint8Array): string | null {
	const match = SIGNATURES.find(({ bytes: signature, offset = 0 }) =>
		signature.every((byte, i) => bytes[offset + i] === byte),
	);
	return match?.what ?? null;
}

function bomEncoding(bytes: Uint8Array): TranscriptEncoding | null {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
		return "utf-8";
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	return null;
}

/** ASCII text saved as UTF-16 without a byte-order mark has a zero in every other byte. */
function looksLikeUtf16WithoutBom(bytes: Uint8Array): boolean {
	const sample = Math.min(bytes.length, 64) & ~1;
	if (sample < 8) return false;
	let even = 0;
	let odd = 0;
	for (let i = 0; i < sample; i++)
		if (bytes[i] === 0) i % 2 === 0 ? even++ : odd++;
	return Math.max(even, odd) >= (sample / 2) * 0.75;
}

/** C0 controls other than tab, line feed, vertical tab, form feed, and carriage return; and DEL. */
function hasControlCharacters(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if ((code < 0x20 && (code < 0x09 || code > 0x0d)) || code === 0x7f)
			return true;
	}
	return false;
}

/**
 * Decodes an uploaded transcript: UTF-8 (with or without a byte-order mark) or UTF-16 with one.
 * Binary content and markup documents are refused; line endings become "\n".
 */
export function decodeTranscript(bytes: Uint8Array): {
	text: string;
	encoding: TranscriptEncoding;
} {
	const encoding = bomEncoding(bytes) ?? "utf-8";
	let text: string;
	try {
		// A matching byte-order mark is removed by the decoder.
		text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
	} catch {
		const kind = binaryKind(bytes);
		if (kind)
			throw new AppError(
				415,
				"unsupported_media_type",
				`The file looks like ${kind}, not a text transcript`,
			);
		throw new AppError(
			422,
			"transcript_encoding_invalid",
			"The transcript must be UTF-8, or UTF-16 with a byte-order mark",
		);
	}
	if (hasControlCharacters(text)) {
		if (encoding === "utf-8" && looksLikeUtf16WithoutBom(bytes))
			throw new AppError(
				422,
				"transcript_encoding_invalid",
				"UTF-16 without a byte-order mark is not supported; save the transcript as UTF-8",
			);
		throw new AppError(
			415,
			"unsupported_media_type",
			`The file looks like ${binaryKind(bytes) ?? "binary data"}, not a text transcript`,
		);
	}
	if (/^\s*<(?:!doctype\s+html|html|svg|\?xml|script)\b/i.test(text))
		throw new AppError(
			415,
			"unsupported_media_type",
			"HTML, SVG, and XML documents are not transcripts",
		);
	return { text: text.replace(/\r\n?/g, "\n"), encoding };
}

/**
 * Builds the normalized transcript every source shares: whitespace collapsed, empty segments dropped,
 * 1-based indexes, at most MAX_SEGMENTS segments of at most MAX_SEGMENT_CHARS characters.
 */
export function assembleTranscript(
	format: TranscriptFormat,
	timing: TranscriptTiming,
	raw: readonly RawSegment[],
	notes: readonly string[] = [],
): ParsedTranscript {
	const warnings = [...notes];
	const segments: ParsedSegment[] = [];
	for (const item of raw) {
		let text = item.text.replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (segments.length === MAX_SEGMENTS)
			throw new AppError(
				422,
				"transcript_too_many_segments",
				`The transcript has more than ${MAX_SEGMENTS} segments`,
			);
		if (text.length > MAX_SEGMENT_CHARS) {
			warnings.push(
				`Segment ${segments.length + 1} was cut to ${MAX_SEGMENT_CHARS} characters`,
			);
			text = text.slice(0, MAX_SEGMENT_CHARS);
		}
		const speaker = item.speaker?.replace(/\s+/g, " ").trim().slice(0, 200);
		segments.push({
			...item,
			index: segments.length + 1,
			speaker: speaker || null,
			text,
		});
	}
	if (segments.length === 0)
		throw new AppError(
			422,
			"transcript_empty",
			"The transcript contains no text",
			{
				errors: warnings
					.slice(0, 5)
					.map((message) => ({ path: "transcript", message })),
			},
		);
	const speakers = [
		...new Set(segments.flatMap((s) => (s.speaker ? [s.speaker] : []))),
	];
	const durationMs =
		timing === "none"
			? null
			: segments.reduce(
					(max, s) => Math.max(max, s.startMs ?? 0, s.endMs ?? 0),
					0,
				);
	return {
		format,
		timing,
		segments,
		speakers,
		durationMs,
		warnings:
			warnings.length > MAX_WARNINGS
				? [
						...warnings.slice(0, MAX_WARNINGS),
						`${warnings.length - MAX_WARNINGS} more warnings`,
					]
				: warnings,
	};
}

const VTT_HEADER = /^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/;
const SRT_TIMING =
	/^(\d{1,3}:[0-5]\d:[0-5]\d[,.]\d{1,3})[ \t]+-->[ \t]+(\d{1,3}:[0-5]\d:[0-5]\d[,.]\d{1,3})/;
/** An SRT file starts with a cue: an optional number line, then a timing line. */
const SRT_START =
	/^(?:\d+[ \t]*\n[ \t]*)?\d{1,3}:[0-5]\d:[0-5]\d[,.]\d{1,3}[ \t]+-->/;

/**
 * Parses a decoded transcript. WebVTT (Teams uses `<v Speaker>` voice tags) is recognized by its
 * header and SRT by its cue timings, whatever the extension says; everything else is speaker-line
 * text ("Name: text" with optional hh:mm:ss markers, as in a Google Meet export) or plain text.
 */
export function parseTranscript(
	text: string,
	extension: TranscriptExtension,
): ParsedTranscript {
	const body = text.trimStart();
	if (VTT_HEADER.test(body)) return parseWebVtt(body);
	if (extension === ".vtt")
		throw new AppError(
			422,
			"transcript_invalid",
			"A .vtt transcript must start with the WEBVTT header",
		);
	if (SRT_START.test(body)) return parseSrt(body);
	if (extension === ".srt")
		throw new AppError(
			422,
			"transcript_invalid",
			"No SRT cue timings (00:00:01,000 --> 00:00:04,000) were found",
		);
	return parseSpeakerText(body);
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	lrm: "",
	rlm: "",
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi,
		(whole, name: string) => {
			if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? whole;
			const code = /^#x/i.test(name)
				? Number.parseInt(name.slice(2), 16)
				: Number(name.slice(1));
			const printable =
				code >= 0x20 &&
				code !== 0x7f &&
				code <= 0x10ffff &&
				(code < 0xd800 || code > 0xdfff);
			return printable ? String.fromCodePoint(code) : whole;
		},
	);
}

const stripTags = (text: string) => text.replace(/<[^>]*>/g, " ");

function clockMs(
	hours: string | undefined,
	minutes: string,
	seconds: string,
	fraction = "0",
): number {
	return (
		((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) *
			1000 +
		Number(fraction.padEnd(3, "0"))
	);
}

const VTT_TIME = /^(?:(\d{1,3}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
const vttTime = (value: string) => {
	const m = VTT_TIME.exec(value);
	return m?.[2] && m[3] ? clockMs(m[1], m[2], m[3], m[4]) : null;
};

const VOICE = /<v(?:\.[^\s>]*)?(?:[ \t]+([^>]*))?>/g;

/** A cue's text by voice: `<v Name>` sets the speaker for the text that follows it. */
function splitVoices(
	payload: string,
): Array<{ speaker: string | null; text: string }> {
	const parts: Array<{ speaker: string | null; text: string }> = [];
	let speaker: string | null = null;
	let last = 0;
	for (const match of payload.matchAll(VOICE)) {
		parts.push({ speaker, text: payload.slice(last, match.index) });
		speaker = decodeEntities(match[1]?.trim() ?? "") || null;
		last = match.index + match[0].length;
	}
	parts.push({ speaker, text: payload.slice(last) });
	return parts
		.map((part) => ({ ...part, text: decodeEntities(stripTags(part.text)) }))
		.filter((part) => part.text.trim() !== "");
}

function parseWebVtt(text: string): ParsedTranscript {
	const raw: RawSegment[] = [];
	const notes: string[] = [];
	// Blocks are separated by blank lines; the first is the header.
	for (const [i, block] of text
		.split(/\n[ \t]*(?:\n[ \t]*)+/)
		.slice(1)
		.entries()) {
		const lines = block.split("\n");
		const first = lines[0]?.trim() ?? "";
		if (!first || /^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(first)) continue;
		const timingAt = first.includes("-->")
			? 0
			: lines[1]?.includes("-->")
				? 1
				: -1;
		const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)/.exec(
			lines[timingAt]?.trim() ?? "",
		);
		const start = timing?.[1] ? vttTime(timing[1]) : null;
		const end = timing?.[2] ? vttTime(timing[2]) : null;
		if (start === null || end === null) {
			notes.push(`Cue block ${i + 1} has no valid timing and was skipped`);
			continue;
		}
		if (end < start)
			notes.push(
				`Cue block ${i + 1} ends before it starts; its end time was dropped`,
			);
		for (const voice of splitVoices(lines.slice(timingAt + 1).join("\n")))
			raw.push({
				speaker: voice.speaker,
				startMs: start,
				endMs: end >= start ? end : null,
				text: voice.text,
			});
	}
	return assembleTranscript("webvtt", "exact", raw, notes);
}

const SRT_TIME = /^(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/;
const srtTime = (value: string) => {
	const m = SRT_TIME.exec(value);
	return m?.[1] && m[2] && m[3] ? clockMs(m[1], m[2], m[3], m[4]) : null;
};

function parseSrt(text: string): ParsedTranscript {
	const raw: RawSegment[] = [];
	const notes: string[] = [];
	for (const [i, block] of text.split(/\n[ \t]*(?:\n[ \t]*)+/).entries()) {
		const blockLines = block
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (blockLines.length === 0) continue;
		const timingAt = SRT_TIMING.test(blockLines[0] ?? "")
			? 0
			: SRT_TIMING.test(blockLines[1] ?? "")
				? 1
				: -1;
		const timing = SRT_TIMING.exec(blockLines[timingAt] ?? "");
		const start = timing?.[1] ? srtTime(timing[1]) : null;
		const end = timing?.[2] ? srtTime(timing[2]) : null;
		if (start === null || end === null) {
			notes.push(`Block ${i + 1} has no valid cue timing and was skipped`);
			continue;
		}
		if (end < start)
			notes.push(
				`Block ${i + 1} ends before it starts; its end time was dropped`,
			);
		// Strip ASS override tags ({\an8}) and HTML-like styling.
		const content = decodeEntities(
			stripTags(
				blockLines
					.slice(timingAt + 1)
					.join(" ")
					.replace(/\{\\[^}]*\}/g, ""),
			),
		).trim();
		raw.push({
			speaker: null,
			startMs: start,
			endMs: end >= start ? end : null,
			text: content,
		});
	}
	// Speakers are "Name:" prefixes, counted over the cleaned cue texts.
	const labels = speakerLabels(
		raw.map((cue) => cue.text),
		new Set(),
	);
	return assembleTranscript(
		"srt",
		"exact",
		raw.map((cue) => ({ ...cue, ...splitSpeaker(cue.text, labels) })),
		notes,
	);
}

// ---- Speaker-line text (Google Meet export) and plain text ----------------------------------------

const TIME_MARKER = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/;
const SPEAKER_PREFIX = /^([^:]{1,80}?):[ \t]+(\S.*)$/;
const NAME = /^\p{L}[\p{L}\p{M}'’.-]*(?:[ \t]+[\p{L}\p{M}\p{N}'’.()-]+){0,5}$/u;
/** Line prefixes that look like names but label content. */
const NOT_SPEAKERS = new Set(
	"note notes error errors warning warnings update updates todo action actions bug bugs issue issues question questions answer summary agenda decision decisions reminder subject date time title attendees transcript step steps expected actual result results status info debug fix fixes done example output input response request total price version link url http https ftp mailto file path log logs console exception trace fyi ps nb re fw fwd q a".split(
		" ",
	),
);
const FOOTER =
	/^(?:meeting ended after \d|this editable transcript was computer generated)/i;

function splitSpeaker(
	line: string,
	labels: ReadonlySet<string>,
): { speaker: string | null; text: string } {
	const match = SPEAKER_PREFIX.exec(line);
	const label = match?.[1]?.trim();
	return label && match?.[2] && labels.has(label)
		? { speaker: label, text: match[2] }
		: { speaker: null, text: line };
}

/**
 * Prefixes accepted as speakers: names from the export's attendee list, and name-like prefixes that
 * occur at least twice. A false speaker would cut words out of the text ("Total: $NaN"), so a
 * one-off prefix stays part of the text instead.
 */
function speakerLabels(
	lines: readonly string[],
	attendees: ReadonlySet<string>,
): Set<string> {
	const counts = new Map<string, number>();
	for (const line of lines) {
		const label = SPEAKER_PREFIX.exec(line.trim())?.[1]?.trim();
		if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return new Set(
		[...counts].flatMap(([label, n]) =>
			attendees.has(label.toLowerCase()) ||
			(n >= 2 && NAME.test(label) && !NOT_SPEAKERS.has(label.toLowerCase()))
				? [label]
				: [],
		),
	);
}

function parseSpeakerText(text: string): ParsedTranscript {
	const notes: string[] = [];
	let lines = text.split("\n");
	// A Meet export starts with a title, an "Attendees" list, and a "Transcript" heading.
	const attendees = new Set<string>();
	const heading = lines
		.slice(0, 40)
		.findIndex((line) => /^transcript$/i.test(line.trim()));
	if (heading >= 0) {
		const listed = lines
			.slice(0, heading)
			.findIndex((line) => /^attendees$/i.test(line.trim()));
		if (listed >= 0)
			for (const name of lines
				.slice(listed + 1, heading)
				.join(",")
				.split(","))
				if (name.trim()) attendees.add(name.trim().toLowerCase());
		notes.push(`Skipped the ${heading + 1}-line export header`);
		lines = lines.slice(heading + 1);
	}
	const labels = speakerLabels(lines, attendees);
	const raw: RawSegment[] = [];
	let block: RawSegment[] = [];
	let blockStart: number | null = null;
	let markers = 0;
	let previous: RawSegment | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			previous = null;
			continue;
		}
		const marker = TIME_MARKER.exec(trimmed);
		if (marker?.[1] && marker[2]) {
			blockStart = marker[3]
				? clockMs(marker[1], marker[2], marker[3])
				: clockMs(undefined, marker[1], marker[2]);
			for (const segment of block) segment.endMs = blockStart;
			block = [];
			markers += 1;
			previous = null;
			continue;
		}
		if (FOOTER.test(trimmed)) continue;
		const parsed = splitSpeaker(trimmed, labels);
		// A wrapped line (no "X:" prefix) directly after a speaker's line continues that turn.
		if (!parsed.speaker && previous?.speaker && !SPEAKER_PREFIX.test(trimmed)) {
			previous.text += ` ${trimmed}`;
			continue;
		}
		previous = { ...parsed, startMs: blockStart, endMs: null };
		raw.push(previous);
		block.push(previous);
	}
	return assembleTranscript(
		labels.size > 0 ? "speaker_text" : "plain_text",
		markers > 0 ? "block" : "none",
		raw,
		notes,
	);
}
