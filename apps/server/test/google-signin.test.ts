import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../src/config.ts";
import { AppError } from "../src/lib/http.ts";
import {
	evaluateSupabaseUser,
	fetchSupabaseUser,
	googleAuthorizeUrl,
	revokeSupabaseSession,
	type SupabaseUser,
} from "../src/modules/google-signin.ts";
import {
	closedPortUrl,
	fakeToken,
	googleUser,
	PUBLISHABLE_KEY,
	startSupabaseStub,
} from "./supabase-stub.ts";

const base = { DATABASE_URL: "postgres://tracera:pw@127.0.0.1:5432/tracera" };
const withProject = (extra: Record<string, string> = {}) =>
	loadConfig({
		...base,
		SUPABASE_URL: "https://abcdefgh.supabase.co",
		SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
		...extra,
	});

describe("evaluateSupabaseUser", () => {
	const identity = (user: ReturnType<typeof googleUser>, patch: object) => [
		{
			provider: "google",
			identity_data: { ...user.identities[0]?.identity_data, ...patch },
		},
	];
	const cases: Array<[string, (u: ReturnType<typeof googleUser>) => object]> = [
		[
			"an account made through another provider",
			() => ({ app_metadata: { provider: "email" } }),
		],
		["no provider recorded", () => ({ app_metadata: null })],
		["no identities", () => ({ identities: [] })],
		["identities missing", () => ({ identities: undefined })],
		[
			"only another provider's identity",
			(u) => ({
				identities: [
					{ provider: "github", identity_data: u.identities[0]?.identity_data },
				],
			}),
		],
	];
	for (const [name, patch] of cases)
		it(`refuses ${name} as not a Google sign-in`, () => {
			const user = googleUser();
			expect(
				evaluateSupabaseUser({ ...user, ...patch(user) } as SupabaseUser),
			).toEqual({ ok: false, code: "invalid_provider_token" });
		});

	const unverified: Array<
		[string, (u: ReturnType<typeof googleUser>) => object]
	> = [
		["no email", () => ({ email: null })],
		["an email that is not an address", () => ({ email: "not-an-address" })],
		[
			"an account email that was never confirmed",
			() => ({ email_confirmed_at: null }),
		],
		[
			"an identity without data",
			() => ({ identities: [{ provider: "google", identity_data: null }] }),
		],
		[
			"an email Google did not verify",
			(u) => ({ identities: identity(u, { email_verified: false }) }),
		],
		[
			"an email Google did not mention",
			(u) => ({ identities: identity(u, { email_verified: undefined }) }),
		],
		[
			"an email flag that is text, not a boolean",
			(u) => ({ identities: identity(u, { email_verified: "true" }) }),
		],
		[
			"an identity email that differs from the account email",
			(u) => ({
				identities: identity(u, { email: "someone-else@example.com" }),
			}),
		],
		[
			"an identity without an email",
			(u) => ({ identities: identity(u, { email: undefined }) }),
		],
	];
	for (const [name, patch] of unverified)
		it(`refuses ${name} as an unverified email`, () => {
			const user = googleUser();
			expect(
				evaluateSupabaseUser({ ...user, ...patch(user) } as SupabaseUser),
			).toEqual({ ok: false, code: "email_not_verified" });
		});

	it("accepts a verified Google account and lowercases the email", () => {
		const user = googleUser("Ada@Example.COM");
		expect(evaluateSupabaseUser(user)).toEqual({
			ok: true,
			profile: { email: "ada@example.com", displayName: "Ada Lovelace" },
		});
	});

	const names: Array<[string, Record<string, unknown>, string]> = [
		[
			"the name field when there is no full name",
			{ full_name: undefined },
			"Ada Lovelace",
		],
		[
			"the part before the @ when there is no name",
			{ full_name: undefined, name: undefined },
			"ada",
		],
		[
			"a name without control or direction characters",
			{ full_name: "Ada\u202E  Love\nlace\u0000" },
			"Ada Love lace",
		],
		[
			"a name cut to 100 characters",
			{ full_name: "x".repeat(300) },
			"x".repeat(100),
		],
		[
			"the local part when the name is only blanks",
			{ full_name: " ​ ", name: undefined },
			"ada",
		],
	];
	for (const [name, patch, expected] of names)
		it(`uses ${name} for the display name`, () => {
			const user = googleUser();
			const verdict = evaluateSupabaseUser({
				...user,
				identities: identity(user, patch),
			} as SupabaseUser);
			expect(verdict).toMatchObject({
				ok: true,
				profile: { displayName: expected },
			});
		});
});

describe("googleAuthorizeUrl", () => {
	it("points at the project's Google sign-in and returns to the callback page", () => {
		const config = withProject({
			SUPABASE_URL: "https://abcdefgh.supabase.co//",
			TRACERA_PUBLIC_URL: "https://app.example.com/",
		});
		expect(googleAuthorizeUrl(config)).toBe(
			"https://abcdefgh.supabase.co/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback",
		);
	});

	it("keeps the dev server port in the return address and never carries the key", () => {
		const url = googleAuthorizeUrl(
			withProject({ TRACERA_PUBLIC_URL: "http://127.0.0.1:5173" }),
		);
		expect(url).toContain(
			"redirect_to=http%3A%2F%2F127.0.0.1%3A5173%2Fauth%2Fcallback",
		);
		expect(url).not.toContain(PUBLISHABLE_KEY);
	});

	it("is null unless both the address and the key are set", () => {
		expect(googleAuthorizeUrl(loadConfig(base))).toBeNull();
		expect(
			googleAuthorizeUrl(
				loadConfig({ ...base, SUPABASE_URL: "https://abcdefgh.supabase.co" }),
			),
		).toBeNull();
		expect(
			googleAuthorizeUrl(
				loadConfig({ ...base, SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY }),
			),
		).toBeNull();
	});
});

describe("sign-in configuration", () => {
	it("is off by default and gives new users the member role", () => {
		const config = loadConfig(base);
		expect(config.signIn).toEqual({ supabase: null, newUsers: "member" });
		expect(describeConfig(config).googleSignIn).toBe("off");
	});

	it("treats empty values as unset", () => {
		const config = loadConfig({
			...base,
			SUPABASE_URL: "",
			SUPABASE_PUBLISHABLE_KEY: " ",
			TRACERA_GOOGLE_SIGNIN_NEW_USERS: "",
		});
		expect(config.signIn).toEqual({ supabase: null, newUsers: "member" });
	});

	const accepted: Array<[string, string, string]> = [
		[
			"an https address",
			"https://abcdefgh.supabase.co",
			"https://abcdefgh.supabase.co",
		],
		[
			"trailing slashes",
			"https://abcdefgh.supabase.co///",
			"https://abcdefgh.supabase.co",
		],
		[
			"surrounding blanks",
			"  https://abcdefgh.supabase.co  ",
			"https://abcdefgh.supabase.co",
		],
		[
			"a custom domain with a path",
			"https://auth.example.com/supabase/",
			"https://auth.example.com/supabase",
		],
		[
			"plain http on 127.0.0.1",
			"http://127.0.0.1:54321",
			"http://127.0.0.1:54321",
		],
		[
			"plain http on localhost",
			"http://localhost:54321",
			"http://localhost:54321",
		],
		[
			"plain http on the IPv6 loopback",
			"http://[::1]:54321",
			"http://[::1]:54321",
		],
	];
	for (const [name, value, normalized] of accepted)
		it(`accepts ${name}`, () => {
			const config = withProject({ SUPABASE_URL: value });
			expect(config.signIn.supabase?.url).toBe(normalized);
			expect(describeConfig(config).googleSignIn).toBe("member");
		});

	const rejected: Array<[string, string]> = [
		["plain http on another host", "http://abcdefgh.supabase.co"],
		["a lookalike of localhost", "http://localhost.evil.example"],
		["credentials in the address", "https://user:pass@abcdefgh.supabase.co"],
		["a query", "https://abcdefgh.supabase.co/?apikey=leaky-canary"],
		["a fragment", "https://abcdefgh.supabase.co/#leaky-canary"],
		["another scheme", "ftp://abcdefgh.supabase.co"],
		["something that is not an address", "leaky-canary"],
	];
	for (const [name, value] of rejected)
		it(`rejects ${name} without echoing it`, () => {
			const attempt = () => withProject({ SUPABASE_URL: value });
			expect(attempt).toThrow(ConfigError);
			expect(attempt).toThrow(/SUPABASE_URL/);
			expect(attempt).not.toThrow(/leaky-canary|pass@/);
		});

	it("trims the key and rejects one that cannot be a header value", () => {
		expect(
			withProject({ SUPABASE_PUBLISHABLE_KEY: `  ${PUBLISHABLE_KEY}\n` }).signIn
				.supabase?.publishableKey,
		).toBe(PUBLISHABLE_KEY);
		for (const bad of [
			"two words",
			"tab\there",
			"x".repeat(501),
			"nöt-ascii",
		]) {
			const attempt = () => withProject({ SUPABASE_PUBLISHABLE_KEY: bad });
			expect(attempt).toThrow(/SUPABASE_PUBLISHABLE_KEY/);
		}
	});

	it("takes member or deny for new users and nothing else", () => {
		expect(
			withProject({ TRACERA_GOOGLE_SIGNIN_NEW_USERS: "deny" }).signIn.newUsers,
		).toBe("deny");
		expect(() =>
			withProject({ TRACERA_GOOGLE_SIGNIN_NEW_USERS: "owner" }),
		).toThrow(/TRACERA_GOOGLE_SIGNIN_NEW_USERS/);
	});

	it("keeps the address and the key out of the loggable summary", () => {
		const summary = JSON.stringify(describeConfig(withProject()));
		expect(summary).not.toContain("supabase.co");
		expect(summary).not.toContain(PUBLISHABLE_KEY);
	});
});

describe("talking to the provider", () => {
	let stub: Awaited<ReturnType<typeof startSupabaseStub>>;
	beforeAll(async () => {
		stub = await startSupabaseStub();
	});
	afterAll(async () => stub.close());
	const project = () => ({ url: stub.url, publishableKey: PUBLISHABLE_KEY });
	const outcome = async (token: string, timeoutMs?: number) => {
		try {
			await fetchSupabaseUser(project(), token, { timeoutMs });
			return "accepted";
		} catch (error) {
			if (!(error instanceof AppError)) throw error;
			expect(error.message).not.toContain(token);
			return `${error.status} ${error.code}`;
		}
	};

	it("sends the project key and the token, and reads the user", async () => {
		const token = fakeToken("reads");
		stub.accept(token, googleUser("reads@example.com"));
		const user = await fetchSupabaseUser(project(), token);
		expect(user.email).toBe("reads@example.com");
		const call = stub.calls.findLast((c) => c.authorization?.includes(token));
		expect(call).toMatchObject({
			method: "GET",
			path: "/auth/v1/user",
			apikey: PUBLISHABLE_KEY,
			authorization: `Bearer ${token}`,
		});
	});

	it("tells a refused token from a provider that is failing", async () => {
		const answers: Array<[number, string]> = [
			[400, "401 invalid_provider_token"],
			[401, "401 invalid_provider_token"],
			[403, "401 invalid_provider_token"],
			[404, "401 invalid_provider_token"],
			[418, "502 provider_unreachable"],
			[429, "502 provider_unreachable"],
			[500, "502 provider_unreachable"],
			[503, "502 provider_unreachable"],
		];
		for (const [status, expected] of answers) {
			const token = fakeToken(`status-${status}`);
			stub.answer(token, { status, body: { msg: "no" } });
			expect(await outcome(token), `HTTP ${status}`).toBe(expected);
		}
		expect(await outcome(fakeToken("never-accepted"))).toBe(
			"401 invalid_provider_token",
		);
	});

	it("treats an unreadable answer as the provider failing", async () => {
		for (const [label, body] of [
			["empty object", {}],
			["a list", []],
			["user without id", { email: "x@example.com" }],
		] as const) {
			const token = fakeToken(label);
			stub.answer(token, { status: 200, body });
			expect(await outcome(token), label).toBe("502 provider_unreachable");
		}
	});

	it("never follows a redirect with the token attached", async () => {
		const token = fakeToken("redirect");
		stub.answer(token, { status: 302, redirectTo: "/elsewhere" });
		expect(await outcome(token)).toBe("502 provider_unreachable");
		expect(stub.calls.some((c) => c.path === "/elsewhere")).toBe(false);
	});

	it("gives up on a provider that does not answer", async () => {
		const token = fakeToken("hangs");
		stub.answer(token, { status: 200, hang: true });
		const started = Date.now();
		expect(await outcome(token, 150)).toBe("502 provider_unreachable");
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("reports a refused connection as the provider being unreachable", async () => {
		const down = {
			url: await closedPortUrl(),
			publishableKey: PUBLISHABLE_KEY,
		};
		await expect(
			fetchSupabaseUser(down, fakeToken("down")),
		).rejects.toMatchObject({ status: 502, code: "provider_unreachable" });
		expect(await revokeSupabaseSession(down, fakeToken("down"))).toBe(false);
	});

	it("ends the provider's session for the local device only", async () => {
		const token = fakeToken("revoke");
		stub.accept(token, googleUser("revoke@example.com"));
		expect(await revokeSupabaseSession(project(), token)).toBe(true);
		expect(stub.calls.findLast((c) => c.method === "POST")).toMatchObject({
			path: "/auth/v1/logout?scope=local",
			apikey: PUBLISHABLE_KEY,
			authorization: `Bearer ${token}`,
		});
		expect(await revokeSupabaseSession(project(), fakeToken("not-known"))).toBe(
			false,
		);
	});
});
