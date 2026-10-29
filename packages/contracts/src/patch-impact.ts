import { z } from "zod";
import { idSchema, RefNameSchema as refName } from "./common.ts";
import { EdgeCertaintySchema, GraphEdgeKindSchema } from "./graph.ts";

// ---- Patch impact -----------------------------------------------------------------------------

/** One patch to analyse: two revisions, or a unified diff applied to a base revision. */
export const PatchImpactRequestSchema = z
	.strictObject({
		base: refName,
		head: refName.optional(),
		/** A unified diff as `git diff` prints it, applied to `base` (instead of `head`). */
		diff: z.string().min(1).max(750_000).optional(),
		/** Pull-request style: compare `head` with its merge base with `base` (`git diff base...head`). */
		merge_base: z.boolean().default(false),
		/** How far impact is followed from each changed symbol (relationship hops). */
		depth: z.number().int().min(1).max(6).default(4),
		/** At most this many impact findings are returned (ranked). */
		limit: z.number().int().min(1).max(300).default(100),
	})
	.refine(
		(request) => (request.head === undefined) !== (request.diff === undefined),
		{
			message: "Give exactly one of head or diff",
			path: ["head"],
		},
	)
	.refine((request) => !request.merge_base || request.head !== undefined, {
		message: "merge_base compares two revisions; it needs head",
		path: ["merge_base"],
	});

export const PatchImpactListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const PatchAnalysisIdSchema = idSchema("pia");

export const FileParseStatusSchema = z.enum([
	"parsed",
	"parse_failed",
	"unsupported_language",
	"not_indexed",
	"binary",
	"absent",
]);
export const FileCategorySchema = z.enum([
	"source",
	"test",
	"manifest",
	"lockfile",
	"migration",
	"config",
	"docs",
	"generated",
	"other",
]);
export const SymbolChangeSchema = z.enum([
	"added",
	"removed",
	"modified",
	"signature_changed",
	"export_changed",
]);
/** Whether tests are linked to a changed symbol; "none_identified" is never "untested". */
export const TestStateSchema = z.enum([
	"relevant",
	"possible",
	"none_identified",
	"unknown",
]);
/** How much a finding would matter if real (documented rules), independent of the evidence for it. */
export const ImpactSeveritySchema = z.enum(["high", "medium", "low"]);
/** How strong the evidence for a finding is, independent of its severity. */
export const EvidenceConfidenceSchema = z.enum(["high", "medium", "low"]);

const lineRange = z.object({ start: z.number().int(), end: z.number().int() });
const count = z.number().int().min(0);

export const ImpactLinkSchema = z.object({
	from: z.string(),
	kind: GraphEdgeKindSchema,
	to: z.string(),
	certainty: EdgeCertaintySchema,
	path: z.string().nullable(),
	line: z.number().int().nullable(),
	method: z.string().nullable(),
});

export const PatchImpactResultSchema = z.object({
	version: z.string(),
	/** False when any part was skipped or cut short; the limitations say what. */
	complete: z.boolean(),
	base: z.object({ ref: z.string().nullable(), sha: z.string() }),
	head: z.object({
		ref: z.string().nullable(),
		sha: z.string(),
		kind: z.enum(["commit", "tree"]),
	}),
	merge_base: z.boolean(),
	summary: z.object({
		files: count,
		added: count,
		modified: count,
		deleted: count,
		renamed: count,
		binary: count,
		generated: count,
		symbols: z.object({
			added: count,
			removed: count,
			modified: count,
			signature_changed: count,
			export_changed: count,
		}),
		findings: count,
		tests: z.object({
			relevant: count,
			possible: count,
			none_identified: count,
			unknown: count,
		}),
	}),
	files: z.array(
		z.object({
			path: z.string(),
			old_path: z.string().nullable(),
			status: z.enum(["added", "deleted", "modified", "renamed", "copied"]),
			category: FileCategorySchema,
			language: z.string().nullable(),
			additions: z.number().int().nullable(),
			deletions: z.number().int().nullable(),
			parse: z.object({
				base: FileParseStatusSchema,
				head: FileParseStatusSchema,
			}),
			changed_lines: z.object({
				base: z.array(lineRange),
				head: z.array(lineRange),
			}),
			/** Changed lines that fall in no parsed symbol (module-level code), by side. */
			unattributed: z.array(
				lineRange.extend({ side: z.enum(["base", "head"]) }),
			),
			import_changes: z.array(
				z.object({
					change: z.enum(["added", "removed"]),
					kind: z.enum(["IMPORTS", "RE_EXPORTS"]),
					target: z.string(),
				}),
			),
			notes: z.array(z.string()),
		}),
	),
	symbols: z.array(
		z.object({
			key: z.string(),
			base_key: z.string().nullable(),
			head_key: z.string().nullable(),
			name: z.string(),
			kind: z.string(),
			path: z.string(),
			change: SymbolChangeSchema,
			exported: z.boolean(),
			lines: z.object({
				base: lineRange.nullable(),
				head: lineRange.nullable(),
			}),
			/** Declaration text before and after (approximate: up to where the body starts). */
			signature: z
				.object({ before: z.string().nullable(), after: z.string().nullable() })
				.nullable(),
			dependents: count,
			tests: TestStateSchema,
		}),
	),
	test_changes: z.array(
		z.object({
			name: z.string(),
			path: z.string(),
			change: z.enum(["added", "removed", "modified"]),
		}),
	),
	dependency_changes: z.array(
		z.object({
			symbol: z.string(),
			change: z.enum(["added", "removed"]),
			kind: GraphEdgeKindSchema,
			target: z.string(),
		}),
	),
	route_changes: z.array(
		z.object({
			key: z.string(),
			name: z.string(),
			path: z.string().nullable(),
			change: z.enum(["added", "removed"]),
			clients: count,
		}),
	),
	schema_changes: z.array(
		z.object({
			table: z.string(),
			path: z.string(),
			line: z.number().int().nullable(),
			statement: z.string(),
		}),
	),
	manifest_changes: z.array(
		z.object({
			path: z.string(),
			dependency: z.string(),
			change: z.enum(["added", "removed", "changed"]),
			scope: z.string().nullable(),
			before: z.string().nullable(),
			after: z.string().nullable(),
		}),
	),
	findings: z.array(
		z.object({
			id: z.string(),
			origin: z.object({
				key: z.string(),
				name: z.string(),
				change: z.string(),
			}),
			target: z.object({
				key: z.string(),
				name: z.string(),
				kind: z.string(),
				path: z.string().nullable(),
				line: z.number().int().nullable(),
				package: z.string().nullable(),
			}),
			/** The revision whose graph the chain was found in (removed code is traced in the base). */
			graph: z.enum(["base", "head"]),
			depth: z.number().int().min(0),
			/** From the changed code outward to the affected component. */
			chain: z.array(ImpactLinkSchema),
			/** The weakest link of the chain. */
			certainty: EdgeCertaintySchema,
			category: z.string(),
			reason: z.string(),
			crosses_package: z.boolean(),
			critical_path: z.boolean(),
			/** Seen directly (for example an unresolved reference to removed code), not inferred by walking the graph. */
			observed: z.boolean(),
			severity: ImpactSeveritySchema,
			confidence: EvidenceConfidenceSchema,
			also_from: z.array(z.string()),
		}),
	),
	tests: z.object({
		by_symbol: z.array(
			z.object({
				symbol: z.string(),
				state: TestStateSchema,
				reason: z.string(),
				tests: z.array(
					z.object({
						key: z.string(),
						name: z.string(),
						path: z.string().nullable(),
						state: z.enum(["relevant", "possible"]),
						distance: z.number().int().min(0),
						via: z.string(),
					}),
				),
			}),
		),
		/** Tests worth running for this patch, with why each was selected (nothing is run). */
		recommended: z.array(
			z.object({
				name: z.string(),
				path: z.string().nullable(),
				state: z.enum(["relevant", "possible"]),
				reason: z.string(),
			}),
		),
	}),
	risk: z.object({
		/** Highest severity among findings with high-confidence evidence. */
		evidenced: z.object({
			severity: ImpactSeveritySchema.nullable(),
			findings: z.array(z.string()),
		}),
		/** Highest severity among all findings, including weakly evidenced ones. */
		plausible: z.object({
			severity: ImpactSeveritySchema.nullable(),
			findings: z.array(z.string()),
		}),
		factors: z.array(z.string()),
	}),
	review_actions: z.array(
		z.object({
			action: z.string(),
			/** `evidence`: tied to findings, symbols, or tests (in refs); `precaution`: general advice. */
			basis: z.enum(["evidence", "precaution"]),
			refs: z.array(z.string()),
		}),
	),
	limitations: z.array(z.string()),
	stats: z.object({
		edges_visited: count,
		truncated: z.boolean(),
	}),
});

export type PatchImpactRequest = z.infer<typeof PatchImpactRequestSchema>;
export type PatchImpactListQuery = z.infer<typeof PatchImpactListQuerySchema>;
export type PatchImpactResult = z.infer<typeof PatchImpactResultSchema>;
export type ImpactLink = z.infer<typeof ImpactLinkSchema>;
export type TestState = z.infer<typeof TestStateSchema>;
export type ImpactSeverity = z.infer<typeof ImpactSeveritySchema>;
export type EvidenceConfidence = z.infer<typeof EvidenceConfidenceSchema>;
export type FileParseStatus = z.infer<typeof FileParseStatusSchema>;
export type FileCategory = z.infer<typeof FileCategorySchema>;
export type SymbolChange = z.infer<typeof SymbolChangeSchema>;
