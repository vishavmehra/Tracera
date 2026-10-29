import {
	ConfirmMeetingCandidateRequestSchema,
	DismissMeetingCandidateRequestSchema,
	type IdPrefix,
	ImportMeetingRequestSchema,
	idSchema,
	MeetingListQuerySchema,
	MeetingSegmentsQuerySchema,
	UpdateMeetingCandidateRequestSchema,
	UpdateMeetingRequestSchema,
	UploadMeetingTranscriptRequestSchema,
} from "@tracera/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, createRateLimiter } from "../lib/http.ts";
import { requireScope, requireSession } from "../modules/auth.ts";
import {
	completeGoogleConnect,
	disconnectIntegration,
	importProviderMeeting,
	listIntegrations,
	listProviderMeetings,
	startGoogleConnect,
} from "../modules/meeting-integrations.ts";
import {
	confirmCandidate,
	deleteMeeting,
	dismissCandidate,
	getMeetingView,
	listCandidates,
	listMeetings,
	listSegments,
	meetingSummary,
	requestExtraction,
	updateCandidate,
	updateMeeting,
	uploadMeetingTranscript,
} from "../modules/meetings.ts";
import { type AppDeps, authOf } from "./app.ts";

/** A 5 MB transcript is about 7 MB as base64; the rest of the API keeps the 1 MB body limit. */
const UPLOAD_BODY_LIMIT = 7.5 * 1024 * 1024;
const SummaryQuerySchema = z.object({
	format: z.enum(["json", "markdown"]).default("json"),
});
const CallbackQuerySchema = z.object({
	code: z.string().max(2000).optional(),
	state: z.string().max(200).optional(),
	error: z.string().max(200).optional(),
});

/** Meetings and meeting integrations. Reads accept reports:read tokens; every change needs a session. */
export function registerMeetingRoutes(app: FastifyInstance, deps: AppDeps) {
	const { db, config } = deps;
	const limits = {
		upload: createRateLimiter({ limit: 10, windowMs: 3_600_000 }), // per user
		extraction: createRateLimiter({ limit: 20, windowMs: 60_000 }), // model calls, per workspace
		confirmation: createRateLimiter({ limit: 30, windowMs: 60_000 }), // investigations, per workspace
	};
	const throttle = (
		reply: FastifyReply,
		kind: keyof typeof limits,
		key: string,
	) => {
		const result = limits[kind].take(key);
		if (result.allowed) return;
		reply.header("retry-after", String(result.retryAfterSeconds));
		throw new AppError(
			429,
			"rate_limited",
			`Too many meeting ${kind} requests; try again in ${result.retryAfterSeconds} s`,
		);
	};
	const param = (
		request: FastifyRequest,
		name: string,
		prefix: IdPrefix,
		label: string,
	) => {
		const value =
			(request.params as Record<string, string | undefined>)[name] ?? "";
		if (!idSchema(prefix).safeParse(value).success)
			throw new AppError(404, "not_found", `${label} ${value} was not found`);
		return value;
	};
	const meetingId = (request: FastifyRequest) =>
		param(request, "id", "mtg", "Meeting");
	const candidateId = (request: FastifyRequest) =>
		param(request, "candidateId", "cand", "Candidate");
	const idempotencyKey = (request: FastifyRequest) => {
		const value = request.headers["idempotency-key"];
		return typeof value === "string" ? value : undefined;
	};
	const session = (request: FastifyRequest) => {
		const auth = authOf(request);
		requireSession(auth);
		return auth;
	};
	const reader = (request: FastifyRequest) => {
		const auth = authOf(request);
		requireScope(auth, "reports:read");
		return auth;
	};

	app.post(
		"/api/v1/meetings",
		{ bodyLimit: UPLOAD_BODY_LIMIT },
		async (request, reply) => {
			const auth = session(request);
			throttle(reply, "upload", auth.userId);
			const result = await uploadMeetingTranscript(
				deps,
				auth,
				UploadMeetingTranscriptRequestSchema.parse(request.body),
				{ requestId: request.id, idempotencyKey: idempotencyKey(request) },
			);
			return reply.status(result.status).send(result.body);
		},
	);

	app.get("/api/v1/meetings", async (request) =>
		listMeetings(
			db,
			reader(request).workspaceId,
			MeetingListQuerySchema.parse(request.query),
		),
	);

	app.get("/api/v1/meetings/:id", async (request) => ({
		meeting: await getMeetingView(
			db,
			reader(request).workspaceId,
			meetingId(request),
		),
	}));

	app.patch("/api/v1/meetings/:id", async (request) =>
		updateMeeting(
			deps,
			session(request),
			meetingId(request),
			UpdateMeetingRequestSchema.parse(request.body),
			request.id,
		),
	);

	app.delete("/api/v1/meetings/:id", async (request, reply) => {
		await deleteMeeting(deps, session(request), meetingId(request), request.id);
		return reply.status(204).send();
	});

	app.get("/api/v1/meetings/:id/segments", async (request) =>
		listSegments(
			db,
			reader(request).workspaceId,
			meetingId(request),
			MeetingSegmentsQuerySchema.parse(request.query),
		),
	);

	app.post("/api/v1/meetings/:id/extract", async (request, reply) => {
		const auth = session(request);
		throttle(reply, "extraction", auth.workspaceId);
		return reply
			.status(202)
			.send(
				await requestExtraction(deps, auth, meetingId(request), request.id),
			);
	});

	app.get("/api/v1/meetings/:id/candidates", async (request) =>
		listCandidates(db, reader(request).workspaceId, meetingId(request)),
	);

	app.patch("/api/v1/meetings/:id/candidates/:candidateId", async (request) =>
		updateCandidate(
			deps,
			session(request),
			meetingId(request),
			candidateId(request),
			UpdateMeetingCandidateRequestSchema.parse(request.body),
			request.id,
		),
	);

	app.post(
		"/api/v1/meetings/:id/candidates/:candidateId/confirm",
		async (request, reply) => {
			const auth = session(request);
			throttle(reply, "confirmation", auth.workspaceId);
			return reply
				.status(201)
				.send(
					await confirmCandidate(
						deps,
						auth,
						meetingId(request),
						candidateId(request),
						ConfirmMeetingCandidateRequestSchema.parse(request.body ?? {}),
						request.id,
					),
				);
		},
	);

	app.post(
		"/api/v1/meetings/:id/candidates/:candidateId/dismiss",
		async (request) =>
			dismissCandidate(
				deps,
				session(request),
				meetingId(request),
				candidateId(request),
				DismissMeetingCandidateRequestSchema.parse(request.body ?? {}).reason ??
					null,
				request.id,
			),
	);

	// ---- Provider integrations (Google Meet import; Microsoft listed as not implemented) ----

	app.get("/api/v1/integrations", async (request) =>
		listIntegrations(db, config, session(request)),
	);

	app.get("/api/v1/integrations/google/connect", async (request, reply) =>
		reply.redirect(startGoogleConnect(config, session(request)), 302),
	);

	app.get("/api/v1/integrations/google/callback", async (request, reply) => {
		const query = CallbackQuerySchema.parse(request.query);
		return reply.redirect(
			await completeGoogleConnect(deps, session(request), query, request.id),
			302,
		);
	});

	app.get("/api/v1/integrations/:id/meetings", async (request) =>
		listProviderMeetings(
			deps,
			session(request),
			param(request, "id", "int", "Integration"),
		),
	);

	app.post("/api/v1/integrations/:id/import", async (request, reply) => {
		const auth = session(request);
		throttle(reply, "upload", auth.userId);
		const result = await importProviderMeeting(
			deps,
			auth,
			param(request, "id", "int", "Integration"),
			ImportMeetingRequestSchema.parse(request.body),
			{ requestId: request.id, idempotencyKey: idempotencyKey(request) },
		);
		return reply.status(result.status).send(result.body);
	});

	app.delete("/api/v1/integrations/:id", async (request, reply) => {
		await disconnectIntegration(
			deps,
			session(request),
			param(request, "id", "int", "Integration"),
			request.id,
		);
		return reply.status(204).send();
	});

	app.get("/api/v1/meetings/:id/summary", async (request, reply) => {
		const { format } = SummaryQuerySchema.parse(request.query);
		const summary = await meetingSummary(
			db,
			config,
			reader(request).workspaceId,
			meetingId(request),
		);
		if (format === "markdown")
			return reply
				.header("content-type", "text/markdown; charset=utf-8")
				.send(summary.markdown);
		return { summary };
	});
}
