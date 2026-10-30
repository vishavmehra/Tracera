import path from "node:path";
import { idSchema, LocateRequestSchema } from "@tracera/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { withTransaction } from "../db/client.ts";
import { readBlobBytes } from "../lib/fs.ts";
import { AppError, createRateLimiter } from "../lib/http.ts";
import { audit } from "../modules/audit.ts";
import { actorOf, requireScope, requireSession } from "../modules/auth.ts";
import {
	listObservations,
	requireAsset,
	requireObservable,
} from "../modules/visual-evidence.ts";
import {
	listLocations,
	segmentationAvailable,
} from "../modules/visual-locate.ts";
import { enqueueLocate, enqueueObserve } from "../queue.ts";
import { type AppDeps, authOf } from "./app.ts";

const IMAGE_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Screenshot content, what the vision model read from it, and where a segmentation model found an element. */
export function registerVisualRoutes(app: FastifyInstance, deps: AppDeps) {
	const { db, config } = deps;
	// Each request can start a model call, so reading is limited per workspace and minute.
	const reads = createRateLimiter({ limit: 20, windowMs: 60_000 });
	const images = createRateLimiter({ limit: 300, windowMs: 60_000 });
	const evidenceId = (request: FastifyRequest) => {
		const id = (request.params as { id?: string }).id ?? "";
		if (!idSchema("evd").safeParse(id).success)
			throw new AppError(404, "not_found", `Evidence ${id} was not found`);
		return id;
	};

	app.get("/api/v1/evidence/:id/observations", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "reports:read");
		return listObservations(deps, auth.workspaceId, evidenceId(request));
	});

	app.post("/api/v1/evidence/:id/observations", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "reports:write");
		const quota = reads.take(auth.workspaceId);
		if (!quota.allowed) {
			reply.header("retry-after", String(quota.retryAfterSeconds));
			throw new AppError(
				429,
				"rate_limited",
				`Too many screenshot reads for this workspace; try again in ${quota.retryAfterSeconds} s`,
			);
		}
		const asset = await requireAsset(db, auth.workspaceId, evidenceId(request));
		requireObservable(asset);
		await withTransaction(deps.pool, async ({ db: tx, queueDb }) => {
			await enqueueObserve(deps.boss, queueDb, {
				evidenceId: asset.id,
				workspaceId: asset.workspaceId,
			});
			await audit(tx, {
				workspaceId: asset.workspaceId,
				actor: actorOf(auth),
				action: "evidence.observation_requested",
				targetType: "evidence_asset",
				targetId: asset.id,
				requestId: request.id,
			});
		});
		return reply.status(202).send({ job: { status: "queued" } });
	});

	app.get("/api/v1/evidence/:id/locations", async (request) => {
		const auth = authOf(request);
		requireScope(auth, "reports:read");
		return listLocations(deps, auth.workspaceId, evidenceId(request));
	});

	// A person asks where an element is; the model's answer is a display aid, so only a session may ask.
	app.post("/api/v1/evidence/:id/locate", async (request, reply) => {
		const auth = authOf(request);
		requireSession(auth);
		const input = LocateRequestSchema.parse(request.body);
		const asset = await requireAsset(db, auth.workspaceId, evidenceId(request));
		requireObservable(asset);
		if (!segmentationAvailable(config))
			throw new AppError(
				409,
				"capability_unavailable",
				"The configured inference provider has no segmentation model",
			);
		const quota = reads.take(auth.workspaceId);
		if (!quota.allowed) {
			reply.header("retry-after", String(quota.retryAfterSeconds));
			throw new AppError(
				429,
				"rate_limited",
				`Too many screenshot reads for this workspace; try again in ${quota.retryAfterSeconds} s`,
			);
		}
		await withTransaction(deps.pool, async ({ db: tx, queueDb }) => {
			await enqueueLocate(deps.boss, queueDb, {
				evidenceId: asset.id,
				workspaceId: asset.workspaceId,
				phrase: input.phrase,
			});
			await audit(tx, {
				workspaceId: asset.workspaceId,
				actor: actorOf(auth),
				action: "evidence.location_requested",
				targetType: "evidence_asset",
				targetId: asset.id,
				requestId: request.id,
			});
		});
		return reply.status(202).send({ job: { status: "queued" } });
	});

	// Images only: the stored type is the one the bytes proved at upload, and the response cannot run script.
	app.get("/api/v1/evidence/:id/content", async (request, reply) => {
		const auth = authOf(request);
		requireScope(auth, "reports:read");
		const quota = images.take(auth.workspaceId);
		if (!quota.allowed) {
			reply.header("retry-after", String(quota.retryAfterSeconds));
			throw new AppError(429, "rate_limited", "Too many image requests");
		}
		const asset = await requireAsset(db, auth.workspaceId, evidenceId(request));
		if (!IMAGE_CONTENT_TYPES.has(asset.mimeType))
			throw new AppError(
				415,
				"unsupported_media_type",
				"Only image evidence can be shown here",
			);
		const bytes = await readBlobBytes(
			path.join(config.dataDir, "blobs"),
			asset.blobSha256,
		);
		if (!bytes)
			throw new AppError(
				404,
				"not_found",
				"The evidence content is not available",
			);
		return reply
			.type(asset.mimeType)
			.header("x-content-type-options", "nosniff")
			.header("content-security-policy", "default-src 'none'; sandbox")
			.header("cache-control", "private, max-age=3600")
			.send(bytes);
	});
}
