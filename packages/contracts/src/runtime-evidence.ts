import { z } from "zod";
import { BrowserActionSchema } from "./browser-repro.ts";

// Runtime evidence of a patch: the sandboxed browser runs before it (baseline) and after it
// (verification), with how the app started, each step's outcome, and a screenshot per run.
// Served by GET /api/v1/patches/{id}/runtime-evidence; every field is read from stored records.

export const RuntimePhaseSchema = z.enum(["before", "after"]);

/**
 * How the app came up in the sandbox. `started`: the app answered its health check. `failed`: it did
 * not. `unknown`: the run ended before reporting (timeout, cancellation, runner failure). Anything but
 * `started` carries a stable reason code, never app output.
 */
export const RuntimeStartupSchema = z.object({
	state: z.enum(["started", "failed", "unknown"]),
	reason: z.string().max(100).nullable(),
	/** Sandbox (app) image and browser image, by digest. */
	image: z.string(),
	browser_image: z.string(),
	start: z.string(),
	port: z.number().int(),
	ready_path: z.string(),
	health: z
		.object({
			ok: z.boolean(),
			status: z.number().int().nullable(),
			attempts: z.number().int().min(0),
			waited_ms: z.number().int().min(0),
			error: z.string().nullable(),
		})
		.nullable(),
	page: z
		.object({ loaded: z.boolean(), error: z.string().nullable() })
		.nullable(),
});

export const RuntimeStepSchema = z.object({
	index: z.number().int().min(0),
	action: BrowserActionSchema,
	/** The step in words (action, locator, expected value), from the validated plan. */
	label: z.string(),
	status: z.enum(["passed", "failed", "skipped"]),
	assertion: z.boolean(),
	message: z.string().nullable(),
	expected: z.string().nullable(),
	actual: z.string().nullable(),
});

/** The stored screenshot (an evidence asset of kind `repro_screenshot`) and where its bytes are served. */
export const RuntimeScreenshotSchema = z.object({
	evidence_id: z.string(),
	mime: z.literal("image/png"),
	bytes: z.number().int().min(0),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	captured_at: z.string(),
	url: z.string(),
});

export const RuntimeRunSchema = z.object({
	run_id: z.string(),
	phase: RuntimePhaseSchema,
	/** Set for after-patch runs. */
	patch_id: z.string().nullable(),
	/** The sandbox run status (`exited`, `timed_out`, …). */
	status: z.string(),
	/** The run's own classification: `reproduced` means a step's assertion failed. */
	reproduction: z.object({
		status: z.string(),
		reason: z.string().nullable(),
	}),
	/** `docker` for a real sandbox; anything else is a test double and must be shown as such. */
	sandbox: z.object({ kind: z.string() }),
	startup: RuntimeStartupSchema,
	steps: z.array(RuntimeStepSchema),
	assertions: z.object({
		passed: z.number().int().min(0),
		failed: z.number().int().min(0),
		skipped: z.number().int().min(0),
	}),
	final_path: z.string().nullable(),
	console_errors: z.number().int().min(0),
	page_errors: z.number().int().min(0),
	blocked_requests: z.number().int().min(0),
	failed_requests: z.number().int().min(0),
	screenshot: RuntimeScreenshotSchema.nullable(),
	started_at: z.string(),
	duration_ms: z.number().int().min(0),
});

/** The sandbox mode an investigation started under; `disabled` means no app was started and nothing ran. */
export const RuntimeSandboxModeSchema = z.enum(["docker", "disabled", "fake"]);

export const RuntimeEvidenceResponseSchema = z.object({
	patch_id: z.string(),
	investigation_id: z.string(),
	/**
	 * Lets a page with no runs say why: under `disabled` there was no sandbox, so no app started and
	 * nothing was verified. Runs, when there are any, always take precedence.
	 */
	sandbox_mode: RuntimeSandboxModeSchema,
	verification: z
		.object({
			id: z.string(),
			outcome: z.string(),
			reproduction_check: z
				.object({ status: z.string(), reason: z.string().nullable() })
				.nullable(),
		})
		.nullable(),
	before: z.array(RuntimeRunSchema),
	after: z.array(RuntimeRunSchema),
	/**
	 * Whether the stored post-patch assertions allow saying the patch changed what the reproduction
	 * showed. Derived from stored records only; the verification outcome stays the authority.
	 */
	visual_fix: z.object({ claimable: z.boolean(), reason: z.string() }),
});

export type RuntimePhase = z.infer<typeof RuntimePhaseSchema>;
export type RuntimeSandboxMode = z.infer<typeof RuntimeSandboxModeSchema>;
export type RuntimeStartup = z.infer<typeof RuntimeStartupSchema>;
export type RuntimeStep = z.infer<typeof RuntimeStepSchema>;
export type RuntimeScreenshot = z.infer<typeof RuntimeScreenshotSchema>;
export type RuntimeRun = z.infer<typeof RuntimeRunSchema>;
export type RuntimeEvidenceResponse = z.infer<
	typeof RuntimeEvidenceResponseSchema
>;
