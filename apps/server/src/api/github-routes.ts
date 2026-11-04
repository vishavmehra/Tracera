import {
	ConnectGitHubRepositoryRequestSchema,
	GitHubCallbackQuerySchema,
	type IdPrefix,
	idSchema,
} from "@tracera/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError, createRateLimiter } from "../lib/http.ts";
import { requireOwner, requireScope } from "../modules/auth.ts";
import {
	CALLBACK_PATH,
	completeInstallation,
	connectRepository,
	githubStatus,
	installUrl,
	listInstallationRepositories,
	listInstallations,
	receiveWebhook,
	WEBHOOK_MAX_BYTES,
	WEBHOOK_PATH,
} from "../modules/github.ts";
import { getSyncStatus, requestManualSync } from "../modules/sync.ts";
import { type AppDeps, authOf } from "./app.ts";

/** GitHub App connection, webhooks, and repository synchronization. */
export function registerGitHubRoutes(app: FastifyInstance, deps: AppDeps) {
	const { db } = deps;
	// Calls that reach GitHub, and sync requests, per workspace and minute.
	const quota = createRateLimiter({ limit: 20, windowMs: 60_000 });
	// Unauthenticated callers that keep sending bad signatures, per IP and minute.
	const badSignatures = createRateLimiter({ limit: 30, windowMs: 60_000 });
	const throttle = (reply: FastifyReply, workspaceId: string) => {
		const result = quota.take(workspaceId);
		if (result.allowed) return;
		reply.header("retry-after", String(result.retryAfterSeconds));
		throw new AppError(
			429,
			"rate_limited",
			`Too many GitHub and sync requests for this workspace; try again in ${result.retryAfterSeconds} s`,
		);
	};
	const param = (request: FastifyRequest, prefix: IdPrefix, label: string) => {
		const id = (request.params as { id?: string }).id ?? "";
		if (!idSchema(prefix).safeParse(id).success)
			throw new AppError(404, "not_found", `${label} ${id} was not found`);
		return id;
	};

	app.get("/api/v1/github/status", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return githubStatus(deps, auth.workspaceId);
	});

	app.get("/api/v1/github/installations", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return { installations: await listInstallations(db, auth.workspaceId) };
	});

	// Owner session only, like repository registration: the URL carries a state bound to this owner.
	app.get("/api/v1/github/install", async (request, reply) => {
		const auth = authOf(request);
		requireOwner(auth);
		throttle(reply, auth.workspaceId);
		return installUrl(deps, auth);
	});

	// GitHub sends the browser here after installing; the session cookie comes with the navigation.
	app.get(CALLBACK_PATH, async (request, reply) => {
		const auth = authOf(request);
		requireOwner(auth);
		throttle(reply, auth.workspaceId);
		const back = new URL("/repositories", deps.config.api.publicUrl);
		try {
			const installation = await completeInstallation(
				deps,
				auth,
				GitHubCallbackQuerySchema.parse(request.query),
				request.id,
			);
			back.searchParams.set("github_installation", installation.id);
		} catch (error) {
			if (error instanceof AppError)
				back.searchParams.set("github_error", error.code);
			else if (error instanceof ZodError)
				back.searchParams.set("github_error", "validation_failed");
			else throw error;
		}
		return reply.redirect(back.toString(), 302);
	});

	app.get(
		"/api/v1/github/installations/:id/repositories",
		async (request, reply) => {
			const auth = authOf(request);
			requireOwner(auth);
			throttle(reply, auth.workspaceId);
			return listInstallationRepositories(
				deps,
				auth,
				param(request, "ghi", "GitHub installation"),
			);
		},
	);

	app.post(
		"/api/v1/github/installations/:id/repositories",
		async (request, reply) => {
			const auth = authOf(request);
			requireOwner(auth);
			throttle(reply, auth.workspaceId);
			const input = ConnectGitHubRepositoryRequestSchema.parse(request.body);
			return reply
				.status(201)
				.send(
					await connectRepository(
						deps,
						auth,
						param(request, "ghi", "GitHub installation"),
						input,
						request.id,
					),
				);
		},
	);

	app.get("/api/v1/repositories/:id/sync", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return getSyncStatus(
			deps,
			auth.workspaceId,
			param(request, "repo", "Repository"),
		);
	});

	// Manual sync and recovery after failures: same scope as an index request.
	app.post("/api/v1/repositories/:id/sync", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		throttle(reply, auth.workspaceId);
		const { status, update } = await requestManualSync(
			deps,
			auth,
			param(request, "repo", "Repository"),
			request.id,
		);
		return reply.status(status).send({ update });
	});

	// Authenticated by the signature over the raw body, not by a session or token (app.ts lets this
	// path through). This scope parses JSON as raw bytes so the HMAC covers exactly what GitHub sent;
	// any other content type is refused with 415, a larger body with 413.
	app.register(async (scope) => {
		scope.removeAllContentTypeParsers();
		scope.addContentTypeParser(
			"application/json",
			{ parseAs: "buffer", bodyLimit: WEBHOOK_MAX_BYTES },
			(_request, body, done) => done(null, body),
		);
		scope.post(
			WEBHOOK_PATH,
			{ bodyLimit: WEBHOOK_MAX_BYTES },
			async (request, reply) => {
				if (badSignatures.isLimited(request.ip).limited) {
					reply.header("retry-after", "60");
					throw new AppError(
						429,
						"rate_limited",
						"Too many deliveries with invalid signatures from this address",
					);
				}
				const header = (name: string) => {
					const value = request.headers[name];
					return typeof value === "string" ? value : undefined;
				};
				try {
					const result = await receiveWebhook(deps, {
						event: header("x-github-event"),
						guid: header("x-github-delivery"),
						signature: header("x-hub-signature-256"),
						body: Buffer.isBuffer(request.body)
							? request.body
							: Buffer.alloc(0),
					});
					return reply.status(result.status).send(result.body);
				} catch (error) {
					if (
						error instanceof AppError &&
						error.code === "webhook_signature_invalid"
					)
						badSignatures.take(request.ip);
					throw error;
				}
			},
		);
	});
}
