import path from "node:path";
import {
	type BrowserLocator,
	type BrowserStep,
	type RuntimePhase,
	type RuntimeRun,
	type RuntimeSandboxMode,
	RuntimeSandboxModeSchema,
	type RuntimeStartup,
	type RuntimeStep,
} from "@tracera/contracts";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { evidenceAssets } from "../db/schema.ts";
import { putBlob } from "../lib/fs.ts";
import type { BrowserRunResult } from "../sandbox/executor.ts";

// What a browser reproduction run leaves behind for review: its screenshot as an evidence asset with
// provenance, how the app started, and each step in words. Written by the pipeline when a run ends;
// read back by modules/runtime-evidence.ts.

/** Screenshots are evidence: kept as long as other uploaded evidence. */
const EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}…` : text;
const quote = (text: string) => JSON.stringify(clip(text, 80));

export const blobsDir = (config: Pick<Config, "dataDir">) =>
	path.join(config.dataDir, "blobs");

/** The runner's output is untrusted: only real PNG bytes are stored or served as a screenshot. */
export const isPng = (bytes: Buffer) =>
	bytes.length > PNG_SIGNATURE.length &&
	bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

/** Stores a runner screenshot (base64) as a content-addressed blob; null when there is none or it is not a PNG. */
export async function storeScreenshot(
	config: Pick<Config, "dataDir">,
	encoded: string | null | undefined,
): Promise<{ sha256: string; size: number } | null> {
	if (!encoded) return null;
	const bytes = Buffer.from(encoded, "base64");
	if (!isPng(bytes)) return null;
	const { sha256, size } = await putBlob(blobsDir(config), bytes);
	return { sha256, size };
}

/** The sandbox mode an investigation started under; records that predate it take this environment's. */
export function sandboxModeOf(
	snapshot: Record<string, unknown>,
	current: RuntimeSandboxMode,
): RuntimeSandboxMode {
	return (
		z
			.object({ sandbox: z.object({ mode: RuntimeSandboxModeSchema }) })
			.safeParse(snapshot).data?.sandbox.mode ?? current
	);
}

/** Baseline runs show the bug before the patch; every other browser run is after it. */
export const phaseOf = (purpose: string): RuntimePhase =>
	purpose === "repro_baseline" ? "before" : "after";

function locatorText(target: BrowserLocator) {
	if (target.by === "role")
		return `${target.value}${target.name ? ` ${quote(target.name)}` : ""}`;
	return `${target.by.replace("_", " ")} ${quote(target.value)}`;
}

/** A step in words, from the validated plan, for the review page. */
export function describeStep(step: BrowserStep): string {
	const on = step.target ? locatorText(step.target) : "the page";
	switch (step.action) {
		case "goto":
			return `Open ${step.path}`;
		case "click":
			return `Click ${on}`;
		case "fill":
			return `Fill ${on} with ${quote(step.value ?? "")}`;
		case "select":
			return `Select ${quote(step.value ?? "")} in ${on}`;
		case "press":
			return `Press ${step.key}${step.target ? ` on ${on}` : ""}`;
		case "set_viewport":
			return `Set the viewport to ${step.width}×${step.height}`;
		case "wait_for":
			return `Wait for ${on}`;
		case "expect_text":
			return `Expect ${on} to ${step.match === "equals" ? "equal" : "contain"} ${quote(step.value ?? "")}`;
		case "expect_visible":
			return `Expect ${on} to be visible`;
		case "expect_hidden":
			return `Expect ${on} to be hidden`;
		case "expect_url":
			return `Expect the page to be ${step.path}`;
		case "expect_no_console_errors":
			return "Expect no console errors";
		case "expect_no_horizontal_overflow":
			return "Expect no horizontal scrolling";
	}
}

/**
 * How the app came up, for the run record: facts the runner observed plus the failure reason when
 * there was one. `unknown` when the run ended before the runner reported anything.
 */
export function startupRecord(
	result: BrowserRunResult,
	target: {
		start: readonly string[];
		app: { port: number; readyPath: string };
	},
): RuntimeStartup {
	const report = result.report;
	const seen = report?.startup;
	let state: RuntimeStartup["state"] = "started";
	let reason: string | null = null;
	if (!report) {
		state = result.detail === "app_container_failed" ? "failed" : "unknown";
		reason = result.detail ?? result.status;
	} else if (!report.ready) {
		state = "failed";
		reason =
			seen?.health_error === "app_exited"
				? "app_exited_before_ready"
				: "health_check_failed";
	} else if (seen && !seen.page_loaded) {
		state = "failed";
		reason = "page_load_failed";
	}
	return {
		state,
		reason,
		image: result.executor.image,
		browser_image: result.executor.browserImage,
		start: target.start.join(" "),
		port: target.app.port,
		ready_path: target.app.readyPath,
		health: seen
			? {
					ok: seen.health_ok,
					status: seen.health_status,
					attempts: seen.health_attempts,
					waited_ms: seen.health_waited_ms,
					error: seen.health_error,
				}
			: null,
		page: seen ? { loaded: seen.page_loaded, error: seen.page_error } : null,
	};
}

/** The run record's evidence fields (added to `sandbox_runs.result.browser`). */
export function browserEvidenceFields(input: {
	result: BrowserRunResult;
	plan: {
		steps: readonly BrowserStep[];
		target: {
			start: readonly string[];
			app: { port: number; readyPath: string };
		};
	};
	purpose: string;
	screenshotEvidenceId: string | null;
}) {
	const { result, plan } = input;
	const steps: RuntimeStep[] = (result.report?.steps ?? []).map((step) => {
		const planned = plan.steps[step.index];
		return {
			index: step.index,
			action: step.action,
			label: planned ? clip(describeStep(planned), 300) : step.action,
			status: step.status,
			assertion: step.assertion,
			message: step.message === null ? null : clip(step.message, 500),
			expected: step.expected === null ? null : clip(step.expected, 300),
			actual: step.actual === null ? null : clip(step.actual, 300),
		};
	});
	return {
		phase: phaseOf(input.purpose),
		executor_kind: result.executor.kind,
		startup: startupRecord(result, plan.target),
		step_results: steps,
		screenshot_evidence_id: input.screenshotEvidenceId,
	};
}

/**
 * Records a run's screenshot as an evidence asset: the blob plus where it came from (run, phase,
 * patch, sandbox, image digests). A retried run replaces its own earlier screenshot.
 */
export async function recordScreenshotEvidence(
	db: Db,
	input: {
		id: string;
		workspaceId: string;
		investigationId: string;
		runId: string;
		runKey: string;
		purpose: string;
		patchId: string | null;
		blob: { sha256: string; size: number };
		result: BrowserRunResult;
		capturedAt: Date;
	},
) {
	await db
		.delete(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.investigationId, input.investigationId),
				eq(evidenceAssets.kind, "repro_screenshot"),
				sql`${evidenceAssets.provenance}->>'sandbox_run_id' = ${input.runId}`,
			),
		);
	await db.insert(evidenceAssets).values({
		id: input.id,
		workspaceId: input.workspaceId,
		investigationId: input.investigationId,
		kind: "repro_screenshot",
		origin: "generated_by_tool",
		blobSha256: input.blob.sha256,
		mimeType: "image/png",
		sizeBytes: input.blob.size,
		capturedAt: input.capturedAt,
		provenance: {
			method: "browser_sandbox",
			sandbox_run_id: input.runId,
			run_key: input.runKey,
			phase: phaseOf(input.purpose),
			purpose: input.purpose,
			patch_id: input.patchId,
			executor: input.result.executor.kind,
			image: input.result.executor.image,
			browser_image: input.result.executor.browserImage,
		},
		retentionUntil: new Date(Date.now() + EVIDENCE_RETENTION_MS),
	});
}

/**
 * Whether the stored post-patch browser assertions allow saying the patch changed what the
 * reproduction showed. A claim needs a verification whose reproduction check passed and, in every
 * post-patch run, an app that started, at least one assertion that passed, and none that failed.
 * It reads stored records only and never sets an outcome: `deriveVerificationOutcome` stays the authority.
 */
export function visualFixClaim(input: {
	verification: { reproductionStatus: string | null } | null;
	after: ReadonlyArray<Pick<RuntimeRun, "status" | "startup" | "assertions">>;
}): { claimable: boolean; reason: string } {
	const no = (reason: string) => ({ claimable: false, reason });
	if (!input.verification) return no("no_verification");
	if (input.after.length === 0) return no("no_post_patch_run");
	if (
		input.after.some(
			(run) => run.status !== "exited" || run.startup.state !== "started",
		)
	)
		return no("post_patch_run_incomplete");
	if (input.after.some((run) => run.assertions.failed > 0))
		return no("post_patch_assertion_failed");
	if (input.after.some((run) => run.assertions.passed === 0))
		return no("no_assertion_passed");
	if (input.verification.reproductionStatus !== "passed")
		return no("reproduction_check_not_passed");
	return { claimable: true, reason: "post_patch_assertions_passed" };
}
