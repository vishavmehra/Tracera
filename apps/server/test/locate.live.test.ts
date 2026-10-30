import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { ModelExecutionRecord } from "../src/inference/gateway.ts";
import { createSegmenter } from "../src/inference/segmentation.ts";
import { createProvider } from "../src/worker/handlers.ts";
import { CHECKOUT_PAGE, renderScreenshotWithBox } from "./visual-fixtures.ts";

// [live] Locates the Place order button in a locally rendered screenshot with the segmentation model
// (a fraction of a cent) and compares the box with where the browser laid the button out.
// Run: npm run smoke:provider. Set TRACERA_LIVE_RESULT_DIR to keep the answer.
const envFile = path.resolve(import.meta.dirname, "../../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig({ ...process.env, NODE_ENV: "test" });

type Rect = { x: number; y: number; width: number; height: number };

/** Intersection over union of two rectangles. */
const overlap = (a: Rect, b: Rect) => {
	const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	const shared = Math.max(0, w) * Math.max(0, h);
	return shared / (a.width * a.height + b.width * b.height - shared);
};

describe.skipIf(config.inference.provider !== "meta")(
	`[live] ${config.inference.providerName} / ${config.inference.segmentModel} locates an element`,
	() => {
		it("finds the button where the browser drew it", async () => {
			const shot = await renderScreenshotWithBox(CHECKOUT_PAGE, "button");
			const records: ModelExecutionRecord[] = [];
			const segmenter = createSegmenter({
				provider: createProvider(config),
				model: config.inference.segmentModel,
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
			const result = await segmenter.locate({
				phrase: "button",
				image: { bytes: shot.png, declaredType: "image/png" },
			});
			const best = Math.max(
				0,
				...result.boxes.map((box) =>
					overlap(
						{
							x: box.x1,
							y: box.y1,
							width: box.x2 - box.x1 + 1,
							height: box.y2 - box.y1 + 1,
						},
						shot.box,
					),
				),
			);
			const report = JSON.stringify(
				{
					model: records[0]?.model,
					status: records[0]?.status,
					attempts: records[0]?.attempts,
					latency_ms: records[0]?.latencyMs,
					estimated_cost_usd: records[0]?.estimatedCostUsd,
					browser_box: shot.box,
					boxes: result.boxes,
					best_overlap: best,
				},
				null,
				2,
			);
			console.log(report);
			if (process.env.TRACERA_LIVE_RESULT_DIR) {
				mkdirSync(process.env.TRACERA_LIVE_RESULT_DIR, { recursive: true });
				writeFileSync(
					path.join(process.env.TRACERA_LIVE_RESULT_DIR, "locate.json"),
					report,
				);
			}
			expect(records[0]?.status).toBe("succeeded");
			expect(result.boxes.length).toBeGreaterThan(0);
			expect(best).toBeGreaterThan(0.5);
		});
	},
);
