import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, GITHUB_VARIABLES, loadConfig } from "../src/config.ts";
import { summarizeDelivery } from "../src/modules/github.ts";
import {
	appJwt,
	evaluatePermissions,
	fetchInvocation,
	type GitHubConfig,
	GitHubError,
	githubAppClient,
	installationToken,
	signInstallState,
	verifyInstallState,
	verifyWebhookSignature,
} from "../src/modules/github-app.ts";
import {
	APP_ID,
	appKey,
	fakeGitHub,
	githubEnv,
	jwtValid,
	WEBHOOKS,
} from "./github-fake.ts";

const gh: GitHubConfig = {
	appId: APP_ID,
	privateKeyPath: "unused",
	webhookSecret: "w".repeat(32),
	clientId: "Iv23liTraceraTest",
	clientSecret: "s".repeat(40),
};

describe("webhook signatures (X-Hub-Signature-256)", () => {
	it("accepts GitHub's documented test vector and nothing else", () => {
		// docs.github.com, "Validating webhook deliveries": secret, payload, and expected signature.
		const secret = "It's a Secret to Everybody";
		const body = Buffer.from("Hello, World!");
		const expected =
			"sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
		expect(verifyWebhookSignature(secret, body, expected)).toBe(true);
		const cases: Array<[string, Buffer, string | undefined]> = [
			["one digit changed", body, expected.replace(/7$/, "8")],
			["body changed by one byte", Buffer.from("Hello, World?"), expected],
			["wrong secret", body, expected],
			["missing prefix", body, expected.slice("sha256=".length)],
			["sha1 header style", body, `sha1=${"0".repeat(40)}`],
			[
				"upper-case hex",
				body,
				expected.toUpperCase().replace("SHA256", "sha256"),
			],
			["truncated", body, expected.slice(0, -2)],
			["empty", body, ""],
			["absent", body, undefined],
		];
		for (const [label, payload, header] of cases)
			expect(
				verifyWebhookSignature(
					label === "wrong secret" ? `${secret}!` : secret,
					payload,
					header,
				),
				label,
			).toBe(false);
	});
});

describe("GitHub App JWT (RS256)", () => {
	it("signs a JWT that verifies with the App's public key and stays within GitHub's limits", () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const now = Date.UTC(2026, 9, 26, 12, 0, 0);
		const jwt = appJwt(APP_ID, privateKey, now);
		const [header, payload, signature] = jwt.split(".");
		expect(
			JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")),
		).toEqual({ alg: "RS256", typ: "JWT" });
		const claims = JSON.parse(
			Buffer.from(payload ?? "", "base64url").toString("utf8"),
		);
		// iat 60 s in the past (clock drift), exp at most 10 minutes after iat, issuer the App ID.
		expect(claims).toEqual({
			iat: now / 1000 - 60,
			exp: now / 1000 + 540,
			iss: 123456,
		});
		expect(
			verify(
				"sha256",
				Buffer.from(`${header}.${payload}`),
				publicKey,
				Buffer.from(signature ?? "", "base64url"),
			),
		).toBe(true);
		// RSASSA-PKCS1 signatures are deterministic: same key, time, and claims give the same JWT.
		expect(appJwt(APP_ID, privateKey, now)).toBe(jwt);
		// A changed claim no longer verifies.
		const forged = Buffer.from(
			JSON.stringify({ ...claims, iss: 999 }),
		).toString("base64url");
		expect(
			verify(
				"sha256",
				Buffer.from(`${header}.${forged}`),
				publicKey,
				Buffer.from(signature ?? "", "base64url"),
			),
		).toBe(false);
		expect(jwtValid(`Bearer ${jwt}`, publicKey, now)).toBe(true);
		expect(jwtValid(`Bearer ${jwt}`, publicKey, now + 11 * 60_000)).toBe(false);
	});
});

describe("install state", () => {
	const binding = { workspaceId: "wsp_A", userId: "usr_A" };
	const now = Date.UTC(2026, 9, 26, 12);

	it("round-trips for 10 minutes and refuses tampering, expiry, and other keys", () => {
		const state = signInstallState(gh, binding, now);
		expect(verifyInstallState(gh, state, now + 9 * 60_000)).toEqual(binding);
		expect(verifyInstallState(gh, state, now + 10 * 60_000 + 1)).toBeNull();
		const [body = "", mac = ""] = state.split(".");
		const forgedBody = Buffer.from(
			JSON.stringify({ w: "wsp_B", u: "usr_B", n: "x", e: now + 60_000 }),
		).toString("base64url");
		const cases = [
			`${forgedBody}.${mac}`,
			`${body}.${mac.slice(1)}`,
			`${body}.${Buffer.alloc(32).toString("base64url")}`,
			`${state}.extra`,
			body,
			"",
		];
		for (const candidate of cases)
			expect(verifyInstallState(gh, candidate, now)).toBeNull();
		expect(
			verifyInstallState({ ...gh, clientSecret: "t".repeat(40) }, state, now),
		).toBeNull();
		// Each state carries a fresh nonce.
		expect(signInstallState(gh, binding, now)).not.toBe(state);
	});
});

describe("permission checks (least privilege)", () => {
	it.each([
		[{ contents: "read", metadata: "read" }, [], []],
		[{ contents: "read", metadata: "read", pull_requests: "read" }, [], []],
		[{ metadata: "read" }, ["missing:contents:read"], []],
		[{}, ["missing:contents:read", "missing:metadata:read"], []],
		[{ contents: "write", metadata: "read" }, [], ["excess:contents:write"]],
		[
			{ contents: "read", metadata: "read", issues: "write" },
			[],
			["excess:issues:write"],
		],
		[
			{ contents: "read", metadata: "read", administration: "read" },
			[],
			["excess:administration:read"],
		],
	])("%j → problems %j, warnings %j", (permissions, problems, warnings) => {
		// Later push/PR checks pass their write needs; read access does not satisfy them.
		expect(
			evaluatePermissions(
				{ contents: "read", metadata: "read" },
				{ contents: "write" },
			).problems,
		).toEqual(["missing:contents:write"]);
		expect(evaluatePermissions(permissions as Record<string, string>)).toEqual({
			problems,
			warnings,
		});
	});
});

describe("installation tokens", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "tracera-github-unit-"));
	const key = appKey(dir);
	const config = { ...gh, privateKeyPath: key.keyPath };

	it("mints read-only tokens for one repository with a valid App JWT, and reuses them", async () => {
		const fake = fakeGitHub(key.publicKey, dir);
		const request = { installationId: 42, repositoryId: 7 };
		const token = await installationToken(fake.client, config, request);
		expect(token).toBe(fake.tokens[0]);
		const [mint] = fake.requests;
		expect(mint).toMatchObject({
			method: "POST",
			url: "https://api.github.com/app/installations/42/access_tokens",
			body: {
				repository_ids: [7],
				permissions: { contents: "read", metadata: "read" },
			},
		});
		expect(
			jwtValid(mint?.headers.authorization, key.publicKey, Date.now()),
		).toBe(true);
		// Cached in memory until five minutes before expiry; listing tokens are separate and metadata-only.
		expect(await installationToken(fake.client, config, request)).toBe(token);
		await installationToken(fake.client, config, { installationId: 42 });
		expect(fake.requests).toHaveLength(2);
		expect(fake.requests[1]?.body).toEqual({
			permissions: { metadata: "read" },
		});
	});

	it("checks write access for one repository, as a later push or pull-request step needs", async () => {
		const fake = fakeGitHub(key.publicKey, dir);
		const app = githubAppClient(config, fake.client);
		const write = {
			installationId: 42,
			repositoryId: 7,
			permissions: {
				contents: "write",
				pull_requests: "write",
				metadata: "read",
			},
		} as const;
		// The fixture installation grants read access only: GitHub refuses the write token.
		await expect(app.repositoryAccess(write)).rejects.toMatchObject({
			code: "github_repository_not_accessible",
		});
		expect(
			evaluatePermissions(
				(fake.installations.get(42) as { permissions: Record<string, string> })
					.permissions,
				write.permissions,
			).problems,
		).toEqual(["missing:contents:write", "missing:pull_requests:write"]);
		fake.installations.set(42, {
			...(fake.installations.get(42) ?? {}),
			permissions: {
				contents: "write",
				metadata: "read",
				pull_requests: "write",
			},
		});
		const access = await app.repositoryAccess(write);
		expect(access.repository).toMatchObject({ id: 7, full_name: "acme/shop" });
		expect(fake.requests.at(-2)?.body).toEqual({
			repository_ids: [7],
			permissions: {
				contents: "write",
				metadata: "read",
				pull_requests: "write",
			},
		});
		// Read and write tokens are separate: synchronization never receives the write token.
		const read = await app.token({ installationId: 42, repositoryId: 7 });
		expect(read).not.toBe(access.token);
		// Write access is never granted for a whole installation, nor any level beyond write.
		for (const request of [
			{ installationId: 42, permissions: { contents: "write" } },
			{ installationId: 42, repositoryId: 7, permissions: {} },
			{
				installationId: 42,
				repositoryId: 7,
				permissions: { contents: "admin" },
			},
			{
				installationId: 42,
				repositoryId: 7,
				permissions: { "Contents!": "read" },
			},
		])
			await expect(
				app.token(request as Parameters<typeof app.token>[0]),
			).rejects.toMatchObject({ code: "github_token_request_invalid" });
	});

	it("refuses broader, malformed, or unavailable tokens", async () => {
		const fake = fakeGitHub(key.publicKey, dir);
		const mint = "POST /app/installations/42/access_tokens";
		const attempt = () =>
			installationToken(fake.client, config, {
				installationId: 42,
				repositoryId: 7,
			});
		const cases: Array<[number, unknown, string]> = [
			[
				201,
				{
					token: "ghs_x",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					permissions: { contents: "write", metadata: "read" },
				},
				"github_token_scope_mismatch",
			],
			[
				201,
				{
					token: "ghs_x\r\nX-Injected: 1",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					permissions: { contents: "read", metadata: "read" },
				},
				"github_unexpected_response",
			],
			[422, { message: "not accessible" }, "github_repository_not_accessible"],
			[404, { message: "Not Found" }, "github_installation_not_found"],
			[401, { message: "Bad credentials" }, "github_auth_failed"],
			[503, null, "github_unavailable"],
		];
		for (const [status, body, code] of cases) {
			fake.failures.set(mint, { status, headers: {}, body });
			const error = await attempt().catch((caught: unknown) => caught);
			expect(error, code).toBeInstanceOf(GitHubError);
			expect((error as GitHubError).code).toBe(code);
		}
		fake.failures.set(mint, {
			status: 403,
			headers: { "x-ratelimit-remaining": "0" },
			body: null,
		});
		await expect(attempt()).rejects.toMatchObject({
			code: "github_rate_limited",
			retryable: true,
		});
	});

	it("reports an unreadable private key without echoing it", async () => {
		const fake = fakeGitHub(key.publicKey, dir);
		const error = await installationToken(
			fake.client,
			{ ...config, privateKeyPath: path.join(dir, "missing.pem") },
			{ installationId: 42, repositoryId: 7 },
		).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: "github_private_key_invalid" });
		expect(fake.requests).toHaveLength(0);
	});
});

describe("fetching repository content", () => {
	it("passes the token to git only through this command's environment", () => {
		const token = "ghs_TraceraTestOnly0000000000000000000099";
		const { args, env } = fetchInvocation(
			{
				url: (fullName) => `https://github.com/${fullName}.git`,
				protocol: "https",
			},
			"acme/shop",
			token,
			["+refs/heads/*:refs/heads/*"],
		);
		const header = Buffer.from(`x-access-token:${token}`).toString("base64");
		expect(args.join(" ")).not.toContain(token);
		expect(args.join(" ")).not.toContain(header);
		expect(args).toContain("https://github.com/acme/shop.git");
		expect(env).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
			GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${header}`,
			SSH_ASKPASS: "",
		});
		// No stored credential of the machine's user is consulted; only HTTPS; no redirects or tags.
		for (const setting of [
			"credential.helper=",
			"credential.interactive=false",
			"core.askPass=",
			"protocol.allow=never",
			"protocol.https.allow=always",
			"http.followRedirects=false",
		])
			expect(args).toContain(setting);
		expect(args).toContain("--no-tags");
		expect(() =>
			fetchInvocation(
				{ url: (fullName) => fullName, protocol: "https" },
				"acme/shop.git --upload-pack=evil",
				token,
				[],
			),
		).toThrow(GitHubError);
	});
});

describe("delivery summaries", () => {
	it("keeps only what processing needs: no messages, emails, or user details", () => {
		const summary = summarizeDelivery(
			"push",
			Buffer.from(JSON.stringify(WEBHOOKS.push)),
		);
		expect(summary).toEqual({
			kind: "push",
			installation_id: 42,
			action: null,
			repository: { id: 7, full_name: "acme/shop" },
			ref: "refs/heads/main",
			after: "2222222222222222222222222222222222222222",
			deleted: false,
		});
		const stored = JSON.stringify(summary);
		for (const secretish of [
			"dev.one@example.com",
			"Dev One",
			"sk-live",
			"checkout total",
		])
			expect(stored).not.toContain(secretish);
		const pr = summarizeDelivery(
			"pull_request",
			Buffer.from(JSON.stringify(WEBHOOKS.pull_request)),
		);
		expect(JSON.stringify(pr)).not.toContain("dev.two@example.com");
		expect(pr).toMatchObject({
			kind: "pull_request",
			number: 5,
			base_ref: "main",
		});
	});

	it("marks malformed payloads invalid without copying their values", () => {
		const broken = {
			...WEBHOOKS.push,
			after: "not-a-sha <script>",
			repository: { ...WEBHOOKS.push.repository, full_name: "../../etc" },
		};
		const summary = summarizeDelivery(
			"push",
			Buffer.from(JSON.stringify(broken)),
		);
		expect(summary.kind).toBe("invalid");
		expect(JSON.stringify(summary)).not.toContain("<script>");
		expect(JSON.stringify(summary)).not.toContain("etc");
		expect(summarizeDelivery("push", Buffer.from("{not json"))).toMatchObject({
			kind: "invalid",
			issues: ["The body is not JSON"],
		});
		expect(
			summarizeDelivery(
				"star",
				Buffer.from(JSON.stringify({ action: "created" })),
			),
		).toEqual({ kind: "other", installation_id: null, action: "created" });
	});
});

describe("configuration", () => {
	const base = {
		NODE_ENV: "test",
		DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x",
	};

	it("is configured only when all five variables are set, and never fails on missing ones", () => {
		const unset = loadConfig(base);
		expect(unset.github).toBeNull();
		expect(unset.githubMissing).toEqual([...GITHUB_VARIABLES]);
		const env = githubEnv("/keys/app.pem");
		const full = loadConfig({ ...base, ...env });
		expect(full.github).toEqual({
			appId: APP_ID,
			privateKeyPath: "/keys/app.pem",
			webhookSecret: env.TRACERA_GITHUB_WEBHOOK_SECRET,
			clientId: env.TRACERA_GITHUB_CLIENT_ID,
			clientSecret: env.TRACERA_GITHUB_CLIENT_SECRET,
		});
		expect(full.githubMissing).toEqual([]);
		// A partial set is "not configured" and names exactly the unset variables, never a value.
		const { TRACERA_GITHUB_CLIENT_SECRET: _secret, ...partial } = env;
		const half = loadConfig({ ...base, ...partial });
		expect(half.github).toBeNull();
		expect(half.githubMissing).toEqual(["TRACERA_GITHUB_CLIENT_SECRET"]);
		expect(JSON.stringify(half.githubMissing)).not.toContain(
			env.TRACERA_GITHUB_WEBHOOK_SECRET,
		);
		expect(() =>
			loadConfig({ ...base, ...env, TRACERA_GITHUB_WEBHOOK_SECRET: "short" }),
		).toThrow(ConfigError);
		expect(() =>
			loadConfig({ ...base, ...env, TRACERA_GITHUB_APP_ID: "abc" }),
		).toThrow(ConfigError);
	});
});

describe("HMAC helper used by the integration tests", () => {
	it("matches the module's verification", () => {
		const body = Buffer.from(JSON.stringify(WEBHOOKS.ping));
		const header = `sha256=${createHmac("sha256", gh.webhookSecret).update(body).digest("hex")}`;
		expect(verifyWebhookSignature(gh.webhookSecret, body, header)).toBe(true);
	});
});
