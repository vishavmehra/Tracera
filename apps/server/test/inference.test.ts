import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { NormalizationOutputSchema } from "@tracera/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createGateway,
	InferenceError,
	type ModelExecutionRecord,
} from "../src/inference/gateway.ts";
import { createMockProvider } from "../src/inference/mock.ts";
import {
	createHttpProvider,
	estimateCostUsd,
} from "../src/inference/providers.ts";
import { normalizeBugReportTask } from "../src/inference/tasks.ts";

type Scripted = {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
	delayMs?: number;
};
const received: Array<{
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}> = [];
let script: Scripted[] = [];
let server: Server;
let baseUrl = "";

const validOutput = {
	title: "Cart total shows NaN",
	summary: "Applying SAVE10 makes the total NaN.",
	expected_behavior: "A numeric total",
	actual_behavior: "Total: $NaN",
	steps: ["Add two mugs", "Apply SAVE10"],
	environment: {
		browser: "Chrome",
		os: null,
		viewport: null,
		app_version: null,
	},
	affected_page: "/cart",
	severity_suggestion: "unknown",
	suspected_components: ["cart total"],
	search_terms: ["SAVE10"],
	ui_element_phrases: [],
	screenshot_observations: [],
	unresolved_questions: [],
	field_basis: [{ field: "actual_behavior", basis: "stated_by_user" }],
};

const completion = (
	content: unknown,
	usage = { prompt_tokens: 1000, completion_tokens: 500 },
) => ({
	status: 200,
	body: {
		choices: [
			{
				message: {
					role: "assistant",
					content:
						typeof content === "string" ? content : JSON.stringify(content),
				},
				finish_reason: "stop",
			},
		],
		usage: {
			...usage,
			completion_tokens_details: { reasoning_tokens: 200 },
			prompt_tokens_details: { cached_tokens: 100 },
		},
	},
});

beforeAll(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			received.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
			const next = script.shift() ?? {
				status: 500,
				body: { error: { message: "no scripted response" } },
			};
			setTimeout(() => {
				res.writeHead(next.status, {
					"content-type": "application/json",
					...next.headers,
				});
				res.end(JSON.stringify(next.body));
			}, next.delayMs ?? 0);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	received.length = 0;
	script = [];
});

function gateway(
	options: {
		kind?: "meta" | "openai_compatible";
		timeoutMs?: number;
		spent?: number;
	} = {},
) {
	const records: ModelExecutionRecord[] = [];
	const instance = createGateway({
		provider: createHttpProvider({
			kind: options.kind ?? "openai_compatible",
			name: "stub",
			baseUrl,
			apiKey: "test-key",
		}),
		model: "muse-spark-1.3",
		timeoutMs: options.timeoutMs ?? 5000,
		redactEmails: true,
		maxConcurrency: 2,
		dailyBudgetUsd: 5,
		spentTodayUsd: async () => options.spent ?? 0,
		record: async (execution) => {
			records.push(execution);
			return `mex_${records.length}`;
		},
		sleep: async () => undefined,
	});
	return { instance, records };
}

describe("HTTP provider request shape", () => {
	it("sends system role, strict json_schema, reasoning effort, and max_tokens for openai_compatible", async () => {
		script = [completion(validOutput)];
		await gateway().instance.run(normalizeBugReportTask, { user: "Title: x" });
		const body = received[0]?.body as {
			messages: Array<{ role: string }>;
			response_format: { type: string; json_schema: { strict: boolean } };
			reasoning_effort: string;
			max_tokens?: number;
			max_completion_tokens?: number;
		};
		expect(received[0]?.headers.authorization).toBe("Bearer test-key");
		expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
			"system",
			"user",
		]);
		expect(body.response_format.type).toBe("json_schema");
		expect(body.response_format.json_schema.strict).toBe(true);
		expect(body.reasoning_effort).toBe("low");
		expect(body.max_tokens).toBe(4000);
		expect(body.max_completion_tokens).toBeUndefined();
	});

	it("uses max_completion_tokens for the Meta Model API", async () => {
		script = [completion(validOutput)];
		await gateway({ kind: "meta" }).instance.run(normalizeBugReportTask, {
			user: "Title: x",
		});
		const body = received[0]?.body as Record<string, unknown>;
		expect(body.max_completion_tokens).toBe(4000);
		expect(body.max_tokens).toBeUndefined();
	});
});

describe("gateway", () => {
	it("returns schema-validated output and records usage and cost", async () => {
		script = [completion(validOutput)];
		const { instance, records } = gateway();
		const result = await instance.run(normalizeBugReportTask, {
			user: "Title: Cart total",
		});
		expect(result.output.title).toBe("Cart total shows NaN");
		expect(result.modelExecutionId).toBe("mex_1");
		expect(records[0]).toMatchObject({
			status: "succeeded",
			task: "normalize_bug_report",
			promptVersion: "normalize_bug_report.v1",
			usage: {
				inputTokens: 1000,
				outputTokens: 500,
				reasoningTokens: 200,
				cachedTokens: 100,
			},
			attempts: 1,
		});
		expect(records[0]?.estimatedCostUsd).toBeGreaterThan(0);
	});

	it("redacts secrets before anything leaves the process", async () => {
		script = [completion(validOutput)];
		const { instance, records } = gateway();
		await instance.run(normalizeBugReportTask, {
			user: "stack: key=LLM_1234567890123456_FakeTestKey-notreal00",
		});
		const sent = JSON.stringify(received[0]?.body);
		expect(sent).not.toContain("FakeTestKey");
		expect(sent).toContain("[REDACTED:meta_key]");
		expect(records[0]?.redactionCount).toBeGreaterThan(0);
	});

	it("retries a 429 and then succeeds", async () => {
		script = [
			{
				status: 429,
				body: { error: { message: "slow down" } },
				headers: { "retry-after": "0" },
			},
			completion(validOutput),
		];
		const { instance, records } = gateway();
		await instance.run(normalizeBugReportTask, { user: "Title: x" });
		expect(received).toHaveLength(2);
		expect(records[0]?.attempts).toBe(2);
	});

	it("does not retry billing failures and reports them precisely", async () => {
		script = [
			{
				status: 402,
				body: {
					error: {
						code: "billing_not_configured",
						message: "Billing verification failed",
					},
				},
			},
		];
		const { instance, records } = gateway();
		const error = await instance
			.run(normalizeBugReportTask, { user: "Title: x" })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(InferenceError);
		expect((error as InferenceError).code).toBe(
			"provider_billing_not_configured",
		);
		expect((error as InferenceError).retryable).toBe(false);
		expect(received).toHaveLength(1);
		expect(records[0]?.status).toBe("failed");
	});

	it("repairs one invalid output", async () => {
		script = [completion({ title: 1 }), completion(validOutput)];
		const { instance } = gateway();
		const result = await instance.run(normalizeBugReportTask, {
			user: "Title: x",
		});
		expect(result.output.summary).toContain("SAVE10");
		expect(received).toHaveLength(2);
		const repairBody = received[1]?.body as
			| { messages: Array<{ role: string }> }
			| undefined;
		const repairMessages = (repairBody?.messages ?? []).map((m) => m.role);
		expect(repairMessages).toEqual(["system", "user", "assistant", "user"]);
	});

	it("rejects output that stays invalid after the repair attempt", async () => {
		script = [completion("not json"), completion({ title: 1 })];
		const { instance, records } = gateway();
		const error = await instance
			.run(normalizeBugReportTask, { user: "Title: x" })
			.catch((e: unknown) => e);
		expect((error as InferenceError).code).toBe("model_output_invalid");
		expect(records[0]?.status).toBe("invalid_output");
	});

	it("rejects truncated output", async () => {
		const truncated = completion(validOutput);
		(truncated.body.choices[0] as { finish_reason: string }).finish_reason =
			"length";
		script = [truncated, truncated];
		const error = await gateway()
			.instance.run(normalizeBugReportTask, { user: "Title: x" })
			.catch((e: unknown) => e);
		expect((error as InferenceError).code).toBe("model_output_invalid");
	});

	it("times out slow providers after bounded retries", async () => {
		script = [0, 1, 2].map(() => ({
			...completion(validOutput),
			delayMs: 400,
		}));
		const { instance, records } = gateway({ timeoutMs: 100 });
		const error = await instance
			.run(normalizeBugReportTask, { user: "Title: x" })
			.catch((e: unknown) => e);
		expect((error as InferenceError).code).toBe("provider_timeout");
		expect(records[0]?.attempts).toBe(3);
	});

	it("refuses calls once the daily budget is spent", async () => {
		const { instance, records } = gateway({ spent: 5 });
		const error = await instance
			.run(normalizeBugReportTask, { user: "Title: x" })
			.catch((e: unknown) => e);
		expect((error as InferenceError).code).toBe("inference_budget_exceeded");
		expect(received).toHaveLength(0);
		expect(records[0]?.status).toBe("budget_exceeded");
	});
});

describe("mock provider", () => {
	it("returns schema-valid output without any network call", async () => {
		const records: ModelExecutionRecord[] = [];
		const instance = createGateway({
			provider: createMockProvider(),
			model: "mock-reasoner",
			timeoutMs: 1000,
			redactEmails: true,
			maxConcurrency: 1,
			dailyBudgetUsd: 5,
			spentTodayUsd: async () => 0,
			record: async (execution) => {
				records.push(execution);
				return "mex_mock";
			},
		});
		const result = await instance.run(normalizeBugReportTask, {
			user: "Title: Checkout broken\nDescription: it fails",
		});
		expect(NormalizationOutputSchema.safeParse(result.output).success).toBe(
			true,
		);
		expect(records[0]?.provider).toBe("mock");
		expect(received).toHaveLength(0);
	});
});

describe("estimateCostUsd", () => {
	it("prices Muse Spark 1.3 at the listed rates, including cached input", () => {
		expect(
			estimateCostUsd("muse-spark-1.3", {
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				reasoningTokens: 0,
				cachedTokens: 0,
			}),
		).toBeCloseTo(5.5);
		expect(
			estimateCostUsd("muse-spark-1.3", {
				inputTokens: 1_000_000,
				outputTokens: 0,
				reasoningTokens: 0,
				cachedTokens: 1_000_000,
			}),
		).toBeCloseTo(0.15);
	});

	it("prices unknown models conservatively", () => {
		expect(
			estimateCostUsd("unknown-model", {
				inputTokens: 1_000_000,
				outputTokens: 0,
				reasoningTokens: 0,
				cachedTokens: 0,
			}),
		).toBeCloseTo(4);
	});
});
