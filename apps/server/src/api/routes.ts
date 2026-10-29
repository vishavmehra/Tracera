import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import {
	ApprovalRequestSchema,
	AskQuestionRequestSchema,
	BugReportListQuerySchema,
	ChangeImpactRequestSchema,
	CreateAssessmentRequestSchema,
	CreateBugReportRequestSchema,
	CreateInvestigationRequestSchema,
	CreateRepositoryRequestSchema,
	CreateTokenRequestSchema,
	DeleteRepositoryQuerySchema,
	DependencySnapshotListQuerySchema,
	GetInvestigationQuerySchema,
	GraphHistoryQuerySchema,
	GraphImpactQuerySchema,
	GraphNeighborsQuerySchema,
	GraphNodeSearchQuerySchema,
	GraphTraceQuerySchema,
	type IdPrefix,
	IndexRepositoryRequestSchema,
	InvestigationListQuerySchema,
	idSchema,
	LoginRequestSchema,
	MapStackTraceRequestSchema,
	PatchImpactListQuerySchema,
	PatchImpactRequestSchema,
	PrepareDependenciesRequestSchema,
	RepositorySearchQuerySchema,
	UpdateRepositoryRequestSchema,
} from "@tracera/contracts";
import { desc, gt } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { dataApiExposure } from "../db/migrate.ts";
import { workerHeartbeats } from "../db/schema.ts";
import { AppError, createRateLimiter, serializeCookie } from "../lib/http.ts";
import {
	askQuestion,
	createAssessment,
	getAssessment,
} from "../modules/assessment.ts";
import { audit } from "../modules/audit.ts";
import {
	actorOf,
	createApiToken,
	describeMe,
	listApiTokens,
	login,
	logout,
	requireOwner,
	requireScope,
	requireSession,
	revokeApiToken,
	SESSION_COOKIE,
	SESSION_TTL_SECONDS,
} from "../modules/auth.ts";
import {
	createBugReport,
	getBugReport,
	listBugReports,
} from "../modules/bug-reports.ts";
import {
	cancelDependencySnapshot,
	createDependencySnapshot,
	getDependencySnapshot,
	listDependencySnapshots,
} from "../modules/dependencies.ts";
import { cancelIndex, requestIndex } from "../modules/graph.ts";
import {
	analyzeImpact,
	mapStackTrace,
	nodeHistory,
	traceFlow,
} from "../modules/graph-insights.ts";
import {
	getGraphEdge,
	getGraphNode,
	getRepositoryProfile,
	graphImpact,
	graphNeighbors,
	listSnapshots,
	searchGraphNodes,
	searchRepository,
} from "../modules/graph-queries.ts";
import {
	cancelInvestigation,
	createInvestigation,
	getInvestigation,
	listInvestigations,
	listModelExecutions,
	retryInvestigation,
} from "../modules/investigations.ts";
import {
	cancelPatchAnalysis,
	createPatchAnalysis,
	getPatchAnalysis,
	getPatchAnalysisReport,
	listPatchAnalyses,
} from "../modules/patch-analysis.ts";
import {
	deleteRepository,
	getRepository,
	listRepositories,
	registerRepository,
	updateRepository,
} from "../modules/repositories.ts";
import {
	decidePatch,
	getFindings,
	getPatch,
	getPatchDiff,
	getReport,
	getVerification,
	listPatches,
	listReproductions,
} from "../modules/results.ts";
import { type AppDeps, authOf } from "./app.ts";
import { registerMcpGuards } from "./mcp.ts";

const ReportQuerySchema = z.object({
	format: z.enum(["json", "markdown"]).default("json"),
});

/** Implemented routes. Anything else is a 404 problem response, never a placeholder. */
export function registerRoutes(app: FastifyInstance, deps: AppDeps) {
	const { db, config } = deps;
	registerMcpGuards(app, db); // MCP tokens: per-token rate limits and mcp.tool_called audit
	const failedLoginsByIp = createRateLimiter({ limit: 10, windowMs: 60_000 });
	const failedLoginsByEmail = createRateLimiter({
		limit: 50,
		windowMs: 3_600_000,
	});
	const secureCookie = config.api.publicUrl.startsWith("https://");
	// Expensive operations (git, model calls, sandbox work) per workspace and minute.
	const quotas = {
		index: createRateLimiter({ limit: 20, windowMs: 60_000 }),
		analysis: createRateLimiter({ limit: 20, windowMs: 60_000 }),
		search: createRateLimiter({ limit: 120, windowMs: 60_000 }),
		intake: createRateLimiter({ limit: 60, windowMs: 60_000 }),
	};
	const throttle = (
		reply: FastifyReply,
		quota: keyof typeof quotas,
		workspaceId: string,
	) => {
		const result = quotas[quota].take(workspaceId);
		if (result.allowed) return;
		reply.header("retry-after", String(result.retryAfterSeconds));
		throw new AppError(
			429,
			"rate_limited",
			`Too many ${quota} requests for this workspace; try again in ${result.retryAfterSeconds} s`,
		);
	};
	const idempotencyKey = (request: FastifyRequest) => {
		const value = request.headers["idempotency-key"];
		return typeof value === "string" ? value : undefined;
	};
	const param = (request: FastifyRequest, prefix: IdPrefix, label: string) => {
		const id = (request.params as { id?: string }).id ?? "";
		if (!idSchema(prefix).safeParse(id).success)
			throw new AppError(404, "not_found", `${label} ${id} was not found`);
		return id;
	};

	app.get("/healthz", async () => ({ status: "ok" }));

	app.get("/readyz", async (_request, reply) => {
		const blobs = path.join(config.dataDir, "blobs");
		const database = await deps.pool.query("select 1").then(
			() => "ok",
			() => "unavailable",
		);
		const blobStore = await mkdir(blobs, { recursive: true })
			.then(() => access(blobs, constants.W_OK))
			.then(
				() => "ok",
				() => "unavailable",
			);
		// Hosted Postgres (Supabase) serves `public` over HTTP; Tracera's tables must stay locked down.
		const exposed =
			database === "ok"
				? await dataApiExposure(deps.pool).catch(() => null)
				: null;
		const dataApi =
			exposed === null
				? "unknown"
				: exposed.length === 0
					? "locked_down"
					: "exposed";
		const ready =
			database === "ok" && blobStore === "ok" && dataApi === "locked_down";
		// Workers publish liveness and sandbox availability; the API itself never calls Docker.
		const [worker] =
			database === "ok"
				? await db
						.select()
						.from(workerHeartbeats)
						.where(
							gt(workerHeartbeats.updatedAt, new Date(Date.now() - 60_000)),
						)
						.orderBy(desc(workerHeartbeats.updatedAt))
						.limit(1)
						.catch(() => [])
				: [];
		return reply.status(ready ? 200 : 503).send({
			status: ready ? "ready" : "not_ready",
			database,
			data_api_exposure: dataApi,
			blob_store: blobStore,
			worker: worker ? "ok" : "not_running",
			sandbox: worker?.sandbox ?? null,
			inference_provider: config.inference.providerName,
			inference_mode: config.inference.provider,
		});
	});

	// ---- Auth and tokens ----
	app.post("/api/v1/auth/login", async (request, reply) => {
		const input = LoginRequestSchema.parse(request.body);
		for (const limit of [
			failedLoginsByIp.isLimited(request.ip),
			failedLoginsByEmail.isLimited(input.email),
		]) {
			if (limit.limited) {
				reply.header("retry-after", String(limit.retryAfterSeconds));
				throw new AppError(
					429,
					"rate_limited",
					"Too many failed login attempts; try again later",
				);
			}
		}
		const result = await login(db, input, {
			ip: request.ip,
			userAgent: request.headers["user-agent"],
		});
		if (!result) {
			failedLoginsByIp.take(request.ip);
			failedLoginsByEmail.take(input.email);
			request.log.info({ event: "auth.login_failed" }, "login failed");
			throw new AppError(
				401,
				"invalid_credentials",
				"Email or password is incorrect",
			);
		}
		await audit(db, {
			workspaceId: result.workspace.id,
			actor: { type: "user", id: result.user.id },
			action: "auth.login_succeeded",
			targetType: "user",
			targetId: result.user.id,
			metadata: { ip: request.ip },
			requestId: request.id,
		});
		reply.header(
			"set-cookie",
			serializeCookie(SESSION_COOKIE, result.secret, {
				maxAgeSeconds: SESSION_TTL_SECONDS,
				secure: secureCookie,
			}),
		);
		return { user: result.user, workspace: result.workspace };
	});

	app.post("/api/v1/auth/logout", async (request, reply) => {
		const auth = authOf(request);
		requireSession(auth);
		await logout(db, auth.sessionId);
		reply.header(
			"set-cookie",
			serializeCookie(SESSION_COOKIE, "", {
				maxAgeSeconds: 0,
				secure: secureCookie,
			}),
		);
		return reply.status(204).send();
	});

	app.get("/api/v1/auth/me", async (request) =>
		describeMe(db, authOf(request)),
	);

	app.post("/api/v1/tokens", async (request, reply) => {
		const auth = authOf(request);
		requireSession(auth);
		const input = CreateTokenRequestSchema.parse(request.body);
		const created = await createApiToken(db, auth, input);
		await audit(db, {
			workspaceId: auth.workspaceId,
			actor: actorOf(auth),
			action: "token.created",
			targetType: "api_token",
			targetId: created.token.id,
			metadata: {
				client_kind: input.client_kind,
				scopes: created.token.scopes,
			},
			requestId: request.id,
		});
		return reply.status(201).send(created);
	});

	app.get("/api/v1/tokens", async (request) => {
		const auth = authOf(request);
		requireSession(auth);
		return { items: await listApiTokens(db, auth) };
	});

	app.delete("/api/v1/tokens/:id", async (request, reply) => {
		const auth = authOf(request);
		requireSession(auth);
		const id = param(request, "tok", "Token");
		if (!(await revokeApiToken(db, auth, id)))
			throw new AppError(404, "not_found", `Token ${id} was not found`);
		await audit(db, {
			workspaceId: auth.workspaceId,
			actor: actorOf(auth),
			action: "token.revoked",
			targetType: "api_token",
			targetId: id,
			requestId: request.id,
		});
		return reply.status(204).send();
	});

	// ---- Repositories ----
	app.get("/api/v1/repositories", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return {
			items: await listRepositories(db, auth.workspaceId),
			next_cursor: null,
		};
	});

	app.post("/api/v1/repositories", async (request, reply) => {
		const auth = authOf(request);
		requireOwner(auth);
		const input = CreateRepositoryRequestSchema.parse(request.body);
		const repository = await registerRepository(deps, auth, input, request.id);
		// Background indexing starts with registration; a failure here leaves the repository usable.
		const index = await requestIndex(
			deps,
			auth,
			repository.id,
			{},
			request.id,
		).catch((error: unknown) => {
			request.log.warn(
				{
					code: error instanceof AppError ? error.code : "index_request_failed",
				},
				"initial index request failed",
			);
			return null;
		});
		return reply
			.status(201)
			.send({ repository, snapshot: index?.snapshot ?? null });
	});

	// Owner session only, like registration. The source location itself cannot change.
	app.patch("/api/v1/repositories/:id", async (request) => {
		const auth = authOf(request);
		requireOwner(auth);
		const input = UpdateRepositoryRequestSchema.parse(request.body);
		return {
			repository: await updateRepository(
				deps,
				auth,
				param(request, "repo", "Repository"),
				input,
				request.id,
			),
		};
	});

	app.delete("/api/v1/repositories/:id", async (request) => {
		const auth = authOf(request);
		requireOwner(auth);
		const { confirm } = DeleteRepositoryQuerySchema.parse(request.query);
		return deleteRepository(
			deps,
			auth,
			param(request, "repo", "Repository"),
			confirm,
			request.id,
		);
	});

	app.post("/api/v1/snapshots/:id/cancel", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		return reply
			.status(202)
			.send(
				await cancelIndex(
					db,
					auth,
					param(request, "snap", "Snapshot"),
					request.id,
				),
			);
	});

	// ---- Repository graph, profile, and search ----
	app.post("/api/v1/repositories/:id/index", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		throttle(reply, "index", auth.workspaceId);
		const input = IndexRepositoryRequestSchema.parse(request.body ?? {});
		const result = await requestIndex(
			deps,
			auth,
			param(request, "repo", "Repository"),
			input,
			request.id,
		);
		return reply.status(result.status).send({ snapshot: result.snapshot });
	});

	app.get("/api/v1/repositories/:id/snapshots", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return listSnapshots(
			db,
			auth.workspaceId,
			param(request, "repo", "Repository"),
		);
	});

	app.get("/api/v1/repositories/:id/profile", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return getRepositoryProfile(
			deps,
			auth.workspaceId,
			param(request, "repo", "Repository"),
		);
	});

	app.get("/api/v1/repositories/:id/graph/nodes", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return searchGraphNodes(
			db,
			auth.workspaceId,
			param(request, "repo", "Repository"),
			GraphNodeSearchQuerySchema.parse(request.query),
		);
	});

	app.get("/api/v1/repositories/:id/search", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		throttle(reply, "search", auth.workspaceId);
		return searchRepository(
			deps,
			auth.workspaceId,
			param(request, "repo", "Repository"),
			RepositorySearchQuerySchema.parse(request.query),
		);
	});

	app.get("/api/v1/graph/nodes/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return getGraphNode(
			deps,
			auth.workspaceId,
			param(request, "gnd", "Graph node"),
		);
	});

	app.get("/api/v1/graph/snapshots/:id/edges/:edgeId", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		const edgeId = z.coerce
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.safeParse((request.params as { edgeId?: string }).edgeId);
		if (!edgeId.success)
			throw new AppError(404, "not_found", "Graph edge was not found");
		return getGraphEdge(
			deps,
			auth.workspaceId,
			param(request, "snap", "Snapshot"),
			edgeId.data,
		);
	});

	app.get("/api/v1/graph/nodes/:id/trace", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return traceFlow(
			db,
			auth.workspaceId,
			param(request, "gnd", "Graph node"),
			GraphTraceQuerySchema.parse(request.query),
		);
	});

	app.get("/api/v1/graph/nodes/:id/history", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return nodeHistory(
			deps,
			auth.workspaceId,
			param(request, "gnd", "Graph node"),
			GraphHistoryQuerySchema.parse(request.query),
		);
	});

	// A read: the body carries the targets; nothing is stored.
	app.post("/api/v1/repositories/:id/impact", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		throttle(reply, "search", auth.workspaceId);
		return analyzeImpact(
			deps,
			auth.workspaceId,
			param(request, "repo", "Repository"),
			ChangeImpactRequestSchema.parse(request.body),
		);
	});

	// A read: the trace and logs are mapped, redacted, and returned; nothing is stored.
	app.post(
		"/api/v1/repositories/:id/stack-traces/map",
		async (request, reply) => {
			const auth = authOf(request);
			requireScope(auth, "repositories:read");
			throttle(reply, "search", auth.workspaceId);
			return mapStackTrace(
				deps,
				auth.workspaceId,
				param(request, "repo", "Repository"),
				MapStackTraceRequestSchema.parse(request.body),
			);
		},
	);

	app.get("/api/v1/graph/nodes/:id/neighbors", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return graphNeighbors(
			db,
			auth.workspaceId,
			param(request, "gnd", "Graph node"),
			GraphNeighborsQuerySchema.parse(request.query),
		);
	});

	app.get("/api/v1/graph/nodes/:id/impact", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return graphImpact(
			db,
			auth.workspaceId,
			param(request, "gnd", "Graph node"),
			GraphImpactQuerySchema.parse(request.query),
		);
	});

	// ---- Feasibility and change assessment ----
	app.post("/api/v1/repositories/:id/assessments", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		throttle(reply, "analysis", auth.workspaceId);
		const input = CreateAssessmentRequestSchema.parse(request.body);
		return reply.status(202).send({
			assessment: await createAssessment(
				deps,
				auth,
				param(request, "repo", "Repository"),
				input,
				request.id,
			),
		});
	});

	// Engineering questions are assessments of kind "question"; results come from GET /assessments/:id.
	app.post("/api/v1/repositories/:id/questions", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		throttle(reply, "analysis", auth.workspaceId);
		const input = AskQuestionRequestSchema.parse(request.body);
		return reply.status(202).send({
			assessment: await askQuestion(
				deps,
				auth,
				param(request, "repo", "Repository"),
				input,
				request.id,
			),
		});
	});

	app.get("/api/v1/assessments/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return {
			assessment: await getAssessment(
				db,
				auth.workspaceId,
				param(request, "asm", "Assessment"),
			),
		};
	});

	// ---- Patch impact: two revisions, or a diff on a base revision ----
	app.post("/api/v1/repositories/:id/patch-impact", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		throttle(reply, "analysis", auth.workspaceId);
		const input = PatchImpactRequestSchema.parse(request.body);
		const { status, analysis } = await createPatchAnalysis(
			deps,
			auth,
			param(request, "repo", "Repository"),
			input,
			request.id,
		);
		return reply.status(status).send({ analysis });
	});

	app.get("/api/v1/repositories/:id/patch-impact", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		const query = PatchImpactListQuerySchema.parse(request.query);
		return {
			analyses: await listPatchAnalyses(
				db,
				auth.workspaceId,
				param(request, "repo", "Repository"),
				query.limit,
			),
		};
	});

	app.get("/api/v1/patch-impact/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return {
			analysis: await getPatchAnalysis(
				db,
				auth.workspaceId,
				param(request, "pia", "Patch analysis"),
			),
		};
	});

	app.get("/api/v1/patch-impact/:id/report", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		const markdown = await getPatchAnalysisReport(
			db,
			auth.workspaceId,
			param(request, "pia", "Patch analysis"),
		);
		return reply
			.header("content-type", "text/markdown; charset=utf-8")
			.send(markdown);
	});

	app.post("/api/v1/patch-impact/:id/cancel", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		return reply.status(202).send({
			analysis: await cancelPatchAnalysis(
				deps,
				auth,
				param(request, "pia", "Patch analysis"),
				request.id,
			),
		});
	});

	// ---- Dependency preparation ------------------------------------------------------------------

	app.post(
		"/api/v1/repositories/:id/dependency-snapshots",
		async (request, reply) => {
			const auth = authOf(request);
			requireScope(auth, "investigations:write");
			throttle(reply, "analysis", auth.workspaceId);
			const input = PrepareDependenciesRequestSchema.parse(request.body ?? {});
			const { status, snapshot } = await createDependencySnapshot(
				deps,
				auth,
				param(request, "repo", "Repository"),
				input,
				request.id,
			);
			return reply.status(status).send({ snapshot });
		},
	);

	app.get("/api/v1/repositories/:id/dependency-snapshots", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		const query = DependencySnapshotListQuerySchema.parse(request.query);
		return {
			snapshots: await listDependencySnapshots(
				db,
				auth.workspaceId,
				param(request, "repo", "Repository"),
				query.limit,
			),
		};
	});

	app.get("/api/v1/dependency-snapshots/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return {
			snapshot: await getDependencySnapshot(
				db,
				auth.workspaceId,
				param(request, "dep", "Dependency snapshot"),
			),
		};
	});

	app.post(
		"/api/v1/dependency-snapshots/:id/cancel",
		async (request, reply) => {
			const auth = authOf(request);
			requireScope(auth, "investigations:write");
			return reply.status(202).send({
				snapshot: await cancelDependencySnapshot(
					deps,
					auth,
					param(request, "dep", "Dependency snapshot"),
					request.id,
				),
			});
		},
	);

	app.get("/api/v1/repositories/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "repositories:read");
		return {
			repository: await getRepository(
				db,
				auth.workspaceId,
				param(request, "repo", "Repository"),
			),
		};
	});

	// ---- Bug reports ----
	app.post("/api/v1/bug-reports", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "reports:write");
		throttle(reply, "intake", auth.workspaceId);
		const input = CreateBugReportRequestSchema.parse(request.body);
		const result = await createBugReport(deps, auth, input, {
			requestId: request.id,
			idempotencyKey: idempotencyKey(request),
		});
		return reply.status(result.status).send(result.body);
	});

	app.get("/api/v1/bug-reports", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "reports:read");
		return listBugReports(
			db,
			auth.workspaceId,
			BugReportListQuerySchema.parse(request.query),
		);
	});

	app.get("/api/v1/bug-reports/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "reports:read");
		return {
			bug_report: await getBugReport(
				db,
				auth.workspaceId,
				param(request, "bug", "Bug report"),
			),
		};
	});

	// ---- Investigations ----
	app.post("/api/v1/investigations", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		throttle(reply, "analysis", auth.workspaceId);
		const input = CreateInvestigationRequestSchema.parse(request.body);
		const result = await createInvestigation(deps, auth, input, {
			requestId: request.id,
			idempotencyKey: idempotencyKey(request),
		});
		return reply.status(result.status).send(result.body);
	});

	app.get("/api/v1/investigations", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return listInvestigations(
			db,
			auth.workspaceId,
			InvestigationListQuerySchema.parse(request.query),
		);
	});

	app.get("/api/v1/investigations/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		const query = GetInvestigationQuerySchema.parse(request.query);
		return {
			investigation: await getInvestigation(
				db,
				auth.workspaceId,
				param(request, "inv", "Investigation"),
				query,
			),
		};
	});

	app.post("/api/v1/investigations/:id/cancel", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		return reply
			.status(202)
			.send(
				await cancelInvestigation(
					db,
					auth,
					param(request, "inv", "Investigation"),
					request.id,
				),
			);
	});

	app.post("/api/v1/investigations/:id/retry", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:write");
		return reply
			.status(202)
			.send(
				await retryInvestigation(
					deps,
					auth,
					param(request, "inv", "Investigation"),
					request.id,
				),
			);
	});

	app.get("/api/v1/investigations/:id/model-executions", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return listModelExecutions(
			db,
			auth.workspaceId,
			param(request, "inv", "Investigation"),
		);
	});

	// ---- Investigation results ----
	app.get("/api/v1/investigations/:id/findings", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return getFindings(
			db,
			auth.workspaceId,
			param(request, "inv", "Investigation"),
		);
	});

	app.get("/api/v1/investigations/:id/reproductions", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return listReproductions(
			db,
			auth.workspaceId,
			param(request, "inv", "Investigation"),
		);
	});

	app.get("/api/v1/investigations/:id/patches", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return listPatches(
			db,
			auth.workspaceId,
			param(request, "inv", "Investigation"),
		);
	});

	app.get("/api/v1/investigations/:id/report", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		const { format } = ReportQuerySchema.parse(request.query);
		const result = await getReport(
			db,
			config,
			auth.workspaceId,
			param(request, "inv", "Investigation"),
			format,
		);
		if ("markdown" in result)
			return reply
				.header("content-type", "text/markdown; charset=utf-8")
				.send(result.markdown);
		return result;
	});

	app.get("/api/v1/patches/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return {
			patch: await getPatch(
				db,
				auth.workspaceId,
				param(request, "pat", "Patch"),
			),
		};
	});

	app.get("/api/v1/patches/:id/diff", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		const diff = await getPatchDiff(
			db,
			config,
			auth.workspaceId,
			param(request, "pat", "Patch"),
		);
		if (String(request.headers.accept ?? "").includes("text/x-diff"))
			return reply
				.header("content-type", "text/x-diff; charset=utf-8")
				.send(diff.diff);
		return diff;
	});

	// Approval is a human decision: session only, never a token or an MCP client. It changes no files.
	app.post("/api/v1/patches/:id/approval", async (request, reply) => {
		const auth = authOf(request);
		requireSession(auth);
		const input = ApprovalRequestSchema.parse(request.body);
		return reply
			.status(201)
			.send(
				await decidePatch(
					deps,
					auth,
					param(request, "pat", "Patch"),
					input,
					request.id,
				),
			);
	});

	app.get("/api/v1/verifications/:id", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "investigations:read");
		return {
			verification: await getVerification(
				db,
				auth.workspaceId,
				param(request, "ver", "Verification"),
			),
		};
	});
}
