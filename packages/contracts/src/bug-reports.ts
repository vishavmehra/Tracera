import { z } from "zod";
import {
	idSchema,
	PaginationQuerySchema,
	PrioritySchema,
	SeveritySchema,
} from "./common.ts";

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const EnvironmentInputSchema = z.strictObject({
	browser: optionalText(200),
	os: optionalText(200),
	user_agent: optionalText(500),
	app_version: optionalText(100),
	viewport: z
		.strictObject({
			width: z.number().int().min(1).max(20_000),
			height: z.number().int().min(1).max(20_000),
		})
		.optional(),
});

export const LogEvidenceKindSchema = z.enum([
	"stack_trace",
	"log_file",
	"text_note",
]);

export const LogEvidenceInputSchema = z.strictObject({
	kind: LogEvidenceKindSchema,
	content: z.string().min(1).max(200_000),
});

/** POST /api/v1/bug-reports (JSON). source_channel is derived by the server and must not be sent. */
export const CreateBugReportRequestSchema = z.strictObject({
	title: requiredText(200),
	description: requiredText(20_000),
	expected_behavior: optionalText(5000),
	actual_behavior: optionalText(5000),
	steps: z.array(requiredText(1000)).max(50).optional(),
	environment: EnvironmentInputSchema.optional(),
	affected_url: z
		.string()
		.trim()
		.max(2048)
		.pipe(z.url({ protocol: /^https?$/ }))
		.optional(),
	keep_query: z.boolean().optional(),
	severity: SeveritySchema.optional(),
	priority: PrioritySchema.optional(),
	repository_id: idSchema("repo").optional(),
	logs: z.array(LogEvidenceInputSchema).max(10).optional(),
	normalize: z.boolean().optional(),
});

export const BugReportStatusSchema = z.enum([
	"draft",
	"open",
	"investigating",
	"resolved",
	"closed",
	"dismissed",
]);
export const NormalizationStatusSchema = z.enum([
	"not_requested",
	"queued",
	"done",
	"failed",
]);

export const BugReportListQuerySchema = PaginationQuerySchema.extend({
	status: BugReportStatusSchema.optional(),
	repository_id: idSchema("repo").optional(),
});

/** Fields normalization may fill when the user left them empty. */
export const NORMALIZABLE_FIELDS = [
	"expected_behavior",
	"actual_behavior",
	"steps",
	"environment.browser",
	"environment.os",
	"environment.viewport",
	"environment.app_version",
	"affected_page",
] as const;

export const FieldBasisSchema = z.enum([
	"stated_by_user",
	"visible_in_screenshot",
	"inferred",
]);

/** Structured output required from the model for task normalize_bug_report. */
export const NormalizationOutputSchema = z.object({
	title: z.string().max(200),
	summary: z.string().max(2000),
	expected_behavior: z.string().max(5000).nullable(),
	actual_behavior: z.string().max(5000).nullable(),
	steps: z.array(z.string().max(1000)).max(50),
	environment: z.object({
		browser: z.string().max(200).nullable(),
		os: z.string().max(200).nullable(),
		viewport: z.string().max(100).nullable(),
		app_version: z.string().max(100).nullable(),
	}),
	affected_page: z.string().max(500).nullable(),
	severity_suggestion: SeveritySchema,
	suspected_components: z.array(z.string().max(200)).max(20),
	search_terms: z.array(z.string().max(200)).max(20),
	ui_element_phrases: z.array(z.string().max(80)).max(10),
	screenshot_observations: z
		.array(
			z.object({
				evidence_handle: z.string().max(20),
				visible_text: z.array(z.string().max(500)).max(100),
				anomalies: z.array(z.string().max(500)).max(20),
			}),
		)
		.max(5),
	unresolved_questions: z
		.array(
			z.object({
				question: z.string().max(500),
				why_it_matters: z.string().max(500),
			}),
		)
		.max(10),
	field_basis: z
		.array(
			z.object({ field: z.enum(NORMALIZABLE_FIELDS), basis: FieldBasisSchema }),
		)
		.max(20),
});

export type CreateBugReportRequest = z.infer<
	typeof CreateBugReportRequestSchema
>;
export type BugReportStatus = z.infer<typeof BugReportStatusSchema>;
export type NormalizationStatus = z.infer<typeof NormalizationStatusSchema>;
export type NormalizationOutput = z.infer<typeof NormalizationOutputSchema>;
export type FieldBasis = z.infer<typeof FieldBasisSchema>;
export type LogEvidenceKind = z.infer<typeof LogEvidenceKindSchema>;
