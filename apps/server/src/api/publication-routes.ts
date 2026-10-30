import {
	ActionRequestSchema,
	type IdPrefix,
	idSchema,
} from "@tracera/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError, createRateLimiter } from "../lib/http.ts";
import { requireOwner, requireScope } from "../modules/auth.ts";
import {
	downloadPatch,
	getAction,
	listActions,
	requestAction,
} from "../modules/publication.ts";
import { type AppDeps, authOf } from "./app.ts";

/**
 * Applying, committing, and pushing an approved patch. These change the user's repository, so each is a
 * separate request from a signed-in workspace owner: tokens (including MCP clients) are refused.
 */
export function registerPublicationRoutes(app: FastifyInstance, deps: AppDeps) {
	const { db, config } = deps;
	// Git work on the host, per workspace and minute.
	const quota = createRateLimiter({ limit: 20, windowMs: 60_000 });
	const param = (request: FastifyRequest, prefix: IdPrefix, label: string) => {
		const id = (request.params as { id?: string }).id ?? "";
		if (!idSchema(prefix).safeParse(id).success)
			throw new AppError(404, "not_found", `${label} ${id} was not found`);
		return id;
	};

	app.post("/api/v1/patches/:id/actions", async (request, reply) => {
		const auth = authOf(request);
		requireOwner(auth);
		const input = ActionRequestSchema.parse(request.body);
		const taken = quota.take(auth.workspaceId);
		if (!taken.allowed) {
			reply.header("retry-after", String(taken.retryAfterSeconds));
			throw new AppError(
				429,
				"rate_limited",
				`Too many actions for this workspace; try again in ${taken.retryAfterSeconds} s`,
			);
		}
		const key = request.headers["idempotency-key"];
		const { action, replayed } = await requestAction(
			deps,
			auth,
			param(request, "pat", "Patch"),
			input,
			{
				requestId: request.id,
				idempotencyKey: typeof key === "string" ? key : undefined,
			},
		);
		return reply.status(replayed ? 200 : 201).send({ action });
	});

	app.get("/api/v1/patches/:id/actions", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return listActions(db, auth.workspaceId, param(request, "pat", "Patch"));
	});

	app.get("/api/v1/actions/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return getAction(db, auth.workspaceId, param(request, "act", "Action"));
	});

	app.get("/api/v1/patches/:id/download", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		const { filename, diff } = await downloadPatch(
			db,
			config,
			auth.workspaceId,
			param(request, "pat", "Patch"),
		);
		return reply
			.header("content-type", "text/x-patch; charset=utf-8")
			.header("content-disposition", `attachment; filename="${filename}"`)
			.header("x-content-type-options", "nosniff")
			.send(diff);
	});
}
