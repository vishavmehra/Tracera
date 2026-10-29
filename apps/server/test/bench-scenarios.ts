import type { ChatRequest } from "../src/inference/providers.ts";

// Bench Shop case B3 as scripted model outputs. Shared by the fake-executor pipeline tests and the
// real-Docker pipeline test so both drive identical inputs.

export const B3 = {
	branch: "bug/dashboard-aov",
	file: "src/metrics.js",
	marker: "revenueCents(orders) / count",
	report: {
		title: "Dashboard average order value is wrong",
		description:
			"The sales dashboard says the average order value is $12.40. We had two orders today totaling $49.60, so the average should be $24.80.",
		expected_behavior: "Average order value is $24.80",
		actual_behavior: "Average order value shows $12.40",
		normalize: false,
	},
	test: [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { averageOrderValueCents } from "../../src/metrics.js";',
		"",
		'test("two orders totaling $49.60 average $24.80", () => {',
		"\tconst order = (...prices) => ({ lines: prices.map((unitPriceCents) => ({ unitPriceCents, quantity: 1 })) });",
		"\tassert.equal(averageOrderValueCents([order(1500, 980), order(1200, 1280)]), 2480);",
		"});",
		"",
	].join("\n"),
	fix: {
		path: "src/metrics.js",
		search:
			"\tconst count = lineItemCount(orders);\n\treturn count === 0 ? 0 : Math.round(revenueCents(orders) / count);",
		replace:
			"\tif (orders.length === 0) return 0;\n\treturn Math.round(revenueCents(orders) / orders.length);",
	},
};
export const SUITE = [
	"revenue sums every line of every order",
	"counts line items across orders",
	"average order value of single-item orders",
	"empty dashboards show zero",
];

export const plan = (test = B3.test) => ({
	feasible: true,
	infeasible_reason: null,
	test_source: test,
	expected_observation: "Two orders totaling 4960 cents average 2480 cents",
	reported_observation: "The average shows 1240 cents",
});

type Block = { source: string; attributes: string; body: string };
export function blocks(user: string): Block[] {
	return [
		...user.matchAll(
			/<untrusted source="([^"]+)"([^>]*)>\n([\s\S]*?)\n<\/untrusted>/g,
		),
	].map((m) => ({
		source: m[1] ?? "",
		attributes: m[2] ?? "",
		body: m[3] ?? "",
	}));
}
export const userOf = (request: ChatRequest) =>
	request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";

/** Reads the prompt like a model would: cites the excerpt and line that contain `marker`. */
export function hypothesesCiting(
	file: string,
	marker: string,
	support: Array<"REPRO" | "COMMIT"> = ["REPRO", "COMMIT"],
) {
	return (request: ChatRequest) => {
		const all = blocks(userOf(request));
		const code = all.find((b) => b.attributes.includes(`path="${file}"`));
		const line = code?.body
			.split("\n")
			.find((l) => l.includes(marker))
			?.match(/^\s*(\d+)\|/)?.[1];
		const repro = all.find((b) => b.source.startsWith("REPRO-"));
		const commit = all.find(
			(b) =>
				b.source.startsWith("COMMIT-") && b.body.includes(`Files: ${file}`),
		);
		const citations = [
			support.includes("REPRO") ? repro?.source : undefined,
			support.includes("COMMIT") ? commit?.source : undefined,
		]
			.filter((handle): handle is string => Boolean(handle))
			.map((handle) => ({ handle, start_line: null, end_line: null }));
		return {
			insufficient_evidence: false,
			insufficient_evidence_reason: null,
			hypotheses: [
				{
					title: "Average divides revenue by line items",
					mechanism:
						"averageOrderValueCents divides revenue by lineItemCount(orders) instead of orders.length",
					locations: [
						{
							handle: code?.source ?? "CODE-0",
							start_line: Number(line ?? 1),
							end_line: Number(line ?? 1),
						},
					],
					supporting: citations,
					contradicting: [],
					alternatives: ["Revenue could be wrong instead"],
					next_check:
						"Run the reproduction test after dividing by the order count",
					confidence: "high",
					confidence_rationale:
						"The reproduction fails as the mechanism predicts",
				},
			],
			observations: [
				{
					statement: "The average changed in a recent refactor",
					kind: "history_observation",
					citations: [
						{
							handle: commit?.source ?? "COMMIT-404",
							start_line: null,
							end_line: null,
						},
					],
				},
			],
			missing_information: [],
		};
	};
}

export const patchOutput = (edit = B3.fix) => ({
	hypothesis_handle: "HYP-1",
	edits: [edit],
	summary: "Divide revenue by the number of orders",
	rationale:
		"The mechanism divides by line items; dividing by orders restores the per-order mean",
	expected_effect: "The reproduction test passes",
	risks: [],
});
