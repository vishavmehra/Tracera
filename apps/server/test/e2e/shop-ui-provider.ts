import type { BrowserStep } from "@tracera/contracts";
import { FIX } from "../../../../scripts/shop-ui-setup.ts";
import type {
	ChatProvider,
	ChatRequest,
} from "../../src/inference/providers.ts";
import { blocks, userOf } from "../bench-scenarios.ts";
import { createFixtureProvider } from "./fixture-provider.ts";

/**
 * A deterministic inference provider for the Shop UI demo fixture [mock], in the pattern of
 * fixture-provider.ts: it answers from the evidence blocks Tracera actually put in the prompt (real
 * handles, real line numbers), labels every text "[mock fixture]", and declares itself `mock`. Citations,
 * hypothesis states, the patch policy, and the verification outcome are still decided by the product's
 * own rules, and the browser steps below run in the real sandbox. Other tasks go to the fixture provider.
 */

/** A bug report whose title carries this marker gets the Shop UI answers. */
export const SHOP_UI_MARKER = "[e2e:shop-ui]";

const MOCK = "[mock fixture]";

const step = (partial: Partial<BrowserStep>): BrowserStep => ({
	action: "goto",
	target: null,
	value: null,
	path: null,
	key: null,
	width: null,
	height: null,
	match: null,
	timeout_ms: null,
	...partial,
});
const testId = (value: string) => ({
	by: "test_id" as const,
	value,
	name: null,
	exact: null,
});

/** What a user does to see the bug: add a second lamp, so the subtotal is exactly $50.00. */
export const SHOP_UI_STEPS: BrowserStep[] = [
	step({ action: "goto", path: "/cart" }),
	step({
		action: "click",
		target: {
			by: "role",
			value: "link",
			name: "Add one Desk lamp",
			exact: null,
		},
	}),
	step({ action: "expect_url", path: "/cart?qty=2" }),
	step({
		action: "expect_text",
		target: testId("subtotal"),
		value: "Subtotal: $50.00",
		match: "equals",
	}),
	step({
		action: "expect_text",
		target: testId("banner"),
		value: "Free shipping on orders of $50 or more",
		match: "equals",
	}),
	step({
		action: "expect_text",
		target: testId("shipping"),
		value: "Shipping: Free",
		match: "equals",
		timeout_ms: 2_000,
	}),
	step({ action: "expect_no_console_errors" }),
];

export const SHOP_UI_REPORT = {
	title: `${SHOP_UI_MARKER} Free shipping banner contradicts a $4.99 shipping charge`,
	description:
		"The cart page says free shipping on orders of $50 or more, but with two Desk lamps ($25.00 each, subtotal exactly $50.00) it still shows Shipping: $4.99. An order of $75.00 correctly ships free. See shippingCents in src/pricing.js.",
	expected_behavior: "Shipping reads Free when the subtotal is $50.00",
	actual_behavior: "Shipping reads $4.99 when the subtotal is $50.00",
	affected_url: "http://localhost:4173/cart",
	normalize: false,
} as const;

/** The first numbered line of an excerpt block (`  12| code`) that contains `text`. */
function lineOf(body: string, text: string) {
	for (const line of body.split("\n")) {
		const match = line.match(/^\s*(\d+)\|(.*)$/);
		if (match && (match[2] ?? "").includes(text)) return Number(match[1]);
	}
	return null;
}

function scripted(request: ChatRequest): unknown {
	const user = userOf(request);
	if (!user.includes(SHOP_UI_MARKER)) return undefined;
	switch (request.schema.name) {
		case "plan_browser_reproduction":
			return {
				feasible: true,
				infeasible_reason: null,
				steps: SHOP_UI_STEPS,
				expected_observation: `${MOCK} With two lamps the subtotal is $50.00 and shipping reads Free, as the banner promises`,
				reported_observation: `${MOCK} Shipping reads $4.99 at a subtotal of exactly $50.00`,
			};
		case "generate_hypotheses": {
			const code = blocks(user).find((b) =>
				b.attributes.includes('path="src/pricing.js"'),
			);
			const line = code ? lineOf(code.body, FIX.search) : null;
			if (!code || line === null)
				return {
					insufficient_evidence: true,
					insufficient_evidence_reason: `${MOCK} The shipping rule was not in the evidence.`,
					hypotheses: [],
					observations: [],
					missing_information: [],
				};
			const support = blocks(user)
				.filter(
					(b) =>
						b.source.startsWith("REPRO-") ||
						(b.source.startsWith("COMMIT-") &&
							b.body.includes("Files: src/pricing.js")),
				)
				.map((b) => ({ handle: b.source, start_line: null, end_line: null }));
			return {
				insufficient_evidence: false,
				insufficient_evidence_reason: null,
				hypotheses: [
					{
						title: `${MOCK} The free-shipping check leaves out a subtotal of exactly the threshold`,
						mechanism: `${MOCK} shippingCents compares with > instead of >=, so a $50.00 subtotal is charged shipping.`,
						locations: [
							{ handle: code.source, start_line: line, end_line: line },
						],
						supporting: support,
						contradicting: [],
						alternatives: [],
						next_check: `${MOCK} Run the browser steps again after changing > to >=.`,
						confidence: "medium",
						confidence_rationale: `${MOCK} Deterministic test output, not a model judgment.`,
					},
				],
				observations: [],
				missing_information: [],
			};
		}
		case "generate_patch":
			return {
				hypothesis_handle: "HYP-1",
				edits: [FIX],
				summary: `${MOCK} Include the threshold itself in the free-shipping check`,
				rationale: `${MOCK} The page promises free shipping from $50, so the comparison must be >=.`,
				expected_effect: `${MOCK} A subtotal of exactly $50.00 ships free.`,
				risks: [
					`${MOCK} Orders of exactly the threshold no longer pay shipping`,
				],
			};
		default:
			return undefined;
	}
}

export function createShopUiProvider(): ChatProvider {
	const base = createFixtureProvider();
	return {
		kind: "mock",
		name: "mock",
		async complete(request, signal) {
			const output = scripted(request);
			if (output === undefined) return base.complete(request, signal);
			const content = JSON.stringify(output);
			return {
				content,
				finishReason: "stop",
				usage: {
					inputTokens: Math.ceil(
						request.messages.reduce((sum, m) => sum + m.content.length, 0) / 4,
					),
					outputTokens: Math.ceil(content.length / 4),
					reasoningTokens: 0,
					cachedTokens: 0,
				},
			};
		},
	};
}
