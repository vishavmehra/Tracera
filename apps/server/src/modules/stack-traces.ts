import path from "node:path";
import { redactSecrets } from "../lib/redact.ts";

// Stack-trace and log intelligence. Frames are parsed from text, their paths are
// normalized and resolved to repository files at one revision, source maps are followed when the
// generated file's map is in the repository, and each resolved frame is placed in the innermost
// symbol at its line. A frame shows where an error surfaced, never by itself why.

export type FrameClassification =
	| "application"
	| "dependency"
	| "runtime"
	| "generated"
	| "unknown";

export type ParsedFrame = {
	index: number;
	raw: string;
	function: string | null;
	file: string | null;
	line: number | null;
	column: number | null;
	classification: FrameClassification;
};

export type ParsedTrace = {
	format: "v8" | "firefox" | "python" | "java" | "mixed" | "unknown";
	error: { type: string; message: string } | null;
	frames: ParsedFrame[];
	truncated: boolean;
};

const MAX_FRAMES = 60;
const V8_FRAME =
	/^\s*at\s+(?:async\s+)?(?:new\s+)?(?:(.+?)\s+\()?(?:eval at .+?, )?((?:[A-Za-z]:)?[^():]*?[^()]*?):(\d+):(\d+)\)?\s*$/;
const V8_BARE =
	/^\s*at\s+(?:async\s+)?(.+?)\s+\((native|<anonymous>|index \d+)\)\s*$/;
const FIREFOX_FRAME = /^\s*(?:([^@\s]*)@)(.+?):(\d+):(\d+)\s*$/;
const PYTHON_FRAME = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?\s*$/;
const JAVA_FRAME =
	/^\s*at\s+([\w$.<>]+)\(([\w$-]+\.(?:java|kt|scala|groovy)):(\d+)\)\s*$/;
const ERROR_LINE =
	/^\s*(?:Uncaught\s+(?:\(in promise\)\s+)?)?([A-Za-z_$][\w$.]*?(?:Error|Exception|Exit|Fault|Warning|Rejection))(?:\s*\[[^\]]*\])?\s*:\s*(.*)$/;

/** Where a frame's code lives, judged from its path alone. */
function classify(file: string): FrameClassification {
	if (
		/^(node:|internal\/|<anonymous>|native\b|\[native code\])/.test(file) ||
		/^(?:evalmachine|wasm-function)/.test(file)
	)
		return "runtime";
	if (
		/[\\/]node_modules[\\/]|[\\/]site-packages[\\/]|[\\/]dist-packages[\\/]/.test(
			file,
		)
	)
		return "dependency";
	// Dev servers serve original modules over HTTP; only bundles and hashed chunks are generated.
	if (/\.(min|bundle|chunk)\.js(\?|$)|[-.][0-9a-f]{8,}\.js(\?|$)/i.test(file))
		return "generated";
	return "application";
}

/** Parses V8 (Node, Chrome, Edge), Firefox/Safari, Python, and Java traces; other lines are ignored. */
export function parseStackTrace(text: string): ParsedTrace {
	const lines = text.replace(/\r\n?/g, "\n").split("\n").slice(0, 2000);
	const frames: ParsedFrame[] = [];
	const formats = new Set<ParsedTrace["format"]>();
	let error: ParsedTrace["error"] = null;
	let truncated = false;
	const push = (frame: Omit<ParsedFrame, "index" | "classification">) => {
		if (frames.length >= MAX_FRAMES) {
			truncated = true;
			return;
		}
		frames.push({
			...frame,
			index: frames.length,
			classification: frame.file ? classify(frame.file) : "unknown",
		});
	};
	for (const line of lines) {
		const raw = line.trim().slice(0, 500);
		if (!raw) continue;
		let match = JAVA_FRAME.exec(line);
		if (match) {
			formats.add("java");
			const qualified = match[1] ?? "";
			const packagePath = qualified.split(".").slice(0, -2).join("/");
			push({
				raw,
				function: qualified,
				file: packagePath ? `${packagePath}/${match[2]}` : (match[2] ?? null),
				line: Number(match[3]),
				column: null,
			});
			continue;
		}
		match = V8_FRAME.exec(line);
		if (match) {
			formats.add("v8");
			push({
				raw,
				function: match[1]?.trim() || null,
				file: match[2]?.trim() || null,
				line: Number(match[3]),
				column: Number(match[4]),
			});
			continue;
		}
		match = V8_BARE.exec(line);
		if (match) {
			formats.add("v8");
			push({
				raw,
				function: match[1] ?? null,
				file: null,
				line: null,
				column: null,
			});
			continue;
		}
		match = PYTHON_FRAME.exec(line);
		if (match) {
			formats.add("python");
			push({
				raw,
				function: match[3]?.trim() || null,
				file: match[1] ?? null,
				line: Number(match[2]),
				column: null,
			});
			continue;
		}
		if (!/^\s*at\s/.test(line)) {
			match = FIREFOX_FRAME.exec(line);
			if (match?.[2] && !/\s/.test(match[2])) {
				formats.add("firefox");
				push({
					raw,
					function: match[1] || null,
					file: match[2],
					line: Number(match[3]),
					column: Number(match[4]),
				});
				continue;
			}
		}
		const header = ERROR_LINE.exec(line);
		// The first error line names the error (Python prints it last, after the frames).
		if (header && (!error || formats.has("python")))
			error = {
				type: header[1] ?? "Error",
				message: (header[2] ?? "").trim().slice(0, 500),
			};
	}
	const format =
		formats.size === 0
			? "unknown"
			: formats.size > 1
				? "mixed"
				: ([...formats][0] ?? "unknown");
	return { format, error, frames, truncated };
}

/**
 * A frame path as a repository-relative candidate: bundler and file URL prefixes, query strings, and
 * Windows separators removed. `null` for paths that can never be repository files.
 */
export function normalizeFramePath(file: string): string | null {
	let value = file.trim();
	if (!value || /^(node:|internal\/|<|native\b)/.test(value)) return null;
	value = value
		.replace(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?/, "")
		.replace(/^webpack:\/\/(?:[^/]*\/)?/, "")
		.replace(/^(?:vite|rollup|turbopack):\/\/\/?/, "")
		.replace(/^file:\/\/\/?/, "")
		.replace(/^\(app-pages-browser\)\/|^\(rsc\)\//, "")
		.replace(/[?#].*$/, "")
		.replace(/\\/g, "/");
	if (/^https?:\/\//.test(value)) {
		try {
			value = new URL(value).pathname;
		} catch {
			return null;
		}
	}
	try {
		value = decodeURIComponent(value);
	} catch {
		// keep the raw value
	}
	value = value.replace(/^[A-Za-z]:\//, "/").replace(/^\.\//, "");
	return value || null;
}

export type PathResolution =
	| { status: "resolved"; file: string; method: "exact_path" | "path_suffix" }
	| { status: "ambiguous"; candidates: string[] }
	| { status: "unresolved" };

/**
 * Indexes repository files by basename once, so each frame resolves in time proportional to its
 * candidates. A candidate matches files with the same name, scored by how many trailing path segments
 * agree (a deploy path like /app/src/x.ts or a Java package path like com/shop/X.java both work); the
 * single best score wins and a tie stays ambiguous.
 */
export function pathResolver(files: Iterable<string>) {
	const all = new Set(files);
	const byBase = new Map<string, string[]>();
	for (const file of all) {
		const base = path.posix.basename(file);
		const list = byBase.get(base) ?? [];
		list.push(file);
		byBase.set(base, list);
	}
	return (candidate: string): PathResolution => {
		const clean = candidate.replace(/^\/+/, "");
		if (all.has(clean))
			return { status: "resolved", file: clean, method: "exact_path" };
		const segments = clean.split("/");
		const agreement = (file: string) => {
			const parts = file.split("/");
			let n = 0;
			while (
				n < parts.length &&
				n < segments.length &&
				parts[parts.length - 1 - n] === segments[segments.length - 1 - n]
			)
				n += 1;
			return n;
		};
		const scored = (byBase.get(path.posix.basename(clean)) ?? []).map(
			(file) => ({
				file,
				score: agreement(file),
			}),
		);
		if (scored.length === 0) return { status: "unresolved" };
		const top = Math.max(...scored.map((entry) => entry.score));
		const best = scored.filter((entry) => entry.score === top);
		return best.length === 1 && best[0]
			? { status: "resolved", file: best[0].file, method: "path_suffix" }
			: {
					status: "ambiguous",
					candidates: best.map((entry) => entry.file).slice(0, 5),
				};
	};
}

// ---- Source maps (v3) ------------------------------------------------------------------------

const BASE64 =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Map([...BASE64].map((char, i) => [char, i]));

export type SourceMap = {
	sources: string[];
	names: string[];
	sourceRoot: string;
	/** Per generated line: segments [generated column, source, original line, original column, name?]. */
	lines: number[][][];
};

/** Parses a v3 source map (VLQ mappings); null for anything else. Bounded to 8 MB of mappings. */
export function parseSourceMap(text: string): SourceMap | null {
	let json: {
		version?: unknown;
		sources?: unknown;
		names?: unknown;
		mappings?: unknown;
		sourceRoot?: unknown;
	};
	try {
		json = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		json.version !== 3 ||
		!Array.isArray(json.sources) ||
		typeof json.mappings !== "string" ||
		json.mappings.length > 8_000_000
	)
		return null;
	const lines: number[][][] = [];
	let source = 0;
	let originalLine = 0;
	let originalColumn = 0;
	let name = 0;
	for (const lineText of json.mappings.split(";")) {
		const segments: number[][] = [];
		let column = 0;
		for (const segmentText of lineText.split(",")) {
			if (!segmentText) continue;
			const values: number[] = [];
			let value = 0;
			let shift = 0;
			for (const char of segmentText) {
				const digit = BASE64_VALUE.get(char);
				if (digit === undefined) return null;
				value += (digit & 31) << shift;
				if (digit & 32) shift += 5;
				else {
					values.push(value & 1 ? -(value >>> 1) : value >>> 1);
					value = 0;
					shift = 0;
				}
			}
			column += values[0] ?? 0;
			if (values.length >= 4) {
				source += values[1] ?? 0;
				originalLine += values[2] ?? 0;
				originalColumn += values[3] ?? 0;
				if (values.length >= 5) name += values[4] ?? 0;
				segments.push(
					values.length >= 5
						? [column, source, originalLine, originalColumn, name]
						: [column, source, originalLine, originalColumn],
				);
			}
		}
		lines.push(segments);
	}
	return {
		sources: json.sources.map((s) => String(s)),
		names: Array.isArray(json.names) ? json.names.map((n) => String(n)) : [],
		sourceRoot: typeof json.sourceRoot === "string" ? json.sourceRoot : "",
		lines,
	};
}

/** The original position of a generated (1-based) line and column, or null when nothing maps there. */
export function originalPosition(
	map: SourceMap,
	line: number,
	column: number,
): {
	source: string;
	line: number;
	column: number;
	name: string | null;
} | null {
	const segments = map.lines[line - 1];
	if (!segments || segments.length === 0) return null;
	const target = Math.max(0, column - 1);
	let low = 0;
	let high = segments.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if ((segments[mid]?.[0] ?? 0) <= target) {
			found = mid;
			low = mid + 1;
		} else high = mid - 1;
	}
	const segment = segments[found === -1 ? 0 : found];
	if (!segment || segment[1] === undefined) return null;
	const source = map.sources[segment[1]];
	if (source === undefined) return null;
	return {
		source: map.sourceRoot ? path.posix.join(map.sourceRoot, source) : source,
		line: (segment[2] ?? 0) + 1,
		column: (segment[3] ?? 0) + 1,
		name: segment[4] === undefined ? null : (map.names[segment[4]] ?? null),
	};
}

// ---- Mapping frames onto one revision of a repository ----------------------------------------

/** What mapping needs from a revision; backed by a stored snapshot or by an in-memory analysis. */
export type RevisionIndex = {
	files: Iterable<string>;
	/** The innermost symbol whose lines contain `line`, if the file was parsed. */
	symbolAt(
		file: string,
		line: number,
	): Promise<{
		key: string;
		node_id: string | null;
		name: string;
		kind: string;
		start_line: number;
		end_line: number;
	} | null>;
	/** A file's text at the revision (excerpts, source maps); null if absent or unreadable. */
	readText(file: string): Promise<string | null>;
	/** Whether symbols exist for this file (parsed language). */
	parsed(file: string): boolean;
};

export type MappedFrame = ParsedFrame & {
	resolution:
		| {
				status: "resolved";
				file: string;
				line: number | null;
				method: "exact_path" | "path_suffix" | "source_map";
				line_reliable: boolean;
		  }
		| { status: "ambiguous"; candidates: string[] }
		| { status: "unresolved" | "external"; reason: string };
	symbol: {
		key: string;
		node_id: string | null;
		name: string;
		kind: string;
		start_line: number;
		end_line: number;
		/** Whether the symbol at the line has the frame's function name (a revision-drift check). */
		name_matches: boolean | null;
	} | null;
	excerpt: { start_line: number; end_line: number; text: string } | null;
};

const frameFunctionName = (name: string | null) =>
	name
		?.replace(/^(async|new)\s+/, "")
		.replace(/^Object\.|^Module\./, "")
		.replace(/^.*\[as (.+)\]$/, "$1")
		.trim() || null;
/** Whether a frame's function name agrees with the symbol found at its line. */
export function nameMatches(
	frame: string | null,
	symbol: string,
): boolean | null {
	const name = frameFunctionName(frame);
	if (!name || name.includes("<anonymous>")) return null;
	const tail = (value: string) => value.split(/[.#]/).pop() ?? value;
	return (
		name === symbol ||
		tail(name) === tail(symbol) ||
		symbol.endsWith(`.${tail(name)}`)
	);
}

/** The item with the shortest line span containing `line` (the innermost symbol there), or null. */
export function innermost<T>(
	items: Iterable<T>,
	line: number,
	span: (item: T) => readonly [number | null, number | null],
): T | null {
	let best: T | null = null;
	let size = Number.POSITIVE_INFINITY;
	for (const item of items) {
		const [start, end] = span(item);
		if (start === null || end === null || start > line || end < line) continue;
		if (end - start < size) {
			best = item;
			size = end - start;
		}
	}
	return best;
}

/**
 * Resolves frames against one revision. Application frames resolve to files (exact path or longest
 * unique path suffix); generated frames go through a source map committed next to the bundle; runtime
 * and dependency frames are reported as external. Every unresolved frame says why.
 */
export async function mapFrames(
	trace: ParsedTrace,
	index: RevisionIndex,
): Promise<MappedFrame[]> {
	const resolve = pathResolver(index.files);
	const maps = new Map<string, SourceMap | null>();
	const lineCache = new Map<string, string[] | null>();
	const linesOf = async (file: string) => {
		if (!lineCache.has(file)) {
			const text = await index.readText(file);
			const lines = text === null ? null : text.split("\n");
			if (lines?.at(-1) === "") lines.pop(); // a final newline ends the last line
			lineCache.set(file, lines);
		}
		return lineCache.get(file) ?? null;
	};
	const out: MappedFrame[] = [];
	for (const frame of trace.frames) {
		const base: MappedFrame = {
			...frame,
			resolution: { status: "unresolved", reason: "no_location" },
			symbol: null,
			excerpt: null,
		};
		if (!frame.file) {
			out.push(base);
			continue;
		}
		if (
			frame.classification === "runtime" ||
			frame.classification === "dependency"
		) {
			out.push({
				...base,
				resolution: {
					status: "external",
					reason:
						frame.classification === "runtime"
							? "runtime_frame"
							: "dependency_frame",
				},
			});
			continue;
		}
		const candidate = normalizeFramePath(frame.file);
		if (!candidate) {
			out.push({
				...base,
				resolution: { status: "unresolved", reason: "not_a_repository_path" },
			});
			continue;
		}
		let resolution = resolve(candidate);
		let file = resolution.status === "resolved" ? resolution.file : null;
		let line = frame.line;
		let method: "exact_path" | "path_suffix" | "source_map" =
			resolution.status === "resolved" ? resolution.method : "exact_path";
		// A generated file with a committed source map: follow the map to the original source.
		if (
			file &&
			frame.line !== null &&
			frame.column !== null &&
			/\.[cm]?js$/.test(file)
		) {
			if (!maps.has(file)) {
				const text = await index.readText(`${file}.map`);
				maps.set(file, text === null ? null : parseSourceMap(text));
			}
			const map = maps.get(file);
			const original = map
				? originalPosition(map, frame.line, frame.column)
				: null;
			if (original) {
				const source =
					normalizeFramePath(
						path.posix.join(path.posix.dirname(file), original.source),
					) ?? original.source;
				const mapped = resolve(source);
				if (mapped.status === "resolved") {
					file = mapped.file;
					line = original.line;
					method = "source_map";
					resolution = mapped;
				}
			}
		}
		if (resolution.status === "ambiguous") {
			out.push({
				...base,
				resolution: { status: "ambiguous", candidates: resolution.candidates },
			});
			continue;
		}
		if (!file) {
			out.push({
				...base,
				resolution: {
					status: "unresolved",
					reason:
						frame.classification === "generated"
							? "generated_without_source_map"
							: "no_matching_file",
				},
			});
			continue;
		}
		const lines = await linesOf(file);
		const lineReliable =
			lines !== null && line !== null && line >= 1 && line <= lines.length;
		let symbol: MappedFrame["symbol"] = null;
		if (line !== null && index.parsed(file)) {
			const found = await index.symbolAt(file, line);
			if (found)
				symbol = {
					...found,
					name_matches: nameMatches(frame.function, found.name),
				};
		}
		const excerpt =
			lines && line !== null && lineReliable
				? {
						start_line: Math.max(1, line - 3),
						end_line: Math.min(lines.length, line + 3),
						text: lines
							.slice(Math.max(0, line - 4), Math.min(lines.length, line + 3))
							.map(
								(text, i) =>
									`${String(Math.max(1, line - 3) + i).padStart(4)}| ${text.slice(0, 300)}`,
							)
							.join("\n"),
					}
				: null;
		out.push({
			...base,
			resolution: {
				status: "resolved",
				file,
				line,
				method,
				line_reliable: lineReliable,
			},
			symbol,
			excerpt,
		});
	}
	return out;
}

/** Error lines and mentions of mapped files or symbols in supplied logs (redacted and bounded). */
export function correlateLogs(
	logs: string,
	frames: readonly MappedFrame[],
	options: { redactEmails: boolean },
) {
	const redacted = redactSecrets(logs.slice(0, 200_000), options);
	const lines = redacted.text.replace(/\r\n?/g, "\n").split("\n");
	const errorLines: Array<{ line: number; text: string }> = [];
	const terms = new Map<string, number>();
	for (const frame of frames) {
		if (frame.resolution.status !== "resolved") continue;
		terms.set(path.posix.basename(frame.resolution.file), 0);
		if (frame.symbol)
			terms.set(frame.symbol.name.split(".").pop() ?? frame.symbol.name, 0);
	}
	lines.forEach((text, i) => {
		if (
			errorLines.length < 50 &&
			/\b(ERROR|FATAL|CRITICAL|panic|Traceback|Unhandled|Exception|\w+Error)\b/.test(
				text,
			)
		)
			errorLines.push({ line: i + 1, text: text.slice(0, 300) });
		for (const term of terms.keys())
			if (term.length > 2 && text.includes(term))
				terms.set(term, (terms.get(term) ?? 0) + 1);
	});
	return {
		lines_scanned: lines.length,
		redactions: redacted.count,
		error_lines: errorLines,
		mentions: [...terms]
			.filter(([, count]) => count > 0)
			.map(([term, count]) => ({ term, count }))
			.sort((a, b) => b.count - a.count),
		embedded_frames: parseStackTrace(redacted.text).frames.length,
	};
}

export const STACK_TRACE_LIMITATIONS = [
	"A frame shows where an error surfaced, not why it happened: mapped frames are evidence for hypotheses, never a root cause on their own.",
	"Frames are mapped to the chosen revision; if the trace came from different code, lines may point elsewhere (each resolved frame says whether its line exists and whether the symbol there has the frame's name).",
	"Generated (bundled or minified) frames are followed only through a source map committed next to the bundle.",
];
