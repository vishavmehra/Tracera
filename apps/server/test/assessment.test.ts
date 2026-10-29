import { describe, expect, it } from "vitest";
import {
	citationValid,
	classifyChangeSize,
	packagesOf,
	settleAnswer,
	settleAssessment,
} from "../src/modules/assessment.ts";

describe("citationValid", () => {
	const pack = new Map([
		["CODE-1", { start: 10, end: 30 }],
		["FACT-1", null],
	]);
	it.each([
		[
			"a cited excerpt range inside the excerpt",
			{ handle: "CODE-1", start_line: 12, end_line: 20 },
			true,
		],
		[
			"the whole excerpt",
			{ handle: "CODE-1", start_line: null, end_line: null },
			true,
		],
		[
			"lines before the excerpt",
			{ handle: "CODE-1", start_line: 5, end_line: 12 },
			false,
		],
		[
			"lines after the excerpt",
			{ handle: "CODE-1", start_line: 29, end_line: 31 },
			false,
		],
		[
			"a reversed range",
			{ handle: "CODE-1", start_line: 20, end_line: 12 },
			false,
		],
		[
			"a fact handle",
			{ handle: "FACT-1", start_line: null, end_line: null },
			true,
		],
		[
			"an invented handle",
			{ handle: "CODE-9", start_line: null, end_line: null },
			false,
		],
	])("%s", (_name, citation, expected) => {
		expect(citationValid(citation, pack)).toBe(expected);
	});
});

describe("settleAssessment", () => {
	const base = {
		status: "SUPPORTED_WITH_CHANGES" as const,
		confidence: "high" as const,
		validComponents: 2,
		validRiskCitations: 0,
		invalidCitations: 0,
		totalCitations: 3,
		coverageComplete: true,
		stale: false,
	};
	it.each([
		["keeps an evidenced verdict", {}, "SUPPORTED_WITH_CHANGES", "high", []],
		[
			"needs cited components for a supported verdict",
			{ validComponents: 0 },
			"INSUFFICIENT_EVIDENCE",
			"high",
			["no_cited_components"],
		],
		[
			"needs evidence for a blocker",
			{ status: "BLOCKED" as const, validComponents: 0, validRiskCitations: 0 },
			"INSUFFICIENT_EVIDENCE",
			"high",
			["blocker_not_evidenced"],
		],
		[
			"keeps a blocker backed by a cited risk",
			{ status: "BLOCKED" as const, validComponents: 0, validRiskCitations: 1 },
			"BLOCKED",
			"high",
			[],
		],
		[
			"drops confidence when half the citations are invalid",
			{ invalidCitations: 2, totalCitations: 4 },
			"SUPPORTED_WITH_CHANGES",
			"low",
			["many_invalid_citations"],
		],
		[
			"caps confidence on partial coverage",
			{ coverageComplete: false },
			"SUPPORTED_WITH_CHANGES",
			"medium",
			["partial_graph_coverage"],
		],
		[
			"caps confidence on a stale snapshot",
			{ stale: true },
			"SUPPORTED_WITH_CHANGES",
			"medium",
			["stale_snapshot"],
		],
		[
			"caps confidence when freshness is unknown",
			{ stale: null },
			"SUPPORTED_WITH_CHANGES",
			"medium",
			["freshness_unknown"],
		],
	])("%s", (_name, overrides, status, confidence, downgrades) => {
		expect(settleAssessment({ ...base, ...overrides })).toEqual({
			status,
			confidence,
			downgrades,
		});
	});
});

describe("classifyChangeSize", () => {
	const base = {
		status: "SUPPORTED_WITH_CHANGES" as const,
		likelyFiles: ["src/a.js"],
		dependents: 3,
		tests: 2,
		missingKinds: ["code"],
		coverageComplete: true,
		impactTruncated: false,
	};
	it.each([
		["one file with few dependents", {}, "SMALL"],
		[
			"insufficient evidence",
			{ status: "INSUFFICIENT_EVIDENCE" as const },
			"UNKNOWN",
		],
		["no cited files", { likelyFiles: [] }, "UNKNOWN"],
		["a new data model", { missingKinds: ["data_model"] }, "MEDIUM"],
		["many dependents", { dependents: 12 }, "MEDIUM"],
		[
			"several files and infrastructure",
			{
				likelyFiles: ["a", "b", "c", "d", "e", "f", "g"],
				missingKinds: ["infrastructure", "dependency"],
			},
			"LARGE",
		],
		["a wide blast radius", { dependents: 40 }, "LARGE"],
	])("%s", (_name, overrides, size) => {
		expect(classifyChangeSize({ ...base, ...overrides }).size).toBe(size);
	});

	it("says when the dependent count may be low", () => {
		expect(
			classifyChangeSize({ ...base, coverageComplete: false }).reasons.at(-1),
		).toMatch(/may be low/);
	});
});

describe("settleAnswer", () => {
	const base = {
		status: "ANSWERED" as const,
		confidence: "high" as const,
		supportedClaims: 2,
		unsupportedClaims: 0,
		invalidCitations: 0,
		totalCitations: 3,
		coverageComplete: true,
		stale: false,
	};
	it.each([
		["keeps a fully cited answer", {}, "ANSWERED", "high", []],
		[
			"needs at least one claim backed by valid evidence",
			{ supportedClaims: 0, unsupportedClaims: 2 },
			"INSUFFICIENT_EVIDENCE",
			"high",
			["no_supported_claims"],
		],
		[
			"marks an answer with unsupported claims as partial",
			{ unsupportedClaims: 1 },
			"PARTIALLY_ANSWERED",
			"high",
			["unsupported_claims"],
		],
		[
			"keeps the model's own insufficient-evidence verdict",
			{ status: "INSUFFICIENT_EVIDENCE" as const, supportedClaims: 0 },
			"INSUFFICIENT_EVIDENCE",
			"high",
			[],
		],
		[
			"drops confidence when half the citations are invalid",
			{ invalidCitations: 2, totalCitations: 4 },
			"ANSWERED",
			"low",
			["many_invalid_citations"],
		],
		[
			"caps confidence on partial coverage",
			{ coverageComplete: false },
			"ANSWERED",
			"medium",
			["partial_graph_coverage"],
		],
		[
			"caps confidence on a stale snapshot",
			{ stale: true },
			"ANSWERED",
			"medium",
			["stale_snapshot"],
		],
	])("%s", (_name, overrides, status, confidence, downgrades) => {
		expect(settleAnswer({ ...base, ...overrides })).toEqual({
			status,
			confidence,
			downgrades,
		});
	});
});

describe("packagesOf", () => {
	const packages = [
		{ path: "package.json", name: "root" },
		{ path: "apps/web/package.json", name: "web" },
		{ path: "apps/server/package.json", name: "server" },
	];
	it("assigns each file to the package with the deepest enclosing manifest", () => {
		expect(
			packagesOf(
				[
					"apps/web/src/a.ts",
					"apps/web/src/b.ts",
					"apps/server/src/c.ts",
					"scripts/x.ts",
					"README.md",
				],
				packages,
			),
		).toEqual([
			{ path: "apps/web/package.json", name: "web", files: 2 },
			{ path: "package.json", name: "root", files: 2 },
			{ path: "apps/server/package.json", name: "server", files: 1 },
		]);
	});

	it("leaves files outside every package unassigned", () => {
		expect(
			packagesOf(["apps/webby/x.ts", "tools/y.ts"], packages.slice(1)),
		).toEqual([]);
	});
});
