import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/client.ts";
import { AppError, createRateLimiter } from "../lib/http.ts";
import { audit } from "../modules/audit.ts";
import { actorOf } from "../modules/auth.ts";

/** Audit target type by ID prefix, for calls that name one resource in the path. */
const TARGETS: Record<string, string> = {
	repo: "repository",
	snap: "snapshot",
	gnd: "graph_node",
	asm: "assessment",
	bug: "bug_report",
	inv: "investigation",
	pat: "patch",
	ver: "verification",
};
const ID = /^([a-z]+)_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOOL = /^tracera_[a-z_]{1,56}$/;
const CLIENT = /^mcp\/[0-9A-Za-z.+-]{1,32}$/;

/**
 * Guards for calls made with MCP tokens (client_kind "mcp"): per-token rate
 * limits (reads 300/min, writes 60/min, on top of the per-workspace quotas) and one
 * `mcp.tool_called` audit event per API request. The tool name and client version are client-reported
 * headers, stored only when well-formed; arguments are never stored. Other callers are untouched.
 */
export function registerMcpGuards(app: FastifyInstance, db: Db) {
	const reads = createRateLimiter({ limit: 300, windowMs: 60_000 });
	const writes = createRateLimiter({ limit: 60, windowMs: 60_000 });
	const problemCodes = new WeakMap<FastifyRequest, string>();
	const mcpAuth = (request: FastifyRequest) =>
		request.auth?.kind === "token" && request.auth.clientKind === "mcp"
			? request.auth
			: null;

	// Runs after app.ts authenticates the request (hooks run in registration order).
	app.addHook("preHandler", async (request, reply) => {
		const auth = mcpAuth(request);
		if (!auth) return;
		const limiter = ["GET", "HEAD"].includes(request.method) ? reads : writes;
		const result = limiter.take(auth.tokenId);
		if (result.allowed) return;
		reply.header("retry-after", String(result.retryAfterSeconds));
		throw new AppError(
			429,
			"rate_limited",
			`Too many requests for this token; try again in ${result.retryAfterSeconds} s`,
		);
	});

	app.addHook("onSend", async (request, reply, payload) => {
		if (
			reply.statusCode >= 400 &&
			typeof payload === "string" &&
			mcpAuth(request)
		)
			try {
				const { code } = JSON.parse(payload) as { code?: unknown };
				if (typeof code === "string") problemCodes.set(request, code);
			} catch {}
		return payload;
	});

	// After the response is sent, so auditing adds no latency to the call.
	app.addHook("onResponse", async (request, reply) => {
		const auth = mcpAuth(request);
		if (!auth) return;
		const id = (request.params as { id?: unknown } | undefined)?.id;
		const prefix = typeof id === "string" ? ID.exec(id)?.[1] : undefined;
		const targetType = prefix ? TARGETS[prefix] : undefined;
		const tool = request.headers["x-tracera-mcp-tool"];
		const client = request.headers["x-tracera-client"];
		await audit(db, {
			workspaceId: auth.workspaceId,
			actor: actorOf(auth),
			action: "mcp.tool_called",
			targetType:
				targetType && typeof id === "string" ? targetType : "api_token",
			targetId: targetType && typeof id === "string" ? id : auth.tokenId,
			metadata: {
				tool: typeof tool === "string" && TOOL.test(tool) ? tool : null,
				client:
					typeof client === "string" && CLIENT.test(client) ? client : null,
				method: request.method,
				route: request.routeOptions.url ?? null,
				status: reply.statusCode,
				code: problemCodes.get(request) ?? null,
				latency_ms: Math.round(reply.elapsedTime),
			},
			requestId: request.id,
		}).catch((error: unknown) =>
			request.log.warn(
				{ code: (error as { code?: unknown }).code },
				"mcp audit write failed",
			),
		);
	});
}
