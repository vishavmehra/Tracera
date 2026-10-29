import { createMockProvider } from "../../src/inference/mock.ts";
import type {
	ChatProvider,
	ChatRequest,
} from "../../src/inference/providers.ts";
import { blocks, userOf } from "../bench-scenarios.ts";
import { BUG, SCENARIO } from "./fixture.ts";

/**
 * A deterministic inference provider for browser E2E journeys [mock]. It answers from the evidence
 * blocks Tracera actually put in the prompt (it cites real handles and real line numbers), labels every
 * text "[mock fixture]", and declares itself `mock`, so every result is shown as mock. It never decides
 * anything the product decides: citations are re-validated, hypothesis states are set by rules, patches
 * pass the patch policy, and verification runs the real checks in the Docker sandbox. Tasks it does not
 * script fall back to the plain mock adapter (schema-minimal output).
 */
export function createFixtureProvider(): ChatProvider {
	const fallback = createMockProvider();
	return {
		kind: "mock",
		name: "mock",
		async complete(request, signal) {
			const output = scripted(request);
			if (output === undefined) return fallback.complete(request, signal);
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

const MOCK = "[mock fixture]";

/** Which journey a prompt belongs to, from the scenario marker in the report's title. */
function scenarioOf(user: string): keyof typeof SCENARIO | null {
	if (user.includes(SCENARIO.verified)) return "verified";
	if (user.includes(SCENARIO.unverified)) return "unverified";
	return null;
}

/** The first numbered line of an excerpt block (`  12| code`), or the line containing `text`. */
function lineOf(body: string, text?: string) {
	const numbered = body
		.split("\n")
		.map((line) => line.match(/^\s*(\d+)\|(.*)$/))
		.filter((match): match is RegExpMatchArray => match !== null);
	const hit = text
		? numbered.find((match) => (match[2] ?? "").includes(text))
		: numbered[0];
	return hit ? Number(hit[1]) : null;
}

function scripted(request: ChatRequest): unknown {
	const user = userOf(request);
	const all = blocks(user);
	switch (request.schema.name) {
		case "answer_question": {
			const code = all.find((b) => b.source.startsWith("CODE-"));
			const line = code ? lineOf(code.body) : null;
			if (!code || line === null)
				return {
					status: "INSUFFICIENT_EVIDENCE",
					answer: `${MOCK} No code excerpt was provided, so nothing can be cited.`,
					claims: [],
					unknowns: [`${MOCK} Where the behavior is implemented`],
					follow_up_questions: [],
					confidence: "low",
					confidence_rationale: `${MOCK} Deterministic test output, not a model judgment.`,
				};
			return {
				status: "ANSWERED",
				answer: `${MOCK} Deterministic test answer: one claim cites the first excerpt Tracera collected, one cites nothing.`,
				claims: [
					{
						statement: `${MOCK} The excerpt ${code.source} is the first code Tracera collected for this question.`,
						citations: [
							{ handle: code.source, start_line: line, end_line: line },
						],
					},
					{
						statement: `${MOCK} This statement cites no evidence, so the rules must mark it unsupported.`,
						citations: [],
					},
				],
				unknowns: [`${MOCK} Whether other callers depend on this behavior`],
				follow_up_questions: [`${MOCK} Which tests cover this code?`],
				confidence: "low",
				confidence_rationale: `${MOCK} Deterministic test output, not a model judgment.`,
			};
		}
		case "plan_reproduction":
			return scenarioOf(user) === "verified"
				? {
						feasible: true,
						infeasible_reason: null,
						test_source: BUG.reproTest,
						expected_observation: `${MOCK} total([{ price: "2" }, { price: 3 }]) is 5`,
						reported_observation: `${MOCK} The total is "023"`,
					}
				: {
						feasible: false,
						infeasible_reason: `${MOCK} No reproduction is scripted for this report.`,
						test_source: "",
						expected_observation: "",
						reported_observation: "",
					};
		case "generate_hypotheses": {
			const code = all.find((b) => b.attributes.includes(`path="${BUG.file}"`));
			const line = code ? lineOf(code.body, BUG.marker) : null;
			if (!scenarioOf(user) || !code || line === null)
				return {
					insufficient_evidence: true,
					insufficient_evidence_reason: `${MOCK} No hypothesis is scripted for this report.`,
					hypotheses: [],
					observations: [],
					missing_information: [],
				};
			// Support: a reproduction that ran (if any) and the commit that touched the file.
			const support = all
				.filter(
					(b) =>
						b.source.startsWith("REPRO-") ||
						(b.source.startsWith("COMMIT-") &&
							b.body.includes(`Files: ${BUG.file}`)),
				)
				.map((b) => ({ handle: b.source, start_line: null, end_line: null }));
			return {
				insufficient_evidence: false,
				insufficient_evidence_reason: null,
				hypotheses: [
					{
						title: `${MOCK} total adds string prices without converting them`,
						mechanism: `${MOCK} add() concatenates when a price is a string, so the total becomes a string.`,
						locations: [
							{ handle: code.source, start_line: line, end_line: line },
						],
						supporting: support,
						contradicting: [],
						alternatives: [],
						next_check: `${MOCK} Run the reproduction after converting prices to numbers.`,
						confidence: "medium",
						confidence_rationale: `${MOCK} Deterministic test output, not a model judgment.`,
					},
				],
				observations: [],
				missing_information: [],
			};
		}
		case "generate_patch":
			return scenarioOf(user)
				? {
						hypothesis_handle: "HYP-1",
						edits: [BUG.fix],
						summary: `${MOCK} Convert prices to numbers before adding them`,
						rationale: `${MOCK} add() concatenates strings; converting each price keeps the sum numeric.`,
						expected_effect: `${MOCK} Totals of string prices are numeric sums.`,
						risks: [
							`${MOCK} A non-numeric price now yields NaN instead of text`,
						],
					}
				: undefined;
		default:
			return undefined;
	}
}
