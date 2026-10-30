import path from "node:path";
import {
	type EvidenceObservation,
	type EvidenceObservationsResponse,
	type ObservationProvenance,
	ObservationProvenanceSchema,
	type ScreenshotObservationOutput,
	ScreenshotObservationOutputSchema,
	VISION_IMAGE_MIME_TYPES,
} from "@tracera/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type pg from "pg";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { evidenceAssets } from "../db/schema.ts";
import { InferenceError } from "../inference/gateway.ts";
import type { ChatProvider } from "../inference/providers.ts";
import {
	observeScreenshotTask,
	SCREENSHOT_OBSERVATION_INPUT,
} from "../inference/tasks.ts";
import { putBlob, readBlobBytes, readBlobUtf8 } from "../lib/fs.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { redactSecrets } from "../lib/redact.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import type { PackItem } from "./context.ts";
import { workspaceGateway } from "./normalization.ts";

export type VisualDeps = {
	db: Db;
	pool: pg.Pool;
	config: Config;
	provider: ChatProvider;
};

type Asset = typeof evidenceAssets.$inferSelect;

/** One stored reading of a screenshot: the derived `ai_annotation` evidence row and its parsed content. */
export type StoredObservation = {
	id: string;
	status: "succeeded" | "failed";
	provenance: ObservationProvenance;
	output: ScreenshotObservationOutput | null;
	error: { code: string; message: string } | null;
	createdAt: Date;
};

/** Screenshots read per bug report; more than this are reported as unread, never silently dropped. */
const MAX_SCREENSHOTS = 5;
/** How long a caller waits for another worker that is already reading the same screenshot. */
const LOCK_WAIT_MS = 150_000;
const IMAGE_TYPES = new Set<string>(VISION_IMAGE_MIME_TYPES);

export const blobsDir = (config: Pick<Config, "dataDir">) =>
	path.join(config.dataDir, "blobs");

export const isObservableImage = (asset: Pick<Asset, "kind" | "mimeType">) =>
	asset.kind === "screenshot" && IMAGE_TYPES.has(asset.mimeType);

export async function findAsset(
	db: Db,
	workspaceId: string,
	id: string,
): Promise<Asset | undefined> {
	const [asset] = await db
		.select()
		.from(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.id, id),
				eq(evidenceAssets.workspaceId, workspaceId),
			),
		)
		.limit(1);
	return asset;
}

/** Foreign or missing evidence is a 404, the same as for every other workspace-scoped record. */
export async function requireAsset(db: Db, workspaceId: string, id: string) {
	const asset = await findAsset(db, workspaceId, id);
	if (!asset)
		throw new AppError(404, "not_found", `Evidence ${id} was not found`);
	return asset;
}

export function requireObservable(asset: Asset) {
	if (!isObservableImage(asset))
		throw new AppError(
			422,
			"evidence_not_observable",
			"Only PNG, JPEG, and WebP screenshots can be read",
		);
}

// ---- Stored observations ----------------------------------------------------------------------

async function readObservation(
	config: Pick<Config, "dataDir">,
	row: Asset,
): Promise<StoredObservation | null> {
	const provenance = ObservationProvenanceSchema.safeParse(row.provenance);
	if (!provenance.success) return null;
	const status = row.provenance.status === "failed" ? "failed" : "succeeded";
	const stored = await readBlobUtf8(blobsDir(config), row.blobSha256);
	let output: ScreenshotObservationOutput | null = null;
	if (status === "succeeded") {
		try {
			const parsed = ScreenshotObservationOutputSchema.safeParse(
				(JSON.parse(stored ?? "null") as { output?: unknown } | null)?.output,
			);
			if (parsed.success) output = parsed.data;
		} catch {
			// A damaged blob is reported below as unavailable content.
		}
	}
	const error = row.provenance.error as StoredObservation["error"] | undefined;
	return {
		id: row.id,
		status: status === "succeeded" && output === null ? "failed" : status,
		provenance: provenance.data,
		output,
		error:
			status === "failed"
				? (error ?? { code: "observation_failed", message: "Reading failed" })
				: output === null
					? {
							code: "observation_unavailable",
							message: "The stored observation could not be read",
						}
					: null,
		createdAt: row.createdAt,
	};
}

/** Derived annotations of one task for a piece of evidence, newest first. */
export function derivedRows(
	db: Db,
	workspaceId: string,
	evidenceId: string,
	task: string,
	limit: number,
): Promise<Asset[]> {
	return db
		.select()
		.from(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.workspaceId, workspaceId),
				eq(evidenceAssets.derivedFromEvidenceId, evidenceId),
				eq(evidenceAssets.kind, "ai_annotation"),
				sql`${evidenceAssets.provenance}->>'task' = ${task}`,
			),
		)
		.orderBy(desc(evidenceAssets.createdAt), desc(evidenceAssets.id))
		.limit(limit);
}

async function observationsOf(
	db: Db,
	config: Pick<Config, "dataDir">,
	workspaceId: string,
	evidenceId: string,
	limit: number,
): Promise<StoredObservation[]> {
	const rows = await derivedRows(
		db,
		workspaceId,
		evidenceId,
		"observe_screenshot",
		limit,
	);
	const observations = await Promise.all(
		rows.map((row) => readObservation(config, row)),
	);
	return observations.filter((item) => item !== null);
}

const toView = (observation: StoredObservation): EvidenceObservation => ({
	id: observation.id,
	status: observation.status,
	provenance: observation.provenance,
	output: observation.output,
	error: observation.error,
	created_at: observation.createdAt.toISOString(),
});

/** `GET /api/v1/evidence/{id}/observations`, newest first. */
export async function listObservations(
	deps: Pick<VisualDeps, "db" | "config">,
	workspaceId: string,
	evidenceId: string,
): Promise<EvidenceObservationsResponse> {
	const asset = await requireAsset(deps.db, workspaceId, evidenceId);
	requireObservable(asset);
	const observations = await observationsOf(
		deps.db,
		deps.config,
		workspaceId,
		asset.id,
		10,
	);
	return {
		evidence_id: asset.id,
		kind: asset.kind,
		mime_type: asset.mimeType,
		observations: observations.map(toView),
	};
}

// ---- Reading a screenshot ---------------------------------------------------------------------

/**
 * Model output is text transcribed from pixels, so it can carry a secret the image showed. Redaction
 * runs on the output before anything is stored or shown, as it does on every text sent to a model.
 */
function redactOutput(
	output: ScreenshotObservationOutput,
	redactEmails: boolean,
): { output: ScreenshotObservationOutput; count: number } {
	let count = 0;
	const walk = (value: unknown): unknown => {
		if (typeof value === "string") {
			const result = redactSecrets(value, { redactEmails });
			count += result.count;
			return result.text;
		}
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, walk(item)]),
			);
		return value;
	};
	return { output: walk(output) as ScreenshotObservationOutput, count };
}

/**
 * Runs `work` while holding a session advisory lock for this screenshot, so the queue job and an
 * investigation stage never read the same image twice. The lock dies with its connection, so a crashed
 * worker cannot leave one behind. Returns null when another worker still holds it after the wait.
 */
async function withReadLock<T>(
	pool: pg.Pool,
	evidenceId: string,
	signal: AbortSignal | undefined,
	work: () => Promise<T>,
): Promise<T | null> {
	const client = await pool.connect();
	const key = `observe_screenshot:${evidenceId}`;
	let broken = false;
	try {
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			const { rows } = await client.query<{ locked: boolean }>(
				"select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
				[key],
			);
			if (rows[0]?.locked) break;
			if (signal?.aborted || Date.now() > deadline) return null;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		try {
			return await work();
		} finally {
			await client
				.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key])
				.catch(() => {
					broken = true;
				});
		}
	} finally {
		client.release(broken);
	}
}

export type ReadOptions = {
	workspaceId: string;
	evidenceId: string;
	/** Attributes the model call to an investigation, so its call and cost limits apply. */
	investigationId?: string | null;
	signal?: AbortSignal | undefined;
};

/**
 * Reads one screenshot with the vision model and stores the result as derived evidence
 * (`ai_annotation`, `generated_by_model`, `derived_from_evidence_id` = the screenshot). A succeeded
 * reading is reused; a failed one is retried. Returns null when the screenshot is not readable
 * evidence of this workspace or another worker is still reading it.
 */
export async function observeEvidenceAsset(
	deps: VisualDeps,
	options: ReadOptions,
): Promise<StoredObservation | null> {
	const asset = await findAsset(
		deps.db,
		options.workspaceId,
		options.evidenceId,
	);
	if (!asset || !isObservableImage(asset)) return null;
	return withReadLock(deps.pool, asset.id, options.signal, async () => {
		const [latest] = await observationsOf(
			deps.db,
			deps.config,
			asset.workspaceId,
			asset.id,
			1,
		);
		if (latest?.status === "succeeded") return latest;
		return readScreenshot(deps, asset, options);
	});
}

async function readScreenshot(
	deps: VisualDeps,
	asset: Asset,
	options: ReadOptions,
): Promise<StoredObservation> {
	const gateway = workspaceGateway(
		deps,
		{
			workspaceId: asset.workspaceId,
			bugReportId: asset.bugReportId,
			investigationId: options.investigationId ?? null,
		},
		{ model: deps.config.inference.visionModel },
	);
	const bytes = await readBlobBytes(blobsDir(deps.config), asset.blobSha256);
	let output: ScreenshotObservationOutput | null = null;
	let error: { code: string; message: string } | null = null;
	let modelExecutionId: string | null = null;
	let redactionCount = 0;
	if (!bytes) {
		error = {
			code: "evidence_content_unavailable",
			message: "The stored screenshot could not be read",
		};
	} else {
		try {
			const result = await gateway.run(observeScreenshotTask, {
				user: SCREENSHOT_OBSERVATION_INPUT,
				images: [{ bytes, declaredType: asset.mimeType }],
				cacheKey: asset.id,
				signal: options.signal,
			});
			modelExecutionId = result.modelExecutionId;
			const cleaned = redactOutput(
				result.output,
				deps.config.inference.redactEmails,
			);
			output = cleaned.output;
			redactionCount = cleaned.count;
		} catch (caught) {
			// A cancelled call belongs to an aborted stage, not to the screenshot: nothing is stored.
			if (!(caught instanceof InferenceError) || caught.code === "cancelled")
				throw caught;
			modelExecutionId = caught.modelExecutionId;
			error = { code: caught.code, message: caught.message };
		}
	}
	const kind = gateway.providerKind;
	const provenance = {
		task: "observe_screenshot",
		prompt_version: observeScreenshotTask.promptVersion,
		model: gateway.model,
		provider: gateway.providerName,
		provider_kind: kind,
		mode: kind === "mock" ? "mock" : "live",
		// Same rule as the investigation flag: anything that is not Meta's own API is a placeholder.
		placeholder_provider: kind === "openai_compatible",
		model_execution_id: modelExecutionId,
		source_evidence_id: asset.id,
		source_sha256: asset.blobSha256,
		redaction_count: redactionCount,
		status: error ? "failed" : "succeeded",
		error,
	};
	const blob = await putBlob(
		blobsDir(deps.config),
		Buffer.from(
			JSON.stringify({ schema: "screenshot_observation.v1", output }),
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
		redactions:
			redactionCount > 0 ? { applied_by: "server", count: redactionCount } : {},
		retentionUntil: asset.retentionUntil,
	});
	await audit(deps.db, {
		workspaceId: asset.workspaceId,
		actor: WORKER_ACTOR,
		action: "evidence.observed",
		targetType: "evidence_asset",
		targetId: asset.id,
		metadata: {
			derived_evidence_id: id,
			status: provenance.status,
			provider: provenance.provider,
			model: provenance.model,
			mode: provenance.mode,
			model_execution_id: modelExecutionId,
			...(error ? { code: error.code } : {}),
		},
	});
	const stored = await observationsOf(
		deps.db,
		deps.config,
		asset.workspaceId,
		asset.id,
		1,
	);
	const first = stored[0];
	if (!first) throw new Error("observation vanished after it was stored");
	return first;
}

// ---- Feeding the investigation ----------------------------------------------------------------

type ScreenshotReading = {
	asset: Asset;
	observation: StoredObservation | null;
};

/** Reads every screenshot of a bug report (up to MAX_SCREENSHOTS, in upload order). */
async function readBugReportScreenshots(
	deps: VisualDeps,
	scope: {
		workspaceId: string;
		bugReportId: string;
		investigationId?: string | null;
		signal?: AbortSignal | undefined;
	},
): Promise<{ readings: ScreenshotReading[]; skipped: number }> {
	const assets = await deps.db
		.select()
		.from(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.workspaceId, scope.workspaceId),
				eq(evidenceAssets.bugReportId, scope.bugReportId),
				eq(evidenceAssets.kind, "screenshot"),
			),
		)
		.orderBy(asc(evidenceAssets.createdAt), asc(evidenceAssets.id));
	const readable = assets.filter(isObservableImage).slice(0, MAX_SCREENSHOTS);
	const readings = await Promise.all(
		readable.map(async (asset): Promise<ScreenshotReading> => {
			const done = await observeEvidenceAsset(deps, {
				workspaceId: scope.workspaceId,
				evidenceId: asset.id,
				investigationId: scope.investigationId ?? null,
				signal: scope.signal,
			});
			if (done) return { asset, observation: done };
			// Another worker is still reading it: show the newest stored reading, if there is one.
			const [latest] = await observationsOf(
				deps.db,
				deps.config,
				asset.workspaceId,
				asset.id,
				1,
			);
			return { asset, observation: latest ?? null };
		}),
	);
	return { readings, skipped: assets.length - readable.length };
}

/** Keeps a transcribed value on one line and cannot close the `<untrusted>` block it is placed in. */
const oneLine = (text: string, max = 300) => {
	const flat = text
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/<\s*(\/?)\s*untrusted/gi, "[$1untrusted");
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const sourceOf = (p: ObservationProvenance) =>
	`${p.model} via ${p.provider}, ${p.mode === "mock" ? "[mock]" : "[live]"}${
		p.placeholder_provider ? ", placeholder provider" : ""
	}`;

function listLines(title: string, lines: string[]): string[] {
	return lines.length > 0 ? [`${title}:`, ...lines.map((l) => `- ${l}`)] : [];
}

/** "Observed in screenshot": what the vision model says is visible. Never repository fact, never verified. */
export function renderObserved(
	output: ScreenshotObservationOutput,
	provenance: ObservationProvenance,
): string {
	return [
		`Read from a screenshot by a vision model (${sourceOf(provenance)}). This was transcribed from pixels, can contain reading errors, and has not been checked against the repository or by running anything.`,
		`Summary: ${oneLine(output.summary, 600)}`,
		...listLines(
			"Visible text",
			output.visible_text
				.slice(0, 60)
				.map((t) => `"${oneLine(t.text)}" (${oneLine(t.location, 100)})`),
		),
		...listLines(
			"Error messages",
			output.error_messages
				.slice(0, 20)
				.map((t) => `"${oneLine(t.text)}" (${oneLine(t.location, 100)})`),
		),
		...listLines(
			"UI elements",
			output.ui_elements
				.slice(0, 30)
				.map(
					(e) =>
						`${oneLine(e.kind, 40)} "${oneLine(e.label, 120)}"${
							e.state ? ` [${oneLine(e.state, 80)}]` : ""
						} (${oneLine(e.location, 100)})`,
				),
		),
		output.observed_failure
			? `Observed failure: ${oneLine(output.observed_failure, 500)}`
			: "Observed failure: none seen",
		...listLines(
			"Observations",
			output.observations.slice(0, 30).map((o) => oneLine(o.statement, 400)),
		),
		...listLines(
			"Not determinable from the image",
			output.missing_information.slice(0, 15).map((m) => oneLine(m, 300)),
		),
	].join("\n");
}

/** "Model inference": guesses the model made about what it saw. Not visible, not verified. */
export function renderInferences(
	output: ScreenshotObservationOutput,
	provenance: ObservationProvenance,
): string {
	return [
		`Guesses by a vision model about a screenshot (${sourceOf(provenance)}). None of this is visible in the image and none of it has been verified.`,
		...output.inferences
			.slice(0, 15)
			.map(
				(i) => `- (${i.confidence} confidence) ${oneLine(i.statement, 400)}`,
			),
	].join("\n");
}

const nameOf = (asset: Asset, n: number) =>
	oneLine(asset.originalFilename ?? "", 60) || `screenshot ${n}`;

/** Prompt blocks for bug report normalization: SHOT-n (visible) and INFER-n (inferred) per screenshot. */
export async function screenshotEvidenceForNormalization(
	deps: VisualDeps,
	scope: {
		workspaceId: string;
		bugReportId: string;
		investigationId?: string | null;
	},
): Promise<{
	evidence: Array<{ handle: string; kind: string; text: string }>;
	unread: number;
}> {
	const { readings, skipped } = await readBugReportScreenshots(deps, scope);
	const evidence: Array<{ handle: string; kind: string; text: string }> = [];
	let n = 0;
	for (const { observation } of readings) {
		if (observation?.status !== "succeeded" || !observation.output) continue;
		n += 1;
		evidence.push({
			handle: `SHOT-${n}`,
			kind: "screenshot_observation",
			text: renderObserved(observation.output, observation.provenance),
		});
		if (observation.output.inferences.length > 0)
			evidence.push({
				handle: `INFER-${n}`,
				kind: "screenshot_inference",
				text: renderInferences(observation.output, observation.provenance),
			});
	}
	return { evidence, unread: readings.length - n + skipped };
}

/**
 * Investigation evidence for collect_context. SHOT-n is basis `reported` (the user supplied the image,
 * a model read it) and INFER-n is basis `inferred`; neither is `observed`, so neither can move a
 * hypothesis to supported or contradicted. Unreadable screenshots become limitations.
 */
export async function screenshotEvidenceItems(
	deps: VisualDeps,
	scope: {
		workspaceId: string;
		bugReportId: string;
		investigationId: string;
		signal?: AbortSignal;
	},
): Promise<{ items: PackItem[]; limitations: string[] }> {
	const { readings, skipped } = await readBugReportScreenshots(deps, scope);
	const items: PackItem[] = [];
	const limitations: string[] = [];
	let n = 0;
	for (const { asset, observation } of readings) {
		if (observation?.status !== "succeeded" || !observation.output) {
			limitations.push(
				`Screenshot ${oneLine(asset.originalFilename ?? "", 60) || asset.id} was attached but could not be read${
					observation?.error ? ` (${observation.error.code})` : " yet"
				}`,
			);
			continue;
		}
		n += 1;
		const { output, provenance } = observation;
		const where = {
			evidence_asset_id: asset.id,
			derived_evidence_id: observation.id,
		};
		const how = {
			method: "vision_model",
			task: provenance.task,
			prompt_version: provenance.prompt_version,
			model: provenance.model,
			provider: provenance.provider,
			mode: provenance.mode,
			placeholder_provider: provenance.placeholder_provider,
			model_execution_id: provenance.model_execution_id,
		};
		items.push({
			handle: `SHOT-${n}`,
			kind: "model_observation",
			basis: "reported",
			label: `Observed in screenshot: ${nameOf(asset, n)} (${provenance.mode === "mock" ? "[mock]" : "[live]"} ${provenance.model})`,
			content: renderObserved(output, provenance),
			locator: where,
			provenance: how,
		});
		if (output.inferences.length > 0)
			items.push({
				handle: `INFER-${n}`,
				kind: "model_observation",
				basis: "inferred",
				label: `Model inference about screenshot: ${nameOf(asset, n)} (${provenance.mode === "mock" ? "[mock]" : "[live]"} ${provenance.model})`,
				content: renderInferences(output, provenance),
				locator: where,
				provenance: how,
			});
	}
	if (skipped > 0)
		limitations.push(
			`${skipped} attached screenshot(s) were not read (unsupported type, or more than ${MAX_SCREENSHOTS})`,
		);
	return { items, limitations };
}
