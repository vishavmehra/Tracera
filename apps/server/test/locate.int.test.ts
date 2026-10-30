import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	auditEvents,
	evidenceAssets,
	modelExecutions,
} from "../src/db/schema.ts";
import {
	type ChatProvider,
	ProviderError,
	type SegmentRequest,
	type SegmentResult,
} from "../src/inference/providers.ts";
import { putBlob } from "../src/lib/fs.ts";
import { newId } from "../src/lib/ids.ts";
import { createUnavailableExecutor } from "../src/sandbox/executor.ts";
import { handleLocateJob, type WorkerDeps } from "../src/worker/handlers.ts";
import {
	asSession,
	asToken,
	createOwner,
	createTestContext,
	createToken,
	login,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);
const BOX = {
	x1: 794,
	y1: 541,
	x2: 911,
	y2: 578,
	width: 1280,
	height: 800,
	confidence: 0.73,
};

let ctx: TestContext;
let session: ReturnType<typeof asSession>;
let owner: { userId: string; workspaceId: string };

beforeAll(async () => {
	// The API only needs to know that segmentation exists; the worker below gets a stub provider.
	ctx = await createTestContext({
		TRACERA_INFERENCE_PROVIDER: "meta",
		TRACERA_META_API_KEY: "LLM_1_dummy",
	});
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await ctx.pool.query("DELETE FROM pgboss.job WHERE name = 'evidence.locate'");
	owner = await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
});

function samProvider(answer: SegmentResult | ProviderError) {
	const calls: SegmentRequest[] = [];
	const provider: ChatProvider & { calls: SegmentRequest[] } = {
		kind: "meta",
		name: "meta",
		calls,
		async complete() {
			throw new Error("chat is not used by locating");
		},
		async locate(request) {
			calls.push(request);
			if (answer instanceof ProviderError) throw answer;
			return answer;
		},
	};
	return provider;
}

const worker = (provider: ChatProvider): WorkerDeps => ({
	config: ctx.config,
	db: ctx.db,
	pool: ctx.pool,
	boss: ctx.boss,
	provider,
	executor: createUnavailableExecutor("sandbox_disabled"),
	workerId: "test-worker",
});

async function addEvidence(
	kind: "screenshot" | "text_note" = "screenshot",
	workspaceId = owner.workspaceId,
) {
	const bytes = kind === "screenshot" ? PNG : Buffer.from("log");
	const blob = await putBlob(path.join(ctx.config.dataDir, "blobs"), bytes);
	const bug = (
		await session("POST", "/api/v1/bug-reports", {
			title: "Checkout total is NaN",
			description: "Applying SAVE10 makes the total NaN.",
			normalize: false,
		})
	).json().bug_report as { id: string };
	const id = newId("evd");
	await ctx.db.insert(evidenceAssets).values({
		id,
		workspaceId,
		bugReportId: bug.id,
		kind,
		origin: "user_provided",
		blobSha256: blob.sha256,
		mimeType: kind === "screenshot" ? "image/png" : "text/plain",
		sizeBytes: blob.size,
		provenance: {},
		retentionUntil: new Date(Date.now() + 86_400_000),
	});
	return id;
}

describe("locating an element in a screenshot", () => {
	it("queues the request for a session only, and checks the evidence first", async () => {
		const shot = await addEvidence();
		const note = await addEvidence("text_note");
		const queued = await session("POST", `/api/v1/evidence/${shot}/locate`, {
			phrase: "button",
		});
		expect(queued.statusCode).toBe(202);
		expect(queued.json()).toEqual({ job: { status: "queued" } });
		const { rows } = await ctx.pool.query(
			"SELECT data FROM pgboss.job WHERE name = 'evidence.locate'",
		);
		expect(rows[0].data).toEqual({
			evidenceId: shot,
			workspaceId: owner.workspaceId,
			phrase: "button",
		});
		const audits = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.action, "evidence.location_requested"));
		expect(audits).toHaveLength(1);

		const cookie = await login(ctx);
		const token = asToken(
			ctx,
			await createToken(ctx, cookie, {
				name: "writer",
				client_kind: "script",
				scopes: ["reports:write", "reports:read"],
			}),
		);
		expect(
			(
				await token("POST", `/api/v1/evidence/${shot}/locate`, { phrase: "x" })
			).json().code,
		).toBe("session_required");
		for (const payload of [{ phrase: "  " }, {}, { phrase: "ok", extra: 1 }])
			expect(
				(await session("POST", `/api/v1/evidence/${shot}/locate`, payload))
					.statusCode,
			).toBe(400);
		expect(
			(
				await session("POST", `/api/v1/evidence/${note}/locate`, {
					phrase: "x",
				})
			).json().code,
		).toBe("evidence_not_observable");
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		expect(
			(await other("POST", `/api/v1/evidence/${shot}/locate`, { phrase: "x" }))
				.statusCode,
		).toBe(404);
		expect(
			(await other("GET", `/api/v1/evidence/${shot}/locations`)).statusCode,
		).toBe(404);
	});

	it("stores the boxes as derived evidence with provenance and lists them newest first", async () => {
		const shot = await addEvidence();
		const provider = samProvider({ boxes: [BOX], imagesProcessed: 1 });
		await handleLocateJob(worker(provider), {
			evidenceId: shot,
			workspaceId: owner.workspaceId,
			phrase: "button",
		});
		expect(provider.calls).toHaveLength(1);
		expect(provider.calls[0]).toMatchObject({
			model: "sam-3.1",
			phrase: "button",
			image: { mimeType: "image/png" },
		});
		const [row] = await ctx.db
			.select()
			.from(evidenceAssets)
			.where(eq(evidenceAssets.derivedFromEvidenceId, shot));
		expect(row).toMatchObject({
			kind: "ai_annotation",
			origin: "generated_by_model",
			mimeType: "application/json",
		});
		const [execution] = await ctx.db
			.select()
			.from(modelExecutions)
			.where(eq(modelExecutions.task, "locate_ui_element"));
		expect(execution).toMatchObject({
			model: "sam-3.1",
			provider: "meta",
			status: "succeeded",
		});
		expect(Number(execution?.estimatedCostUsd)).toBeCloseTo(0.0025, 6);

		const { locations } = (
			await session("GET", `/api/v1/evidence/${shot}/locations`)
		).json();
		expect(locations).toHaveLength(1);
		expect(locations[0]).toMatchObject({
			phrase: "button",
			status: "succeeded",
			boxes: [BOX],
			error: null,
			provenance: {
				task: "locate_ui_element",
				model: "sam-3.1",
				provider: "meta",
				mode: "live",
				placeholder_provider: false,
				source_evidence_id: shot,
				model_execution_id: execution?.id,
			},
		});
		const audits = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.action, "evidence.located"));
		expect(audits).toHaveLength(1);
		expect(audits[0]?.metadata).toMatchObject({
			found: 1,
			status: "succeeded",
		});
	});

	it("keeps 'nothing found' and a provider failure as results of their own", async () => {
		const shot = await addEvidence();
		const job = { evidenceId: shot, workspaceId: owner.workspaceId };
		await handleLocateJob(
			worker(samProvider({ boxes: [], imagesProcessed: 1 })),
			{
				...job,
				phrase: "table",
			},
		);
		await handleLocateJob(
			worker(
				samProvider(
					new ProviderError(
						"provider_bad_request",
						"Model provider rejected the request: HTTP 400",
						false,
					),
				),
			),
			{ ...job, phrase: "banner" },
		);
		const { locations } = (
			await session("GET", `/api/v1/evidence/${shot}/locations`)
		).json();
		expect(
			locations.map(
				(l: { phrase: string; status: string; boxes: unknown[] }) => [
					l.phrase,
					l.status,
					l.boxes.length,
				],
			),
		).toEqual([
			["banner", "failed", 0],
			["table", "succeeded", 0],
		]);
		expect(locations[0].error).toMatchObject({ code: "provider_bad_request" });
	});

	it("refuses another workspace's evidence and a provider without segmentation", async () => {
		const shot = await addEvidence();
		const provider = samProvider({ boxes: [BOX], imagesProcessed: 1 });
		await handleLocateJob(worker(provider), {
			evidenceId: shot,
			workspaceId: "wsp_00000000000000000000000000",
			phrase: "button",
		});
		expect(provider.calls).toHaveLength(0);

		const chatOnly: ChatProvider = {
			kind: "openai_compatible",
			name: "nebius",
			complete: provider.complete,
		};
		await handleLocateJob(worker(chatOnly), {
			evidenceId: shot,
			workspaceId: owner.workspaceId,
			phrase: "button",
		});
		const { locations } = (
			await session("GET", `/api/v1/evidence/${shot}/locations`)
		).json();
		expect(locations[0]).toMatchObject({
			status: "failed",
			error: { code: "capability_unavailable" },
			provenance: { placeholder_provider: true },
		});
	});
});

describe("locating with a provider that has no segmentation model", () => {
	it("answers 409 capability_unavailable for existing evidence and 404 for unknown evidence", async () => {
		const plain = await createTestContext();
		try {
			await createOwner(plain.db, "plain@example.com");
			const plainSession = asSession(
				plain,
				await login(plain, "plain@example.com"),
			);
			const shot = newId("evd");
			expect(
				(
					await plainSession("POST", `/api/v1/evidence/${shot}/locate`, {
						phrase: "button",
					})
				).statusCode,
			).toBe(404);
			const bug = (
				await plainSession("POST", "/api/v1/bug-reports", {
					title: "t",
					description: "d",
					normalize: false,
				})
			).json().bug_report;
			const workspace = (
				await plain.pool.query(
					"SELECT workspace_id FROM bug_reports WHERE id = $1",
					[bug.id],
				)
			).rows[0].workspace_id;
			const blob = await putBlob(path.join(plain.config.dataDir, "blobs"), PNG);
			await plain.db.insert(evidenceAssets).values({
				id: shot,
				workspaceId: workspace,
				bugReportId: bug.id,
				kind: "screenshot",
				origin: "user_provided",
				blobSha256: blob.sha256,
				mimeType: "image/png",
				sizeBytes: blob.size,
				provenance: {},
				retentionUntil: new Date(Date.now() + 86_400_000),
			});
			const response = await plainSession(
				"POST",
				`/api/v1/evidence/${shot}/locate`,
				{
					phrase: "button",
				},
			);
			expect(response.statusCode).toBe(409);
			expect(response.json().code).toBe("capability_unavailable");
		} finally {
			await plain.close();
		}
	});
});
