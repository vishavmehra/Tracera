import { z } from "zod";
import { idSchema, PaginationQuerySchema } from "./common.ts";

export const InvestigationStatusSchema = z.enum([
	"queued",
	"running",
	"needs_input",
	"awaiting_approval",
	"completed",
	"failed",
	"cancelled",
]);

export const InvestigationStageSchema = z.enum([
	"normalize",
	"collect_context",
	"prepare_dependencies",
	"plan_reproduction",
	"reproduce_baseline",
	"generate_hypotheses",
	"rank_hypotheses",
	"generate_patch",
	"verify",
	"write_report",
]);

export const StepStatusSchema = z.enum([
	"pending",
	"running",
	"succeeded",
	"failed",
	"skipped",
	"blocked",
	"cancelled",
]);

export const INVESTIGATION_STAGES = InvestigationStageSchema.options;
export const ACTIVE_INVESTIGATION_STATUSES = [
	"queued",
	"running",
	"needs_input",
	"awaiting_approval",
] as const;
export const TERMINAL_INVESTIGATION_STATUSES = [
	"completed",
	"failed",
	"cancelled",
] as const;

/** Branch names or SHAs only: no options, ranges, reflog syntax, or whitespace. */
const commitSchema = z
	.string()
	.regex(/^[A-Za-z0-9._/-]{1,200}$/, "Expected a branch name or commit SHA")
	.refine(
		(value) => !value.startsWith("-") && !value.includes(".."),
		"Expected a branch name or commit SHA",
	);

export const CreateInvestigationRequestSchema = z.strictObject({
	bug_report_id: idSchema("bug"),
	repository_id: idSchema("repo").optional(),
	commit: commitSchema.optional(),
	mode: z.enum(["full", "analysis_only"]).optional(),
	model_profile: z.enum(["standard", "deep"]).optional(),
	interactive: z.boolean().optional(),
});

export const GetInvestigationQuerySchema = z.object({
	wait_seconds: z.coerce.number().int().min(0).max(20).default(0),
	known_version: z.coerce.number().int().min(0).optional(),
});

export const InvestigationListQuerySchema = PaginationQuerySchema.extend({
	bug_report_id: idSchema("bug").optional(),
	status: InvestigationStatusSchema.optional(),
});

export type InvestigationStatus = z.infer<typeof InvestigationStatusSchema>;
export type InvestigationStage = z.infer<typeof InvestigationStageSchema>;
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type CreateInvestigationRequest = z.infer<
	typeof CreateInvestigationRequestSchema
>;
