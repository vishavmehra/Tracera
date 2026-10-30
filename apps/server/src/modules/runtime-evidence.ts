import {
	type RuntimeEvidenceResponse,
	type RuntimeRun,
	RuntimeStartupSchema,
	RuntimeStepSchema,
} from "@tracera/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
	evidenceAssets,
	investigations,
	sandboxRuns,
	verificationRuns,
} from "../db/schema.ts";
import { readBlobBytes } from "../lib/fs.ts";
import { AppError } from "../lib/http.ts";
import {
	blobsDir,
	isPng,
	phaseOf,
	sandboxModeOf,
	visualFixClaim,
} from "./browser-evidence.ts";
import { latestStep } from "./pipeline.ts";
import { ownPatch } from "./results.ts";

// Read model for a patch's runtime evidence: the browser runs before and after it, as stored when
// each run ended. Every query is scoped to the caller's workspace; foreign IDs are 404.

/** The part of `sandbox_runs.result.browser` this read model uses; older records lack the newer fields. */
const StoredBrowserRunSchema = z.object({
	executor_kind: z.string().optional(),
	browser_image: z.string().optional(),
	startup: RuntimeStartupSchema.optional(),
	step_results: z.array(RuntimeStepSchema).optional(),
	console_errors: z.number().int().optional(),
	page_errors: z.number().int().optional(),
	blocked_requests: z.array(z.string()).optional(),
	failed_requests: z.number().int().optional(),
	final_path: z.string().nullable().optional(),
	screenshot_evidence_id: z.string().nullable().optional(),
});
const StoredClassificationSchema = z.object({
	status: z.string(),
	reason: z.string().nullable(),
});

type StoredRun = typeof sandboxRuns.$inferSelect;
type StoredScreenshot = typeof evidenceAssets.$inferSelect;

const screenshotUrl = (evidenceId: string) =>
	`/api/v1/repro-screenshots/${evidenceId}`;

function toRun(
	row: StoredRun,
	screenshot: StoredScreenshot | undefined,
): RuntimeRun {
	const browser = StoredBrowserRunSchema.safeParse(row.result.browser);
	const stored = browser.success ? browser.data : {};
	const classification = StoredClassificationSchema.safeParse(
		row.result.reproduction,
	);
	const steps = stored.step_results ?? [];
	const asserted = steps.filter((step) => step.assertion);
	return {
		run_id: row.id,
		phase: phaseOf(row.purpose),
		patch_id: row.patchId,
		status: row.status,
		reproduction: classification.success
			? classification.data
			: { status: "unknown", reason: "not_recorded" },
		sandbox: { kind: stored.executor_kind ?? "unknown" },
		startup: stored.startup ?? {
			state: "unknown",
			reason: "not_recorded",
			image: row.image,
			browser_image: stored.browser_image ?? "",
			start: row.argv.join(" "),
			port: 0,
			ready_path: "",
			health: null,
			page: null,
		},
		steps,
		assertions: {
			passed: asserted.filter((step) => step.status === "passed").length,
			failed: asserted.filter((step) => step.status === "failed").length,
			skipped: asserted.filter((step) => step.status === "skipped").length,
		},
		final_path: stored.final_path ?? null,
		console_errors: stored.console_errors ?? 0,
		page_errors: stored.page_errors ?? 0,
		blocked_requests: stored.blocked_requests?.length ?? 0,
		failed_requests: stored.failed_requests ?? 0,
		screenshot: screenshot
			? {
					evidence_id: screenshot.id,
					mime: "image/png",
					bytes: screenshot.sizeBytes,
					sha256: screenshot.blobSha256,
					captured_at: (
						screenshot.capturedAt ?? screenshot.createdAt
					).toISOString(),
					url: screenshotUrl(screenshot.id),
				}
			: null,
		started_at: row.startedAt.toISOString(),
		duration_ms: row.durationMs,
	};
}

async function verificationPatchId(
	db: Db,
	workspaceId: string,
	verificationId: string,
) {
	const [row] = await db
		.select({ patchId: verificationRuns.patchId })
		.from(verificationRuns)
		.innerJoin(
			investigations,
			eq(investigations.id, verificationRuns.investigationId),
		)
		.where(
			and(
				eq(verificationRuns.id, verificationId),
				eq(investigations.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(
			404,
			"not_found",
			`Verification ${verificationId} was not found`,
		);
	return row.patchId;
}

const stringIds = (value: unknown) =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];

/**
 * The browser runs behind a patch's verification: the baseline runs (before) and the post-patch runs
 * the verification's reproduction check used (after), each with its screenshot and step outcomes.
 */
export async function getRuntimeEvidence(
	db: Db,
	config: Pick<Config, "sandboxMode">,
	workspaceId: string,
	ref: { patchId: string } | { verificationId: string },
): Promise<RuntimeEvidenceResponse> {
	const patchId =
		"patchId" in ref
			? ref.patchId
			: await verificationPatchId(db, workspaceId, ref.verificationId);
	const { patch, investigation } = await ownPatch(db, workspaceId, patchId);
	const [verification] = await db
		.select()
		.from(verificationRuns)
		.where(eq(verificationRuns.patchId, patch.id))
		.limit(1);
	const check =
		verification?.checks.find((item) => item.kind === "reproduction") ?? null;
	const baseline = await latestStep(
		db,
		patch.investigationId,
		"reproduce_baseline",
	);
	const beforeIds = stringIds(baseline?.summary.repro_run_ids);
	const afterIds = check?.sandbox_run_ids ?? [];
	const ids = [...new Set([...beforeIds, ...afterIds])];
	const rows =
		ids.length === 0
			? []
			: await db
					.select()
					.from(sandboxRuns)
					.where(
						and(
							eq(sandboxRuns.investigationId, patch.investigationId),
							inArray(sandboxRuns.id, ids),
						),
					)
					.orderBy(asc(sandboxRuns.startedAt), asc(sandboxRuns.runKey));
	const browserRows = rows.filter((row) =>
		Object.hasOwn(row.result, "browser"),
	);
	const shotIds = browserRows.flatMap((row) => {
		const stored = StoredBrowserRunSchema.safeParse(row.result.browser);
		return stored.success && stored.data.screenshot_evidence_id
			? [stored.data.screenshot_evidence_id]
			: [];
	});
	const shots =
		shotIds.length === 0
			? []
			: await db
					.select()
					.from(evidenceAssets)
					.where(
						and(
							eq(evidenceAssets.workspaceId, workspaceId),
							eq(evidenceAssets.investigationId, patch.investigationId),
							eq(evidenceAssets.kind, "repro_screenshot"),
							inArray(evidenceAssets.id, shotIds),
						),
					);
	const runOf = (row: StoredRun) => {
		const stored = StoredBrowserRunSchema.safeParse(row.result.browser);
		const shot = shots.find(
			(item) =>
				stored.success && item.id === stored.data.screenshot_evidence_id,
		);
		return toRun(row, shot);
	};
	const before = browserRows
		.filter((row) => beforeIds.includes(row.id))
		.map(runOf);
	const after = browserRows
		.filter((row) => afterIds.includes(row.id))
		.map(runOf);
	return {
		patch_id: patch.id,
		investigation_id: patch.investigationId,
		sandbox_mode: sandboxModeOf(
			investigation.configSnapshot,
			config.sandboxMode,
		),
		verification: verification
			? {
					id: verification.id,
					outcome: verification.outcome,
					reproduction_check: check
						? { status: check.status, reason: check.reason }
						: null,
				}
			: null,
		before,
		after,
		visual_fix: visualFixClaim({
			verification: verification
				? { reproductionStatus: check?.status ?? null }
				: null,
			after,
		}),
	};
}

/** The stored PNG of one reproduction screenshot of the caller's workspace; the route sets the headers. */
export async function getRuntimeScreenshot(
	db: Db,
	config: Pick<Config, "dataDir">,
	workspaceId: string,
	evidenceId: string,
): Promise<Buffer> {
	const [asset] = await db
		.select()
		.from(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.id, evidenceId),
				eq(evidenceAssets.workspaceId, workspaceId),
				eq(evidenceAssets.kind, "repro_screenshot"),
			),
		)
		.limit(1);
	if (!asset)
		throw new AppError(
			404,
			"not_found",
			`Screenshot ${evidenceId} was not found`,
		);
	const bytes = await readBlobBytes(blobsDir(config), asset.blobSha256);
	if (!bytes || !isPng(bytes))
		throw new AppError(
			404,
			"not_found",
			"The screenshot's file is no longer available",
		);
	return bytes;
}
