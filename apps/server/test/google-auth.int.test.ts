import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { buildApp } from "../src/api/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import {
	auditEvents,
	sessions,
	users,
	workspaceMembers,
	workspaces,
} from "../src/db/schema.ts";
import { newId } from "../src/lib/ids.ts";
import { SESSION_TTL_SECONDS } from "../src/modules/auth.ts";
import {
	createOwner,
	createTestContext,
	csrf,
	PASSWORD,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";
import {
	closedPortUrl,
	fakeToken,
	googleUser,
	PUBLISHABLE_KEY,
	startSupabaseStub,
} from "./supabase-stub.ts";

// "Continue with Google" end to end: the real app and database, with a local server standing in for
// the Supabase Auth project.

let ctx: TestContext;
let stub: Awaited<ReturnType<typeof startSupabaseStub>>;
let owner: { userId: string; workspaceId: string };
const opened: FastifyInstance[] = [];

beforeAll(async () => {
	ctx = await createTestContext();
	await ctx.app.ready();
	stub = await startSupabaseStub();
});
afterAll(async () => {
	await stub.close();
	await ctx.close();
});
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	owner = await createOwner(ctx.db);
});
afterEach(async () => {
	await Promise.all(opened.splice(0).map((app) => app.close()));
});

type Harness = { app: FastifyInstance; config: Config };

/** A fresh app on the shared database, so each test has its own failed-login budget. */
async function appWith(
	env: Record<string, string> = {},
	logStream?: Writable,
): Promise<Harness> {
	const config = loadConfig({
		NODE_ENV: "test",
		LOG_LEVEL: logStream ? "trace" : "silent",
		DATABASE_URL: ctx.config.databaseUrl,
		TRACERA_DATA_DIR: ctx.config.dataDir,
		TRACERA_SANDBOX_MODE: "disabled",
		SUPABASE_URL: stub.url,
		SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
		...env,
	});
	const app = await buildApp({
		config,
		pool: ctx.pool,
		db: ctx.db,
		boss: ctx.boss,
		...(logStream ? { logStream } : {}),
	});
	await app.ready();
	opened.push(app);
	return { app, config };
}

const signIn = (
	{ app, config }: Harness,
	token: string,
	headers: Record<string, string> = csrf(config),
) =>
	app.inject({
		method: "POST",
		url: "/api/v1/auth/google",
		headers,
		payload: { access_token: token },
	});

const passwordLogin = (
	{ app, config }: Harness,
	email: string,
	password: string,
) =>
	app.inject({
		method: "POST",
		url: "/api/v1/auth/login",
		headers: csrf(config),
		payload: { email, password },
	});

const codeOf = (response: LightMyRequestResponse) =>
	(response.json() as { code?: string }).code;
const cookieOf = (response: LightMyRequestResponse) =>
	String(response.headers["set-cookie"]).split(";")[0] ?? "";
const attributesOf = (response: LightMyRequestResponse) =>
	String(response.headers["set-cookie"]).split("; ").slice(1).join("; ");
const audits = (action: string) =>
	ctx.db.select().from(auditEvents).where(eq(auditEvents.action, action));
const count = async (table: PgTable) =>
	(await ctx.db.select().from(table)).length;

/** The token, in any of the places it could leak to. */
async function everythingStored() {
	return JSON.stringify({
		audit: await ctx.db.select().from(auditEvents),
		users: await ctx.db.select().from(users),
		sessions: await ctx.db.select().from(sessions),
	});
}

describe("GET /api/v1/auth/providers", () => {
	it("tells anyone where to start, without the key", async () => {
		const { app } = await appWith({
			TRACERA_PUBLIC_URL: "http://127.0.0.1:5173",
		});
		const response = await app.inject({
			method: "GET",
			url: "/api/v1/auth/providers",
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			google: {
				enabled: true,
				authorize_url: `${stub.url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent("http://127.0.0.1:5173/auth/callback")}`,
			},
		});
		expect(response.body).not.toContain(PUBLISHABLE_KEY);
	});

	it("answers whatever credentials come with it", async () => {
		const { app } = await appWith();
		const response = await app.inject({
			method: "GET",
			url: "/api/v1/auth/providers",
			headers: {
				authorization: "Bearer not-a-token",
				cookie: "tracera_session=forged",
			},
		});
		expect(response.statusCode).toBe(200);
	});

	it("reports Google as off when the server has no project", async () => {
		const incomplete: Array<Record<string, string>> = [
			{ SUPABASE_URL: "" },
			{ SUPABASE_PUBLISHABLE_KEY: "" },
		];
		for (const env of incomplete) {
			const { app } = await appWith(env);
			const response = await app.inject({
				method: "GET",
				url: "/api/v1/auth/providers",
			});
			expect(response.json()).toEqual({
				google: { enabled: false, authorize_url: null },
			});
		}
	});
});

describe("POST /api/v1/auth/google", () => {
	it("signs in the user who has that email, with the session the password login gives", async () => {
		const token = fakeToken("existing");
		stub.accept(token, googleUser("Owner@Example.com"));
		const h = await appWith();
		const response = await signIn(h, token);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			user: {
				id: owner.userId,
				email: "owner@example.com",
				display_name: "owner",
			},
			workspace: {
				id: owner.workspaceId,
				name: "Default workspace",
				role: "owner",
			},
		});
		expect(String(response.headers["set-cookie"])).toMatch(
			/^tracera_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/,
		);

		const me = await h.app.inject({
			method: "GET",
			url: "/api/v1/auth/me",
			headers: { cookie: cookieOf(response) },
		});
		expect(me.statusCode).toBe(200);
		expect(me.json()).toMatchObject({
			user: { id: owner.userId },
			auth: { type: "session" },
		});

		// Same cookie attributes and lifetime as the password login.
		const viaPassword = await passwordLogin(h, "owner@example.com", PASSWORD);
		expect(attributesOf(response)).toBe(attributesOf(viaPassword));
		const stored = await ctx.db.select().from(sessions);
		expect(stored).toHaveLength(2);
		for (const row of stored) {
			expect(row.workspaceId).toBe(owner.workspaceId);
			expect(
				Math.abs(
					row.expiresAt.getTime() - (Date.now() + SESSION_TTL_SECONDS * 1000),
				),
			).toBeLessThan(60_000);
		}

		expect(await count(users)).toBe(1);
		expect(
			stub.calls.filter((c) => c.authorization === `Bearer ${token}`),
		).toMatchObject([
			{ method: "GET", path: "/auth/v1/user", apikey: PUBLISHABLE_KEY },
			{
				method: "POST",
				path: "/auth/v1/logout?scope=local",
				apikey: PUBLISHABLE_KEY,
			},
		]);
		const succeeded = await audits("auth.login_succeeded");
		// One row for this sign-in and one for the password login above.
		expect(succeeded).toHaveLength(2);
		expect(
			succeeded.find((event) => event.metadata.method === "google"),
		).toMatchObject({
			workspaceId: owner.workspaceId,
			actorType: "user",
			actorId: owner.userId,
			targetType: "user",
			targetId: owner.userId,
			metadata: {
				method: "google",
				ip: "127.0.0.1",
				provider_session_revoked: true,
			},
		});
		for (const place of [
			response.body,
			JSON.stringify(response.headers),
			await everythingStored(),
		])
			expect(place).not.toContain(token);
	});

	it("keeps the existing owner's password working", async () => {
		const token = fakeToken("password-untouched");
		stub.accept(token, googleUser("owner@example.com"));
		const h = await appWith();
		expect((await signIn(h, token)).statusCode).toBe(200);
		expect(
			(await passwordLogin(h, "owner@example.com", PASSWORD)).statusCode,
		).toBe(200);
	});

	it("adds a new email as a member of the default workspace, never as an owner", async () => {
		const token = fakeToken("newcomer");
		stub.accept(token, googleUser("Grace@Example.com", {}));
		const h = await appWith();
		const workspacesBefore = await count(workspaces);
		const response = await signIn(h, token);
		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			user: { id: string; email: string; display_name: string };
			workspace: { id: string; role: string };
		};
		expect(body.user).toMatchObject({
			email: "grace@example.com",
			display_name: "Ada Lovelace",
		});
		expect(body.workspace).toMatchObject({
			id: owner.workspaceId,
			role: "member",
		});
		expect(await count(workspaces)).toBe(workspacesBefore);

		const members = await ctx.db
			.select()
			.from(workspaceMembers)
			.where(eq(workspaceMembers.userId, body.user.id));
		expect(members).toMatchObject([
			{ workspaceId: owner.workspaceId, role: "member" },
		]);
		const me = await h.app.inject({
			method: "GET",
			url: "/api/v1/auth/me",
			headers: { cookie: cookieOf(response) },
		});
		expect(me.json()).toMatchObject({ workspace: { role: "member" } });

		// No password can open this account.
		for (const guess of [
			PASSWORD,
			"password",
			"grace@example.com",
			"a-long-password-guess",
		]) {
			const attempt = await passwordLogin(h, "grace@example.com", guess);
			expect(attempt.statusCode).toBe(401);
			expect(codeOf(attempt)).toBe("invalid_credentials");
		}

		const created = await audits("auth.user_created");
		expect(created).toMatchObject([
			{
				workspaceId: owner.workspaceId,
				actorId: body.user.id,
				targetId: body.user.id,
				metadata: { method: "google", role: "member" },
			},
		]);
		expect(await everythingStored()).not.toContain(token);

		// Signing in again finds the same user.
		const again = await signIn(h, token);
		expect(again.statusCode).toBe(200);
		expect((again.json() as typeof body).user.id).toBe(body.user.id);
		expect(await count(users)).toBe(2);
		expect(await audits("auth.user_created")).toHaveLength(1);
	});

	it("creates one user when the same new email signs in at once", async () => {
		const token = fakeToken("simultaneous");
		stub.accept(token, googleUser("race@example.com"));
		const h = await appWith();
		const responses = await Promise.all([
			signIn(h, token),
			signIn(h, token),
			signIn(h, token),
		]);
		expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
		const ids = new Set(
			responses.map((r) => (r.json() as { user: { id: string } }).user.id),
		);
		expect(ids.size).toBe(1);
		expect(await count(users)).toBe(2);
		expect(await ctx.db.select().from(workspaceMembers)).toHaveLength(2);
		expect(await audits("auth.user_created")).toHaveLength(1);
	});

	it("only lets existing users in when new users are denied", async () => {
		const h = await appWith({ TRACERA_GOOGLE_SIGNIN_NEW_USERS: "deny" });
		const stranger = fakeToken("stranger");
		stub.accept(stranger, googleUser("stranger@example.com"));
		const denied = await signIn(h, stranger);
		expect(denied.statusCode).toBe(403);
		expect(codeOf(denied)).toBe("signin_not_allowed");
		expect(denied.headers["set-cookie"]).toBeUndefined();
		expect(await count(users)).toBe(1);
		expect(await count(sessions)).toBe(0);
		expect(await audits("auth.login_failed")).toMatchObject([
			{ metadata: { method: "google", reason: "signin_not_allowed" } },
		]);

		const member = fakeToken("known");
		stub.accept(member, googleUser("owner@example.com"));
		expect((await signIn(h, member)).statusCode).toBe(200);
	});

	it("refuses a disabled user, a user with no workspace, and a server with no workspace at all", async () => {
		const h = await appWith();
		const token = fakeToken("refused-users");
		stub.accept(token, googleUser("owner@example.com"));
		await ctx.db
			.update(users)
			.set({ disabledAt: new Date() })
			.where(eq(users.id, owner.userId));
		let response = await signIn(h, token);
		expect([response.statusCode, codeOf(response)]).toEqual([
			403,
			"signin_not_allowed",
		]);

		await ctx.db.insert(users).values({
			id: newId("usr"),
			email: "orphan@example.com",
			displayName: "orphan",
			passwordHash: "unusable",
		});
		stub.accept(token, googleUser("orphan@example.com"));
		response = await signIn(h, token);
		expect([response.statusCode, codeOf(response)]).toEqual([
			403,
			"signin_not_allowed",
		]);

		await resetDatabase(ctx.pool);
		stub.accept(token, googleUser("first@example.com"));
		response = await signIn(h, token);
		expect([response.statusCode, codeOf(response)]).toEqual([
			403,
			"signin_not_allowed",
		]);
		expect(await count(users)).toBe(0);
		expect(await count(sessions)).toBe(0);
	});

	const refused: Array<
		[string, (email: string) => object | null, number, string]
	> = [
		[
			"a token the provider does not know",
			() => null,
			401,
			"invalid_provider_token",
		],
		[
			"an account made with an email and a password",
			(email) => googleUser(email, { app_metadata: { provider: "email" } }),
			401,
			"invalid_provider_token",
		],
		[
			"a Google email that Google did not verify",
			(email) => {
				const user = googleUser(email);
				return {
					...user,
					identities: [
						{
							provider: "google",
							identity_data: { email, email_verified: false },
						},
					],
				};
			},
			403,
			"email_not_verified",
		],
		[
			"an account email that was never confirmed",
			(email) => googleUser(email, { email_confirmed_at: null }),
			403,
			"email_not_verified",
		],
		[
			"an account whose Google identity has another email",
			(email) => {
				const user = googleUser(email);
				return {
					...user,
					identities: [
						{
							provider: "google",
							identity_data: {
								email: "other@example.com",
								email_verified: true,
							},
						},
					],
				};
			},
			403,
			"email_not_verified",
		],
	];
	for (const [name, user, status, code] of refused)
		it(`turns away ${name} with ${code}, with no cookie and a failure on record`, async () => {
			const token = fakeToken(name);
			const body = user("owner@example.com");
			if (body) stub.accept(token, body);
			const h = await appWith();
			const logouts = stub.calls.filter((c) =>
				c.path.startsWith("/auth/v1/logout"),
			).length;
			const response = await signIn(h, token);
			expect(response.statusCode).toBe(status);
			expect(codeOf(response)).toBe(code);
			expect(response.headers["content-type"]).toContain(
				"application/problem+json",
			);
			expect(response.headers["set-cookie"]).toBeUndefined();
			expect(response.body).not.toContain(token);
			expect(await count(sessions)).toBe(0);
			expect(await count(users)).toBe(1);
			expect(await audits("auth.login_succeeded")).toHaveLength(0);
			expect(await audits("auth.login_failed")).toMatchObject([
				{
					workspaceId: owner.workspaceId,
					actorType: "system",
					actorId: null,
					metadata: { method: "google", reason: code, ip: "127.0.0.1" },
				},
			]);
			expect(await everythingStored()).not.toContain(token);
			// The provider's session is only ended after a sign-in that worked.
			expect(
				stub.calls.filter((c) => c.path.startsWith("/auth/v1/logout")),
			).toHaveLength(logouts);
		});

	it("reports an unreachable provider as 502 without counting it against the caller", async () => {
		const h = await appWith({ SUPABASE_URL: await closedPortUrl() });
		for (let attempt = 0; attempt < 12; attempt++) {
			const response = await signIn(h, fakeToken(`down-${attempt}`));
			expect(response.statusCode).toBe(502);
			expect(codeOf(response)).toBe("provider_unreachable");
			expect(response.headers["set-cookie"]).toBeUndefined();
		}
		expect(await audits("auth.login_failed")).toHaveLength(0);
		expect(await count(sessions)).toBe(0);
	});

	it("does not offer the route when the server has no project", async () => {
		const incomplete: Array<Record<string, string>> = [
			{ SUPABASE_URL: "" },
			{ SUPABASE_PUBLISHABLE_KEY: "" },
		];
		for (const env of incomplete) {
			const h = await appWith(env);
			const calls = stub.calls.length;
			const response = await signIn(h, fakeToken("unavailable"));
			expect(response.statusCode).toBe(404);
			expect(codeOf(response)).toBe("google_signin_unavailable");
			expect(response.headers["set-cookie"]).toBeUndefined();
			expect(stub.calls).toHaveLength(calls);
		}
		const response = await signIn(
			{ app: ctx.app, config: ctx.config },
			fakeToken("unavailable"),
		);
		expect(codeOf(response)).toBe("google_signin_unavailable");
	});

	const csrfVariants: Array<
		[string, (config: Config) => Record<string, string>]
	> = [
		["no header and no Origin", () => ({})],
		["the header without an Origin", () => ({ "x-tracera-csrf": "1" })],
		["the Origin without the header", (c) => ({ origin: c.api.publicOrigin })],
		[
			"another header value",
			(c) => ({ "x-tracera-csrf": "true", origin: c.api.publicOrigin }),
		],
		[
			"a foreign Origin",
			() => ({ "x-tracera-csrf": "1", origin: "https://evil.example" }),
		],
		[
			"the opaque null Origin",
			() => ({ "x-tracera-csrf": "1", origin: "null" }),
		],
		[
			"an Origin that extends the public one",
			(c) => ({
				"x-tracera-csrf": "1",
				origin: `${c.api.publicOrigin}.evil.example`,
			}),
		],
		[
			"a same-origin Referer but no Origin",
			(c) => ({ "x-tracera-csrf": "1", referer: `${c.api.publicOrigin}/` }),
		],
	];
	for (const [name, headers] of csrfVariants)
		it(`rejects ${name} before it reaches the provider`, async () => {
			const token = fakeToken("csrf");
			stub.accept(token, googleUser("owner@example.com"));
			const h = await appWith();
			const calls = stub.calls.length;
			const response = await signIn(h, token, headers(h.config));
			expect(response.statusCode).toBe(403);
			expect(codeOf(response)).toBe("csrf_failed");
			expect(response.headers["set-cookie"]).toBeUndefined();
			expect(stub.calls).toHaveLength(calls);
			expect(await count(sessions)).toBe(0);
			expect(await audits("auth.login_failed")).toHaveLength(0);
		});

	const invalidBodies: Array<[string, unknown]> = [
		["no body", undefined],
		["an empty object", {}],
		["an empty token", { access_token: "" }],
		["a token that is too short", { access_token: "abc" }],
		["a token with a space", { access_token: "abcdefgh ijklmnopqrstuvwx" }],
		[
			"a token with a line break",
			{ access_token: "abcdefgh\r\nx-injected: abcdefgh" },
		],
		["a token over 4096 characters", { access_token: "a".repeat(4097) }],
		["a token that is not text", { access_token: 1234567890123456 }],
		[
			"a refresh token next to the access token",
			{
				access_token: fakeToken("v"),
				refresh_token: "refresh-canary-abcdefgh",
			},
		],
	];
	for (const [name, payload] of invalidBodies)
		it(`refuses ${name} as invalid without asking the provider`, async () => {
			const h = await appWith();
			const calls = stub.calls.length;
			const response = await h.app.inject({
				method: "POST",
				url: "/api/v1/auth/google",
				headers: csrf(h.config),
				...(payload === undefined ? {} : { payload: payload as object }),
			});
			expect(response.statusCode).toBe(400);
			expect(codeOf(response)).toBe("validation_failed");
			expect(response.headers["set-cookie"]).toBeUndefined();
			expect(response.body).not.toMatch(/injected|canary/);
			expect(stub.calls).toHaveLength(calls);
		});

	it("shares the failed-login budget with the password login and counts only failures", async () => {
		const h = await appWith();
		const good = fakeToken("budget-good");
		stub.accept(good, googleUser("owner@example.com"));
		// Successes never use the budget up.
		for (let i = 0; i < 12; i++)
			expect((await signIn(h, good)).statusCode).toBe(200);

		for (let i = 0; i < 6; i++)
			expect(
				(await passwordLogin(h, "owner@example.com", `wrong-guess-${i}`))
					.statusCode,
			).toBe(401);
		for (let i = 0; i < 4; i++)
			expect((await signIn(h, fakeToken(`budget-bad-${i}`))).statusCode).toBe(
				401,
			);

		const calls = stub.calls.length;
		const limited = await signIn(h, good);
		expect(limited.statusCode).toBe(429);
		expect(codeOf(limited)).toBe("rate_limited");
		expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
		expect(limited.headers["set-cookie"]).toBeUndefined();
		expect(stub.calls).toHaveLength(calls);
		expect(
			(await passwordLogin(h, "owner@example.com", PASSWORD)).statusCode,
		).toBe(429);
	});

	it("marks the cookie Secure when the public address is https", async () => {
		const h = await appWith({ TRACERA_PUBLIC_URL: "https://app.example.com" });
		const token = fakeToken("secure");
		stub.accept(token, googleUser("owner@example.com"));
		const response = await signIn(h, token);
		expect(response.statusCode).toBe(200);
		expect(attributesOf(response)).toMatch(/; Secure$/);
	});

	it("never prints a token, the project key, or a request body in the log", async () => {
		const lines: string[] = [];
		const logStream = new Writable({
			write(chunk, _encoding, callback) {
				lines.push(String(chunk));
				callback();
			},
		});
		const h = await appWith({}, logStream);
		const good = fakeToken("log-good");
		const bad = fakeToken("log-bad");
		const down = fakeToken("log-down");
		stub.accept(good, googleUser("owner@example.com"));
		await signIn(h, good);
		await signIn(h, bad);
		await signIn(
			await appWith({ SUPABASE_URL: await closedPortUrl() }, logStream),
			down,
		);
		const log = lines.join("");
		// The log is being captured, and failures are in it by code only.
		expect(log).toContain("google sign-in failed");
		expect(log).toContain("invalid_provider_token");
		expect(log).toContain("provider_unreachable");
		for (const secret of [good, bad, down, PUBLISHABLE_KEY, "access_token"])
			expect(log, secret).not.toContain(secret);
	});
});
