import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MeetingExtractionOutput } from "@tracera/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupBenchShop } from "../../../scripts/bench-setup.ts";
import {
	authorizedActions,
	evidenceAssets,
	integrationConnections,
} from "../src/db/schema.ts";
import { putBlob } from "../src/lib/fs.ts";
import { newId } from "../src/lib/ids.ts";
import { runIndexJob } from "../src/modules/graph.ts";
import {
	MEETING_EXTRACT_QUEUE,
	runMeetingExtraction,
} from "../src/modules/meeting-extract.ts";
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
let ownerUserId = "";
/** One of workspace A's IDs per collection (the segment before `:id`). */
const ids: Record<string, string> = {};
let edgeId = "";
let questionId = "";
let candidateId = "";
let segmentId = "";
let intruderRepoId = "";
let intruderBugId = "";
let intruderMeetingId = "";
/** A valid screenshot upload, so a 404 for the evidence route can only come from the workspace check. */
let screenshotUpload: { payload: Buffer; contentType: string };
let intruderCandidateId = "";

/** What a model could return for the Teams-style transcript: one bug that cites its segment. */
const EXTRACTION: MeetingExtractionOutput = {
	items: [
		{
			kind: "bug",
			title: "Cart total shows NaN after applying the SAVE10 coupon",
			description:
				"With two items in the cart and the SAVE10 coupon applied, the total shows NaN.",
			expected_behavior: "The discounted total is shown",
			actual_behavior: "The total shows NaN",
			steps: ["Add two items to the cart", "Apply the SAVE10 coupon"],
			severity_suggestion: "unknown",
			affected_area: "cart",
			citations: [
				{
					handle: "SEG-2",
					quote: "the total shows NaN instead of the discounted price",
				},
			],
		},
	],
};

const transcriptUpload = () => ({
	provider: "teams",
	consent_attested: true,
	title: "Checkout standup",
	transcript: {
		filename: "teams.vtt",
		content_type: "text/vtt",
		data_base64: readFileSync(
			new URL("./fixtures/meetings/teams.vtt", import.meta.url),
		).toString("base64"),
	},
});

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

/** Uploads the transcript and runs its queued extraction the way the worker does. */
async function seedMeeting(
	as: typeof owner,
	repositoryId?: string,
): Promise<{ meetingId: string; candidateId: string; segmentId: string }> {
	const created = await json<{ meeting: { id: string } }>(
		as("POST", "/api/v1/meetings", {
			...transcriptUpload(),
			...(repositoryId ? { repository_id: repositoryId } : {}),
		}),
		202,
	);
	const meetingId = created.meeting.id;
	await ctx.pool.query(
		"DELETE FROM pgboss.job WHERE name = $1 AND data->>'meetingId' = $2",
		[MEETING_EXTRACT_QUEUE, meetingId],
	);
	await runMeetingExtraction(
		{
			db: ctx.db,
			pool: ctx.pool,
			config: ctx.config,
			provider: scriptedProvider({ extract_meeting_bugs: EXTRACTION }),
		},
		meetingId,
	);
	const candidates = await json<{ items: Array<{ id: string }> }>(
		as("GET", `/api/v1/meetings/${meetingId}/candidates`),
		200,
	);
	const segments = await json<{ items: Array<{ id: string }> }>(
		as("GET", `/api/v1/meetings/${meetingId}/segments`),
		200,
	);
	const candidate = candidates.items[0];
	const segment = segments.items[0];
	if (!candidate || !segment) throw new Error("the meeting was not extracted");
	return { meetingId, candidateId: candidate.id, segmentId: segment.id };
}

beforeAll(async () => {
	ctx = await createTestContext();
	setupBenchShop(ctx.config.dataDir);
	await ctx.app.ready();
	await resetDatabase(ctx.pool);
	const form = new FormData();
	form.set(
		"meta",
		JSON.stringify({
			kind: "screenshot",
			captured_at: "2026-10-25T10:00:00.000Z",
			page_url: "https://shop.example/dashboard",
			page_title: "Dashboard",
			viewport: { width: 1280, height: 720 },
			device_pixel_ratio: 2,
			client_redactions: [],
			client_annotations: [],
		}),
	);
	form.set(
		"file",
		new Blob(
			[new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])],
			{ type: "image/png" },
		),
		"screenshot.png",
	);
	const encoded = new Request("http://localhost/", {
		method: "POST",
		body: form,
	});
	screenshotUpload = {
		payload: Buffer.from(await encoded.arrayBuffer()),
		contentType: encoded.headers.get("content-type") ?? "",
	};
	const created = await createOwner(ctx.db);
	ownerWorkspaceId = created.workspaceId;
	ownerUserId = created.userId;
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
	// Evidence of workspace A, stored directly (the upload route has its own tests).
	const screenshot = await putBlob(
		path.join(ctx.config.dataDir, "blobs"),
		Buffer.from("89504e470d0a1a0a00", "hex"),
	);
	ids.evidence = newId("evd");
	await ctx.db.insert(evidenceAssets).values({
		id: ids.evidence,
		workspaceId: ownerWorkspaceId,
		bugReportId: ids["bug-reports"],
		kind: "screenshot",
		origin: "user_provided",
		blobSha256: screenshot.sha256,
		mimeType: "image/png",
		sizeBytes: screenshot.size,
		provenance: {},
		retentionUntil: new Date(Date.now() + 86_400_000),
	});
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

	// An action request that was refused (the patch is not approved), so an action exists to address.
	ids.actions = newId("act");
	await ctx.db.insert(authorizedActions).values({
		id: ids.actions,
		workspaceId: ownerWorkspaceId,
		patchId: ids.patches,
		repositoryId: ids.repositories,
		kind: "apply",
		status: "refused",
		requestedBy: ownerUserId,
		errorCode: "not_approved",
	});

	// A meeting with one extracted candidate, and the owner's provider connection (never used).
	const meeting = await seedMeeting(owner, ids.repositories);
	ids.meetings = meeting.meetingId;
	candidateId = meeting.candidateId;
	segmentId = meeting.segmentId;
	ids.integrations = newId("int");
	await ctx.db.insert(integrationConnections).values({
		id: ids.integrations,
		workspaceId: ownerWorkspaceId,
		userId: ownerUserId,
		provider: "google",
		status: "active",
		scopes: [],
		accessTokenSealed: "sealed",
	});

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
	const intruderMeeting = await seedMeeting(intruder);
	intruderMeetingId = intruderMeeting.meetingId;
	intruderCandidateId = intruderMeeting.candidateId;
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
	fillPath(
		routePath,
		(collection) => ids[collection] ?? "",
		edgeId,
		candidateId,
	);

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
		"POST /api/v1/evidence/:id/locate": { phrase: "button" },
		"POST /api/v1/patches/:id/approval": {
			decision: "approved",
			verification_id: ids.verifications,
			acknowledged_risks: [],
		},
		"POST /api/v1/patches/:id/actions": { kind: "apply" },
		"PATCH /api/v1/meetings/:id": { title: "taken-over" },
		"PATCH /api/v1/meetings/:id/candidates/:candidateId": {
			title: "taken-over",
		},
		"POST /api/v1/integrations/:id/import": {
			provider_meeting_ref: "conferenceRecords/abc-123/transcripts/tr-1",
			consent_attested: true,
		},
	};
	const upload = key === "POST /api/v1/bug-reports/:id/evidence";
	return {
		url: `${ownerUrl(routePath)}${query[key] ?? ""}`,
		payload: upload
			? screenshotUpload.payload
			: method === "POST" || method === "PATCH"
				? (body[key] ?? {})
				: undefined,
		headers: (upload
			? { "content-type": screenshotUpload.contentType }
			: {}) as Record<string, string>,
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
			const { url, payload, headers } = requestFor(route.method, route.path);
			expectNotFound(
				await intruder(route.method, url, payload, headers),
				`${routeKey(route)} as B's session`,
			);
			const rule = ROUTE_RULES.find((r) => routeKey(r) === routeKey(route));
			if (rule?.access === "session" || rule?.access === "owner") continue;
			expectNotFound(
				await intruderToken(route.method, url, payload, headers),
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

	it("answers 404 to foreign repositories and candidates, and 422 to foreign segments, in meeting requests", async () => {
		const own = `/api/v1/meetings/${intruderMeetingId}`;
		const candidate = `${own}/candidates/${intruderCandidateId}`;
		const foreignRepository = { repository_id: ids.repositories };
		const cases: Array<[Method, string, unknown]> = [
			[
				"POST",
				"/api/v1/meetings",
				{ ...transcriptUpload(), ...foreignRepository },
			],
			["PATCH", own, foreignRepository],
			["PATCH", candidate, foreignRepository],
			["POST", `${candidate}/confirm`, foreignRepository],
			// A candidate and a meeting that belong to different workspaces never pair up.
			["PATCH", `${own}/candidates/${candidateId}`, { title: "x" }],
			[
				"PATCH",
				`/api/v1/meetings/${ids.meetings}/candidates/${intruderCandidateId}`,
				{ title: "x" },
			],
		];
		for (const [method, url, payload] of cases)
			expectNotFound(await intruder(method, url, payload), `${method} ${url}`);
		// A segment of workspace A's meeting is as unknown to B's meeting as any invented one.
		const foreignSegment = await intruder("PATCH", candidate, {
			segment_ids: [segmentId],
		});
		expect(foreignSegment.statusCode).toBe(422);
		expect(foreignSegment.body).not.toContain(segmentId);
	});

	it("lists only the caller's own workspace, whatever the filter", async () => {
		const own = `/api/v1/repositories/${intruderRepoId}`;
		const foreign = [...Object.values(ids), questionId, candidateId, segmentId];
		for (const url of [
			"/api/v1/repositories",
			"/api/v1/bug-reports",
			"/api/v1/meetings",
			"/api/v1/integrations",
			`/api/v1/meetings/${intruderMeetingId}/candidates`,
			`/api/v1/meetings/${intruderMeetingId}/segments`,
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
		const candidates = await get<{
			items: Array<{ id: string; status: string; title: string }>;
		}>(`/api/v1/meetings/${ids.meetings}/candidates`);
		expect(candidates.items.map((c) => [c.id, c.status, c.title])).toEqual([
			[candidateId, "pending_review", EXTRACTION.items[0]?.title],
		]);
		expect(
			(
				await get<{ meeting: { title: string } }>(
					`/api/v1/meetings/${ids.meetings}`,
				)
			).meeting.title,
		).toBe("Checkout standup");
		const connection = await ctx.pool.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM integration_connections WHERE id = $1",
			[ids.integrations],
		);
		expect(connection.rows[0]?.n).toBe(1);
		const actions = await get<{ items: Array<{ id: string; status: string }> }>(
			`/api/v1/patches/${ids.patches}/actions`,
		);
		expect(actions.items.map((a) => [a.id, a.status])).toEqual([
			[ids.actions, "refused"],
		]);
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
