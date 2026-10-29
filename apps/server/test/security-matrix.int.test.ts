import { request } from "node:http";
import { SCOPE_PRESETS, type Scope, ScopeSchema } from "@tracera/contracts";
import { and, eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	apiTokens,
	bugReports,
	sessions,
	users,
	workspaceMembers,
} from "../src/db/schema.ts";
import { sha256Hex } from "../src/lib/crypto.ts";
import { newId } from "../src/lib/ids.ts";
import {
	addMember,
	createOwner,
	createTestContext,
	createToken,
	csrf,
	login,
	PASSWORD,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";
import {
	COLLECTION_PREFIX,
	fillPath,
	isMutating,
	isScope,
	ROUTE_RULES,
	type RouteRule,
	registeredRoutes,
	routeKey,
} from "./security-routes.ts";

// Authentication, session-only routes, token scopes, owner-only routes, and CSRF, checked over
// every registered route.
// IDs in paths are well-formed but unknown: every check here happens before a route reads its ID.

let ctx: TestContext;
let workspaceId: string;
let ownerCookie: string;
let memberCookie: string;

beforeAll(async () => {
	ctx = await createTestContext();
	await ctx.app.ready();
	await resetDatabase(ctx.pool);
	({ workspaceId } = await createOwner(ctx.db));
	await addMember(ctx.db, workspaceId);
	ownerCookie = await login(ctx);
	memberCookie = await login(ctx, "member@example.com");
});
afterAll(async () => ctx.close());

const SCOPES = ScopeSchema.options;
const protectedRoutes = ROUTE_RULES.filter(
	(rule) => rule.access !== "public" && rule.access !== "login",
);
const sessionOnly = ROUTE_RULES.filter(
	(rule) => rule.access === "session" || rule.access === "owner",
);
const scoped = ROUTE_RULES.filter((rule) => isScope(rule.access));
const LOGOUT = "POST /api/v1/auth/logout";

/** Valid request bodies, so a refusal is never a validation error in disguise. */
const BODY: Record<string, unknown> = {
	"POST /api/v1/auth/login": { email: "owner@example.com", password: PASSWORD },
	"POST /api/v1/tokens": {
		name: "matrix",
		client_kind: "script",
		scopes: ["reports:read"],
	},
	"POST /api/v1/patches/:id/approval": {
		decision: "rejected",
		verification_id: newId("ver"),
	},
	"POST /api/v1/repositories": {
		name: "matrix-repo",
		source: { type: "local_path", path: "/nowhere/matrix-repo" },
		commands: { install: "npm ci --ignore-scripts", test: "npm test" },
	},
	"PATCH /api/v1/repositories/:id": { name: "renamed" },
	"POST /api/v1/repositories/:id/impact": {
		targets: [{ kind: "file", path: "src/index.js" }],
	},
	"POST /api/v1/repositories/:id/stack-traces/map": {
		trace: "TypeError: x is undefined\n    at f (src/index.js:1:1)",
	},
	"POST /api/v1/repositories/:id/assessments": {
		request: "Add a discount code field to checkout",
	},
	"POST /api/v1/repositories/:id/questions": {
		question: "Where is shipping computed?",
	},
	"POST /api/v1/repositories/:id/patch-impact": {
		base: "main",
		head: "feature",
	},
	"POST /api/v1/investigations": { bug_report_id: newId("bug") },
	"POST /api/v1/bug-reports": {
		title: "Matrix report",
		description: "Created by the security matrix",
		normalize: false,
	},
};

type Credentials = {
	cookie?: string;
	token?: string;
	headers?: Record<string, string>;
};

function call(
	rule: RouteRule,
	credentials: Credentials = {},
	url = fillPath(rule.path, (collection) =>
		newId(COLLECTION_PREFIX[collection] ?? "usr"),
	),
) {
	return ctx.app.inject({
		method: rule.method,
		url,
		headers: {
			...(credentials.cookie ? { cookie: credentials.cookie } : {}),
			...(credentials.token
				? { authorization: `Bearer ${credentials.token}` }
				: {}),
			...credentials.headers,
		},
		...(rule.method === "POST" || rule.method === "PATCH"
			? { payload: (BODY[routeKey(rule)] ?? {}) as object }
			: {}),
	});
}

/** The problem `code`, or undefined for an empty or non-JSON body. */
function codeOf(response: LightMyRequestResponse): string | undefined {
	try {
		return (response.json() as { code?: string }).code;
	} catch {
		return undefined;
	}
}

const label = (rule: RouteRule, variant: string) =>
	`${routeKey(rule)} with ${variant}`;
const mutationHeaders = (rule: RouteRule) =>
	isMutating(rule) ? csrf(ctx.config) : {};

async function scriptToken(name: string, scopes: readonly Scope[]) {
	return createToken(ctx, ownerCookie, {
		name,
		client_kind: "script",
		scopes,
	});
}

async function tokenId(secret: string) {
	const [row] = await ctx.db
		.select({ id: apiTokens.id })
		.from(apiTokens)
		.where(eq(apiTokens.tokenHash, sha256Hex(secret)));
	if (!row) throw new Error("token not stored");
	return row.id;
}

const sessionValue = (cookie: string) =>
	decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));

describe("route inventory", () => {
	it("knows the access rule of every registered route", () => {
		expect(registeredRoutes(ctx.app)).toEqual(ROUTE_RULES.map(routeKey).sort());
	});
});

describe("authentication", () => {
	it("answers 401 unauthenticated on every protected route without valid credentials", async () => {
		const valid = await scriptToken("valid", SCOPES);
		const revoked = await scriptToken("revoked", SCOPES);
		const revokedResponse = await ctx.app.inject({
			method: "DELETE",
			url: `/api/v1/tokens/${await tokenId(revoked)}`,
			headers: { cookie: ownerCookie, ...csrf(ctx.config) },
		});
		expect(revokedResponse.statusCode).toBe(204);
		const expired = await scriptToken("expired", SCOPES);
		await ctx.db
			.update(apiTokens)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(apiTokens.tokenHash, sha256Hex(expired)));
		const expiredCookie = await login(ctx);
		await ctx.db
			.update(sessions)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(sessions.tokenHash, sha256Hex(sessionValue(expiredCookie))));

		const variants: Array<[string, Credentials]> = [
			["no credentials", {}],
			["a malformed bearer token", { headers: { authorization: "Bearer x" } }],
			["an unknown token", { token: `trc_pat_${"0".repeat(64)}` }],
			["a revoked token", { token: revoked }],
			["an expired token", { token: expired }],
			[
				"a valid token followed by more text",
				{ headers: { authorization: `Bearer ${valid} extra` } },
			],
			[
				"Basic credentials",
				{
					headers: {
						authorization: `Basic ${Buffer.from(`owner@example.com:${PASSWORD}`).toString("base64")}`,
					},
				},
			],
			["an unknown session cookie", { cookie: "tracera_session=forged" }],
			["an expired session", { cookie: expiredCookie }],
			// A bad bearer token never falls back to a valid cookie sent alongside it.
			[
				"an unknown token next to a valid session cookie",
				{ cookie: ownerCookie, token: `trc_pat_${"1".repeat(64)}` },
			],
		];
		for (const rule of protectedRoutes)
			for (const [variant, credentials] of variants) {
				const response = await call(rule, {
					...credentials,
					headers: { ...mutationHeaders(rule), ...credentials.headers },
				});
				expect(response.statusCode, label(rule, variant)).toBe(401);
				expect(codeOf(response), label(rule, variant)).toBe("unauthenticated");
				expect(response.headers["content-type"]).toContain(
					"application/problem+json",
				);
			}
	});

	it("serves the health routes without credentials", async () => {
		for (const rule of ROUTE_RULES.filter((r) => r.access === "public")) {
			const response = await call(rule);
			expect([200, 503], routeKey(rule)).toContain(response.statusCode);
		}
	});

	it("ends access when a member leaves the workspace", async () => {
		const former = await addMember(ctx.db, workspaceId, "former@example.com");
		const cookie = await login(ctx, "former@example.com");
		const token = await createToken(ctx, cookie, {
			name: "former",
			client_kind: "mcp",
		});
		const me = (credentials: Credentials) =>
			call(
				{ method: "GET", path: "/api/v1/auth/me", access: "any" },
				credentials,
			);
		expect((await me({ cookie })).statusCode).toBe(200);
		expect((await me({ token })).statusCode).toBe(200);
		await ctx.db
			.delete(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					eq(workspaceMembers.userId, former),
				),
			);
		expect((await me({ cookie })).statusCode).toBe(401);
		expect((await me({ token })).statusCode).toBe(401);
		// The account itself still exists; only the membership is gone.
		expect(
			await ctx.db.select().from(users).where(eq(users.id, former)),
		).toHaveLength(1);
	});
});

describe("authorization", () => {
	it("refuses every token on session-only routes (403 session_required) and changes nothing", async () => {
		const tokens: Array<[string, string]> = [
			[
				"the extension preset",
				await createToken(ctx, ownerCookie, {
					name: "ext",
					client_kind: "extension",
				}),
			],
			[
				"the MCP preset",
				await createToken(ctx, ownerCookie, {
					name: "mcp",
					client_kind: "mcp",
				}),
			],
			["a script token with every scope", await scriptToken("all", SCOPES)],
		];
		const tokenCount = async () =>
			(await ctx.db.select().from(apiTokens)).length;
		const before = await tokenCount();
		for (const rule of sessionOnly)
			for (const [variant, token] of tokens) {
				const response = await call(rule, { token });
				expect(response.statusCode, label(rule, variant)).toBe(403);
				expect(codeOf(response), label(rule, variant)).toBe("session_required");
			}
		expect(await tokenCount()).toBe(before);
	});

	it("requires the route's scope from tokens (403 insufficient_scope) and accepts a token with only that scope", async () => {
		const only = new Map<string, string>();
		const allBut = new Map<string, string>();
		for (const scope of new Set(scoped.map((rule) => rule.access as Scope))) {
			only.set(scope, await scriptToken(`only ${scope}`, [scope]));
			allBut.set(
				scope,
				await scriptToken(
					`all but ${scope}`,
					SCOPES.filter((s) => s !== scope),
				),
			);
		}
		for (const rule of scoped) {
			const denied = await call(rule, { token: allBut.get(rule.access) });
			expect(denied.statusCode, label(rule, "every other scope")).toBe(403);
			expect(codeOf(denied), label(rule, "every other scope")).toBe(
				"insufficient_scope",
			);
			const allowed = await call(rule, { token: only.get(rule.access) });
			expect([401, 403], label(rule, `only ${rule.access}`)).not.toContain(
				allowed.statusCode,
			);
		}
		const me = ROUTE_RULES.filter((rule) => rule.access === "any");
		for (const rule of me)
			for (const [scope, token] of only)
				expect(
					(await call(rule, { token })).statusCode,
					label(rule, scope),
				).toBe(200);
	});

	it("limits the extension and MCP presets to their documented scopes", async () => {
		for (const kind of ["extension", "mcp"] as const) {
			const token = await createToken(ctx, ownerCookie, {
				name: kind,
				client_kind: kind,
			});
			for (const rule of protectedRoutes) {
				const response = await call(rule, { token });
				const allowed =
					rule.access === "any" ||
					(isScope(rule.access) && SCOPE_PRESETS[kind].includes(rule.access));
				if (allowed)
					expect([401, 403], label(rule, `the ${kind} preset`)).not.toContain(
						response.statusCode,
					);
				else
					expect(response.statusCode, label(rule, `the ${kind} preset`)).toBe(
						403,
					);
			}
		}
	});

	it("keeps owner-only routes from members (403 owner_required) and opens the rest to them", async () => {
		for (const rule of ROUTE_RULES.filter((r) => r.access === "owner")) {
			const response = await call(rule, {
				cookie: memberCookie,
				headers: csrf(ctx.config),
			});
			expect(response.statusCode, label(rule, "a member session")).toBe(403);
			expect(codeOf(response), label(rule, "a member session")).toBe(
				"owner_required",
			);
		}
		for (const rule of protectedRoutes) {
			if (rule.access === "owner" || routeKey(rule) === LOGOUT) continue;
			const response = await call(rule, {
				cookie: memberCookie,
				headers: mutationHeaders(rule),
			});
			expect([401, 403], label(rule, "a member session")).not.toContain(
				response.statusCode,
			);
		}
	});
});

describe("CSRF", () => {
	const cookieMutations = ROUTE_RULES.filter(
		(rule) => isMutating(rule) && rule.access !== "public",
	);

	it("rejects cookie-authenticated changes without the header or from another origin (403 csrf_failed)", async () => {
		const origin = ctx.config.api.publicOrigin;
		const url = new URL(origin);
		const otherPort = new URL(origin);
		otherPort.port = String(Number(url.port || 80) + 1);
		const otherScheme = `${url.protocol === "https:" ? "http" : "https"}://${url.host}`;
		const variants: Array<[string, Record<string, string>]> = [
			["no header and no Origin", {}],
			["the header without an Origin", { "x-tracera-csrf": "1" }],
			["the Origin without the header", { origin }],
			["another header value", { "x-tracera-csrf": "true", origin }],
			[
				"a foreign Origin",
				{ "x-tracera-csrf": "1", origin: "https://evil.example" },
			],
			[
				"an Origin that extends the public origin",
				{ "x-tracera-csrf": "1", origin: `${origin}.evil.example` },
			],
			["another port", { "x-tracera-csrf": "1", origin: otherPort.origin }],
			["another scheme", { "x-tracera-csrf": "1", origin: otherScheme }],
			["the opaque null Origin", { "x-tracera-csrf": "1", origin: "null" }],
			[
				"a same-origin Referer but no Origin",
				{ "x-tracera-csrf": "1", referer: `${origin}/` },
			],
		];
		for (const rule of cookieMutations)
			for (const [variant, headers] of variants) {
				const response = await call(
					rule,
					rule.access === "login"
						? { headers }
						: { cookie: ownerCookie, headers },
				);
				expect(response.statusCode, label(rule, variant)).toBe(403);
				expect(codeOf(response), label(rule, variant)).toBe("csrf_failed");
				expect(response.headers["set-cookie"], label(rule, variant)).toBe(
					undefined,
				);
			}
	});

	it("accepts cookie-authenticated changes with the header and the exact origin", async () => {
		for (const rule of cookieMutations) {
			// Logging out would end the session the other checks use.
			const cookie = routeKey(rule) === LOGOUT ? await login(ctx) : ownerCookie;
			const response = await call(
				rule,
				rule.access === "login"
					? { headers: csrf(ctx.config) }
					: { cookie, headers: csrf(ctx.config) },
			);
			expect(codeOf(response), label(rule, "the CSRF header")).not.toBe(
				"csrf_failed",
			);
			expect([401, 403], label(rule, "the CSRF header")).not.toContain(
				response.statusCode,
			);
		}
	});

	it("does not ask bearer tokens for the CSRF header", async () => {
		const token = await scriptToken("no csrf", SCOPES);
		for (const rule of cookieMutations.filter((r) => isScope(r.access))) {
			const response = await call(rule, {
				token,
				headers: { origin: "https://evil.example" },
			});
			expect([401, 403], label(rule, "a token")).not.toContain(
				response.statusCode,
			);
		}
	});

	it("refuses a forged change before it has any effect", async () => {
		const victim = await login(ctx);
		const token = await scriptToken("kept", SCOPES);
		const id = await tokenId(token);
		const forged = (method: "POST" | "DELETE", url: string, payload?: object) =>
			ctx.app.inject({
				method,
				url,
				headers: {
					cookie: victim,
					"x-tracera-csrf": "1",
					origin: "https://evil.example",
				},
				...(payload ? { payload } : {}),
			});
		const counts = async () => ({
			tokens: (await ctx.db.select().from(apiTokens)).length,
			reports: (await ctx.db.select().from(bugReports)).length,
		});
		const before = await counts();
		for (const response of [
			await forged("POST", "/api/v1/tokens", {
				name: "stolen",
				client_kind: "mcp",
			}),
			await forged("DELETE", `/api/v1/tokens/${id}`),
			await forged("POST", "/api/v1/bug-reports", {
				title: "forged",
				description: "forged",
			}),
			await forged("POST", "/api/v1/auth/logout"),
		])
			expect(codeOf(response)).toBe("csrf_failed");
		expect(await counts()).toEqual(before);
		const me = {
			method: "GET",
			path: "/api/v1/auth/me",
			access: "any",
		} as const;
		expect((await call(me, { cookie: victim })).statusCode).toBe(200);
		expect((await call(me, { token })).statusCode).toBe(200);
	});

	it("applies authentication and CSRF to every spelling of an API path the router accepts", async () => {
		// The router decodes %61 to "a" before matching, so /%61pi/v1/... reaches the /api/v1/... handlers.
		const unauthenticated = await ctx.app.inject({
			method: "GET",
			url: "/%61pi/v1/bug-reports",
		});
		expect(unauthenticated.statusCode).toBe(401);
		const before = (await ctx.db.select().from(bugReports)).length;
		const forgedChange = await ctx.app.inject({
			method: "POST",
			url: "/%61pi/v1/bug-reports",
			headers: { cookie: ownerCookie },
			payload: BODY["POST /api/v1/bug-reports"] as object,
		});
		expect(forgedChange.statusCode).toBe(403);
		expect(codeOf(forgedChange)).toBe("csrf_failed");
		expect((await ctx.db.select().from(bugReports)).length).toBe(before);
		const forgedLogin = await ctx.app.inject({
			method: "POST",
			url: "/%61pi/v1/auth/login",
			payload: BODY["POST /api/v1/auth/login"] as object,
		});
		expect(forgedLogin.statusCode).toBe(403);
		expect(codeOf(forgedLogin)).toBe("csrf_failed");
		expect(forgedLogin.headers["set-cookie"]).toBe(undefined);

		// An absolute-form request target (what proxies send) needs a real socket: inject only sends paths.
		await ctx.app.listen({ host: "127.0.0.1", port: 0 });
		const address = ctx.app.server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const body = JSON.stringify(BODY["POST /api/v1/auth/login"]);
		for (const target of [
			`http://127.0.0.1:${port}/api/v1/auth/login`,
			"http://evil.example/api/v1/auth/login",
		]) {
			const response = await new Promise<{
				status: number;
				cookie: unknown;
				body: string;
			}>((resolve, reject) => {
				const req = request(
					{
						host: "127.0.0.1",
						port,
						method: "POST",
						path: target,
						headers: {
							"content-type": "application/json",
							"content-length": Buffer.byteLength(body),
						},
					},
					(res) => {
						let text = "";
						res.on("data", (chunk) => {
							text += chunk;
						});
						res.on("end", () =>
							resolve({
								status: res.statusCode ?? 0,
								cookie: res.headers["set-cookie"],
								body: text,
							}),
						);
					},
				);
				req.on("error", reject);
				req.end(body);
			});
			expect(response.status, target).toBe(403);
			expect(JSON.parse(response.body).code, target).toBe("csrf_failed");
			expect(response.cookie, target).toBe(undefined);
		}
	});
});
