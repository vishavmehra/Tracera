import { z } from "zod";

// ---- Browser reproduction ----------------------------------------------------------------------
// The model proposes steps in this DSL; code validates them (apps/server/src/sandbox/browser-steps.ts)
// and a fixed runner executes them. Flat objects with nullable fields keep the model's strict JSON
// schema simple; which fields an action needs is checked by code, not by the schema.

export const BrowserActionSchema = z.enum([
	"goto",
	"click",
	"fill",
	"press",
	"select",
	"set_viewport",
	"wait_for",
	"expect_text",
	"expect_visible",
	"expect_hidden",
	"expect_url",
	"expect_no_console_errors",
	"expect_no_horizontal_overflow",
]);

export const BrowserLocatorSchema = z.strictObject({
	by: z.enum(["role", "text", "label", "placeholder", "test_id", "css"]),
	value: z.string().min(1).max(200),
	/** Accessible name, for `role` locators. */
	name: z.string().max(200).nullable(),
	exact: z.boolean().nullable(),
});

export const BrowserStepSchema = z.strictObject({
	action: BrowserActionSchema,
	target: BrowserLocatorSchema.nullable(),
	/** Text to type or option to select; for `expect_text`, the expected text. */
	value: z.string().max(500).nullable(),
	/** A path on the app (`/cart?x=1`), never a full URL: for `goto` and `expect_url`. */
	path: z.string().max(500).nullable(),
	key: z.string().max(40).nullable(),
	width: z.number().int().nullable(),
	height: z.number().int().nullable(),
	match: z.enum(["contains", "equals"]).nullable(),
	timeout_ms: z.number().int().nullable(),
});

export const BrowserReproductionPlanOutputSchema = z.strictObject({
	feasible: z.boolean(),
	infeasible_reason: z.string().max(1000).nullable(),
	steps: z.array(BrowserStepSchema).max(40),
	expected_observation: z.string().max(1000),
	reported_observation: z.string().max(1000),
});

/** How the app came up, as the runner saw it: the health check, then the first page load. */
export const BrowserStartupSchema = z.object({
	health_path: z.string().max(200),
	health_ok: z.boolean(),
	/** HTTP status of the last health probe; null when nothing answered. */
	health_status: z.number().int().nullable(),
	health_attempts: z.number().int().min(0),
	health_waited_ms: z.number().int().min(0),
	/** Why the last probe failed: a network error code or `app_exited`, never app output. */
	health_error: z.string().max(100).nullable(),
	page_loaded: z.boolean(),
	page_error: z.string().max(500).nullable(),
});

/** What the fixed runner reports from inside the sandbox; validated before use (untrusted output). */
export const BrowserRunReportSchema = z.object({
	ready: z.boolean(),
	/** Absent only in reports that predate it (and in test doubles). */
	startup: BrowserStartupSchema.optional(),
	steps: z
		.array(
			z.object({
				index: z.number().int().min(0),
				action: BrowserActionSchema,
				status: z.enum(["passed", "failed", "skipped"]),
				assertion: z.boolean(),
				message: z.string().max(2000).nullable(),
				expected: z.string().max(1000).nullable(),
				actual: z.string().max(1000).nullable(),
				duration_ms: z.number().int().min(0),
			}),
		)
		.max(40),
	console_errors: z.array(z.string().max(1000)).max(50),
	page_errors: z.array(z.string().max(1000)).max(50),
	blocked_requests: z.array(z.string().max(300)).max(50),
	failed_requests: z
		.array(
			z.object({
				path: z.string().max(500),
				status: z.number().int().nullable(),
				failure: z.string().max(300).nullable(),
			}),
		)
		.max(50),
	final_path: z.string().max(500).nullable(),
	/** PNG of the page after the last step (also when a step failed), base64; capped by the runner. */
	screenshot: z.string().max(1_500_000).nullable(),
	duration_ms: z.number().int().min(0),
});

export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export type BrowserLocator = z.infer<typeof BrowserLocatorSchema>;
export type BrowserStep = z.infer<typeof BrowserStepSchema>;
export type BrowserReproductionPlanOutput = z.infer<
	typeof BrowserReproductionPlanOutputSchema
>;
export type BrowserStartup = z.infer<typeof BrowserStartupSchema>;
export type BrowserRunReport = z.infer<typeof BrowserRunReportSchema>;
