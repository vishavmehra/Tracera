import type {
	CheckKind,
	CheckStatus,
	FieldBasis,
	PatchImpactResult,
	ValueSource,
} from "@tracera/contracts";
import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

// Column names are snake_case via `casing: "snake_case"`.

const ts = () => timestamp({ withTimezone: true, mode: "date" });
const createdAt = () => ts().notNull().defaultNow();
const updatedAt = () => ts().notNull().defaultNow();
const emptyTextArray = sql`'{}'::text[]`;

export const workspaceRole = pgEnum("workspace_role", ["owner", "member"]);
export const clientKind = pgEnum("client_kind", ["extension", "mcp", "script"]);
export const repositorySourceType = pgEnum("repository_source_type", [
	"fixture",
	"local_path",
	"git_url",
]);
export const bugReportStatus = pgEnum("bug_report_status", [
	"draft",
	"open",
	"investigating",
	"resolved",
	"closed",
	"dismissed",
]);
export const severity = pgEnum("severity", [
	"critical",
	"high",
	"medium",
	"low",
	"unknown",
]);
export const priority = pgEnum("priority", ["p0", "p1", "p2", "p3", "unknown"]);
export const sourceChannel = pgEnum("source_channel", [
	"web",
	"extension",
	"meeting",
	"mcp",
	"api",
]);
export const normalizationStatus = pgEnum("normalization_status", [
	"not_requested",
	"queued",
	"done",
	"failed",
]);
export const evidenceKind = pgEnum("evidence_kind", [
	"screenshot",
	"screen_recording",
	"meeting_transcript",
	"meeting_recording",
	"console_log",
	"network_log",
	"stack_trace",
	"log_file",
	"text_note",
	"repro_trace",
	"repro_screenshot",
	"test_output",
	"sandbox_log",
	"ai_annotation",
]);
export const evidenceOrigin = pgEnum("evidence_origin", [
	"user_provided",
	"captured_by_extension",
	"imported_from_provider",
	"generated_by_tool",
	"generated_by_model",
]);
export const investigationStatus = pgEnum("investigation_status", [
	"queued",
	"running",
	"needs_input",
	"awaiting_approval",
	"completed",
	"failed",
	"cancelled",
]);
export const investigationStage = pgEnum("investigation_stage", [
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
export const investigationMode = pgEnum("investigation_mode", [
	"full",
	"analysis_only",
]);
export const modelProfile = pgEnum("model_profile", ["standard", "deep"]);
export const stepStatus = pgEnum("step_status", [
	"pending",
	"running",
	"succeeded",
	"failed",
	"skipped",
	"blocked",
	"cancelled",
]);
export const actorType = pgEnum("actor_type", [
	"user",
	"api_token",
	"mcp",
	"worker",
	"system",
]);
export const modelExecutionStatus = pgEnum("model_execution_status", [
	"succeeded",
	"failed",
	"invalid_output",
	"cancelled",
	"budget_exceeded",
]);

export type FieldProvenance = {
	source: ValueSource;
	basis?: FieldBasis | null;
	model_execution_id?: string | null;
	evidence_ids?: string[];
};
export type EnvironmentInfo = {
	browser?: string | null;
	os?: string | null;
	user_agent?: string | null;
	viewport?: { width: number; height: number } | string | null;
	app_version?: string | null;
};
export type RepositoryCommands = {
	install: string;
	test: string;
	typecheck?: string;
	lint?: string;
	build?: string;
	start?: string;
};
export type RepositoryApp = {
	port: number;
	ready_path: string;
	base_url_path?: string;
};
export type ErrorInfo = { code: string; message: string; retryable?: boolean };

export const users = pgTable("users", {
	id: text().primaryKey(),
	email: text().notNull().unique(),
	displayName: text().notNull(),
	passwordHash: text().notNull(),
	disabledAt: ts(),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const workspaces = pgTable("workspaces", {
	id: text().primaryKey(),
	name: text().notNull(),
	settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

export const workspaceMembers = pgTable(
	"workspace_members",
	{
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		userId: text()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: workspaceRole().notNull(),
		createdAt: createdAt(),
	},
	(t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const sessions = pgTable("sessions", {
	id: text().primaryKey(),
	userId: text()
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	workspaceId: text()
		.notNull()
		.references(() => workspaces.id, { onDelete: "cascade" }),
	tokenHash: text().notNull().unique(),
	expiresAt: ts().notNull(),
	lastSeenAt: ts().notNull().defaultNow(),
	ip: text(),
	userAgent: text(),
	createdAt: createdAt(),
});

export const apiTokens = pgTable("api_tokens", {
	id: text().primaryKey(),
	workspaceId: text()
		.notNull()
		.references(() => workspaces.id, { onDelete: "cascade" }),
	userId: text()
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	name: text().notNull(),
	clientKind: clientKind().notNull(),
	tokenPrefix: text().notNull(),
	tokenHash: text().notNull().unique(),
	scopes: text().array().notNull(),
	expiresAt: ts().notNull(),
	lastUsedAt: ts(),
	revokedAt: ts(),
	createdAt: createdAt(),
});

export const repositories = pgTable(
	"repositories",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text().notNull(),
		sourceType: repositorySourceType().notNull(),
		sourceRef: text().notNull(),
		defaultBranch: text().notNull(),
		synthetic: boolean().notNull().default(false),
		commands: jsonb().$type<RepositoryCommands>().notNull(),
		app: jsonb().$type<RepositoryApp>(),
		allowInstallScripts: boolean().notNull().default(false),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex().on(t.workspaceId, t.name)],
);

export const bugReports = pgTable(
	"bug_reports",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		repositoryId: text().references(() => repositories.id, {
			onDelete: "set null",
		}),
		status: bugReportStatus().notNull().default("open"),
		sourceChannel: sourceChannel().notNull(),
		title: text().notNull(),
		description: text().notNull(),
		expectedBehavior: text(),
		actualBehavior: text(),
		steps: jsonb().$type<string[]>().notNull().default([]),
		environment: jsonb().$type<EnvironmentInfo>().notNull().default({}),
		affectedUrl: text(),
		severity: severity().notNull().default("unknown"),
		priority: priority().notNull().default("unknown"),
		fieldProvenance: jsonb()
			.$type<Record<string, FieldProvenance>>()
			.notNull()
			.default({}),
		suspectedComponents: jsonb()
			.$type<Array<{ label: string; source: ValueSource }>>()
			.notNull()
			.default([]),
		unresolvedQuestions: jsonb()
			.$type<
				Array<{ question: string; why_it_matters: string; source: ValueSource }>
			>()
			.notNull()
			.default([]),
		normalizationStatus: normalizationStatus()
			.notNull()
			.default("not_requested"),
		normalizedAt: ts(),
		normalizationResult: jsonb().$type<Record<string, unknown>>(),
		normalizationError: jsonb().$type<ErrorInfo>(),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index().on(t.workspaceId, t.createdAt.desc(), t.id.desc())],
);

export const investigations = pgTable(
	"investigations",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		bugReportId: text()
			.notNull()
			.references(() => bugReports.id, { onDelete: "cascade" }),
		repositoryId: text()
			.notNull()
			.references(() => repositories.id, { onDelete: "restrict" }),
		commitSha: text().notNull(),
		status: investigationStatus().notNull().default("queued"),
		stateVersion: integer().notNull().default(0),
		flags: text().array().notNull().default(emptyTextArray),
		currentStage: investigationStage(),
		mode: investigationMode().notNull(),
		modeReason: text(),
		modelProfile: modelProfile().notNull().default("standard"),
		interactive: boolean().notNull().default(true),
		progress: jsonb()
			.$type<{ stage_index: number; stage_count: number; message: string }>()
			.notNull(),
		needsInput: jsonb().$type<{
			code: string;
			question: string;
			fields: string[];
		}>(),
		configSnapshot: jsonb().$type<Record<string, unknown>>().notNull(),
		cancelRequestedAt: ts(),
		startedAt: ts(),
		finishedAt: ts(),
		failure: jsonb().$type<{
			stage: string;
			code: string;
			message: string;
			retryable: boolean;
		}>(),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		// One active investigation per bug report, enforced by the database.
		uniqueIndex("investigations_one_active_per_bug_report")
			.on(t.bugReportId)
			.where(
				sql`${t.status} in ('queued', 'running', 'needs_input', 'awaiting_approval')`,
			),
		index().on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
	],
);

export const investigationSteps = pgTable(
	"investigation_steps",
	{
		id: text().primaryKey(),
		investigationId: text()
			.notNull()
			.references(() => investigations.id, { onDelete: "cascade" }),
		stage: investigationStage().notNull(),
		attempt: integer().notNull(),
		status: stepStatus().notNull(),
		startedAt: ts(),
		finishedAt: ts(),
		summary: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		error: jsonb().$type<ErrorInfo>(),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex().on(t.investigationId, t.stage, t.attempt)],
);

export const evidenceAssets = pgTable(
	"evidence_assets",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		bugReportId: text().references(() => bugReports.id, {
			onDelete: "cascade",
		}),
		investigationId: text().references(() => investigations.id, {
			onDelete: "cascade",
		}),
		derivedFromEvidenceId: text(),
		kind: evidenceKind().notNull(),
		origin: evidenceOrigin().notNull(),
		blobSha256: text().notNull(),
		mimeType: text().notNull(),
		sizeBytes: integer().notNull(),
		originalFilename: text(),
		capturedAt: ts(),
		provenance: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		redactions: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		sensitivity: text().array().notNull().default(emptyTextArray),
		retentionUntil: ts().notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		check(
			"evidence_single_owner",
			sql`(${t.bugReportId} is not null)::int + (${t.investigationId} is not null)::int = 1`,
		),
		index().on(t.bugReportId),
	],
);

export const modelExecutions = pgTable(
	"model_executions",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		investigationId: text().references(() => investigations.id, {
			onDelete: "set null",
		}),
		bugReportId: text().references(() => bugReports.id, {
			onDelete: "set null",
		}),
		assessmentId: text(),
		task: text().notNull(),
		promptVersion: text().notNull(),
		provider: text().notNull(),
		model: text().notNull(),
		requestHash: text().notNull(),
		status: modelExecutionStatus().notNull(),
		inputTokens: integer().notNull().default(0),
		outputTokens: integer().notNull().default(0),
		reasoningTokens: integer().notNull().default(0),
		cachedTokens: integer().notNull().default(0),
		latencyMs: integer().notNull().default(0),
		estimatedCostUsd: numeric({ precision: 10, scale: 6 })
			.notNull()
			.default("0"),
		redactionCount: integer().notNull().default(0),
		attempts: integer().notNull().default(1),
		error: jsonb().$type<ErrorInfo>(),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.workspaceId, t.createdAt)],
);

/** Append-only (UPDATE/DELETE blocked by a trigger in migration 0001). No content, no secrets. */
export const auditEvents = pgTable(
	"audit_events",
	{
		id: text().primaryKey(),
		workspaceId: text().notNull(),
		actorType: actorType().notNull(),
		actorId: text(),
		action: text().notNull(),
		targetType: text().notNull(),
		targetId: text().notNull(),
		metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		requestId: text(),
		createdAt: createdAt(),
	},
	(t) => [
		index().on(t.workspaceId, t.createdAt),
		index().on(t.targetType, t.targetId),
	],
);

// ---- Investigation evidence, hypotheses, sandbox runs, patches, verification, reports ----

export const evidenceBasis = pgEnum("evidence_basis", [
	"observed",
	"reported",
	"inferred",
]);
export const hypothesisState = pgEnum("hypothesis_state", [
	"proposed",
	"supported",
	"contradicted",
	"confirmed",
	"rejected",
]);
export const confidence = pgEnum("confidence", ["low", "medium", "high"]);
export const patchStatus = pgEnum("patch_status", [
	"proposed",
	"apply_failed",
	"superseded",
	"approved",
	"rejected",
	"changes_requested",
]);
export const verificationOutcome = pgEnum("verification_outcome", [
	"verified",
	"partially_verified",
	"failed",
	"inconclusive",
	"blocked",
	"not_attempted",
]);
export const sandboxRunStatus = pgEnum("sandbox_run_status", [
	"exited",
	"timed_out",
	"cancelled",
	"limit_exceeded",
	"executor_error",
]);

export type EvidenceItemKind =
	| "report_claim"
	| "evidence_asset"
	| "code_excerpt"
	| "commit"
	| "repository_fact"
	| "reproduction"
	| "model_observation";
export type StoredCitation = {
	handle: string;
	start_line: number | null;
	end_line: number | null;
};
export type CheckRecord = {
	kind: CheckKind;
	status: CheckStatus;
	reason: string | null;
	command: string | null;
	exit_code: number | null;
	duration_ms: number | null;
	summary: Record<string, unknown>;
	sandbox_run_ids: string[];
};

/**
 * Every citable item of an investigation, addressed by a stable handle (EV-n, CODE-n, COMMIT-n,
 * FIND-n, REPRO-n). Models cite handles; citations are validated against these rows.
 */
export const investigationEvidence = pgTable(
	"investigation_evidence",
	{
		id: text().primaryKey(),
		investigationId: text()
			.notNull()
			.references(() => investigations.id, { onDelete: "cascade" }),
		handle: text().notNull(),
		kind: text().$type<EvidenceItemKind>().notNull(),
		basis: evidenceBasis().notNull(),
		label: text().notNull(),
		content: text().notNull(),
		locator: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		provenance: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		stage: investigationStage().notNull(),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex().on(t.investigationId, t.handle)],
);

export const hypotheses = pgTable(
	"hypotheses",
	{
		id: text().primaryKey(),
		investigationId: text()
			.notNull()
			.references(() => investigations.id, { onDelete: "cascade" }),
		handle: text().notNull(),
		rank: integer().notNull(),
		title: text().notNull(),
		mechanism: text().notNull(),
		locations: jsonb().$type<StoredCitation[]>().notNull(),
		supporting: jsonb().$type<StoredCitation[]>().notNull(),
		contradicting: jsonb().$type<StoredCitation[]>().notNull(),
		alternatives: jsonb().$type<string[]>().notNull(),
		nextCheck: text().notNull(),
		confidence: confidence().notNull(),
		confidenceRationale: text().notNull(),
		state: hypothesisState().notNull(),
		score: integer().notNull().default(0),
		modelExecutionId: text(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex().on(t.investigationId, t.handle)],
);

/** One sandbox execution (the execution audit record). Output bodies live in the blob store. */
export const sandboxRuns = pgTable(
	"sandbox_runs",
	{
		id: text().primaryKey(),
		investigationId: text()
			.notNull()
			.references(() => investigations.id, { onDelete: "cascade" }),
		patchId: text(),
		runKey: text().notNull().unique(),
		purpose: text().notNull(),
		argv: text().array().notNull(),
		image: text().notNull(),
		status: sandboxRunStatus().notNull(),
		exitCode: integer(),
		durationMs: integer().notNull(),
		truncated: boolean().notNull().default(false),
		stdoutSha256: text(),
		stderrSha256: text(),
		result: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		/** The sealed dependency artifact mounted read-only into the run, if any. */
		dependencySnapshotId: text().references(() => dependencySnapshots.id, {
			onDelete: "set null",
		}),
		startedAt: ts().notNull(),
		finishedAt: ts().notNull(),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.investigationId)],
);

export const patchProposals = pgTable(
	"patch_proposals",
	{
		id: text().primaryKey(),
		investigationId: text()
			.notNull()
			.references(() => investigations.id, { onDelete: "cascade" }),
		hypothesisId: text()
			.notNull()
			.references(() => hypotheses.id, { onDelete: "cascade" }),
		attempt: integer().notNull(),
		status: patchStatus().notNull(),
		baseCommit: text().notNull(),
		edits: jsonb()
			.$type<Array<{ path: string; search: string; replace: string }>>()
			.notNull(),
		files: jsonb()
			.$type<
				Array<{
					path: string;
					change_type: "modified" | "added";
					additions: number;
					deletions: number;
				}>
			>()
			.notNull()
			.default([]),
		diffSha256: text(),
		diffBytes: integer().notNull().default(0),
		summary: text().notNull(),
		rationale: text().notNull(),
		expectedEffect: text().notNull(),
		risks: jsonb()
			.$type<Array<{ code: string; message: string }>>()
			.notNull()
			.default([]),
		applyError: jsonb().$type<ErrorInfo & { details?: string[] }>(),
		/** What the patch changes and reaches in the static graph (patch-impact.ts), or why it is missing. */
		impact: jsonb().$type<
			| ({ available: true } & PatchImpactResult)
			| { available: false; reason: string }
		>(),
		model: jsonb().$type<{ provider: string; model: string } | null>(),
		modelExecutionId: text(),
		approval: jsonb().$type<{
			decision: "approved" | "rejected" | "changes_requested";
			verification_id: string;
			outcome_at_decision: string;
			comment: string | null;
			acknowledged_risks: string[];
			decided_by: string;
			decided_at: string;
		}>(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex().on(t.investigationId, t.attempt)],
);

export const verificationRuns = pgTable("verification_runs", {
	id: text().primaryKey(),
	investigationId: text()
		.notNull()
		.references(() => investigations.id, { onDelete: "cascade" }),
	patchId: text()
		.notNull()
		.unique()
		.references(() => patchProposals.id, { onDelete: "cascade" }),
	status: text().$type<"completed" | "cancelled" | "error">().notNull(),
	outcome: verificationOutcome().notNull(),
	outcomeReasons: jsonb().$type<string[]>().notNull(),
	checks: jsonb().$type<CheckRecord[]>().notNull(),
	/** What the checks ran against: executor, image, network, and the exact dependency snapshot. */
	environment: jsonb().$type<VerificationEnvironment>(),
	startedAt: ts().notNull(),
	finishedAt: ts().notNull(),
	createdAt: createdAt(),
});

export type VerificationEnvironment = {
	executor: string;
	image: string | null;
	network: "none";
	dependencies: {
		snapshot_id: string;
		digest: string;
		manager: string;
		lockfile_sha256: string;
		registry: string;
	} | null;
	/** Why dependencies were not available, when the repository declares some. */
	dependencies_blocked: string | null;
};

export const resolutionReports = pgTable(
	"resolution_reports",
	{
		id: text().primaryKey(),
		investigationId: text()
			.notNull()
			.references(() => investigations.id, { onDelete: "cascade" }),
		version: integer().notNull(),
		content: jsonb().$type<Record<string, unknown>>().notNull(),
		markdownSha256: text().notNull(),
		generatedWith: jsonb().$type<Record<string, unknown>>().notNull(),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex().on(t.investigationId, t.version)],
);

/** Workers publish liveness and sandbox availability here; the API reads it (the API never calls Docker). */
export const workerHeartbeats = pgTable("worker_heartbeats", {
	workerId: text().primaryKey(),
	sandbox: jsonb()
		.$type<{
			available: boolean;
			kind: string;
			image: string | null;
			detail: string | null;
		}>()
		.notNull(),
	startedAt: ts().notNull(),
	updatedAt: ts().notNull(),
});

// ---- Repository Knowledge Graph ---------------------------------------------------------------

export const snapshotStatus = pgEnum("snapshot_status", [
	"queued",
	"indexing",
	"ready",
	"partial",
	"failed",
	"cancelled",
]);

export type IndexProgress = {
	phase:
		| "cloning"
		| "listing"
		| "parsing"
		| "reading"
		| "history"
		| "linking"
		| "saving";
	done: number;
	total: number;
	updated_at: string;
};

/** One indexed revision. Nodes and edges are immutable per snapshot; newer commits get new snapshots. */
export const repositorySnapshots = pgTable(
	"repository_snapshots",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		repositoryId: text()
			.notNull()
			.references(() => repositories.id, { onDelete: "cascade" }),
		ref: text().notNull(),
		commitSha: text().notNull(),
		status: snapshotStatus().notNull(),
		extractorVersion: text().notNull(),
		previousSnapshotId: text(),
		profile: jsonb().$type<Record<string, unknown>>(),
		coverage: jsonb().$type<Record<string, unknown>>(),
		stats: jsonb().$type<Record<string, unknown>>(),
		progress: jsonb().$type<IndexProgress>(),
		error: jsonb().$type<ErrorInfo>(),
		requestedBy: text(),
		cancelRequestedAt: ts(),
		startedAt: ts(),
		finishedAt: ts(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex().on(t.repositoryId, t.commitSha, t.extractorVersion),
		index().on(t.workspaceId, t.repositoryId, t.createdAt),
	],
);

export const graphNodes = pgTable(
	"graph_nodes",
	{
		id: text().primaryKey(),
		snapshotId: text()
			.notNull()
			.references(() => repositorySnapshots.id, { onDelete: "cascade" }),
		workspaceId: text().notNull(),
		key: text().notNull(),
		kind: text().notNull(),
		name: text().notNull(),
		path: text(),
		startLine: integer(),
		endLine: integer(),
		language: text(),
		attributes: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		provenance: jsonb().$type<Record<string, unknown>>().notNull().default({}),
	},
	(t) => [
		uniqueIndex().on(t.snapshotId, t.key),
		index().on(t.snapshotId, t.kind),
		index().on(t.snapshotId, t.path),
	],
);

/** Edges join nodes by key within a snapshot; `to_key` is null for explicitly unresolved targets. */
export const graphEdges = pgTable(
	"graph_edges",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		snapshotId: text()
			.notNull()
			.references(() => repositorySnapshots.id, { onDelete: "cascade" }),
		kind: text().notNull(),
		fromKey: text().notNull(),
		toKey: text(),
		targetText: text(),
		certainty: text()
			.$type<"exact" | "resolved" | "heuristic" | "unresolved">()
			.notNull(),
		provenance: jsonb().$type<Record<string, unknown>>().notNull().default({}),
	},
	(t) => [
		index().on(t.snapshotId, t.fromKey),
		index().on(t.snapshotId, t.toKey),
	],
);

/** Per-blob extraction results, so re-indexing a new commit parses only changed files. */
export const graphFileCache = pgTable(
	"graph_file_cache",
	{
		repositoryId: text()
			.notNull()
			.references(() => repositories.id, { onDelete: "cascade" }),
		extractorVersion: text().notNull(),
		path: text().notNull(),
		objectId: text().notNull(),
		extraction: jsonb().$type<Record<string, unknown>>().notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		primaryKey({
			columns: [t.repositoryId, t.extractorVersion, t.path, t.objectId],
		}),
	],
);

export const assessmentStatus = pgEnum("assessment_status", [
	"queued",
	"running",
	"completed",
	"failed",
]);

export const assessmentKind = pgEnum("assessment_kind", [
	"feasibility",
	"question",
]);

/**
 * A model-interpreted analysis of one snapshot: a feasibility and change-size assessment of a
 * requested change, or a cited answer to an engineering question (optionally following up another).
 */
export const assessments = pgTable(
	"assessments",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		repositoryId: text()
			.notNull()
			.references(() => repositories.id, { onDelete: "cascade" }),
		snapshotId: text().references(() => repositorySnapshots.id, {
			onDelete: "set null",
		}),
		kind: assessmentKind().notNull().default("feasibility"),
		parentId: text().references((): AnyPgColumn => assessments.id, {
			onDelete: "set null",
		}),
		commitSha: text().notNull(),
		request: text().notNull(),
		targets: text().array().notNull().default(emptyTextArray),
		status: assessmentStatus().notNull(),
		result: jsonb().$type<Record<string, unknown>>(),
		error: jsonb().$type<ErrorInfo>(),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		finishedAt: ts(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index().on(t.workspaceId, t.repositoryId, t.createdAt)],
);

export const patchAnalysisStatus = pgEnum("patch_analysis_status", [
	"queued",
	"running",
	"completed",
	"partial",
	"failed",
	"cancelled",
]);

/**
 * Impact of one patch on a repository: two revisions, or a supplied diff applied to a base revision.
 * Results are keyed by the exact commits (or diff hash), options, and analysis versions, so a stored
 * result never describes different code.
 */
export const patchAnalyses = pgTable(
	"patch_analyses",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		repositoryId: text()
			.notNull()
			.references(() => repositories.id, { onDelete: "cascade" }),
		baseRef: text().notNull(),
		baseSha: text().notNull(),
		headRef: text(),
		headSha: text(),
		/** sha256 of a supplied diff, stored in the blob store. */
		diffSha256: text(),
		mergeBase: boolean().notNull().default(false),
		options: jsonb().$type<{ depth: number; limit: number }>().notNull(),
		cacheKey: text().notNull(),
		status: patchAnalysisStatus().notNull(),
		progress: jsonb().$type<{ phase: string; updated_at: string }>(),
		result: jsonb().$type<PatchImpactResult>(),
		error: jsonb().$type<ErrorInfo>(),
		cancelRequestedAt: ts(),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		startedAt: ts(),
		finishedAt: ts(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex().on(t.repositoryId, t.cacheKey),
		index().on(t.workspaceId, t.repositoryId, t.createdAt),
	],
);

export const dependencySnapshotStatus = pgEnum("dependency_snapshot_status", [
	"queued",
	"preparing",
	"ready",
	"failed",
	"cancelled",
	"expired",
]);

/**
 * Dependencies prepared for one repository and one exact set of manifests and lockfile.
 * The artifact is a sealed executor-side volume identified by its digest; runs and verifications
 * reference the snapshot they used. Identical inputs at another revision reuse the same snapshot.
 */
export const dependencySnapshots = pgTable(
	"dependency_snapshots",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		repositoryId: text()
			.notNull()
			.references(() => repositories.id, { onDelete: "cascade" }),
		/** The revision it was first prepared for. */
		commitSha: text().notNull(),
		cacheKey: text().notNull(),
		manager: text().notNull(),
		lockfile: jsonb()
			.$type<{
				path: string;
				version: number;
				sha256: string;
				packages: number;
			}>()
			.notNull(),
		manifests: jsonb()
			.$type<Array<{ path: string; sha256: string }>>()
			.notNull(),
		registry: text().notNull(),
		image: text().notNull(),
		status: dependencySnapshotStatus().notNull(),
		attempts: integer().notNull().default(0),
		volume: text(),
		seal: jsonb().$type<{
			digest: string;
			files: number;
			dirs: number;
			links: number;
			bytes: number;
			mounts: string[];
		}>(),
		egress: jsonb().$type<{
			allowed: number;
			denied: number;
			targets: string[];
			denied_targets: string[];
		}>(),
		/** The install output (redacted, capped) in the blob store. */
		logSha256: text(),
		durationMs: integer(),
		error: jsonb().$type<ErrorInfo>(),
		cancelRequestedAt: ts(),
		/** Null when an investigation prepared it. */
		createdBy: text().references(() => users.id),
		startedAt: ts(),
		finishedAt: ts(),
		lastUsedAt: ts(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex().on(t.repositoryId, t.cacheKey),
		index().on(t.workspaceId, t.repositoryId, t.createdAt),
	],
);

export const idempotencyKeys = pgTable(
	"idempotency_keys",
	{
		workspaceId: text().notNull(),
		actorId: text().notNull(),
		key: text().notNull(),
		methodPath: text().notNull(),
		requestSha256: text().notNull(),
		responseStatus: integer().notNull(),
		responseBody: jsonb().notNull(),
		expiresAt: ts().notNull(),
		createdAt: createdAt(),
	},
	(t) => [primaryKey({ columns: [t.workspaceId, t.actorId, t.key] })],
);

// ---- Meetings ---------------------------------------------------------------------------------
// Tables only. Transcript bytes stay in the blob store.

type TranscriptInfoJson = import("@tracera/contracts").TranscriptInfo;
type MeetingExtractionJson = import("@tracera/contracts").MeetingExtractionInfo;
export type CandidateCitationRecord = {
	segment_id: string;
	index: number;
	/** The model's quote, checked against the segment; null when a person chose the segment. */
	quote: string | null;
};
export type CandidateSupportRecord = {
	status: "supported" | "partially_supported" | "unsupported";
	citations_valid: number;
	citations_dropped: number;
	reasons: string[];
};
export type DuplicateRecord = {
	type: "candidate" | "bug_report";
	id: string;
	title: string;
	similarity: number;
};
export type ReviewRecord = {
	decided_by: string;
	decided_at: string;
	reason: string | null;
};

export const meetingProvider = pgEnum("meeting_provider", [
	"teams",
	"google_meet",
	"other",
]);
export const meetingSource = pgEnum("meeting_source", [
	"upload_transcript",
	"provider_api",
]);
export const meetingStatus = pgEnum("meeting_status", [
	"transcribed",
	"processing",
	"extracted",
	"reviewed",
	"failed",
]);
export const meetingCandidateKind = pgEnum("meeting_candidate_kind", [
	"bug",
	"feature_request",
	"question",
	"other",
]);
export const meetingCandidateStatus = pgEnum("meeting_candidate_status", [
	"pending_review",
	"confirmed",
	"dismissed",
	"rejected",
]);
export const integrationProvider = pgEnum("integration_provider", ["google"]);
export const integrationStatus = pgEnum("integration_status", [
	"active",
	"expired",
	"revoked",
	"error",
]);

/** One user's OAuth connection to a meeting provider. Tokens are sealed with TRACERA_ENCRYPTION_KEY. */
export const integrationConnections = pgTable(
	"integration_connections",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		userId: text()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		provider: integrationProvider().notNull(),
		status: integrationStatus().notNull(),
		scopes: text().array().notNull(),
		accessTokenSealed: text().notNull(),
		refreshTokenSealed: text(),
		accessTokenExpiresAt: ts(),
		lastError: jsonb().$type<ErrorInfo>(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex().on(t.workspaceId, t.userId, t.provider)],
);

/** An uploaded or imported transcript; the original bytes are the blob `blob_sha256`. */
export const meetingSessions = pgTable(
	"meeting_sessions",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		provider: meetingProvider().notNull(),
		source: meetingSource().notNull(),
		status: meetingStatus().notNull(),
		title: text(),
		occurredAt: ts(),
		repositoryId: text().references(() => repositories.id, {
			onDelete: "set null",
		}),
		providerRef: text(),
		integrationConnectionId: text().references(
			() => integrationConnections.id,
			{ onDelete: "set null" },
		),
		blobSha256: text().notNull(),
		transcript: jsonb().$type<TranscriptInfoJson>().notNull(),
		speakerMap: jsonb().$type<Record<string, string>>().notNull().default({}),
		flags: text().array().notNull().default(emptyTextArray),
		extraction: jsonb().$type<MeetingExtractionJson>(),
		extractionStartedAt: ts(),
		failure: jsonb().$type<ErrorInfo>(),
		consentStatement: text().notNull(),
		consentAttestedAt: ts().notNull(),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index().on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
		// A provider transcript is imported once per workspace.
		uniqueIndex()
			.on(t.workspaceId, t.providerRef)
			.where(sql`${t.providerRef} is not null`),
	],
);

export const transcriptSegments = pgTable(
	"transcript_segments",
	{
		id: text().primaryKey(),
		meetingSessionId: text()
			.notNull()
			.references(() => meetingSessions.id, { onDelete: "cascade" }),
		workspaceId: text().notNull(),
		/** 1-based position, cited as SEG-n. */
		segmentIndex: integer().notNull(),
		speakerLabel: text(),
		startMs: integer(),
		endMs: integer(),
		text: text().notNull(),
	},
	(t) => [uniqueIndex().on(t.meetingSessionId, t.segmentIndex)],
);

/** A model-proposed topic from a meeting, validated by code and decided by a person. */
export const meetingCandidates = pgTable(
	"meeting_candidates",
	{
		id: text().primaryKey(),
		workspaceId: text()
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		meetingSessionId: text()
			.notNull()
			.references(() => meetingSessions.id, { onDelete: "cascade" }),
		ordinal: integer().notNull(),
		kind: meetingCandidateKind().notNull(),
		status: meetingCandidateStatus().notNull(),
		title: text().notNull(),
		description: text().notNull(),
		expectedBehavior: text(),
		actualBehavior: text(),
		steps: jsonb().$type<string[]>().notNull().default([]),
		severity: severity().notNull().default("unknown"),
		affectedArea: text(),
		citations: jsonb().$type<CandidateCitationRecord[]>().notNull(),
		support: jsonb().$type<CandidateSupportRecord>().notNull(),
		duplicateOf: jsonb().$type<DuplicateRecord>(),
		fieldSources: jsonb()
			.$type<Record<string, ValueSource>>()
			.notNull()
			.default({}),
		repositoryId: text().references(() => repositories.id, {
			onDelete: "set null",
		}),
		modelExecutionId: text(),
		bugReportId: text().references(() => bugReports.id, {
			onDelete: "set null",
		}),
		review: jsonb().$type<ReviewRecord>(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex().on(t.meetingSessionId, t.ordinal),
		index().on(t.workspaceId, t.kind, t.status),
	],
);
// ---- end of the meetings section ----------------------------------------------------------------
