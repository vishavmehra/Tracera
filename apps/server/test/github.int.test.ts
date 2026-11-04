import { createHmac, type KeyObject, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	GitHubInstallationSchema,
	GitHubRepositoryCandidateSchema,
	GitHubStatusSchema,
	RepositorySyncStatusSchema,
	RepositoryUpdateSchema,
} from "@tracera/contracts";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { buildApp } from "../src/api/app.ts";
import { deliveryMaintenance } from "../src/modules/github.ts";
import { runIndexJob } from "../src/modules/graph.ts";
import { runPatchImpactJob } from "../src/modules/patch-analysis.ts";
import {
	runReconcileJob,
	runSyncJob,
	settleUpdates,
} from "../src/modules/sync.ts";
import { sourceCachePath, sourcesRoot } from "../src/modules/workspace.ts";
import { QUEUES } from "../src/queue.ts";
import {
	API,
	appKey,
	type FakeGitHub,
	fakeGitHub,
	githubEnv,
	remoteRepository,
	USER_CODE,
	WEBHOOK_SECRET,
	WEBHOOKS,
} from "./github-fake.ts";
import {
	addMember,
	asSession,
	createOwner,
	createTestContext,
	login,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

// GitHub App connection, webhooks, and synchronization against a fake GitHub (github-fake.ts):
// fixtures shaped like GitHub's documented responses, JWTs verified as GitHub would, and repository
// content served from local bare repositories. No network and no live credentials: the live install
// and live delivery stay unverified until the App is registered.

const WEBHOOK = "/api/v1/webhooks/github";
const COMMANDS = { install: "npm ci --ignore-scripts", test: "npm test" };
let ctx: TestContext;
let key: { keyPath: string; publicKey: KeyObject };
let fake: FakeGitHub;
let root: string;
let session: ReturnType<typeof asSession>;
const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
const deps = () => ({
	db: ctx.db,
	pool: ctx.pool,
	boss: ctx.boss,
	config: ctx.config,
	github: fake.client,
	log: (message: string, fields: Record<string, unknown>) =>
		logs.push({ message, fields }),
});

beforeAll(async () => {
	key = appKey(mkdtempSync(path.join(tmpdir(), "tracera-github-key-")));
	ctx = await createTestContext(githubEnv(key.keyPath));
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await ctx.pool.query("DELETE FROM pgboss.job WHERE name = ANY($1)", [
		[QUEUES.sync, QUEUES.reconcile, QUEUES.patchImpact],
	]);
	root = mkdtempSync(path.join(tmpdir(), "tracera-github-remote-"));
	fake = fakeGitHub(key.publicKey, root);
	// A fresh app per test: its GitHub client (with its token cache) and rate limiters start empty.
	await ctx.app.close();
	ctx.app = await buildApp({
		config: ctx.config,
		pool: ctx.pool,
		db: ctx.db,
		boss: ctx.boss,
		github: fake.client,
	});
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
	logs.length = 0;
});

async function drain(
	queue: string,
	run: (data: Record<string, string>) => Promise<void>,
): Promise<number> {
	let handled = 0;
	for (;;) {
		const { rows } = await ctx.pool.query<{
			id: string;
			data: Record<string, string>;
		}>(
			"SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' ORDER BY created_on LIMIT 1",
			[queue],
		);
		const job = rows[0];
		if (!job) return handled;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [job.id]);
		await run(job.data);
		handled += 1;
	}
}
const drainSync = () =>
	drain(QUEUES.sync, (data) => runSyncJob(deps(), data.updateId ?? ""));
const drainIndex = () =>
	drain(QUEUES.index, (data) =>
		runIndexJob({ db: ctx.db, config: ctx.config }, data.snapshotId ?? ""),
	);
const syncJobs = async () =>
	(
		await ctx.pool.query(
			"SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state = 'created'",
			[QUEUES.sync],
		)
	).rows[0].n as number;

const sign = (body: string, secret = WEBHOOK_SECRET) =>
	`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function deliver(
	event: string,
	payload: unknown,
	options: { guid?: string; signature?: string; contentType?: string } = {},
) {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
	return ctx.app.inject({
		method: "POST",
		url: WEBHOOK,
		headers: {
			"content-type": options.contentType ?? "application/json",
			"x-github-event": event,
			"x-github-delivery": options.guid ?? randomUUID(),
			"x-hub-signature-256": options.signature ?? sign(body),
		},
		payload: body,
	});
}

const stateFrom = (url: string) => new URL(url).searchParams.get("state") ?? "";

async function connectInstallation(
	as = session,
	installationId = 42,
): Promise<string> {
	const install = await as("GET", "/api/v1/github/install");
	expect(install.statusCode, install.body).toBe(200);
	const callback = await as(
		"GET",
		`/api/v1/github/callback?installation_id=${installationId}&setup_action=install&code=${USER_CODE}&state=${encodeURIComponent(stateFrom(install.json().url))}`,
	);
	expect(callback.statusCode).toBe(302);
	const location = new URL(String(callback.headers.location));
	const id = location.searchParams.get("github_installation");
	expect(id, location.toString()).toMatch(/^ghi_/);
	return id ?? "";
}

async function connectShop(installation: string, as = session) {
	const remote = remoteRepository(root, "acme/shop", {
		"src/cart.js":
			"export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n",
		"src/checkout.js":
			"import { total } from './cart.js';\nexport const charge = (items) => total(items);\n",
	});
	fake.remotes.set("acme/shop", remote.bare);
	const response = await as(
		"POST",
		`/api/v1/github/installations/${installation}/repositories`,
		{ github_repository_id: 7, commands: COMMANDS },
	);
	expect(response.statusCode, response.body).toBe(201);
	return {
		remote,
		repository: response.json().repository,
		update: response.json().update,
	};
}

/** Connects acme/shop and brings it to its first ready snapshot. */
async function connectedShop() {
	const installation = await connectInstallation();
	const shop = await connectShop(installation);
	expect(await drainSync()).toBe(1);
	expect(await drainIndex()).toBe(1);
	await settleUpdates(ctx.db);
	return { installation, ...shop };
}

const profileOf = async (repositoryId: string) =>
	(await session("GET", `/api/v1/repositories/${repositoryId}/profile`)).json();
const deliveriesOf = async () =>
	(
		await ctx.pool.query(
			"SELECT * FROM webhook_deliveries ORDER BY received_at",
		)
	).rows;

describe("GitHub App connection [fixtures, no network]", () => {
	it("reports the App's configuration and its least-privilege check", async () => {
		const status = GitHubStatusSchema.parse(
			(await session("GET", "/api/v1/github/status")).json(),
		);
		expect(status).toMatchObject({
			configured: true,
			missing: [],
			webhook_path: WEBHOOK,
			callback_path: "/api/v1/github/callback",
			required_permissions: { contents: "read", metadata: "read" },
			app: { slug: "tracera-test", problems: [], warnings: [] },
			app_error: null,
			installations: [],
		});
	});

	it("flags an App registered with excess access or without push events", async () => {
		fake.failures.set("GET /app", {
			status: 200,
			headers: {},
			body: {
				...API.app,
				permissions: { contents: "write", metadata: "read", issues: "write" },
				events: ["pull_request"],
			},
		});
		const status = GitHubStatusSchema.parse(
			(await session("GET", "/api/v1/github/status")).json(),
		);
		expect(status.app).toMatchObject({
			problems: ["event_not_subscribed:push"],
			warnings: [
				"excess:contents:write",
				"excess:issues:write",
				"event_not_subscribed:repository",
			],
		});
	});

	it("binds an installation only after GitHub confirms the owner's access", async () => {
		const install = await session("GET", "/api/v1/github/install");
		expect(install.json()).toMatchObject({
			url: expect.stringMatching(
				/^https:\/\/github\.com\/apps\/tracera-test\/installations\/new\?state=/,
			),
			expires_in_seconds: 600,
		});
		const state = encodeURIComponent(stateFrom(install.json().url));
		const errorOf = async (
			query: string,
			as: ReturnType<typeof asSession> = session,
		) => {
			const response = await as("GET", `/api/v1/github/callback?${query}`);
			expect(response.statusCode).toBe(302);
			return new URL(String(response.headers.location)).searchParams.get(
				"github_error",
			);
		};
		// A forged installation ID: installation 77 exists, but this GitHub user cannot access it.
		fake.installations.set(77, { ...API.installation, id: 77 });
		expect(
			await errorOf(`installation_id=77&code=${USER_CODE}&state=${state}`),
		).toBe("github_installation_not_accessible");
		expect(
			await errorOf(`installation_id=42&code=${USER_CODE}&state=${state}x`),
		).toBe("github_state_invalid");
		expect(await errorOf(`installation_id=42&code=${USER_CODE}`)).toBe(
			"github_state_invalid",
		);
		expect(await errorOf(`installation_id=42&state=${state}`)).toBe(
			"github_authorization_required",
		);
		expect(
			await errorOf(`installation_id=42&code=wrong-code&state=${state}`),
		).toBe("github_authorization_failed");
		expect(await errorOf(`installation_id=abc&state=${state}`)).toBe(
			"validation_failed",
		);
		// Another workspace's owner cannot use this owner's state.
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		expect(
			await errorOf(
				`installation_id=42&code=${USER_CODE}&state=${state}`,
				other,
			),
		).toBe("github_state_invalid");
		expect(
			(
				await ctx.pool.query(
					"SELECT count(*)::int AS n FROM github_installations",
				)
			).rows[0].n,
		).toBe(0);

		const id = await connectInstallation();
		const [installation] = (
			await session("GET", "/api/v1/github/installations")
		).json().installations;
		expect(GitHubInstallationSchema.parse(installation)).toMatchObject({
			id,
			installation_id: 42,
			account_login: "acme",
			repository_selection: "selected",
			status: "active",
			permission_problems: [],
			permission_warnings: [],
		});
		// Every user token used for an access check was revoked right away.
		const exchanges = fake.requests.filter((request) =>
			request.url.endsWith("/login/oauth/access_token"),
		);
		const revocations = fake.requests.filter(
			(request) => request.method === "DELETE",
		);
		expect(revocations.length).toBe(
			exchanges.length - 1, // the wrong code produced no token
		);
		const audit = await ctx.pool.query(
			"SELECT actor_type, metadata FROM audit_events WHERE action = 'github.installation_connected'",
		);
		expect(audit.rows).toEqual([
			{
				actor_type: "user",
				metadata: expect.objectContaining({
					installation_id: 42,
					permission_problems: [],
				}),
			},
		]);
		// The installation belongs to this workspace now; the other one cannot claim it.
		const otherInstall = await other("GET", "/api/v1/github/install");
		expect(
			await errorOf(
				`installation_id=42&code=${USER_CODE}&state=${encodeURIComponent(stateFrom(otherInstall.json().url))}`,
				other,
			),
		).toBe("conflict");
		expect(
			(await other("GET", "/api/v1/github/installations")).json().installations,
		).toEqual([]);
		// Only owners connect.
		const { rows } = await ctx.pool.query(
			"SELECT workspace_id FROM github_installations",
		);
		await addMember(ctx.db, rows[0].workspace_id);
		const member = asSession(ctx, await login(ctx, "member@example.com"));
		expect((await member("GET", "/api/v1/github/install")).statusCode).toBe(
			403,
		);
	});

	it("connects a selected repository and indexes it through a repository-scoped, read-only token", async () => {
		const installation = await connectInstallation();
		const listed = await session(
			"GET",
			`/api/v1/github/installations/${installation}/repositories`,
		);
		expect(listed.statusCode).toBe(200);
		expect(
			listed
				.json()
				.repositories.map((candidate: unknown) =>
					GitHubRepositoryCandidateSchema.parse(candidate),
				),
		).toMatchObject([
			{
				github_repository_id: 7,
				full_name: "acme/shop",
				private: true,
				connected_repository_id: null,
			},
			{ github_repository_id: 8, full_name: "acme/docs", archived: true },
		]);

		const { remote, repository, update } = await connectShop(installation);
		expect(repository).toMatchObject({
			source_type: "git_url",
			source_display: "https://github.com/acme/shop",
			default_branch: "main",
			index: null,
			sync: { pending: 1, failed: 0 },
		});
		expect(RepositoryUpdateSchema.parse(update)).toMatchObject({
			trigger: "connect",
			status: "pending",
			ref: "main",
		});
		// GitHub checked the selection: listing used a metadata-only token; the connection minted one for
		// repository 7 only, with read-only contents and metadata.
		expect(
			fake.requests
				.filter((request) => request.url.endsWith("/access_tokens"))
				.map((request) => request.body),
		).toEqual([
			{ permissions: { metadata: "read" } },
			{
				repository_ids: [7],
				permissions: { contents: "read", metadata: "read" },
			},
		]);

		expect(await drainSync()).toBe(1);
		const cache = sourceCachePath(ctx.config, repository.id);
		const cacheConfig = readFileSync(path.join(cache, "config"), "utf8");
		expect(cacheConfig).not.toMatch(/extraheader|remote|ghs_/i);
		expect(existsSync(path.join(cache, "FETCH_HEAD"))).toBe(false);
		expect(await drainIndex()).toBe(1);
		await settleUpdates(ctx.db);
		const profile = await profileOf(repository.id);
		expect(profile.snapshot).toMatchObject({
			status: "ready",
			ref: "main",
			commit_sha: remote.head,
		});
		expect(profile.freshness).toMatchObject({ stale: false, reasons: [] });
		const status = RepositorySyncStatusSchema.parse(
			(
				await session("GET", `/api/v1/repositories/${repository.id}/sync`)
			).json(),
		);
		expect(status).toMatchObject({
			source: "github",
			github: {
				installation,
				full_name: "acme/shop",
				private: true,
				access: "active",
			},
			last_synced_at: expect.any(String),
		});
		expect(status.recent[0]).toMatchObject({
			trigger: "connect",
			status: "indexed",
			indexed_sha: remote.head,
		});
		// The graph of a GitHub repository answers like any other.
		const nodes = (
			await session(
				"GET",
				`/api/v1/repositories/${repository.id}/graph/nodes?q=total`,
			)
		).json().nodes as Array<{ name: string }>;
		expect(nodes.some((node) => node.name === "total")).toBe(true);

		const again = await session(
			"POST",
			`/api/v1/github/installations/${installation}/repositories`,
			{ github_repository_id: 7, name: "shop-2", commands: COMMANDS },
		);
		expect(again.statusCode).toBe(409);
		const denied = await session(
			"POST",
			`/api/v1/github/installations/${installation}/repositories`,
			{ github_repository_id: 999, commands: COMMANDS },
		);
		expect(denied.statusCode).toBe(422);
		expect(denied.json().code).toBe("github_repository_not_accessible");
		expect(
			(
				await session(
					"GET",
					`/api/v1/github/installations/${installation}/repositories`,
				)
			).json().repositories[0].connected_repository_id,
		).toBe(repository.id);
	});

	it("never logs, stores, or writes an installation token anywhere", async () => {
		const { remote, repository } = await connectedShop();
		const pushed = remote.pushMain({
			"src/cart.js": "export const total = () => 0;\n",
		});
		await deliver("push", {
			...WEBHOOKS.push,
			before: remote.head,
			after: pushed,
		});
		// One fetch fails (the remote is gone): failures are logged by code, without credentials.
		fake.remotes.delete("acme/shop");
		await drainSync();
		expect(logs.some((entry) => entry.fields.code === "fetch_failed")).toBe(
			true,
		);
		expect(fake.tokens.length).toBeGreaterThan(0);

		const tables = [
			"audit_events",
			"repository_updates",
			"webhook_deliveries",
			"github_installations",
			"github_repositories",
			"repositories",
			"repository_snapshots",
		];
		let stored = JSON.stringify(logs);
		for (const table of tables)
			stored += (
				await ctx.pool.query(
					`SELECT coalesce(string_agg(t::text, ''), '') AS s FROM ${table} t`,
				)
			).rows[0].s;
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const full = path.join(dir, entry);
				if (statSync(full).isDirectory()) walk(full);
				else files.push(readFileSync(full, "latin1"));
			}
		};
		walk(sourcesRoot(ctx.config));
		for (const secret of [...fake.tokens, API.oauth_token.access_token]) {
			expect(stored).not.toContain(secret);
			expect(
				files.some((content) => content.includes(secret)),
				"source cache",
			).toBe(false);
		}
		expect(process.env.GIT_CONFIG_VALUE_0).toBeUndefined();
		expect(repository.source_display).toBe("https://github.com/acme/shop");
	});
});

describe("webhooks [signed fixtures]", () => {
	it("processes a signed push once, merges repeats, and indexes the pushed commit", async () => {
		const { remote, repository } = await connectedShop();
		const pushed = remote.pushMain({
			"src/cart.js":
				"export function total(items) {\n  return items.length;\n}\n",
		});
		const payload = { ...WEBHOOKS.push, before: remote.head, after: pushed };
		const guid = randomUUID();
		const first = await deliver("push", payload, { guid });
		expect(first.statusCode).toBe(202);
		expect(first.json()).toMatchObject({ status: "processed", reason: null });
		// Until the update runs, the profile says the graph is behind GitHub.
		expect((await profileOf(repository.id)).freshness).toMatchObject({
			stale: true,
			current_commit: pushed,
			reasons: ["update_pending", "ref_moved"],
		});
		// A replay of the same delivery is not processed again.
		const replay = await deliver("push", payload, { guid });
		expect(replay.statusCode).toBe(200);
		expect(replay.json()).toEqual({
			delivery_id: first.json().delivery_id,
			status: "duplicate",
			reason: null,
		});
		// The same push under a new GUID merges into the pending update: still one job.
		expect((await deliver("push", payload)).json().status).toBe("processed");
		const { rows: pending } = await ctx.pool.query(
			"SELECT * FROM repository_updates WHERE repository_id = $1 AND status = 'pending'",
			[repository.id],
		);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({
			trigger: "push",
			target_sha: pushed,
			coalesced: 1,
		});
		expect(await syncJobs()).toBe(1);
		// What the graph does not track is acknowledged and ignored.
		const ignoredReason = async (body: unknown) =>
			(await deliver("push", body)).json().reason;
		expect(
			await ignoredReason({ ...payload, ref: "refs/heads/feature/x" }),
		).toBe("ref_not_tracked");
		expect(
			await ignoredReason({ ...payload, after: "0".repeat(40), deleted: true }),
		).toBe("ref_deleted");
		expect(
			await ignoredReason({
				...payload,
				repository: { ...payload.repository, id: 8, full_name: "acme/docs" },
			}),
		).toBe("repository_not_connected");
		expect(
			await ignoredReason({ ...payload, installation: { id: 4242 } }),
		).toBe("installation_not_connected");

		expect(await drainSync()).toBe(1);
		expect(await drainIndex()).toBe(1);
		await settleUpdates(ctx.db);
		const profile = await profileOf(repository.id);
		expect(profile.snapshot.commit_sha).toBe(pushed);
		expect(profile.freshness).toMatchObject({ stale: false, reasons: [] });
		const status = RepositorySyncStatusSchema.parse(
			(
				await session("GET", `/api/v1/repositories/${repository.id}/sync`)
			).json(),
		);
		expect(status.summary).toMatchObject({
			pending: 0,
			failed: 0,
			failed_deliveries: 0,
			latest_known_commit: pushed,
		});
		expect(status.recent[0]).toMatchObject({
			trigger: "push",
			status: "indexed",
			indexed_sha: pushed,
		});
		expect(
			status.deliveries.recent.map((delivery) => delivery.status),
		).toContain("processed");
	});

	it("refuses unauthenticated, malformed, and oversized deliveries without storing them", async () => {
		await connectInstallation();
		const body = JSON.stringify(WEBHOOKS.push);
		const bad = await deliver("push", body, {
			signature: sign(body, "not-the-webhook-secret-0000"),
		});
		expect(bad.statusCode).toBe(401);
		expect(bad.json().code).toBe("webhook_signature_invalid");
		expect(
			(await deliver("push", body, { signature: "sha256=deadbeef" }))
				.statusCode,
		).toBe(401);
		const unsigned = await ctx.app.inject({
			method: "POST",
			url: WEBHOOK,
			headers: {
				"content-type": "application/json",
				"x-github-event": "push",
				"x-github-delivery": randomUUID(),
			},
			payload: body,
		});
		expect(unsigned.statusCode).toBe(401);
		// A signed-in session is not a substitute for the signature.
		const cookie = await login(ctx);
		const withSession = await ctx.app.inject({
			method: "POST",
			url: WEBHOOK,
			headers: {
				cookie,
				"x-tracera-csrf": "1",
				origin: ctx.config.api.publicOrigin,
				"content-type": "application/json",
				"x-github-event": "push",
				"x-github-delivery": randomUUID(),
			},
			payload: body,
		});
		expect(withSession.statusCode).toBe(401);
		const noHeaders = await ctx.app.inject({
			method: "POST",
			url: WEBHOOK,
			headers: {
				"content-type": "application/json",
				"x-hub-signature-256": sign(body),
			},
			payload: body,
		});
		expect(noHeaders.statusCode).toBe(400);
		expect(
			(
				await deliver("push", body, {
					contentType: "application/x-www-form-urlencoded",
				})
			).statusCode,
		).toBe(415);
		const oversized = await deliver(
			"push",
			JSON.stringify({
				...WEBHOOKS.push,
				padding: "x".repeat(5 * 1024 * 1024),
			}),
		);
		expect(oversized.statusCode).toBe(413);
		expect(oversized.json().code).toBe("payload_too_large");
		expect(await deliveriesOf()).toHaveLength(0);
		// An address that keeps failing the signature check is throttled.
		for (let attempt = 0; attempt < 30; attempt++)
			await deliver("push", body, {
				signature: sign(body, "attacker-secret-00000000"),
			});
		const throttled = await deliver("push", body);
		expect(throttled.statusCode).toBe(429);
		expect(await deliveriesOf()).toHaveLength(0);
	});

	it("acknowledges unknown events and records invalid payloads as failed, without retries", async () => {
		await connectInstallation();
		const star = await deliver("star", {
			action: "created",
			installation: { id: 42 },
		});
		expect(star.statusCode).toBe(202);
		expect(star.json()).toMatchObject({
			status: "ignored",
			reason: "event_not_handled",
		});
		expect((await deliver("ping", WEBHOOKS.ping)).json()).toMatchObject({
			status: "ignored",
			reason: "ping",
		});
		const broken = await deliver("push", {
			...WEBHOOKS.push,
			after: "not-a-commit",
		});
		expect(broken.statusCode).toBe(400);
		expect(broken.json()).toMatchObject({
			code: "webhook_payload_invalid",
			delivery_id: expect.stringMatching(/^whd_/),
		});
		const failed = (await deliveriesOf()).find(
			(row) => row.status === "failed",
		);
		expect(failed).toMatchObject({
			event: "push",
			error: { code: "webhook_payload_invalid", retryable: false },
			next_attempt_at: null,
			workspace_id: expect.stringMatching(/^wsp_/),
		});
		expect(JSON.stringify(failed?.summary)).not.toContain("not-a-commit");
	});

	it("records a failed delivery with its retry state and processes it on retry", async () => {
		const { remote, repository } = await connectedShop();
		const pushed = remote.pushMain({
			"src/cart.js": "export const total = () => 1;\n",
		});
		const payload = { ...WEBHOOKS.push, before: remote.head, after: pushed };
		const guid = randomUUID();
		const send = vi
			.spyOn(ctx.boss, "send")
			.mockRejectedValueOnce(new Error("queue unavailable"));
		const failed = await deliver("push", payload, { guid });
		send.mockRestore();
		expect(failed.statusCode).toBe(500);
		expect(failed.json().code).toBe("webhook_processing_failed");
		const [row] = await deliveriesOf();
		expect(row).toMatchObject({
			status: "failed",
			attempts: 1,
			repository_id: repository.id,
			error: { code: "webhook_processing_failed", retryable: true },
		});
		expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
		// Nothing was half done: the failed processing left no update behind.
		expect(
			(
				await ctx.pool.query(
					"SELECT count(*)::int AS n FROM repository_updates WHERE trigger = 'push'",
				)
			).rows[0].n,
		).toBe(0);
		const view = (
			await session("GET", `/api/v1/repositories/${repository.id}`)
		).json().repository;
		expect(view.sync).toMatchObject({ failed_deliveries: 1 });
		const status = RepositorySyncStatusSchema.parse(
			(
				await session("GET", `/api/v1/repositories/${repository.id}/sync`)
			).json(),
		);
		expect(status.deliveries.failed[0]).toMatchObject({
			delivery_guid: guid,
			event: "push",
			attempts: 1,
			error: { code: "webhook_processing_failed" },
		});

		// Not due yet: maintenance leaves it alone; once due, it is processed.
		expect(await deliveryMaintenance(deps())).toBe(0);
		await ctx.pool.query(
			"UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'",
		);
		expect(await deliveryMaintenance(deps())).toBe(1);
		const [retried] = await deliveriesOf();
		expect(retried).toMatchObject({
			status: "processed",
			attempts: 2,
			error: null,
		});
		expect(
			(await session("GET", `/api/v1/repositories/${repository.id}`)).json()
				.repository.sync,
		).toMatchObject({ failed_deliveries: 0, pending: 1 });
		// GitHub redelivering it now is a duplicate.
		expect((await deliver("push", payload, { guid })).json().status).toBe(
			"duplicate",
		);
		expect(await drainSync()).toBe(1);
	});

	it("keeps every delivery inside the workspace that connected its installation", async () => {
		const { repository } = await connectedShop();
		// A second workspace connects its own installation (99) and the same GitHub repository ID.
		fake.installations.set(99, { ...API.installation, id: 99 });
		fake.userInstallations.push(99);
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		const otherInstallation = await connectInstallation(other, 99);
		const connected = await other(
			"POST",
			`/api/v1/github/installations/${otherInstallation}/repositories`,
			{ github_repository_id: 7, commands: COMMANDS },
		);
		expect(connected.statusCode).toBe(201);
		const theirs = connected.json().repository;
		const before = await syncJobs();
		const pushFor = (installation: number) =>
			deliver("push", {
				...WEBHOOKS.push,
				installation: { id: installation },
				after: "5".repeat(40),
			});
		const pendingOf = async (repositoryId: string) =>
			(
				await ctx.pool.query(
					"SELECT trigger, target_sha, coalesced FROM repository_updates WHERE repository_id = $1 AND status = 'pending'",
					[repositoryId],
				)
			).rows;
		await pushFor(42);
		expect(await pendingOf(repository.id)).toEqual([
			{ trigger: "push", target_sha: "5".repeat(40), coalesced: 0 },
		]);
		// The other workspace's pending connection update is untouched.
		expect(await pendingOf(theirs.id)).toEqual([
			{ trigger: "connect", target_sha: null, coalesced: 0 },
		]);
		await pushFor(99);
		expect(await pendingOf(theirs.id)).toEqual([
			{ trigger: "connect", target_sha: "5".repeat(40), coalesced: 1 },
		]);
		expect(await pendingOf(repository.id)).toHaveLength(1);
		expect(await syncJobs()).toBe(before + 1);
		// Neither owner reaches the other's installation, repositories, or sync state.
		for (const [as, installation, repo] of [
			[other, "", repository.id],
			[session, otherInstallation, theirs.id],
		] as const) {
			if (installation)
				expect(
					(
						await as(
							"GET",
							`/api/v1/github/installations/${installation}/repositories`,
						)
					).statusCode,
				).toBe(404);
			expect(
				(await as("GET", `/api/v1/repositories/${repo}/sync`)).statusCode,
			).toBe(404);
			expect(
				(await as("POST", `/api/v1/repositories/${repo}/sync`)).statusCode,
			).toBe(404);
		}
		const deliveries = await deliveriesOf();
		expect(new Set(deliveries.map((row) => row.workspace_id)).size).toBe(2);
	});
});

describe("permission checks and installation changes [signed fixtures]", () => {
	it("stops listing, connecting, and syncing when required permissions are withdrawn", async () => {
		const { installation, remote, repository } = await connectedShop();
		const downgraded = {
			...WEBHOOKS.installation,
			installation: {
				...WEBHOOKS.installation.installation,
				permissions: { metadata: "read" },
			},
		};
		expect((await deliver("installation", downgraded)).json()).toMatchObject({
			status: "processed",
		});
		const [view] = (await session("GET", "/api/v1/github/installations")).json()
			.installations;
		expect(view.permission_problems).toEqual(["missing:contents:read"]);
		const listing = await session(
			"GET",
			`/api/v1/github/installations/${installation}/repositories`,
		);
		expect(listing.statusCode).toBe(422);
		expect(listing.json().code).toBe("github_permission_missing");
		// A sync checks permissions before minting a token or fetching anything.
		const minted = fake.tokens.length;
		const pushed = remote.pushMain({ "src/new.js": "export const n = 1;\n" });
		await deliver("push", { ...WEBHOOKS.push, after: pushed });
		await drainSync();
		expect(fake.tokens.length).toBe(minted);
		const status = RepositorySyncStatusSchema.parse(
			(
				await session("GET", `/api/v1/repositories/${repository.id}/sync`)
			).json(),
		);
		expect(status.failed[0]?.error).toMatchObject({
			code: "github_permission_missing",
		});
		// The webhook said the ref moved, and the fetch failed: answers would disclose a stale graph.
		expect(status.freshness).toMatchObject({
			stale: true,
			current_commit: pushed,
			reasons: ["update_failed", "ref_moved"],
		});
		// Restoring the permission brings syncing back.
		expect(
			(await deliver("installation", WEBHOOKS.installation)).json().status,
		).toBe("processed");
		expect(
			(await session("POST", `/api/v1/repositories/${repository.id}/sync`))
				.statusCode,
		).toBe(202);
		await drainSync();
		await drainIndex();
		await settleUpdates(ctx.db);
		expect((await profileOf(repository.id)).snapshot.commit_sha).toBe(pushed);
	});

	it("follows suspension, repository removal, and uninstallation", async () => {
		const { repository } = await connectedShop();
		const event = (action: string) => ({ ...WEBHOOKS.installation, action });
		const access = async () =>
			RepositorySyncStatusSchema.parse(
				(
					await session("GET", `/api/v1/repositories/${repository.id}/sync`)
				).json(),
			).github?.access;

		expect(
			(await deliver("installation", event("suspend"))).json().status,
		).toBe("processed");
		expect(await access()).toBe("installation_suspended");
		expect((await deliver("push", WEBHOOKS.push)).json()).toMatchObject({
			status: "ignored",
			reason: "installation_suspended",
		});
		await session("POST", `/api/v1/repositories/${repository.id}/sync`);
		await drainSync();
		expect(
			(
				await ctx.pool.query(
					"SELECT error FROM repository_updates WHERE trigger = 'manual'",
				)
			).rows[0].error,
		).toMatchObject({ code: "github_installation_suspended" });
		expect(
			(await deliver("installation", event("unsuspend"))).json().status,
		).toBe("processed");
		expect(await access()).toBe("active");

		const removed = await deliver(
			"installation_repositories",
			WEBHOOKS.installation_repositories,
		);
		expect(removed.json()).toMatchObject({ status: "processed" });
		expect(await access()).toBe("repository_removed");
		expect((await deliver("push", WEBHOOKS.push)).json().reason).toBe(
			"repository_access_removed",
		);
		// Reconciliation does not poll a repository it may no longer read.
		expect(await runReconcileJob(deps())).toMatchObject({
			skipped: 1,
			requested: 0,
		});
		const restored = await deliver("installation_repositories", {
			...WEBHOOKS.installation_repositories,
			action: "added",
			repositories_added:
				WEBHOOKS.installation_repositories.repositories_removed,
			repositories_removed: [],
		});
		expect(restored.json().status).toBe("processed");
		expect(await access()).toBe("active");

		expect(
			(await deliver("installation", event("deleted"))).json().status,
		).toBe("processed");
		expect(await access()).toBe("installation_removed");
		const [installation] = (
			await session("GET", "/api/v1/github/installations")
		).json().installations;
		expect(installation.status).toBe("removed");
		const actions = (
			await ctx.pool.query(
				"SELECT action FROM audit_events WHERE action LIKE 'github.%' ORDER BY created_at",
			)
		).rows.map((row) => row.action);
		expect(actions).toEqual([
			"github.installation_connected",
			"github.installation_suspend",
			"github.installation_unsuspend",
			"github.repository_access_changed",
			"github.repository_access_changed",
			"github.installation_deleted",
		]);
	});
});

describe("branches, pull requests, and reconciliation", () => {
	it("follows a default-branch change only when Tracera tracked the old default", async () => {
		const { remote, repository } = await connectedShop();
		remote.publishBranch("trunk");
		const changed = await deliver("repository", WEBHOOKS.repository);
		expect(changed.json()).toMatchObject({ status: "processed" });
		expect(
			(await session("GET", `/api/v1/repositories/${repository.id}`)).json()
				.repository.default_branch,
		).toBe("trunk");
		const { rows } = await ctx.pool.query(
			"SELECT trigger, ref, status FROM repository_updates WHERE trigger = 'default_branch'",
		);
		expect(rows).toEqual([
			{ trigger: "default_branch", ref: "trunk", status: "pending" },
		]);
		expect(await drainSync()).toBe(1);
		// The old default was main; Tracera now tracks trunk, so a repeat of the event does not apply.
		expect(
			(await deliver("repository", WEBHOOKS.repository)).json(),
		).toMatchObject({
			status: "ignored",
			reason: "default_branch_customized",
		});
		expect(
			(
				await deliver("repository", {
					...WEBHOOKS.repository,
					action: "archived",
				})
			).json().reason,
		).toBe("action_not_handled");
		// A rename on GitHub is followed (fetches do not follow redirects), and syncing keeps working.
		const renamed = await deliver("repository", {
			...WEBHOOKS.repository,
			action: "renamed",
			repository: {
				...WEBHOOKS.repository.repository,
				full_name: "acme/storefront",
			},
		});
		expect(renamed.json()).toMatchObject({ status: "processed" });
		expect(
			(await session("GET", `/api/v1/repositories/${repository.id}`)).json()
				.repository.source_display,
		).toBe("https://github.com/acme/storefront");
		fake.remotes.set("acme/storefront", remote.bare);
		fake.remotes.delete("acme/shop");
		expect(
			(await session("POST", `/api/v1/repositories/${repository.id}/sync`))
				.statusCode,
		).toBe(202);
		await drainSync();
		const [latest] = (
			await ctx.pool.query(
				"SELECT status, error FROM repository_updates WHERE trigger = 'manual'",
			)
		).rows;
		expect(latest.error).toBeNull();
		expect(["indexing", "indexed"]).toContain(latest.status);
	});

	it("analyses pull requests with patch impact instead of replacing the current snapshot", async () => {
		const { remote, repository } = await connectedShop();
		const head = remote.openPullRequest(5, {
			"src/cart.js":
				"export function total(items) {\n  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n}\n",
		});
		const opened = {
			...WEBHOOKS.pull_request,
			pull_request: {
				...WEBHOOKS.pull_request.pull_request,
				head: { ...WEBHOOKS.pull_request.pull_request.head, sha: head },
			},
		};
		expect((await deliver("pull_request", opened)).json()).toMatchObject({
			status: "processed",
		});
		const [update] = (
			await ctx.pool.query(
				"SELECT * FROM repository_updates WHERE trigger = 'pull_request'",
			)
		).rows;
		expect(update).toMatchObject({
			ref: "refs/pull/5/head",
			target_sha: head,
			pull_request: { number: 5, base_ref: "main" },
		});
		expect(await drainSync()).toBe(1);
		const [analysis] = (
			await ctx.pool.query(
				"SELECT * FROM patch_analyses WHERE repository_id = $1",
				[repository.id],
			)
		).rows;
		expect(analysis).toMatchObject({
			base_ref: "main",
			head_ref: "refs/pull/5/head",
			head_sha: head,
			merge_base: true,
			status: "queued",
		});
		const audit = await ctx.pool.query(
			"SELECT actor_type FROM audit_events WHERE action = 'patch_impact.requested'",
		);
		expect(audit.rows).toEqual([{ actor_type: "worker" }]);
		await runPatchImpactJob({ db: ctx.db, config: ctx.config }, analysis.id);
		await settleUpdates(ctx.db);
		const [settled] = (
			await ctx.pool.query(
				"SELECT status, patch_analysis_id, indexed_sha FROM repository_updates WHERE trigger = 'pull_request'",
			)
		).rows;
		expect(settled).toEqual({
			status: "indexed",
			patch_analysis_id: analysis.id,
			indexed_sha: head,
		});
		const result = (
			await session("GET", `/api/v1/patch-impact/${analysis.id}`)
		).json().analysis;
		expect(["completed", "partial"]).toContain(result.status);
		expect(
			(result.result.symbols as Array<{ name: string }>).some(
				(symbol) => symbol.name === "total",
			),
		).toBe(true);
		// The repository's current snapshot is still the default branch's.
		expect((await profileOf(repository.id)).snapshot.commit_sha).toBe(
			remote.head,
		);
		expect(
			(await deliver("pull_request", { ...opened, action: "closed" })).json()
				.reason,
		).toBe("action_not_handled");
	});

	it("reconciles a GitHub repository from the API when a delivery was missed", async () => {
		const { remote, repository } = await connectedShop();
		expect(await runReconcileJob(deps())).toMatchObject({
			checked: 1,
			requested: 0,
		});
		// A push whose webhook never arrived.
		const missed = remote.pushMain({
			"src/missed.js": "export const m = 1;\n",
		});
		expect(await runReconcileJob(deps())).toMatchObject({ requested: 1 });
		expect(
			fake.requests.some((request) =>
				request.url.endsWith("/repos/acme/shop/git/ref/heads/main"),
			),
		).toBe(true);
		expect((await profileOf(repository.id)).freshness).toMatchObject({
			stale: true,
			current_commit: missed,
		});
		expect(await runReconcileJob(deps())).toMatchObject({ requested: 0 });
		expect(await drainSync()).toBe(1);
		expect(await drainIndex()).toBe(1);
		await settleUpdates(ctx.db);
		expect((await profileOf(repository.id)).snapshot.commit_sha).toBe(missed);
		expect(await runReconcileJob(deps())).toMatchObject({
			checked: 1,
			requested: 0,
		});
		// GitHub being unavailable is a failed check, never a guess.
		fake.failures.set("GET /repos/acme/shop/git/ref/heads/main", {
			status: 503,
			headers: {},
			body: null,
		});
		expect(await runReconcileJob(deps())).toMatchObject({
			failed: 1,
			requested: 0,
		});
		expect(
			logs.some((entry) => entry.fields.code === "github_unavailable"),
		).toBe(true);
	});
});

describe("without the GitHub App", () => {
	it("answers capability_unavailable on every GitHub endpoint and says what is missing", async () => {
		const plain = await createTestContext();
		try {
			await createOwner(plain.db, "plain@example.com");
			const as = asSession(plain, await login(plain, "plain@example.com"));
			const status = GitHubStatusSchema.parse(
				(await as("GET", "/api/v1/github/status")).json(),
			);
			expect(status).toMatchObject({
				configured: false,
				app: null,
				missing: [
					"TRACERA_GITHUB_APP_ID",
					"TRACERA_GITHUB_APP_PRIVATE_KEY_PATH",
					"TRACERA_GITHUB_WEBHOOK_SECRET",
					"TRACERA_GITHUB_CLIENT_ID",
					"TRACERA_GITHUB_CLIENT_SECRET",
				],
			});
			const id = `ghi_${"0".repeat(26)}`;
			for (const [method, url, body] of [
				["GET", "/api/v1/github/install", undefined],
			] as const) {
				const response = await as(method, url, body);
				expect(response.statusCode, url).toBe(409);
				expect(response.json().code).toBe("capability_unavailable");
			}
			// Routes that name an installation check the workspace first: nothing exists to find.
			for (const [method, url, body] of [
				["GET", `/api/v1/github/installations/${id}/repositories`, undefined],
				[
					"POST",
					`/api/v1/github/installations/${id}/repositories`,
					{ github_repository_id: 7, commands: COMMANDS },
				],
			] as const) {
				const response = await as(method, url, body);
				expect(response.statusCode, url).toBe(404);
				expect(response.json().code).toBe("not_found");
			}
			const callback = await as(
				"GET",
				"/api/v1/github/callback?installation_id=42&code=x&state=y",
			);
			expect(
				new URL(String(callback.headers.location)).searchParams.get(
					"github_error",
				),
			).toBe("capability_unavailable");
			const body = JSON.stringify(WEBHOOKS.push);
			const webhook = await plain.app.inject({
				method: "POST",
				url: WEBHOOK,
				headers: {
					"content-type": "application/json",
					"x-github-event": "push",
					"x-github-delivery": randomUUID(),
					"x-hub-signature-256": sign(body),
				},
				payload: body,
			});
			// The public endpoint reveals nothing about the configuration.
			expect(webhook.statusCode).toBe(404);
			expect(webhook.json().code).toBe("not_found");
			expect(webhook.body).not.toContain("TRACERA_GITHUB");
		} finally {
			await plain.close();
		}
	});
});
