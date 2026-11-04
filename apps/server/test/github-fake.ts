import { execFileSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
	GitHubClient,
	GitHubRequest,
	GitHubResponse,
} from "../src/modules/github-app.ts";

// A stand-in for GitHub in tests: replays the fixtures in fixtures/github (hand-built from GitHub's
// documented shapes, not recorded live; see their `_provenance`), verifies App JWTs as GitHub would,
// scopes installation tokens, and serves repository content from local bare repositories through
// git's file transport. Nothing reaches the network.

const FIXTURES = path.join(import.meta.dirname, "fixtures", "github");
// biome-ignore lint/suspicious/noExplicitAny: fixture JSON, shaped by the files themselves.
export const API: Record<string, any> = JSON.parse(
	readFileSync(path.join(FIXTURES, "api.json"), "utf8"),
);
// biome-ignore lint/suspicious/noExplicitAny: fixture JSON, shaped by the files themselves.
export const WEBHOOKS: Record<string, any> = JSON.parse(
	readFileSync(path.join(FIXTURES, "webhooks.json"), "utf8"),
);

export const APP_ID = "123456";
export const WEBHOOK_SECRET = "tracera-test-webhook-secret-0123456789";
export const CLIENT_ID = "Iv23liTraceraTest";
export const CLIENT_SECRET = "tracera-test-client-secret-0123456789";
export const USER_CODE = "good-code";

/** An RSA key pair for the test App; the private key is written like a downloaded `.pem`. */
export function appKey(dir: string): { keyPath: string; publicKey: KeyObject } {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const keyPath = path.join(dir, "tracera-test.private-key.pem");
	writeFileSync(
		keyPath,
		privateKey.export({ type: "pkcs1", format: "pem" }) as string,
	);
	return { keyPath, publicKey };
}

export const githubEnv = (keyPath: string) => ({
	TRACERA_GITHUB_APP_ID: APP_ID,
	TRACERA_GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
	TRACERA_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
	TRACERA_GITHUB_CLIENT_ID: CLIENT_ID,
	TRACERA_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
});

/** Checks an App JWT as GitHub does: RS256 signature, issuer, and at most ten minutes of validity. */
export function jwtValid(
	authorization: string | undefined,
	publicKey: KeyObject,
	nowMs: number,
): boolean {
	const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
	const [header, payload, signature] = token.split(".");
	if (!header || !payload || !signature) return false;
	if (
		!verify(
			"sha256",
			Buffer.from(`${header}.${payload}`),
			publicKey,
			Buffer.from(signature, "base64url"),
		)
	)
		return false;
	const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	const now = Math.floor(nowMs / 1000);
	return (
		JSON.parse(Buffer.from(header, "base64url").toString("utf8")).alg ===
			"RS256" &&
		claims.iss === Number(APP_ID) &&
		claims.iat <= now &&
		claims.exp > now &&
		claims.exp - claims.iat <= 600
	);
}

export type FakeGitHub = {
	client: GitHubClient;
	requests: GitHubRequest[];
	/** Every installation token minted, in order. */
	tokens: string[];
	installations: Map<number, Record<string, unknown>>;
	/** Repositories installation 42 grants access to. */
	repositories: Array<Record<string, unknown> & { id: number }>;
	/** Installations the OAuth user can access. */
	userInstallations: number[];
	/** Full name → local bare repository standing in for github.com. */
	remotes: Map<string, string>;
	/** "METHOD /path" → a forced response (outages, errors). */
	failures: Map<string, GitHubResponse>;
};

const json = (status: number, body: unknown): GitHubResponse => ({
	status,
	headers: {},
	body,
});
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

export function fakeGitHub(publicKey: KeyObject, root: string): FakeGitHub {
	const fake: FakeGitHub = {
		client: undefined as unknown as GitHubClient,
		requests: [],
		tokens: [],
		installations: new Map([[42, structuredClone(API.installation)]]),
		repositories: structuredClone(API.installation_repositories.repositories),
		userInstallations: [42],
		remotes: new Map(),
		failures: new Map(),
	};
	const issued = new Map<string, { repositories: number[] | null }>();
	const http = async (request: GitHubRequest): Promise<GitHubResponse> => {
		fake.requests.push(request);
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		const forced = fake.failures.get(route);
		if (forced) return forced;
		if (url.origin === "https://github.com") {
			if (route !== "POST /login/oauth/access_token")
				return json(404, { message: "Not Found" });
			const body = request.body as Record<string, string>;
			// GitHub answers a bad code with 200 and an error field.
			if (
				body.client_id !== CLIENT_ID ||
				body.client_secret !== CLIENT_SECRET ||
				body.code !== USER_CODE
			)
				return json(200, { error: "bad_verification_code" });
			return json(200, API.oauth_token);
		}
		if (url.origin !== "https://api.github.com")
			throw new Error(`The fake GitHub was asked for ${url.origin}`);
		if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
			if (!jwtValid(request.headers.authorization, publicKey, Date.now()))
				return json(401, {
					message: "A JSON web token could not be decoded",
				});
			if (route === "GET /app") return json(200, API.app);
			const match = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(
				url.pathname,
			);
			const installation = match
				? fake.installations.get(Number(match[1]))
				: undefined;
			if (!match || !installation) return json(404, { message: "Not Found" });
			if (!match[2]) return json(200, installation);
			const body = request.body as {
				repository_ids?: number[];
				permissions?: Record<string, string>;
			};
			const grantable = installation.permissions as Record<string, string>;
			if (
				Object.entries(body.permissions ?? {}).some(
					([name, level]) =>
						!grantable[name] ||
						(level === "write" && grantable[name] === "read"),
				)
			)
				return json(422, {
					message:
						"The permissions requested are not granted to this installation.",
				});
			if (
				body.repository_ids?.some(
					(id) => !fake.repositories.some((repo) => repo.id === id),
				)
			)
				return json(422, {
					message:
						"There is at least one repository that does not exist or is not accessible to the parent installation.",
				});
			const token = `ghs_TraceraTestOnly${String(fake.tokens.length + 1).padStart(22, "0")}`;
			fake.tokens.push(token);
			issued.set(token, { repositories: body.repository_ids ?? null });
			return json(201, {
				...API.access_token,
				token,
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				permissions: body.permissions ?? grantable,
			});
		}
		if (route === `DELETE /applications/${CLIENT_ID}/token`) {
			const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
				"base64",
			);
			return request.headers.authorization === `Basic ${basic}`
				? json(204, null)
				: json(401, { message: "Bad credentials" });
		}
		const bearer =
			/^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
		if (url.pathname === "/user/installations")
			return bearer === API.oauth_token.access_token
				? json(200, {
						total_count: fake.userInstallations.length,
						installations: fake.userInstallations.map((id) => ({ id })),
					})
				: json(401, { message: "Bad credentials" });
		const scope = issued.get(bearer);
		if (!scope) return json(401, { message: "Bad credentials" });
		if (url.pathname === "/installation/repositories") {
			const visible = fake.repositories.filter(
				(repo) => !scope.repositories || scope.repositories.includes(repo.id),
			);
			return json(200, {
				total_count: visible.length,
				repository_selection: "selected",
				repositories: visible,
			});
		}
		const ref = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/.exec(
			url.pathname,
		);
		if (ref?.[1] && ref[2]) {
			const remote = fake.remotes.get(ref[1]);
			const branch = decodeURIComponent(ref[2]);
			let sha: string | null = null;
			try {
				sha = remote ? git(remote, "rev-parse", `refs/heads/${branch}`) : null;
			} catch {
				sha = null;
			}
			if (!sha) return json(404, { message: "Not Found" });
			return json(200, {
				...API.git_ref,
				ref: `refs/heads/${branch}`,
				object: { ...API.git_ref.object, sha },
			});
		}
		return json(404, { message: "Not Found" });
	};
	fake.client = {
		http,
		remote: {
			url: (fullName) =>
				fake.remotes.get(fullName) ?? path.join(root, "missing.git"),
			protocol: "file",
		},
		now: () => Date.now(),
	};
	return fake;
}

/** A local bare repository standing in for `github.com/<fullName>`, with helpers to push to it. */
export function remoteRepository(
	root: string,
	fullName: string,
	files: Record<string, string>,
) {
	const bare = path.join(root, "github", `${fullName}.git`);
	const work = path.join(root, "github-work", fullName);
	mkdirSync(path.dirname(bare), { recursive: true });
	mkdirSync(work, { recursive: true });
	git(path.dirname(bare), "init", "--bare", "-q", bare);
	git(work, "init", "-q", "-b", "main");
	const commit = (changes: Record<string, string>, message: string) => {
		for (const [file, content] of Object.entries(changes)) {
			mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
			writeFileSync(path.join(work, file), content);
		}
		git(work, "add", "-A");
		git(
			work,
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"-m",
			message,
		);
		return git(work, "rev-parse", "HEAD");
	};
	const push = (...refspecs: string[]) =>
		git(work, "push", "-q", "--force", bare, ...refspecs);
	const head = commit(files, "initial");
	push("HEAD:refs/heads/main");
	return {
		bare,
		head,
		/** Commits to main and pushes it, as a developer pushing to GitHub would. */
		pushMain(changes: Record<string, string>, message = "change") {
			const sha = commit(changes, message);
			push("HEAD:refs/heads/main");
			return sha;
		},
		/** Publishes main's current commit as another branch on the remote. */
		publishBranch(name: string) {
			push(`HEAD:refs/heads/${name}`);
		},
		/** A pull request's head: a commit on a branch, published as refs/pull/<n>/head. */
		openPullRequest(number: number, changes: Record<string, string>) {
			git(work, "checkout", "-q", "-b", `pr-${number}`);
			const sha = commit(changes, `pull request ${number}`);
			push(`HEAD:refs/heads/pr-${number}`, `HEAD:refs/pull/${number}/head`);
			git(work, "checkout", "-q", "main");
			return sha;
		},
	};
}
