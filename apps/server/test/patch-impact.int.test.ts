import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PatchImpactResultSchema } from "@tracera/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	recoverLostPatchAnalyses,
	runPatchImpactJob,
} from "../src/modules/patch-analysis.ts";
import { QUEUES } from "../src/queue.ts";
import { DEPS, SHOP } from "./fullstack-fixture.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	login,
	makeGitRepo,
	repositoryBody,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

// Patch impact through the API [static analysis, real git, no execution]: commit ranges, pull-request
// style merge bases, supplied diffs, caching, cancellation, failures, and workspace isolation.

let ctx: TestContext;
let session: ReturnType<typeof asSession>;

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
});

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
const commit = (dir: string, message: string) => {
	git(dir, "add", "-A");
	git(
		dir,
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"-m",
		message,
	);
	return git(dir, "rev-parse", "HEAD").trim();
};
const write = (dir: string, files: Record<string, string>) => {
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), content);
	}
};
/** OrderService.create gains a parameter: a contract change its callers must follow. */
const requireActor = (dir: string) =>
	write(dir, {
		"server/services/orders.ts": (
			SHOP["server/services/orders.ts"] ?? ""
		).replace(
			"\tcreate(body: unknown) {",
			"\tcreate(body: unknown, actor: string) {",
		),
	});

let repos = 0;
/** The full-stack shop in a fresh git repository, registered, with its first commit. */
async function registerShop() {
	repos += 1;
	const name = `impact-${repos}`;
	const dir = makeGitRepo(ctx.repoRoot, name);
	write(dir, {
		...SHOP,
		"package.json": JSON.stringify({
			name: "shop",
			type: "module",
			dependencies: DEPS,
		}),
	});
	const base = commit(dir, "add sources");
	const response = await session(
		"POST",
		"/api/v1/repositories",
		repositoryBody(dir, name),
	);
	expect(response.statusCode).toBe(201);
	return { dir, id: response.json().repository.id as string, base };
}

/** Runs queued patch-impact jobs in-process, as the worker would. */
async function drain(): Promise<number> {
	let handled = 0;
	for (;;) {
		const { rows } = await ctx.pool.query<{
			id: string;
			data: { analysisId: string };
		}>(
			"SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' ORDER BY created_on LIMIT 1",
			[QUEUES.patchImpact],
		);
		const job = rows[0];
		if (!job) return handled;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [job.id]);
		await runPatchImpactJob(
			{ db: ctx.db, config: ctx.config },
			job.data.analysisId,
		);
		handled += 1;
	}
}

async function analyse(repositoryId: string, body: Record<string, unknown>) {
	const created = await session(
		"POST",
		`/api/v1/repositories/${repositoryId}/patch-impact`,
		body,
	);
	expect(created.statusCode).toBe(202);
	const id = created.json().analysis.id as string;
	expect(await drain()).toBe(1);
	const response = await session("GET", `/api/v1/patch-impact/${id}`);
	expect(response.statusCode).toBe(200);
	return { id, analysis: response.json().analysis };
}

describe("patch impact analysis [static analysis, real git, no execution]", () => {
	it("analyses a commit range: changed symbols, evidence chains, tests, a report, and a cached repeat", async () => {
		const repo = await registerShop();
		requireActor(repo.dir);
		const head = commit(repo.dir, "require an actor");
		const { id, analysis } = await analyse(repo.id, { base: repo.base, head });
		const result = PatchImpactResultSchema.parse(analysis.result);
		expect(analysis.status).toBe(result.complete ? "completed" : "partial");
		expect(result.head).toMatchObject({ sha: head, kind: "commit" });
		expect(result.symbols).toEqual([
			expect.objectContaining({
				name: "OrderService.create",
				change: "signature_changed",
				signature: {
					before: "create(body: unknown)",
					after: "create(body: unknown, actor: string)",
				},
				tests: "none_identified",
			}),
		]);
		const byTarget = Object.fromEntries(
			result.findings.map((f) => [f.target.key, f]),
		);
		expect(
			byTarget["sym:server/controllers/orders.js#createOrder"],
		).toMatchObject({
			depth: 1,
			severity: "high",
			confidence: "high",
			chain: [{ kind: "CALLS", path: "server/controllers/orders.js" }],
		});
		expect(
			byTarget["route:POST /api/orders"]?.chain.map((l) => l.kind),
		).toEqual(["CALLS", "ROUTES_TO"]);
		expect(
			byTarget["sym:web/src/api.ts#ordersApi.create"]?.chain.map((l) => l.kind),
		).toEqual(["CALLS", "ROUTES_TO", "SENDS_REQUEST_TO"]);
		// Whatever is reached only through a guessed link (the emitter's event) is never high confidence.
		for (const finding of result.findings)
			if (finding.certainty === "heuristic")
				expect(finding.confidence).toBe("low");
		expect(result.review_actions.map((a) => a.action)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(
					/^Add or point to a test for OrderService\.create/,
				),
			]),
		);

		const report = await session("GET", `/api/v1/patch-impact/${id}/report`);
		expect(report.statusCode).toBe(200);
		expect(report.headers["content-type"]).toMatch(/text\/markdown/);
		expect(report.body).toContain("OrderService.create");

		const again = await session(
			"POST",
			`/api/v1/repositories/${repo.id}/patch-impact`,
			{
				base: repo.base,
				head,
			},
		);
		expect(again.statusCode).toBe(200);
		expect(again.json().analysis.id).toBe(id);
		const listed = await session(
			"GET",
			`/api/v1/repositories/${repo.id}/patch-impact`,
		);
		expect(listed.json().analyses).toEqual([
			expect.objectContaining({ id, result: null }),
		]);
	});

	it("applies a supplied diff to the base revision without touching the registered repository", async () => {
		const repo = await registerShop();
		requireActor(repo.dir);
		const diff = git(repo.dir, "diff");
		git(repo.dir, "checkout", "--", ".");
		const { analysis } = await analyse(repo.id, { base: repo.base, diff });
		expect(analysis.head).toMatchObject({
			sha: null,
			diff_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		const result = PatchImpactResultSchema.parse(analysis.result);
		expect(result.head.kind).toBe("tree");
		expect(result.symbols.map((s) => [s.name, s.change])).toEqual([
			["OrderService.create", "signature_changed"],
		]);
		// The registered repository was only read.
		expect(git(repo.dir, "status", "--porcelain")).toBe("");
	});

	it("compares a branch with its merge base, like a pull request", async () => {
		const repo = await registerShop();
		git(repo.dir, "checkout", "-q", "-b", "feature");
		requireActor(repo.dir);
		commit(repo.dir, "feature change");
		git(repo.dir, "checkout", "-q", "main");
		write(repo.dir, {
			"server/unrelated.js": `${SHOP["server/unrelated.js"]}\nexport const later = 1;`,
		});
		commit(repo.dir, "main moves on");
		const pr = PatchImpactResultSchema.parse(
			(
				await analyse(repo.id, {
					base: "main",
					head: "feature",
					merge_base: true,
				})
			).analysis.result,
		);
		expect(pr).toMatchObject({ merge_base: true, base: { sha: repo.base } });
		expect(pr.files.map((f) => f.path)).toEqual(["server/services/orders.ts"]);
		// Without the merge base, main's later commit shows up as part of the difference.
		const direct = PatchImpactResultSchema.parse(
			(await analyse(repo.id, { base: "main", head: "feature" })).analysis
				.result,
		);
		expect(direct.files.map((f) => f.path).sort()).toEqual([
			"server/services/orders.ts",
			"server/unrelated.js",
		]);
	});

	it("validates requests, cancels, re-queues, and keeps analyses inside the workspace", async () => {
		const repo = await registerShop();
		const url = `/api/v1/repositories/${repo.id}/patch-impact`;
		expect(
			(
				await session("POST", url, {
					base: repo.base,
					head: repo.base,
					diff: "x",
				})
			).statusCode,
		).toBe(400);
		expect(
			(await session("POST", url, { base: "--upload-pack=x", head: repo.base }))
				.statusCode,
		).toBe(400);
		const unknown = await session("POST", url, {
			base: repo.base,
			head: "no-such-branch",
		});
		expect(unknown.statusCode).toBe(422);
		expect(unknown.json().code).toBe("commit_not_found");
		const unsafe = await session("POST", url, {
			base: repo.base,
			diff: "diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n",
		});
		expect(unsafe.statusCode).toBe(422);
		expect(unsafe.json().code).toBe("diff_invalid");

		const queued = await session("POST", url, {
			base: repo.base,
			head: repo.base,
			depth: 2,
		});
		expect(queued.statusCode).toBe(202);
		const id = queued.json().analysis.id as string;
		const cancelled = await session(
			"POST",
			`/api/v1/patch-impact/${id}/cancel`,
		);
		expect(cancelled.statusCode).toBe(202);
		expect(cancelled.json().analysis).toMatchObject({
			status: "cancelled",
			error: { code: "cancelled" },
		});
		expect(await drain()).toBe(1); // the job sees the cancellation and does nothing
		expect(
			(await session("GET", `/api/v1/patch-impact/${id}`)).json().analysis
				.status,
		).toBe("cancelled");
		expect(
			(await session("POST", `/api/v1/patch-impact/${id}/cancel`)).statusCode,
		).toBe(409);
		expect(
			(await session("GET", `/api/v1/patch-impact/${id}/report`)).statusCode,
		).toBe(409);
		const requeued = await session("POST", url, {
			base: repo.base,
			head: repo.base,
			depth: 2,
		});
		expect(requeued.statusCode).toBe(202);
		expect(requeued.json().analysis.id).toBe(id);
		expect(await drain()).toBe(1);
		const empty = (await session("GET", `/api/v1/patch-impact/${id}`)).json()
			.analysis;
		expect(empty).toMatchObject({
			status: "completed",
			result: { summary: { files: 0 } },
		});
		expect(empty.result.limitations[0]).toMatch(/identical trees/);

		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		for (const [method, target] of [
			["POST", url],
			["GET", url],
			["GET", `/api/v1/patch-impact/${id}`],
			["GET", `/api/v1/patch-impact/${id}/report`],
			["POST", `/api/v1/patch-impact/${id}/cancel`],
		] as const)
			expect(
				(
					await other(
						method,
						target,
						method === "POST"
							? { base: repo.base, head: repo.base }
							: undefined,
					)
				).statusCode,
				`${method} ${target}`,
			).toBe(404);
	});

	it("fails honestly when a supplied diff does not apply, and recovers lost jobs", async () => {
		const repo = await registerShop();
		const { analysis } = await analyse(repo.id, {
			base: repo.base,
			diff: "diff --git a/server/app.js b/server/app.js\n--- a/server/app.js\n+++ b/server/app.js\n@@ -1 +1 @@\n-this line does not exist\n+replacement\n",
		});
		expect(analysis).toMatchObject({
			status: "failed",
			error: { code: "diff_does_not_apply" },
			result: null,
		});

		const lost = await session(
			"POST",
			`/api/v1/repositories/${repo.id}/patch-impact`,
			{
				base: repo.base,
				head: repo.base,
			},
		);
		const id = lost.json().analysis.id as string;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
			QUEUES.patchImpact,
		]);
		await ctx.pool.query(
			"UPDATE patch_analyses SET updated_at = now() - interval '5 minutes' WHERE id = $1",
			[id],
		);
		expect(await recoverLostPatchAnalyses(ctx.db)).toBe(1);
		expect(
			(await session("GET", `/api/v1/patch-impact/${id}`)).json().analysis,
		).toMatchObject({
			status: "failed",
			error: { code: "job_lost", retryable: true },
		});
	});
});
