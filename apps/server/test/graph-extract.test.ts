import { describe, expect, it } from "vitest";
import {
	type GraphFileFacts,
	graphFactsFor,
	renderGraphFacts,
} from "../src/modules/graph.ts";
import {
	buildGraph,
	codeownersMatcher,
	docSections,
	type GraphInput,
	resolveSpecifier,
} from "../src/modules/graph-build.ts";
import {
	extractFile,
	type FileExtraction,
} from "../src/modules/graph-extract.ts";

const pricing = [
	"export const FREE_SHIPPING_CENTS = 5000;",
	"",
	"export function shippingCents(subtotal) {",
	"\treturn subtotal > FREE_SHIPPING_CENTS ? 0 : 499;",
	"}",
	"",
	"export function orderTotal(subtotal) {",
	"\treturn subtotal + shippingCents(subtotal);",
	"}",
].join("\n");
const pricingTest = [
	'import assert from "node:assert/strict";',
	'import { describe, test } from "node:test";',
	'import { orderTotal, shippingCents } from "../src/pricing.js";',
	"",
	'describe("shipping", () => {',
	'\ttest("free at the threshold", () => {',
	"\t\tassert.equal(shippingCents(5000), 0);",
	"\t});",
	"});",
	'test("totals", () => {',
	"\tassert.equal(orderTotal(100), 599);",
	"});",
].join("\n");

function input(
	files: Record<string, string>,
	extra: Partial<GraphInput> = {},
): GraphInput {
	const extractions = new Map<string, FileExtraction>();
	for (const [file, source] of Object.entries(files))
		if (/\.[cm]?[jt]sx?$/.test(file))
			extractions.set(file, extractFile(file, source));
	return {
		repositoryName: "demo",
		commitSha: "a".repeat(40),
		files: Object.entries(files).map(([file, source]) => ({
			path: file,
			size: source.length,
			object: `obj-${file}`,
		})),
		skipped: {},
		extractions,
		manifests: [],
		commits: [],
		codeowners: [],
		docs: [],
		limits: { truncatedFiles: [] },
		...extra,
	};
}
const edgesOf = (graph: ReturnType<typeof buildGraph>, kind: string) =>
	graph.edges
		.filter((edge) => edge.kind === kind)
		.map((edge) => `${edge.from} -> ${edge.to ?? `?${edge.target_text}`}`);

describe("extractFile", () => {
	it("records exported symbols with their line ranges", () => {
		const result = extractFile("src/pricing.js", pricing);
		expect(result.parse_error).toBeNull();
		expect(result.symbols).toEqual([
			expect.objectContaining({
				name: "FREE_SHIPPING_CENTS",
				kind: "variable",
				start_line: 1,
				end_line: 1,
				exported: true,
			}),
			expect.objectContaining({
				name: "shippingCents",
				kind: "function",
				start_line: 3,
				end_line: 5,
			}),
			expect.objectContaining({
				name: "orderTotal",
				kind: "function",
				start_line: 7,
				end_line: 9,
			}),
		]);
		expect(result.calls).toEqual([
			{ caller: "orderTotal", callee: "shippingCents", line: 8 },
		]);
		expect(result.references).toContainEqual({
			from: "shippingCents",
			name: "FREE_SHIPPING_CENTS",
			line: 4,
		});
	});

	it("names test cases with describe prefixes and records what they call", () => {
		const result = extractFile("test/pricing.test.js", pricingTest);
		expect(result.is_test_file).toBe(true);
		expect(result.tests).toEqual([
			{
				name: "shipping > free at the threshold",
				start_line: 6,
				end_line: 8,
				calls: ["shippingCents"],
			},
			{ name: "totals", start_line: 10, end_line: 12, calls: ["orderTotal"] },
		]);
	});

	it("does not link a call to a shadowed local of the same name", () => {
		const source = [
			"export function total(items) { return items.length; }",
			"export function report(total) {",
			"\treturn total(1);",
			"}",
		].join("\n");
		const result = extractFile("src/a.js", source);
		expect(result.calls).toEqual([]);
	});

	it("reports a parse error instead of throwing", () => {
		const result = extractFile("src/broken.js", "export function (");
		expect(result.parse_error).toEqual(expect.objectContaining({ line: 1 }));
		expect(result.symbols).toEqual([]);
	});

	it("handles TypeScript, JSX, require, re-exports, and dynamic imports", () => {
		const source = [
			'import type { Cart } from "./types";',
			'import { Row } from "./row";',
			'const fs = require("node:fs");',
			'export * from "./util";',
			"export interface Props { cart: Cart }",
			"export class Store implements Cart {",
			"\tload() { return 1; }",
			"}",
			"export function Table(props: Props) {",
			"\treturn <div><Row /></div>;",
			"}",
			'export async function later() { return import("./lazy"); }',
		].join("\n");
		const result = extractFile("src/table.tsx", source);
		expect(result.parse_error).toBeNull();
		expect(
			result.imports.map((entry) => [entry.specifier, entry.kind]),
		).toEqual([
			["./types", "type"],
			["./row", "static"],
			["node:fs", "require"],
			["./util", "reexport"],
			["./lazy", "dynamic"],
		]);
		expect(result.symbols.map((s) => [s.name, s.kind])).toEqual([
			["Props", "interface"],
			["Store", "class"],
			["Store.load", "method"],
			["Table", "ui_component"],
			["later", "function"],
		]);
		expect(result.renders).toEqual([
			{ from: "Table", component: "Row", line: 10 },
		]);
		expect(result.implements).toEqual([
			{ className: "Store", interfaceName: "Cart", line: 6 },
		]);
	});
});

describe("graphFactsFor", () => {
	it("lists definitions, users, and linked tests of a file, excluding its own references", () => {
		const graph = buildGraph(
			input({
				"src/pricing.js": pricing,
				"src/cart.js":
					'import { orderTotal } from "./pricing.js";\nexport function checkout(lines) { return orderTotal(lines); }\n',
				"test/pricing.test.js": pricingTest,
			}),
		);
		const [facts] = graphFactsFor(graph, ["src/pricing.js"]);
		expect(facts?.defines.map((d) => d.name)).toEqual([
			"FREE_SHIPPING_CENTS",
			"shippingCents",
			"orderTotal",
		]);
		expect(facts?.imported_by).toEqual(["src/cart.js", "test/pricing.test.js"]);
		expect(facts?.used_by).toEqual([
			{
				from: "src/cart.js#checkout",
				kind: "CALLS",
				target: "src/pricing.js#orderTotal",
			},
		]);
		expect(facts?.tests.map((t) => t.name)).toEqual([
			"(whole file)",
			"shipping > free at the threshold",
			"totals",
		]);
		const text = renderGraphFacts(
			facts as GraphFileFacts,
			"a".repeat(40),
			true,
		);
		expect(text).toMatch(/not proof of behavior/);
		expect(text).toContain(
			'test/pricing.test.js > "totals" (src/pricing.js#orderTotal)',
		);
	});
});

describe("resolveSpecifier", () => {
	const files = new Set(["src/a.ts", "src/b/index.js", "src/c.js"]);
	it.each([
		["src/x.ts", "./a.js", "src/a.ts"],
		["src/x.ts", "./b", "src/b/index.js"],
		["src/x.ts", "./c", "src/c.js"],
		["src/x.ts", "../outside", null],
		["src/x.ts", "../../escape", null],
		["src/x.ts", "react", null],
	])("%s imports %s", (importer, specifier, expected) => {
		expect(resolveSpecifier(importer, specifier, files)).toBe(expected);
	});
});

describe("codeownersMatcher", () => {
	it.each([
		["*.js", "src/a.js", true],
		["/src/", "src/a.js", true],
		["/src/", "lib/src/a.js", false],
		["docs/**", "docs/a/b.md", true],
		["apps/web", "apps/web/x.ts", true],
		["apps/web", "apps/webby/x.ts", false],
	])("%s matches %s: %s", (pattern, file, expected) => {
		expect(codeownersMatcher(pattern)(file)).toBe(expected);
	});
});

describe("buildGraph", () => {
	it("links definitions, imports, calls, and tests only through resolved bindings", () => {
		const graph = buildGraph(
			input({
				"src/pricing.js": pricing,
				"test/pricing.test.js": pricingTest,
				// Same function name, never imported by the test: must not be linked.
				"src/legacy.js": "export function shippingCents() { return 0; }",
			}),
		);
		expect(edgesOf(graph, "DEFINES")).toContain(
			"file:src/pricing.js -> sym:src/pricing.js#shippingCents",
		);
		expect(edgesOf(graph, "IMPORTS")).toEqual([
			"file:test/pricing.test.js -> dep:node:assert/strict",
			"file:test/pricing.test.js -> dep:node:test",
			"file:test/pricing.test.js -> file:src/pricing.js",
		]);
		expect(edgesOf(graph, "CALLS")).toEqual([
			"sym:src/pricing.js#orderTotal -> sym:src/pricing.js#shippingCents",
			"file:test/pricing.test.js -> sym:src/pricing.js#shippingCents",
			"file:test/pricing.test.js -> sym:src/pricing.js#orderTotal",
		]);
		expect(edgesOf(graph, "TESTS")).toEqual([
			"file:test/pricing.test.js -> file:src/pricing.js",
			"test:test/pricing.test.js#shipping > free at the threshold -> sym:src/pricing.js#shippingCents",
			"test:test/pricing.test.js#totals -> sym:src/pricing.js#orderTotal",
		]);
		expect(
			graph.edges
				.filter((edge) => edge.to === "sym:src/legacy.js#shippingCents")
				.map((edge) => edge.kind),
		).toEqual(["DEFINES"]);
		const symbol = graph.nodes.find(
			(n) => n.key === "sym:src/pricing.js#shippingCents",
		);
		expect(symbol).toMatchObject({
			path: "src/pricing.js",
			start_line: 3,
			end_line: 5,
			provenance: { method: "babel_parse", start_line: 3, end_line: 5 },
		});
	});

	it("keeps unresolvable imports as explicit unresolved edges", () => {
		const graph = buildGraph(
			input({ "src/a.js": 'import x from "left-pad";\nexport const y = x;' }),
		);
		expect(graph.edges.find((edge) => edge.kind === "IMPORTS")).toMatchObject({
			to: null,
			target_text: "left-pad",
			certainty: "unresolved",
		});
		expect(graph.coverage.unresolved.imports).toBe(1);
	});

	it("reports parse failures and unparsed languages as incomplete coverage", () => {
		const graph = buildGraph(
			input({
				"src/ok.js": "export const a = 1;",
				"src/broken.js": "export function (",
				"tools/run.py": "print('x')",
			}),
		);
		expect(graph.coverage.complete).toBe(false);
		expect(graph.coverage.parse_failures).toEqual([
			expect.objectContaining({ path: "src/broken.js" }),
		]);
		expect(graph.coverage.unsupported_code_files).toEqual({ python: 1 });
		expect(graph.coverage.notes.join(" ")).toMatch(/could not be parsed/);
		expect(graph.profile.files_by_language).toEqual({
			javascript: 2,
			python: 1,
		});
	});

	it("adds history, ownership, packages, and documentation edges", () => {
		const graph = buildGraph(
			input(
				{
					"src/pricing.js": pricing,
					"README.md": "# Demo\n\n## Pricing\nSee src/pricing.js.\n",
				},
				{
					manifests: [
						{
							path: "package.json",
							name: "demo",
							scripts: { test: "node --test", build: "tsc" },
							dependencies: { react: "19.0.0" },
							devDependencies: {},
							main: "src/pricing.js",
							bin: [],
							type: "module",
						},
					],
					commits: [
						{
							sha: "b".repeat(40),
							date: "2026-10-01T00:00:00Z",
							subject: "Change shipping threshold",
							files: ["src/pricing.js", "deleted.js"],
						},
					],
					codeowners: [
						{ pattern: "*", owners: ["@team"] },
						{ pattern: "/src/", owners: ["@pricing"] },
					],
					docs: docSections(
						"README.md",
						"# Demo\n\n## Pricing\nSee src/pricing.js.\n",
						new Set(["src/pricing.js", "README.md"]),
					),
				},
			),
		);
		expect(edgesOf(graph, "INTRODUCED_OR_CHANGED_BY")).toEqual([
			`file:src/pricing.js -> commit:${"b".repeat(40)}`,
		]);
		expect(edgesOf(graph, "OWNED_BY")).toEqual([
			"file:src/pricing.js -> owner:@pricing",
			"file:README.md -> owner:@team",
		]);
		expect(edgesOf(graph, "DEPENDS_ON")).toEqual(["pkg:. -> dep:react"]);
		expect(
			graph.edges.find((edge) => edge.kind === "DOCUMENTED_BY"),
		).toMatchObject({
			from: "file:src/pricing.js",
			to: "doc:README.md#pricing-3",
			certainty: "heuristic",
		});
		expect(graph.profile).toMatchObject({
			test_commands: ["package.json: npm run test (node --test)"],
			build_commands: ["package.json: npm run build (tsc)"],
			entry_points: ["src/pricing.js"],
			frameworks: [{ name: "React", evidence: expect.any(String) }],
		});
	});
});
