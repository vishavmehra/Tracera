import { z } from "zod";
import { idSchema } from "./common.ts";

// ---- Statuses ---------------------------------------------------------------------------------

export const ReproductionStatusSchema = z.enum([
	"reproduced",
	"not_reproduced",
	"inconclusive",
	"blocked",
	"error",
	"not_attempted",
]);
export const CheckKindSchema = z.enum([
	"reproduction",
	"unit_tests",
	"typecheck",
	"lint",
	"build",
]);
export const CheckStatusSchema = z.enum([
	"passed",
	"failed",
	"inconclusive",
	"blocked",
	"not_attempted",
]);
export const VerificationOutcomeSchema = z.enum([
	"verified",
	"partially_verified",
	"failed",
	"inconclusive",
	"blocked",
	"not_attempted",
]);
export const HypothesisStateSchema = z.enum([
	"proposed",
	"supported",
	"contradicted",
	"confirmed",
	"rejected",
]);
export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
/** observed = produced by a deterministic tool; reported = stated by a user; inferred = stated by a model. */
export const EvidenceBasisSchema = z.enum(["observed", "reported", "inferred"]);
export const PatchStatusSchema = z.enum([
	"proposed",
	"apply_failed",
	"superseded",
	"approved",
	"rejected",
	"changes_requested",
]);

// ---- Model outputs (strict-schema subset: every property required, optional values nullable) ----

const handleSchema = z.string().min(1).max(40);

/** A reference to an evidence handle from the pack sent with the call; lines only for CODE handles. */
export const CitationSchema = z.strictObject({
	handle: handleSchema,
	start_line: z.number().int().min(1).nullable(),
	end_line: z.number().int().min(1).nullable(),
});

export const ReproductionPlanOutputSchema = z.strictObject({
	feasible: z.boolean(),
	infeasible_reason: z.string().max(1000).nullable(),
	test_source: z.string().max(12_000),
	expected_observation: z.string().max(1000),
	reported_observation: z.string().max(1000),
});

export const HypothesesOutputSchema = z.strictObject({
	insufficient_evidence: z.boolean(),
	insufficient_evidence_reason: z.string().max(1000).nullable(),
	hypotheses: z
		.array(
			z.strictObject({
				title: z.string().min(1).max(160),
				mechanism: z.string().min(1).max(2000),
				locations: z
					.array(
						z.strictObject({
							handle: handleSchema,
							start_line: z.number().int().min(1),
							end_line: z.number().int().min(1),
						}),
					)
					.max(5),
				supporting: z.array(CitationSchema).max(10),
				contradicting: z.array(CitationSchema).max(10),
				alternatives: z.array(z.string().max(500)).max(5),
				next_check: z.string().min(1).max(1000),
				confidence: ConfidenceSchema,
				confidence_rationale: z.string().max(1000),
			}),
		)
		.max(5),
	observations: z
		.array(
			z.strictObject({
				statement: z.string().min(1).max(1000),
				kind: z.enum([
					"code_observation",
					"evidence_observation",
					"history_observation",
				]),
				citations: z.array(CitationSchema).max(10),
			}),
		)
		.max(10),
	missing_information: z
		.array(
			z.strictObject({
				question: z.string().max(500),
				why_it_matters: z.string().max(500),
			}),
		)
		.max(5),
});

export const PatchOutputSchema = z.strictObject({
	hypothesis_handle: handleSchema,
	edits: z
		.array(
			z.strictObject({
				path: z.string().min(1).max(300),
				search: z.string().max(8000),
				replace: z.string().max(8000),
			}),
		)
		.max(10),
	summary: z.string().min(1).max(500),
	rationale: z.string().min(1).max(2000),
	expected_effect: z.string().min(1).max(1000),
	risks: z.array(z.string().max(300)).max(10),
});

// ---- Requests ---------------------------------------------------------------------------------

export const ApprovalRequestSchema = z
	.strictObject({
		decision: z.enum(["approved", "rejected", "changes_requested"]),
		verification_id: idSchema("ver"),
		comment: z.string().trim().max(5000).optional(),
		acknowledged_risks: z.array(z.string().min(1).max(100)).max(50).optional(),
	})
	.refine(
		(value) => value.decision !== "changes_requested" || !!value.comment,
		{
			message: "A comment is required when requesting changes",
			path: ["comment"],
		},
	);

export type ReproductionStatus = z.infer<typeof ReproductionStatusSchema>;
export type CheckKind = z.infer<typeof CheckKindSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;
export type HypothesisState = z.infer<typeof HypothesisStateSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type EvidenceBasis = z.infer<typeof EvidenceBasisSchema>;
export type PatchStatus = z.infer<typeof PatchStatusSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type ReproductionPlanOutput = z.infer<
	typeof ReproductionPlanOutputSchema
>;
export type HypothesesOutput = z.infer<typeof HypothesesOutputSchema>;
export type PatchOutput = z.infer<typeof PatchOutputSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
