import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	SHOP_UI_REPOSITORY,
	setupShopUi,
} from "../../../scripts/shop-ui-setup.ts";
import { workspacesRoot } from "../src/modules/workspace.ts";
import { createDockerExecutor } from "../src/sandbox/docker.ts";
import type { WorkerDeps } from "../src/worker/handlers.ts";
import {
	createShopUiProvider,
	SHOP_UI_REPORT,
	SHOP_UI_STEPS,
} from "./e2e/shop-ui-provider.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	driveInvestigation,
	login,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";
import { quiet } from "./npm-registry.ts";

// One investigation of the Shop UI demo fixture, start to finish [deterministic fixture provider (mock),
// real Docker sandbox, real Chromium]: the app starts in the sandbox, the browser reproduces the visible
// bug, the patch is verified by replaying the same steps against the patched app, and the review page's
// data shows before and after. Set TRACERA_QA_OUT to a directory to keep the screenshots and the API
// responses for inspection.

let ctx: TestContext;
let session: ReturnType<typeof asSession>;
let repositoryPath = "";
const TAG = `shop-ui-e2e-${process.pid}`;
const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

beforeAll(async () => {
	ctx = await createTestContext({ TRACERA_SANDBOX_MODE: "docker" });
	repositoryPath = setupShopUi(path.join(ctx.repoRoot, "shop-ui")).path;
});
afterAll(async () => {
	for (const id of quiet(
		"ps",
		"-a",
		"-q",
		"--filter",
		`label=tracera.instance=${TAG}`,
	)
		.split(/\s+/)
		.filter(Boolean))
		quiet("rm", "-f", id);
	await ctx.close();
});
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
});

const dimensions = (bytes: Buffer) => [
	bytes.readUInt32BE(16),
	bytes.readUInt32BE(20),
];

describe("Shop UI investigation [fixture provider, real Docker sandbox]", () => {
	it("reproduces the visible bug, verifies the one-line patch, and shows before and after", async () => {
		const executor = createDockerExecutor({
			image: ctx.config.sandboxImage,
			browserImage: ctx.config.browserImage,
			workspacesRoot: workspacesRoot(ctx.config),
			workerId: TAG,
			instance: TAG,
		});
		expect(await executor.status()).toMatchObject({ available: true });
		const deps: WorkerDeps = {
			config: ctx.config,
			db: ctx.db,
			pool: ctx.pool,
			boss: ctx.boss,
			provider: createShopUiProvider(),
			executor,
			workerId: TAG,
		};
		const get = async (url: string) => (await session("GET", url)).json();
		const repository = (
			await session("POST", "/api/v1/repositories", {
				name: SHOP_UI_REPOSITORY.name,
				source: { type: "local_path", path: repositoryPath },
				commands: SHOP_UI_REPOSITORY.commands,
				app: SHOP_UI_REPOSITORY.app,
			})
		).json().repository;
		const bug = (
			await session("POST", "/api/v1/bug-reports", {
				...SHOP_UI_REPORT,
				repository_id: repository.id,
			})
		).json().bug_report;
		const created = (
			await session("POST", "/api/v1/investigations", {
				bug_report_id: bug.id,
			})
		).json().investigation;
		await driveInvestigation(ctx, deps, created.id);

		const view = (await get(`/api/v1/investigations/${created.id}`))
			.investigation;
		expect(view).toMatchObject({
			status: "awaiting_approval",
			baseline_reproduction: { status: "reproduced" },
			latest_verification: { outcome: "verified", outcome_reasons: [] },
		});
		const stage = (name: string) =>
			view.steps.find((s: { stage: string }) => s.stage === name);
		expect(stage("plan_reproduction").summary).toMatchObject({
			mode: "browser",
			step_count: SHOP_UI_STEPS.length,
		});
		const verification = (
			await get(`/api/v1/verifications/${view.latest_verification.id}`)
		).verification;
		expect(
			verification.checks.map(
				(c: { kind: string; status: string }) => `${c.kind}:${c.status}`,
			),
		).toEqual(["reproduction:passed", "unit_tests:passed"]);

		// The patch is the one-line change, shown as the reviewer will see it.
		const patch = (await get(`/api/v1/investigations/${created.id}/patches`))
			.items[0];
		expect(patch.files).toEqual([
			expect.objectContaining({
				path: "src/pricing.js",
				additions: 1,
				deletions: 1,
			}),
		]);
		expect((await get(`/api/v1/patches/${patch.id}/diff`)).diff).toContain(
			"+\treturn subtotal >= FREE_SHIPPING_THRESHOLD_CENTS",
		);

		// Runtime evidence: two runs on the original code, two on the patched code.
		const evidence = await get(`/api/v1/patches/${patch.id}/runtime-evidence`);
		expect(evidence).toMatchObject({
			patch_id: patch.id,
			verification: { outcome: "verified" },
			visual_fix: { claimable: true, reason: "post_patch_assertions_passed" },
		});
		expect(evidence.before).toHaveLength(2);
		expect(evidence.after).toHaveLength(2);
		for (const run of [...evidence.before, ...evidence.after])
			expect(run).toMatchObject({
				status: "exited",
				sandbox: { kind: "docker" },
				startup: {
					state: "started",
					reason: null,
					image: ctx.config.sandboxImage,
					browser_image: ctx.config.browserImage,
					start: "npm run start",
					port: 4173,
					health: { ok: true, status: 200 },
					page: { loaded: true },
				},
				screenshot: { mime: "image/png" },
			});
		for (const run of evidence.before) {
			expect(run.reproduction.status).toBe("reproduced");
			expect(run.assertions).toMatchObject({ failed: 1 });
			const failed = run.steps.find(
				(s: { status: string }) => s.status === "failed",
			);
			expect(failed).toMatchObject({
				label: 'Expect test id "shipping" to equal "Shipping: Free"',
				expected: "Shipping: Free",
				actual: "Shipping: $4.99",
			});
		}
		for (const run of evidence.after) {
			expect(run.reproduction.status).toBe("not_reproduced");
			expect(run.assertions).toMatchObject({ failed: 0, skipped: 0 });
			expect(
				run.steps.every((s: { status: string }) => s.status === "passed"),
			).toBe(true);
		}

		// The screenshots are real PNGs served by the API, and the page changed between them.
		const fetchImage = async (url: string) => {
			const response = await session("GET", url);
			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toBe("image/png");
			expect(response.headers["x-content-type-options"]).toBe("nosniff");
			return response.rawPayload;
		};
		const before = await fetchImage(evidence.before[0].screenshot.url);
		const after = await fetchImage(evidence.after[0].screenshot.url);
		for (const image of [before, after]) {
			expect(image.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
			expect(dimensions(image)).toEqual([1280, 800]);
		}
		expect(before.equals(after)).toBe(false);

		const report = (
			await session(
				"GET",
				`/api/v1/investigations/${created.id}/report?format=markdown`,
			)
		).body;
		expect(report).toContain(
			`browser steps (${SHOP_UI_STEPS.length}) against npm run start`,
		);

		const out = process.env.TRACERA_QA_OUT;
		if (out) {
			mkdirSync(out, { recursive: true });
			writeFileSync(path.join(out, "before.png"), before);
			writeFileSync(path.join(out, "after.png"), after);
			const urls = [
				"/api/v1/auth/me",
				`/api/v1/investigations/${created.id}`,
				`/api/v1/bug-reports/${bug.id}`,
				`/api/v1/investigations/${created.id}/findings`,
				`/api/v1/investigations/${created.id}/reproductions`,
				`/api/v1/investigations/${created.id}/patches`,
				`/api/v1/patches/${patch.id}`,
				`/api/v1/patches/${patch.id}/diff`,
				`/api/v1/verifications/${view.latest_verification.id}`,
				`/api/v1/patches/${patch.id}/runtime-evidence`,
			];
			const recorded: Record<string, unknown> = {};
			for (const url of urls) recorded[url] = await get(url);
			writeFileSync(
				path.join(out, "responses.json"),
				JSON.stringify(
					{
						responses: recorded,
						images: {
							[evidence.before[0].screenshot.url]: "before.png",
							[evidence.after[0].screenshot.url]: "after.png",
						},
					},
					null,
					1,
				),
			);
		}
	}, 420_000);
});
