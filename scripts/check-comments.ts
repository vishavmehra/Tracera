// Fails when a comment in a tracked source file carries a date, a version number, an internal
// planning reference, or a pointer to documentation that is not published with the code. Published
// code should read the same without them.
//
// Usage: node scripts/check-comments.ts [file ...]   (default: every tracked file of a known kind)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type Span = { start: number; end: number };
type Kind = "js" | "css" | "html" | "sql" | "hash" | "hashLine" | "powershell";

export type Finding = {
	file: string;
	line: number;
	category: string;
	match: string;
	comment: string;
};

const BY_EXTENSION: Record<string, Kind> = {
	".ts": "js",
	".tsx": "js",
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".css": "css",
	".html": "html",
	".sql": "sql",
	".yml": "hash",
	".yaml": "hash",
	".sh": "hash",
	".ps1": "powershell",
};

const BY_NAME: Record<string, Kind> = {
	".env.example": "hash",
	".gitignore": "hashLine",
	".gitattributes": "hashLine",
};

export function kindOf(file: string): Kind | undefined {
	const name = path.posix.basename(file.replaceAll("\\", "/"));
	return BY_NAME[name] ?? BY_EXTENSION[path.posix.extname(name)];
}

// ---------------------------------------------------------------------------------------------
// Comment extraction. Each scanner returns the spans of the comments in a source text and steps
// over string, template, and regex literals so that "https://" in a string is never a comment.
// ---------------------------------------------------------------------------------------------

// After these words a "/" starts a regex literal; after any other word it is a division.
const REGEX_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

const WORD = /[\w$]/;

function scanJs(src: string): Span[] {
	const spans: Span[] = [];
	const n = src.length;
	let i = 0;
	let regexOk = true; // would a "/" at the cursor start a regex literal?

	const skipQuoted = (quote: string) => {
		i++;
		while (i < n) {
			const c = src.charAt(i);
			if (c === "\\") i += 2;
			else if (c === quote) {
				i++;
				return;
			}
			// An unterminated string is JSX text or a stray quote: resume on the next line.
			else if (c === "\n") return;
			else i++;
		}
	};

	// Regex literals never span lines, so a missing close means the "/" was a division after all.
	const skipRegex = (): boolean => {
		let j = i + 1;
		let inClass = false;
		while (j < n) {
			const c = src.charAt(j);
			if (c === "\n") return false;
			if (c === "\\") j += 2;
			else if (c === "[") {
				inClass = true;
				j++;
			} else if (c === "]") {
				inClass = false;
				j++;
			} else if (c === "/" && !inClass) {
				j++;
				while (/[a-z]/i.test(src.charAt(j))) j++;
				i = j;
				return true;
			} else j++;
		}
		return false;
	};

	const skipTemplate = () => {
		i++;
		while (i < n) {
			const c = src.charAt(i);
			if (c === "\\") i += 2;
			else if (c === "`") {
				i++;
				return;
			} else if (c === "$" && src.charAt(i + 1) === "{") {
				i += 2;
				scanCode(true);
			} else i++;
		}
	};

	const scanCode = (inTemplateExpression: boolean) => {
		let depth = 0;
		while (i < n) {
			const c = src.charAt(i);
			if (c === "/") {
				const next = src.charAt(i + 1);
				if (next === "/" || next === "*") {
					let end: number;
					if (next === "/") {
						end = src.indexOf("\n", i);
						if (end === -1) end = n;
					} else {
						const close = src.indexOf("*/", i + 2);
						end = close === -1 ? n : close + 2;
					}
					spans.push({ start: i, end });
					i = end;
				} else if (regexOk && skipRegex()) {
					regexOk = false;
				} else {
					i++;
					regexOk = true;
				}
			} else if (c === '"' || c === "'") {
				skipQuoted(c);
				regexOk = false;
			} else if (c === "`") {
				skipTemplate();
				regexOk = false;
			} else if (c === "{") {
				depth++;
				i++;
				regexOk = true;
			} else if (c === "}") {
				i++;
				if (inTemplateExpression && depth === 0) return;
				depth--;
				regexOk = false;
			} else if (WORD.test(c)) {
				let j = i + 1;
				while (WORD.test(src.charAt(j))) j++;
				// A property named like a keyword (map.delete) is still an operand.
				regexOk =
					src.charAt(i - 1) !== "." && REGEX_KEYWORDS.has(src.slice(i, j));
				i = j;
			} else if (c === ")" || c === "]") {
				regexOk = false;
				i++;
			} else if (/\s/.test(c)) {
				i++;
			} else {
				// "</div>" and "a > /re/" are not regexes; "=> /re/" is.
				regexOk = c !== "<" && (c !== ">" || src.charAt(i - 1) === "=");
				i++;
			}
		}
	};

	if (src.startsWith("#!"))
		i = src.indexOf("\n") === -1 ? n : src.indexOf("\n");
	scanCode(false);
	return spans;
}

function scanCss(src: string, base = 0): Span[] {
	const spans: Span[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src.charAt(i);
		if (c === "/" && src.charAt(i + 1) === "*") {
			const close = src.indexOf("*/", i + 2);
			const end = close === -1 ? src.length : close + 2;
			spans.push({ start: base + i, end: base + end });
			i = end;
		} else if (c === '"' || c === "'") {
			i++;
			while (i < src.length && src.charAt(i) !== c && src.charAt(i) !== "\n") {
				if (src.charAt(i) === "\\") i++;
				i++;
			}
			i++;
		} else i++;
	}
	return spans;
}

// SQL: "--" to the end of the line and block comments. Quoted strings and identifiers are skipped;
// a doubled quote just reads as two adjacent strings, and dollar-quoted bodies are scanned as code.
function scanSql(src: string): Span[] {
	const spans: Span[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src.charAt(i);
		const next = src.charAt(i + 1);
		if ((c === "-" && next === "-") || (c === "/" && next === "*")) {
			const line = c === "-";
			const close = line ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
			let end = close === -1 ? src.length : close;
			if (!line && close !== -1) end += 2;
			spans.push({ start: i, end });
			i = end;
		} else if (c === "'" || c === '"') {
			const close = src.indexOf(c, i + 1);
			i = close === -1 ? src.length : close + 1;
		} else i++;
	}
	return spans;
}

// Comments in markup, plus the comments inside inline <script> and <style> bodies.
function scanHtml(src: string): Span[] {
	const spans: Span[] = [];
	const token = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi;
	for (const m of src.matchAll(token)) {
		if (m[1] === undefined || m[2] === undefined) {
			spans.push({ start: m.index, end: m.index + m[0].length });
			continue;
		}
		const base = m.index + m[0].indexOf(m[2], m[0].indexOf(">"));
		const inner =
			m[1].toLowerCase() === "script" ? scanJs(m[2]) : scanCss(m[2]);
		for (const s of inner)
			spans.push({ start: base + s.start, end: base + s.end });
	}
	return spans;
}

// "#" comments for YAML, shell, dotenv, and PowerShell: a "#" opens one only at the start of a line
// or after whitespace, and never inside a quoted value. Quote state resets at each newline.
function scanHash(src: string, powershell: boolean): Span[] {
	const spans: Span[] = [];
	const escapeChar = powershell ? "`" : "\\";
	let quote = "";
	let i = 0;
	while (i < src.length) {
		const c = src.charAt(i);
		const prev = src.charAt(i - 1);
		if (c === "\n") {
			quote = "";
			i++;
		} else if (quote) {
			if (c === quote) quote = "";
			else if (c === escapeChar && quote === '"') i++;
			i++;
		} else if (powershell && c === "<" && src.charAt(i + 1) === "#") {
			const close = src.indexOf("#>", i + 2);
			const end = close === -1 ? src.length : close + 2;
			spans.push({ start: i, end });
			i = end;
		} else if (c === "#" && (i === 0 || /\s/.test(prev))) {
			let end = src.indexOf("\n", i);
			if (end === -1) end = src.length;
			spans.push({ start: i, end });
			i = end;
		} else {
			// An apostrophe inside a word (don't) is not the start of a quoted value.
			if ((c === '"' || c === "'") && !WORD.test(prev)) quote = c;
			i++;
		}
	}
	return spans;
}

// .gitignore and .gitattributes: a comment is a line that starts with "#".
function scanHashLines(src: string): Span[] {
	const spans: Span[] = [];
	for (const m of src.matchAll(/^[ \t]*(#.*)$/gm)) {
		const start = m.index + m[0].length - (m[1]?.length ?? 0);
		spans.push({ start, end: m.index + m[0].length });
	}
	return spans;
}

const SCANNERS: Record<Kind, (src: string) => Span[]> = {
	js: scanJs,
	css: (src) => scanCss(src),
	html: scanHtml,
	sql: scanSql,
	hash: (src) => scanHash(src, false),
	hashLine: scanHashLines,
	powershell: (src) => scanHash(src, true),
};

// ---------------------------------------------------------------------------------------------
// What a comment may not contain.
// ---------------------------------------------------------------------------------------------

const MONTH =
	"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const YEAR = "20[23]\\d";

const PRODUCTS = [
	"Node(?:\\.js)?",
	"NodeJS",
	"Deno",
	"Bun",
	"npm",
	"React",
	"Vite",
	"Vitest",
	"Playwright",
	"Puppeteer",
	"TypeScript",
	"JavaScript",
	"ECMAScript",
	"Tailwind(?:\\s?CSS)?",
	"Zod",
	"Biome",
	"Drizzle",
	"Hono",
	"Fastify",
	"Express",
	"Postgres(?:QL)?",
	"Supabase",
	"Docker",
	"Chromium",
	"Chrome",
	"Firefox",
	"Safari",
	"WebKit",
	"Python",
	"Java",
	"Go",
	"Rust",
	"Ubuntu",
	"Debian",
	"Alpine",
	"Windows",
	"Linux",
	"macOS",
	"Muse(?:\\s+Spark)?",
	"Llama",
	"GPT",
	"Claude",
	"Gemini",
	"SAM",
	"Git",
].join("|");

export const REQUIREMENT_PREFIXES = [
	"REPO",
	"IDX",
	"GRAPH",
	"LANG",
	"INC",
	"SNAP",
	"PR",
	"STALE",
	"Q",
	"OWN",
	"SEARCH",
	"SPEC",
	"INT",
	"MM",
	"INV",
	"PATCH",
	"IMPACT",
	"DEP",
	"BROWSER",
	"VER",
	"APR",
	"PUB",
	"MCP",
	"EXT",
	"MTG",
	"WEB",
	"DATA",
	"PROV",
	"SEC",
	"PRIV",
	"REL",
	"OBS",
	"EVAL",
	"COST",
	"DEPLOY",
];

// The internal documents, which are not published with the code.
const DOC_NAMES = [
	"AGENT_WORKFLOWS",
	"API_SPEC",
	"DATA_MODEL",
	"MCP_SPEC",
	"SECURITY_PRIVACY",
	"EVALUATION_TESTING",
	"RELEASE_ACCEPTANCE",
	"IMPLEMENTATION_ROADMAP",
	"PRODUCT_SPEC",
	"DEV_SETUP",
].join("|");
const SECTION = "\\u00a7\\s*\\d+(?:\\.\\d+)*";

// Earlier rules win when two matches overlap, so list the most specific first.
const RULES: Array<{ category: string; pattern: RegExp }> = [
	{
		category: "date",
		pattern: new RegExp(
			`\\b${YEAR}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])\\b`,
			"g",
		),
	},
	{
		category: "date",
		pattern: new RegExp(
			`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b\\.?(?:,?\\s+${YEAR}\\b)?`,
			"g",
		),
	},
	{
		category: "date",
		pattern: new RegExp(
			`\\b${MONTH}\\b\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+${YEAR}\\b)?`,
			"g",
		),
	},
	{ category: "date", pattern: new RegExp(`\\b${YEAR}\\b`, "g") },
	{
		category: "version",
		pattern: new RegExp(
			`\\b(?:${PRODUCTS})\\s*(?:[:@-]\\s*)?(?:[<>=~^]+\\s*)?v?\\d+(?:\\.\\d+){0,2}\\b`,
			"g",
		),
	},
	// Image tags such as "name:tag" or "name@tag" with a numeric tag.
	{
		category: "version",
		pattern:
			/\b(?:node|postgres|alpine|ubuntu|debian|python|redis|playwright)[:@]v?\d[\w.-]*/g,
	},
	{ category: "version", pattern: /(?<![\w.])v\d+\.\d+(?:\.\d+)*\b/g },
	{ category: "version", pattern: /(?<![\w.])\d+\.\d+\.\d+(?![\w]|\.\d)/g },
	{
		category: "decision",
		pattern: /\b(?:D|FD|OQ)-(?:[A-Z]+-)?\d+\b/g,
	},
	{
		category: "requirement",
		pattern: new RegExp(
			`\\b(?:${REQUIREMENT_PREFIXES.join("|")})-\\d+\\b`,
			"g",
		),
	},
	{ category: "milestone", pattern: /\bM\d\b/g },
	{ category: "schedule", pattern: /\bDay \d+\b/g },
	{ category: "schedule", pattern: /\b[Pp]hase [A-G]\b/g },
	{ category: "schedule", pattern: /\b[Gg]ate [A-G]\b/g },
	{ category: "agent", pattern: /\bAgents? [A-I]\b/g },
	// Pointers into documentation that is not published with the code.
	{
		category: "doc",
		pattern: new RegExp(
			`(?<![\\w/.:-])docs/[\\w./*-]*(?:\\s*${SECTION})?`,
			"g",
		),
	},
	{ category: "doc", pattern: /\bCLAUDE\.md\b/g },
	{
		category: "doc",
		pattern: new RegExp(
			`\\b(?:${DOC_NAMES})\\b(?:\\.md)?(?:\\s*${SECTION})?`,
			"g",
		),
	},
	{
		category: "doc",
		pattern: /\b(?:ARCHITECTURE|ENVIRONMENT|DECISIONS|INTEGRATIONS)\.md\b/g,
	},
	{ category: "doc", pattern: /\bmaster (?:product )?prompt\b/gi },
	{ category: "doc", pattern: /§(?:\s*\d+(?:\.\d+)*)?/g },
];

type Match = { start: number; end: number; category: string; text: string };

function matchRules(text: string): Match[] {
	const all: Match[] = [];
	for (const { category, pattern } of RULES)
		for (const m of text.matchAll(pattern))
			all.push({
				start: m.index,
				end: m.index + m[0].length,
				category,
				text: m[0],
			});
	// Keep the leftmost, then longest, match of each overlapping group.
	all.sort((a, b) => a.start - b.start || b.end - a.end);
	const kept: Match[] = [];
	for (const m of all) {
		const last = kept.at(-1);
		if (!last || m.start >= last.end) kept.push(m);
	}
	return kept;
}

// Strips the comment delimiters and the leading "*" of block-comment lines.
function stripDecoration(line: string): string {
	return line
		.replace(/\s*(?:\*+\/|-->|#>)\s*$/, "")
		.replace(/^\s*(?:\/\*+|\*+|\/{2,}|#+|-{2,}|<!--|<#)?\s?/, "");
}

/** Where the comments of `src` are, as offsets into it. Empty for files of an unknown kind. */
export function commentSpans(file: string, src: string): Span[] {
	const kind = kindOf(file);
	return kind ? SCANNERS[kind](src) : [];
}

export function findIssues(file: string, text: string): Finding[] {
	const src = text.replace(/\r\n?/g, "\n");

	// One entry per comment line; adjacent lines form a group so a phrase wrapped over two
	// lines ("Node" / "24") is still seen as one.
	const lines: Array<{ line: number; text: string }> = [];
	let line = 1;
	let pos = 0;
	for (const span of commentSpans(file, src)) {
		for (let k = pos; k < span.start; k++) if (src.charCodeAt(k) === 10) line++;
		pos = span.start;
		for (const [k, part] of src
			.slice(span.start, span.end)
			.split("\n")
			.entries())
			lines.push({ line: line + k, text: stripDecoration(part) });
	}

	const groups: Array<typeof lines> = [];
	for (const entry of lines) {
		const group = groups.at(-1);
		if (group && entry.line - (group.at(-1)?.line ?? -2) <= 1)
			group.push(entry);
		else groups.push([entry]);
	}

	const findings: Finding[] = [];
	for (const group of groups) {
		const joined = group.map((entry) => entry.text).join(" ");
		const starts: number[] = [];
		let offset = 0;
		for (const entry of group) {
			starts.push(offset);
			offset += entry.text.length + 1;
		}
		for (const m of matchRules(joined)) {
			let index = starts.findLastIndex((start) => start <= m.start);
			if (index < 0) index = 0;
			const entry = group[index];
			if (!entry) continue;
			findings.push({
				file,
				line: entry.line,
				category: m.category,
				match: m.text,
				comment: entry.text.trim(),
			});
		}
	}
	return findings;
}

export function trackedFiles(root: string): string[] {
	const out = execFileSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return out.split("\0").filter((file) => file && kindOf(file));
}

export function main(argv: string[]): number {
	const root = path.resolve(import.meta.dirname, "..");
	const files = argv.length > 0 ? argv : trackedFiles(root);
	const findings: Finding[] = [];
	let scanned = 0;
	for (const file of files) {
		const full = path.resolve(root, file);
		if (!existsSync(full)) continue;
		scanned++;
		findings.push(...findIssues(file, readFileSync(full, "utf8")));
	}
	for (const f of findings)
		console.log(
			`${f.file}:${f.line}: ${f.category} "${f.match}"  ${f.comment.slice(0, 160)}`,
		);
	if (findings.length > 0) {
		const fileCount = new Set(findings.map((f) => f.file)).size;
		console.error(
			`check:comments: ${findings.length} finding(s) in ${fileCount} file(s)`,
		);
		return 1;
	}
	console.log(`check:comments: no findings (${scanned} files scanned)`);
	return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
