import {
	AnswerStatusSchema,
	CheckKindSchema,
	CheckStatusSchema,
	ConfidenceSchema,
	EdgeCertaintySchema,
	EvidenceRefSchema,
	HypothesisStateSchema,
	InvestigationStageSchema,
	InvestigationStatusSchema,
	idSchema,
	PatchImpactResultSchema,
	PatchStatusSchema,
	ScopeSchema,
	SnapshotStatusSchema,
	StepStatusSchema,
	VerificationOutcomeSchema,
} from "@tracera/contracts";
import { z } from "zod";

// Response schemas for the routes this app reads. packages/contracts has request schemas, shared
// enums, EvidenceRef, and PatchImpactResult, but no response views for most routes, so each schema
// here mirrors the server function named in its comment. z.object() drops unknown fields;
// only the fields the UI shows are declared.

const timestamp = z.iso.datetime();
const commitSha = z.string().regex(/^[0-9a-f]{40,64}$/);
const count = z.number().int().nonnegative();
const role = z.enum(["owner", "member"]);
const ErrorInfoSchema = z.object({
	code: z.string(),
	message: z.string(),
	retryable: z.boolean().optional(),
});

/** POST /api/v1/auth/login: `login()` in apps/server/src/modules/auth.ts. */
export const SignInResponseSchema = z.object({
	user: z.object({
		id: idSchema("usr"),
		email: z.string(),
		display_name: z.string(),
	}),
	workspace: z.object({ id: idSchema("wsp"), name: z.string(), role }),
});

/** GET /api/v1/auth/me: `describeMe()` in apps/server/src/modules/auth.ts (it may omit names). */
export const SessionSchema = z.object({
	user: z.object({
		id: idSchema("usr"),
		email: z.string().optional(),
		display_name: z.string().optional(),
	}),
	workspace: z.object({
		id: idSchema("wsp"),
		name: z.string().optional(),
		role,
	}),
	auth: z.object({
		type: z.enum(["session", "token"]),
		scopes: z.array(ScopeSchema).nullable(),
	}),
});

/** GET /readyz (`registerRoutes()` in apps/server/src/api/routes.ts); public, no secrets. */
export const ReadinessSchema = z.object({
	status: z.enum(["ready", "not_ready"]),
	worker: z.string(),
	sandbox: z.unknown(),
	inference_provider: z.string(),
	inference_mode: z.string(),
});

/** `IndexProgress` in apps/server/src/db/schema.ts. The phase is displayed as reported. */
const IndexProgressSchema = z.object({
	phase: z.string(),
	done: count,
	total: count,
	updated_at: timestamp,
});

/**
 * GET /api/v1/repositories (`items`) and GET /api/v1/repositories/{id} (`repository`): `toView()` in
 * apps/server/src/modules/repositories.ts.
 */
export const RepositorySchema = z.object({
	id: idSchema("repo"),
	name: z.string(),
	source_type: z.string(),
	source_display: z.string(),
	default_branch: z.string(),
	synthetic: z.boolean(),
	commands: z
		.object({
			install: z.string(),
			test: z.string(),
			typecheck: z.string().nullable(),
			lint: z.string().nullable(),
			build: z.string().nullable(),
		})
		.optional(),
	/** The newest snapshot, whatever its status. */
	index: z
		.object({
			snapshot_id: idSchema("snap"),
			status: SnapshotStatusSchema,
			commit_sha: commitSha,
			progress: IndexProgressSchema.nullable(),
			error: ErrorInfoSchema.nullable(),
			created_at: timestamp,
			finished_at: timestamp.nullable(),
		})
		.nullable(),
});
export const RepositoryListSchema = z.object({
	items: z.array(RepositorySchema),
	next_cursor: z.string().nullable(),
});
export const RepositoryResponseSchema = z.object({
	repository: RepositorySchema,
});

/** `toSnapshotView()` in apps/server/src/modules/graph.ts. */
export const SnapshotSchema = z.object({
	id: idSchema("snap"),
	ref: z.string(),
	commit_sha: commitSha,
	status: SnapshotStatusSchema,
	extractor_version: z.string(),
	progress: IndexProgressSchema.nullable(),
	cancel_requested_at: timestamp.nullable(),
	error: ErrorInfoSchema.nullable(),
	created_at: timestamp,
	started_at: timestamp.nullable(),
	finished_at: timestamp.nullable(),
});
/** GET /api/v1/repositories/{id}/snapshots: `listSnapshots()` in apps/server/src/modules/graph-queries.ts. */
export const SnapshotListSchema = z.object({
	snapshots: z.array(SnapshotSchema),
});
/** POST /api/v1/repositories (201): the route in apps/server/src/api/routes.ts. */
export const RegisterResponseSchema = z.object({
	repository: RepositorySchema,
	snapshot: SnapshotSchema.nullable(),
});
/** POST …/{id}/index and POST /snapshots/{id}/cancel: `{snapshot}`. */
export const SnapshotResponseSchema = z.object({ snapshot: SnapshotSchema });

/**
 * `GraphCoverage` in apps/server/src/modules/graph-build.ts. It is stored per snapshot, and a snapshot
 * from an older extractor version may lack newer fields, so everything except `complete` is optional
 * and shown as "not reported" when absent.
 */
const CoverageSchema = z.object({
	complete: z.boolean(),
	parsed_files: count.optional(),
	parse_failures: z
		.array(
			z.object({
				path: z.string(),
				message: z.string(),
				line: z.number().int().nullable(),
			}),
		)
		.optional(),
	unsupported_code_files: z.record(z.string(), count).optional(),
	unresolved: z
		.object({
			imports: count.optional(),
			calls: count.optional(),
			member_calls: count.optional(),
			requests: count.optional(),
			route_handlers: count.optional(),
			routes_with_unknown_prefix: count.optional(),
		})
		.optional(),
	truncated_files: z.array(z.string()).optional(),
	notes: z.array(z.string()).optional(),
});

/** `snapshotFreshness()` in apps/server/src/modules/graph-queries.ts. */
const FreshnessSchema = z.object({
	stale: z.boolean().nullable(),
	ref: z.string(),
	indexed_commit: commitSha,
	current_commit: commitSha.nullable(),
	reasons: z.array(z.string()),
	checked_at: timestamp,
});

/** GET /api/v1/repositories/{id}/profile: `getRepositoryProfile()` in apps/server/src/modules/graph-queries.ts. */
export const ProfileSchema = z.object({
	/** The newest usable (ready or partial) snapshot; coverage and freshness describe it. */
	snapshot: SnapshotSchema,
	coverage: CoverageSchema.nullable(),
	freshness: FreshnessSchema,
	/** The newest snapshot when it is not the usable one (for example still indexing). */
	latest_snapshot: SnapshotSchema.nullable(),
});

// ---- Graph (apps/server/src/modules/graph-queries.ts, graph-insights.ts) -------------------------

/** `toNodeView()`. */
export const NodeSchema = z.object({
	id: idSchema("gnd"),
	key: z.string(),
	kind: z.string(),
	name: z.string(),
	path: z.string().nullable(),
	start_line: z.number().int().nullable(),
	end_line: z.number().int().nullable(),
	language: z.string().nullable(),
});
/** `toEdgeView()`. */
export const EdgeSchema = z.object({
	id: z.number().int(),
	kind: z.string(),
	from_key: z.string(),
	from_node_id: z.string().nullable(),
	to_key: z.string().nullable(),
	to_node_id: z.string().nullable(),
	target_text: z.string().nullable(),
	certainty: EdgeCertaintySchema,
});

/** GET /repositories/{id}/search?mode=all: `searchAll()`. */
export const SearchResponseSchema = z.object({
	snapshot: SnapshotSchema,
	results: z.array(
		z.object({
			match: z.object({ kind: z.string(), reason: z.string() }),
			node: NodeSchema.nullable(),
			evidence: EvidenceRefSchema,
		}),
	),
	truncated: z.boolean(),
	limitations: z.array(z.string()),
	semantic: z.object({ available: z.boolean(), reason: z.string() }).optional(),
});

/** GET /graph/nodes/{id}: `getGraphNode()`. */
export const NodeDetailSchema = z.object({
	snapshot: SnapshotSchema,
	node: NodeSchema,
	evidence: EvidenceRefSchema,
	outgoing: z.array(EdgeSchema),
	incoming: z.array(EdgeSchema),
	truncated: z.object({ outgoing: z.boolean(), incoming: z.boolean() }),
});

/** GET /graph/nodes/{id}/trace: `traceFlow()`. */
export const TraceSchema = z.object({
	start: NodeSchema,
	direction: z.enum(["downstream", "upstream"]),
	nodes: z.array(NodeSchema.extend({ distance: z.number().int() })),
	edges: z.array(EdgeSchema),
	gaps: z.array(
		z.object({
			from_key: z.string(),
			kind: z.string(),
			target_text: z.string().nullable(),
			reason: z.string(),
		}),
	),
	truncated: z.boolean(),
	limitations: z.array(z.string()),
});

/** GET /graph/nodes/{id}/history: `nodeHistory()`. Author names only, never email addresses. */
export const HistorySchema = z.object({
	history: z.object({
		method: z.string(),
		commits: z.array(
			z.object({
				sha: z.string(),
				date: z.string(),
				author: z.string(),
				subject: z.string(),
			}),
		),
	}),
	blame: z.object({
		method: z.string(),
		lines: z.number().int(),
		commits: z.array(
			z.object({
				sha: z.string(),
				author: z.string(),
				date: z.string(),
				summary: z.string(),
				lines: z.number().int(),
			}),
		),
	}),
	owners: z.array(
		z.object({
			owner: z.string(),
			basis: z.string(),
			pattern: z.string().nullable(),
		}),
	),
	limitations: z.array(z.string()),
});

/** POST /repositories/{id}/impact: `analyzeImpact()`. */
export const ChangeImpactSchema = z.object({
	snapshot: SnapshotSchema,
	unresolved_targets: z.array(z.unknown()),
	affected: z.array(
		z.object({
			node: NodeSchema,
			category: z.string(),
			distance: z.number().int(),
			via: z.string(),
			certainty: z.string(),
			score: z.number(),
			reached_from: z.string(),
			why: z.array(
				z.object({
					from_key: z.string(),
					kind: z.string(),
					to_key: z.string(),
				}),
			),
		}),
	),
	groups: z.record(z.string(), z.number()),
	untested_targets: z.array(z.string()),
	owners: z.array(
		z.object({
			owner: z.string(),
			files: z.array(z.string()),
			basis: z.string(),
		}),
	),
	recent_commits: z.array(
		z.object({
			sha: z.string(),
			date: z.string(),
			subject: z.string(),
			files: z.array(z.string()),
		}),
	),
	truncated: z.boolean(),
	limitations: z.array(z.string()),
});

// ---- Engineering questions (apps/server/src/modules/assessment.ts) -------------------------------

/** A completed question's `result` (`answerQuestion()` plus the shared `partial`). */
const AnswerResultSchema = z.object({
	inference_mode: z.enum(["live", "mock"]),
	status: AnswerStatusSchema,
	model_status: AnswerStatusSchema,
	downgrades: z.array(z.string()),
	summary: z.object({ text: z.string(), basis: z.string() }),
	claims: z.array(
		z.object({
			statement: z.string(),
			basis: z.string(),
			supported: z.boolean(),
			evidence: z.array(EvidenceRefSchema),
		}),
	),
	unknowns: z.array(z.string()),
	follow_up_questions: z.array(z.string()),
	confidence: ConfidenceSchema,
	model_confidence: ConfidenceSchema,
	confidence_rationale: z.string(),
	citations: z.object({ total: count, invalid: count }),
	model: z.object({ provider: z.string(), model: z.string() }),
	limitations: z.array(z.string()),
});
/** Present on failed questions too: the deterministic part, without any verdict. */
const PartialResultSchema = z.object({
	inference_mode: z.enum(["live", "mock"]).optional(),
	limitations: z.array(z.string()).optional(),
});

/** `toAssessmentView()`; GET /assessments/{id} and POST …/questions return `{assessment}`. */
export const AssessmentSchema = z.object({
	id: idSchema("asm"),
	kind: z.enum(["feasibility", "question"]),
	repository_id: idSchema("repo"),
	commit_sha: z.string().nullable(),
	follow_up_of: z.string().nullable(),
	request: z.string(),
	status: z.enum(["queued", "running", "completed", "failed"]),
	result: z.record(z.string(), z.unknown()).nullable(),
	error: ErrorInfoSchema.nullable(),
	created_at: timestamp,
	finished_at: timestamp.nullable(),
});
export const AssessmentResponseSchema = z.object({
	assessment: AssessmentSchema,
});
export const parseAnswer = (result: unknown) =>
	AnswerResultSchema.safeParse(result);
export const parsePartial = (result: unknown) =>
	PartialResultSchema.safeParse(result);

// ---- Patch impact (apps/server/src/modules/patch-analysis.ts `toAnalysisView()`) ----------------

export const PatchAnalysisSchema = z.object({
	id: idSchema("pia"),
	base: z.object({ ref: z.string().nullable(), sha: z.string().nullable() }),
	head: z.object({
		ref: z.string().nullable(),
		sha: z.string().nullable(),
		diff_sha256: z.string().nullable(),
	}),
	merge_base: z.boolean(),
	status: z.enum([
		"queued",
		"running",
		"completed",
		"partial",
		"failed",
		"cancelled",
	]),
	progress: z.object({ phase: z.string(), updated_at: z.string() }).nullable(),
	/** Parsed where shown (parseImpact), so one unreadable result does not hide the analysis. */
	result: z.unknown().nullable(),
	error: ErrorInfoSchema.nullable(),
	cancel_requested_at: timestamp.nullable(),
	created_at: timestamp,
	finished_at: timestamp.nullable(),
});
/** A stored PatchImpactResult, validated against the shared contract when it is shown. */
export const parseImpact = (value: unknown) =>
	PatchImpactResultSchema.safeParse(value);
const UnavailableImpactSchema = z.object({
	available: z.literal(false),
	reason: z.string(),
});
export const parseUnavailableImpact = (value: unknown) =>
	UnavailableImpactSchema.safeParse(value);

export const PatchAnalysisResponseSchema = z.object({
	analysis: PatchAnalysisSchema,
});
export const PatchAnalysisListSchema = z.object({
	analyses: z.array(PatchAnalysisSchema),
});

// ---- Bug reports and investigations ------------------------------------------------------------

/** `toView()` in apps/server/src/modules/bug-reports.ts. */
export const BugReportSchema = z.object({
	id: idSchema("bug"),
	status: z.string(),
	source_channel: z.string(),
	title: z.string(),
	description: z.string(),
	expected_behavior: z.string().nullable(),
	actual_behavior: z.string().nullable(),
	steps: z.array(z.string()),
	severity: z.string(),
	repository_id: z.string().nullable(),
	normalization: z.object({
		status: z.string(),
		summary: z.string().nullable(),
	}),
	created_at: timestamp,
});
export const BugReportResponseSchema = z.object({
	bug_report: BugReportSchema,
});

/** `toView()` in apps/server/src/modules/investigations.ts. List items carry no steps or extras. */
export const InvestigationSchema = z.object({
	id: idSchema("inv"),
	status: InvestigationStatusSchema,
	state_version: z.number().int(),
	current_stage: InvestigationStageSchema.nullable(),
	mode: z.enum(["full", "analysis_only"]),
	mode_reason: z.string().nullable(),
	bug_report_id: idSchema("bug"),
	repository_id: idSchema("repo"),
	commit_sha: z.string(),
	flags: z.array(z.string()),
	progress: z.object({
		stage_index: z.number().int(),
		stage_count: z.number().int(),
		message: z.string(),
	}),
	steps: z.array(
		z.object({
			stage: InvestigationStageSchema,
			specialists: z.array(z.string()).optional(),
			attempt: z.number().int(),
			status: StepStatusSchema,
			started_at: timestamp.nullable(),
			finished_at: timestamp.nullable(),
			error: ErrorInfoSchema.nullable(),
		}),
	),
	needs_input: z.object({ code: z.string(), question: z.string() }).nullable(),
	counts: z.object({
		findings: count,
		hypotheses: count,
		reproductions: count,
		patches: count,
	}),
	baseline_reproduction: z
		.object({ status: z.string(), reason: z.string().nullable() })
		.nullable(),
	latest_patch: z
		.object({ id: idSchema("pat"), status: PatchStatusSchema })
		.nullable(),
	latest_verification: z
		.object({
			id: idSchema("ver"),
			outcome: VerificationOutcomeSchema,
			outcome_reasons: z.array(z.string()),
		})
		.nullable(),
	inference: z.object({ provider: z.string(), mock: z.boolean() }),
	failure: z
		.object({
			stage: z.string(),
			code: z.string(),
			message: z.string(),
			retryable: z.boolean(),
		})
		.nullable(),
	created_at: timestamp,
	finished_at: timestamp.nullable(),
});
export const InvestigationResponseSchema = z.object({
	investigation: InvestigationSchema,
});
export const InvestigationListSchema = z.object({
	items: z.array(InvestigationSchema),
	next_cursor: z.string().nullable(),
});

/** `getFindings()` in apps/server/src/modules/results.ts. */
const EvidenceItemSchema = z.object({
	handle: z.string(),
	kind: z.string(),
	basis: z.string(),
	label: z.string(),
	content: z.string(),
	/** Where the item came from; code references carry `path`, `start_line`, and `end_line`. */
	locator: z.record(z.string(), z.unknown()).optional(),
});
const CiteSchema = z.object({
	handle: z.string(),
	start_line: z.number().int().nullable(),
	end_line: z.number().int().nullable(),
	label: z.string().nullable(),
});
export const FindingsSchema = z.object({
	reported_claims: z.array(EvidenceItemSchema),
	observed_facts: z.array(EvidenceItemSchema),
	code_references: z.array(EvidenceItemSchema),
	commits: z.array(EvidenceItemSchema),
	experiments: z.array(EvidenceItemSchema),
	model_observations: z.array(EvidenceItemSchema),
	hypotheses: z.array(
		z.object({
			id: idSchema("hyp"),
			handle: z.string(),
			rank: z.number().int(),
			title: z.string(),
			state: HypothesisStateSchema,
			label: z.string(),
			confidence: ConfidenceSchema,
			confidence_rationale: z.string(),
			mechanism: z.string(),
			locations: z.array(CiteSchema),
			supporting: z.array(CiteSchema),
			contradicting: z.array(CiteSchema),
			alternatives: z.array(z.string()),
			next_check: z.string(),
		}),
	),
	open_questions: z.array(
		z.object({ question: z.string(), why_it_matters: z.string() }),
	),
	insufficient_evidence: z.object({ reason: z.string().nullable() }).nullable(),
	model_disclosure: z.object({
		providers: z.array(z.string()),
		models: z.array(z.string()),
		mock: z.boolean(),
	}),
});

/** `listReproductions()` in apps/server/src/modules/results.ts (sandbox runs). */
export const ReproductionListSchema = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			purpose: z.string(),
			status: z.string(),
			exit_code: z.number().int().nullable(),
			duration_ms: z.number().int(),
			truncated: z.boolean(),
			argv: z.array(z.string()),
			image: z.string(),
			started_at: timestamp,
		}),
	),
});

/** `patchView()` in apps/server/src/modules/results.ts. */
export const PatchSchema = z.object({
	id: idSchema("pat"),
	investigation_id: idSchema("inv"),
	hypothesis_handle: z.string().nullable(),
	attempt: z.number().int(),
	status: PatchStatusSchema,
	base_commit: z.string(),
	summary: z.string(),
	rationale: z.string(),
	expected_effect: z.string(),
	risks: z.array(z.object({ code: z.string(), message: z.string() })),
	files: z.array(
		z.object({
			path: z.string(),
			change_type: z.string(),
			additions: z.number().int(),
			deletions: z.number().int(),
		}),
	),
	diff_sha256: z.string().nullable(),
	apply_error: ErrorInfoSchema.nullable(),
	/** `{available: true, ...PatchImpactResult}` or `{available: false, reason}`; parsed where shown. */
	impact: z.unknown().nullable(),
	verification: z
		.object({
			id: idSchema("ver"),
			outcome: VerificationOutcomeSchema,
			label: z.string(),
			outcome_reasons: z.array(z.string()),
		})
		.nullable(),
	approval: z
		.object({
			decision: z.enum(["approved", "rejected", "changes_requested"]),
			outcome_at_decision: z.string(),
			comment: z.string().nullable(),
			acknowledged_risks: z.array(z.string()),
			decided_by: z.string(),
			decided_at: timestamp,
		})
		.nullable(),
	model: z.object({ provider: z.string(), model: z.string() }).nullable(),
	created_at: timestamp,
});
export const PatchListSchema = z.object({ items: z.array(PatchSchema) });
export const PatchResponseSchema = z.object({ patch: PatchSchema });
/** `getPatchDiff()`: at most 200,000 characters of the stored diff. */
export const PatchDiffSchema = z.object({
	diff: z.string(),
	truncated: z.boolean(),
	diff_sha256: z.string(),
});

/** `VerificationEnvironment` in apps/server/src/db/schema.ts. */
const VerificationEnvironmentSchema = z.object({
	executor: z.string(),
	image: z.string().nullable(),
	network: z.string(),
	dependencies: z
		.object({
			snapshot_id: z.string(),
			manager: z.string(),
			lockfile_sha256: z.string(),
		})
		.nullable(),
	dependencies_blocked: z.string().nullable(),
});
const CheckSchema = z.object({
	kind: CheckKindSchema,
	status: CheckStatusSchema,
	reason: z.string().nullable(),
	command: z.string().nullable(),
	exit_code: z.number().int().nullable(),
	duration_ms: z.number().int().nullable(),
	summary: z.record(z.string(), z.unknown()),
});
/**
 * `getVerification()` in apps/server/src/modules/results.ts. `environment` is being added to this
 * route by the lead (optional here); until it is, the report's verification environment is shown.
 */
export const VerificationSchema = z.object({
	id: idSchema("ver"),
	patch_id: idSchema("pat"),
	status: z.string(),
	outcome: VerificationOutcomeSchema,
	label: z.string(),
	outcome_reasons: z.array(z.string()),
	checks: z.array(CheckSchema),
	environment: VerificationEnvironmentSchema.nullable().optional(),
	started_at: timestamp,
	finished_at: timestamp,
});
export const VerificationResponseSchema = z.object({
	verification: VerificationSchema,
});

/** POST /patches/{id}/approval (201): `decidePatch()`. */
export const ApprovalResponseSchema = z.object({
	investigation: z.object({
		id: idSchema("inv"),
		status: InvestigationStatusSchema,
	}),
});

/** `ResolutionReportContent` in apps/server/src/modules/report.ts, under GET …/report `{report}`. */
export const ReportSchema = z.object({
	report: z.object({
		id: z.string(),
		version: z.number().int(),
		created_at: timestamp,
		generated_with: z.object({
			method: z.string(),
			providers: z.array(z.string()),
			models: z.array(z.string()),
			mock: z.boolean(),
			placeholder_provider: z.boolean(),
		}),
		original_issue: z.object({ title: z.string(), description: z.string() }),
		reproduction: z.object({
			baseline: z.string(),
			label: z.string(),
			reason: z.string().nullable(),
			summary: z.string(),
		}),
		confirmed_findings: z.array(
			z.object({
				handle: z.string(),
				title: z.string(),
				mechanism: z.string(),
			}),
		),
		unverified_hypotheses: z.array(
			z.object({
				handle: z.string(),
				title: z.string(),
				label: z.string(),
				confidence: z.string(),
			}),
		),
		proposed_change: z
			.object({
				patch_id: z.string(),
				status: z.string(),
				summary: z.string(),
				files: z.array(z.object({ path: z.string() })),
				risks: z.array(z.object({ code: z.string(), message: z.string() })),
			})
			.nullable(),
		verification: z.object({
			outcome: VerificationOutcomeSchema,
			label: z.string(),
			reasons: z.array(z.string()),
			environment: VerificationEnvironmentSchema.nullable(),
			checks: z.array(CheckSchema),
		}),
		limitations: z.array(z.string()),
		recommended_next_step: z.string(),
		decisions: z.array(
			z.object({
				decision: z.string(),
				by: z.string(),
				at: z.string(),
				comment: z.string().nullable(),
			}),
		),
	}),
});

export type Session = z.infer<typeof SessionSchema>;
export type Repository = z.infer<typeof RepositorySchema>;
export type RepositoryIndex = NonNullable<Repository["index"]>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type IndexProgress = z.infer<typeof IndexProgressSchema>;
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Freshness = z.infer<typeof FreshnessSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type GraphNode = z.infer<typeof NodeSchema>;
export type GraphEdge = z.infer<typeof EdgeSchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;
export type AnswerResult = z.infer<typeof AnswerResultSchema>;
export type PatchAnalysis = z.infer<typeof PatchAnalysisSchema>;
export type Investigation = z.infer<typeof InvestigationSchema>;
export type Findings = z.infer<typeof FindingsSchema>;
export type Patch = z.infer<typeof PatchSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
export type VerificationEnvironment = z.infer<
	typeof VerificationEnvironmentSchema
>;
export type Check = z.infer<typeof CheckSchema>;
export type Report = z.infer<typeof ReportSchema>["report"];
