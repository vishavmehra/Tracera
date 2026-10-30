import {
	type EvidenceLocation,
	type EvidenceLocationsResponse,
	type LocatedBox,
	LocatedBoxSchema,
	LocationProvenanceSchema,
} from "@tracera/contracts";
import type { Config } from "../config.ts";
import { evidenceAssets } from "../db/schema.ts";
import { InferenceError } from "../inference/gateway.ts";
import { createSegmenter, LOCATE_TASK } from "../inference/segmentation.ts";
import { putBlob, readBlobBytes, readBlobUtf8 } from "../lib/fs.ts";
import { newId } from "../lib/ids.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import { workspaceGatewayDeps } from "./normalization.ts";
import {
	blobsDir,
	derivedRows,
	findAsset,
	isObservableImage,
	requireAsset,
	requireObservable,
	type VisualDeps,
} from "./visual-evidence.ts";

/** Only Meta hosts a segmentation model; every other provider answers `capability_unavailable`. */
export const segmentationAvailable = (config: Pick<Config, "inference">) =>
	config.inference.provider === "meta";

type StoredLocation = EvidenceLocation;

/**
 * Locates the element a short noun phrase names in one screenshot and stores the boxes as derived
 * evidence (`ai_annotation`, `generated_by_model`). The result is a display aid: where a model says
 * something is, never a statement that a defect exists. Returns null when the screenshot is not
 * readable evidence of this workspace.
 */
export async function locateInEvidence(
	deps: VisualDeps,
	options: {
		workspaceId: string;
		evidenceId: string;
		phrase: string;
		signal?: AbortSignal | undefined;
	},
): Promise<StoredLocation | null> {
	const asset = await findAsset(
		deps.db,
		options.workspaceId,
		options.evidenceId,
	);
	if (!asset || !isObservableImage(asset)) return null;
	const segmenter = createSegmenter(
		workspaceGatewayDeps(
			deps,
			{ workspaceId: asset.workspaceId, bugReportId: asset.bugReportId },
			{ model: deps.config.inference.segmentModel },
		),
	);
	const bytes = await readBlobBytes(blobsDir(deps.config), asset.blobSha256);
	let phrase = options.phrase;
	let boxes: LocatedBox[] = [];
	let error: { code: string; message: string } | null = null;
	let modelExecutionId: string | null = null;
	if (!bytes) {
		error = {
			code: "evidence_content_unavailable",
			message: "The stored screenshot could not be read",
		};
	} else {
		try {
			const result = await segmenter.locate({
				phrase,
				image: { bytes, declaredType: asset.mimeType },
				signal: options.signal,
			});
			phrase = result.phrase;
			modelExecutionId = result.modelExecutionId;
			boxes = result.boxes;
		} catch (caught) {
			if (!(caught instanceof InferenceError) || caught.code === "cancelled")
				throw caught;
			modelExecutionId = caught.modelExecutionId;
			error = { code: caught.code, message: caught.message };
		}
	}
	const kind = segmenter.providerKind;
	const provenance = {
		task: LOCATE_TASK.name,
		prompt_version: LOCATE_TASK.promptVersion,
		model: segmenter.model,
		provider: segmenter.providerName,
		provider_kind: kind,
		mode: kind === "mock" ? "mock" : "live",
		placeholder_provider: kind === "openai_compatible",
		model_execution_id: modelExecutionId,
		source_evidence_id: asset.id,
		source_sha256: asset.blobSha256,
		phrase,
		status: error ? "failed" : "succeeded",
		error,
	};
	const blob = await putBlob(
		blobsDir(deps.config),
		Buffer.from(
			JSON.stringify({ schema: "ui_element_location.v1", phrase, boxes }),
		),
	);
	const id = newId("evd");
	await deps.db.insert(evidenceAssets).values({
		id,
		workspaceId: asset.workspaceId,
		bugReportId: asset.bugReportId,
		investigationId: asset.investigationId,
		derivedFromEvidenceId: asset.id,
		kind: "ai_annotation",
		origin: "generated_by_model",
		blobSha256: blob.sha256,
		mimeType: "application/json",
		sizeBytes: blob.size,
		provenance,
		retentionUntil: asset.retentionUntil,
	});
	await audit(deps.db, {
		workspaceId: asset.workspaceId,
		actor: WORKER_ACTOR,
		action: "evidence.located",
		targetType: "evidence_asset",
		targetId: asset.id,
		metadata: {
			derived_evidence_id: id,
			status: provenance.status,
			provider: provenance.provider,
			model: provenance.model,
			mode: provenance.mode,
			model_execution_id: modelExecutionId,
			found: boxes.length,
			...(error ? { code: error.code } : {}),
		},
	});
	const [stored] = await readLocations(deps, asset.workspaceId, asset.id, 1);
	if (!stored) throw new Error("location vanished after it was stored");
	return stored;
}

async function readLocations(
	deps: Pick<VisualDeps, "db" | "config">,
	workspaceId: string,
	evidenceId: string,
	limit: number,
): Promise<StoredLocation[]> {
	const rows = await derivedRows(
		deps.db,
		workspaceId,
		evidenceId,
		LOCATE_TASK.name,
		limit,
	);
	const locations = await Promise.all(
		rows.map(async (row): Promise<StoredLocation | null> => {
			const provenance = LocationProvenanceSchema.safeParse(row.provenance);
			if (!provenance.success) return null;
			const failed = row.provenance.status === "failed";
			let boxes: LocatedBox[] = [];
			if (!failed) {
				try {
					const stored = JSON.parse(
						(await readBlobUtf8(blobsDir(deps.config), row.blobSha256)) ??
							"null",
					) as { boxes?: unknown } | null;
					boxes = LocatedBoxSchema.array().parse(stored?.boxes);
				} catch {
					return {
						id: row.id,
						phrase: provenance.data.phrase,
						status: "failed",
						provenance: provenance.data,
						boxes: [],
						error: {
							code: "location_unavailable",
							message: "The stored location could not be read",
						},
						created_at: row.createdAt.toISOString(),
					};
				}
			}
			const error = row.provenance.error as
				| { code: string; message: string }
				| null
				| undefined;
			return {
				id: row.id,
				phrase: provenance.data.phrase,
				status: failed ? "failed" : "succeeded",
				provenance: provenance.data,
				boxes,
				error: failed
					? (error ?? { code: "location_failed", message: "Locating failed" })
					: null,
				created_at: row.createdAt.toISOString(),
			};
		}),
	);
	return locations.filter((item) => item !== null);
}

/** `GET /api/v1/evidence/{id}/locations`, newest first. */
export async function listLocations(
	deps: Pick<VisualDeps, "db" | "config">,
	workspaceId: string,
	evidenceId: string,
): Promise<EvidenceLocationsResponse> {
	const asset = await requireAsset(deps.db, workspaceId, evidenceId);
	requireObservable(asset);
	return {
		evidence_id: asset.id,
		locations: await readLocations(deps, workspaceId, asset.id, 20),
	};
}
