import {
	createHmac,
	createPrivateKey,
	hkdfSync,
	type KeyObject,
	randomBytes,
	sign,
	timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	GITHUB_OPTIONAL_PERMISSIONS,
	GITHUB_TOKEN_PERMISSIONS,
	GitHubFullNameSchema,
	type GitHubInstallationObject,
	GitHubInstallationObjectSchema,
	GitHubNumericIdSchema,
	RefNameSchema,
} from "@tracera/contracts";
import { z } from "zod";
import type { Config } from "../config.ts";

// GitHub App primitives: App JWTs, installation tokens, webhook signatures, the signed install
// state, and every call Tracera makes to GitHub. Endpoints are fixed constants (callers supply only
// validated numeric IDs and `owner/name`), and the HTTP client is injectable so tests replay recorded
// responses offline. Tokens live only in memory: never logged, stored, put in a URL, or written to a
// git configuration file.

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";
const API_VERSION = "2022-11-28";
const MAX_RESPONSE_CHARS = 5_000_000;
const MAX_PAGES = 10;
const STATE_TTL_MS = 10 * 60_000;
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const APP_INFO_TTL_MS = 10 * 60_000;

export type GitHubConfig = NonNullable<Config["github"]>;

export type GitHubRequest = {
	method: "GET" | "POST" | "DELETE";
	url: string;
	headers: Record<string, string>;
	body?: unknown;
};
/** Header names are lower case. */
export type GitHubResponse = {
	status: number;
	headers: Record<string, string>;
	body: unknown;
};
export type GitHubHttp = (request: GitHubRequest) => Promise<GitHubResponse>;

/** Everything Tracera needs from GitHub; tests substitute recorded responses and a local remote. */
export type GitHubClient = {
	http: GitHubHttp;
	/** Where repository content is fetched from: `https://github.com/<owner>/<name>.git` in production. */
	remote: { url: (fullName: string) => string; protocol: "https" | "file" };
	now: () => number;
};

/** A failed GitHub call or check with a stable code. Never carries a token. */
export class GitHubError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.code = code;
		this.retryable = retryable;
	}
}

const fetchHttp: GitHubHttp = async (request) => {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body === undefined ? undefined : JSON.stringify(request.body),
		// No call needs a redirect; following one could carry credentials to another place.
		redirect: "manual",
		signal: AbortSignal.timeout(15_000),
	});
	const text = await response.text();
	if (text.length > MAX_RESPONSE_CHARS)
		throw new GitHubError(
			"github_unexpected_response",
			"GitHub returned an oversized response",
		);
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = null;
	}
	return {
		status: response.status,
		headers: Object.fromEntries(response.headers),
		body,
	};
};

let defaultClient: GitHubClient | undefined;

/** The production client: fetch() against the fixed GitHub endpoints and HTTPS clones from github.com. */
export function defaultGitHubClient(): GitHubClient {
	defaultClient ??= {
		http: fetchHttp,
		remote: {
			url: (fullName) => `${GITHUB_WEB}/${fullName}.git`,
			protocol: "https",
		},
		now: Date.now,
	};
	return defaultClient;
}

// ---- Credentials -------------------------------------------------------------------------------

const keys = new Map<string, Promise<KeyObject>>();

/** The App's RSA private key, read once per path (a failed read is retried on the next use). */
function privateKey(path: string): Promise<KeyObject> {
	let key = keys.get(path);
	if (!key) {
		key = readFile(path, "utf8")
			.then((pem) => {
				const parsed = createPrivateKey(pem);
				if (parsed.asymmetricKeyType !== "rsa") throw new Error("not RSA");
				return parsed;
			})
			.catch(() => {
				keys.delete(path);
				throw new GitHubError(
					"github_private_key_invalid",
					"The GitHub App private key could not be read as an RSA PEM key (TRACERA_GITHUB_APP_PRIVATE_KEY_PATH)",
				);
			});
		keys.set(path, key);
	}
	return key;
}

const base64url = (value: string | Buffer) =>
	Buffer.from(value).toString("base64url");

/**
 * The App's RS256 JWT: `iat` 60 s in the past to absorb clock drift and a 10-minute lifetime, as
 * GitHub requires. It authenticates only `/app/...` calls; repository access always uses a token.
 */
export function appJwt(appId: string, key: KeyObject, nowMs: number): string {
	const iat = Math.floor(nowMs / 1000) - 60;
	const input = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
		JSON.stringify({ iat, exp: iat + 600, iss: Number(appId) }),
	)}`;
	return `${input}.${base64url(sign("sha256", Buffer.from(input), key))}`;
}

/** GitHub's `X-Hub-Signature-256`: HMAC-SHA256 of the exact body bytes, compared in constant time. */
export function verifyWebhookSignature(
	secret: string,
	body: Buffer,
	header: string | undefined,
): boolean {
	const match = /^sha256=([0-9a-f]{64})$/.exec(header ?? "");
	if (!match?.[1]) return false;
	return timingSafeEqual(
		createHmac("sha256", secret).update(body).digest(),
		Buffer.from(match[1], "hex"),
	);
}

const stateKey = (gh: GitHubConfig) =>
	Buffer.from(
		hkdfSync("sha256", gh.clientSecret, "tracera", "github-install-state", 32),
	);
const StateSchema = z.object({
	w: z.string().max(100),
	u: z.string().max(100),
	n: z.string().max(40),
	e: z.number(),
});

/**
 * The `state` carried through GitHub's install flow: the workspace and user that started it, a nonce,
 * and a 10-minute expiry, MACed with a key derived from the App's client secret. The callback accepts
 * it only for the same signed-in user and workspace.
 */
export function signInstallState(
	gh: GitHubConfig,
	binding: { workspaceId: string; userId: string },
	nowMs: number,
): string {
	const body = base64url(
		JSON.stringify({
			w: binding.workspaceId,
			u: binding.userId,
			n: randomBytes(12).toString("base64url"),
			e: nowMs + STATE_TTL_MS,
		}),
	);
	return `${body}.${createHmac("sha256", stateKey(gh)).update(body).digest("base64url")}`;
}

export function verifyInstallState(
	gh: GitHubConfig,
	state: string,
	nowMs: number,
): { workspaceId: string; userId: string } | null {
	const [body, mac, extra] = state.split(".");
	if (!body || !mac || extra !== undefined) return null;
	const expected = createHmac("sha256", stateKey(gh)).update(body).digest();
	const given = Buffer.from(mac, "base64url");
	if (given.length !== expected.length || !timingSafeEqual(given, expected))
		return null;
	try {
		const parsed = StateSchema.parse(
			JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
		);
		return parsed.e > nowMs
			? { workspaceId: parsed.w, userId: parsed.u }
			: null;
	} catch {
		return null;
	}
}

/** Access levels a token may ask for; `admin` is never requested. */
export type PermissionLevel = "read" | "write";
export type Permissions = Readonly<Record<string, PermissionLevel>>;
const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/**
 * Permission check before anything is connected, fetched, or (later) pushed. `problems`: a required
 * permission is missing or below the level needed (`required` defaults to synchronization's read-only
 * `contents` and `metadata`; a push or pull-request step passes its write needs). `warnings`: access
 * beyond what synchronization uses; tokens are still minted with only the permissions each use asks.
 */
export function evaluatePermissions(
	permissions: Record<string, string>,
	required: Permissions = GITHUB_TOKEN_PERMISSIONS,
): { problems: string[]; warnings: string[] } {
	const problems = Object.entries(required)
		.filter(
			([name, level]) =>
				(RANK[permissions[name] ?? ""] ?? 0) < (RANK[level] ?? Infinity),
		)
		.map(([name, level]) => `missing:${name}:${level}`);
	const used = new Set([
		...Object.keys(GITHUB_TOKEN_PERMISSIONS),
		...Object.keys(GITHUB_OPTIONAL_PERMISSIONS),
	]);
	const warnings = Object.entries(permissions)
		.filter(([name, level]) => level !== "read" || !used.has(name))
		.map(([name, level]) => `excess:${name}:${level}`);
	return { problems, warnings };
}

// ---- Calls -------------------------------------------------------------------------------------

type Auth =
	| { kind: "app" }
	| { kind: "token"; token: string }
	| { kind: "client" }
	| { kind: "none" };

/** A numeric GitHub ID as a URL segment; anything else never reaches a URL. */
const idSegment = (id: number) => String(GitHubNumericIdSchema.parse(id));

function fullNameSegment(fullName: string): string {
	const parsed = GitHubFullNameSchema.safeParse(fullName);
	if (!parsed.success)
		throw new GitHubError(
			"github_unexpected_response",
			"Not a GitHub repository name",
		);
	return parsed.data;
}

async function call(
	client: GitHubClient,
	gh: GitHubConfig,
	request: {
		method: GitHubRequest["method"];
		url: string;
		auth: Auth;
		body?: unknown;
		accept?: string;
	},
): Promise<GitHubResponse> {
	const headers: Record<string, string> = {
		accept: request.accept ?? "application/vnd.github+json",
		"user-agent": "tracera",
		"x-github-api-version": API_VERSION,
	};
	if (request.auth.kind === "app")
		headers.authorization = `Bearer ${appJwt(gh.appId, await privateKey(gh.privateKeyPath), client.now())}`;
	else if (request.auth.kind === "token")
		headers.authorization = `Bearer ${request.auth.token}`;
	else if (request.auth.kind === "client")
		headers.authorization = `Basic ${Buffer.from(`${gh.clientId}:${gh.clientSecret}`).toString("base64")}`;
	if (request.body !== undefined) headers["content-type"] = "application/json";
	try {
		return await client.http({
			method: request.method,
			url: request.url,
			headers,
			...(request.body === undefined ? {} : { body: request.body }),
		});
	} catch (error) {
		if (error instanceof GitHubError) throw error;
		throw new GitHubError(
			"github_unavailable",
			"GitHub could not be reached",
			true,
		);
	}
}

/** Maps an unexpected status to a stable code; callers name what 404 and 422 mean for them. */
function failure(
	response: GitHubResponse,
	what: string,
	codes: { 404?: string; 422?: string } = {},
): GitHubError {
	if (
		response.status === 429 ||
		response.headers["x-ratelimit-remaining"] === "0"
	)
		return new GitHubError(
			"github_rate_limited",
			`GitHub rate-limited ${what}`,
			true,
		);
	if (response.status === 401)
		return new GitHubError(
			"github_auth_failed",
			`GitHub rejected Tracera's credentials for ${what}`,
		);
	if (response.status === 403)
		return new GitHubError("github_forbidden", `GitHub refused ${what}`);
	if (response.status === 404)
		return new GitHubError(
			codes[404] ?? "github_not_found",
			`GitHub found nothing for ${what}`,
		);
	if (response.status === 422)
		return new GitHubError(
			codes[422] ?? "github_permission_missing",
			`GitHub refused ${what}`,
		);
	if (response.status >= 500)
		return new GitHubError(
			"github_unavailable",
			`GitHub failed ${what} (HTTP ${response.status})`,
			true,
		);
	return new GitHubError(
		"github_unexpected_response",
		`GitHub answered ${what} with HTTP ${response.status}`,
	);
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
	const parsed = schema.safeParse(body);
	if (!parsed.success)
		throw new GitHubError(
			"github_unexpected_response",
			`GitHub's ${what} did not have the expected shape`,
		);
	return parsed.data;
}

const PermissionsSchema = z.record(z.string().max(100), z.string().max(20));
const AppSchema = z.object({
	slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
	name: z.string().max(200),
	permissions: PermissionsSchema,
	events: z.array(z.string().max(100)).max(300),
});
export type RegisteredApp = z.infer<typeof AppSchema>;

const appInfo = new WeakMap<GitHubClient, { app: RegisteredApp; at: number }>();

/** The registered App (`GET /app`): slug for the install URL, configured permissions and events. */
export async function getApp(
	client: GitHubClient,
	gh: GitHubConfig,
): Promise<RegisteredApp> {
	const cached = appInfo.get(client);
	if (cached && client.now() - cached.at < APP_INFO_TTL_MS) return cached.app;
	const response = await call(client, gh, {
		method: "GET",
		url: `${GITHUB_API}/app`,
		auth: { kind: "app" },
	});
	if (response.status !== 200) throw failure(response, "the App");
	const app = parseBody(AppSchema, response.body, "App response");
	appInfo.set(client, { app, at: client.now() });
	return app;
}

export async function getInstallation(
	client: GitHubClient,
	gh: GitHubConfig,
	installationId: number,
): Promise<GitHubInstallationObject> {
	const response = await call(client, gh, {
		method: "GET",
		url: `${GITHUB_API}/app/installations/${idSegment(installationId)}`,
		auth: { kind: "app" },
	});
	if (response.status !== 200)
		throw failure(response, "the installation", {
			404: "github_installation_not_found",
		});
	return parseBody(
		GitHubInstallationObjectSchema,
		response.body,
		"installation response",
	);
}

/** Printable ASCII without spaces: safe to place in an HTTP header (no header injection). */
const SecretTokenSchema = z
	.string()
	.min(1)
	.max(1000)
	.regex(/^[\x21-\x7e]+$/);
const TokenResponseSchema = z.object({
	token: SecretTokenSchema,
	expires_at: z.iso.datetime({ offset: true }),
	permissions: PermissionsSchema,
});

const tokenCaches = new WeakMap<
	GitHubClient,
	Map<string, { token: string; expiresAt: number }>
>();

/** What an installation token is for: one repository, or (no `repositoryId`) listing repositories. */
export type TokenRequest = {
	installationId: number;
	repositoryId?: number;
	/**
	 * Exactly the access wanted. Defaults: read-only `contents` and `metadata` for a repository,
	 * `metadata` for listing. Write access (a later user-authorized push or pull request) is
	 * allowed only for exactly one repository.
	 */
	permissions?: Permissions;
};

const PermissionNameSchema = z.string().regex(/^[a-z_]{1,50}$/);

/**
 * Installation-token exchange: a short-lived token minted per use, scoped to at most one repository and
 * to exactly the requested permissions. It is reused from memory until five minutes before it expires
 * (separately per repository and permission set), never logged or stored, and refused if GitHub
 * returns permissions other than those requested.
 */
export async function installationToken(
	client: GitHubClient,
	gh: GitHubConfig,
	request: TokenRequest,
): Promise<string> {
	const { installationId, repositoryId } = request;
	const permissions: Permissions =
		request.permissions ??
		(repositoryId === undefined
			? { metadata: "read" }
			: GITHUB_TOKEN_PERMISSIONS);
	const entries = Object.entries(permissions).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	if (
		entries.length === 0 ||
		entries.some(
			([name, level]) =>
				!PermissionNameSchema.safeParse(name).success ||
				(level !== "read" && level !== "write"),
		)
	)
		throw new GitHubError(
			"github_token_request_invalid",
			"Request named read or write permissions",
		);
	if (
		repositoryId === undefined &&
		entries.some(([, level]) => level === "write")
	)
		throw new GitHubError(
			"github_token_request_invalid",
			"Write access is granted for exactly one repository, never for a whole installation",
		);
	const key = `${installationId}:${repositoryId ?? "*"}:${entries
		.map(([name, level]) => `${name}=${level}`)
		.join(",")}`;
	let cache = tokenCaches.get(client);
	if (!cache) {
		cache = new Map();
		tokenCaches.set(client, cache);
	}
	const cached = cache.get(key);
	if (cached && cached.expiresAt - client.now() > TOKEN_REUSE_MARGIN_MS)
		return cached.token;
	const response = await call(client, gh, {
		method: "POST",
		url: `${GITHUB_API}/app/installations/${idSegment(installationId)}/access_tokens`,
		auth: { kind: "app" },
		body: {
			...(repositoryId === undefined
				? {}
				: { repository_ids: [GitHubNumericIdSchema.parse(repositoryId)] }),
			permissions: Object.fromEntries(entries),
		},
	});
	if (response.status !== 201)
		throw failure(response, "an installation token", {
			404: "github_installation_not_found",
			422:
				repositoryId === undefined
					? "github_permission_missing"
					: "github_repository_not_accessible",
		});
	const parsed = parseBody(
		TokenResponseSchema,
		response.body,
		"token response",
	);
	const granted = parsed.permissions;
	const exact =
		Object.keys(granted).length === entries.length &&
		entries.every(([name, level]) => granted[name] === level);
	if (!exact)
		throw new GitHubError(
			"github_token_scope_mismatch",
			"GitHub returned a token whose permissions differ from those requested; it was discarded",
		);
	cache.set(key, {
		token: parsed.token,
		expiresAt: Date.parse(parsed.expires_at),
	});
	return parsed.token;
}

/**
 * Repository permission check: GitHub mints a token for exactly this repository with exactly these
 * permissions only if the installation grants them (otherwise `github_repository_not_accessible`), and
 * the repository list seen with that token must hold it. Returns the scoped token and the repository.
 */
export async function repositoryAccess(
	client: GitHubClient,
	gh: GitHubConfig,
	request: TokenRequest & { repositoryId: number },
): Promise<{ token: string; repository: GitHubRepositoryEntry }> {
	const token = await installationToken(client, gh, request);
	const { repositories } = await listAccessibleRepositories(client, gh, token);
	const repository = repositories.find(
		(candidate) => candidate.id === request.repositoryId,
	);
	if (!repository)
		throw new GitHubError(
			"github_repository_not_accessible",
			"The installation does not grant access to that repository",
		);
	return { token, repository };
}

const RepositoryEntrySchema = z.object({
	id: GitHubNumericIdSchema,
	full_name: GitHubFullNameSchema,
	private: z.boolean(),
	default_branch: z.string().max(255).nullable().optional(),
	archived: z.boolean().optional(),
});
const RepositoryPageSchema = z.object({
	total_count: z.number().int().nonnegative(),
	repositories: z.array(RepositoryEntrySchema).max(100),
});
export type GitHubRepositoryEntry = z.infer<typeof RepositoryEntrySchema>;

/** The repositories a token can see (`GET /installation/repositories`), at most 1,000. */
export async function listAccessibleRepositories(
	client: GitHubClient,
	gh: GitHubConfig,
	token: string,
): Promise<{ repositories: GitHubRepositoryEntry[]; truncated: boolean }> {
	const repositories: GitHubRepositoryEntry[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const response = await call(client, gh, {
			method: "GET",
			url: `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`,
			auth: { kind: "token", token },
		});
		if (response.status !== 200)
			throw failure(response, "the installation's repositories");
		const parsed = parseBody(
			RepositoryPageSchema,
			response.body,
			"repository list",
		);
		repositories.push(...parsed.repositories);
		if (
			parsed.repositories.length < 100 ||
			repositories.length >= parsed.total_count
		)
			return { repositories, truncated: false };
	}
	return { repositories, truncated: true };
}

const RefSchema = z.object({
	object: z.object({
		sha: z.string().regex(/^[0-9a-f]{40}$/),
		type: z.string(),
	}),
});

/** The commit a branch points to on GitHub; null when the branch does not exist. */
export async function branchHead(
	client: GitHubClient,
	gh: GitHubConfig,
	token: string,
	fullName: string,
	branch: string,
): Promise<string | null> {
	const name = RefNameSchema.safeParse(branch);
	if (!name.success) return null;
	const response = await call(client, gh, {
		method: "GET",
		url: `${GITHUB_API}/repos/${fullNameSegment(fullName)}/git/ref/heads/${name.data
			.split("/")
			.map(encodeURIComponent)
			.join("/")}`,
		auth: { kind: "token", token },
	});
	if (response.status === 404) return null;
	if (response.status !== 200) throw failure(response, `the head of ${branch}`);
	const ref = parseBody(RefSchema, response.body, "ref response");
	if (ref.object.type !== "commit")
		throw new GitHubError(
			"github_unexpected_response",
			`${branch} does not point to a commit`,
		);
	return ref.object.sha;
}

const OAuthTokenSchema = z.object({ access_token: SecretTokenSchema });

/** Exchanges the install flow's OAuth code for a user token, used once to verify access, then revoked. */
export async function exchangeUserCode(
	client: GitHubClient,
	gh: GitHubConfig,
	code: string,
): Promise<string> {
	const response = await call(client, gh, {
		method: "POST",
		url: `${GITHUB_WEB}/login/oauth/access_token`,
		auth: { kind: "none" },
		accept: "application/json",
		body: {
			client_id: gh.clientId,
			client_secret: gh.clientSecret,
			code,
		},
	});
	// GitHub reports a bad code with HTTP 200 and an `error` field instead of a token.
	const parsed = OAuthTokenSchema.safeParse(response.body);
	if (response.status !== 200 || !parsed.success)
		throw new GitHubError(
			"github_authorization_failed",
			"GitHub did not accept the authorization code; start the connection again",
		);
	return parsed.data.access_token;
}

const UserInstallationsSchema = z.object({
	installations: z.array(z.object({ id: GitHubNumericIdSchema })).max(100),
});

/**
 * Whether the GitHub user behind `userToken` can access the installation. The callback's
 * `installation_id` is attacker-controllable, so GitHub's guidance is to never trust it alone.
 */
export async function userCanAccessInstallation(
	client: GitHubClient,
	gh: GitHubConfig,
	userToken: string,
	installationId: number,
): Promise<boolean> {
	for (let page = 1; page <= MAX_PAGES; page++) {
		const response = await call(client, gh, {
			method: "GET",
			url: `${GITHUB_API}/user/installations?per_page=100&page=${page}`,
			auth: { kind: "token", token: userToken },
		});
		if (response.status !== 200)
			throw failure(response, "the user's installations");
		const { installations } = parseBody(
			UserInstallationsSchema,
			response.body,
			"installation list",
		);
		if (
			installations.some((installation) => installation.id === installationId)
		)
			return true;
		if (installations.length < 100) return false;
	}
	return false;
}

/** Best effort: the user token is not needed once access is verified, so it is revoked at once. */
export async function revokeUserToken(
	client: GitHubClient,
	gh: GitHubConfig,
	userToken: string,
): Promise<void> {
	await call(client, gh, {
		method: "DELETE",
		url: `${GITHUB_API}/applications/${encodeURIComponent(gh.clientId)}/token`,
		auth: { kind: "client" },
		body: { access_token: userToken },
	}).catch(() => undefined);
}

/**
 * For any git command that talks to GitHub with an installation token (fetch here; a later push):
 * credential helpers and askpass programs are disabled, so the machine user's stored GitHub
 * credentials are never consulted, and redirects are not followed.
 */
export const GIT_REMOTE_HARDENING: readonly string[] = [
	"-c",
	"credential.helper=",
	"-c",
	"credential.interactive=false",
	"-c",
	"core.askPass=",
	"-c",
	"http.followRedirects=false",
];

/**
 * The token for one git command's environment only: an `http.https://github.com/.extraheader` set
 * through git's `GIT_CONFIG_*` variables, never in argv (visible to other processes), a URL, or a
 * config file.
 */
export function gitAuthEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `http.${GITHUB_WEB}/.extraheader`,
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(
			`x-access-token:${token}`,
		).toString("base64")}`,
		SSH_ASKPASS: "",
	};
}

/**
 * `git fetch` of a GitHub repository into Tracera's bare cache, with the hardening and token handling
 * above; only the remote's protocol is allowed, and tags, submodules, and automatic gc are off.
 */
export function fetchInvocation(
	remote: GitHubClient["remote"],
	fullName: string,
	token: string,
	refspecs: readonly string[],
): { args: string[]; env: Record<string, string> } {
	return {
		args: [
			...GIT_REMOTE_HARDENING,
			"-c",
			"gc.auto=0",
			"-c",
			"maintenance.auto=false",
			"-c",
			"protocol.allow=never",
			"-c",
			`protocol.${remote.protocol}.allow=always`,
			"fetch",
			"--quiet",
			"--no-tags",
			"--prune",
			"--no-write-fetch-head",
			"--no-recurse-submodules",
			"--",
			remote.url(fullNameSegment(fullName)),
			...refspecs,
		],
		env: gitAuthEnv(token),
	};
}

/**
 * The GitHub App as one reusable, injectable client: installation-token exchange and repository
 * permission checks over a transport (`GitHubClient`) that tests replace. Synchronization uses it
 * read-only; the separate, user-authorized push and pull-request step
 * asks it for write access to one repository per operation, e.g.
 * `repositoryAccess({installationId, repositoryId, permissions: {contents: "write", pull_requests: "write", metadata: "read"}})`.
 */
export function githubAppClient(
	gh: GitHubConfig,
	client: GitHubClient = defaultGitHubClient(),
) {
	return {
		client,
		token: (request: TokenRequest) => installationToken(client, gh, request),
		repositoryAccess: (request: TokenRequest & { repositoryId: number }) =>
			repositoryAccess(client, gh, request),
		installation: (installationId: number) =>
			getInstallation(client, gh, installationId),
		registeredApp: () => getApp(client, gh),
	};
}
export type GitHubAppClient = ReturnType<typeof githubAppClient>;
