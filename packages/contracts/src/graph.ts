import { z } from "zod";
import {
	CitationSchema,
	ConfidenceSchema,
	EvidenceBasisSchema,
} from "./analysis.ts";
import { idSchema } from "./common.ts";

// ---- Repository Knowledge Graph --------------------------------------------------------------

export const GRAPH_NODE_KINDS = [
	"repository",
	"revision",
	"directory",
	"file",
	"test_file",
	"package",
	"dependency",
	"function",
	"class",
	"method",
	"variable",
	"interface",
	"type_alias",
	"enum",
	"ui_component",
	"hook",
	"test_case",
	"commit",
	"owner",
	"doc_section",
	"route",
	"page",
	"external_service",
	"event",
	"queue",
	"db_table",
	"config_key",
] as const;
export const GRAPH_EDGE_KINDS = [
	"CONTAINS",
	"DEFINES",
	"IMPORTS",
	"RE_EXPORTS",
	"DEPENDS_ON",
	"CALLS",
	"REFERENCES",
	"IMPLEMENTS",
	"EXTENDS",
	"RENDERS",
	"HANDLES_EVENT",
	"SENDS_REQUEST_TO",
	"ROUTES_TO",
	"READS_FROM",
	"WRITES_TO",
	"PUBLISHES",
	"SUBSCRIBES_TO",
	"TESTS",
	"CONFIGURED_BY",
	"INTRODUCED_OR_CHANGED_BY",
	"OWNED_BY",
	"DOCUMENTED_BY",
] as const;
export const GraphNodeKindSchema = z.enum(GRAPH_NODE_KINDS);
export const GraphEdgeKindSchema = z.enum(GRAPH_EDGE_KINDS);
/** exact = read directly from git or syntax; resolved = a binding resolved to a target; heuristic = textual. */
export const EdgeCertaintySchema = z.enum([
	"exact",
	"resolved",
	"heuristic",
	"unresolved",
]);
export const SnapshotStatusSchema = z.enum([
	"queued",
	"indexing",
	"ready",
	"partial",
	"failed",
	"cancelled",
]);

/**
 * The shared evidence contract: graph queries, search, assessments, investigations, and reports all
 * cite evidence in this shape, so unsupported or inferred statements stay distinguishable.
 */
export const EvidenceRefSchema = z.object({
	type: z.enum([
		"report_claim",
		"evidence_asset",
		"code_excerpt",
		"commit",
		"repository_fact",
		"reproduction",
		"model_observation",
		"graph_node",
		"graph_edge",
		"search_hit",
	]),
	classification: EvidenceBasisSchema,
	handle: z.string().nullable(),
	repository_id: z.string().nullable(),
	commit_sha: z.string().nullable(),
	snapshot_id: z.string().nullable(),
	path: z.string().nullable(),
	start_line: z.number().int().nullable(),
	end_line: z.number().int().nullable(),
	symbol: z.string().nullable(),
	excerpt: z.string().nullable(),
	method: z.string(),
	certainty: EdgeCertaintySchema.nullable(),
	collected_at: z.string(),
	limitations: z.array(z.string()),
});

// ---- Requests ---------------------------------------------------------------------------------

const refName = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/);

export const IndexRepositoryRequestSchema = z.strictObject({
	ref: refName.optional(),
});
export const GraphNodeSearchQuerySchema = z.object({
	q: z.string().trim().min(1).max(200).optional(),
	kind: GraphNodeKindSchema.optional(),
	path: z.string().trim().min(1).max(500).optional(),
	/** Exact node key: keys are stable across snapshots, so this finds the same entity in a newer one. */
	key: z.string().trim().min(1).max(600).optional(),
	snapshot_id: idSchema("snap").optional(),
	limit: z.coerce.number().int().min(1).max(100).default(25),
});
const booleanQuery = (fallback: boolean) =>
	z
		.enum(["true", "false"])
		.optional()
		.transform((value) => (value === undefined ? fallback : value === "true"));
/** Flow tracing: UI → handler → client call → route → handler → service → data (or the reverse). */
export const GraphTraceQuerySchema = z.object({
	direction: z.enum(["downstream", "upstream"]).default("downstream"),
	// page → component → handler → client → route → handler → service → table is 7 hops.
	depth: z.coerce.number().int().min(1).max(10).default(8),
	limit: z.coerce.number().int().min(1).max(300).default(150),
	include_heuristic: booleanQuery(true),
});
export const GraphHistoryQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(30).default(10),
});
export const ImpactTargetSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("node"), id: idSchema("gnd") }),
	z.strictObject({ kind: z.literal("file"), path: z.string().min(1).max(500) }),
	z.strictObject({
		kind: z.literal("symbol"),
		name: z.string().min(1).max(300),
		path: z.string().min(1).max(500).optional(),
	}),
	z.strictObject({
		kind: z.literal("route"),
		method: z.string().regex(/^[A-Z]{3,7}$/),
		path: z.string().startsWith("/").max(500),
	}),
	z.strictObject({
		kind: z.literal("table"),
		name: z.string().min(1).max(200),
	}),
	z.strictObject({
		kind: z.literal("config_key"),
		name: z.string().min(1).max(200),
	}),
]);
/** Maps a stack trace (and optional logs) onto one indexed revision; nothing is stored. */
export const MapStackTraceRequestSchema = z.strictObject({
	trace: z.string().min(1).max(100_000),
	logs: z.string().max(200_000).optional(),
	/** The commit the error came from, when known: its snapshot is used if one exists. */
	commit_sha: z
		.string()
		.regex(/^[0-9a-f]{40}$/)
		.optional(),
	snapshot_id: idSchema("snap").optional(),
});
export const ChangeImpactRequestSchema = z.strictObject({
	targets: z.array(ImpactTargetSchema).min(1).max(20),
	// A table change reaches a page through service → handler → route → client → handler → component.
	depth: z.number().int().min(1).max(8).default(6),
	limit: z.number().int().min(1).max(300).default(150),
	snapshot_id: idSchema("snap").optional(),
});
export const GraphNeighborsQuerySchema = z.object({
	direction: z.enum(["in", "out", "both"]).default("both"),
	edge: GraphEdgeKindSchema.optional(),
	depth: z.coerce.number().int().min(1).max(3).default(1),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const GraphImpactQuerySchema = z.object({
	depth: z.coerce.number().int().min(1).max(4).default(3),
	limit: z.coerce.number().int().min(1).max(300).default(100),
});
export const RepositorySearchQuerySchema = z.object({
	q: z.string().trim().min(2).max(100),
	/** `all` ranks symbols, files, routes, tables, documentation, and text hits together. */
	mode: z.enum(["all", "text", "symbol"]).default("text"),
	snapshot_id: idSchema("snap").optional(),
	limit: z.coerce.number().int().min(1).max(100).default(30),
});

// ---- Feasibility and change assessment --------------------------------------------------------

export const AssessmentStatusSchema = z.enum([
	"SUPPORTED",
	"SUPPORTED_WITH_CHANGES",
	"BLOCKED",
	"INSUFFICIENT_EVIDENCE",
]);
export const ChangeSizeSchema = z.enum(["SMALL", "MEDIUM", "LARGE", "UNKNOWN"]);

export const CreateAssessmentRequestSchema = z.strictObject({
	request: z.string().trim().min(10).max(4000),
	/** Optional hints: tracked paths or symbol names the requester believes are involved. */
	targets: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
	snapshot_id: idSchema("snap").optional(),
});

const shortText = (max: number) => z.string().min(1).max(max);

/** Model output for `assess_feasibility`; every reference is an evidence handle from the pack. */
export const FeasibilityOutputSchema = z.strictObject({
	understanding: shortText(1000),
	status: AssessmentStatusSchema,
	status_rationale: shortText(1500),
	relevant_components: z
		.array(z.strictObject({ citation: CitationSchema, role: shortText(300) }))
		.max(15),
	reusable_capabilities: z
		.array(
			z.strictObject({ citation: CitationSchema, description: shortText(300) }),
		)
		.max(10),
	missing: z
		.array(
			z.strictObject({
				kind: z.enum([
					"code",
					"interface",
					"dependency",
					"data_model",
					"infrastructure",
					"configuration",
					"other",
				]),
				description: shortText(400),
			}),
		)
		.max(10),
	external_assumptions: z.array(shortText(300)).max(10),
	risks: z
		.array(
			z.strictObject({
				category: z.enum([
					"compatibility",
					"security",
					"performance",
					"regression",
					"other",
				]),
				description: shortText(400),
				citations: z.array(CitationSchema).max(5),
			}),
		)
		.max(10),
	unknowns: z.array(shortText(300)).max(10),
	next_steps: z.array(shortText(300)).max(8),
	confidence: ConfidenceSchema,
	confidence_rationale: shortText(800),
});

// ---- Engineering questions --------------------------------------------------------------------

export const AnswerStatusSchema = z.enum([
	"ANSWERED",
	"PARTIALLY_ANSWERED",
	"INSUFFICIENT_EVIDENCE",
]);

export const AskQuestionRequestSchema = z.strictObject({
	question: z.string().trim().min(5).max(2000),
	/** Optional hints: tracked paths or symbol names the asker believes are involved. */
	targets: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
	snapshot_id: idSchema("snap").optional(),
	/** A completed question on the same repository that this one follows up. */
	follow_up_of: idSchema("asm").optional(),
});

/** Model output for `answer_question`: the claims carry the evidence; `answer` summarizes them. */
export const AnswerOutputSchema = z.strictObject({
	status: AnswerStatusSchema,
	answer: shortText(3000),
	claims: z
		.array(
			z.strictObject({
				statement: shortText(600),
				citations: z.array(CitationSchema).max(5),
			}),
		)
		.max(12),
	unknowns: z.array(shortText(300)).max(8),
	follow_up_questions: z.array(shortText(200)).max(4),
	confidence: ConfidenceSchema,
	confidence_rationale: shortText(800),
});

export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;
export type GraphEdgeKind = z.infer<typeof GraphEdgeKindSchema>;
export type EdgeCertainty = z.infer<typeof EdgeCertaintySchema>;
export type SnapshotStatus = z.infer<typeof SnapshotStatusSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type IndexRepositoryRequest = z.infer<
	typeof IndexRepositoryRequestSchema
>;
export type GraphNodeSearchQuery = z.infer<typeof GraphNodeSearchQuerySchema>;
export type GraphNeighborsQuery = z.infer<typeof GraphNeighborsQuerySchema>;
export type GraphImpactQuery = z.infer<typeof GraphImpactQuerySchema>;
export type GraphTraceQuery = z.infer<typeof GraphTraceQuerySchema>;
export type GraphHistoryQuery = z.infer<typeof GraphHistoryQuerySchema>;
export type ImpactTarget = z.infer<typeof ImpactTargetSchema>;
export type ChangeImpactRequest = z.infer<typeof ChangeImpactRequestSchema>;
export type MapStackTraceRequest = z.infer<typeof MapStackTraceRequestSchema>;
export type RepositorySearchQuery = z.infer<typeof RepositorySearchQuerySchema>;
export type AssessmentStatus = z.infer<typeof AssessmentStatusSchema>;
export type ChangeSize = z.infer<typeof ChangeSizeSchema>;
export type CreateAssessmentRequest = z.infer<
	typeof CreateAssessmentRequestSchema
>;
export type FeasibilityOutput = z.infer<typeof FeasibilityOutputSchema>;
export type AnswerStatus = z.infer<typeof AnswerStatusSchema>;
export type AskQuestionRequest = z.infer<typeof AskQuestionRequestSchema>;
export type AnswerOutput = z.infer<typeof AnswerOutputSchema>;
