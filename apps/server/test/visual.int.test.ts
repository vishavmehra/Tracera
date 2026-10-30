import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	auditEvents,
	evidenceAssets,
	investigationEvidence,
	investigationSteps,
	modelExecutions,
} from "../src/db/schema.ts";
import { createMockProvider } from "../src/inference/mock.ts";
import {
	type ChatProvider,
	ProviderError,
} from "../src/inference/providers.ts";
import { putBlob } from "../src/lib/fs.ts";
import { newId } from "../src/lib/ids.ts";
import { observeEvidenceAsset } from "../src/modules/visual-evidence.ts";
import { createUnavailableExecutor } from "../src/sandbox/executor.ts";
import {
	handleObserveJob,
	handleStageJob,
	type WorkerDeps,
} from "../src/worker/handlers.ts";
import {
	asSession,
	asToken,
	createOwner,
	createTestContext,
	createToken,
	login,
	makeGitRepo,
	normalizationOutput,
	repositoryBody,
	resetDatabase,
	scriptedProvider,
	type TestContext,
} from "./helpers.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

const observeOutput = {
	summary: "A checkout page whose total reads $NaN.",
	visible_text: [
		{ text: "Total: $NaN", location: "order summary" },
		{
			text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
			location: "debug footer",
		},
	],
	error_messages: [
		{ text: "could not apply coupon SAVE10", location: "red banner" },
	],
	ui_elements: [
		{
			kind: "button",
			label: "Place order",
			state: "disabled",
			location: "order summary",
		},
	],
	observed_failure: "The total shows $NaN where an amount belongs.",
	observations: [{ statement: "The Total line reads $NaN", basis: "visible" }],
	inferences: [
		{
			statement: "The coupon discount is probably undefined",
			confidence: "medium",
		},
	],
	missing_information: ["The page address"],
};

let ctx: TestContext;
let session: ReturnType<typeof asSession>;
let owner: { userId: string; workspaceId: string };

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await ctx.pool.query(
		"DELETE FROM pgboss.job WHERE name = 'evidence.observe'",
	);
	owner = await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
});

/** A scripted provider that also records which task carried images. */
function visionProvider(
	script: Record<string, unknown> = {},
): ChatProvider & { tasks: Array<{ task: string; images: string[] }> } {
	const base = scriptedProvider({
		normalize_bug_report: normalizationOutput,
		observe_screenshot: observeOutput,
		...script,
	});
	const tasks: Array<{ task: string; images: string[] }> = [];
	return {
		kind: base.kind,
		name: base.name,
		tasks,
		async complete(request, signal) {
			const user = request.messages.filter((m) => m.role === "user").at(-1);
			tasks.push({
				task: request.schema.name,
				images: (user?.images ?? []).map((image) => image.mimeType),
			});
			return base.complete(request, signal);
		},
	};
}

function worker(
	provider: ChatProvider,
	inference: Partial<WorkerDeps["config"]["inference"]> = {},
): WorkerDeps {
	return {
		config: {
			...ctx.config,
			inference: {
				...ctx.config.inference,
				visionModel: "muse-spark-1.3",
				taskModels: {
					...ctx.config.inference.taskModels,
					normalize_bug_report: "muse-spark-1.3",
				},
				...inference,
			},
		},
		db: ctx.db,
		pool: ctx.pool,
		boss: ctx.boss,
		provider,
		executor: createUnavailableExecutor("sandbox_disabled"),
		workerId: "test-worker",
	};
}

async function createReport(body: Record<string, unknown> = {}) {
	const response = await session("POST", "/api/v1/bug-reports", {
		title: "Checkout total is NaN",
		description: "Applying SAVE10 at checkout makes the total NaN.",
		normalize: false,
		...body,
	});
	return response.json().bug_report as { id: string };
}

/** What the upload endpoint stores: a content-addressed blob and a `screenshot` evidence row. */
async function addEvidence(
	bugReportId: string,
	options: {
		workspaceId?: string;
		kind?: "screenshot" | "text_note";
		bytes?: Buffer;
		mimeType?: string;
	} = {},
) {
	const bytes = options.bytes ?? PNG;
	const blob = await putBlob(path.join(ctx.config.dataDir, "blobs"), bytes);
	const id = newId("evd");
	await ctx.db.insert(evidenceAssets).values({
		id,
		workspaceId: options.workspaceId ?? owner.workspaceId,
		bugReportId,
		kind: options.kind ?? "screenshot",
		origin: "user_provided",
		blobSha256: blob.sha256,
		mimeType: options.mimeType ?? "image/png",
		sizeBytes: blob.size,
		originalFilename: "cart.png",
		provenance: {},
		retentionUntil: new Date(Date.now() + 86_400_000),
	});
	return id;
}

const derived = (evidenceId: string) =>
	ctx.db
		.select()
		.from(evidenceAssets)
		.where(eq(evidenceAssets.derivedFromEvidenceId, evidenceId));

describe("reading a screenshot [mock inference]", () => {
	it("stores the reading as derived evidence with provenance, redacts what it transcribed, and records the execution", async () => {
		const bug = await createReport();
		const evidenceId = await addEvidence(bug.id);
		const provider = visionProvider();
		await handleObserveJob(worker(provider), {
			evidenceId,
			workspaceId: owner.workspaceId,
		});
		expect(provider.tasks).toEqual([
			{ task: "observe_screenshot", images: ["image/png"] },
		]);
		const [row] = await derived(evidenceId);
		expect(row?.redactions).toHaveProperty("count", expect.any(Number));
		expect(row).toMatchObject({
			kind: "ai_annotation",
			origin: "generated_by_model",
			bugReportId: bug.id,
			mimeType: "application/json",
			redactions: { applied_by: "server" },
		});
		const [execution] = await ctx.db
			.select()
			.from(modelExecutions)
			.where(eq(modelExecutions.task, "observe_screenshot"));
		expect(execution).toMatchObject({
			model: "muse-spark-1.3",
			provider: "scripted",
			status: "succeeded",
			bugReportId: bug.id,
		});
		expect(row?.provenance).toMatchObject({
			task: "observe_screenshot",
			prompt_version: "observe_screenshot.v1",
			model: "muse-spark-1.3",
			provider: "scripted",
			mode: "live",
			placeholder_provider: true,
			model_execution_id: execution?.id,
			source_evidence_id: evidenceId,
			status: "succeeded",
		});
		const response = (
			await session("GET", `/api/v1/evidence/${evidenceId}/observations`)
		).json();
		const [observation] = response.observations;
		expect(observation.status).toBe("succeeded");
		expect(observation.output.visible_text[1].text).toContain("[REDACTED:");
		expect(JSON.stringify(observation)).not.toContain("abcdefghijklmnop");
		expect(observation.output.observations[0].basis).toBe("visible");
		const audits = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.action, "evidence.observed"));
		expect(audits).toHaveLength(1);
		expect(JSON.stringify(audits[0]?.metadata)).not.toContain("NaN");
	});

	it("labels a reading by the mock adapter as mock and leaves it empty", async () => {
		const bug = await createReport();
		const evidenceId = await addEvidence(bug.id);
		const stored = await observeEvidenceAsset(worker(createMockProvider()), {
			workspaceId: owner.workspaceId,
			evidenceId,
		});
		expect(stored?.provenance).toMatchObject({
			mode: "mock",
			placeholder_provider: false,
			provider: "mock",
		});
		expect(stored?.output?.summary).toBe(
			"Mock inference: no model looked at this image.",
		);
		expect(stored?.output?.observed_failure).toBeNull();
	});

	it("reads one screenshot once when the job and a stage ask at the same time", async () => {
		const bug = await createReport();
		const evidenceId = await addEvidence(bug.id);
		const provider = visionProvider();
		const deps = worker(provider);
		const [a, b] = await Promise.all([
			observeEvidenceAsset(deps, {
				workspaceId: owner.workspaceId,
				evidenceId,
			}),
			observeEvidenceAsset(deps, {
				workspaceId: owner.workspaceId,
				evidenceId,
			}),
		]);
		expect(provider.tasks).toHaveLength(1);
		expect(a?.id).toBe(b?.id);
		expect(await derived(evidenceId)).toHaveLength(1);
	});

	it("stores a failed reading, retries it on the next ask, and lists the newest first", async () => {
		const bug = await createReport();
		const evidenceId = await addEvidence(bug.id);
		await observeEvidenceAsset(
			worker(
				visionProvider({
					observe_screenshot: new ProviderError(
						"provider_bad_request",
						"Model provider rejected the request: HTTP 400",
						false,
					),
				}),
			),
			{ workspaceId: owner.workspaceId, evidenceId },
		);
		let listed = (
			await session("GET", `/api/v1/evidence/${evidenceId}/observations`)
		).json().observations;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			status: "failed",
			output: null,
			error: { code: "provider_bad_request" },
		});
		await observeEvidenceAsset(worker(visionProvider()), {
			workspaceId: owner.workspaceId,
			evidenceId,
		});
		listed = (
			await session("GET", `/api/v1/evidence/${evidenceId}/observations`)
		).json().observations;
		expect(listed.map((o: { status: string }) => o.status)).toEqual([
			"succeeded",
			"failed",
		]);
	});

	it("refuses an image above the size limit without calling the model", async () => {
		const bug = await createReport();
		const evidenceId = await addEvidence(bug.id);
		const provider = visionProvider();
		const stored = await observeEvidenceAsset(
			worker(provider, { maxImageBytes: 10 }),
			{ workspaceId: owner.workspaceId, evidenceId },
		);
		expect(provider.tasks).toHaveLength(0);
		expect(stored).toMatchObject({
			status: "failed",
			error: { code: "image_too_large" },
		});
	});

	it("ignores evidence of another workspace", async () => {
		const bug = await createReport();
		const evidenceId = await addEvidence(bug.id);
		const provider = visionProvider();
		const stored = await observeEvidenceAsset(worker(provider), {
			workspaceId: "wsp_00000000000000000000000000",
			evidenceId,
		});
		expect(stored).toBeNull();
		expect(provider.tasks).toHaveLength(0);
	});
});

describe("evidence API for screenshots", () => {
	it("scopes observations to the workspace and rejects what is not a readable screenshot", async () => {
		const bug = await createReport();
		const shot = await addEvidence(bug.id);
		const note = await addEvidence(bug.id, {
			kind: "text_note",
			bytes: Buffer.from("hello"),
			mimeType: "text/plain",
		});
		expect(
			(await session("GET", `/api/v1/evidence/${shot}/observations`)).json(),
		).toMatchObject({
			evidence_id: shot,
			kind: "screenshot",
			observations: [],
		});
		expect(
			(await session("GET", `/api/v1/evidence/${note}/observations`)).json()
				.code,
		).toBe("evidence_not_observable");
		expect(
			(await session("GET", "/api/v1/evidence/not-an-id/observations"))
				.statusCode,
		).toBe(404);
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		for (const url of [
			`/api/v1/evidence/${shot}/observations`,
			`/api/v1/evidence/${shot}/content`,
		])
			expect((await other("GET", url)).statusCode).toBe(404);
		expect(
			(await other("POST", `/api/v1/evidence/${shot}/observations`)).statusCode,
		).toBe(404);
	});

	it("serves screenshot bytes as an inert image and refuses other content", async () => {
		const bug = await createReport();
		const shot = await addEvidence(bug.id);
		const note = await addEvidence(bug.id, {
			kind: "text_note",
			bytes: Buffer.from("secret log"),
			mimeType: "text/plain",
		});
		const image = await session("GET", `/api/v1/evidence/${shot}/content`);
		expect(image.statusCode).toBe(200);
		expect(image.headers["content-type"]).toBe("image/png");
		expect(image.headers["x-content-type-options"]).toBe("nosniff");
		expect(image.headers["content-security-policy"]).toContain("sandbox");
		expect(Buffer.from(image.rawPayload)).toEqual(PNG);
		expect(
			(await session("GET", `/api/v1/evidence/${note}/content`)).statusCode,
		).toBe(415);
	});

	it("queues a read, audits each request, and needs the write scope and a CSRF header", async () => {
		const bug = await createReport();
		const shot = await addEvidence(bug.id);
		const cookie = await login(ctx);
		expect(
			(
				await ctx.app.inject({
					method: "POST",
					url: `/api/v1/evidence/${shot}/observations`,
					headers: { cookie },
				})
			).json().code,
		).toBe("csrf_failed");
		for (let i = 0; i < 2; i++) {
			const queued = await session(
				"POST",
				`/api/v1/evidence/${shot}/observations`,
			);
			expect(queued.statusCode).toBe(202);
			expect(queued.json()).toEqual({ job: { status: "queued" } });
		}
		const { rows } = await ctx.pool.query(
			"SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'evidence.observe' AND data->>'evidenceId' = $1",
			[shot],
		);
		// Repeated requests are harmless: the handler reuses a succeeded reading.
		expect(rows[0].n).toBeGreaterThanOrEqual(1);
		const audits = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.action, "evidence.observation_requested"));
		expect(audits).toHaveLength(2);
		const reader = asToken(
			ctx,
			await createToken(ctx, cookie, {
				name: "reader",
				client_kind: "script",
				scopes: ["reports:read"],
			}),
		);
		expect(
			(await reader("GET", `/api/v1/evidence/${shot}/observations`)).statusCode,
		).toBe(200);
		expect(
			(await reader("POST", `/api/v1/evidence/${shot}/observations`))
				.statusCode,
		).toBe(403);
	});
});

describe("screenshots in an investigation [mock inference]", () => {
	async function start(extra: Record<string, unknown> = {}) {
		const repo = makeGitRepo(ctx.repoRoot);
		const repository = (
			await session("POST", "/api/v1/repositories", repositoryBody(repo))
		).json().repository;
		const bug = await createReport({ repository_id: repository.id, ...extra });
		const shot = await addEvidence(bug.id);
		const investigation = (
			await session("POST", "/api/v1/investigations", { bug_report_id: bug.id })
		).json().investigation;
		return { bug, shot, investigation };
	}
	const run = (
		deps: WorkerDeps,
		investigationId: string,
		stage: "normalize" | "collect_context",
	) => handleStageJob(deps, { investigationId, stage, attempt: 1 });

	it("gives the screenshot reading to normalization and to collect_context as labelled evidence", async () => {
		const { shot, investigation } = await start();
		const provider = visionProvider();
		const deps = worker(provider);
		await run(deps, investigation.id, "normalize");
		expect(provider.tasks.map((t) => t.task)).toEqual([
			"observe_screenshot",
			"normalize_bug_report",
		]);
		expect(provider.tasks[1]?.images).toEqual([]);
		await run(deps, investigation.id, "collect_context");
		// collect_context reuses the stored reading: no second model call.
		expect(
			provider.tasks.filter((t) => t.task === "observe_screenshot"),
		).toHaveLength(1);

		const rows = await ctx.db
			.select()
			.from(investigationEvidence)
			.where(eq(investigationEvidence.investigationId, investigation.id));
		const observed = rows.find((r) => r.handle === "SHOT-1");
		const guessed = rows.find((r) => r.handle === "INFER-1");
		expect(observed).toMatchObject({
			kind: "model_observation",
			basis: "reported",
			locator: { evidence_asset_id: shot },
			provenance: {
				method: "vision_model",
				mode: "live",
				model: "muse-spark-1.3",
			},
		});
		expect(observed?.label).toMatch(/^Observed in screenshot: cart\.png/);
		expect(observed?.content).toContain('"Total: $NaN" (order summary)');
		expect(observed?.content).toContain("[REDACTED:");
		expect(observed?.content).not.toContain("divide");
		expect(guessed).toMatchObject({
			kind: "model_observation",
			basis: "inferred",
		});
		expect(guessed?.label).toMatch(/^Model inference about screenshot/);
		expect(guessed?.content).toContain(
			"The coupon discount is probably undefined",
		);
		expect(guessed?.content).not.toContain("Total: $NaN");

		const findings = (
			await session(
				"GET",
				`/api/v1/investigations/${investigation.id}/findings`,
			)
		).json();
		expect(
			findings.reported_claims.map((i: { handle: string }) => i.handle),
		).toContain("SHOT-1");
		expect(
			findings.model_observations.map((i: { handle: string }) => i.handle),
		).toEqual(["INFER-1"]);
		expect(
			findings.observed_facts.map((i: { handle: string }) => i.handle),
		).not.toContain("SHOT-1");
	});

	it("tells normalization what the screenshot showed, and that it did not see the image itself", async () => {
		const { investigation } = await start();
		const seen: string[] = [];
		const base = visionProvider();
		const provider: typeof base = {
			...base,
			async complete(request, signal) {
				if (request.schema.name === "normalize_bug_report")
					seen.push(
						String(
							request.messages.filter((m) => m.role === "user").at(-1)?.content,
						),
					);
				return base.complete(request, signal);
			},
		};
		await run(worker(provider), investigation.id, "normalize");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toContain(
			'<untrusted source="SHOT-1" kind="screenshot_observation">',
		);
		expect(seen[0]).toContain(
			'<untrusted source="INFER-1" kind="screenshot_inference">',
		);
		expect(seen[0]).toContain("You do not see any image");
		expect(seen[0]).not.toContain("No screenshots are provided");
	});

	it("records an unreadable screenshot as a limitation and tells normalization it is unseen", async () => {
		const { investigation, shot } = await start();
		const seen: string[] = [];
		const base = visionProvider({
			observe_screenshot: new ProviderError(
				"provider_bad_request",
				"Model provider rejected the request: HTTP 400",
				false,
			),
		});
		const provider: typeof base = {
			...base,
			async complete(request, signal) {
				if (request.schema.name === "normalize_bug_report")
					seen.push(
						String(
							request.messages.filter((m) => m.role === "user").at(-1)?.content,
						),
					);
				return base.complete(request, signal);
			},
		};
		const deps = worker(provider);
		await run(deps, investigation.id, "normalize");
		await run(deps, investigation.id, "collect_context");
		expect(seen[0]).toContain("1 attached screenshot(s) could not be read");
		expect(seen[0]).not.toContain("No screenshots are provided");
		const [step] = await ctx.db
			.select()
			.from(investigationSteps)
			.where(
				and(
					eq(investigationSteps.investigationId, investigation.id),
					eq(investigationSteps.stage, "collect_context"),
				),
			);
		expect(JSON.stringify(step?.summary.limitations)).toContain(
			"could not be read (provider_bad_request)",
		);
		const rows = await ctx.db
			.select()
			.from(investigationEvidence)
			.where(eq(investigationEvidence.investigationId, investigation.id));
		expect(rows.some((r) => r.handle.startsWith("SHOT-"))).toBe(false);
		expect((await derived(shot)).length).toBeGreaterThanOrEqual(1);
	});
});
