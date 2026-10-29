import type { HypothesesOutput } from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import {
	type EvidenceIndex,
	hypothesisState,
	rankHypotheses,
	selectPatchTarget,
	validateHypotheses,
	validatePatchEdits,
	validateReproTest,
} from "../src/modules/analysis.ts";

const tracked = new Set([
	"src/pricing.js",
	"src/cart.js",
	"test/pricing.test.js",
	"package.json",
]);

describe("validateReproTest", () => {
	const good = [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { shippingCents } from "../../src/pricing.js";',
		"",
		'test("ships free at $50", () => {',
		"\tassert.equal(shippingCents(5000), 0);",
		"});",
		"",
	].join("\n");

	it("accepts a node:test file that imports tracked repository modules", () => {
		expect(validateReproTest(good, tracked)).toEqual({
			ok: true,
			imports: ["src/pricing.js"],
		});
	});

	it.each([
		[
			"child_process",
			`import { execSync } from "node:child_process";\n${good}`,
		],
		["fs", `import fs from "node:fs";\n${good}`],
		["network modules", `import http from "node:http";\n${good}`],
		["bare packages", `import x from "lodash";\n${good}`],
		["dynamic import", `${good}\nawait import("node:fs");`],
		["require", `${good}\nconst cp = require("child_process");`],
		["process.env", `${good}\nconsole.log(process.env.HOME);`],
		["eval", `${good}\neval("1");`],
		["the Function constructor", `${good}\nnew Function("return 1")();`],
		["process.exit", `${good}\nprocess.exit(0);`],
		["fetch", `${good}\nawait fetch("http://example.com");`],
		[
			"paths outside the repository",
			good.replace("../../src/pricing.js", "../../../etc/passwd"),
		],
		[
			"untracked modules",
			good.replace("../../src/pricing.js", "../../src/missing.js"),
		],
		[
			"files without a test",
			'import assert from "node:assert";\nassert.ok(true);',
		],
		["empty files", ""],
	])("rejects %s", (_label, source) => {
		expect(validateReproTest(source, tracked).ok).toBe(false);
	});
});

const index: EvidenceIndex = new Map([
	[
		"EV-1",
		{ handle: "EV-1", kind: "report_claim", basis: "reported", locator: {} },
	],
	[
		"CODE-1",
		{
			handle: "CODE-1",
			kind: "code_excerpt",
			basis: "observed",
			locator: {
				path: "src/metrics.js",
				start_line: 1,
				end_line: 30,
				line_count: 30,
			},
		},
	],
	[
		"CODE-2",
		{
			handle: "CODE-2",
			kind: "code_excerpt",
			basis: "observed",
			locator: {
				path: "src/cart.js",
				start_line: 1,
				end_line: 40,
				line_count: 40,
			},
		},
	],
	[
		"COMMIT-1",
		{
			handle: "COMMIT-1",
			kind: "commit",
			basis: "observed",
			locator: { sha: "a".repeat(40), files: ["src/metrics.js"] },
		},
	],
	[
		"REPRO-1",
		{
			handle: "REPRO-1",
			kind: "reproduction",
			basis: "observed",
			locator: { status: "reproduced" },
		},
	],
	[
		"REPRO-2",
		{
			handle: "REPRO-2",
			kind: "reproduction",
			basis: "observed",
			locator: { status: "not_reproduced" },
		},
	],
]);

type Hypothesis = HypothesesOutput["hypotheses"][number];
const hypothesis = (overrides: Partial<Hypothesis> = {}): Hypothesis => ({
	title: "Average divides by line items",
	mechanism:
		"averageOrderValueCents divides revenue by lineItemCount instead of the order count",
	locations: [{ handle: "CODE-1", start_line: 18, end_line: 21 }],
	supporting: [{ handle: "REPRO-1", start_line: null, end_line: null }],
	contradicting: [],
	alternatives: ["Revenue itself is wrong"],
	next_check:
		"Assert averageOrderValueCents of two orders with four lines equals the per-order mean",
	confidence: "high",
	confidence_rationale:
		"The reproduction fails exactly as the mechanism predicts",
	...overrides,
});
const output = (
	hypotheses: Hypothesis[],
	observations: HypothesesOutput["observations"] = [],
): HypothesesOutput => ({
	insufficient_evidence: false,
	insufficient_evidence_reason: null,
	hypotheses,
	observations,
	missing_information: [],
});

describe("validateHypotheses (citation validation)", () => {
	it("keeps hypotheses whose citations all exist", () => {
		const result = validateHypotheses(output([hypothesis()]), index);
		expect(result.hypotheses).toHaveLength(1);
		expect(result.invalidCitations).toBe(0);
	});

	it("drops citations to handles that were never collected and counts them", () => {
		const result = validateHypotheses(
			output([
				hypothesis({
					supporting: [
						{ handle: "REPRO-1", start_line: null, end_line: null },
						{ handle: "CODE-99", start_line: 1, end_line: 2 },
						{ handle: "TEST-RESULT-7", start_line: null, end_line: null },
					],
				}),
			]),
			index,
		);
		expect(result.hypotheses[0]?.supporting.map((c) => c.handle)).toEqual([
			"REPRO-1",
		]);
		expect(result.invalidCitations).toBe(2);
	});

	it.each([
		[
			"no valid supporting citation",
			{ supporting: [{ handle: "NOPE-1", start_line: null, end_line: null }] },
		],
		[
			"a location past the end of the file",
			{ locations: [{ handle: "CODE-1", start_line: 25, end_line: 99 }] },
		],
		[
			"a location on a non-code handle",
			{ locations: [{ handle: "COMMIT-1", start_line: 1, end_line: 2 }] },
		],
		[
			"a reversed line range",
			{ locations: [{ handle: "CODE-1", start_line: 21, end_line: 18 }] },
		],
	])("discards a hypothesis with %s", (_label, overrides) => {
		const result = validateHypotheses(
			output([hypothesis(overrides as Partial<Hypothesis>)]),
			index,
		);
		expect(result.hypotheses).toHaveLength(0);
		expect(result.discarded).toBe(1);
	});

	it("discards observations without a valid citation", () => {
		const result = validateHypotheses(
			output(
				[hypothesis()],
				[
					{
						statement: "Metrics changed recently",
						kind: "history_observation",
						citations: [
							{ handle: "COMMIT-1", start_line: null, end_line: null },
						],
					},
					{
						statement: "I read the database schema",
						kind: "code_observation",
						citations: [{ handle: "CODE-50", start_line: 1, end_line: 2 }],
					},
				],
			),
			index,
		);
		expect(result.observations.map((o) => o.statement)).toEqual([
			"Metrics changed recently",
		]);
	});
});

describe("hypothesisState (rule-driven claim states)", () => {
	it("is supported only with a code location and observed supporting evidence", () => {
		expect(hypothesisState(hypothesis(), index)).toBe("supported");
		expect(
			hypothesisState(
				hypothesis({
					supporting: [
						{ handle: "COMMIT-1", start_line: null, end_line: null },
					],
				}),
				index,
			),
		).toBe("supported");
	});

	it("is only proposed when the support is what the user reported", () => {
		expect(
			hypothesisState(
				hypothesis({
					supporting: [{ handle: "EV-1", start_line: null, end_line: null }],
				}),
				index,
			),
		).toBe("proposed");
	});

	it("does not treat a reproduction that did not reproduce as support", () => {
		expect(
			hypothesisState(
				hypothesis({
					supporting: [{ handle: "REPRO-2", start_line: null, end_line: null }],
				}),
				index,
			),
		).toBe("proposed");
	});

	it("is contradicted by any observed contradicting evidence", () => {
		expect(
			hypothesisState(
				hypothesis({
					contradicting: [
						{ handle: "REPRO-2", start_line: null, end_line: null },
					],
				}),
				index,
			),
		).toBe("contradicted");
	});
});

describe("rankHypotheses and selectPatchTarget", () => {
	it("scores observed runtime evidence and recently changed locations, keeping model order on ties", () => {
		const ranked = rankHypotheses(
			[
				hypothesis({
					title: "weak",
					supporting: [{ handle: "EV-1", start_line: null, end_line: null }],
					locations: [{ handle: "CODE-2", start_line: 1, end_line: 2 }],
					confidence: "low",
				}),
				hypothesis({ title: "strong" }),
				hypothesis({ title: "strong twin" }),
			],
			index,
		);
		expect(ranked.map((h) => [h.title, h.rank])).toEqual([
			["strong", 1],
			["strong twin", 2],
			["weak", 3],
		]);
		// 3 (reproduced) + 2 (location in a file changed by COMMIT-1) + 2 (high confidence)
		expect(ranked[0]?.score).toBe(7);
	});

	it("targets the best supported hypothesis, never a merely proposed one in full mode", () => {
		const proposed = { id: "hyp_a", rank: 1, state: "proposed" as const };
		const supported = { id: "hyp_b", rank: 2, state: "supported" as const };
		expect(selectPatchTarget([proposed, supported], "full")?.id).toBe("hyp_b");
		expect(selectPatchTarget([proposed], "full")).toBeNull();
		expect(selectPatchTarget([proposed], "analysis_only")?.id).toBe("hyp_a");
	});
});

describe("validatePatchEdits (patch policy)", () => {
	const tree = new Map([
		["src/metrics.js", "100644"],
		["test/metrics.test.js", "100644"],
		["package.json", "100644"],
		["link.js", "120000"],
		["vendor/lib", "160000"],
	]);
	const edit = (path: string, search = "a", replace = "b") => ({
		path,
		search,
		replace,
	});

	it("accepts a minimal edit to a tracked source file", () => {
		expect(validatePatchEdits([edit("src/metrics.js")], tree)).toEqual({
			ok: true,
			errors: [],
			risks: [],
		});
	});

	it.each([
		["../outside.js"],
		["/etc/passwd"],
		["C:/Windows/win.ini"],
		["src\\metrics.js"],
		["./src/metrics.js"],
		["src//metrics.js"],
		[".git/config"],
		[".tracera/repro/repro.mjs"],
		[".env"],
		["config/.env.local"],
		["package.json"],
		["package-lock.json"],
		["yarn.lock"],
		["pnpm-lock.yaml"],
		[".github/workflows/ci.yml"],
		["node_modules/x/index.js"],
		["link.js"],
		["vendor/lib"],
		["src/new-feature.js"],
	])("rejects an edit to %s", (path) => {
		expect(validatePatchEdits([edit(path)], tree).ok).toBe(false);
	});

	it("allows a new test file and flags it", () => {
		expect(
			validatePatchEdits([edit("test/regression.test.js", "", "test()")], tree),
		).toMatchObject({ ok: true, risks: [{ code: "adds_test" }] });
	});

	it("flags edits to existing tests", () => {
		expect(
			validatePatchEdits([edit("test/metrics.test.js")], tree).risks[0]?.code,
		).toBe("modifies_existing_test");
	});

	it.each([
		["no edits", []],
		["an empty search on an existing file", [edit("src/metrics.js", "", "x")]],
		["a no-op edit", [edit("src/metrics.js", "same", "same")]],
		[
			"more than five files",
			["a", "b", "c", "d", "e", "f"].map((n) =>
				edit(`test/${n}.test.js`, "", "x"),
			),
		],
	])("rejects %s", (_label, edits) => {
		expect(validatePatchEdits(edits, tree).ok).toBe(false);
	});
});
