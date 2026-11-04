import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	auditEvents,
	evidenceAssets,
	investigationEvidence,
	investigationSteps,
	modelExecutions,
} from "../src/db/schema.ts";
import {
	type ChatProvider,
	ProviderError,
} from "../src/inference/providers.ts";
import { createUnavailableExecutor } from "../src/sandbox/executor.ts";
import {
	handleRecordingJob,
	handleStageJob,
	type WorkerDeps,
} from "../src/worker/handlers.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	csrf,
	login,
	makeGitRepo,
	normalizationOutput,
	repositoryBody,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

// [mock] The browser extracts the keyframes; here they are tiny stand-in images and the provider answers from a script.

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);
const RECORDING = "rec_abcdefgh1234";
const BOX = {
	x1: 260,
	y1: 228,
	x2: 476,
	y2: 268,
	width: 1280,
	height: 720,
	confidence: 0.87,
};

const observation = (text: string) => ({
	summary: text,
	visible_text: [{ text, location: "page" }],
	error_messages: text.includes("banner")
		? [{ text: "Error: could not apply coupon SAVE10", location: "red banner" }]
		: [],
	ui_elements: [],
	observed_failure: text.includes("banner")
		? "A red banner reports a coupon error"
		: null,
	observations: [{ statement: text, basis: "visible" }],
	inferences: [],
	missing_information: [],
});
const analysis = {
	summary: "The cart total turns into $NaN after a coupon error.",
	timeline: [
		{
			timestamp_seconds: 0,
			statement: "The checkout page shows a $49.60 total",
			basis: "visible",
		},
		{
			timestamp_seconds: 3,
			statement: "A red banner reports a coupon error and the total reads $NaN",
			basis: "visible",
		},
		{
			timestamp_seconds: 1.5,
			statement: "The user clicked Apply coupon SAVE10",
			basis: "inferred",
		},
		{
			timestamp_seconds: 900,
			statement: "A time outside the recording",
			basis: "visible",
		},
	],
	error_messages: [
		{ text: "Error: could not apply coupon SAVE10", timestamp_seconds: 3 },
	],
	failing_element: "red banner",
	reproduction_steps: [
		{ step: "Open the checkout page" },
		{ step: "Click Apply coupon SAVE10" },
	],
	missing_information: ["What happened between the frames"],
};

type Script = { observeFails?: boolean; analyzeFails?: ProviderError };
function provider(script: Script = {}) {
	const seen = { observe: 0, analyze: 0, locate: 0, analyzeUser: "" };
	const p: ChatProvider & { seen: typeof seen } = {
		kind: "meta",
		name: "meta",
		seen,
		async complete(request) {
			const user = String(
				request.messages.filter((m) => m.role === "user").at(-1)?.content,
			);
			const usage = {
				inputTokens: 1500,
				outputTokens: 400,
				reasoningTokens: 100,
				cachedTokens: 0,
			};
			if (request.schema.name === "observe_screenshot") {
				seen.observe += 1;
				if (script.observeFails)
					throw new ProviderError(
						"provider_bad_request",
						"Model provider rejected the request: HTTP 400",
						false,
					);
				return {
					content: JSON.stringify(
						observation(
							seen.observe < 3
								? "The checkout page with a total"
								: "A red banner above the total",
						),
					),
					finishReason: "stop",
					usage,
				};
			}
			if (request.schema.name === "analyze_recording") {
				seen.analyze += 1;
				seen.analyzeUser = user;
				if (script.analyzeFails) throw script.analyzeFails;
				return {
					content: JSON.stringify(analysis),
					finishReason: "stop",
					usage,
				};
			}
			if (request.schema.name === "normalize_bug_report")
				return {
					content: JSON.stringify(normalizationOutput),
					finishReason: "stop",
					usage,
				};
			throw new ProviderError(
				"provider_bad_request",
				`unexpected ${request.schema.name}`,
				false,
			);
		},
		async locate() {
			seen.locate += 1;
			return { boxes: [BOX], imagesProcessed: 1 };
		},
	};
	return p;
}

let ctx: TestContext;
let session: ReturnType<typeof asSession>;
let cookie = "";
let owner: { userId: string; workspaceId: string };

beforeAll(async () => {
	ctx = await createTestContext({
		TRACERA_INFERENCE_PROVIDER: "meta",
		TRACERA_META_API_KEY: "LLM_1_dummy",
		TRACERA_MAX_IMAGE_BYTES: "2048",
	});
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await ctx.pool.query(
		"DELETE FROM pgboss.job WHERE name IN ('evidence.recording', 'evidence.observe')",
	);
	owner = await createOwner(ctx.db);
	cookie = await login(ctx);
	session = asSession(ctx, cookie);
});

const worker = (p: ChatProvider): WorkerDeps => ({
	config: {
		...ctx.config,
		inference: {
			...ctx.config.inference,
			visionModel: "muse-spark-1.3",
			reasoningModel: "muse-spark-1.3",
			taskModels: {
				...ctx.config.inference.taskModels,
				normalize_bug_report: "muse-spark-1.3",
			},
		},
	},
	db: ctx.db,
	pool: ctx.pool,
	boss: ctx.boss,
	provider: p,
	executor: createUnavailableExecutor("sandbox_disabled"),
	workerId: "test-worker",
});

const report = async (extra: Record<string, unknown> = {}) =>
	(
		await session("POST", "/api/v1/bug-reports", {
			title: "Checkout total is NaN",
			description: "Applying SAVE10 makes the total NaN.",
			normalize: false,
			...extra,
		})
	).json().bug_report as { id: string };

/** One keyframe through the ordinary screenshot upload, tagged with its recording. */
async function frame(
	bugId: string,
	index: number,
	options: {
		recording?: string;
		count?: number;
		bytes?: Buffer;
		type?: string;
		headers?: Record<string, string>;
		ms?: number;
	} = {},
) {
	const form = new FormData();
	form.set(
		"file",
		new Blob([new Uint8Array(options.bytes ?? PNG)], {
			type: options.type ?? "image/png",
		}),
		"frame.png",
	);
	form.set(
		"meta",
		JSON.stringify({
			kind: "screenshot",
			source_recording: {
				recording_id: options.recording ?? RECORDING,
				name: "demo.webm",
				index,
				count: options.count ?? 3,
				timestamp_ms: options.ms ?? index * 3000,
				duration_ms: 7500,
			},
		}),
	);
	const request = new Request("http://localhost/", {
		method: "POST",
		body: form,
	});
	return ctx.app.inject({
		method: "POST",
		url: `/api/v1/bug-reports/${bugId}/evidence`,
		headers: {
			cookie,
			"content-type": request.headers.get("content-type") ?? "",
			...(options.headers ?? csrf(ctx.config)),
		},
		payload: Buffer.from(await request.arrayBuffer()),
	});
}

/** The frames a browser would send, then the queued job consumed by the test. */
async function uploadAll(bugId: string, recording = RECORDING, count = 3) {
	for (let i = 0; i < count; i++)
		expect((await frame(bugId, i, { recording, count })).statusCode).toBe(201);
	await ctx.pool.query(
		"DELETE FROM pgboss.job WHERE name = 'evidence.recording'",
	);
}
const job = (bugId: string, recordingId = RECORDING) => ({
	workspaceId: owner.workspaceId,
	bugReportId: bugId,
	recordingId,
});
const recordings = async (bugId: string) =>
	(await session("GET", `/api/v1/bug-reports/${bugId}/recordings`)).json()
		.recordings;

describe("uploading keyframes", () => {
	it("stores each frame as tagged screenshot evidence, queues the analysis once the set is complete, and refuses what it should", async () => {
		const bug = await report();
		const first = await frame(bug.id, 0);
		expect(first.statusCode).toBe(201);
		expect(first.json().evidence).toMatchObject({
			kind: "screenshot",
			provenance: { source_recording: { recording_id: RECORDING, index: 0 } },
		});
		expect((await recordings(bug.id))[0]).toMatchObject({
			status: "receiving",
			frame_count: 3,
			name: "demo.webm",
		});
		const again = await frame(bug.id, 0);
		expect(again.statusCode).toBe(200);
		expect(again.json().evidence.id).toBe(first.json().evidence.id);
		expect((await frame(bug.id, 1)).statusCode).toBe(201);
		const jobs = (name: string) =>
			ctx.pool.query(
				"SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1",
				[name],
			);
		expect((await jobs("evidence.recording")).rows[0].n).toBe(0);
		expect((await frame(bug.id, 2)).statusCode).toBe(201);
		expect((await jobs("evidence.recording")).rows[0].n).toBe(1);
		// The recording reads its frames itself, so no frame is queued to be read on its own.
		expect((await jobs("evidence.observe")).rows[0].n).toBe(0);
		const [row] = await ctx.db
			.select()
			.from(evidenceAssets)
			.where(eq(evidenceAssets.id, first.json().evidence.id));
		expect(row).toMatchObject({
			kind: "screenshot",
			originalFilename: "demo.webm at 0:00.0",
			provenance: {
				source_recording: {
					recording_id: RECORDING,
					index: 0,
					count: 3,
					timestamp_ms: 0,
					duration_ms: 7500,
				},
			},
		});
		expect(
			await ctx.db
				.select()
				.from(auditEvents)
				.where(eq(auditEvents.action, "evidence.uploaded")),
		).toHaveLength(3);
		expect((await recordings(bug.id))[0]).toMatchObject({
			status: "queued",
			frames: [
				{ index: 0, timestamp_ms: 0 },
				{ index: 1, timestamp_ms: 3000 },
				{ index: 2, timestamp_ms: 6000 },
			],
		});

		expect(
			(await frame(bug.id, 0, { bytes: Buffer.from("GIF89a....") })).statusCode,
		).toBe(415);
		expect(
			(
				await frame(bug.id, 0, {
					bytes: Buffer.concat([PNG, Buffer.alloc(4096)]),
					recording: "rec_other12345",
				})
			).statusCode,
		).toBe(413);
		expect((await frame(bug.id, 3, { count: 5 })).json().code).toBe(
			"recording_mismatch",
		);
		expect(
			(await frame(bug.id, 3, { recording: "rec_other12345" })).statusCode,
		).toBe(400);
		expect(
			(
				await frame(bug.id, 0, {
					headers: {
						origin: "http://elsewhere.example",
						"x-tracera-csrf": "1",
					},
				})
			).json().code,
		).toBe("csrf_failed");
		expect(
			(
				await ctx.app.inject({
					method: "POST",
					url: `/api/v1/bug-reports/${bug.id}/evidence`,
					headers: { "content-type": "multipart/form-data; boundary=x" },
					payload: "--x--",
				})
			).statusCode,
		).toBe(401);
		for (const id of ["rec_second12345", "rec_third123456"])
			expect(
				(await frame(bug.id, 0, { recording: id, count: 2 })).statusCode,
			).toBe(201);
		const fourth = await frame(bug.id, 0, {
			recording: "rec_fourth12345",
			count: 2,
		});
		expect(fourth.statusCode).toBe(409);
		expect(fourth.json().code).toBe("too_many_recordings");
		expect(await recordings(bug.id)).toHaveLength(3);
		await createOwner(ctx.db, "other@example.com");
		cookie = await login(ctx, "other@example.com");
		expect((await frame(bug.id, 0)).statusCode).toBe(404);
	});
});

describe("analyzing a recording [mock inference]", () => {
	it("reads each frame, analyzes the readings as text, and locates the named element in the frames", async () => {
		const bug = await report();
		await uploadAll(bug.id);
		const p = provider();
		await handleRecordingJob(worker(p), job(bug.id));
		expect(p.seen).toMatchObject({ observe: 3, analyze: 1, locate: 3 });
		expect(p.seen.analyzeUser).toContain(
			"3 keyframes sampled evenly from a 7.5 second screen recording",
		);
		expect(p.seen.analyzeUser).toContain(
			'<untrusted source="FRAME-3" kind="frame_reading" time="6.0 s">',
		);
		expect(p.seen.analyzeUser).not.toMatch(/watched/i);
		const [state] = await recordings(bug.id);
		expect(state).toMatchObject({
			status: "succeeded",
			region_phrase: "red banner",
			analysis: {
				status: "succeeded",
				model: "muse-spark-1.3",
				provider: "meta",
				mode: "live",
				placeholder_provider: false,
				frames_read: 3,
			},
		});
		expect(
			state.frames.map((f: { observation: string; regions: unknown[] }) => [
				f.observation,
				f.regions.length,
			]),
		).toEqual([
			["succeeded", 1],
			["succeeded", 1],
			["succeeded", 1],
		]);
		// A time that is not inside the recording is not kept.
		expect(
			state.analysis.output.timeline.map(
				(e: { timestamp_seconds: number | null }) => e.timestamp_seconds,
			),
		).toEqual([0, 3, 1.5, null]);
		const executions = await ctx.db.select().from(modelExecutions);
		expect(executions.map((e) => e.task).sort()).toEqual([
			"analyze_recording",
			"locate_ui_element",
			"locate_ui_element",
			"locate_ui_element",
			"observe_screenshot",
			"observe_screenshot",
			"observe_screenshot",
		]);
		// Frames are not read as separate screenshots, and a second run reuses the succeeded analysis.
		await handleRecordingJob(worker(p), job(bug.id));
		expect(p.seen).toMatchObject({ observe: 3, analyze: 1 });
	});

	it("stores why it failed, and a retry reads again", async () => {
		const bug = await report();
		await uploadAll(bug.id);
		const unreadable = provider({ observeFails: true });
		await handleRecordingJob(worker(unreadable), job(bug.id));
		expect(unreadable.seen.analyze).toBe(0);
		expect((await recordings(bug.id))[0]).toMatchObject({
			status: "failed",
			error: { code: "frames_unreadable" },
			analysis: { status: "failed", output: null },
		});
		const broken = provider({
			analyzeFails: new ProviderError(
				"provider_unavailable",
				"Model provider error 503",
				false,
			),
		});
		await handleRecordingJob(worker(broken), job(bug.id));
		expect((await recordings(bug.id))[0]).toMatchObject({
			status: "failed",
			error: { code: "provider_unavailable" },
		});
		expect(broken.seen.locate).toBe(0);
		const again = await session(
			"POST",
			`/api/v1/bug-reports/${bug.id}/recordings`,
			{ recording_id: RECORDING },
		);
		expect(again.statusCode).toBe(202);
		expect((await recordings(bug.id))[0].status).toBe("queued");
		await ctx.pool.query(
			"DELETE FROM pgboss.job WHERE name = 'evidence.recording'",
		);
		const good = provider();
		await handleRecordingJob(worker(good), job(bug.id));
		expect((await recordings(bug.id))[0]).toMatchObject({
			status: "succeeded",
		});
		expect(
			(
				await session("POST", `/api/v1/bug-reports/${bug.id}/recordings`, {
					recording_id: "rec_missing1234",
				})
			).statusCode,
		).toBe(404);
	});
});

describe("recordings in an investigation [mock inference]", () => {
	it("gives the analysis to normalization and collect_context as labelled evidence and names what was not read", async () => {
		const repo = makeGitRepo(ctx.repoRoot);
		const repository = (
			await session("POST", "/api/v1/repositories", repositoryBody(repo))
		).json().repository;
		const bug = await report({ repository_id: repository.id });
		await uploadAll(bug.id);
		await frame(bug.id, 0, { recording: "rec_unfinished1", count: 2 });
		const p = provider();
		await handleRecordingJob(worker(p), job(bug.id));
		const investigation = (
			await session("POST", "/api/v1/investigations", { bug_report_id: bug.id })
		).json().investigation;
		const inputs: string[] = [];
		const staged: ChatProvider = {
			...p,
			async complete(request, signal) {
				if (request.schema.name === "normalize_bug_report")
					inputs.push(
						String(
							request.messages.filter((m) => m.role === "user").at(-1)?.content,
						),
					);
				return p.complete(request, signal);
			},
		};
		for (const stage of ["normalize", "collect_context"] as const)
			await handleStageJob(worker(staged), {
				investigationId: investigation.id,
				stage,
				attempt: 1,
			});
		expect(inputs[0]).toContain(
			'<untrusted source="REC-1" kind="recording_observation">',
		);
		expect(inputs[0]).toContain(
			'<untrusted source="RECINFER-1" kind="recording_inference">',
		);
		expect(inputs[0]).toContain(
			"Analyzed 3 keyframes sampled at these timestamps: 0:00.0, 0:03.0, 0:06.0",
		);
		expect(inputs[0]).toContain(
			"1 attached screenshot(s) or recording(s) could not be read",
		);
		const rows = await ctx.db
			.select()
			.from(investigationEvidence)
			.where(eq(investigationEvidence.investigationId, investigation.id));
		const observed = rows.find((r) => r.handle === "REC-1");
		const guessed = rows.find((r) => r.handle === "RECINFER-1");
		expect(observed).toMatchObject({
			kind: "model_observation",
			basis: "reported",
			provenance: { method: "vision_model", frames: 3, mode: "live" },
		});
		expect(observed?.label).toBe(
			"Observed in recording: demo.webm ([live] muse-spark-1.3, 3 keyframes)",
		);
		expect(observed?.content).toContain("The video itself was not read");
		expect(observed?.content).toContain(
			"[0:03.0] A red banner reports a coupon error",
		);
		expect(observed?.content).toContain("Element that looks wrong: red banner");
		expect(observed?.content).not.toContain("Click Apply coupon");
		expect(guessed).toMatchObject({ basis: "inferred" });
		expect(guessed?.content).toContain("1. Open the checkout page");
		expect(rows.some((r) => r.handle.startsWith("SHOT-"))).toBe(false);
		const step = (
			await ctx.db
				.select()
				.from(investigationSteps)
				.where(eq(investigationSteps.investigationId, investigation.id))
		).find((s) => s.stage === "collect_context");
		expect(JSON.stringify(step?.summary.limitations)).toContain(
			"has not fully arrived",
		);
	});
});
