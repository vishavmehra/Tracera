import { z } from "zod";
import { redactSecrets } from "../lib/redact.ts";

// The one place Tracera talks to GitHub, and only to open a pull request the user just authorized. The
// token travels in a single request header; it is in no error, log line, or stored row. Redirects are
// never followed, so the token cannot be sent to another address.

export const GITHUB_API_VERSION = "2022-11-28";
const TIMEOUT_MS = 8_000;

export type GithubErrorCode =
	| "github_auth_failed"
	| "github_permission_denied"
	| "github_repository_not_found"
	| "pull_request_exists"
	| "github_rejected"
	| "github_unreachable";

export class GithubError extends Error {
	readonly code: GithubErrorCode;
	constructor(code: GithubErrorCode, detail: string) {
		super(detail);
		this.code = code;
	}
}

export type GithubRepo = { owner: string; repo: string };
export type GithubApi = { apiUrl: string; token: string; timeoutMs?: number };

const OWNER = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";
const NAME = "[A-Za-z0-9._-]{1,100}?";
const REMOTE_FORMS = [
	new RegExp(`^https://github\\.com/(${OWNER})/(${NAME})(?:\\.git)?$`, "i"),
	new RegExp(`^git@github\\.com:(${OWNER})/(${NAME})(?:\\.git)?$`, "i"),
];

/** The repository a github.com remote URL names, or null for every other spelling (credentials, ports, extra path). */
export function parseGithubRemote(url: string): GithubRepo | null {
	for (const form of REMOTE_FORMS) {
		const [, owner, repo] = form.exec(url) ?? [];
		if (owner && repo && repo !== "." && repo !== "..") return { owner, repo };
	}
	return null;
}

const PULL_REQUEST_URL =
	/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9]\d{0,9})$/;

const sameRepo = (url: string, repo: GithubRepo) => {
	const [, owner, name] = PULL_REQUEST_URL.exec(url) ?? [];
	return (
		owner?.toLowerCase() === repo.owner.toLowerCase() &&
		name?.toLowerCase() === repo.repo.toLowerCase()
	);
};

const CreatedSchema = z.object({
	number: z.number().int().positive(),
	html_url: z.string(),
});
const ProblemSchema = z.object({
	message: z.string().optional(),
	errors: z
		.array(
			z.object({
				message: z.string().optional(),
				field: z.string().optional(),
				code: z.string().optional(),
			}),
		)
		.optional(),
});

/** One short line of GitHub's own words for a refusal, with anything credential-like removed. */
function problemText(json: unknown): string {
	const parsed = ProblemSchema.safeParse(json);
	if (!parsed.success) return "";
	const { message, errors = [] } = parsed.data;
	const details = errors
		.map((e) => e.message ?? [e.field, e.code].filter(Boolean).join(" "))
		.filter(Boolean)
		.join("; ");
	const line = [message, details].filter(Boolean).join(": ");
	return redactSecrets(line.replace(/\s+/g, " ").trim(), {
		redactEmails: false,
	}).text.slice(0, 240);
}

type Answer = { status: number; json: unknown; headers: Headers };

async function send(
	api: GithubApi,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
): Promise<Answer> {
	try {
		const response = await fetch(`${api.apiUrl}${path}`, {
			method,
			redirect: "manual",
			signal: AbortSignal.timeout(api.timeoutMs ?? TIMEOUT_MS),
			headers: {
				authorization: `Bearer ${api.token}`,
				accept: "application/vnd.github+json",
				"x-github-api-version": GITHUB_API_VERSION,
				"user-agent": "tracera",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await response.text();
		let json: unknown = null;
		try {
			json = JSON.parse(text);
		} catch {
			json = null;
		}
		return { status: response.status, json, headers: response.headers };
	} catch {
		throw new GithubError(
			"github_unreachable",
			"GitHub did not answer in time or could not be reached. A pull request may or may not exist: check the repository before trying again",
		);
	}
}

/** Maps a refusal to a stable code. Only a server error or silence leaves it unknown whether a pull request exists. */
function failure(status: number, headers: Headers, json: unknown): GithubError {
	const said = problemText(json);
	if (status >= 300 && status < 400)
		return new GithubError(
			"github_rejected",
			"GitHub redirected the request and Tracera does not follow redirects. The repository may have been renamed or moved: update the remote URL",
		);
	if (status === 401)
		return new GithubError(
			"github_auth_failed",
			"GitHub did not accept the token (it may be wrong, expired, or revoked)",
		);
	if (
		status === 429 ||
		(status === 403 &&
			(headers.get("x-ratelimit-remaining") === "0" ||
				headers.has("retry-after")))
	)
		return new GithubError(
			"github_rejected",
			"GitHub is rate limiting this token. Wait, then try again",
		);
	if (status === 403)
		return new GithubError(
			"github_permission_denied",
			"The token may not open pull requests on this repository (it needs Pull requests: write)",
		);
	if (status === 404)
		return new GithubError(
			"github_repository_not_found",
			"GitHub has no such repository for this token (it may be private, or the token may not have access to it)",
		);
	if (status === 422 && /pull request already exists/i.test(said))
		return new GithubError(
			"pull_request_exists",
			"A pull request already exists for this branch",
		);
	if (status >= 500)
		return new GithubError(
			"github_unreachable",
			`GitHub answered with a server error (${status}). A pull request may or may not exist: check the repository before trying again`,
		);
	return new GithubError(
		"github_rejected",
		said
			? `GitHub rejected the pull request: ${said}`
			: `GitHub refused the request (${status})`,
	);
}

/** The open pull request for a branch, when GitHub lists one; any trouble just means no answer. */
async function findOpen(
	api: GithubApi,
	repo: GithubRepo,
	branch: string,
): Promise<string | null> {
	try {
		const head = encodeURIComponent(`${repo.owner}:${branch}`);
		const { status, json } = await send(
			api,
			"GET",
			`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?state=open&per_page=1&head=${head}`,
		);
		const url = Array.isArray(json)
			? (json[0] as { html_url?: unknown } | undefined)?.html_url
			: undefined;
		return status === 200 && typeof url === "string" && sameRepo(url, repo)
			? url
			: null;
	} catch {
		return null;
	}
}

/**
 * Opens one pull request from a branch already on the remote. Success is only what GitHub answered
 * with: the link and number come from its response, and a response without a usable link is not a success.
 */
export async function createPullRequest(
	api: GithubApi,
	repo: GithubRepo,
	pr: {
		head: string;
		base: string;
		title: string;
		body: string;
		draft: boolean;
	},
): Promise<{ url: string; number: number }> {
	const { status, json, headers } = await send(
		api,
		"POST",
		`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls`,
		{
			title: pr.title,
			body: pr.body,
			head: pr.head,
			base: pr.base,
			draft: pr.draft,
		},
	);
	if (status === 201) {
		const created = CreatedSchema.safeParse(json);
		if (created.success) {
			const { html_url: url, number } = created.data;
			if (
				PULL_REQUEST_URL.exec(url)?.[3] === String(number) &&
				sameRepo(url, repo)
			)
				return { url, number };
		}
		throw new GithubError(
			"github_unreachable",
			"GitHub answered without a usable pull request link. A pull request may exist: check the repository before trying again",
		);
	}
	const error = failure(status, headers, json);
	if (error.code !== "pull_request_exists") throw error;
	const existing = await findOpen(api, repo, pr.head);
	throw new GithubError(
		error.code,
		existing ? `${error.message}: ${existing}` : error.message,
	);
}
