import {
	idSchema,
	MAX_IMAGE_EVIDENCE_BYTES,
	ScreenshotEvidenceMetaSchema,
} from "@tracera/contracts";
import type { FastifyInstance } from "fastify";
import { AppError, createRateLimiter } from "../lib/http.ts";
import { actorOf, authenticateRequest, requireScope } from "../modules/auth.ts";
import { addScreenshotEvidence } from "../modules/evidence.ts";
import { type AppDeps, authOf } from "./app.ts";

/** The largest accepted image plus room for the multipart framing and the `meta` part. */
const MAX_UPLOAD_BODY_BYTES = MAX_IMAGE_EVIDENCE_BYTES + 256 * 1024;

const invalid = (detail: string) =>
	new AppError(400, "validation_failed", detail);

/**
 * `POST /api/v1/bug-reports/{id}/evidence`: exactly one `file` part and one `meta`
 * JSON part, parsed by the runtime's own multipart parser (no extra dependency). Registered in its own
 * plugin so the multipart parser and the larger body limit apply to this route only.
 */
export async function evidenceRoutes(app: FastifyInstance, deps: AppDeps) {
	const uploads = createRateLimiter({ limit: 30, windowMs: 60_000 });
	app.addContentTypeParser(
		"multipart/form-data",
		{ parseAs: "buffer", bodyLimit: MAX_UPLOAD_BODY_BYTES },
		(_request, body, done) => done(null, body),
	);
	app.post(
		"/api/v1/bug-reports/:id/evidence",
		{
			bodyLimit: MAX_UPLOAD_BODY_BYTES,
			// Runs before the body is read, so an unauthenticated or unscoped client cannot make the server
			// buffer 10 MB. The app-wide preHandler still runs afterwards and applies the CSRF rule.
			onRequest: async (request, reply) => {
				const auth = await authenticateRequest(deps.db, {
					authorization: request.headers.authorization,
					cookie: request.headers.cookie,
				});
				if (!auth)
					throw new AppError(
						401,
						"unauthenticated",
						"Sign in or provide a valid personal access token",
					);
				requireScope(auth, "reports:write");
				const quota = uploads.take(`${auth.workspaceId}:${actorOf(auth).id}`);
				if (!quota.allowed) {
					reply.header("retry-after", String(quota.retryAfterSeconds));
					throw new AppError(
						429,
						"rate_limited",
						`Too many evidence uploads; try again in ${quota.retryAfterSeconds} s`,
					);
				}
			},
		},
		async (request, reply) => {
			const auth = authOf(request);
			const id = (request.params as { id?: string }).id ?? "";
			if (!idSchema("bug").safeParse(id).success)
				throw new AppError(404, "not_found", `Bug report ${id} was not found`);
			if (!Buffer.isBuffer(request.body))
				throw new AppError(
					415,
					"unsupported_media_type",
					"Upload evidence as multipart/form-data",
				);
			const form = await new Response(new Uint8Array(request.body), {
				headers: { "content-type": request.headers["content-type"] ?? "" },
			})
				.formData()
				.catch(() => {
					throw invalid("The multipart body could not be parsed");
				});
			const files = form.getAll("file");
			const metas = form.getAll("meta");
			const file = files[0];
			const metaText = metas[0];
			if (
				[...form.keys()].some((key) => key !== "file" && key !== "meta") ||
				files.length !== 1 ||
				metas.length !== 1 ||
				!(file instanceof File) ||
				typeof metaText !== "string"
			)
				throw invalid("Send exactly one file part and one meta part");
			let metaJson: unknown;
			try {
				metaJson = JSON.parse(metaText);
			} catch {
				throw invalid("The meta part is not JSON");
			}
			const meta = ScreenshotEvidenceMetaSchema.safeParse(metaJson);
			if (!meta.success)
				throw new AppError(
					400,
					"validation_failed",
					"The meta part is invalid",
					{
						errors: meta.error.issues.map((issue) => ({
							path: ["meta", ...issue.path].join("."),
							message: issue.message,
						})),
					},
				);
			const idempotencyKey = request.headers["idempotency-key"];
			const result = await addScreenshotEvidence(
				deps,
				auth,
				id,
				{
					bytes: Buffer.from(await file.arrayBuffer()),
					declaredType: file.type,
					name: file.name,
				},
				meta.data,
				{
					requestId: request.id,
					idempotencyKey:
						typeof idempotencyKey === "string" ? idempotencyKey : undefined,
				},
			);
			return reply.status(result.status).send(result.body);
		},
	);
}
