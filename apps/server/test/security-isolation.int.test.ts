import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupBenchShop } from "../../../scripts/bench-setup.ts";
import { runIndexJob } from "../src/modules/graph.ts";
import { workspacesRoot } from "../src/modules/workspace.ts";
import { QUEUES } from "../src/queue.ts";
import type { SandboxRunRequest } from "../src/sandbox/executor.ts";
import {
	B3,
	hypothesesCiting,
	patchOutput,
	plan,
	SUITE,
} from "./bench-scenarios.ts";
import {
	addMember,
	asSession,
	asToken,
	createOwner,
	createTestContext,
	createToken,
	driveInvestigation,
	type FakeRun,
	fakeExecutor,
	login,
	makeGitRepo,
	normalizationOutput,
	repositoryBody,
	resetDatabase,
	scriptedProvider,
	type TestContext,
	tapOutput,
} from "./helpers.ts";
import {
	COLLECTION_PREFIX,
	collectionOf,
	fillPath,
	type Method,
	ROUTE_RULES,
	registeredRoutes,
	routeKey,
} from "./security-routes.ts";

// Workspace isolation over every registered route that takes an ID, plus IDs carried in
// bodies and queries. Workspace A owns one real resource of every kind (an indexed repository, its
// graph, an assessment, a question, a patch analysis, a dependency snapshot, a bug report, an
// investigation driven to a verified patch [mock inference, fake executor], and a token); workspace
// B, with full privileges, must get 404 for each and change nothing.

let ctx: TestContext;
let owner: ReturnType<typeof asSession>;
let intruder: ReturnType<typeof asSession>;
let intruderToken: ReturnType<typeof asToken>;
let ownerToken: string;
let ownerWorkspaceId = "";
/** One of workspace A's IDs per collection (the segment before `:id`). */
const ids: Record<string, string> = {};
let edgeId = "";
let questionId = "";
let intruderRepoId = "";
let intruderBugId = "";

async function drainIndexJobs() {
	for (;;) {
		const { rows } = await ctx.pool.query<{
			id: string;
			data: { snapshotId: string };
		}>(
			"SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' ORDER BY created_on LIMIT 1",
			[QUEUES.index],
		);
		const job = rows[0];
		if (!job) return;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [job.id]);
		await runIndexJob({ db: ctx.db, config: ctx.config }, job.data.snapshotId);
	}
}

function commitFiles(dir: string, files: Record<string, string>) {
	for (const [file, content] of Object.entries(files))
		writeFileSync(path.join(dir, file), content);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("add", "-A");
	git(
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"-m",
		"files",
	);
}

/** package.json and a v3 lockfile pinning one registry tarball (the fake executor downloads nothing). */
function npmProject() {
	const dependencies = { "left-pad": "1.3.0" };
	const integrity = `sha512-${createHash("sha512").update("left-pad@1.3.0").digest("base64")}`;
	const manifest = { name: "deps-app", version: "1.0.0" };
	return {
		"package.json": `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`,
		"package-lock.json": `${JSON.stringify(
			{
				...manifest,
				lockfileVersion: 3,
				requires: true,
				packages: {
					"": { ...manifest, dependencies },
					"node_modules/left-pad": {
						version: "1.3.0",
						resolved:
							"https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
						integrity,
					},
				},
			},
			null,
			2,
		)}\n`,
	};
}

/** node:test without executing code: the bug marker in the run copy decides the result. */
function benchScript(request: SandboxRunRequest): FakeRun {
	const source = readFileSync(
		path.join(request.workspace, ...B3.file.split("/")),
		"utf8",
	);
	const buggy = source.includes(B3.marker);
	if (request.argv.includes(".tracera/repro/repro.mjs"))
		return {
			exitCode: buggy ? 1 : 0,
			stdout: tapOutput([
				{ name: "two orders totaling $49.60 average $24.80", ok: !buggy },
			]),
		};
	return {
		exitCode: 0,
		stdout: tapOutput(SUITE.map((name) => ({ name, ok: true }))),
	};
}

async function json<T>(response: Promise<LightMyRequestResponse>, status = 0) {
	const settled = await response;
	if (status && settled.statusCode !== status)
		throw new Error(
			`expected ${status}, got ${settled.statusCode}: ${settled.body}`,
		);
	return settled.json() as T;
}

beforeAll(async () => {
	ctx = await createTestContext();
	setupBenchShop(ctx.config.dataDir);
	await ctx.app.ready();
	await resetDatabase(ctx.pool);
	ownerWorkspaceId = (await createOwner(ctx.db)).workspaceId;
	const ownerCookie = await login(ctx);
	owner = asSession(ctx, ownerCookie);

	// Workspace A: an indexed repository and its graph.
	const registered = await json<{
		repository: { id: string };
		snapshot: { id: string };
	}>(
		owner("POST", "/api/v1/repositories", {
			name: "bench-shop",
			source: { type: "fixture", fixture: "bench-shop" },
			commands: { install: "npm ci --ignore-scripts", test: "npm test" },
		}),
		201,
	);
	ids.repositories = registered.repository.id;
	ids.snapshots = registered.snapshot.id;
	const deps = makeGitRepo(ctx.repoRoot, "deps-app");
	commitFiles(deps, { ...npmProject(), "index.js": "module.exports = 1;\n" });
	const depsRepository = await json<{ repository: { id: string } }>(
		owner("POST", "/api/v1/repositories", repositoryBody(deps, "deps-app")),
		201,
	);
	await drainIndexJobs();
	const repo = `/api/v1/repositories/${ids.repositories}`;
	const nodes = await json<{ nodes: Array<{ id: string; name: string }> }>(
		owner("GET", `${repo}/graph/nodes?q=averageOrderValueCents&kind=function`),
		200,
	);
	const node = nodes.nodes.find((n) => n.name === "averageOrderValueCents");
	if (!node) throw new Error("averageOrderValueCents was not indexed");
	ids.nodes = node.id;
	const detail = await json<{
		outgoing: Array<{ id: number }>;
		incoming: Array<{ id: number }>;
	}>(owner("GET", `/api/v1/graph/nodes/${node.id}`), 200);
	const edge = detail.outgoing[0] ?? detail.incoming[0];
	if (!edge) throw new Error("the node has no edges");
	edgeId = String(edge.id);

	// Queued work of every kind (no worker runs it; queued rows are enough to address).
	ids.assessments = (
		await json<{ assessment: { id: string } }>(
			owner("POST", `${repo}/assessments`, {
				request: "Add a discount code field to checkout",
			}),
			202,
		)
	).assessment.id;
	questionId = (
		await json<{ assessment: { id: string } }>(
			owner("POST", `${repo}/questions`, {
				question: "Where is the average order value computed?",
			}),
			202,
		)
	).assessment.id;
	ids["patch-impact"] = (
		await json<{ analysis: { id: string } }>(
			owner("POST", `${repo}/patch-impact`, { base: "main", head: B3.branch }),
			202,
		)
	).analysis.id;
	ids["dependency-snapshots"] = (
		await json<{ snapshot: { id: string } }>(
			owner(
				"POST",
				`/api/v1/repositories/${depsRepository.repository.id}/dependency-snapshots`,
				{},
			),
			202,
		)
	).snapshot.id;

	// An investigation driven to a verified patch awaiting approval.
	const bug = await json<{ bug_report: { id: string } }>(
		owner("POST", "/api/v1/bug-reports", {
			...B3.report,
			repository_id: ids.repositories,
		}),
		201,
	);
	ids["bug-reports"] = bug.bug_report.id;
	const investigation = await json<{ investigation: { id: string } }>(
		owner("POST", "/api/v1/investigations", {
			bug_report_id: ids["bug-reports"],
			commit: B3.branch,
		}),
		202,
	);
	ids.investigations = investigation.investigation.id;
	await driveInvestigation(
		ctx,
		{
			config: ctx.config,
			db: ctx.db,
			pool: ctx.pool,
			boss: ctx.boss,
			provider: scriptedProvider({
				normalize_bug_report: normalizationOutput,
				plan_reproduction: plan(),
				generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
				generate_patch: patchOutput(),
			}),
			executor: fakeExecutor(workspacesRoot(ctx.config), benchScript),
			workerId: "test-worker",
		},
		ids.investigations,
	);
	const patches = await json<{
		items: Array<{ id: string; verification: { id: string } | null }>;
	}>(owner("GET", `/api/v1/investigations/${ids.investigations}/patches`), 200);
	const patch = patches.items[0];
	if (!patch?.verification) throw new Error("the investigation has no patch");
	ids.patches = patch.id;
	ids.verifications = patch.verification.id;

	ownerToken = await createToken(ctx, ownerCookie, {
		name: "owner laptop",
		client_kind: "mcp",
	});
	const tokens = await json<{ items: Array<{ id: string }> }>(
		owner("GET", "/api/v1/tokens"),
		200,
	);
	ids.tokens = tokens.items[0]?.id ?? "";

	// Workspace B: an owner with every privilege, a full-scope token, and an indexed repository.
	await createOwner(ctx.db, "intruder@example.com");
	const intruderCookie = await login(ctx, "intruder@example.com");
	intruder = asSession(ctx, intruderCookie);
	intruderToken = asToken(
		ctx,
		await createToken(ctx, intruderCookie, { name: "b", client_kind: "mcp" }),
	);
	const own = makeGitRepo(ctx.repoRoot, "intruder-app");
	commitFiles(own, {
		"metrics.js":
			"export function averageOrderValueCents(orders) {\n\treturn orders.length;\n}\n",
	});
	intruderRepoId = (
		await json<{ repository: { id: string } }>(
			intruder("POST", "/api/v1/repositories", {
				...repositoryBody(own, "intruder-app"),
			}),
			201,
		)
	).repository.id;
	await drainIndexJobs();
	intruderBugId = (
		await json<{ bug_report: { id: string } }>(
			intruder("POST", "/api/v1/bug-reports", {
				title: "Intruder report",
				description: "A report in workspace B",
				repository_id: intruderRepoId,
				normalize: false,
			}),
			201,
		)
	).bug_report.id;
}, 180_000);
afterAll(async () => ctx.close());

const idRoutes = () =>
	registeredRoutes(ctx.app)
		.map((key) => {
			const [method, routePath] = key.split(" ") as [Method, string];
			return { method, path: routePath };
		})
		.filter((route) => route.path.includes("/:"));
const ownerUrl = (routePath: string) =>
	fillPath(routePath, (collection) => ids[collection] ?? "", edgeId);

/** Valid requests, so a 404 can only come from the workspace check. */
function requestFor(method: Method, routePath: string) {
	const key = `${method} ${routePath}`;
	const query: Record<string, string> = {
		"GET /api/v1/repositories/:id/search": "?q=order",
		"DELETE /api/v1/repositories/:id": "?confirm=bench-shop",
	};
	const body: Record<string, unknown> = {
		"PATCH /api/v1/repositories/:id": { name: "taken-over" },
		"POST /api/v1/repositories/:id/assessments": {
			request: "Add a discount code field to checkout",
		},
		"POST /api/v1/repositories/:id/questions": {
			question: "Where is the average order value computed?",
		},
		"POST /api/v1/repositories/:id/patch-impact": {
			base: "main",
			head: B3.branch,
		},
		"POST /api/v1/repositories/:id/impact": {
			targets: [{ kind: "file", path: B3.file }],
		},
		"POST /api/v1/repositories/:id/stack-traces/map": {
			trace: `TypeError: boom\n    at averageOrderValueCents (${B3.file}:3:10)`,
		},
		"POST /api/v1/patches/:id/approval": {
			decision: "approved",
			verification_id: ids.verifications,
			acknowledged_risks: [],
		},
	};
	return {
		url: `${ownerUrl(routePath)}${query[key] ?? ""}`,
		payload:
			method === "POST" || method === "PATCH" ? (body[key] ?? {}) : undefined,
	};
}

function expectNotFound(response: LightMyRequestResponse, what: string) {
	expect(response.statusCode, `${what}: ${response.body}`).toBe(404);
	const problem = response.json() as { code: string; detail: string };
	expect(problem.code, what).toBe("not_found");
	// The route matched and refused; a typo in the URL would be the router's "No route" instead.
	expect(problem.detail, what).not.toMatch(/^No route/);
}

describe("workspace isolation [mock inference, fake executor]", () => {
	it("has a resource of workspace A for every collection a route addresses by ID", () => {
		for (const route of idRoutes()) {
			const collection = collectionOf(route.path);
			expect(collection, routeKey(route)).not.toBe(null);
			expect(COLLECTION_PREFIX[collection ?? ""], routeKey(route)).toBeTruthy();
			expect(ids[collection ?? ""], routeKey(route)).toMatch(
				new RegExp(`^${COLLECTION_PREFIX[collection ?? ""]}_`),
			);
		}
	});

	it("serves workspace A every one of its resources (control)", async () => {
		for (const route of idRoutes().filter((r) => r.method === "GET")) {
			const { url } = requestFor(route.method, route.path);
			const response = await owner("GET", url);
			expect(
				response.statusCode,
				`${routeKey(route)}: ${response.body}`,
			).not.toBe(404);
			expect(response.statusCode, routeKey(route)).toBeLessThan(500);
		}
	});

	it("answers 404 to another workspace's session and token for every foreign ID", async () => {
		for (const route of idRoutes()) {
			const { url, payload } = requestFor(route.method, route.path);
			expectNotFound(
				await intruder(route.method, url, payload),
				`${routeKey(route)} as B's session`,
			);
			const rule = ROUTE_RULES.find((r) => routeKey(r) === routeKey(route));
			if (rule?.access === "session" || rule?.access === "owner") continue;
			expectNotFound(
				await intruderToken(route.method, url, payload),
				`${routeKey(route)} as B's token`,
			);
		}
	});

	it("answers 404 to foreign IDs carried in bodies and queries", async () => {
		const own = `/api/v1/repositories/${intruderRepoId}`;
		const cases: Array<[Method, string, unknown]> = [
			[
				"POST",
				"/api/v1/bug-reports",
				{
					title: "t",
					description: "d",
					repository_id: ids.repositories,
					normalize: false,
				},
			],
			["POST", "/api/v1/investigations", { bug_report_id: ids["bug-reports"] }],
			[
				"POST",
				"/api/v1/investigations",
				{ bug_report_id: intruderBugId, repository_id: ids.repositories },
			],
			[
				"POST",
				`${own}/assessments`,
				{
					request: "Add a discount code field to checkout",
					snapshot_id: ids.snapshots,
				},
			],
			[
				"POST",
				`${own}/questions`,
				{ question: "What does this do?", snapshot_id: ids.snapshots },
			],
			[
				"POST",
				`${own}/questions`,
				{ question: "What does this do?", follow_up_of: questionId },
			],
			["POST", `${own}/impact`, { targets: [{ kind: "node", id: ids.nodes }] }],
			[
				"POST",
				`${own}/impact`,
				{
					targets: [{ kind: "file", path: "metrics.js" }],
					snapshot_id: ids.snapshots,
				},
			],
			[
				"POST",
				`${own}/stack-traces/map`,
				{
					trace: "Error: x\n    at f (metrics.js:1:1)",
					snapshot_id: ids.snapshots,
				},
			],
			["GET", `${own}/graph/nodes?snapshot_id=${ids.snapshots}`, undefined],
			["GET", `${own}/search?q=order&snapshot_id=${ids.snapshots}`, undefined],
		];
		for (const [method, url, payload] of cases) {
			expectNotFound(await intruder(method, url, payload), `${method} ${url}`);
			expectNotFound(
				await intruderToken(method, url, payload),
				`${method} ${url} as a token`,
			);
		}
	});

	it("lists only the caller's own workspace, whatever the filter", async () => {
		const own = `/api/v1/repositories/${intruderRepoId}`;
		const foreign = [...Object.values(ids), questionId];
		for (const url of [
			"/api/v1/repositories",
			"/api/v1/bug-reports",
			`/api/v1/bug-reports?repository_id=${ids.repositories}`,
			"/api/v1/investigations",
			`/api/v1/investigations?bug_report_id=${ids["bug-reports"]}`,
			"/api/v1/tokens",
			`${own}/snapshots`,
			`${own}/patch-impact`,
			`${own}/dependency-snapshots`,
			"/api/v1/auth/me",
		]) {
			const response = await intruder("GET", url);
			expect(response.statusCode, url).toBe(200);
			for (const id of foreign) expect(response.body, url).not.toContain(id);
		}
	});

	it("leaves workspace A unchanged after the refused requests", async () => {
		const get = async <T>(url: string) => json<T>(owner("GET", url), 200);
		expect(
			(
				await get<{ repository: { name: string } }>(
					`/api/v1/repositories/${ids.repositories}`,
				)
			).repository.name,
		).toBe("bench-shop");
		expect(
			(
				await get<{ investigation: { status: string } }>(
					`/api/v1/investigations/${ids.investigations}`,
				)
			).investigation.status,
		).toBe("awaiting_approval");
		expect(
			(
				await get<{ patch: { status: string } }>(
					`/api/v1/patches/${ids.patches}`,
				)
			).patch.status,
		).toBe("proposed");
		expect(
			(
				await get<{ analysis: { status: string } }>(
					`/api/v1/patch-impact/${ids["patch-impact"]}`,
				)
			).analysis.status,
		).toBe("queued");
		expect(
			(
				await get<{ snapshot: { status: string } }>(
					`/api/v1/dependency-snapshots/${ids["dependency-snapshots"]}`,
				)
			).snapshot.status,
		).toBe("queued");
		const snapshots = await get<{
			snapshots: Array<{
				id: string;
				status: string;
				cancel_requested_at: string | null;
			}>;
		}>(`/api/v1/repositories/${ids.repositories}/snapshots`);
		expect(
			snapshots.snapshots.find((s) => s.id === ids.snapshots)?.status,
		).toBe("ready");
		expect(snapshots.snapshots.every((s) => !s.cancel_requested_at)).toBe(true);
		expect(
			(await asToken(ctx, ownerToken)("GET", "/api/v1/auth/me")).statusCode,
		).toBe(200);
		// Nothing about A's resources was recorded in another workspace's audit trail.
		const { rows } = await ctx.pool.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM audit_events WHERE target_id = ANY($1) AND workspace_id <> $2",
			[Object.values(ids), ownerWorkspaceId],
		);
		expect(rows[0]?.n).toBe(0);
	});

	it("never replays another workspace's idempotent response", async () => {
		const headers = { "idempotency-key": "same-key" };
		const body = {
			title: "Same body",
			description: "Same body in two workspaces",
			normalize: false,
		};
		const first = await json<{ bug_report: { id: string } }>(
			owner("POST", "/api/v1/bug-reports", body, headers),
			201,
		);
		const second = await intruder("POST", "/api/v1/bug-reports", body, headers);
		expect(second.statusCode).toBe(201);
		expect(second.body).not.toContain(first.bug_report.id);
	});

	it("keeps tokens private to their user inside a workspace", async () => {
		await addMember(ctx.db, ownerWorkspaceId);
		const member = asSession(ctx, await login(ctx, "member@example.com"));
		const list = await member("GET", "/api/v1/tokens");
		expect(list.statusCode).toBe(200);
		expect(list.body).not.toContain(ids.tokens);
		expectNotFound(
			await member("DELETE", `/api/v1/tokens/${ids.tokens}`),
			"a member revoking the owner's token",
		);
		expect(
			(await asToken(ctx, ownerToken)("GET", "/api/v1/auth/me")).statusCode,
		).toBe(200);
	});
});
