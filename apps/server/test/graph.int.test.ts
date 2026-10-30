import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupBenchShop } from "../../../scripts/bench-setup.ts";
import { type ChatRequest, ProviderError } from "../src/inference/providers.ts";
import {
	recoverLostAssessments,
	runAssessJob,
} from "../src/modules/assessment.ts";
import { recoverLostIndexJobs, runIndexJob } from "../src/modules/graph.ts";
import { mirrorPath } from "../src/modules/workspace.ts";
import { QUEUES } from "../src/queue.ts";
import { DEPS, SHOP } from "./fullstack-fixture.ts";
import {
	addMember,
	asSession,
	createOwner,
	createTestContext,
	login,
	makeGitRepo,
	repositoryBody,
	resetDatabase,
	scriptedProvider,
	type TestContext,
} from "./helpers.ts";

let ctx: TestContext;
let session: ReturnType<typeof asSession>;

beforeAll(async () => {
	ctx = await createTestContext();
	setupBenchShop(ctx.config.dataDir);
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
});

/** Runs queued `repository.index` jobs in-process, as the worker would. */
async function drainIndexJobs(): Promise<number> {
	let handled = 0;
	for (;;) {
		const { rows } = await ctx.pool.query<{
			id: string;
			data: { snapshotId: string };
		}>(
			"SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' ORDER BY created_on LIMIT 1",
			[QUEUES.index],
		);
		const job = rows[0];
		if (!job) return handled;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [job.id]);
		await runIndexJob({ db: ctx.db, config: ctx.config }, job.data.snapshotId);
		handled += 1;
	}
}

async function registerBenchShop() {
	const response = await session("POST", "/api/v1/repositories", {
		name: "bench-shop",
		source: { type: "fixture", fixture: "bench-shop" },
		commands: { install: "npm ci --ignore-scripts", test: "npm test" },
	});
	expect(response.statusCode).toBe(201);
	return response.json() as {
		repository: { id: string };
		snapshot: { id: string; status: string } | null;
	};
}

function commitAll(dir: string, message: string) {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("add", "-A");
	git(
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"-m",
		message,
	);
}

async function registerLocal(name: string, files: Record<string, string>) {
	const dir = makeGitRepo(ctx.repoRoot, name);
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), content);
	}
	commitAll(dir, "add sources");
	const response = await session(
		"POST",
		"/api/v1/repositories",
		repositoryBody(dir, name),
	);
	expect(response.statusCode).toBe(201);
	return {
		dir,
		id: (response.json() as { repository: { id: string } }).repository.id,
	};
}

type NodeView = { id: string; name: string; kind: string; path: string };
async function nodeNamed(repoId: string, q: string, kind?: string) {
	const response = await session(
		"GET",
		`/api/v1/repositories/${repoId}/graph/nodes?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}`,
	);
	expect(response.statusCode).toBe(200);
	const node = (response.json() as { nodes: NodeView[] }).nodes.find(
		(n) => n.name === q,
	);
	if (!node) throw new Error(`no node named ${q}`);
	return node;
}

const edgeList = (
	edges: Array<{ kind: string; from_key: string; to_key: string | null }>,
	end: "from_key" | "to_key",
) => edges.map((edge) => `${edge.kind} ${edge[end]}`);

describe("repository knowledge graph [static analysis, no execution]", () => {
	it("queues indexing on registration and builds a ready snapshot with a profile", async () => {
		const { repository, snapshot } = await registerBenchShop();
		expect(snapshot).toMatchObject({ status: "queued" });
		expect(await drainIndexJobs()).toBe(1);

		const profile = await session(
			"GET",
			`/api/v1/repositories/${repository.id}/profile`,
		);
		expect(profile.statusCode).toBe(200);
		const body = profile.json();
		expect(body.snapshot).toMatchObject({
			status: "ready",
			coverage_complete: true,
		});
		expect(body.profile).toMatchObject({
			tracked_files: 8,
			indexed_files: 8,
			files_by_language: { javascript: 6, json: 1, markdown: 1 },
			test_files: 3,
			test_cases: 13,
			test_commands: ["package.json: npm run test (node --test)"],
		});
		expect(body.freshness).toMatchObject({ stale: false, reasons: [] });
		expect(body.coverage).toMatchObject({
			extractor_version: "graph-extract.v4",
			consistency: { dangling_edges: 0 },
			unsupported_edge_kinds: [],
		});
		expect(body.coverage.extracted_edge_kinds).toContain("ROUTES_TO");
		expect(body.coverage.edge_support.SENDS_REQUEST_TO).toMatch(/fetch/);

		const again = await session(
			"POST",
			`/api/v1/repositories/${repository.id}/index`,
			{},
		);
		expect(again.statusCode).toBe(200);
		expect(again.json().snapshot.id).toBe(snapshot?.id);
	});

	it("indexes a ready snapshot again when its mirror is gone, which brings search back", async () => {
		const { repository, snapshot } = await registerBenchShop();
		expect(await drainIndexJobs()).toBe(1);
		const search = () =>
			session("GET", `/api/v1/repositories/${repository.id}/search?q=shipping`);
		expect((await search()).statusCode).toBe(200);

		// What a host with a temporary data directory looks like after a restart.
		await rm(mirrorPath(ctx.config, snapshot?.id ?? ""), {
			recursive: true,
			force: true,
		});
		const lost = await search();
		expect(lost.statusCode).toBe(409);
		expect(lost.json().code).toBe("snapshot_source_unavailable");

		const again = await session(
			"POST",
			`/api/v1/repositories/${repository.id}/index`,
			{},
		);
		expect(again.statusCode).toBe(202);
		expect(again.json().snapshot).toMatchObject({
			id: snapshot?.id,
			status: "queued",
		});
		expect(await drainIndexJobs()).toBe(1);
		expect(existsSync(mirrorPath(ctx.config, snapshot?.id ?? ""))).toBe(true);
		expect((await search()).statusCode).toBe(200);

		// With the mirror back, asking again changes nothing.
		const settled = await session(
			"POST",
			`/api/v1/repositories/${repository.id}/index`,
			{},
		);
		expect(settled.statusCode).toBe(200);
	});

	it("returns nodes with source evidence, neighbours, and graph-supported impact", async () => {
		const { repository } = await registerBenchShop();
		await drainIndexJobs();
		const shipping = await nodeNamed(
			repository.id,
			"shippingCents",
			"function",
		);
		expect(shipping.path).toBe("src/pricing.js");

		const detail = await session("GET", `/api/v1/graph/nodes/${shipping.id}`);
		expect(detail.statusCode).toBe(200);
		const node = detail.json();
		expect(node.evidence).toMatchObject({
			type: "graph_node",
			classification: "observed",
			path: "src/pricing.js",
			symbol: "shippingCents",
			method: "babel_parse",
		});
		expect(node.evidence.excerpt).toContain(
			"export function shippingCents(subtotal)",
		);
		const incoming = edgeList(node.incoming, "from_key");
		expect(incoming).toContain("CALLS sym:src/pricing.js#orderTotal");
		expect(
			incoming.some((edge) =>
				edge.startsWith("TESTS test:test/pricing.test.js#"),
			),
		).toBe(true);

		const impact = await session(
			"GET",
			`/api/v1/graph/nodes/${shipping.id}/impact`,
		);
		expect(impact.statusCode).toBe(200);
		const result = impact.json();
		expect(result.files).toEqual(
			expect.arrayContaining(["src/pricing.js", "test/pricing.test.js"]),
		);
		expect(result.tests.length).toBeGreaterThan(0);
		expect(result.limitations[0]).toMatch(/Graph-supported impact only/);

		const neighbors = await session(
			"GET",
			`/api/v1/graph/nodes/${shipping.id}/neighbors?depth=3&limit=5`,
		);
		expect(neighbors.statusCode).toBe(200);
		expect(neighbors.json().edges.length).toBeLessThanOrEqual(5);
		expect(neighbors.json().truncated).toBe(true);

		const tooDeep = await session(
			"GET",
			`/api/v1/graph/nodes/${shipping.id}/neighbors?depth=9`,
		);
		expect(tooDeep.statusCode).toBe(400);
	});

	it("searches text and symbols with evidence references", async () => {
		const { repository } = await registerBenchShop();
		await drainIndexJobs();
		const text = await session(
			"GET",
			`/api/v1/repositories/${repository.id}/search?q=FREE_SHIPPING`,
		);
		expect(text.statusCode).toBe(200);
		expect(text.json().hits[0]).toMatchObject({
			type: "search_hit",
			path: "src/pricing.js",
			method: "git_grep_fixed_string",
		});
		const symbols = await session(
			"GET",
			`/api/v1/repositories/${repository.id}/search?q=orderTotal&mode=symbol`,
		);
		expect(symbols.json().hits).toContainEqual(
			expect.objectContaining({
				symbol: "orderTotal",
				path: "src/pricing.js",
				start_line: 24,
			}),
		);
	});

	it("re-indexes only changed files, drops stale edges, and reports a moved ref as stale", async () => {
		const repo = await registerLocal("incremental", {
			"src/a.js":
				'import { g } from "./b.js";\nexport function f() { return g(); }\n',
			"src/b.js": "export function g() { return 1; }\n",
			"src/c.js": "export const c = 3;\n",
		});
		await drainIndexJobs();
		const f = await nodeNamed(repo.id, "f");
		const before = (await session("GET", `/api/v1/graph/nodes/${f.id}`)).json();
		expect(edgeList(before.outgoing, "to_key")).toContain(
			"CALLS sym:src/b.js#g",
		);

		writeFileSync(
			path.join(repo.dir, "src/a.js"),
			"export function f() { return 2; }\n",
		);
		commitAll(repo.dir, "drop the call");
		const stale = (
			await session("GET", `/api/v1/repositories/${repo.id}/profile`)
		).json();
		expect(stale.freshness).toMatchObject({
			stale: true,
			reasons: ["ref_moved"],
		});

		const queued = await session(
			"POST",
			`/api/v1/repositories/${repo.id}/index`,
			{},
		);
		expect(queued.statusCode).toBe(202);
		await drainIndexJobs();
		const fresh = (
			await session("GET", `/api/v1/repositories/${repo.id}/profile`)
		).json();
		expect(fresh.freshness.stale).toBe(false);
		expect(fresh.snapshot.stats).toMatchObject({
			files_parsed: 1,
			files_reused: 2,
		});
		expect(fresh.snapshot.previous_snapshot_id).toBe(stale.snapshot.id);
		const fAfter = await nodeNamed(repo.id, "f");
		const after = (
			await session("GET", `/api/v1/graph/nodes/${fAfter.id}`)
		).json();
		expect(edgeList(after.outgoing, "to_key")).not.toContain(
			"CALLS sym:src/b.js#g",
		);
	});

	it("marks parse failures as partial coverage and never runs repository code", async () => {
		const marker = path.join(ctx.repoRoot, "executed.txt");
		const repo = await registerLocal("partial", {
			"src/ok.js": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nexport const ok = 1;\n`,
			"src/broken.js": "export function (\n",
			"package.json": JSON.stringify({
				name: "partial",
				scripts: { postinstall: "node src/ok.js" },
			}),
		});
		await drainIndexJobs();
		const body = (
			await session("GET", `/api/v1/repositories/${repo.id}/profile`)
		).json();
		expect(body.snapshot.status).toBe("partial");
		expect(body.coverage.complete).toBe(false);
		expect(body.coverage.parse_failures).toEqual([
			expect.objectContaining({ path: "src/broken.js" }),
		]);
		expect(existsSync(marker)).toBe(false);
		// Impact on a partial snapshot says it may be incomplete instead of claiming to be exhaustive.
		const ok = await nodeNamed(repo.id, "ok");
		const impact = (
			await session("GET", `/api/v1/graph/nodes/${ok.id}/impact`)
		).json();
		expect(impact.limitations.join(" ")).toMatch(
			/coverage is partial.*dependents may be missing/,
		);
	});

	it("fails the snapshot honestly when the registered path disappears", async () => {
		const repo = await registerLocal("vanishing", {
			"src/a.js": "export const a = 1;\n",
		});
		renameSync(repo.dir, `${repo.dir}-moved`);
		await drainIndexJobs();
		const list = (
			await session("GET", `/api/v1/repositories/${repo.id}/snapshots`)
		).json();
		expect(list.snapshots[0]).toMatchObject({
			status: "failed",
			error: { code: "repository_unavailable" },
		});
		const profile = await session(
			"GET",
			`/api/v1/repositories/${repo.id}/profile`,
		);
		expect(profile.statusCode).toBe(409);
		expect(profile.json().code).toBe("graph_not_indexed");
	});

	it("keeps graph reads inside the caller's workspace", async () => {
		const { repository } = await registerBenchShop();
		await drainIndexJobs();
		const shipping = await nodeNamed(
			repository.id,
			"shippingCents",
			"function",
		);
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		for (const url of [
			`/api/v1/graph/nodes/${shipping.id}`,
			`/api/v1/graph/nodes/${shipping.id}/neighbors`,
			`/api/v1/graph/nodes/${shipping.id}/impact`,
			`/api/v1/repositories/${repository.id}/profile`,
			`/api/v1/repositories/${repository.id}/graph/nodes?q=ship`,
			`/api/v1/repositories/${repository.id}/search?q=ship`,
		])
			expect((await other("GET", url)).statusCode, url).toBe(404);
	});

	it("recovers a snapshot and an assessment whose queue jobs were lost, so they can run again", async () => {
		const { repository, snapshot } = await registerBenchShop();
		const id = snapshot?.id ?? "";
		// The worker died and the queue gave up: no live job, and the row has not moved for minutes.
		await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
			QUEUES.index,
		]);
		await ctx.pool.query(
			"UPDATE repository_snapshots SET status = 'indexing', updated_at = now() - interval '5 minutes' WHERE id = $1",
			[id],
		);
		expect(await recoverLostIndexJobs(ctx.db)).toBe(1);
		expect(await recoverLostIndexJobs(ctx.db)).toBe(0);
		const failed = (
			await session("GET", `/api/v1/repositories/${repository.id}/snapshots`)
		).json().snapshots[0];
		expect(failed).toMatchObject({
			id,
			status: "failed",
			error: { code: "job_lost", retryable: true },
		});
		const retried = await session(
			"POST",
			`/api/v1/repositories/${repository.id}/index`,
			{},
		);
		expect(retried.statusCode).toBe(202);
		expect(retried.json().snapshot).toMatchObject({ id, status: "queued" });
		expect(await drainIndexJobs()).toBe(1);

		const created = await session(
			"POST",
			`/api/v1/repositories/${repository.id}/assessments`,
			{ request: "Raise the free shipping threshold from $50 to $75" },
		);
		const assessmentId = created.json().assessment.id as string;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
			QUEUES.assess,
		]);
		await ctx.pool.query(
			"UPDATE assessments SET updated_at = now() - interval '5 minutes' WHERE id = $1",
			[assessmentId],
		);
		expect(await recoverLostAssessments(ctx.db)).toBe(1);
		const lost = (
			await session("GET", `/api/v1/assessments/${assessmentId}`)
		).json().assessment;
		expect(lost).toMatchObject({
			status: "failed",
			error: { code: "job_lost" },
		});
	});

	it("cancels a queued index request, keeps it cancelled when its job runs, and indexes again on request", async () => {
		const { repository, snapshot } = await registerBenchShop();
		const id = snapshot?.id ?? "";
		const cancelled = await session(
			"POST",
			`/api/v1/snapshots/${id}/cancel`,
			{},
		);
		expect(cancelled.statusCode).toBe(202);
		expect(cancelled.json().snapshot).toMatchObject({
			status: "cancelled",
			error: { code: "cancelled", retryable: true },
		});
		expect(await drainIndexJobs()).toBe(1); // the job runs and leaves it alone
		expect(
			(
				await session("GET", `/api/v1/repositories/${repository.id}/snapshots`)
			).json().snapshots[0],
		).toMatchObject({ id, status: "cancelled" });
		expect(
			(await session("POST", `/api/v1/snapshots/${id}/cancel`, {})).statusCode,
		).toBe(409);
		const again = await session(
			"POST",
			`/api/v1/repositories/${repository.id}/index`,
			{},
		);
		expect(again.statusCode).toBe(202);
		expect(again.json().snapshot).toMatchObject({ id, status: "queued" });
		expect(await drainIndexJobs()).toBe(1);
		const listed = (await session("GET", "/api/v1/repositories")).json().items;
		expect(listed[0].index).toMatchObject({
			snapshot_id: id,
			status: "ready",
			coverage_complete: true,
			progress: null,
		});
	});

	it("stops a running index job at its next check and records the run as cancelled, not failed", async () => {
		const { repository, snapshot } = await registerBenchShop();
		const id = snapshot?.id ?? "";
		// A worker has picked the job up.
		await ctx.pool.query(
			"UPDATE repository_snapshots SET status = 'indexing' WHERE id = $1",
			[id],
		);
		const response = await session(
			"POST",
			`/api/v1/snapshots/${id}/cancel`,
			{},
		);
		expect(response.statusCode).toBe(202);
		expect(response.json().snapshot).toMatchObject({
			status: "indexing",
			cancel_requested_at: expect.any(String),
		});
		expect(await drainIndexJobs()).toBe(1);
		expect(
			(
				await session("GET", `/api/v1/repositories/${repository.id}/snapshots`)
			).json().snapshots[0],
		).toMatchObject({
			status: "cancelled",
			error: { code: "cancelled" },
			progress: null,
		});
		expect(existsSync(mirrorPath(ctx.config, id))).toBe(false);
		const audits = await ctx.pool.query(
			"SELECT action FROM audit_events WHERE target_id = $1",
			[id],
		);
		expect(audits.rows.map((row) => row.action)).toEqual(
			expect.arrayContaining([
				"repository.index_cancel_requested",
				"repository.index_cancelled",
			]),
		);
	});

	it("updates a registration and deletes a repository with everything derived from it (owner only)", async () => {
		const repo = await registerLocal("lifecycle", {
			"src/a.js": "export const a = 1;\n",
		});
		await drainIndexJobs();
		const bad = await session("PATCH", `/api/v1/repositories/${repo.id}`, {
			default_branch: "nope",
		});
		expect(bad.statusCode).toBe(422);
		expect(bad.json().code).toBe("commit_not_found");
		const renamed = await session("PATCH", `/api/v1/repositories/${repo.id}`, {
			name: "lifecycle-2",
			commands: { install: "npm ci --ignore-scripts", test: "node --test" },
		});
		expect(renamed.statusCode).toBe(200);
		expect(renamed.json().repository).toMatchObject({
			name: "lifecycle-2",
			commands: { test: "node --test" },
			index: { status: "ready" },
		});
		const me = (await session("GET", "/api/v1/auth/me")).json();
		await addMember(ctx.db, me.workspace.id, "member@example.com");
		const member = asSession(ctx, await login(ctx, "member@example.com"));
		expect(
			(await member("PATCH", `/api/v1/repositories/${repo.id}`, { name: "x" }))
				.statusCode,
		).toBe(403);
		expect(
			(
				await member(
					"DELETE",
					`/api/v1/repositories/${repo.id}?confirm=lifecycle-2`,
				)
			).statusCode,
		).toBe(403);
		const [snapshot] = (
			await session("GET", `/api/v1/repositories/${repo.id}/snapshots`)
		).json().snapshots;
		const wrong = await session(
			"DELETE",
			`/api/v1/repositories/${repo.id}?confirm=lifecycle`,
		);
		expect(wrong.statusCode).toBe(422);
		expect(wrong.json().code).toBe("confirmation_mismatch");
		const deleted = await session(
			"DELETE",
			`/api/v1/repositories/${repo.id}?confirm=lifecycle-2`,
		);
		expect(deleted.statusCode).toBe(200);
		expect(deleted.json().deleted).toMatchObject({
			snapshots: 1,
			investigations: 0,
		});
		expect(
			(await session("GET", `/api/v1/repositories/${repo.id}`)).statusCode,
		).toBe(404);
		expect(existsSync(mirrorPath(ctx.config, snapshot.id))).toBe(false);
		const nodes = await ctx.pool.query(
			"SELECT count(*)::int AS n FROM graph_nodes WHERE snapshot_id = $1",
			[snapshot.id],
		);
		expect(nodes.rows[0].n).toBe(0);
		// The registered working tree is never touched.
		expect(existsSync(path.join(repo.dir, "src", "a.js"))).toBe(true);
	});

	it("refuses to delete a repository while an investigation on it is active", async () => {
		const { repository } = await registerBenchShop();
		const bug = (
			await session("POST", "/api/v1/bug-reports", {
				title: "Totals are wrong",
				description: "The cart total is off by one cent.",
				repository_id: repository.id,
			})
		).json().bug_report;
		expect(
			(
				await session("POST", "/api/v1/investigations", {
					bug_report_id: bug.id,
				})
			).statusCode,
		).toBe(202);
		const refused = await session(
			"DELETE",
			`/api/v1/repositories/${repository.id}?confirm=bench-shop`,
		);
		expect(refused.statusCode).toBe(409);
		expect(refused.json().code).toBe("repository_in_use");
	});

	it("rate-limits expensive requests per workspace with a retry hint", async () => {
		const { repository } = await registerBenchShop();
		const statuses: number[] = [];
		for (let i = 0; i < 21; i++)
			statuses.push(
				(
					await session(
						"POST",
						`/api/v1/repositories/${repository.id}/index`,
						{},
					)
				).statusCode,
			);
		expect(statuses.slice(0, 20).every((status) => status < 400)).toBe(true);
		const limited = await session(
			"POST",
			`/api/v1/repositories/${repository.id}/index`,
			{},
		);
		expect(limited.statusCode).toBe(429);
		expect(limited.json().code).toBe("rate_limited");
		expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
	});
});

// ---- Tracing, impact, evidence, history, and search over a full-stack repository --------------

describe("engineering intelligence over an indexed full-stack repository [static analysis]", () => {
	let shops = 0;
	async function registerShop(extra: Record<string, string> = {}) {
		shops += 1; // a fresh git repository per test (the directory outlives the database reset)
		const repo = await registerLocal(`shop-${shops}`, {
			...SHOP,
			...extra,
			"package.json": JSON.stringify({
				name: "shop",
				type: "module",
				scripts: { test: "node --test" },
				dependencies: DEPS,
			}),
		});
		expect(await drainIndexJobs()).toBe(1);
		return repo;
	}
	async function nodeByKey(repoId: string, key: string) {
		const response = await session(
			"GET",
			`/api/v1/repositories/${repoId}/graph/nodes?key=${encodeURIComponent(key)}`,
		);
		expect(response.statusCode).toBe(200);
		const [node] = response.json().nodes as NodeView[];
		if (!node) throw new Error(`no node ${key}`);
		return node;
	}

	it("traces a page down to the table it writes and the subscribers of the event it emits, and back up", async () => {
		const repo = await registerShop();
		const page = await nodeByKey(repo.id, "page:/orders/:param");
		const down = await session("GET", `/api/v1/graph/nodes/${page.id}/trace`);
		expect(down.statusCode).toBe(200);
		const keys = (
			down.json().nodes as Array<{ key: string; distance: number }>
		).map((n) => n.key);
		expect(keys).toEqual(
			expect.arrayContaining([
				"sym:web/src/OrderPage.tsx#OrderPage",
				"sym:web/src/OrderPage.tsx#OrderPage.save",
				"sym:web/src/api.ts#ordersApi.create",
				"route:POST /api/orders",
				"sym:server/controllers/orders.js#createOrder",
				"sym:server/services/orders.ts#OrderService.create",
				"table:orders",
				"event:order:created",
				"sym:server/events.ts#sendReceipt",
			]),
		);
		// Calls on untyped values (res.json) are reported as gaps, not bridged.
		expect(
			(down.json().gaps as Array<{ reason: string }>).some((gap) =>
				gap.reason.includes("could not be resolved"),
			),
		).toBe(true);
		const table = await nodeByKey(repo.id, "table:orders");
		const up = await session(
			"GET",
			`/api/v1/graph/nodes/${table.id}/trace?direction=upstream`,
		);
		expect(up.statusCode).toBe(200);
		expect(
			(up.json().nodes as Array<{ key: string }>).map((n) => n.key),
		).toEqual(
			expect.arrayContaining([
				"route:GET /api/orders/:param",
				"sym:web/src/api.ts#ordersApi.get",
				"page:/orders/:param",
			]),
		);
	});

	it("ranks what a table change reaches and explains each finding with its chain", async () => {
		const repo = await registerShop();
		const response = await session(
			"POST",
			`/api/v1/repositories/${repo.id}/impact`,
			{
				targets: [
					{ kind: "table", name: "orders" },
					{ kind: "config_key", name: "NOPE" },
				],
				depth: 8,
			},
		);
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.unresolved_targets).toEqual([
			{ kind: "config_key", name: "NOPE" },
		]);
		const route = (
			body.affected as Array<{
				node: { key: string };
				category: string;
				why: Array<{ from_key: string; kind: string; to_key: string }>;
				reached_from: string;
			}>
		).find((item) => item.node.key === "route:POST /api/orders");
		expect(route).toMatchObject({
			category: "api",
			reached_from: "table:orders",
		});
		expect(route?.why.map((link) => link.kind)).toEqual([
			"ROUTES_TO",
			"CALLS",
			"WRITES_TO",
		]);
		expect(body.groups).toMatchObject({
			api: expect.any(Number),
			ui: expect.any(Number),
		});
		expect(body.limitations.join(" ")).toMatch(/Graph-supported impact only/);
	});

	it("shows the source lines behind an edge, and the history and blame of a symbol", async () => {
		const repo = await registerShop();
		const route = await nodeByKey(repo.id, "route:POST /api/orders");
		const detail = (
			await session("GET", `/api/v1/graph/nodes/${route.id}`)
		).json();
		const handler = detail.outgoing.find(
			(edge: { kind: string; provenance: { role?: string } }) =>
				edge.kind === "ROUTES_TO" && edge.provenance.role === "handler",
		);
		const evidence = await session(
			"GET",
			`/api/v1/graph/snapshots/${handler.snapshot_id}/edges/${handler.id}`,
		);
		expect(evidence.statusCode).toBe(200);
		expect(evidence.json()).toMatchObject({
			edge: { kind: "ROUTES_TO", certainty: "resolved" },
			to: { name: "createOrder" },
			evidence: {
				type: "graph_edge",
				classification: "observed",
				path: "server/routes/orders.js",
			},
		});
		expect(evidence.json().evidence.excerpt).toContain('router.post("/orders"');
		expect(
			(
				await session(
					"GET",
					`/api/v1/graph/snapshots/${handler.snapshot_id}/edges/999999999`,
				)
			).statusCode,
		).toBe(404);

		const find = await nodeByKey(
			repo.id,
			"sym:server/services/orders.ts#OrderService.find",
		);
		const history = await session(
			"GET",
			`/api/v1/graph/nodes/${find.id}/history`,
		);
		expect(history.statusCode).toBe(200);
		expect(history.json()).toMatchObject({
			history: {
				method: "git log -L",
				commits: [{ subject: "add sources", author: "t" }],
			},
			blame: {
				lines: 1,
				commits: [{ author: "t", summary: "add sources", lines: 1 }],
			},
			owners: [],
		});
		expect(JSON.stringify(history.json())).not.toMatch(/@example\.com/);
	});

	it("maps a stack trace onto the indexed code with callers, routes, and tests, redacting what it echoes", async () => {
		const repo = await registerShop({
			"server/controllers/orders.test.js": [
				'import { test } from "node:test";',
				'import { createOrder } from "./orders.js";',
				'test("creates an order", async () => { await createOrder({ body: {} }, { json() {} }); });',
			].join("\n"),
		});
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo.dir,
			encoding: "utf8",
		}).trim();
		const secret = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
		const trace = [
			`TypeError: Cannot read properties of undefined (reading 'values') token=${secret}`,
			"    at OrderService.create (/srv/app/server/services/orders.ts:10:13)",
			"    at async createOrder (/srv/app/server/controllers/orders.js:4:66)",
			"    at Layer.handle [as handle_request] (/srv/app/node_modules/express/lib/router/layer.js:95:5)",
			"    at charge (/srv/app/server/payments.ts:3:1)",
			"    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
		].join("\n");
		const url = `/api/v1/repositories/${repo.id}/stack-traces/map`;
		const response = await session("POST", url, {
			trace,
			logs: "10:00:01 ERROR order failed for ops@example.com\n10:00:02 INFO orders.ts retry",
			commit_sha: head,
		});
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(JSON.stringify(body)).not.toContain(secret);
		expect(JSON.stringify(body)).not.toContain("ops@example.com");
		expect(body.revision).toEqual({
			requested: head,
			used: head,
			matches: true,
		});
		expect(body.error).toMatchObject({ type: "TypeError" });
		expect(body.summary).toEqual({
			frames: 5,
			resolved: 2,
			ambiguous: 0,
			unresolved: 1,
			external: 2,
			first_resolved_frame: 0,
		});
		const [service, controller, dependency, missing] = body.frames;
		expect(service).toMatchObject({
			resolution: {
				status: "resolved",
				file: "server/services/orders.ts",
				line: 10,
				method: "path_suffix",
				line_reliable: true,
			},
			symbol: {
				key: "sym:server/services/orders.ts#OrderService.create",
				name_matches: true,
			},
			related: {
				callers: [{ key: "sym:server/controllers/orders.js#createOrder" }],
			},
			evidence: {
				type: "code_excerpt",
				classification: "observed",
				path: "server/services/orders.ts",
				commit_sha: head,
				certainty: "resolved",
				symbol: "OrderService.create",
			},
		});
		expect(service.excerpt.text).toContain(
			"  10| \t\treturn db.insert(orders).values(body);",
		);
		expect(
			controller.related.routes.map((r: { key: string }) => r.key),
		).toEqual(["route:POST /api/orders"]);
		expect(controller.related.tests.map((t: { key: string }) => t.key)).toEqual(
			expect.arrayContaining([
				"test:server/controllers/orders.test.js#creates an order",
			]),
		);
		expect(dependency).toMatchObject({
			resolution: { status: "external", reason: "dependency_frame" },
			related: null,
			evidence: null,
		});
		expect(missing.resolution).toEqual({
			status: "unresolved",
			reason: "no_matching_file",
		});
		expect(body.logs).toMatchObject({
			error_lines: [{ line: 1 }],
			mentions: [{ term: "orders.ts", count: 1 }],
		});
		expect(body.limitations.join(" ")).toMatch(/not why it happened/);

		// A trace from a commit that was never indexed is mapped to the newest snapshot, and says so.
		const drift = await session("POST", url, {
			trace,
			commit_sha: "f".repeat(40),
		});
		expect(drift.statusCode).toBe(200);
		expect(drift.json()).toMatchObject({
			revision: { requested: "f".repeat(40), used: head, matches: false },
			logs: null,
		});
		expect(drift.json().limitations.join(" ")).toMatch(/is not indexed/);
		expect((await session("POST", url, { trace: "" })).statusCode).toBe(400);
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		expect((await other("POST", url, { trace })).statusCode).toBe(404);
	});

	it("searches names, paths, and text together, saying why each result matched", async () => {
		const repo = await registerShop();
		const response = await session(
			"GET",
			`/api/v1/repositories/${repo.id}/search?q=orders&mode=all`,
		);
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.results[0]).toMatchObject({ match: { reason: "exact_name" } });
		const reasons = new Set(
			(body.results as Array<{ match: { reason: string } }>).map(
				(r) => r.match.reason,
			),
		);
		expect(reasons).toEqual(
			new Set(["exact_name", "path", "name_prefix", "name_contains", "text"]),
		);
		expect(body.semantic).toMatchObject({ available: false });
		// Other workspaces cannot reach these endpoints.
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		const page = await nodeByKey(repo.id, "page:/orders/:param");
		for (const [method, url] of [
			["GET", `/api/v1/graph/nodes/${page.id}/trace`],
			["GET", `/api/v1/graph/nodes/${page.id}/history`],
			["POST", `/api/v1/repositories/${repo.id}/impact`],
		] as const)
			expect(
				(
					await other(
						method,
						url,
						method === "POST"
							? { targets: [{ kind: "table", name: "orders" }] }
							: undefined,
					)
				).statusCode,
				url,
			).toBe(404);
	});
});

// ---- Feasibility and change assessment [scripted model, real graph] ---------------------------

const userOf = (request: ChatRequest) =>
	request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
function evidenceBlocks(request: ChatRequest) {
	return [
		...userOf(request).matchAll(
			/<untrusted source="([^"]+)"([^>]*)>\n([\s\S]*?)\n<\/untrusted>/g,
		),
	].map((m) => ({
		source: m[1] ?? "",
		attributes: m[2] ?? "",
		body: m[3] ?? "",
	}));
}

/** Reads the prompt like a model would and cites the excerpt that defines shippingCents. */
function feasibility(handle?: string) {
	return (request: ChatRequest) => {
		const code = evidenceBlocks(request).find(
			(b) =>
				b.attributes.includes('path="src/pricing.js"') &&
				b.body.includes("export function shippingCents"),
		);
		const cite = {
			handle: handle ?? code?.source ?? "CODE-missing",
			start_line: null,
			end_line: null,
		};
		return {
			understanding: "Raise the free-shipping threshold from $50 to $75.",
			status: "SUPPORTED_WITH_CHANGES",
			status_rationale: "The threshold is a constant used by shippingCents.",
			relevant_components: [
				{ citation: cite, role: "Decides when shipping is free" },
			],
			reusable_capabilities: [],
			missing: [
				{
					kind: "code",
					description: "A new threshold value and updated tests",
				},
			],
			external_assumptions: [],
			risks: [
				{
					category: "regression",
					description: "Tests assert the old threshold",
					citations: [cite],
				},
			],
			unknowns: [],
			next_steps: ["Change the constant and its tests"],
			confidence: "high",
			confidence_rationale:
				"The constant and its only caller are in the excerpt.",
		};
	};
}

async function runAssessment(
	repositoryId: string,
	provider: ReturnType<typeof scriptedProvider>,
) {
	const created = await session(
		"POST",
		`/api/v1/repositories/${repositoryId}/assessments`,
		{
			request:
				"Raise the free shipping threshold from $50 to $75 for all orders",
		},
	);
	expect(created.statusCode).toBe(202);
	const id = created.json().assessment.id as string;
	const { rows } = await ctx.pool.query<{ id: string }>(
		"SELECT id FROM pgboss.job WHERE name = $1 AND data->>'assessmentId' = $2",
		[QUEUES.assess, id],
	);
	expect(rows).toHaveLength(1);
	await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
		QUEUES.assess,
	]);
	await runAssessJob({ db: ctx.db, config: ctx.config, provider }, id);
	const response = await session("GET", `/api/v1/assessments/${id}`);
	expect(response.statusCode).toBe(200);
	return { id, assessment: response.json().assessment, provider };
}

describe("feasibility and change assessment [scripted model, static graph]", () => {
	it("refuses to assess a repository that has no graph snapshot yet", async () => {
		const { repository } = await registerBenchShop();
		const response = await session(
			"POST",
			`/api/v1/repositories/${repository.id}/assessments`,
			{ request: "Add a loyalty discount for repeat customers" },
		);
		expect(response.statusCode).toBe(409);
		expect(response.json().code).toBe("graph_not_indexed");
	});

	it("grounds an evidenced verdict in cited code and graph-supported impact", async () => {
		const { repository } = await registerBenchShop();
		await drainIndexJobs();
		const { assessment, provider } = await runAssessment(
			repository.id,
			scriptedProvider({ assess_feasibility: feasibility() }),
		);
		expect(provider.calls).toHaveLength(1);
		expect(provider.calls[0]?.user).toContain('<untrusted source="REQ"');
		expect(assessment.status).toBe("completed");
		const result = assessment.result;
		expect(result).toMatchObject({
			specialists: [
				"repository_mapping",
				"code_exploration",
				"feasibility_planning",
				"impact_analysis",
			],
			status: "SUPPORTED_WITH_CHANGES",
			confidence: "high",
			downgrades: [],
			citations: { total: 2, invalid: 0 },
			change_size: { class: "SMALL", likely_files: ["src/pricing.js"] },
		});
		expect(result.relevant_components[0].evidence[0]).toMatchObject({
			type: "code_excerpt",
			classification: "observed",
			path: "src/pricing.js",
			symbol: "shippingCents",
		});
		expect(result.impact.graph_supported.files).toContain(
			"test/pricing.test.js",
		);
		// Affected packages: the one manifest that owns the cited and dependent files.
		expect(result.impact.packages).toMatchObject([{ path: "package.json" }]);
		expect(result.impact.packages[0].files).toBeGreaterThanOrEqual(2);
		expect(result.impact.inferred).toEqual([
			{
				kind: "code",
				description: "A new threshold value and updated tests",
				basis: "inferred",
			},
		]);
		expect(result.limitations[0]).toMatch(/Preliminary estimate/);
	});

	it("downgrades a verdict whose citations do not exist", async () => {
		const { repository } = await registerBenchShop();
		await drainIndexJobs();
		const { assessment } = await runAssessment(
			repository.id,
			scriptedProvider({ assess_feasibility: feasibility("CODE-42") }),
		);
		expect(assessment.result).toMatchObject({
			status: "INSUFFICIENT_EVIDENCE",
			model_status: "SUPPORTED_WITH_CHANGES",
			confidence: "low",
			downgrades: ["no_cited_components", "many_invalid_citations"],
			relevant_components: [],
			change_size: { class: "UNKNOWN" },
		});
	});

	it("fails honestly when the model provider rejects the call", async () => {
		const { repository } = await registerBenchShop();
		await drainIndexJobs();
		const { assessment } = await runAssessment(
			repository.id,
			scriptedProvider({
				assess_feasibility: new ProviderError(
					"provider_auth_failed",
					"Model provider rejected the API key",
					false,
				),
			}),
		);
		expect(assessment).toMatchObject({
			status: "failed",
			error: { code: "provider_auth_failed" },
		});
		// The deterministic evidence is kept; no verdict is invented.
		expect(assessment.result.evidence.length).toBeGreaterThan(1);
		expect(assessment.result.status).toBeUndefined();
	});
});

// ---- Engineering questions [scripted model, real graph] ----------------------------------------

/** Answers like a model would: cites the shippingCents excerpt; optionally adds a claim citing only the question. */
function answer(options: { unsupported?: boolean } = {}) {
	return (request: ChatRequest) => {
		const code = evidenceBlocks(request).find(
			(b) =>
				b.attributes.includes('path="src/pricing.js"') &&
				b.body.includes("export function shippingCents"),
		);
		const none = { start_line: null, end_line: null };
		return {
			status: "ANSWERED",
			answer: "shippingCents in src/pricing.js decides when shipping is free.",
			claims: [
				{
					statement: "shippingCents computes the shipping charge for an order.",
					citations: [{ handle: code?.source ?? "CODE-missing", ...none }],
				},
				...(options.unsupported
					? [
							{
								statement: "Checkout calls it for every order.",
								citations: [{ handle: "REQ", ...none }],
							},
						]
					: []),
			],
			unknowns: [],
			follow_up_questions: ["Which tests cover the threshold?"],
			confidence: "high",
			confidence_rationale: "The function is in the excerpt.",
		};
	};
}

async function runQuestion(
	repositoryId: string,
	provider: ReturnType<typeof scriptedProvider>,
	body: Record<string, unknown>,
) {
	const created = await session(
		"POST",
		`/api/v1/repositories/${repositoryId}/questions`,
		body,
	);
	expect(created.statusCode).toBe(202);
	const id = created.json().assessment.id as string;
	await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
		QUEUES.assess,
	]);
	await runAssessJob({ db: ctx.db, config: ctx.config, provider }, id);
	return (await session("GET", `/api/v1/assessments/${id}`)).json().assessment;
}

describe("engineering questions [scripted model, static graph]", () => {
	it("answers with claims backed by cited code and follows up in the same context", async () => {
		const { repository } = await registerBenchShop();
		await drainIndexJobs();
		const first = await runQuestion(
			repository.id,
			scriptedProvider({ answer_question: answer() }),
			{ question: "Where is the free shipping threshold decided?" },
		);
		expect(first).toMatchObject({
			kind: "question",
			status: "completed",
			follow_up_of: null,
			result: {
				specialists: ["repository_mapping", "code_exploration"],
				status: "ANSWERED",
				confidence: "high",
				downgrades: [],
				citations: { total: 1, invalid: 0 },
				summary: { basis: "inferred" },
			},
		});
		expect(first.result.claims[0]).toMatchObject({
			basis: "inferred",
			supported: true,
			evidence: [{ type: "code_excerpt", path: "src/pricing.js" }],
		});
		expect(first.result.limitations[0]).toMatch(
			/Answered from static evidence/,
		);

		const provider = scriptedProvider({ answer_question: answer() });
		const followUp = await runQuestion(repository.id, provider, {
			question: "Which tests cover it?",
			follow_up_of: first.id,
		});
		expect(followUp).toMatchObject({
			follow_up_of: first.id,
			result: { status: "ANSWERED" },
		});
		const prompt = provider.calls[0]?.user ?? "";
		expect(prompt).toContain(
			'<untrusted source="PRIOR" kind="previous_answer">',
		);
		expect(prompt).toContain("shippingCents in src/pricing.js decides");
		// The files the earlier answer cited stay in view.
		expect(
			(
				followUp.result.candidates as Array<{
					path: string;
					reasons: string[];
				}>
			).some(
				(c) =>
					c.path === "src/pricing.js" &&
					c.reasons.includes("named by the requester"),
			),
		).toBe(true);
	});

	it("marks claims without valid evidence, never counting the question as evidence", async () => {
		const { repository } = await registerBenchShop();
		await drainIndexJobs();
		const asked = await runQuestion(
			repository.id,
			scriptedProvider({ answer_question: answer({ unsupported: true }) }),
			{ question: "Where is the free shipping threshold decided?" },
		);
		expect(asked.result).toMatchObject({
			status: "PARTIALLY_ANSWERED",
			model_status: "ANSWERED",
			confidence: "low",
			downgrades: ["unsupported_claims", "many_invalid_citations"],
			citations: { total: 2, invalid: 1 },
		});
		expect(asked.result.claims[1]).toMatchObject({
			supported: false,
			evidence: [],
		});
	});

	it("follows up only completed questions in the caller's workspace", async () => {
		const { repository } = await registerBenchShop();
		await drainIndexJobs();
		const url = `/api/v1/repositories/${repository.id}/questions`;
		const pending = await session("POST", url, {
			question: "Where is the free shipping threshold decided?",
		});
		expect(pending.statusCode).toBe(202);
		const id = pending.json().assessment.id as string;
		const early = await session("POST", url, {
			question: "And which tests cover it?",
			follow_up_of: id,
		});
		expect(early.statusCode).toBe(409);
		expect(early.json().code).toBe("invalid_state");
		const missing = await session("POST", url, {
			question: "And which tests cover it?",
			follow_up_of: `asm_${"0".repeat(26)}`,
		});
		expect(missing.statusCode).toBe(404);
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		expect(
			(await other("POST", url, { question: "Where is shipping decided?" }))
				.statusCode,
		).toBe(404);
		expect((await other("GET", `/api/v1/assessments/${id}`)).statusCode).toBe(
			404,
		);
	});
});
