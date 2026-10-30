import path from "node:path";
import {
	type ImageEvidenceMimeType,
	MAX_IMAGE_EVIDENCE_BYTES,
	type ScreenshotEvidenceMeta,
} from "@tracera/contracts";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { bugReports, evidenceAssets } from "../db/schema.ts";
import { putBlob } from "../lib/fs.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { audit } from "./audit.ts";
import { type AuthContext, actorOf, sourceChannelOf } from "./auth.ts";
import { stripUrl } from "./bug-reports.ts";
import { idempotent } from "./idempotency.ts";

const EVIDENCE_RETENTION_DAYS = 90;

/** The image type named by the file's magic bytes; null for anything else (SVG, HTML, executables...). */
export function detectImageType(
	bytes: Uint8Array,
): ImageEvidenceMimeType | null {
	const has = (signature: number[], offset = 0) =>
		bytes.length >= offset + signature.length &&
		signature.every((byte, i) => bytes[offset + i] === byte);
	if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (has([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8))
		return "image/webp";
	return null;
}

/**
 * Stores a screenshot for a bug report. The stored type is the detected one; a
 * declared type that disagrees with the bytes is rejected. Page context and redaction regions are kept
 * as client-reported provenance: the server cannot see what the client blacked out.
 */
export async function addScreenshotEvidence(
	deps: { pool: pg.Pool; db: Db; config: Config },
	ctx: AuthContext,
	bugReportId: string,
	file: { bytes: Buffer; declaredType: string; name: string },
	meta: ScreenshotEvidenceMeta,
	request: { requestId: string; idempotencyKey: string | undefined },
) {
	const [report] = await deps.db
		.select({ id: bugReports.id })
		.from(bugReports)
		.where(
			and(
				eq(bugReports.id, bugReportId),
				eq(bugReports.workspaceId, ctx.workspaceId),
			),
		)
		.limit(1);
	if (!report)
		throw new AppError(
			404,
			"not_found",
			`Bug report ${bugReportId} was not found`,
		);
	if (file.bytes.length > MAX_IMAGE_EVIDENCE_BYTES)
		throw new AppError(413, "payload_too_large", "Images are limited to 10 MB");
	const mimeType = detectImageType(file.bytes);
	if (!mimeType)
		throw new AppError(
			415,
			"unsupported_media_type",
			"Only PNG, JPEG, and WebP images are accepted",
		);
	const declared = file.declaredType.split(";")[0]?.trim().toLowerCase();
	if (
		declared &&
		declared !== "application/octet-stream" &&
		declared !== mimeType
	)
		throw new AppError(
			415,
			"unsupported_media_type",
			`The file content is ${mimeType}, not the declared ${declared}`,
		);
	// Content-addressed and written before the transaction; a rollback can only leave an unreferenced blob.
	const blob = await putBlob(
		path.join(deps.config.dataDir, "blobs"),
		file.bytes,
	);
	const actor = actorOf(ctx);
	return idempotent(
		deps,
		{
			workspaceId: ctx.workspaceId,
			actorId: actor.id ?? ctx.userId,
			key: request.idempotencyKey,
			methodPath: `POST /api/v1/bug-reports/${bugReportId}/evidence`,
			body: { meta, sha256: blob.sha256 },
		},
		async ({ db }) => {
			const [row] = await db
				.insert(evidenceAssets)
				.values({
					id: newId("evd"),
					workspaceId: ctx.workspaceId,
					bugReportId,
					kind: "screenshot",
					origin:
						ctx.kind === "token" && ctx.clientKind === "extension"
							? "captured_by_extension"
							: "user_provided",
					blobSha256: blob.sha256,
					mimeType,
					sizeBytes: blob.size,
					originalFilename: file.name.slice(0, 200) || null,
					capturedAt: meta.captured_at ? new Date(meta.captured_at) : null,
					provenance: {
						channel: sourceChannelOf(ctx),
						captured_by_user_id: ctx.userId,
						...(meta.page_url && { page_url: stripUrl(meta.page_url, false) }),
						...(meta.page_title && { page_title: meta.page_title }),
						...(meta.viewport && { viewport: meta.viewport }),
						...(meta.device_pixel_ratio && {
							device_pixel_ratio: meta.device_pixel_ratio,
						}),
						...(meta.client_annotations && {
							client_annotations: meta.client_annotations,
						}),
					},
					redactions: {
						applied_by: "client",
						regions: meta.client_redactions ?? [],
					},
					retentionUntil: new Date(
						Date.now() + EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
					),
				})
				.returning();
			if (!row)
				throw new AppError(500, "internal_error", "Evidence was not stored");
			await audit(db, {
				workspaceId: ctx.workspaceId,
				actor,
				action: "evidence.uploaded",
				targetType: "evidence_asset",
				targetId: row.id,
				metadata: {
					bug_report_id: bugReportId,
					kind: row.kind,
					mime_type: mimeType,
					size_bytes: blob.size,
					client_redactions: meta.client_redactions?.length ?? 0,
				},
				requestId: request.requestId,
			});
			return {
				status: 201,
				body: {
					evidence: {
						id: row.id,
						kind: row.kind,
						origin: row.origin,
						mime_type: row.mimeType,
						size_bytes: row.sizeBytes,
						captured_at: row.capturedAt?.toISOString() ?? null,
						captured_at_client_reported: row.capturedAt !== null,
						provenance: row.provenance,
						content_url: null, // no download endpoint yet
						created_at: row.createdAt.toISOString(),
					},
				},
			};
		},
	);
}
