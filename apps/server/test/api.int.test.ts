import { existsSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dataApiExposure, lockDownDataApi } from "../src/db/migrate.ts";
import { auditEvents, bugReports, evidenceAssets } from "../src/db/schema.ts";
import {
	addMember,
	asSession,
	asToken,
	createOwner,
	createTestContext,
	createToken,
	csrf,
	login,
	makeGitRepo,
	PASSWORD,
	repositoryBody,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

let ctx: TestContext;
let cookie: string;
let session: ReturnType<typeof asSession>;

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	cookie = await login(ctx);
	session = asSession(ctx, cookie);
});

const report = {
	title: "Average order value is wrong",
	description: "Dashboard shows $12.40, expected $24.80.",
};

async function jobCount(
	name: string,
	key: string,
	value: string,
): Promise<number> {
	const result = await ctx.pool.query(
		"select count(*)::int as n from pgboss.job where name = $1 and data->>$2 = $3",
		[name, key, value],
	);
	return result.rows[0].n;
}

describe("health", () => {
	it("reports liveness and readiness without secrets", async () => {
		expect(
			(await ctx.app.inject({ method: "GET", url: "/healthz" })).json(),
		).toEqual({ status: "ok" });
		const ready = await ctx.app.inject({ method: "GET", url: "/readyz" });
		expect(ready.statusCode).toBe(200);
		// The API never calls Docker; sandbox availability comes from worker heartbeats.
		expect(ready.json()).toMatchObject({
			database: "ok",
			blob_store: "ok",
			worker: "not_running",
			sandbox: null,
			inference_mode: "mock",
		});
		expect(ready.body).not.toMatch(/postgres:\/\//);
	});
});

describe("hosted database lockdown", () => {
	it("enables row-level security everywhere and strips Data API roles of table access", async () => {
		// A throwaway stand-in for Supabase's `anon` role; roles are cluster-wide, so it is dropped after.
		const role = `tracera_test_anon_${Date.now().toString(36)}`;
		await ctx.pool.query(`CREATE ROLE ${role} NOLOGIN`);
		try {
			await ctx.pool.query(`GRANT SELECT, INSERT ON public.users TO ${role}`);
			await ctx.pool.query(
				"ALTER TABLE public.audit_events DISABLE ROW LEVEL SECURITY",
			);
			expect(await dataApiExposure(ctx.pool, [role])).toEqual([
				"audit_events",
				"users",
			]);
			const exposed = await ctx.app.inject({ method: "GET", url: "/readyz" });
			expect(exposed.statusCode).toBe(503);
			expect(exposed.json()).toMatchObject({ data_api_exposure: "exposed" });

			await lockDownDataApi(ctx.pool, [role]);
			expect(await dataApiExposure(ctx.pool, [role])).toEqual([]);
			const privilege = await ctx.pool.query(
				"select has_table_privilege($1, 'public.users', 'SELECT') as ok",
				[role],
			);
			expect(privilege.rows[0].ok).toBe(false);
			const ready = await ctx.app.inject({ method: "GET", url: "/readyz" });
			expect(ready.statusCode).toBe(200);
			expect(ready.json()).toMatchObject({ data_api_exposure: "locked_down" });
		} finally {
			await ctx.pool.query(`DROP OWNED BY ${role}`);
			await ctx.pool.query(`DROP ROLE ${role}`);
		}
	});
});

describe("authentication", () => {
	it("sets a protected session cookie on login", async () => {
		const response = await ctx.app.inject({
			method: "POST",
			url: "/api/v1/auth/login",
			headers: csrf(ctx.config),
			payload: { email: "OWNER@example.com", password: PASSWORD },
		});
		expect(response.statusCode).toBe(200);
		const setCookie = String(response.headers["set-cookie"]);
		expect(setCookie).toMatch(/^tracera_session=/);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		expect(response.json().workspace.role).toBe("owner");
	});

	it("returns the same error for an unknown email and a wrong password", async () => {
		for (const payload of [
			{ email: "owner@example.com", password: "wrong-password" },
			{ email: "nobody@example.com", password: PASSWORD },
		]) {
			const response = await ctx.app.inject({
				method: "POST",
				url: "/api/v1/auth/login",
				headers: csrf(ctx.config),
				payload,
			});
			expect(response.statusCode).toBe(401);
			expect(response.json().code).toBe("invalid_credentials");
			expect(response.headers["content-type"]).toContain(
				"application/problem+json",
			);
		}
	});

	it("requires the CSRF header and same origin for cookie-based mutations", async () => {
		const noHeader = await ctx.app.inject({
			method: "POST",
			url: "/api/v1/bug-reports",
			headers: { cookie },
			payload: report,
		});
		expect(noHeader.statusCode).toBe(403);
		expect(noHeader.json().code).toBe("csrf_failed");
		const foreign = await ctx.app.inject({
			method: "POST",
			url: "/api/v1/bug-reports",
			headers: {
				cookie,
				"x-tracera-csrf": "1",
				origin: "https://evil.example",
			},
			payload: report,
		});
		expect(foreign.json().code).toBe("csrf_failed");
	});

	it("rate-limits repeated login attempts", async () => {
		let last = 0;
		for (let i = 0; i < 11; i++) {
			const response = await ctx.app.inject({
				method: "POST",
				url: "/api/v1/auth/login",
				headers: { ...csrf(ctx.config), "x-forwarded-for": "203.0.113.9" },
				remoteAddress: "203.0.113.9",
				payload: { email: "owner@example.com", password: "wrong-password" },
			});
			last = response.statusCode;
		}
		expect(last).toBe(429);
	});

	it("rejects unauthenticated API calls and ends sessions on logout", async () => {
		expect(
			(
				await ctx.app.inject({ method: "GET", url: "/api/v1/bug-reports" })
			).json().code,
		).toBe("unauthenticated");
		expect((await session("GET", "/api/v1/auth/me")).json().user.email).toBe(
			"owner@example.com",
		);
		expect((await session("POST", "/api/v1/auth/logout")).statusCode).toBe(204);
		expect((await session("GET", "/api/v1/auth/me")).statusCode).toBe(401);
	});
});

describe("personal access tokens", () => {
	it("returns the secret once, lists only the prefix, and stops working when revoked", async () => {
		const created = await session("POST", "/api/v1/tokens", {
			name: "laptop",
			client_kind: "mcp",
		});
		expect(created.statusCode).toBe(201);
		const { secret, token } = created.json();
		expect(secret).toMatch(/^trc_pat_[0-9a-f]{64}$/);
		expect(token.scopes).toContain("investigations:write");
		const list = await session("GET", "/api/v1/tokens");
		expect(list.body).not.toContain(secret);
		expect(list.json().items[0].token_prefix).toBe(secret.slice(0, 12));
		expect(
			(await asToken(ctx, secret)("GET", "/api/v1/auth/me")).statusCode,
		).toBe(200);
		expect(
			(await session("DELETE", `/api/v1/tokens/${token.id}`)).statusCode,
		).toBe(204);
		expect(
			(await asToken(ctx, secret)("GET", "/api/v1/auth/me")).statusCode,
		).toBe(401);
	});

	it("refuses token management with a token and enforces scopes", async () => {
		const extension = await createToken(ctx, cookie, {
			name: "ext",
			client_kind: "extension",
		});
		const asExtension = asToken(ctx, extension);
		expect(
			(
				await asExtension("POST", "/api/v1/tokens", {
					name: "x",
					client_kind: "mcp",
				})
			).json().code,
		).toBe("session_required");
		expect((await asExtension("GET", "/api/v1/bug-reports")).json().code).toBe(
			"insufficient_scope",
		);
		const created = await asExtension("POST", "/api/v1/bug-reports", report);
		expect(created.statusCode).toBe(201);
		expect(created.json().bug_report.source_channel).toBe("extension");
	});
});

describe("bug reports", () => {
	it("persists a report with user provenance, audits it, and queues normalization", async () => {
		const response = await session("POST", "/api/v1/bug-reports", {
			...report,
			expected_behavior: "$24.80",
			severity: "high",
			affected_url: "https://shop.example/dashboard?token=abc#x",
		});
		expect(response.statusCode).toBe(201);
		const body = response.json().bug_report;
		expect(body.id).toMatch(/^bug_/);
		expect(body.source_channel).toBe("web");
		expect(body.affected_url).toBe("https://shop.example/dashboard");
		expect(body.field_provenance.expected_behavior.source).toBe(
			"user_provided",
		);
		expect(body.field_provenance.severity.source).toBe("user_provided");
		expect(body.normalization.status).toBe("queued");
		const [row] = await ctx.db
			.select()
			.from(bugReports)
			.where(eq(bugReports.id, body.id));
		expect(row?.title).toBe(report.title);
		const audit = await ctx.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.targetId, body.id));
		expect(audit.map((e) => e.action)).toContain("bug_report.created");
		expect(await jobCount("intake.normalize", "bugReportId", body.id)).toBe(1);
	});

	it("stores text evidence as content-addressed blobs", async () => {
		const response = await session("POST", "/api/v1/bug-reports", {
			...report,
			logs: [
				{
					kind: "stack_trace",
					content: "TypeError: x is undefined\n at metrics.ts:42",
				},
			],
			normalize: false,
		});
		const body = response.json().bug_report;
		expect(body.normalization.status).toBe("not_requested");
		expect(body.evidence).toHaveLength(1);
		expect(body.evidence[0]).toMatchObject({
			kind: "stack_trace",
			origin: "user_provided",
		});
		const [asset] = await ctx.db
			.select()
			.from(evidenceAssets)
			.where(eq(evidenceAssets.bugReportId, body.id));
		const sha = asset?.blobSha256 ?? "";
		expect(
			existsSync(
				path.join(
					ctx.config.dataDir,
					"blobs",
					"sha256",
					sha.slice(0, 2),
					sha.slice(2, 4),
					sha,
				),
			),
		).toBe(true);
	});

	it("replays an idempotent create and rejects key reuse with a different body", async () => {
		const headers = { "idempotency-key": "create-1" };
		const first = await session("POST", "/api/v1/bug-reports", report, headers);
		const second = await session(
			"POST",
			"/api/v1/bug-reports",
			report,
			headers,
		);
		expect(second.statusCode).toBe(201);
		expect(second.json().bug_report.id).toBe(first.json().bug_report.id);
		const reused = await session(
			"POST",
			"/api/v1/bug-reports",
			{ ...report, title: "different" },
			headers,
		);
		expect(reused.statusCode).toBe(409);
		expect(reused.json().code).toBe("idempotency_key_reused");
		expect((await ctx.db.select().from(bugReports)).length).toBe(1);
	});

	it("rejects invalid input with field paths, unknown fields, and unknown repositories", async () => {
		const invalid = await session("POST", "/api/v1/bug-reports", {
			title: "",
			description: "d",
		});
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json().errors[0].path).toBe("title");
		expect(
			(
				await session("POST", "/api/v1/bug-reports", {
					...report,
					command: "rm -rf /",
				})
			).statusCode,
		).toBe(400);
		const unknownRepo = await session("POST", "/api/v1/bug-reports", {
			...report,
			repository_id: "repo_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
		});
		expect(unknownRepo.statusCode).toBe(404);
	});

	it("paginates newest first with a cursor", async () => {
		for (const title of ["one", "two", "three"])
			await session("POST", "/api/v1/bug-reports", {
				...report,
				title,
				normalize: false,
			});
		const first = (await session("GET", "/api/v1/bug-reports?limit=2")).json();
		expect(first.items.map((r: { title: string }) => r.title)).toEqual([
			"three",
			"two",
		]);
		const second = (
			await session(
				"GET",
				`/api/v1/bug-reports?limit=2&cursor=${first.next_cursor}`,
			)
		).json();
		expect(second.items.map((r: { title: string }) => r.title)).toEqual([
			"one",
		]);
		expect(second.next_cursor).toBeNull();
	});

	it("hides other workspaces' reports", async () => {
		const created = (
			await session("POST", "/api/v1/bug-reports", report)
		).json().bug_report;
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		const response = await other("GET", `/api/v1/bug-reports/${created.id}`);
		expect(response.statusCode).toBe(404);
		expect(
			(await other("GET", "/api/v1/bug-reports")).json().items,
		).toHaveLength(0);
	});
});

describe("repositories", () => {
	it("registers a git repository under an allowed root", async () => {
		const repo = makeGitRepo(ctx.repoRoot);
		const response = await session(
			"POST",
			"/api/v1/repositories",
			repositoryBody(repo),
		);
		expect(response.statusCode).toBe(201);
		expect(response.json().repository).toMatchObject({
			name: "demo-app",
			source_type: "local_path",
			default_branch: "main",
		});
		expect(
			(await session("POST", "/api/v1/repositories", repositoryBody(repo)))
				.statusCode,
		).toBe(409);
	});

	it("refuses paths outside the roots, inside Tracera, or without git", async () => {
		const outside = await session(
			"POST",
			"/api/v1/repositories",
			repositoryBody(process.cwd(), "tracera-itself"),
		);
		expect(outside.json().code).toBe("repository_path_not_allowed");
		const notGit = path.join(ctx.repoRoot, "plain");
		await import("node:fs").then((fs) => fs.mkdirSync(notGit));
		expect(
			(
				await session(
					"POST",
					"/api/v1/repositories",
					repositoryBody(notGit, "plain"),
				)
			).json().code,
		).toBe("not_a_git_repository");
	});

	it("allows only owners with a session to register repositories", async () => {
		const { workspaceId } = await createOwner(ctx.db);
		await addMember(ctx.db, workspaceId);
		const member = asSession(ctx, await login(ctx, "member@example.com"));
		const repo = makeGitRepo(ctx.repoRoot);
		expect(
			(
				await member("POST", "/api/v1/repositories", repositoryBody(repo))
			).json().code,
		).toBe("owner_required");
		const token = await createToken(ctx, cookie, {
			name: "mcp",
			client_kind: "mcp",
		});
		expect(
			(
				await asToken(ctx, token)(
					"POST",
					"/api/v1/repositories",
					repositoryBody(repo),
				)
			).json().code,
		).toBe("session_required");
	});
});

describe("investigations", () => {
	async function setup() {
		const repo = makeGitRepo(ctx.repoRoot);
		const repository = (
			await session("POST", "/api/v1/repositories", repositoryBody(repo))
		).json().repository;
		const bug = (
			await session("POST", "/api/v1/bug-reports", {
				...report,
				repository_id: repository.id,
			})
		).json().bug_report;
		return { repository, bug };
	}

	it("creates a queued investigation at a resolved commit and queues the first stage", async () => {
		const { bug } = await setup();
		const response = await session("POST", "/api/v1/investigations", {
			bug_report_id: bug.id,
		});
		expect(response.statusCode).toBe(202);
		const investigation = response.json().investigation;
		// The requested mode is recorded; sandbox availability is decided per stage at run time.
		expect(investigation).toMatchObject({
			status: "queued",
			mode: "full",
			mode_reason: null,
			state_version: 0,
		});
		expect(investigation.commit_sha).toMatch(/^[0-9a-f]{40}$/);
		expect(investigation.inference).toMatchObject({
			provider: "mock",
			mock: true,
		});
		expect(
			(await session("GET", `/api/v1/bug-reports/${bug.id}`)).json().bug_report
				.status,
		).toBe("investigating");
		expect(
			await jobCount(
				"investigation.stage",
				"investigationId",
				investigation.id,
			),
		).toBe(1);
	});

	it("allows one active investigation per bug report", async () => {
		const { bug } = await setup();
		const first = (
			await session("POST", "/api/v1/investigations", { bug_report_id: bug.id })
		).json().investigation;
		const second = await session("POST", "/api/v1/investigations", {
			bug_report_id: bug.id,
		});
		expect(second.statusCode).toBe(409);
		expect(second.json()).toMatchObject({
			code: "investigation_active",
			investigation_id: first.id,
		});
	});

	it("requires a repository and a resolvable commit", async () => {
		const orphan = (await session("POST", "/api/v1/bug-reports", report)).json()
			.bug_report;
		expect(
			(
				await session("POST", "/api/v1/investigations", {
					bug_report_id: orphan.id,
				})
			).json().code,
		).toBe("repository_required");
		const { bug } = await setup();
		const missing = await session("POST", "/api/v1/investigations", {
			bug_report_id: bug.id,
			commit: "no-such-branch",
		});
		expect(missing.json().code).toBe("commit_not_found");
	});

	it("cancels a queued investigation and refuses to retry one that has not failed", async () => {
		const { bug } = await setup();
		const investigation = (
			await session("POST", "/api/v1/investigations", { bug_report_id: bug.id })
		).json().investigation;
		expect(
			(
				await session(
					"POST",
					`/api/v1/investigations/${investigation.id}/retry`,
				)
			).json().code,
		).toBe("invalid_state");
		const cancelled = await session(
			"POST",
			`/api/v1/investigations/${investigation.id}/cancel`,
		);
		expect(cancelled.statusCode).toBe(202);
		expect(cancelled.json().investigation).toMatchObject({
			status: "cancelled",
			state_version: 1,
		});
		expect(
			(
				await session(
					"POST",
					`/api/v1/investigations/${investigation.id}/cancel`,
				)
			).json().code,
		).toBe("invalid_state");
	});

	it("long-polls until the state version changes or the wait expires", async () => {
		const { bug } = await setup();
		const investigation = (
			await session("POST", "/api/v1/investigations", { bug_report_id: bug.id })
		).json().investigation;
		const started = Date.now();
		const response = await session(
			"GET",
			`/api/v1/investigations/${investigation.id}?wait_seconds=1&known_version=0`,
		);
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		expect(response.json().investigation.state_version).toBe(0);
	});
});

describe("audit log", () => {
	it("is append-only at the database level", async () => {
		await session("POST", "/api/v1/bug-reports", report);
		await expect(
			ctx.pool.query("update audit_events set action = 'tampered'"),
		).rejects.toThrow(/append-only/);
		await expect(ctx.pool.query("delete from audit_events")).rejects.toThrow(
			/append-only/,
		);
		const rows = await ctx.db
			.select()
			.from(auditEvents)
			.where(and(eq(auditEvents.action, "bug_report.created")));
		expect(rows).toHaveLength(1);
	});
});
