import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { ZodError } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { AppError, problemBody } from "../lib/http.ts";
import { type AuthContext, authenticateRequest } from "../modules/auth.ts";
import { evidenceRoutes } from "./evidence-routes.ts";
import { registerRoutes } from "./routes.ts";

declare module "fastify" {
	interface FastifyRequest {
		auth: AuthContext | null;
	}
}

/** The API never talks to Docker; sandbox availability is reported by workers (worker_heartbeats). */
export type AppDeps = {
	config: Config;
	pool: pg.Pool;
	db: Db;
	boss: PgBoss;
};

export function authOf(request: FastifyRequest): AuthContext {
	if (!request.auth)
		throw new AppError(
			401,
			"unauthenticated",
			"Sign in or provide a valid personal access token",
		);
	return request.auth;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
	const { config } = deps;
	const app = Fastify({
		trustProxy: config.api.trustProxy,
		logger:
			config.logLevel === "silent"
				? false
				: {
						level: config.logLevel,
						redact: {
							paths: [
								"req.headers.authorization",
								"req.headers.cookie",
								'res.headers["set-cookie"]',
							],
							censor: "[REDACTED]",
						},
					},
		bodyLimit: 1_048_576,
		requestIdHeader: false,
		genReqId: (req) => {
			const incoming = req.headers["x-request-id"];
			return typeof incoming === "string" &&
				/^[A-Za-z0-9._-]{1,64}$/.test(incoming)
				? incoming
				: randomUUID();
		},
	});

	app.decorateRequest("auth", null);
	app.addHook("onSend", async (request, reply) => {
		reply.header("x-request-id", request.id);
	});
	app.addHook("preHandler", async (request) => {
		// Decide by the matched route too: the router also matches percent-encoded and absolute-form
		// spellings (`/%61pi/v1/…`, `http://host/api/v1/…`) whose raw URL has another prefix.
		if (
			!request.url.startsWith("/api/v1/") &&
			!request.routeOptions.url?.startsWith("/api/v1/")
		)
			return;
		const isLogin = request.routeOptions.url === "/api/v1/auth/login";
		if (!isLogin) {
			request.auth = await authenticateRequest(deps.db, {
				authorization: request.headers.authorization,
				cookie: request.headers.cookie,
			});
			if (!request.auth)
				throw new AppError(
					401,
					"unauthenticated",
					"Sign in or provide a valid personal access token",
				);
		}
		const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
		// Cookies are ambient credentials: require a custom header and same-origin for mutations.
		if (mutating && (isLogin || request.auth?.kind === "session")) {
			if (
				request.headers["x-tracera-csrf"] !== "1" ||
				request.headers.origin !== config.api.publicOrigin
			) {
				throw new AppError(
					403,
					"csrf_failed",
					"Cookie-authenticated changes require the X-Tracera-CSRF header and a same-origin request",
				);
			}
		}
	});

	app.setErrorHandler((error, request, reply) => {
		const appError = toAppError(error);
		if (appError.status >= 500)
			request.log.error({ err: error }, "request failed");
		return reply
			.status(appError.status)
			.header("content-type", "application/problem+json")
			.send(problemBody(appError, request.id));
	});
	app.setNotFoundHandler((request, reply) =>
		reply
			.status(404)
			.header("content-type", "application/problem+json")
			.send(
				problemBody(
					new AppError(
						404,
						"not_found",
						`No route for ${request.method} ${request.url.split("?")[0]}`,
					),
					request.id,
				),
			),
	);

	// Own plugin scope: the multipart parser and the 10 MB body limit apply to the upload route only.
	app.register(async (scope) => evidenceRoutes(scope, deps));
	registerRoutes(app, deps);
	return app;
}

function toAppError(error: unknown): AppError {
	if (error instanceof AppError) return error;
	if (error instanceof ZodError) {
		return new AppError(400, "validation_failed", "The request is invalid", {
			errors: error.issues.map((issue) => ({
				path: issue.path.join("."),
				message: issue.message,
			})),
		});
	}
	const fastifyError = error as { code?: string; statusCode?: number };
	if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE")
		return new AppError(
			413,
			"payload_too_large",
			"The request body is too large",
		);
	if (fastifyError.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE")
		return new AppError(
			415,
			"unsupported_media_type",
			"Unsupported content type",
		);
	if (
		fastifyError.statusCode &&
		fastifyError.statusCode >= 400 &&
		fastifyError.statusCode < 500
	) {
		return new AppError(
			400,
			"validation_failed",
			"The request could not be parsed",
		);
	}
	return new AppError(500, "internal_error", "An unexpected error occurred");
}
