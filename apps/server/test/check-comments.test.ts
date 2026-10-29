import { describe, expect, it } from "vitest";
import {
	findIssues,
	kindOf,
	REQUIREMENT_PREFIXES,
} from "../../../scripts/check-comments.ts";

type Hit = [line: number, category: string, match: string];
type Case = [name: string, file: string, source: string, expected: Hit[]];

const hits = (file: string, source: string): Hit[] =>
	findIssues(file, source).map((f) => [f.line, f.category, f.match]);

const PRODUCT_VERSIONS = [
	"Node 24",
	"React 19",
	"Postgres 17",
	"Playwright 1.64",
	"TypeScript 7",
	"Vite 8",
	"Vitest 5",
	"Tailwind 4",
	"Zod 4",
	"Muse Spark 1.3",
	"Node >=24",
];

const flagged: Case[] = [
	// Dates
	[
		"an ISO date",
		"a.ts",
		"// pulled 2026-10-22\n",
		[[1, "date", "2026-10-22"]],
	],
	[
		"day, month name, year",
		"a.ts",
		"// since 24 Oct 2026\n",
		[[1, "date", "24 Oct 2026"]],
	],
	[
		"month name, day, year",
		"a.ts",
		"/* October 24, 2026 */\n",
		[[1, "date", "October 24, 2026"]],
	],
	["month name and day", "a.ts", "// due Oct 24\n", [[1, "date", "Oct 24"]]],
	["the first bare year", "a.ts", "// since 2020\n", [[1, "date", "2020"]]],
	["the last bare year", "a.ts", "// until 2039\n", [[1, "date", "2039"]]],

	// Versions
	["a v-prefixed version", "a.ts", "// needs v1.2\n", [[1, "version", "v1.2"]]],
	[
		"a three-part version",
		"a.ts",
		"// pinned 1.2.3\n",
		[[1, "version", "1.2.3"]],
	],
	[
		"an image tag",
		"a.ts",
		"// from node:24-slim\n",
		[[1, "version", "node:24-slim"]],
	],
	...PRODUCT_VERSIONS.map(
		(product): Case => [
			`the product version "${product}"`,
			"a.ts",
			`// runs on ${product}\n`,
			[[1, "version", product]],
		],
	),

	// Internal planning references
	["a decision ID", "a.ts", "// (D-007)\n", [[1, "decision", "D-007"]]],
	[
		"a foundational decision ID",
		"a.ts",
		"// FD-1\n",
		[[1, "decision", "FD-1"]],
	],
	["an open question ID", "a.ts", "// OQ-1\n", [[1, "decision", "OQ-1"]]],
	[
		"a release decision ID",
		"a.ts",
		"// D-REL-1\n",
		[[1, "decision", "D-REL-1"]],
	],
	...REQUIREMENT_PREFIXES.map(
		(prefix): Case => [
			`the requirement ID ${prefix}-12`,
			"a.ts",
			`// ${prefix}-12\n`,
			[[1, "requirement", `${prefix}-12`]],
		],
	),
	["the first milestone", "a.ts", "// M0 only\n", [[1, "milestone", "M0"]]],
	["the last milestone", "a.ts", "// after M9\n", [[1, "milestone", "M9"]]],
	["a day of the schedule", "a.ts", "// Day 3\n", [[1, "schedule", "Day 3"]]],
	["a phase", "a.ts", "// phase C\n", [[1, "schedule", "phase C"]]],
	["a gate", "a.ts", "// Gate D\n", [[1, "schedule", "Gate D"]]],
	["an agent letter", "a.ts", "// Agent G\n", [[1, "agent", "Agent G"]]],
	[
		"several findings in one comment",
		"a.ts",
		"// D-007, founder 2026-10-26\n",
		[
			[1, "decision", "D-007"],
			[1, "date", "2026-10-26"],
		],
	],

	// Pointers into documentation that is not published
	[
		"a path into the docs folder",
		"a.ts",
		"// see docs/ENVIRONMENT.md\n",
		[[1, "doc", "docs/ENVIRONMENT.md"]],
	],
	[
		"a docs path with a section",
		"a.ts",
		"// (docs/AGENT_WORKFLOWS.md §17)\n",
		[[1, "doc", "docs/AGENT_WORKFLOWS.md §17"]],
	],
	[
		"the project instructions file",
		"a.ts",
		"// CLAUDE.md rule 3\n",
		[[1, "doc", "CLAUDE.md"]],
	],
	[
		"a document name with a section",
		"a.ts",
		"// (MCP_SPEC §8)\n",
		[[1, "doc", "MCP_SPEC §8"]],
	],
	[
		"bare section signs",
		"a.ts",
		"// per §7, §8\n",
		[
			[1, "doc", "§7"],
			[1, "doc", "§8"],
		],
	],
	[
		"the master prompt",
		"a.ts",
		"// the master prompt\n",
		[[1, "doc", "master prompt"]],
	],

	// Comment syntaxes and scanner edge cases
	[
		"a SQL line comment",
		"a.sql",
		"-- M1\nSELECT 1;\n",
		[[1, "milestone", "M1"]],
	],
	[
		"a SQL block comment after a string",
		"a.sql",
		"SELECT '--'; /* D-007 */\n",
		[[1, "decision", "D-007"]],
	],
	[
		"the right line of a block comment",
		"a.ts",
		"/**\n * First line.\n * Second line, D-007.\n */\nexport const x = 1;\n",
		[[3, "decision", "D-007"]],
	],
	[
		"a trailing comment",
		"a.ts",
		"const x = 1; // M2\n",
		[[1, "milestone", "M2"]],
	],
	[
		"an inline block comment",
		"a.ts",
		"const x = /* M3 */ 1;\n",
		[[1, "milestone", "M3"]],
	],
	[
		"a JSX comment",
		"a.tsx",
		"const x = <div>{/* M1 */}</div>;\n",
		[[1, "milestone", "M1"]],
	],
	[
		"a comment after a division",
		"a.ts",
		"const x = a / b; // M1\n",
		[[1, "milestone", "M1"]],
	],
	[
		"a comment after a regex literal",
		"a.ts",
		"const re = /a\\/b/g; // M1\n",
		[[1, "milestone", "M1"]],
	],
	[
		"a comment inside a template expression",
		"a.ts",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source code containing a template literal
		"const s = `x ${/* M1 */ y} z`;\n",
		[[1, "milestone", "M1"]],
	],
	[
		"a comment with quotes in it",
		"a.ts",
		'// don\'t "quote" M1\n',
		[[1, "milestone", "M1"]],
	],
	[
		"a comment after an unterminated string",
		"a.ts",
		"const a = 'oops\n// M1\n",
		[[2, "milestone", "M1"]],
	],
	[
		"a phrase wrapped over two lines",
		"a.ts",
		"// runs on Node\n// 24 only\n",
		[[1, "version", "Node 24"]],
	],
	[
		"CRLF line endings",
		"a.ts",
		"// fine\r\n// M1\r\n",
		[[2, "milestone", "M1"]],
	],
	[
		"a CSS comment",
		"a.css",
		"a { color: red; } /* since 2024 */\n",
		[[1, "date", "2024"]],
	],
	[
		"an HTML comment",
		"a.html",
		"<p>hi</p>\n<!-- D-007 -->\n",
		[[2, "decision", "D-007"]],
	],
	[
		"comments inside inline script and style",
		"a.html",
		"<script>\n// M1\n</script>\n<style>\n/* M2 */\n</style>\n",
		[
			[2, "milestone", "M1"],
			[5, "milestone", "M2"],
		],
	],
	[
		"a YAML comment",
		"ci.yml",
		"key: value # D-007\n",
		[[1, "decision", "D-007"]],
	],
	[
		"a Compose comment",
		"docker-compose.yml",
		"# M0 (D-005)\nservices: {}\n",
		[
			[1, "milestone", "M0"],
			[1, "decision", "D-005"],
		],
	],
	["a shell comment", "run.sh", "echo hi # M1\n", [[1, "milestone", "M1"]]],
	[
		"a dotenv comment",
		".env.example",
		"# Phase C settings\nKEY=1\n",
		[[1, "schedule", "Phase C"]],
	],
	[
		"a gitignore comment",
		".gitignore",
		"# 2026 scratch\ndist/\n",
		[[1, "date", "2026"]],
	],
	[
		"a nested gitignore",
		"apps/web/.gitignore",
		"# M1\n",
		[[1, "milestone", "M1"]],
	],
	[
		"a gitattributes comment",
		".gitattributes",
		"# D-007\n",
		[[1, "decision", "D-007"]],
	],
	[
		"PowerShell line and block comments",
		"x.ps1",
		"# D-007\n<# M1 #>\n",
		[
			[1, "decision", "D-007"],
			[2, "milestone", "M1"],
		],
	],
];

const clean: Array<[name: string, file: string, source: string]> = [
	[
		"a URL in a double-quoted string",
		"a.ts",
		'const u = "https://example.com/D-007"; // ok\n',
	],
	[
		"a URL in a single-quoted string",
		"a.ts",
		"const u = 'http://x/2026'; // ok\n",
	],
	[
		"comment markers in template text",
		"a.ts",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source code containing a template literal
		"const s = `// M1 ${a} /* D-007 */`;\n",
	],
	[
		"comment markers in a regex literal",
		"a.ts",
		"const re = /https?:\\/\\/D-007/;\n",
	],
	["a slash inside a regex character class", "a.ts", "const re = /[/]M1/;\n"],
	["an escaped quote inside a string", "a.ts", 'const s = "a\\" // M1";\n'],
	[
		"references in code, not comments",
		"a.ts",
		"const D_007 = 1;\nconst M1 = 2;\nconst node24 = 3;\nlet v1 = 4;\n",
	],
	[
		"numbers that are not versions",
		"a.ts",
		"// 1.5 s on 127.0.0.1:8787, UTF-8, SHA-256, 2048 bytes\n",
	],
	["years outside the range", "a.ts", "// 1999, 2019, 2040, 12026\n"],
	["month words without a day", "a.ts", "// it may need 5 retries in March\n"],
	["the lowercase word node", "a.ts", "// the graph node 3 hops away\n"],
	[
		"version identifiers without a dot",
		"a.ts",
		"// normalize_bug_report.v1 and /api/v1/ routes\n",
	],
	["a docs URL in a comment", "a.ts", "// https://example.com/docs/intro\n"],
	["the word docs", "a.ts", "// the docs folder\n"],
	["dashes inside SQL strings", "a.sql", "SELECT '-- 2026', \"x--2026\";\n"],
	["a file kind that is not scanned", "README.md", "// 2026 D-007\n"],
	["a JSON file", "package.json", "// 2026\n"],
	[
		"a quoted hash in shell",
		"run.sh",
		'echo "a # 2026"\necho $# done\nx=a#2026\n',
	],
	[
		"a hash that does not follow whitespace in YAML",
		"ci.yml",
		"url: http://x/#2026\nname: 'a # 2026'\n",
	],
	["a hash in the middle of a gitignore line", ".gitignore", "foo#2026\n"],
	[
		"comment markers in a CSS string",
		"a.css",
		'a::after { content: "/* 2026 */"; }\n',
	],
	[
		"slashes in a CSS url",
		"a.css",
		"a { background: url(//cdn.example.com/2026.png); }\n",
	],
	["text outside HTML comments", "a.html", "<p>2026 D-007</p>\n"],
];

describe("check-comments", () => {
	it.each(flagged)("flags %s", (_name, file, source, expected) => {
		expect(hits(file, source)).toEqual(expected);
	});

	it.each(clean)("does not flag %s", (_name, file, source) => {
		expect(hits(file, source)).toEqual([]);
	});

	it("reports the comment text and the file", () => {
		const [finding] = findIssues(
			"src/a.ts",
			"const x = 1;\n  // see M1 here\n",
		);
		expect(finding).toEqual({
			file: "src/a.ts",
			line: 2,
			category: "milestone",
			match: "M1",
			comment: "see M1 here",
		});
	});

	it("knows which tracked files to scan", () => {
		for (const file of [
			"a.ts",
			"b.tsx",
			"c.js",
			"d.mjs",
			"e.cjs",
			"f.css",
			"g.html",
			"g.sql",
			"h.yml",
			"i.yaml",
			"j.sh",
			"k.ps1",
			".env.example",
			".gitignore",
			".gitattributes",
			"docker-compose.yml",
			"apps/web/.gitignore",
		])
			expect(kindOf(file), file).toBeDefined();
		for (const file of [
			"README.md",
			"package.json",
			"notes.txt",
			".env",
			"LICENSE",
		])
			expect(kindOf(file), file).toBeUndefined();
	});
});
