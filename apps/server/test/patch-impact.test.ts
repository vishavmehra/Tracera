import { PatchImpactResultSchema } from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../src/modules/graph-build.ts";
import { checkSuppliedDiff } from "../src/modules/patch-analysis.ts";
import {
	analyzePatch,
	confidenceOf,
	type DiffEntry,
	declarationHeader,
	diffSections,
	type GraphView,
	type PatchInput,
	parseNameStatus,
	parseNumstat,
	renderPatchImpactMarkdown,
	severityOf,
} from "../src/modules/patch-impact.ts";

// Patch impact [pure, static graph]: what a diff changes, what that reaches, and which tests are
// linked to it. Graphs are built by hand so every expected finding can be traced to an edge.

const node = (
	key: string,
	kind: string,
	name: string,
	path: string | null,
	lines: [number, number] | null = null,
	attributes: Record<string, unknown> = {},
): GraphNode => ({
	key,
	kind,
	name,
	path,
	start_line: lines?.[0] ?? null,
	end_line: lines?.[1] ?? null,
	language: null,
	attributes,
	provenance: {},
});
const edge = (
	kind: string,
	from: string,
	to: string | null,
	certainty: GraphEdge["certainty"] = "resolved",
	provenance: Record<string, unknown> = {},
	targetText: string | null = null,
): GraphEdge => ({
	kind,
	from,
	to,
	target_text: targetText,
	certainty,
	provenance,
});
const file = (
	path: string,
	options: {
		test?: boolean;
		parsed?: boolean;
		pkg?: string | null;
		unresolved?: number;
	} = {},
) =>
	node(
		`file:${path}`,
		options.test ? "test_file" : "file",
		path.split("/").pop() ?? path,
		path,
		null,
		{
			parsed: options.parsed ?? true,
			package: options.pkg ?? null,
			...(options.unresolved ? { unresolved_calls: options.unresolved } : {}),
		},
	);
const sym = (
	path: string,
	name: string,
	kind: string,
	lines: [number, number],
	exported = false,
) => node(`sym:${path}#${name}`, kind, name, path, lines, { exported });
const testCase = (path: string, name: string, lines: [number, number]) =>
	node(`test:${path}#${name}`, "test_case", name, path, lines);
const section = (path: string, body: string[], headers: string[] = []) =>
	[
		`diff --git a/${path} b/${path}`,
		...headers,
		`--- a/${path}`,
		`+++ b/${path}`,
		...body,
	].join("\n");
const modified = (path: string, additions = 1, deletions = 1): DiffEntry => ({
	status: "modified",
	path,
	old_path: null,
	additions,
	deletions,
});
const input = (
	base: GraphView,
	head: GraphView,
	entries: DiffEntry[],
	diff: string,
	texts: { base?: Record<string, string>; head?: Record<string, string> } = {},
	options = { depth: 4, limit: 100 },
): PatchInput => ({
	base,
	head,
	baseRef: { ref: "main", sha: "a".repeat(40) },
	headRef: { ref: "feature", sha: "b".repeat(40), kind: "commit" },
	mergeBase: false,
	entries,
	sections: diffSections(diff),
	baseText: (path) => texts.base?.[path],
	headText: (path) => texts.head?.[path],
	options,
});

describe("diffSections", () => {
	const one = (body: string[]) => diffSections(section("src/a.js", body))[0];
	it.each([
		[
			"a modified line inside context",
			[
				"@@ -10,7 +10,7 @@ export function f() {",
				" a",
				" b",
				" c",
				"-old",
				"+new",
				" d",
				" e",
				" f",
			],
			[{ start: 13, end: 13 }],
			[{ start: 13, end: 13 }],
		],
		[
			"a pure insertion between two lines",
			["@@ -4,6 +4,8 @@", " a", " b", " c", "+x", "+y", " d", " e", " f"],
			[{ start: 7, end: 6 }],
			[{ start: 7, end: 8 }],
		],
		[
			"a deletion of two lines",
			["@@ -1,5 +1,3 @@", " a", "-b", "-c", " d", " e"],
			[{ start: 2, end: 3 }],
			[{ start: 2, end: 1 }],
		],
		[
			"two change blocks in one hunk",
			["@@ -1,6 +1,6 @@", "-a", "+A", " b", " c", "-d", "+D", " e"],
			[
				{ start: 1, end: 1 },
				{ start: 4, end: 4 },
			],
			[
				{ start: 1, end: 1 },
				{ start: 4, end: 4 },
			],
		],
		[
			"a removed SQL comment that looks like a file header",
			["@@ -2,3 +2,2 @@", " a", "--- old comment", " b"],
			[{ start: 3, end: 3 }],
			[{ start: 3, end: 2 }],
		],
		[
			"a change at a missing final newline",
			[
				"@@ -3 +3 @@",
				"-end",
				"\\ No newline at end of file",
				"+END",
				"\\ No newline at end of file",
			],
			[{ start: 3, end: 3 }],
			[{ start: 3, end: 3 }],
		],
	])("%s", (_name, body, base, head) => {
		expect(one(body)).toEqual({ base, head, binary: false });
	});

	it("keeps one section per file in diff order and flags binary files", () => {
		const diff = [
			section("src/a.js", ["@@ -1,2 +1,2 @@", "-a", "+b", " c"]),
			"diff --git a/logo.png b/logo.png\nnew file mode 100644\nBinary files /dev/null and b/logo.png differ",
			"diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+x\n+y",
		].join("\n");
		expect(diffSections(diff)).toEqual([
			{
				base: [{ start: 1, end: 1 }],
				head: [{ start: 1, end: 1 }],
				binary: false,
			},
			{ base: [], head: [], binary: true },
			{
				base: [{ start: 1, end: 0 }],
				head: [{ start: 1, end: 2 }],
				binary: false,
			},
		]);
	});
});

describe("git list parsing", () => {
	it("reads name-status records with renames and copies", () => {
		expect(
			parseNameStatus(
				"M\0a.ts\0R087\0old name.ts\0new name.ts\0A\0b.ts\0D\0c.ts\0C100\0d.ts\0e.ts\0",
			),
		).toEqual([
			{ status: "modified", path: "a.ts", old_path: null },
			{ status: "renamed", path: "new name.ts", old_path: "old name.ts" },
			{ status: "added", path: "b.ts", old_path: null },
			{ status: "deleted", path: "c.ts", old_path: null },
			{ status: "copied", path: "e.ts", old_path: "d.ts" },
		]);
	});

	it("reads numstat records, with binary files as unknown counts", () => {
		expect(
			parseNumstat(
				"1\t2\ta.ts\0" + "3\t0\t\0old.ts\0new.ts\0" + "-\t-\timg.png\0",
			),
		).toEqual([
			{ additions: 1, deletions: 2 },
			{ additions: 3, deletions: 0 },
			{ additions: null, deletions: null },
		]);
	});
});

describe("declarationHeader", () => {
	const header = (kind: string, text: string) =>
		declarationHeader(
			text,
			node("k", kind, "x", "a.ts", [1, text.split("\n").length]),
		);
	it.each([
		[
			"function",
			"export function f(a, { b = 1 } = {}) {\n\treturn a;\n}",
			"export function f(a, { b = 1 } = {})",
		],
		[
			"variable",
			"export const g = async (x) => {\n\treturn x;\n};",
			"export const g = async (x)",
		],
		[
			"class",
			"export class A extends B {\n\tm() {}\n}",
			"export class A extends B",
		],
		[
			"interface",
			"export interface P {\n\tid: string;\n}",
			"export interface P { id: string; }",
		],
		["variable", "export const LIMIT = 50;", null],
	])("%s: %s", (kind, text, expected) => {
		expect(header(kind, text)).toBe(expected);
	});
});

describe("severity and confidence are separate rules", () => {
	it.each([
		[
			{
				originChange: "removed",
				depth: 1,
				crossesPackage: false,
				criticalPath: false,
				observed: false,
			},
			"high",
		],
		[
			{
				originChange: "signature_changed",
				depth: 2,
				crossesPackage: false,
				criticalPath: false,
				observed: false,
			},
			"medium",
		],
		[
			{
				originChange: "modified",
				depth: 1,
				crossesPackage: true,
				criticalPath: false,
				observed: false,
			},
			"medium",
		],
		[
			{
				originChange: "modified",
				depth: 3,
				crossesPackage: false,
				criticalPath: true,
				observed: false,
			},
			"medium",
		],
		[
			{
				originChange: "modified",
				depth: 1,
				crossesPackage: false,
				criticalPath: false,
				observed: false,
			},
			"low",
		],
		[
			{
				originChange: "modified",
				depth: 1,
				crossesPackage: false,
				criticalPath: false,
				observed: true,
			},
			"high",
		],
	])("severity %o → %s", (inputs, expected) => {
		expect(severityOf(inputs)).toBe(expected);
	});

	it.each([
		[
			{
				observed: false,
				certainty: "resolved",
				fileLevel: false,
				dataBridge: false,
			},
			"high",
		],
		[
			{
				observed: false,
				certainty: "heuristic",
				fileLevel: false,
				dataBridge: false,
			},
			"low",
		],
		[
			{
				observed: false,
				certainty: "resolved",
				fileLevel: true,
				dataBridge: false,
			},
			"medium",
		],
		[
			{
				observed: false,
				certainty: "exact",
				fileLevel: false,
				dataBridge: true,
			},
			"low",
		],
		[
			{
				observed: true,
				certainty: "heuristic",
				fileLevel: false,
				dataBridge: false,
			},
			"high",
		],
	])("confidence %o → %s", (inputs, expected) => {
		expect(confidenceOf(inputs)).toBe(expected);
	});
});

// ---- A two-package repository and a multi-file patch ------------------------------------------

const BASE_PRICING = [
	"export const FREE = 5000;",
	"",
	"export function shippingCents(subtotal) {",
	"\tif (subtotal >= FREE) return 0;",
	"\treturn 499;",
	"}",
	"",
	"export function round(x) {",
	"\treturn Math.round(x);",
	"}",
].join("\n");
const HEAD_PRICING = [
	"export const FREE = 5000;",
	"",
	"export function shippingCents(subtotal, region) {",
	"\tif (subtotal >= FREE) return 0;",
	'\treturn region === "eu" ? 599 : 499;',
	"}",
].join("\n");
const API = (body: string) =>
	[
		"export function submitOrder(order) {",
		"\tvalidate(order);",
		body,
		"}",
	].join("\n");

const common = [
	node("pkg:server", "package", "server", "server/package.json"),
	node("pkg:web", "package", "web", "web/package.json"),
	file("server/pricing.ts", { pkg: "pkg:server" }),
	sym("server/pricing.ts", "FREE", "variable", [1, 1], true),
	sym("server/pricing.ts", "shippingCents", "function", [3, 6], true),
	file("server/orders.ts", { pkg: "pkg:server" }),
	sym("server/orders.ts", "createOrder", "function", [1, 10], true),
	sym("server/orders.ts", "loadOrder", "function", [12, 15], true),
	file("server/index.ts", { pkg: "pkg:server" }),
	file("server/jobs.ts", { pkg: "pkg:server" }),
	sym("server/jobs.ts", "nightly", "function", [1, 5]),
	file("server/routes.ts", { pkg: "pkg:server" }),
	node(
		"route:POST /api/orders",
		"route",
		"POST /api/orders",
		"server/routes.ts",
		[4, 4],
	),
	file("web/api.ts", { pkg: "pkg:web" }),
	sym("web/api.ts", "submitOrder", "function", [1, 4], true),
	file("web/Checkout.tsx", { pkg: "pkg:web" }),
	sym("web/Checkout.tsx", "Checkout", "ui_component", [1, 20], true),
	file("web/Summary.tsx", { pkg: "pkg:web" }),
	file("web/package.json", { parsed: false, pkg: "pkg:web" }),
	file("server/legacy.py", { parsed: false, pkg: "pkg:server" }),
	file("server/pricing.test.ts", { test: true, pkg: "pkg:server" }),
	testCase("server/pricing.test.ts", "computes shipping", [3, 6]),
	file("server/orders.test.ts", { test: true, pkg: "pkg:server" }),
	testCase("server/orders.test.ts", "creates an order", [3, 8]),
	node("table:orders", "db_table", "orders", null),
	node("dep:react", "dependency", "react", null),
];
const commonEdges = [
	edge(
		"CALLS",
		"sym:server/orders.ts#createOrder",
		"sym:server/pricing.ts#shippingCents",
		"resolved",
		{
			path: "server/orders.ts",
			start_line: 4,
			method: "import_binding",
		},
	),
	edge(
		"ROUTES_TO",
		"route:POST /api/orders",
		"sym:server/orders.ts#createOrder",
		"resolved",
		{
			path: "server/routes.ts",
			start_line: 4,
		},
	),
	edge(
		"SENDS_REQUEST_TO",
		"sym:web/api.ts#submitOrder",
		"route:POST /api/orders",
	),
	edge("CALLS", "sym:web/Checkout.tsx#Checkout", "sym:web/api.ts#submitOrder"),
	// A guessed link: it may carry the change, but never as confirmed evidence.
	edge(
		"CALLS",
		"sym:server/jobs.ts#nightly",
		"sym:server/pricing.ts#shippingCents",
		"heuristic",
	),
	// graph-build emits DEFINES for every top-level symbol; a barrel's chain goes through it.
	edge(
		"DEFINES",
		"file:server/pricing.ts",
		"sym:server/pricing.ts#shippingCents",
		"exact",
	),
	edge(
		"RE_EXPORTS",
		"file:server/index.ts",
		"file:server/pricing.ts",
		"resolved",
		{
			path: "server/index.ts",
			start_line: 1,
			names: ["shippingCents"],
		},
	),
	// Imports the barrel for other names: not a user of shippingCents.
	edge("IMPORTS", "file:web/Summary.tsx", "file:server/index.ts"),
	edge("READS_FROM", "sym:server/orders.ts#loadOrder", "table:orders"),
	edge(
		"TESTS",
		"test:server/pricing.test.ts#computes shipping",
		"sym:server/pricing.ts#shippingCents",
	),
	edge("TESTS", "file:server/pricing.test.ts", "file:server/pricing.ts"),
	edge(
		"TESTS",
		"test:server/orders.test.ts#creates an order",
		"sym:server/orders.ts#createOrder",
	),
	edge(
		"CONTAINS",
		"file:server/pricing.test.ts",
		"test:server/pricing.test.ts#computes shipping",
		"exact",
	),
	edge(
		"CONTAINS",
		"file:server/orders.test.ts",
		"test:server/orders.test.ts#creates an order",
		"exact",
	),
	edge("DEPENDS_ON", "pkg:web", "dep:react", "exact", {
		range: "18.3.1",
		scope: "runtime",
	}),
];
const BASE: GraphView = {
	nodes: [
		...common,
		sym("server/pricing.ts", "round", "function", [8, 10], true),
		file("docs/README.md", { parsed: false }),
	],
	edges: [
		...commonEdges,
		edge(
			"CALLS",
			"sym:server/orders.ts#createOrder",
			"sym:server/pricing.ts#round",
		),
	],
	complete: false,
};
const HEAD: GraphView = {
	nodes: [
		...common,
		file("docs/GUIDE.md", { parsed: false }),
		testCase("server/pricing.test.ts", "charges eu shipping", [8, 10]),
		file("server/migrations/0002.sql", { pkg: "pkg:server" }),
		node("dep:zod", "dependency", "zod", null),
	],
	edges: [
		...commonEdges,
		// round was removed, but createOrder still calls it: the call no longer resolves.
		edge(
			"CALLS",
			"sym:server/orders.ts#createOrder",
			null,
			"unresolved",
			{ path: "server/orders.ts", start_line: 6 },
			"round",
		),
		edge(
			"TESTS",
			"test:server/pricing.test.ts#charges eu shipping",
			"sym:server/pricing.ts#shippingCents",
		),
		edge(
			"CONTAINS",
			"file:server/pricing.test.ts",
			"test:server/pricing.test.ts#charges eu shipping",
			"exact",
		),
		edge(
			"WRITES_TO",
			"file:server/migrations/0002.sql",
			"table:orders",
			"exact",
			{
				path: "server/migrations/0002.sql",
				start_line: 1,
				statement: "alter",
				schema_change: true,
			},
		),
		edge("DEPENDS_ON", "pkg:web", "dep:zod", "exact", {
			range: "4.0.0",
			scope: "runtime",
		}),
	],
	complete: false,
};
const ENTRIES: DiffEntry[] = [
	modified("server/pricing.ts", 2, 6),
	modified("web/api.ts"),
	modified("server/legacy.py"),
	{
		status: "renamed",
		path: "docs/GUIDE.md",
		old_path: "docs/README.md",
		additions: 0,
		deletions: 0,
	},
	modified("web/package.json", 1, 0),
	{
		status: "added",
		path: "server/migrations/0002.sql",
		old_path: null,
		additions: 1,
		deletions: 0,
	},
	modified("server/pricing.test.ts", 5, 1),
	{
		status: "added",
		path: "assets/logo.png",
		old_path: null,
		additions: null,
		deletions: null,
	},
];
const DIFF = [
	section("server/pricing.ts", [
		"@@ -3,8 +3,4 @@",
		"-export function shippingCents(subtotal) {",
		"+export function shippingCents(subtotal, region) {",
		" \tif (subtotal >= FREE) return 0;",
		"-\treturn 499;",
		'+\treturn region === "eu" ? 599 : 499;',
		" }",
		"-",
		"-export function round(x) {",
		"-\treturn Math.round(x);",
		"-}",
	]),
	section("web/api.ts", [
		"@@ -3 +3 @@",
		"-\treturn post(order);",
		"+\treturn post({ ...order, v: 2 });",
	]),
	section("server/legacy.py", ["@@ -1 +1 @@", "-x = 1", "+x = 2"]),
	"diff --git a/docs/README.md b/docs/GUIDE.md\nsimilarity index 100%\nrename from docs/README.md\nrename to docs/GUIDE.md",
	section("web/package.json", ["@@ -3,0 +4 @@", '+    "zod": "4.0.0",']),
	"diff --git a/server/migrations/0002.sql b/server/migrations/0002.sql\nnew file mode 100644\n--- /dev/null\n+++ b/server/migrations/0002.sql\n@@ -0,0 +1 @@\n+ALTER TABLE orders ADD COLUMN region text;",
	section("server/pricing.test.ts", [
		"@@ -4 +4 @@",
		"-\texpect(shippingCents(10)).toBe(499);",
		'+\texpect(shippingCents(10, "us")).toBe(499);',
		"@@ -6,0 +7,4 @@",
		"+",
		'+test("charges eu shipping", () => {',
		'+\texpect(shippingCents(10, "eu")).toBe(599);',
		"+});",
	]),
	"diff --git a/assets/logo.png b/assets/logo.png\nnew file mode 100644\nBinary files /dev/null and b/assets/logo.png differ",
].join("\n");
const TEXTS = {
	base: {
		"server/pricing.ts": BASE_PRICING,
		"web/api.ts": API("\treturn post(order);"),
	},
	head: {
		"server/pricing.ts": HEAD_PRICING,
		"web/api.ts": API("\treturn post({ ...order, v: 2 });"),
	},
};

describe("analyzePatch over a multi-file patch", () => {
	const result = analyzePatch(input(BASE, HEAD, ENTRIES, DIFF, TEXTS));
	const finding = (key: string) =>
		result.findings.find((f) => f.target.key === key);

	it("produces output that matches the published schema, deterministically", () => {
		expect(() => PatchImpactResultSchema.parse(result)).not.toThrow();
		expect(analyzePatch(input(BASE, HEAD, ENTRIES, DIFF, TEXTS))).toEqual(
			result,
		);
	});

	it("classifies every changed file, with parse status and categories", () => {
		expect(
			result.files.map((f) => [
				f.path,
				f.status,
				f.category,
				f.parse.base,
				f.parse.head,
			]),
		).toEqual([
			["server/pricing.ts", "modified", "source", "parsed", "parsed"],
			["web/api.ts", "modified", "source", "parsed", "parsed"],
			[
				"server/legacy.py",
				"modified",
				"source",
				"unsupported_language",
				"unsupported_language",
			],
			[
				"docs/GUIDE.md",
				"renamed",
				"docs",
				"unsupported_language",
				"unsupported_language",
			],
			[
				"web/package.json",
				"modified",
				"manifest",
				"unsupported_language",
				"unsupported_language",
			],
			["server/migrations/0002.sql", "added", "migration", "absent", "parsed"],
			["server/pricing.test.ts", "modified", "test", "parsed", "parsed"],
			["assets/logo.png", "added", "other", "absent", "binary"],
		]);
		expect(result.files[3]?.old_path).toBe("docs/README.md");
		expect(result.summary).toMatchObject({
			files: 8,
			added: 2,
			modified: 5,
			renamed: 1,
			deleted: 0,
			binary: 1,
			symbols: {
				removed: 1,
				signature_changed: 1,
				modified: 1,
				added: 0,
				export_changed: 0,
			},
		});
		// No changed line falls outside a symbol in the code files that were parsed.
		expect(result.files.flatMap((f) => f.unattributed)).toEqual([]);
	});

	it("names changed symbols, with the declaration before and after a signature change", () => {
		expect(
			result.symbols.map((s) => [s.name, s.change, s.exported, s.tests]),
		).toEqual([
			["round", "removed", true, "relevant"],
			["shippingCents", "signature_changed", true, "relevant"],
			["submitOrder", "modified", true, "none_identified"],
		]);
		expect(result.symbols[1]?.signature).toEqual({
			before: "export function shippingCents(subtotal)",
			after: "export function shippingCents(subtotal, region)",
		});
		expect(result.test_changes).toEqual([
			{
				name: "computes shipping",
				path: "server/pricing.test.ts",
				change: "modified",
			},
			{
				name: "charges eu shipping",
				path: "server/pricing.test.ts",
				change: "added",
			},
		]);
		expect(result.manifest_changes).toEqual([
			{
				path: "web/package.json",
				dependency: "zod",
				change: "added",
				scope: "runtime",
				before: null,
				after: "4.0.0",
			},
		]);
		expect(result.schema_changes).toEqual([
			{
				table: "table:orders",
				path: "server/migrations/0002.sql",
				line: 1,
				statement: "alter",
			},
		]);
	});

	it("reports a removed function that code still calls as an observed broken reference", () => {
		expect(result.findings[0]).toMatchObject({
			id: "F1",
			target: { key: "sym:server/orders.ts#createOrder" },
			origin: { name: "round", change: "removed" },
			observed: true,
			severity: "high",
			confidence: "high",
			// It is also reached by the signature change, which stays visible.
			also_from: ["sym:server/pricing.ts#shippingCents"],
		});
		expect(result.findings[0]?.chain[0]).toMatchObject({
			kind: "CALLS",
			to: "unresolved:round",
		});
	});

	it("follows re-exports, routes, clients, and data, and explains each finding with its chain", () => {
		expect(finding("file:server/index.ts")).toMatchObject({
			origin: { name: "shippingCents", change: "signature_changed" },
			depth: 1,
			severity: "high",
			confidence: "high",
			chain: [
				{
					kind: "DEFINES",
					from: "file:server/pricing.ts",
					to: "sym:server/pricing.ts#shippingCents",
				},
				{
					kind: "RE_EXPORTS",
					from: "file:server/index.ts",
					to: "file:server/pricing.ts",
				},
			],
		});
		// Users of a symbol through a barrel have symbol-level edges; the barrel's importers do not.
		expect(finding("file:web/Summary.tsx")).toBeUndefined();
		expect(finding("sym:server/orders.ts#loadOrder")).toMatchObject({
			origin: { key: "table:orders", change: "schema_changed" },
			reason: "reads orders",
			severity: "high",
		});
		// A client in another package, three links away from the removed function.
		expect(finding("sym:web/api.ts#submitOrder")).toMatchObject({
			depth: 3,
			crosses_package: true,
			critical_path: true,
			severity: "medium",
			confidence: "high",
		});
		expect(
			finding("sym:web/api.ts#submitOrder")?.chain.map((l) => l.kind),
		).toEqual(["CALLS", "ROUTES_TO", "SENDS_REQUEST_TO"]);
		// Reached from three changes; the closest one explains it.
		expect(finding("sym:web/Checkout.tsx#Checkout")).toMatchObject({
			origin: { name: "submitOrder" },
			depth: 1,
			also_from: [
				"sym:server/pricing.ts#shippingCents",
				"sym:server/pricing.ts#round",
			],
		});
	});

	it("keeps a guessed link at low confidence even when the change would matter", () => {
		expect(finding("sym:server/jobs.ts#nightly")).toMatchObject({
			certainty: "heuristic",
			severity: "high",
			confidence: "low",
		});
		expect(result.risk.evidenced.findings).not.toContain(
			finding("sym:server/jobs.ts#nightly")?.id,
		);
		expect(result.risk.plausible.findings).toContain(
			finding("sym:server/jobs.ts#nightly")?.id,
		);
	});

	it("ranks by severity, then confidence, then distance", () => {
		expect(
			result.findings.map((f) => [
				f.id,
				f.target.name,
				f.severity,
				f.confidence,
			]),
		).toEqual([
			["F1", "createOrder", "high", "high"],
			["F2", "index.ts", "high", "high"],
			["F3", "loadOrder", "high", "high"],
			["F4", "nightly", "high", "low"],
			["F5", "Checkout", "medium", "high"],
			["F6", "POST /api/orders", "medium", "high"],
			["F7", "submitOrder", "medium", "high"],
		]);
	});

	it("separates relevant tests, untested changes, and unknown coverage", () => {
		const bySymbol = Object.fromEntries(
			result.tests.by_symbol.map((t) => [t.symbol, t]),
		);
		expect(
			bySymbol["sym:server/pricing.ts#shippingCents"]?.tests.map((t) => [
				t.name,
				t.state,
				t.distance,
			]),
		).toEqual([
			["charges eu shipping", "relevant", 1],
			["computes shipping", "relevant", 1],
			["creates an order", "relevant", 2],
		]);
		expect(bySymbol["sym:web/api.ts#submitOrder"]).toMatchObject({
			state: "none_identified",
		});
		expect(bySymbol["sym:web/api.ts#submitOrder"]?.reason).toMatch(/not proof/);
		expect(bySymbol["file:server/legacy.py"]).toMatchObject({
			state: "unknown",
		});
		expect(result.summary.tests).toEqual({
			relevant: 2,
			possible: 0,
			none_identified: 1,
			unknown: 1,
		});
		expect(result.tests.recommended.map((t) => t.name)).toEqual([
			"charges eu shipping",
			"computes shipping",
			"creates an order",
		]);
	});

	it("separates evidenced from plausible risk and ties every action to evidence or labels it a precaution", () => {
		expect(result.risk.evidenced).toEqual({
			severity: "high",
			findings: ["F1", "F2", "F3"],
		});
		expect(result.risk.plausible).toEqual({
			severity: "high",
			findings: ["F1", "F2", "F3", "F4"],
		});
		expect(result.risk.factors.join(" ")).toMatch(/contract/);
		for (const action of result.review_actions)
			expect(action.basis === "precaution" || action.refs.length > 0).toBe(
				true,
			);
		expect(result.review_actions.map((a) => a.action)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^Fix createOrder .*round/),
				expect.stringMatching(/^Add or point to a test for submitOrder/),
				expect.stringMatching(
					/^Check the tests for server\/legacy\.py by hand/,
				),
			]),
		);
	});

	it("never presents a partial analysis as complete, and says why", () => {
		expect(result.complete).toBe(false);
		expect(result.limitations.join(" ")).toMatch(
			/could not be analysed at the symbol level/,
		);
		const markdown = renderPatchImpactMarkdown(result);
		expect(markdown).toContain("**Partial analysis**");
		expect(markdown).toContain("## Tests for the changed behaviour");
		expect(markdown).toContain("(General precaution)");
	});
});

describe("analyzePatch edge cases", () => {
	const lib = "lib/m.ts";
	const libFile = (
		attributes: { unresolved?: number; parsed?: boolean } = {},
	) => [
		file(lib, { pkg: "pkg:lib" }),
		sym(lib, "formatTotal", "function", [1, 3], true),
		sym(lib, "parseTotal", "function", [5, 7], true),
		file("lib/m.test.ts", {
			test: true,
			pkg: "pkg:lib",
			parsed: attributes.parsed ?? true,
			unresolved: attributes.unresolved,
		}),
	];
	const otherTestNodes = [testCase("lib/m.test.ts", "parses totals", [1, 3])];
	const otherTestEdges = [
		edge("TESTS", "test:lib/m.test.ts#parses totals", `sym:${lib}#parseTotal`),
		edge("TESTS", "file:lib/m.test.ts", `file:${lib}`),
		edge(
			"CONTAINS",
			"file:lib/m.test.ts",
			"test:lib/m.test.ts#parses totals",
			"exact",
		),
	];
	const change = section(lib, ["@@ -2 +2 @@", "-\treturn a;", "+\treturn b;"]);
	const run = (nodes: GraphNode[], edges: GraphEdge[]) => {
		const graph = { nodes, edges, complete: true };
		return analyzePatch(input(graph, graph, [modified(lib)], change));
	};
	const state = (nodes: GraphNode[], edges: GraphEdge[]) =>
		run(nodes, edges).tests.by_symbol.find(
			(t) => t.symbol === `sym:${lib}#formatTotal`,
		);

	it("does not count a test of another function in the same module as covering the change", () => {
		expect(
			state([...libFile(), ...otherTestNodes], otherTestEdges),
		).toMatchObject({
			state: "none_identified",
			tests: [],
		});
	});

	it("calls a test file that imports the module but has unresolved calls only a possible test", () => {
		expect(
			state([...libFile({ unresolved: 2 }), ...otherTestNodes], otherTestEdges),
		).toMatchObject({
			state: "possible",
			tests: [{ name: "lib/m.test.ts", state: "possible" }],
		});
	});

	it("says coverage is unknown when a test file in the package could not be parsed", () => {
		expect(state(libFile({ parsed: false }), [])).toMatchObject({
			state: "unknown",
		});
	});

	it("treats a guessed link or a name match as a possible test, never a relevant one", () => {
		const guessed = state(
			[...libFile(), testCase("lib/m.test.ts", "renders", [1, 3])],
			[
				edge(
					"CALLS",
					"test:lib/m.test.ts#renders",
					`sym:${lib}#formatTotal`,
					"heuristic",
				),
			],
		);
		expect(guessed?.tests).toEqual([
			expect.objectContaining({
				name: "renders",
				state: "possible",
				via: expect.stringMatching(/guessed link/),
			}),
		]);
		const named = state(
			[
				...libFile(),
				testCase("lib/m.test.ts", "formatTotal handles zero", [1, 3]),
			],
			[],
		);
		expect(named?.tests).toEqual([
			expect.objectContaining({
				state: "possible",
				via: expect.stringMatching(/name only/),
			}),
		]);
	});

	it("walks cycles once and reports each dependent once", () => {
		const nodes = [
			...libFile(),
			file("lib/a.ts", { pkg: "pkg:lib" }),
			sym("lib/a.ts", "a", "function", [1, 3]),
		];
		const edges = [
			edge("CALLS", "sym:lib/a.ts#a", `sym:${lib}#formatTotal`),
			edge("CALLS", `sym:${lib}#formatTotal`, "sym:lib/a.ts#a"),
		];
		const result = run(nodes, edges);
		expect(result.findings.map((f) => [f.target.name, f.depth])).toEqual([
			["a", 1],
		]);
		expect(result.stats.truncated).toBe(false);
	});

	it("reports a removed route that clients still request", () => {
		const routes = "srv/routes.ts";
		const base = {
			nodes: [
				file(routes),
				node("route:GET /api/x", "route", "GET /api/x", routes, [2, 2]),
				sym("web/x.ts", "fetchX", "function", [1, 3]),
			],
			edges: [
				edge("SENDS_REQUEST_TO", "sym:web/x.ts#fetchX", "route:GET /api/x"),
			],
			complete: true,
		};
		const head = {
			nodes: [file(routes), sym("web/x.ts", "fetchX", "function", [1, 3])],
			edges: [],
			complete: true,
		};
		const result = analyzePatch(
			input(
				base,
				head,
				[modified(routes, 0, 1)],
				section(routes, ["@@ -2 +1,0 @@", '-app.get("/api/x", h);']),
			),
		);
		expect(result.route_changes).toEqual([
			{
				key: "route:GET /api/x",
				name: "GET /api/x",
				path: routes,
				change: "removed",
				clients: 1,
			},
		]);
		expect(result.findings[0]).toMatchObject({
			target: { name: "fetchX" },
			origin: { change: "route_removed" },
			severity: "high",
			graph: "base",
		});
	});

	it("handles an empty patch", () => {
		const graph = { nodes: [], edges: [], complete: true };
		const result = analyzePatch(input(graph, graph, [], ""));
		expect(result).toMatchObject({
			complete: true,
			findings: [],
			symbols: [],
			summary: { files: 0 },
		});
		expect(() => PatchImpactResultSchema.parse(result)).not.toThrow();
	});
});

describe("checkSuppliedDiff", () => {
	const ok = section("src/a.ts", ["@@ -1 +1 @@", "-a", "+b"]);
	it("accepts an ordinary diff", () => {
		expect(checkSuppliedDiff(ok)).toEqual({ ok: true, files: 1 });
	});
	it.each([
		[
			"a path that leaves the tree",
			ok.replaceAll("src/a.ts", "../escape.ts"),
			/Unsafe path/,
		],
		[
			"a path into .git",
			ok.replaceAll("src/a.ts", ".git/config"),
			/Unsafe path/,
		],
		[
			"an absolute path",
			"diff --git a/x b/x\n--- a/x\n+++ /etc/passwd\n@@ -1 +1 @@\n-a\n+b",
			/Unsafe path/,
		],
		[
			"a symbolic link",
			"diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+/etc",
			/symbolic links/,
		],
		[
			"a binary patch",
			"diff --git a/i b/i\nGIT binary patch\nliteral 1\nAA",
			/Binary patches/,
		],
		["text with no file sections", "just text", /No file changes/],
		[
			"more files than are analysed",
			Array.from({ length: 501 }, (_, i) =>
				ok.replaceAll("src/a.ts", `src/f${i}.ts`),
			).join("\n"),
			/501 files; at most 500/,
		],
	])("rejects %s", (_name, diff, message) => {
		const check = checkSuppliedDiff(diff);
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.errors.join(" ")).toMatch(message);
	});
});
