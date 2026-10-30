import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { ModelExecutionRecord } from "../src/inference/gateway.ts";
import {
	type ChatProvider,
	createHttpProvider,
	ProviderError,
	parseSegmentBoxes,
	type SegmentBox,
} from "../src/inference/providers.ts";
import { createSegmenter } from "../src/inference/segmentation.ts";
import { segmentationAvailable } from "../src/modules/visual-locate.ts";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

/** The answer of the real segmentation model for the phrase "button" on a 1280 x 800 screenshot. */
const LIVE_ANSWER =
	"<0f>0<|box;x1=794;y1=541;x2=911;y2=578;w=1280;h=800;c=0.7264957427978516|><|mask;x=0;y=0;c=0.7264957427978516;data=38,118,!!!!!:JAaeE+qdNS#nV*5/hB8XHnh/?ZFz:|>\n";

describe("segmentation answers", () => {
	it("reads the box of a real answer and ignores the mask", () => {
		expect(parseSegmentBoxes(LIVE_ANSWER)).toEqual([
			{
				x1: 794,
				y1: 541,
				x2: 911,
				y2: 578,
				width: 1280,
				height: 800,
				confidence: 0.7264957427978516,
			},
		]);
	});

	it("reads several records, a missing confidence, and an empty answer", () => {
		const two = `<0f>0<|box;x1=1;y1=2;x2=30;y2=40;w=100;h=100|><|mask;x=0;y=0;data=!!|>,<0f>1<|box;x1=50;y1=60;x2=99;y2=99;w=100;h=100;c=0.5|><|mask;x=0;y=0;data=!!|>`;
		const boxes = parseSegmentBoxes(two);
		expect(boxes.map((b) => [b.x1, b.confidence])).toEqual([
			[1, null],
			[50, 0.5],
		]);
		expect(parseSegmentBoxes("")).toEqual([]);
	});

	it("drops boxes that cannot be right, and caps the count", () => {
		const bad = [
			"x1=a;y1=0;x2=5;y2=5;w=10;h=10",
			"x1=5;y1=0;x2=2;y2=5;w=10;h=10",
			"x1=0;y1=0;x2=10;y2=5;w=10;h=10",
			"x1=-1;y1=0;x2=5;y2=5;w=10;h=10",
			"x1=0;y1=0;x2=5;y2=5;w=0;h=10",
		]
			.map((fields) => `<|box;${fields}|>`)
			.join(",");
		expect(parseSegmentBoxes(bad)).toEqual([]);
		expect(
			parseSegmentBoxes("<|box;x1=0;y1=0;x2=5;y2=5;w=10;h=10;c=7|>")[0]
				?.confidence,
		).toBeNull();
		const many = "<|box;x1=0;y1=0;x2=5;y2=5;w=10;h=10|>".repeat(80);
		expect(parseSegmentBoxes(many)).toHaveLength(50);
	});
});

describe("Meta segmentation adapter", () => {
	const received: Array<{
		path: string;
		headers: IncomingMessage["headers"];
		body: Record<string, unknown>;
	}> = [];
	let reply: { status: number; body: unknown } = { status: 200, body: {} };
	let server: Server;
	let baseUrl = "";

	beforeAll(async () => {
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk;
			});
			req.on("end", () => {
				received.push({
					path: req.url ?? "",
					headers: req.headers,
					body: JSON.parse(raw || "{}"),
				});
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify(reply.body));
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	});
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
	beforeEach(() => {
		received.length = 0;
		reply = {
			status: 200,
			body: {
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: LIVE_ANSWER }],
					},
				],
				usage: { images_processed: 1 },
			},
		};
	});

	const meta = () =>
		createHttpProvider({
			kind: "meta",
			name: "meta",
			baseUrl,
			apiKey: "test-key",
		});

	function segmenter(
		options: {
			provider?: ChatProvider;
			spent?: number;
			redactEmails?: boolean;
		} = {},
	) {
		const records: ModelExecutionRecord[] = [];
		const instance = createSegmenter({
			provider: options.provider ?? meta(),
			model: "sam-3.1",
			timeoutMs: 5000,
			redactEmails: options.redactEmails ?? true,
			maxConcurrency: 1,
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

	it("posts a concept prompt and the image to /responses with string metadata", async () => {
		const { instance, records } = segmenter();
		const result = await instance.locate({
			phrase: "button",
			image: { bytes: PNG },
		});
		expect(result.boxes).toHaveLength(1);
		const call = received[0];
		expect(call?.path).toBe("/v1/responses");
		expect(call?.headers.authorization).toBe("Bearer test-key");
		expect(call?.body).toMatchObject({
			model: "sam-3.1",
			metadata: { include_confidence: "true", mask_encoding: "one_bit" },
		});
		const input = (call?.body.input ?? []) as Array<Record<string, unknown>>;
		const message = input[0];
		expect(message).toMatchObject({ type: "message", role: "user" });
		const [text, image] = (message?.content ?? []) as Array<
			Record<string, string>
		>;
		expect(text).toEqual({ type: "input_text", text: "button" });
		expect(image?.type).toBe("input_image");
		expect(image?.image_url).toMatch(/^data:image\/png;base64,/);
		expect(records[0]).toMatchObject({
			task: "locate_ui_element",
			model: "sam-3.1",
			status: "succeeded",
			attempts: 1,
			estimatedCostUsd: 0.0025,
		});
	});

	it("treats an empty answer as nothing found, not as an error", async () => {
		reply = {
			status: 200,
			body: {
				status: "completed",
				output: [{ content: [{ type: "output_text", text: "" }] }],
				usage: { images_processed: 1 },
			},
		};
		const { instance, records } = segmenter();
		expect(
			(await instance.locate({ phrase: "x", image: { bytes: PNG } })).boxes,
		).toEqual([] satisfies SegmentBox[]);
		expect(records[0]?.status).toBe("succeeded");
	});

	it("redacts the phrase before it is sent", async () => {
		const { instance } = segmenter();
		const result = await instance.locate({
			phrase: "button for ada@example.com",
			image: { bytes: PNG },
		});
		const sent = JSON.stringify(received[0]?.body);
		expect(sent).not.toContain("ada@example.com");
		expect(result.phrase).toContain("[REDACTED:email]");
	});

	it("has no segmentation capability on providers other than Meta, and says so", async () => {
		const compatible = createHttpProvider({
			kind: "openai_compatible",
			name: "nebius",
			baseUrl,
			apiKey: "k",
		});
		expect(compatible.locate).toBeUndefined();
		const { instance, records } = segmenter({ provider: compatible });
		await expect(
			instance.locate({ phrase: "button", image: { bytes: PNG } }),
		).rejects.toMatchObject({ code: "capability_unavailable" });
		expect(received).toHaveLength(0);
		expect(records[0]).toMatchObject({ status: "failed", attempts: 0 });
		expect(
			segmentationAvailable(
				loadConfig({
					DATABASE_URL: "postgres://u:p@localhost:5432/d",
					TRACERA_INFERENCE_PROVIDER: "meta",
					TRACERA_META_API_KEY: "LLM_1_x",
				}),
			),
		).toBe(true);
		expect(
			segmentationAvailable(
				loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/d" }),
			),
		).toBe(false);
	});

	it("retries a transient failure, stops at the budget, and refuses a bad image", async () => {
		const flaky = meta();
		let calls = 0;
		const provider: ChatProvider = {
			...flaky,
			locate: async (request, signal) => {
				calls += 1;
				if (calls === 1)
					throw new ProviderError(
						"provider_unavailable",
						"Model provider error 503",
						true,
					);
				return (flaky.locate as NonNullable<typeof flaky.locate>)(
					request,
					signal,
				);
			},
		};
		const retried = segmenter({ provider });
		await retried.instance.locate({ phrase: "button", image: { bytes: PNG } });
		expect(retried.records[0]).toMatchObject({
			status: "succeeded",
			attempts: 2,
		});

		const broke = segmenter({ spent: 5 });
		await expect(
			broke.instance.locate({ phrase: "button", image: { bytes: PNG } }),
		).rejects.toMatchObject({ code: "inference_budget_exceeded" });
		const bad = segmenter();
		await expect(
			bad.instance.locate({
				phrase: "button",
				image: { bytes: new TextEncoder().encode("GIF89a") },
			}),
		).rejects.toMatchObject({ code: "image_type_unsupported" });
		expect(calls).toBe(2);
	});

	it("maps an error status to a typed provider error", async () => {
		reply = {
			status: 402,
			body: { error: { code: "billing_not_configured" } },
		};
		const { instance, records } = segmenter();
		await expect(
			instance.locate({ phrase: "button", image: { bytes: PNG } }),
		).rejects.toMatchObject({ code: "provider_billing_not_configured" });
		expect(records[0]?.status).toBe("failed");
	});
});
