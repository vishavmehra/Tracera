import { existsSync } from "node:fs";
import path from "node:path";
import {
	AnswerOutputSchema,
	FeasibilityOutputSchema,
	NormalizationOutputSchema,
} from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
	createGateway,
	type ModelExecutionRecord,
} from "../src/inference/gateway.ts";
import {
	answerQuestionTask,
	assessFeasibilityTask,
	buildAssessmentInput,
	buildNormalizationInput,
	buildQuestionInput,
	normalizeBugReportTask,
} from "../src/inference/tasks.ts";
import { citationValid } from "../src/modules/assessment.ts";
import { createProvider } from "../src/worker/handlers.ts";

// [live] Calls the configured real provider once (a fraction of a cent). Run: npm run smoke:provider
const envFile = path.resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig({ ...process.env, NODE_ENV: "test" });

/** src/pricing.js lines 3-9 as Tracera numbers excerpts. */
const SHIPPING_EXCERPT = [
	"export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;",
	"export const STANDARD_SHIPPING_CENTS = 499;",
	"",
	"export function shippingCents(subtotal) {",
	"\tif (subtotal >= FREE_SHIPPING_THRESHOLD_CENTS) return 0;",
	"\treturn STANDARD_SHIPPING_CENTS;",
	"}",
]
	.map((line, i) => `${String(i + 3).padStart(4)}| ${line}`)
	.join("\n");

describe.skipIf(config.inference.provider === "mock")(
	`[live] ${config.inference.providerName} / ${config.inference.reasoningModel}`,
	() => {
		it("returns schema-valid normalization output through the gateway", async () => {
			const records: ModelExecutionRecord[] = [];
			const gateway = createGateway({
				provider: createProvider(config),
				model: config.inference.reasoningModel,
				timeoutMs: config.inference.timeoutMs,
				redactEmails: true,
				maxConcurrency: 1,
				dailyBudgetUsd: 1,
				spentTodayUsd: async () => 0,
				record: async (execution) => {
					records.push(execution);
					return "mex_live";
				},
			});
			const user = buildNormalizationInput(
				{
					title: "Dashboard average order value is wrong",
					description:
						"On /dashboard the Average order value card shows $12.40. We have 2 orders totaling $49.60, so it should be $24.80. Started after yesterday's deploy. Chrome 141 on Windows 11.",
					expectedBehavior: null,
					actualBehavior: null,
					steps: [],
					environment: {},
					affectedUrl: "https://shop.example/dashboard",
				},
				[],
			);
			const result = await gateway.run(normalizeBugReportTask, { user });
			const record = records[0];
			console.log(
				JSON.stringify({
					provider: record?.provider,
					model: record?.model,
					status: record?.status,
					attempts: record?.attempts,
					latency_ms: record?.latencyMs,
					input_tokens: record?.usage.inputTokens,
					output_tokens: record?.usage.outputTokens,
					reasoning_tokens: record?.usage.reasoningTokens,
					estimated_cost_usd: record?.estimatedCostUsd,
					expected_behavior: result.output.expected_behavior,
					actual_behavior: result.output.actual_behavior,
					field_basis: result.output.field_basis,
				}),
			);
			expect(NormalizationOutputSchema.safeParse(result.output).success).toBe(
				true,
			);
			expect(record?.status).toBe("succeeded");
		});

		it("returns a schema-valid feasibility assessment that cites only provided evidence", async () => {
			const records: ModelExecutionRecord[] = [];
			const gateway = createGateway({
				provider: createProvider(config),
				model: config.inference.taskModels.assess_feasibility,
				timeoutMs: config.inference.timeoutMs,
				redactEmails: true,
				maxConcurrency: 1,
				dailyBudgetUsd: 1,
				spentTodayUsd: async () => 0,
				record: async (execution) => {
					records.push(execution);
					return "mex_live";
				},
			});
			const excerpt = SHIPPING_EXCERPT;
			const user = buildAssessmentInput({
				request:
					"Raise the free shipping threshold from $50 to $75 for all orders",
				targets: [],
				evidence: [
					{
						handle: "FACT-1",
						kind: "repository_fact",
						label: "Tests and commands",
						content:
							"Test files: 3; test cases: 13\nTest commands: package.json: npm run test (node --test)",
						locator: {},
					},
					{
						handle: "CODE-1",
						kind: "code_excerpt",
						label: "function shippingCents",
						content: excerpt,
						locator: {
							path: "src/pricing.js",
							start_line: 3,
							end_line: 9,
							line_count: 34,
						},
					},
				],
			});
			const result = await gateway.run(assessFeasibilityTask, { user });
			const pack = new Map([
				["CODE-1", { start: 3, end: 9 }],
				["FACT-1", null],
				["REQ", null],
			]);
			const citations = [
				...result.output.relevant_components.map((c) => c.citation),
				...result.output.reusable_capabilities.map((c) => c.citation),
				...result.output.risks.flatMap((r) => r.citations),
			];
			const record = records[0];
			console.log(
				JSON.stringify({
					model: record?.model,
					status: record?.status,
					attempts: record?.attempts,
					latency_ms: record?.latencyMs,
					estimated_cost_usd: record?.estimatedCostUsd,
					assessment: result.output.status,
					confidence: result.output.confidence,
					citations: citations.map((c) => ({
						...c,
						valid: citationValid(c, pack),
					})),
				}),
			);
			expect(FeasibilityOutputSchema.safeParse(result.output).success).toBe(
				true,
			);
			expect(record?.status).toBe("succeeded");
			expect(citations.length).toBeGreaterThan(0);
			expect(citations.every((c) => citationValid(c, pack))).toBe(true);
		});

		it("answers an engineering question with claims citing only provided evidence", async () => {
			const records: ModelExecutionRecord[] = [];
			const gateway = createGateway({
				provider: createProvider(config),
				model: config.inference.taskModels.answer_question,
				timeoutMs: config.inference.timeoutMs,
				redactEmails: true,
				maxConcurrency: 1,
				dailyBudgetUsd: 1,
				spentTodayUsd: async () => 0,
				record: async (execution) => {
					records.push(execution);
					return "mex_live";
				},
			});
			const result = await gateway.run(answerQuestionTask, {
				user: buildQuestionInput({
					question:
						"Where is the free shipping threshold decided, and what is it?",
					targets: [],
					prior: null,
					evidence: [
						{
							handle: "CODE-1",
							kind: "code_excerpt",
							label: "function shippingCents",
							content: SHIPPING_EXCERPT,
							locator: {
								path: "src/pricing.js",
								start_line: 3,
								end_line: 9,
								line_count: 34,
							},
						},
					],
				}),
			});
			// The question is not evidence: only the excerpt can support a claim.
			const pack = new Map([["CODE-1", { start: 3, end: 9 }]]);
			const citations = result.output.claims.flatMap((c) => c.citations);
			const record = records[0];
			console.log(
				JSON.stringify({
					model: record?.model,
					status: record?.status,
					attempts: record?.attempts,
					latency_ms: record?.latencyMs,
					estimated_cost_usd: record?.estimatedCostUsd,
					answer_status: result.output.status,
					claims: result.output.claims.length,
					citations: citations.map((c) => ({
						...c,
						valid: citationValid(c, pack),
					})),
				}),
			);
			expect(AnswerOutputSchema.safeParse(result.output).success).toBe(true);
			expect(record?.status).toBe("succeeded");
			expect(citations.length).toBeGreaterThan(0);
			expect(citations.every((c) => citationValid(c, pack))).toBe(true);
		});
	},
);
