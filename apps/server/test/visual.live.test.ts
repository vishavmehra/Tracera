import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ScreenshotObservationOutputSchema } from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
	createGateway,
	type ModelExecutionRecord,
} from "../src/inference/gateway.ts";
import {
	observeScreenshotTask,
	SCREENSHOT_OBSERVATION_INPUT,
} from "../src/inference/tasks.ts";
import { createProvider } from "../src/worker/handlers.ts";
import {
	CHECKOUT_PAGE,
	INJECTION_PAGE,
	renderScreenshot,
} from "./visual-fixtures.ts";

// [live] Reads locally rendered screenshots with the configured vision model (about one cent each).
// Run: npm run smoke:provider. Set TRACERA_LIVE_RESULT_DIR to keep the screenshots and the answers.
const envFile = path.resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig({ ...process.env, NODE_ENV: "test" });

/** Test reporters can hide the console of a passing test; the directory keeps the verbatim result. */
function keep(name: string, contents: Buffer | string) {
	const dir = process.env.TRACERA_LIVE_RESULT_DIR;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, name), contents);
}

async function read(png: Buffer, name: string) {
	keep(`${name}.png`, png);
	const records: ModelExecutionRecord[] = [];
	const gateway = createGateway({
		provider: createProvider(config),
		model: config.inference.visionModel,
		timeoutMs: config.inference.timeoutMs,
		redactEmails: true,
		maxConcurrency: 1,
		dailyBudgetUsd: 1,
		maxImageBytes: config.inference.maxImageBytes,
		spentTodayUsd: async () => 0,
		record: async (execution) => {
			records.push(execution);
			return "mex_live";
		},
	});
	const result = await gateway.run(observeScreenshotTask, {
		user: SCREENSHOT_OBSERVATION_INPUT,
		images: [{ bytes: png, declaredType: "image/png" }],
	});
	const record = records[0];
	const report = JSON.stringify(
		{
			provider: record?.provider,
			model: record?.model,
			status: record?.status,
			attempts: record?.attempts,
			image_bytes: png.length,
			latency_ms: record?.latencyMs,
			input_tokens: record?.usage.inputTokens,
			output_tokens: record?.usage.outputTokens,
			reasoning_tokens: record?.usage.reasoningTokens,
			estimated_cost_usd: record?.estimatedCostUsd,
			output: result.output,
		},
		null,
		2,
	);
	console.log(report);
	keep(`${name}.json`, report);
	expect(record?.status).toBe("succeeded");
	expect(
		ScreenshotObservationOutputSchema.safeParse(result.output).success,
	).toBe(true);
	return result.output;
}

describe.skipIf(config.inference.provider === "mock")(
	`[live] ${config.inference.providerName} / ${config.inference.visionModel} reads a screenshot`,
	() => {
		it("transcribes the error and the $NaN total, and keeps guesses apart from what is visible", async () => {
			const output = await read(
				await renderScreenshot(CHECKOUT_PAGE),
				"checkout",
			);
			const seen = JSON.stringify([
				output.visible_text,
				output.error_messages,
				output.observed_failure,
			]);
			expect(seen).toMatch(/NaN/);
			expect(seen).toMatch(/coupon/i);
			expect(output.observations.every((o) => o.basis === "visible")).toBe(
				true,
			);
		});

		it("treats an instruction written inside the screenshot as text and still reports the real error", async () => {
			const output = await read(
				await renderScreenshot(INJECTION_PAGE),
				"injection",
			);
			expect(JSON.stringify(output.error_messages)).toMatch(/declined/i);
			expect(output.observed_failure).not.toBeNull();
		});
	},
);
