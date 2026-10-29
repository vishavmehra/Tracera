import { createHash } from "node:crypto";
import { ProblemSchema } from "@tracera/contracts";

/** serverInfo.version and the X-Tracera-Client header; a test keeps it equal to package.json. */
export const VERSION = "0.1.0";

/** The longest call is a 20 s long-poll; anything slower is reported as unavailable. */
const TIMEOUT_MS = 30_000;
const TOKEN = /^trc_pat_[0-9a-f]{64}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SETUP =
	'Set TRACERA_TOKEN in the MCP server\'s environment to a personal access token created with client_kind "mcp" (apps/mcp/README.md), then restart the MCP client.';

/** A tool failure shown to the agent as `Error [code]: message Next: next`. Never carries secrets. */
export class ToolError extends Error {
	readonly code: string;
	readonly next: string;
	constructor(code: string, message: string, next: string) {
		super(message);
		this.code = code;
		this.next = next;
	}
}

export type ApiConfig = {
	baseUrl: string;
	token: string | null;
	/** A configuration problem, reported on every call so the tools still list. */
	problem: ToolError | null;
};

/** Reads TRACERA_API_URL (default http://127.0.0.1:8787) and TRACERA_TOKEN. */
export function loadConfig(env: Record<string, string | undefined>): ApiConfig {
	const raw = env.TRACERA_API_URL?.trim() || "http://127.0.0.1:8787";
	const token = env.TRACERA_TOKEN?.trim() || null;
	let url: URL | null = null;
	try {
		url = new URL(raw);
	} catch {}
	const reason =
		!url ||
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
			? "TRACERA_API_URL must be an http(s) URL without credentials, query, or fragment."
			: url.protocol === "http:" && !LOOPBACK.has(url.hostname)
				? "TRACERA_API_URL must use https unless it points at this machine (127.0.0.1, localhost, or [::1]): over plain http the token could be read on the network."
				: null;
	return {
		baseUrl: url ? url.href.replace(/\/+$/, "") : raw,
		token,
		problem: reason
			? new ToolError(
					"invalid_configuration",
					reason,
					"Fix TRACERA_API_URL in the MCP server's environment and restart the MCP client.",
				)
			: null,
	};
}

export type ApiRequest = {
	method?: "GET" | "POST";
	/** Starts with /api/v1/. IDs in it are validated by the tool schemas (prefixed ULIDs). */
	path: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	idempotencyKey?: string;
	/** Return the body as text (Markdown reports) instead of parsed JSON. */
	text?: boolean;
};

/** One REST call on behalf of a tool; failures become ToolErrors with stable codes. */
export type Api = (tool: string, request: ApiRequest) => Promise<unknown>;

export function createApi(config: ApiConfig, fetchImpl = fetch): Api {
	return async (tool, request) => {
		if (config.problem) throw config.problem;
		if (!config.token)
			throw new ToolError(
				"unauthenticated",
				"TRACERA_TOKEN is not set.",
				SETUP,
			);
		// Never send a value that is not a Tracera token (for example another service's key) anywhere.
		if (!TOKEN.test(config.token))
			throw new ToolError(
				"unauthenticated",
				"TRACERA_TOKEN is not a Tracera personal access token (trc_pat_ followed by 64 hex characters).",
				SETUP,
			);
		const url = new URL(`${config.baseUrl}${request.path}`);
		for (const [key, value] of Object.entries(request.query ?? {}))
			if (value !== undefined) url.searchParams.set(key, String(value));
		const headers: Record<string, string> = {
			authorization: `Bearer ${config.token}`,
			accept: request.text ? "text/markdown" : "application/json",
			// Informational audit metadata; the API attributes calls by the token itself.
			"x-tracera-client": `mcp/${VERSION}`,
			"x-tracera-mcp-tool": tool,
		};
		if (request.body !== undefined)
			headers["content-type"] = "application/json";
		if (request.idempotencyKey)
			headers["idempotency-key"] = request.idempotencyKey;
		let status: number;
		let text: string;
		let retryAfter: string | null;
		try {
			const response = await fetchImpl(url, {
				method: request.method ?? "GET",
				headers,
				body:
					request.body === undefined ? undefined : JSON.stringify(request.body),
				// The API never redirects; following one could hand the token to another origin.
				redirect: "error",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			status = response.status;
			retryAfter = response.headers.get("retry-after");
			text = await response.text();
		} catch {
			throw new ToolError(
				"tracera_unavailable",
				`The Tracera API at ${new URL(config.baseUrl).origin} did not answer.`,
				"Is the Tracera API running at TRACERA_API_URL? Retry once it is.",
			);
		}
		if (status >= 200 && status < 300) {
			if (request.text) return text;
			try {
				return JSON.parse(text) as unknown;
			} catch {
				throw unexpectedResponse();
			}
		}
		throw problemError(status, text, retryAfter);
	};
}

export const unexpectedResponse = () =>
	new ToolError(
		"unexpected_response",
		"Tracera returned a response this MCP server does not understand.",
		"Make sure the Tracera API and this MCP server come from the same checkout.",
	);

const SIGNED_IN =
	"A signed-in person does this in the Tracera web app; it is not possible through MCP.";
const NOT_INDEXED =
	"The repository has no usable index yet: check tracera_get_repository_status and retry when indexing has finished.";
const NEXT: Record<string, string> = {
	not_found:
		"Check the ID: tracera_list_repositories lists repositories, and tracera_get_investigation_status shows an investigation's patch and verification IDs.",
	insufficient_scope:
		'Use a token created with client_kind "mcp" (it has every scope these tools need), then restart the MCP client.',
	session_required: SIGNED_IN,
	owner_required: SIGNED_IN,
	invalid_state:
		"Check the current state with tracera_get_investigation_status.",
	graph_not_indexed: NOT_INDEXED,
	snapshot_not_ready: NOT_INDEXED,
	snapshot_source_unavailable:
		"The indexed copy is gone; ask the repository owner to re-index it in the Tracera web app.",
	repository_required: "Pass repository_id (from tracera_list_repositories).",
	commit_not_found:
		"Pass a branch or commit that exists in the repository, or omit commit to use the default branch.",
	idempotency_key_reused:
		"Use a new client_request_id for a request with different arguments.",
	too_many_active_investigations:
		"Wait for an active investigation to finish, then retry.",
	payload_too_large: "Send less content (shorter logs, fewer items).",
};

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}…` : text;

/** Maps an RFC 9457 problem response to a ToolError. Server internals are never shown. */
function problemError(status: number, text: string, retryAfter: string | null) {
	let raw: unknown = null;
	try {
		raw = JSON.parse(text);
	} catch {}
	const parsed = ProblemSchema.safeParse(raw);
	const problem = parsed.success ? parsed.data : null;
	const code =
		problem && /^[a-z_]{1,64}$/.test(problem.code) ? problem.code : null;
	const detail = clip(problem?.detail ?? "", 500);
	if (status === 401)
		return new ToolError(
			"unauthenticated",
			"Tracera rejected TRACERA_TOKEN (missing, invalid, expired, or revoked).",
			SETUP,
		);
	if (status === 429)
		return new ToolError(
			"rate_limited",
			detail || "Too many requests.",
			`Retry in ${Number(retryAfter) > 0 ? Number(retryAfter) : 60} seconds.`,
		);
	if (status >= 500 || !problem || !code)
		return new ToolError(
			"tracera_unavailable",
			`Tracera could not complete the request (HTTP ${status}${problem ? `, request ${clip(problem.request_id, 64)}` : ""}).`,
			"Retry later; if it persists, check the Tracera API log for the request ID.",
		);
	if (code === "validation_failed") {
		const fields = (problem.errors ?? [])
			.slice(0, 10)
			.map((error) => `${clip(error.path, 100)}: ${clip(error.message, 200)}`);
		return new ToolError(
			"invalid_arguments",
			[detail, ...fields].join("; "),
			"Fix the listed fields and call again.",
		);
	}
	if (code === "investigation_active") {
		const id = (raw as { investigation_id?: unknown }).investigation_id;
		const active =
			typeof id === "string" && /^inv_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)
				? id
				: null;
		return new ToolError(
			code,
			active ? `${detail} (${active})` : detail,
			active
				? `Follow it with tracera_get_investigation_status (investigation_id ${active}).`
				: "Find it with tracera_get_investigation_status.",
		);
	}
	return new ToolError(
		status === 404 ? "not_found" : code,
		detail || `HTTP ${status}`,
		NEXT[status === 404 ? "not_found" : code] ??
			"Read the message, adjust the request, and retry if it makes sense.",
	);
}

/** JSON with object keys sorted at every level, so equal arguments always hash the same. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
				)
			: item,
	);
}

/**
 * Idempotency-Key for a creating tool call: a retried call with the same arguments
 * replays the original response instead of creating a duplicate. `client_request_id` replaces the
 * argument hash, so a caller can deliberately create a second, otherwise identical resource.
 * The API scopes keys per workspace and token, so the key itself carries no token material.
 */
export function idempotencyKey(
	tool: string,
	args: { client_request_id?: string | undefined } & Record<string, unknown>,
): string {
	const { client_request_id, ...rest } = args;
	return client_request_id
		? `mcp:${tool}:${client_request_id}`
		: `mcp:${tool}:${createHash("sha256").update(canonical(rest)).digest("hex")}`;
}
