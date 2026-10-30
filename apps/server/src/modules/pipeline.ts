import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	BrowserReproductionPlanOutputSchema,
	type BrowserStep,
	INVESTIGATION_STAGES,
	type InvestigationStage,
	type ReproductionStatus,
	type SpecialistRole,
} from "@tracera/contracts";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type pg from "pg";
import type { Config, ModelTask } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
	bugReports,
	type CheckRecord,
	dependencySnapshots,
	evidenceAssets,
	hypotheses,
	investigationEvidence,
	investigationSteps,
	type investigations,
	patchProposals,
	repositories,
	resolutionReports,
	sandboxRuns,
	type VerificationEnvironment,
	verificationRuns,
} from "../db/schema.ts";
import { InferenceError } from "../inference/gateway.ts";
import type { ChatProvider } from "../inference/providers.ts";
import {
	buildBrowserReproductionInput,
	buildHypothesesInput,
	buildPatchInput,
	buildReproductionPlanInput,
	generateHypothesesTask,
	generatePatchTask,
	type PromptEvidence,
	planBrowserReproductionTask,
	planReproductionTask,
} from "../inference/tasks.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { putBlob, readBlobUtf8 } from "../lib/fs.ts";
import { git } from "../lib/git.ts";
import { newId } from "../lib/ids.ts";
import { validateBrowserSteps } from "../sandbox/browser-steps.ts";
import {
	BROWSER_LIMITS,
	type BrowserRunResult,
	type DependencyMounts,
	parseRepositoryCommand,
	REPRO_ARGV,
	REPRO_TEST_PATH,
	type SandboxExecutor,
	type SandboxRunResult,
	SUITE_ENV,
} from "../sandbox/executor.ts";
import {
	detectInjection,
	type EvidenceIndex,
	hypothesisState,
	rankHypotheses,
	selectPatchTarget,
	validateHypotheses,
	validatePatchEdits,
	validateReproTest,
} from "./analysis.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import {
	buildContextPack,
	ContextError,
	type ContextPack,
	extractSearchTerms,
	type PackItem,
	reportEvidenceItems,
	TEST_FILE,
	verifySourcePath,
} from "./context.ts";
import {
	type EnsureResult,
	ensureDependencySnapshot,
	gitFileReader,
	planDependencies,
	snapshotMatches,
	verifySnapshot,
	workTreeReader,
} from "./dependencies.ts";
import {
	analyzeCommit,
	type CommitAnalysis,
	graphFactsFor,
	renderGraphFacts,
} from "./graph.ts";
import type { GraphNode } from "./graph-build.ts";
import { EXTRACTOR_VERSION } from "./graph-extract.ts";
import { SYMBOL_KINDS } from "./graph-queries.ts";
import { runNormalization, workspaceGateway } from "./normalization.ts";
import {
	computePatchImpact,
	type PatchImpactRecord,
} from "./patch-analysis.ts";
import { buildResolutionReport } from "./report.ts";
import {
	innermost,
	type MappedFrame,
	mapFrames,
	type ParsedTrace,
	parseStackTrace,
	type RevisionIndex,
} from "./stack-traces.ts";
import {
	classifyBrowserRun,
	classifyReproduction,
	combineReproductionRuns,
	deriveVerificationOutcome,
	linkedTestOutcomes,
	parseTap,
	type ReproductionRunResult,
	reproductionCheck,
	suiteCheck,
} from "./verification.ts";
import { screenshotEvidenceItems } from "./visual-evidence.ts";
import {
	applyEdits,
	applyStoredDiff,
	cloneAtCommit,
	readBlob,
	removeWorkspace,
	stageAndDiff,
	workspacePath,
} from "./workspace.ts";

// Stage implementations. Each returns a StageOutcome; the orchestrator
// in investigations.ts writes `persist`, the step result, and the next job in one transaction.

export type InvestigationRow = typeof investigations.$inferSelect;
export type StageTarget =
	| InvestigationStage
	| "awaiting_approval"
	| "completed";
export type StepError = { code: string; message: string; retryable: boolean };
export type StageOutcome = {
	status: "succeeded" | "skipped" | "failed" | "blocked";
	summary?: Record<string, unknown>;
	error?: StepError;
	/** A fatal failure ends the investigation as `failed`; non-fatal ones are recorded and the run continues. */
	fatal?: boolean;
	next?: StageTarget;
	persist?: (tx: Db) => Promise<void>;
	flags?: string[];
};
export type StageContext = {
	db: Db;
	pool: pg.Pool;
	config: Config;
	provider: ChatProvider;
	executor: SandboxExecutor;
	row: InvestigationRow;
	stage: InvestigationStage;
	attempt: number;
	signal: AbortSignal;
};

/** Legal stage transitions; anything else is a bug and throws. */
export const STAGE_TRANSITIONS: Record<
	InvestigationStage,
	readonly StageTarget[]
> = {
	normalize: ["collect_context"],
	collect_context: ["prepare_dependencies"],
	prepare_dependencies: ["plan_reproduction"],
	plan_reproduction: ["reproduce_baseline"],
	reproduce_baseline: ["generate_hypotheses"],
	generate_hypotheses: ["rank_hypotheses", "write_report"],
	rank_hypotheses: ["generate_patch", "write_report"],
	generate_patch: ["verify", "generate_patch", "write_report"],
	verify: ["generate_patch", "write_report"],
	write_report: ["awaiting_approval", "completed"],
};

export function defaultNext(stage: InvestigationStage): StageTarget {
	return (
		INVESTIGATION_STAGES[INVESTIGATION_STAGES.indexOf(stage) + 1] ?? "completed"
	);
}

/** Wall-clock budget per stage; all shorter than the queue's 1,200 s job expiry. */
export const STAGE_TIMEOUT_MS: Record<InvestigationStage, number> = {
	normalize: 180_000,
	collect_context: 180_000,
	// The install timeout (TRACERA_DEPS_TIMEOUT_MS ≤ 840 s) plus sealing; still below the 1,200 s expiry.
	prepare_dependencies: 1_080_000,
	plan_reproduction: 300_000,
	reproduce_baseline: 600_000,
	generate_hypotheses: 420_000,
	rank_hypotheses: 30_000,
	generate_patch: 420_000,
	verify: 900_000,
	write_report: 60_000,
};

/** Which specialist roles each investigation stage serves. */
export const STAGE_SPECIALISTS: Record<
	InvestigationStage,
	readonly SpecialistRole[]
> = {
	normalize: ["orchestrator"],
	collect_context: ["repository_mapping", "code_exploration"],
	prepare_dependencies: ["reproduction", "verification"],
	plan_reproduction: ["reproduction"],
	reproduce_baseline: ["reproduction"],
	generate_hypotheses: ["bug_investigation"],
	rank_hypotheses: ["bug_investigation"],
	generate_patch: ["patch_generation", "security_quality"],
	verify: ["verification", "impact_analysis"],
	write_report: ["orchestrator"],
};

/** Failures in these stages end the investigation; elsewhere they are recorded and the run continues. */
export const FATAL_STAGES: ReadonlySet<InvestigationStage> = new Set([
	"collect_context",
	"generate_hypotheses",
	"rank_hypotheses",
	"write_report",
]);

const MAX_PRIMARY_PATCH_ATTEMPTS = 2;
const MAX_CHANGED_LINES = 200;
const CONTEXT_BUDGET_MS = 150_000;
const GRAPH_BUDGET_MS = 45_000;
const SOURCE_FILE = /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/;

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}…` : text;
const failure = (
	code: string,
	message: string,
	retryable = false,
): StepError => ({ code, message, retryable });

// ---- Shared helpers -------------------------------------------------------------------------

const blobsRoot = (config: Config) => path.join(config.dataDir, "blobs");
const storeText = (config: Config, text: string) =>
	putBlob(blobsRoot(config), Buffer.from(text, "utf8"));

export function readBlobText(
	config: Pick<Config, "dataDir">,
	sha: string | null | undefined,
): Promise<string | null> {
	return readBlobUtf8(path.join(config.dataDir, "blobs"), sha);
}

export async function latestStep(
	db: Db,
	investigationId: string,
	stage: InvestigationStage,
) {
	const [step] = await db
		.select()
		.from(investigationSteps)
		.where(
			and(
				eq(investigationSteps.investigationId, investigationId),
				eq(investigationSteps.stage, stage),
			),
		)
		.orderBy(desc(investigationSteps.attempt))
		.limit(1);
	return step ?? null;
}

async function loadPack(ctx: StageContext): Promise<ContextPack> {
	const step = await latestStep(ctx.db, ctx.row.id, "collect_context");
	const text = await readBlobText(
		ctx.config,
		step?.status === "succeeded"
			? (step.summary.context_sha256 as string | undefined)
			: null,
	);
	if (!text)
		throw new ContextError(
			"context_missing",
			"The context pack for this investigation is missing",
		);
	return JSON.parse(text) as ContextPack;
}

export async function loadEvidence(db: Db, investigationId: string) {
	return db
		.select()
		.from(investigationEvidence)
		.where(eq(investigationEvidence.investigationId, investigationId))
		.orderBy(
			asc(investigationEvidence.createdAt),
			asc(investigationEvidence.handle),
		);
}
type EvidenceRow = Awaited<ReturnType<typeof loadEvidence>>[number];

export const indexOf = (rows: readonly EvidenceRow[]): EvidenceIndex =>
	new Map(
		rows.map((row) => [
			row.handle,
			{
				handle: row.handle,
				kind: row.kind,
				basis: row.basis,
				locator: row.locator,
			},
		]),
	);

const promptEvidence = (rows: readonly EvidenceRow[]): PromptEvidence[] =>
	rows.map((row) => ({
		handle: row.handle,
		kind: row.kind,
		label: row.label,
		content: row.content,
		locator: row.locator,
	}));

const nextNumber = (rows: readonly { handle: string }[], prefix: string) =>
	rows.reduce((highest, row) => {
		const match = new RegExp(`^${prefix}-(\\d+)$`).exec(row.handle);
		return match ? Math.max(highest, Number(match[1])) : highest;
	}, 0) + 1;

const evidenceValues = (
	investigationId: string,
	stage: InvestigationStage,
	items: readonly PackItem[],
) =>
	items.map((item) => ({
		id: newId("ive"),
		investigationId,
		handle: item.handle,
		kind: item.kind,
		basis: item.basis,
		label: item.label,
		content: item.content,
		locator: item.locator,
		provenance: item.provenance,
		stage,
	}));

function taskGateway(ctx: StageContext, task: ModelTask, model?: string) {
	return workspaceGateway(
		ctx,
		{
			workspaceId: ctx.row.workspaceId,
			bugReportId: ctx.row.bugReportId,
			investigationId: ctx.row.id,
		},
		{ model: model ?? ctx.config.inference.taskModels[task] },
	);
}

/** Model failures become typed step errors; anything else is a bug and propagates. */
async function modelCall<T>(
	run: () => Promise<{ output: T; modelExecutionId: string }>,
): Promise<
	| { ok: true; output: T; modelExecutionId: string }
	| { ok: false; error: StepError }
> {
	try {
		const result = await run();
		return {
			ok: true,
			output: result.output,
			modelExecutionId: result.modelExecutionId,
		};
	} catch (error) {
		if (!(error instanceof InferenceError)) throw error;
		return {
			ok: false,
			error: failure(error.code, error.message, error.retryable),
		};
	}
}

async function repositoryOf(ctx: StageContext) {
	const [repo] = await ctx.db
		.select()
		.from(repositories)
		.where(
			and(
				eq(repositories.id, ctx.row.repositoryId),
				eq(repositories.workspaceId, ctx.row.workspaceId),
			),
		)
		.limit(1);
	return repo ?? null;
}

/** The base clone, recreated from the registered repository (with every check) if it is gone. */
async function ensureBase(ctx: StageContext): Promise<string> {
	const base = workspacePath(ctx.config, ctx.row.id, "base");
	if (
		await stat(path.join(base, ".git")).then(
			() => true,
			() => false,
		)
	)
		return base;
	const repo = await repositoryOf(ctx);
	if (!repo)
		throw new ContextError(
			"repository_access_denied",
			"The repository is not available to this investigation",
		);
	const source = await verifySourcePath(ctx.config, repo);
	const clone = await cloneAtCommit(
		ctx.config,
		source,
		base,
		ctx.row.commitSha,
	);
	if (!clone.ok) throw new ContextError(clone.code, clone.message);
	return base;
}

/** Stops a stage between steps once it is cancelled or out of time: no new copies or runs start. */
function throwIfStopped(ctx: StageContext): void {
	if (!ctx.signal.aborted) return;
	throw ctx.signal.reason === "stage_timeout"
		? new ContextError("stage_timeout", "The stage ran out of time", true)
		: new ContextError("cancelled", "The investigation was cancelled");
}

/** A fresh per-run copy of the base clone at the investigation commit. */
async function runCopy(ctx: StageContext, name: string): Promise<string> {
	throwIfStopped(ctx);
	const base = await ensureBase(ctx);
	const dir = workspacePath(ctx.config, ctx.row.id, name);
	const clone = await cloneAtCommit(ctx.config, base, dir, ctx.row.commitSha);
	if (!clone.ok) throw new ContextError(clone.code, clone.message);
	return dir;
}

async function writeReproTest(dir: string, source: string) {
	const target = path.join(dir, ...REPRO_TEST_PATH.split("/"));
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, source);
}

type ExecutedRun = {
	id: string;
	result: SandboxRunResult;
	classification: ReproductionRunResult | null;
};

/** Runs one command in the sandbox, records it (row, output blobs, audit), and removes the copy. */
async function execute(
	ctx: StageContext,
	run: {
		purpose: string;
		index: number;
		dir: string;
		argv: readonly string[];
		env: Readonly<Record<string, string>>;
		patchId?: string | null;
		dependencies?: PreparedDependencies | null;
	},
): Promise<ExecutedRun> {
	const runKey = `${ctx.row.id}-${ctx.stage}-${ctx.attempt}-${run.purpose}-${run.index}`;
	throwIfStopped(ctx);
	const dependencies = run.dependencies ?? null;
	// The copy is mounted read-only, so the artifact's mount points are created in it first.
	if (dependencies)
		for (const mount of dependencies.mounts)
			await mkdir(path.join(run.dir, ...mount.split("/")), { recursive: true });
	const startedAt = new Date();
	const result = await ctx.executor.run(
		{
			runId: runKey,
			investigationId: ctx.row.id,
			workspace: run.dir,
			argv: run.argv,
			env: run.env,
			timeoutMs: ctx.config.sandboxTimeoutMs,
			...(dependencies
				? {
						dependencies: {
							volume: dependencies.volume,
							mounts: dependencies.mounts,
						},
					}
				: {}),
		},
		ctx.signal,
	);
	await rm(run.dir, { recursive: true, force: true });
	await rm(`${run.dir}.patch`, { force: true });
	const [stdout, stderr] = await Promise.all([
		result.stdout ? storeText(ctx.config, result.stdout) : null,
		result.stderr ? storeText(ctx.config, result.stderr) : null,
	]);
	const tap = parseTap(result.stdout);
	const classification = run.purpose.startsWith("repro")
		? classifyReproduction(result)
		: null;
	const values = {
		investigationId: ctx.row.id,
		patchId: run.patchId ?? null,
		runKey,
		purpose: run.purpose,
		argv: [...run.argv],
		image: result.executor.image,
		status: result.status,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		truncated: result.truncated,
		stdoutSha256: stdout?.sha256 ?? null,
		stderrSha256: stderr?.sha256 ?? null,
		result: {
			tap: {
				parsed: tap.parsed,
				tests: tap.tests,
				passed: tap.pass,
				failed: tap.fail,
			},
			...(classification
				? {
						reproduction: {
							status: classification.status,
							reason: classification.reason,
							observation: classification.observation,
						},
					}
				: {}),
		},
		dependencySnapshotId: dependencies?.snapshotId ?? null,
		startedAt,
		finishedAt: new Date(),
	};
	const [stored] = await ctx.db
		.insert(sandboxRuns)
		.values({ id: newId("sbx"), ...values })
		.onConflictDoUpdate({ target: sandboxRuns.runKey, set: values })
		.returning({ id: sandboxRuns.id });
	const id = stored?.id ?? runKey;
	await audit(ctx.db, {
		workspaceId: ctx.row.workspaceId,
		actor: WORKER_ACTOR,
		action: "sandbox.run",
		targetType: "sandbox_run",
		targetId: id,
		metadata: {
			investigation_id: ctx.row.id,
			run_key: runKey,
			purpose: run.purpose,
			argv: values.argv,
			image: values.image,
			status: result.status,
			exit_code: result.exitCode,
			duration_ms: result.durationMs,
			truncated: result.truncated,
			dependency_snapshot_id: dependencies?.snapshotId ?? null,
			dependency_digest: dependencies?.digest ?? null,
		},
	});
	return { id, result, classification };
}

async function storedRun(
	ctx: StageContext,
	id: string | undefined,
): Promise<SandboxRunResult | null> {
	if (!id) return null;
	const [row] = await ctx.db
		.select()
		.from(sandboxRuns)
		.where(
			and(eq(sandboxRuns.id, id), eq(sandboxRuns.investigationId, ctx.row.id)),
		)
		.limit(1);
	if (!row) return null;
	return {
		status: row.status,
		exitCode: row.exitCode,
		stdout: (await readBlobText(ctx.config, row.stdoutSha256)) ?? "",
		stderr: "",
		truncated: row.truncated,
		durationMs: row.durationMs,
		executor: { kind: "stored", image: row.image },
	};
}

// ---- Browser reproduction -----------------------------------------------------------------------

type BrowserTarget = {
	start: string[];
	app: { port: number; readyPath: string; basePath: string };
	/** The page the report names, as a path on the app, when it can be told. */
	reportedPath: string | null;
};
type BrowserPlan = { steps: BrowserStep[]; target: BrowserTarget };

/** A URL or path reduced to a path on the app (scheme and host dropped); null when not a path. */
function pagePath(value: string): string | null {
	try {
		const url = new URL(value, "http://app.invalid");
		return `${url.pathname}${url.search}`.slice(0, 200);
	} catch {
		return null;
	}
}

/**
 * Browser plans are chosen by code, never by the model: only for an app the repository owner declared
 * (`app` plus `commands.start` as `npm run <script>`) and a report that names a page.
 */
async function browserTarget(ctx: StageContext): Promise<BrowserTarget | null> {
	const repo = await repositoryOf(ctx);
	if (!repo?.app || !repo.commands.start) return null;
	const start = parseRepositoryCommand(repo.commands.start);
	if (!start.ok || start.argv[1] !== "run") return null;
	const [report] = await ctx.db
		.select({
			affectedUrl: bugReports.affectedUrl,
			normalized: bugReports.normalizationResult,
		})
		.from(bugReports)
		.where(eq(bugReports.id, ctx.row.bugReportId))
		.limit(1);
	const page = report?.normalized?.affected_page;
	const named =
		report?.affectedUrl ?? (typeof page === "string" && page ? page : null);
	if (!named) return null;
	return {
		start: start.argv,
		app: {
			port: repo.app.port,
			readyPath: repo.app.ready_path,
			basePath: repo.app.base_url_path ?? "/",
		},
		reportedPath:
			report?.affectedUrl || named.startsWith("/") ? pagePath(named) : null,
	};
}

/** The stored browser plan of a run, re-validated before use; null for a node plan or a bad record. */
async function browserPlanOf(
	ctx: StageContext,
	plan: Awaited<ReturnType<typeof latestStep>>,
): Promise<BrowserPlan | null> {
	if (plan?.status !== "succeeded" || plan.summary.mode !== "browser")
		return null;
	const text = await readBlobText(
		ctx.config,
		plan.summary.steps_sha256 as string | undefined,
	);
	if (!text) return null;
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const steps =
		BrowserReproductionPlanOutputSchema.shape.steps.safeParse(parsed);
	if (!steps.success || !validateBrowserSteps(steps.data).ok) return null;
	const target = await browserTarget(ctx);
	return target ? { steps: steps.data, target } : null;
}

type ExecutedBrowserRun = {
	id: string;
	result: BrowserRunResult;
	classification: ReproductionRunResult;
	screenshotSha256: string | null;
};

/** One browser run (app + browser containers), recorded like any sandbox run; the copy is removed. */
async function executeBrowser(
	ctx: StageContext,
	run: {
		purpose: string;
		index: number;
		dir: string;
		plan: BrowserPlan;
		patchId?: string | null;
		dependencies?: PreparedDependencies | null;
	},
): Promise<ExecutedBrowserRun> {
	const runKey = `${ctx.row.id}-${ctx.stage}-${ctx.attempt}-${run.purpose}-${run.index}`;
	throwIfStopped(ctx);
	const dependencies = run.dependencies ?? null;
	if (dependencies)
		for (const mount of dependencies.mounts)
			await mkdir(path.join(run.dir, ...mount.split("/")), { recursive: true });
	const startedAt = new Date();
	const result = await ctx.executor.runBrowser(
		{
			runId: runKey,
			investigationId: ctx.row.id,
			workspace: run.dir,
			start: run.plan.target.start,
			app: run.plan.target.app,
			steps: run.plan.steps,
			timeoutMs: Math.min(
				Math.max(ctx.config.sandboxTimeoutMs, BROWSER_LIMITS.minTimeoutMs),
				BROWSER_LIMITS.maxTimeoutMs,
			),
			...(dependencies
				? {
						dependencies: {
							volume: dependencies.volume,
							mounts: dependencies.mounts,
						},
					}
				: {}),
		},
		ctx.signal,
	);
	await rm(run.dir, { recursive: true, force: true });
	await rm(`${run.dir}.patch`, { force: true });
	const report = result.report;
	const [reportBlob, logBlob, shotBlob] = await Promise.all([
		report
			? storeText(ctx.config, JSON.stringify({ ...report, screenshot: null }))
			: null,
		result.appLog || result.stderr
			? storeText(ctx.config, `${result.appLog}${result.stderr}`)
			: null,
		report?.screenshot
			? putBlob(blobsRoot(ctx.config), Buffer.from(report.screenshot, "base64"))
			: null,
	]);
	const classification = classifyBrowserRun(result);
	const failed = report?.steps.find((step) => step.status === "failed");
	const values = {
		investigationId: ctx.row.id,
		patchId: run.patchId ?? null,
		runKey,
		purpose: run.purpose,
		argv: [...run.plan.target.start],
		image: result.executor.image,
		status: result.status,
		exitCode: null,
		durationMs: result.durationMs,
		truncated: result.truncated,
		stdoutSha256: reportBlob?.sha256 ?? null,
		stderrSha256: logBlob?.sha256 ?? null,
		result: {
			browser: {
				browser_image: result.executor.browserImage,
				detail: result.detail ?? null,
				ready: report?.ready ?? null,
				steps: report?.steps.length ?? 0,
				failed_step: failed ? failed.index + 1 : null,
				console_errors: report?.console_errors.length ?? 0,
				page_errors: report?.page_errors.length ?? 0,
				blocked_requests: report?.blocked_requests ?? [],
				failed_requests: report?.failed_requests.length ?? 0,
				final_path: report?.final_path ?? null,
				screenshot_sha256: shotBlob?.sha256 ?? null,
			},
			reproduction: {
				status: classification.status,
				reason: classification.reason,
				observation: classification.observation,
			},
		},
		dependencySnapshotId: dependencies?.snapshotId ?? null,
		startedAt,
		finishedAt: new Date(),
	};
	const [stored] = await ctx.db
		.insert(sandboxRuns)
		.values({ id: newId("sbx"), ...values })
		.onConflictDoUpdate({ target: sandboxRuns.runKey, set: values })
		.returning({ id: sandboxRuns.id });
	const id = stored?.id ?? runKey;
	await audit(ctx.db, {
		workspaceId: ctx.row.workspaceId,
		actor: WORKER_ACTOR,
		action: "sandbox.run",
		targetType: "sandbox_run",
		targetId: id,
		metadata: {
			investigation_id: ctx.row.id,
			run_key: runKey,
			purpose: run.purpose,
			kind: "browser",
			argv: values.argv,
			image: values.image,
			browser_image: result.executor.browserImage,
			status: result.status,
			steps: values.result.browser.steps,
			duration_ms: result.durationMs,
			dependency_snapshot_id: dependencies?.snapshotId ?? null,
		},
	});
	return {
		id,
		result,
		classification,
		screenshotSha256: shotBlob?.sha256 ?? null,
	};
}

/** A sealed dependency snapshot that runs mount read-only, with what verification records about it. */
type PreparedDependencies = DependencyMounts & {
	snapshotId: string;
	repositoryId: string;
	cacheKey: string;
	digest: string;
	manager: string;
	lockfileSha256: string;
	registry: string;
};

type SandboxEnvironment =
	| { blocker: { reason: string; detail: string }; image: string | null }
	| {
			blocker: null;
			dependencies: PreparedDependencies | null;
			image: string | null;
	  };

/**
 * Whether sandbox stages can run, and with which dependencies. Decided at run time, never frozen at
 * creation: the prepared snapshot must exist, still describe this revision's manifests and lockfile,
 * and still match its seal. Anything else blocks with a precise reason; nothing is installed here.
 */
async function sandboxEnvironment(
	ctx: StageContext,
): Promise<SandboxEnvironment> {
	if (ctx.row.mode === "analysis_only")
		return {
			blocker: {
				reason: "analysis_only_requested",
				detail: "the investigation was started in analysis-only mode",
			},
			image: null,
		};
	const status = await ctx.executor.status();
	if (!status.available)
		return {
			blocker: {
				reason: "sandbox_unavailable",
				detail: `the sandbox is unavailable (${status.detail ?? status.kind})`,
			},
			image: status.image,
		};
	const blocked = (reason: string, detail: string): SandboxEnvironment => ({
		blocker: { reason, detail },
		image: status.image,
	});
	const step = await latestStep(ctx.db, ctx.row.id, "prepare_dependencies");
	if (!step) {
		// An investigation that predates the preparation stage: allowed only without dependencies.
		const plan = await planDependencies(
			gitFileReader(await ensureBase(ctx), ctx.row.commitSha),
			new URL(ctx.config.dependencies.registry),
		);
		return plan.required
			? blocked(
					"dependencies_not_prepared",
					"the repository declares dependencies and they were not prepared",
				)
			: { blocker: null, dependencies: null, image: status.image };
	}
	if (step.status === "skipped")
		return { blocker: null, dependencies: null, image: status.image };
	const snapshotId = step.summary.snapshot_id;
	if (step.status !== "succeeded" || typeof snapshotId !== "string") {
		const reason =
			typeof step.summary.reason === "string"
				? step.summary.reason
				: (step.error?.code ?? "unknown");
		const detail =
			typeof step.summary.detail === "string" ? `: ${step.summary.detail}` : "";
		return blocked(
			"dependencies_not_prepared",
			`the repository's dependencies were not prepared (${reason}${detail})`,
		);
	}
	const [row] = await ctx.db
		.select()
		.from(dependencySnapshots)
		.where(
			and(
				eq(dependencySnapshots.id, snapshotId),
				eq(dependencySnapshots.workspaceId, ctx.row.workspaceId),
			),
		)
		.limit(1);
	if (row?.status !== "ready" || !row.volume || !row.seal)
		return blocked(
			"dependencies_not_prepared",
			"the prepared dependency snapshot is no longer available",
		);
	if (
		!(await snapshotMatches(
			row,
			gitFileReader(await ensureBase(ctx), ctx.row.commitSha),
			ctx.config,
		))
	)
		return blocked(
			"dependency_snapshot_mismatch",
			"the prepared dependencies were made from different manifests or a different lockfile",
		);
	const checked = await verifySnapshot(ctx, row, ctx.signal);
	if (!checked.ok) return blocked(checked.code, checked.detail);
	return {
		blocker: null,
		image: status.image,
		dependencies: {
			volume: row.volume,
			mounts: row.seal.mounts,
			snapshotId: row.id,
			repositoryId: row.repositoryId,
			cacheKey: row.cacheKey,
			digest: row.seal.digest,
			manager: row.manager,
			lockfileSha256: row.lockfile.sha256,
			registry: row.registry,
		},
	};
}

/** What a verification ran against, stored with it and shown in the report. */
const environmentRecord = (
	ctx: StageContext,
	environment: SandboxEnvironment,
): VerificationEnvironment => ({
	executor: ctx.executor.kind,
	image: environment.image,
	network: "none",
	dependencies:
		environment.blocker === null && environment.dependencies
			? {
					snapshot_id: environment.dependencies.snapshotId,
					digest: environment.dependencies.digest,
					manager: environment.dependencies.manager,
					lockfile_sha256: environment.dependencies.lockfileSha256,
					registry: environment.dependencies.registry,
				}
			: null,
	dependencies_blocked:
		environment.blocker &&
		environment.blocker.reason !== "analysis_only_requested" &&
		environment.blocker.reason !== "sandbox_unavailable"
			? environment.blocker.reason
			: null,
});

const factItem = (
	handle: string,
	label: string,
	content: string,
	basis: "observed" | "inferred" = "observed",
	locator: Record<string, unknown> = {},
): PackItem => ({
	handle,
	kind: basis === "observed" ? "repository_fact" : "model_observation",
	basis,
	label,
	content,
	locator,
	provenance: {},
});

// ---- Stages ---------------------------------------------------------------------------------

async function normalizeStage(ctx: StageContext): Promise<StageOutcome> {
	const [bug] = await ctx.db
		.select({ status: bugReports.normalizationStatus })
		.from(bugReports)
		.where(eq(bugReports.id, ctx.row.bugReportId))
		.limit(1);
	if (bug?.status === "done")
		return { status: "skipped", summary: { reason: "already_normalized" } };
	const outcome = await runNormalization(ctx, ctx.row.bugReportId, {
		investigationId: ctx.row.id,
	});
	// Non-fatal by design: the investigation continues with the user-provided fields.
	return outcome.ok
		? {
				status: "succeeded",
				summary: {
					model_execution_id: outcome.modelExecutionId,
					filled: outcome.filled,
				},
			}
		: { status: "failed", error: outcome.error };
}

/** Stack traces found in the report (EV-1) and its trace and log attachments. */
type ReportedTrace = { handle: string; trace: ParsedTrace };
const FRAME_LEADS = 3;
const SYMBOL_KIND_SET = new Set<string>(SYMBOL_KINDS);

/** Resolves reported frames against this commit's in-memory graph (files, symbols, blobs). */
async function mapReportedFrames(
	analysis: Pick<CommitAnalysis, "nodes">,
	dir: string,
	commitSha: string,
	traces: readonly ReportedTrace[],
): Promise<Array<{ source: string; frame: MappedFrame }>> {
	const files: string[] = [];
	const parsed = new Set<string>();
	const symbols = new Map<string, GraphNode[]>();
	for (const node of analysis.nodes) {
		if (!node.path) continue;
		if (node.kind === "file" || node.kind === "test_file") {
			files.push(node.path);
			if (node.attributes.parsed === true) parsed.add(node.path);
		} else if (SYMBOL_KIND_SET.has(node.kind)) {
			const list = symbols.get(node.path) ?? [];
			list.push(node);
			symbols.set(node.path, list);
		}
	}
	const index: RevisionIndex = {
		files,
		parsed: (file) => parsed.has(file),
		readText: (file) => readBlob(dir, commitSha, file),
		symbolAt: async (file, line) => {
			const node = innermost(symbols.get(file) ?? [], line, (n) => [
				n.start_line,
				n.end_line,
			]);
			return node
				? {
						key: node.key,
						node_id: null,
						name: node.name,
						kind: node.kind,
						start_line: node.start_line ?? line,
						end_line: node.end_line ?? line,
					}
				: null;
		},
	};
	const mapped: Array<{ source: string; frame: MappedFrame }> = [];
	for (const { handle, trace } of traces)
		for (const frame of await mapFrames(trace, index))
			mapped.push({ source: handle, frame });
	return mapped;
}

/**
 * A CODE excerpt (the enclosing symbol, or lines around the frame) and a FIND fact for each of the
 * first few distinct frames that resolve to non-test repository code. Returns their files.
 */
async function addFrameEvidence(
	pack: ContextPack,
	frames: ReadonlyArray<{ source: string; frame: MappedFrame }>,
	dir: string,
	commitSha: string,
): Promise<string[]> {
	const leads: Array<{
		source: string;
		frame: MappedFrame;
		file: string;
		line: number;
	}> = [];
	const seen = new Set<string>();
	for (const { source, frame } of frames) {
		const at = frame.resolution;
		if (at.status !== "resolved" || at.line === null || TEST_FILE.test(at.file))
			continue;
		if (seen.has(`${at.file}:${at.line}`)) continue;
		seen.add(`${at.file}:${at.line}`);
		leads.push({ source, frame, file: at.file, line: at.line });
		if (leads.length === FRAME_LEADS) break;
	}
	let code = nextNumber(pack.items, "CODE");
	let find = nextNumber(pack.items, "FIND");
	for (const { source, frame, file, line } of leads) {
		const covering = pack.items.find(
			(item) =>
				item.kind === "code_excerpt" &&
				item.locator.path === file &&
				Number(item.locator.start_line) <= line &&
				Number(item.locator.end_line) >= line,
		);
		let excerpt = covering?.handle ?? null;
		const text =
			excerpt === null && frame.excerpt !== null
				? await readBlob(dir, commitSha, file)
				: null;
		if (text !== null) {
			const lines = text.split("\n");
			if (lines.at(-1) === "") lines.pop();
			const symbol = frame.symbol;
			const [start, end] =
				symbol && symbol.end_line - symbol.start_line <= 40
					? [symbol.start_line, Math.min(lines.length, symbol.end_line)]
					: [Math.max(1, line - 8), Math.min(lines.length, line + 8)];
			excerpt = `CODE-${code++}`;
			pack.items.push({
				handle: excerpt,
				kind: "code_excerpt",
				basis: "observed",
				label: `${file} lines ${start}-${end}`,
				content: lines
					.slice(start - 1, end)
					.map(
						(row, i) =>
							`${String(start + i).padStart(4)}| ${row.length > 300 ? `${row.slice(0, 300)}…` : row}`,
					)
					.join("\n"),
				locator: {
					path: file,
					start_line: start,
					end_line: end,
					line_count: lines.length,
				},
				provenance: { method: "stack_frame", source, frame: frame.index + 1 },
			});
		}
		const how =
			frame.resolution.status === "resolved" &&
			frame.resolution.method === "source_map"
				? "through a source map committed with the bundle"
				: frame.resolution.status === "resolved" &&
						frame.resolution.method === "exact_path"
					? "by its exact path"
					: "by its path suffix";
		const symbol = frame.symbol;
		pack.items.push({
			handle: `FIND-${find++}`,
			kind: "repository_fact",
			basis: "observed",
			label: `Stack frame: ${file}:${line}`,
			// Frame text is untrusted: only the frame number and repository data are quoted.
			content: [
				`Frame ${frame.index + 1} of the stack trace in ${source} resolves ${how} to ${file} line ${line} at commit ${commitSha.slice(0, 12)}.`,
				symbol
					? `The innermost symbol there is ${symbol.name} (${symbol.kind}, lines ${symbol.start_line}-${symbol.end_line})${
							symbol.name_matches === true
								? ", matching the frame's function name"
								: symbol.name_matches === false
									? "; it does not match the frame's function name, so the code may have changed since the trace was recorded"
									: ""
						}.`
					: "No parsed symbol encloses that line.",
				frame.excerpt === null
					? "That line does not exist at this commit; the trace may come from different code."
					: null,
				excerpt ? `The source lines are in ${excerpt}.` : null,
				"This locates where the error surfaced, not why it happened: it is a lead for hypotheses, not the root cause.",
			]
				.filter((sentence) => sentence !== null)
				.join(" "),
			locator: {},
			provenance: {
				method: "stack_frame_mapping",
				source,
				frame: frame.index + 1,
				path: file,
				line,
				symbol: symbol?.key ?? null,
			},
		});
	}
	return leads.map((lead) => lead.file);
}

/**
 * Static-graph facts (FIND items) for the files that reported stack frames resolve to and the
 * selected source files, and the tests linked to them, which verification reports separately. The
 * leading frames also get excerpts and facts of their own. Supplementary: failures become
 * limitations, except cancellation.
 */
async function addGraphFacts(
	ctx: StageContext,
	repo: { id: string; name: string },
	dir: string,
	pack: ContextPack,
	started: number,
	traces: readonly ReportedTrace[],
): Promise<{ mapped: number; resolved: number; leads: string[] } | null> {
	const selected = pack.selected
		.map((file) => file.path)
		.filter((file) => !TEST_FILE.test(file));
	if (selected.length === 0 && traces.length === 0) return null;
	const deadline = Math.min(Date.now() + GRAPH_BUDGET_MS, started + 170_000);
	if (deadline - Date.now() < 2000) {
		pack.limitations.push(
			"Static graph facts were skipped: time budget exhausted",
		);
		return null;
	}
	try {
		const analysis = await analyzeCommit(ctx, {
			repositoryId: repo.id,
			repositoryName: repo.name,
			dir,
			commitSha: ctx.row.commitSha,
			deadline,
			signal: ctx.signal,
		});
		const frames =
			traces.length > 0
				? await mapReportedFrames(analysis, dir, ctx.row.commitSha, traces)
				: [];
		const leads = await addFrameEvidence(pack, frames, dir, ctx.row.commitSha);
		const files = [...new Set([...leads, ...selected])].slice(0, 4);
		const facts = graphFactsFor(analysis, files);
		let next = nextNumber(pack.items, "FIND") - 1;
		for (const fact of facts) {
			next += 1;
			pack.items.push({
				handle: `FIND-${next}`,
				kind: "repository_fact",
				basis: "observed",
				label: `Static graph: ${fact.path}`,
				content: renderGraphFacts(
					fact,
					ctx.row.commitSha,
					analysis.coverage.complete,
				),
				locator: {},
				provenance: {
					method: "static_graph",
					path: fact.path,
					extractor_version: EXTRACTOR_VERSION,
					certainty: "resolved",
				},
			});
		}
		pack.graph = {
			extractor_version: EXTRACTOR_VERSION,
			coverage_complete: analysis.coverage.complete,
			files: facts.map((fact) => ({
				path: fact.path,
				tests: fact.tests.map(({ name, file }) => ({ name, file })),
			})),
		};
		return {
			mapped: frames.length,
			resolved: frames.filter(
				({ frame }) => frame.resolution.status === "resolved",
			).length,
			leads,
		};
	} catch (error) {
		if (error instanceof ContextError && error.code === "cancelled")
			throw error;
		pack.limitations.push(
			`Static graph facts are unavailable: ${error instanceof ContextError ? error.message : "graph extraction failed"}`,
		);
		return null;
	}
}

async function collectContextStage(ctx: StageContext): Promise<StageOutcome> {
	const fatal = (error: StepError): StageOutcome => ({
		status: "failed",
		fatal: true,
		error,
	});
	const repo = await repositoryOf(ctx);
	const [bug] = await ctx.db
		.select()
		.from(bugReports)
		.where(
			and(
				eq(bugReports.id, ctx.row.bugReportId),
				eq(bugReports.workspaceId, ctx.row.workspaceId),
			),
		)
		.limit(1);
	if (!repo || !bug)
		return fatal(
			failure(
				"repository_access_denied",
				"The repository or bug report does not belong to this investigation's workspace",
			),
		);
	const assets = await ctx.db
		.select()
		.from(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.bugReportId, bug.id),
				inArray(evidenceAssets.kind, ["stack_trace", "log_file", "text_note"]),
			),
		)
		.orderBy(asc(evidenceAssets.createdAt), asc(evidenceAssets.id));
	const assetTexts = await Promise.all(
		assets.map(async (asset) => ({
			id: asset.id,
			kind: asset.kind,
			text:
				(await readBlobText(ctx.config, asset.blobSha256)) ??
				"[evidence content unavailable]",
		})),
	);
	// Handles as reportEvidenceItems assigns them: EV-1 is the report, EV-2… its attachments in order.
	const traces = [
		{
			handle: "EV-1",
			text: `${bug.description}\n${bug.actualBehavior ?? ""}`,
		},
		...assetTexts.flatMap((asset, i) =>
			asset.kind === "text_note"
				? []
				: [{ handle: `EV-${i + 2}`, text: asset.text }],
		),
	]
		.map(({ handle, text }) => ({ handle, trace: parseStackTrace(text) }))
		.filter(({ trace }) => trace.frames.length > 0);
	let pack: ContextPack;
	let frames: Awaited<ReturnType<typeof addGraphFacts>> = null;
	const started = Date.now();
	try {
		const source = await verifySourcePath(ctx.config, repo);
		const base = workspacePath(ctx.config, ctx.row.id, "base");
		const clone = await cloneAtCommit(
			ctx.config,
			source,
			base,
			ctx.row.commitSha,
		);
		if (!clone.ok)
			return fatal(
				failure(clone.code, clone.message, clone.code === "context_timeout"),
			);
		pack = await buildContextPack({
			dir: base,
			commitSha: ctx.row.commitSha,
			terms: extractSearchTerms(
				bug,
				bug.normalizationResult as { search_terms?: unknown } | null,
			),
			testCommand: repo.commands.test,
			deadline: Date.now() + CONTEXT_BUDGET_MS,
			signal: ctx.signal,
		});
		frames = await addGraphFacts(ctx, repo, base, pack, started, traces);
	} catch (error) {
		if (error instanceof ContextError)
			return fatal(failure(error.code, error.message, error.retryable));
		throw error;
	}
	const visual = await screenshotEvidenceItems(ctx, {
		workspaceId: ctx.row.workspaceId,
		bugReportId: bug.id,
		investigationId: ctx.row.id,
		signal: ctx.signal,
	});
	pack.limitations.push(...visual.limitations);
	const items = [
		...reportEvidenceItems(bug, assetTexts),
		...visual.items,
		...pack.items,
	];
	const stored = await storeText(ctx.config, JSON.stringify(pack));
	const count = (prefix: string) =>
		items.filter((item) => item.handle.startsWith(`${prefix}-`)).length;
	return {
		status: "succeeded",
		summary: {
			context_sha256: stored.sha256,
			complete: pack.complete,
			files_selected: pack.selected,
			counts: {
				reported: count("EV"),
				code_excerpts: count("CODE"),
				commits: count("COMMIT"),
				facts: count("FIND"),
			},
			search: {
				methods: pack.search.methods,
				terms: pack.search.terms.map(({ term, source, hits, timed_out }) => ({
					term,
					source,
					hits,
					timed_out,
				})),
				total_hits: pack.search.total_hits,
				truncated: pack.search.truncated,
			},
			skipped: Object.fromEntries(
				Object.entries(pack.tree.skipped).map(([key, value]) => [
					key,
					value.count,
				]),
			),
			history_length: pack.commit.history_length,
			stack_frames:
				traces.length > 0
					? {
							traces: traces.length,
							frames: traces.reduce(
								(sum, { trace }) => sum + trace.frames.length,
								0,
							),
							resolved: frames?.resolved ?? 0,
							leads: frames?.leads ?? [],
						}
					: null,
			limitations: pack.limitations,
		},
		flags: detectInjection(items.map((item) => item.content))
			? ["injection_suspected"]
			: [],
		persist: async (tx) => {
			await tx
				.delete(investigationEvidence)
				.where(
					and(
						eq(investigationEvidence.investigationId, ctx.row.id),
						eq(investigationEvidence.stage, "collect_context"),
					),
				);
			await tx
				.insert(investigationEvidence)
				.values(evidenceValues(ctx.row.id, "collect_context", items));
		},
	};
}

async function planReproductionStage(ctx: StageContext): Promise<StageOutcome> {
	if (ctx.row.mode === "analysis_only")
		return {
			status: "skipped",
			summary: { reason: "analysis_only_requested" },
		};
	const target = await browserTarget(ctx);
	if (target) return planBrowserReproduction(ctx, target);
	const pack = await loadPack(ctx);
	const evidence = await loadEvidence(ctx.db, ctx.row.id);
	const tracked = new Set(
		Object.entries(pack.tracked_modes)
			.filter(([, mode]) => mode === "100644" || mode === "100755")
			.map(([file]) => file),
	);
	const importablePaths = [...tracked].filter(
		(file) => SOURCE_FILE.test(file) && !file.startsWith(".tracera/"),
	);
	const gateway = taskGateway(ctx, "plan_reproduction");
	const executions: string[] = [];
	let rejected: { source: string; errors: string[] } | undefined;
	for (let round = 0; round < 2; round++) {
		const call = await modelCall(() =>
			gateway.run(planReproductionTask, {
				user: buildReproductionPlanInput({
					evidence: promptEvidence(
						evidence.filter((item) => item.kind !== "commit"),
					),
					importablePaths,
					packageType: pack.package_json?.type ?? null,
					rejected,
				}),
				cacheKey: ctx.row.id,
				signal: ctx.signal,
			}),
		);
		if (!call.ok)
			return {
				status: "failed",
				error: call.error,
				summary: { model_execution_ids: executions },
			};
		executions.push(call.modelExecutionId);
		const plan = call.output;
		if (!plan.feasible)
			return {
				status: "skipped",
				summary: {
					reason: "reproduction_not_feasible",
					infeasible_reason: clip(plan.infeasible_reason ?? "", 1000),
					model_execution_ids: executions,
				},
			};
		const check = validateReproTest(plan.test_source, tracked);
		if (check.ok) {
			const blob = await storeText(ctx.config, plan.test_source);
			return {
				status: "succeeded",
				summary: {
					test_path: REPRO_TEST_PATH,
					test_sha256: blob.sha256,
					imports: check.imports,
					expected_observation: clip(plan.expected_observation, 1000),
					reported_observation: clip(plan.reported_observation, 1000),
					model_execution_ids: executions,
					repaired: round > 0,
				},
			};
		}
		rejected = { source: plan.test_source, errors: check.errors };
	}
	return {
		status: "failed",
		error: failure(
			"repro_plan_invalid",
			`The proposed reproduction test was rejected and not run: ${(rejected?.errors ?? []).slice(0, 3).join("; ")}`,
		),
		summary: {
			validation_errors: rejected?.errors ?? [],
			model_execution_ids: executions,
		},
	};
}

/** Browser steps from the model, validated by code before anything runs; one repair round. */
async function planBrowserReproduction(
	ctx: StageContext,
	target: BrowserTarget,
): Promise<StageOutcome> {
	const evidence = await loadEvidence(ctx.db, ctx.row.id);
	const gateway = taskGateway(ctx, "plan_reproduction");
	const executions: string[] = [];
	let rejected: { steps: string; errors: string[] } | undefined;
	for (let round = 0; round < 2; round++) {
		const call = await modelCall(() =>
			gateway.run(planBrowserReproductionTask, {
				user: buildBrowserReproductionInput({
					evidence: promptEvidence(
						evidence.filter((item) => item.kind !== "commit"),
					),
					app: {
						startPath: target.app.basePath,
						reportedPath: target.reportedPath,
					},
					rejected,
				}),
				cacheKey: ctx.row.id,
				signal: ctx.signal,
			}),
		);
		if (!call.ok)
			return {
				status: "failed",
				error: call.error,
				summary: { mode: "browser", model_execution_ids: executions },
			};
		executions.push(call.modelExecutionId);
		const plan = call.output;
		if (!plan.feasible)
			return {
				status: "skipped",
				summary: {
					mode: "browser",
					reason: "reproduction_not_feasible",
					infeasible_reason: clip(plan.infeasible_reason ?? "", 1000),
					model_execution_ids: executions,
				},
			};
		const check = validateBrowserSteps(plan.steps);
		if (check.ok) {
			const blob = await storeText(ctx.config, JSON.stringify(plan.steps));
			return {
				status: "succeeded",
				summary: {
					mode: "browser",
					steps_sha256: blob.sha256,
					step_count: plan.steps.length,
					start: target.start.join(" "),
					app_port: target.app.port,
					start_path: target.app.basePath,
					reported_path: target.reportedPath,
					expected_observation: clip(plan.expected_observation, 1000),
					reported_observation: clip(plan.reported_observation, 1000),
					model_execution_ids: executions,
					repaired: round > 0,
				},
			};
		}
		rejected = {
			steps: JSON.stringify(plan.steps).slice(0, 4000),
			errors: check.errors,
		};
	}
	return {
		status: "failed",
		error: failure(
			"repro_plan_invalid",
			`The proposed browser steps were rejected and not run: ${(rejected?.errors ?? []).slice(0, 3).join("; ")}`,
		),
		summary: {
			mode: "browser",
			validation_errors: rejected?.errors ?? [],
			model_execution_ids: executions,
		},
	};
}

/** The evidence item a set of browser runs leaves behind (observed facts only). */
function browserReproItem(
	handle: string,
	label: string,
	status: { status: ReproductionStatus; reason: string | null },
	runs: readonly ExecutedBrowserRun[],
	plan: BrowserPlan,
	expected: unknown,
): PackItem {
	const observation = runs.find((run) => run.classification.observation)
		?.classification.observation;
	const report = runs.find((run) => run.result.report)?.result.report;
	return {
		handle,
		kind: "reproduction",
		basis: "observed",
		label: `${label}: ${status.status}`,
		content: [
			`${label} in a sandboxed browser: ${status.status}${status.reason ? ` (${status.reason})` : ""}.`,
			`The app (${plan.target.start.join(" ")}) ran with no network; ${plan.steps.length} validated steps ran ${runs.length} times: ${runs.map((run) => run.classification.status).join(", ")}.`,
			typeof expected === "string" ? `The steps assert: ${expected}` : null,
			observation?.failing_tests.length
				? `Failing step: ${observation.failing_tests.join("; ")}`
				: null,
			observation?.message
				? `Message: ${clip(observation.message, 600)}`
				: null,
			observation?.expected != null
				? `Expected: ${clip(observation.expected, 300)}`
				: null,
			observation?.actual != null
				? `Actual: ${clip(observation.actual, 300)}`
				: null,
			report?.console_errors.length
				? `Console errors: ${report.console_errors
						.slice(0, 3)
						.map((error) => clip(error, 200))
						.join(" | ")}`
				: null,
			report?.blocked_requests.length
				? `Blocked requests to other hosts: ${report.blocked_requests.slice(0, 5).join(", ")}`
				: null,
		]
			.filter(Boolean)
			.join("\n"),
		locator: {
			status: status.status,
			reason: status.reason,
			sandbox_run_ids: runs.map((run) => run.id),
			screenshot_sha256s: runs.flatMap((run) =>
				run.screenshotSha256 ? [run.screenshotSha256] : [],
			),
		},
		provenance: { method: "browser_sandbox", argv: plan.target.start },
	};
}

async function reproduceBaselineStage(
	ctx: StageContext,
): Promise<StageOutcome> {
	const evidence = await loadEvidence(ctx.db, ctx.row.id);
	const findNumber = nextNumber(evidence, "FIND");
	const reproNumber = nextNumber(evidence, "REPRO");
	const record = (
		outcome: Omit<StageOutcome, "persist">,
		items: PackItem[],
	): StageOutcome => ({
		...outcome,
		persist: async (tx) => {
			await tx
				.delete(investigationEvidence)
				.where(
					and(
						eq(investigationEvidence.investigationId, ctx.row.id),
						eq(investigationEvidence.stage, "reproduce_baseline"),
					),
				);
			if (items.length > 0)
				await tx
					.insert(investigationEvidence)
					.values(evidenceValues(ctx.row.id, "reproduce_baseline", items));
		},
	});
	const notRun = (
		status: "skipped" | "blocked",
		baseline: ReproductionStatus,
		reason: string,
		detail: string,
	) =>
		record({ status, summary: { baseline, reason, detail } }, [
			factItem(
				`FIND-${findNumber}`,
				"Baseline reproduction not run",
				`The baseline reproduction was not run: ${detail}.`,
			),
		]);

	const plan = await latestStep(ctx.db, ctx.row.id, "plan_reproduction");
	const testSha =
		plan?.status === "succeeded"
			? (plan.summary.test_sha256 as string | undefined)
			: undefined;
	const environment = await sandboxEnvironment(ctx);
	const blocker = environment.blocker;
	if (blocker?.reason === "analysis_only_requested")
		return notRun("skipped", "not_attempted", blocker.reason, blocker.detail);
	if (blocker)
		return notRun("blocked", "blocked", blocker.reason, blocker.detail);
	const dependencies =
		environment.blocker === null ? environment.dependencies : null;
	const testSource = await readBlobText(ctx.config, testSha);
	const browser = await browserPlanOf(ctx, plan);
	if (
		plan?.status === "succeeded" &&
		plan.summary.mode === "browser" &&
		!browser
	)
		return notRun(
			"skipped",
			"not_attempted",
			"no_reproduction_plan",
			"the browser reproduction plan could not be loaded or the app is no longer configured",
		);
	const repo = await repositoryOf(ctx);
	const suiteCommand = repo ? parseRepositoryCommand(repo.commands.test) : null;
	if (!testSource && !browser && !suiteCommand?.ok)
		return notRun(
			"skipped",
			"not_attempted",
			"no_reproduction_plan",
			"there is no valid reproduction test and the repository test command is not allowed",
		);

	const reproRuns = testSource
		? await Promise.all(
				[1, 2].map(async (index) => {
					const dir = await runCopy(ctx, `baseline-repro-${index}`);
					await writeReproTest(dir, testSource);
					return execute(ctx, {
						purpose: "repro_baseline",
						index,
						dir,
						argv: REPRO_ARGV,
						env: { CI: "1" },
						dependencies,
					});
				}),
			)
		: [];
	// Browser runs one after another: each holds an app and a Chromium container.
	const browserRuns: ExecutedBrowserRun[] = [];
	if (browser)
		for (const index of [1, 2])
			browserRuns.push(
				await executeBrowser(ctx, {
					purpose: "repro_baseline",
					index,
					dir: await runCopy(ctx, `baseline-browser-${index}`),
					plan: browser,
					dependencies,
				}),
			);
	const suite = suiteCommand?.ok
		? await execute(ctx, {
				purpose: "suite_baseline",
				index: 1,
				dir: await runCopy(ctx, "baseline-suite"),
				argv: suiteCommand.argv,
				env: SUITE_ENV,
				dependencies,
			})
		: null;

	const items: PackItem[] = [];
	let baseline: { status: ReproductionStatus; reason: string | null } = {
		status: "not_attempted",
		reason: "no_reproduction_plan",
	};
	if (reproRuns.length > 0) {
		const classified = reproRuns
			.map((run) => run.classification)
			.filter((run): run is ReproductionRunResult => run !== null);
		baseline = combineReproductionRuns(classified);
		const observation = classified.find((run) => run.observation)?.observation;
		items.push({
			handle: `REPRO-${reproNumber}`,
			kind: "reproduction",
			basis: "observed",
			label: `Baseline reproduction: ${baseline.status}`,
			content: [
				`Baseline reproduction at ${ctx.row.commitSha.slice(0, 12)}: ${baseline.status}${baseline.reason ? ` (${baseline.reason})` : ""}.`,
				`The reproduction test (${REPRO_TEST_PATH}) ran ${reproRuns.length} times in the sandbox: ${classified.map((run) => run.status).join(", ")}.`,
				typeof plan?.summary.expected_observation === "string"
					? `The test asserts: ${plan.summary.expected_observation}`
					: null,
				observation?.failing_tests.length
					? `Failing test(s): ${observation.failing_tests.join("; ")}`
					: null,
				observation?.message
					? `Assertion output: ${clip(observation.message, 600)}`
					: null,
				observation?.expected != null
					? `Expected: ${clip(observation.expected, 300)}`
					: null,
				observation?.actual != null
					? `Actual: ${clip(observation.actual, 300)}`
					: null,
			]
				.filter(Boolean)
				.join("\n"),
			locator: {
				status: baseline.status,
				reason: baseline.reason,
				sandbox_run_ids: reproRuns.map((run) => run.id),
				test_sha256: testSha,
			},
			provenance: { method: "sandbox", argv: REPRO_ARGV },
		});
	}
	if (browser && browserRuns.length > 0) {
		baseline = combineReproductionRuns(
			browserRuns.map((run) => run.classification),
		);
		items.push(
			browserReproItem(
				`REPRO-${reproNumber}`,
				"Baseline reproduction",
				baseline,
				browserRuns,
				browser,
				plan?.summary.expected_observation,
			),
		);
	}
	if (suite && suiteCommand?.ok) {
		const tap = parseTap(suite.result.stdout);
		items.push(
			factItem(
				`FIND-${findNumber}`,
				"Baseline test suite",
				suite.result.status === "exited"
					? `Baseline test suite (${suiteCommand.argv.join(" ")}): exit code ${suite.result.exitCode}; ${
							tap.parsed
								? `${tap.pass} passed, ${tap.fail} failed${
										tap.failures.length > 0
											? ` (${tap.failures
													.slice(0, 5)
													.map((f) => f.name)
													.join("; ")})`
											: ""
									}`
								: "results could not be parsed"
						}.`
					: `The baseline test suite did not finish: ${suite.result.status}.`,
				"observed",
				{ sandbox_run_ids: [suite.id] },
			),
		);
	}
	return record(
		{
			status: "succeeded",
			summary: {
				baseline: baseline.status,
				reason: baseline.reason,
				mode: browser ? "browser" : "node_test",
				repro_run_ids: [...reproRuns, ...browserRuns].map((run) => run.id),
				suite_run_id: suite?.id ?? null,
				suite_exit_code: suite?.result.exitCode ?? null,
			},
			flags: detectInjection([
				...reproRuns.map((run) => run.result.stdout),
				...browserRuns.map((run) => run.result.appLog),
				suite?.result.stdout ?? "",
			])
				? ["injection_suspected"]
				: [],
		},
		items,
	);
}

async function generateHypothesesStage(
	ctx: StageContext,
): Promise<StageOutcome> {
	const evidence = await loadEvidence(ctx.db, ctx.row.id);
	const gateway = taskGateway(ctx, "generate_hypotheses");
	const call = await modelCall(() =>
		gateway.run(generateHypothesesTask, {
			user: buildHypothesesInput({ evidence: promptEvidence(evidence) }),
			cacheKey: ctx.row.id,
			signal: ctx.signal,
		}),
	);
	if (!call.ok) return { status: "failed", fatal: true, error: call.error };
	const output = call.output;
	const validated = validateHypotheses(output, indexOf(evidence));
	let findNumber = nextNumber(evidence, "FIND");
	const observations = validated.observations.map((observation) =>
		factItem(
			`FIND-${findNumber++}`,
			`Model observation (${observation.kind})`,
			observation.statement,
			"inferred",
			{ citations: observation.citations },
		),
	);
	return {
		status: "succeeded",
		next: validated.hypotheses.length > 0 ? "rank_hypotheses" : "write_report",
		summary: {
			model_execution_id: call.modelExecutionId,
			proposed: output.hypotheses.length,
			kept: validated.hypotheses.length,
			discarded: validated.discarded,
			invalid_citations: validated.invalidCitations,
			insufficient_evidence: output.insufficient_evidence,
			insufficient_evidence_reason: output.insufficient_evidence_reason,
			missing_information: output.missing_information,
		},
		persist: async (tx) => {
			await tx
				.delete(hypotheses)
				.where(eq(hypotheses.investigationId, ctx.row.id));
			await tx
				.delete(investigationEvidence)
				.where(
					and(
						eq(investigationEvidence.investigationId, ctx.row.id),
						eq(investigationEvidence.stage, "generate_hypotheses"),
					),
				);
			if (validated.hypotheses.length > 0)
				await tx.insert(hypotheses).values(
					validated.hypotheses.map((hypothesis, i) => ({
						id: newId("hyp"),
						investigationId: ctx.row.id,
						handle: `HYP-${i + 1}`,
						rank: i + 1,
						title: hypothesis.title,
						mechanism: hypothesis.mechanism,
						locations: hypothesis.locations,
						supporting: hypothesis.supporting,
						contradicting: hypothesis.contradicting,
						alternatives: hypothesis.alternatives,
						nextCheck: hypothesis.next_check,
						confidence: hypothesis.confidence,
						confidenceRationale: hypothesis.confidence_rationale,
						state: "proposed" as const,
						modelExecutionId: call.modelExecutionId,
					})),
				);
			if (observations.length > 0)
				await tx
					.insert(investigationEvidence)
					.values(
						evidenceValues(ctx.row.id, "generate_hypotheses", observations),
					);
		},
	};
}

async function rankHypothesesStage(ctx: StageContext): Promise<StageOutcome> {
	const rows = await ctx.db
		.select()
		.from(hypotheses)
		.where(eq(hypotheses.investigationId, ctx.row.id))
		.orderBy(asc(hypotheses.rank));
	const index = indexOf(await loadEvidence(ctx.db, ctx.row.id));
	const ranked = rankHypotheses(rows, index).map((hypothesis) => ({
		...hypothesis,
		state: hypothesisState(hypothesis, index),
	}));
	const target = selectPatchTarget(ranked, ctx.row.mode);
	return {
		status: "succeeded",
		next: target ? "generate_patch" : "write_report",
		summary: {
			ranking: ranked.map(({ handle, rank, score, state }) => ({
				handle,
				rank,
				score,
				state,
			})),
			target: target?.handle ?? null,
			reason: target ? null : "no_supported_hypothesis",
		},
		persist: async (tx) => {
			for (const hypothesis of ranked)
				await tx
					.update(hypotheses)
					.set({
						rank: hypothesis.rank,
						score: hypothesis.score,
						state: hypothesis.state,
						updatedAt: new Date(),
					})
					.where(eq(hypotheses.id, hypothesis.id));
		},
	};
}

export const escalationAvailable = (config: Config) =>
	config.inference.escalationEnabled &&
	config.inference.escalationModel !== null;
export const maxPatchAttempts = (config: Config) =>
	MAX_PRIMARY_PATCH_ATTEMPTS + (escalationAvailable(config) ? 1 : 0);

async function generatePatchStage(ctx: StageContext): Promise<StageOutcome> {
	const patches = await ctx.db
		.select()
		.from(patchProposals)
		.where(eq(patchProposals.investigationId, ctx.row.id))
		.orderBy(asc(patchProposals.attempt));
	const attempt = patches.length + 1;
	if (attempt > maxPatchAttempts(ctx.config))
		return {
			status: "skipped",
			next: "write_report",
			summary: { reason: "patch_attempts_exhausted" },
			flags: escalationAvailable(ctx.config) ? [] : ["escalation_unavailable"],
		};
	const rows = await ctx.db
		.select()
		.from(hypotheses)
		.where(eq(hypotheses.investigationId, ctx.row.id))
		.orderBy(asc(hypotheses.rank));
	const target = selectPatchTarget(rows, ctx.row.mode);
	if (!target)
		return {
			status: "skipped",
			next: "write_report",
			summary: { reason: "no_supported_hypothesis" },
		};
	const evidence = await loadEvidence(ctx.db, ctx.row.id);
	const pack = await loadPack(ctx);
	const feedback = await patchFeedback(ctx, patches.at(-1));
	const escalated = attempt > MAX_PRIMARY_PATCH_ATTEMPTS;
	const gateway = taskGateway(
		ctx,
		"generate_patch",
		escalated ? (ctx.config.inference.escalationModel ?? undefined) : undefined,
	);
	const call = await modelCall(() =>
		gateway.run(generatePatchTask, {
			user: buildPatchInput({
				target: {
					handle: target.handle,
					title: target.title,
					mechanism: target.mechanism,
					locations: target.locations,
				},
				evidence: promptEvidence(
					evidence.filter((item) =>
						[
							"report_claim",
							"evidence_asset",
							"code_excerpt",
							"reproduction",
							"commit",
						].includes(item.kind),
					),
				),
				feedback: feedback ?? undefined,
			}),
			cacheKey: ctx.row.id,
			signal: ctx.signal,
		}),
	);
	if (!call.ok)
		return {
			status: "failed",
			next: "write_report",
			error: call.error,
			summary: { attempt },
		};
	const output = call.output;
	const patchModel = { provider: gateway.providerName, model: gateway.model };
	const base = {
		investigationId: ctx.row.id,
		hypothesisId: target.id,
		attempt,
		baseCommit: ctx.row.commitSha,
		edits: output.edits,
		summary: clip(output.summary, 500),
		rationale: clip(output.rationale, 2000),
		expectedEffect: clip(output.expected_effect, 1000),
		model: patchModel,
		modelExecutionId: call.modelExecutionId,
	};
	const rejectedPatch = (
		code: string,
		message: string,
		details: string[],
	): StageOutcome => {
		const id = newId("pat");
		return {
			status: "failed",
			next:
				attempt < maxPatchAttempts(ctx.config)
					? "generate_patch"
					: "write_report",
			error: failure(code, message),
			summary: { attempt, patch_id: id, details },
			persist: async (tx) => {
				await tx.insert(patchProposals).values({
					...base,
					id,
					status: "apply_failed",
					applyError: { code, message, details },
				});
			},
		};
	};
	const policy = validatePatchEdits(
		output.edits,
		new Map(Object.entries(pack.tracked_modes)),
	);
	if (!policy.ok)
		return rejectedPatch(
			"patch_rejected_by_policy",
			"The proposed patch violates the patch policy",
			policy.errors,
		);
	const dir = await runCopy(ctx, `patch-${attempt}`);
	try {
		const applied = await applyEdits(dir, output.edits);
		if (!applied.ok)
			return rejectedPatch(
				"patch_apply_failed",
				"The proposed edits do not apply to the investigated commit",
				applied.errors,
			);
		const diff = await stageAndDiff(dir);
		if (!diff.ok)
			return rejectedPatch(
				"patch_apply_failed",
				"git could not produce a diff",
				[],
			);
		if (diff.files.length === 0)
			return rejectedPatch(
				"patch_changed_nothing",
				"The patch changes nothing",
				[],
			);
		const changed = diff.files.reduce(
			(sum, file) => sum + file.additions + file.deletions,
			0,
		);
		if (changed > MAX_CHANGED_LINES || diff.files.length > 5)
			return rejectedPatch(
				"patch_limits_exceeded",
				`The patch changes ${changed} lines in ${diff.files.length} files (limits: ${MAX_CHANGED_LINES} lines, 5 files)`,
				[],
			);
		const blob = await storeText(ctx.config, diff.diff);
		const impact = await generatedPatchImpact(ctx, dir);
		const risks = [
			...policy.risks,
			...(diff.files.some(
				(file) => TEST_FILE.test(file.path) && file.change_type === "modified",
			) && !policy.risks.some((risk) => risk.code === "modifies_existing_test")
				? [
						{
							code: "modifies_existing_test",
							message: "The patch changes an existing test",
						},
					]
				: []),
			...output.risks
				.filter((risk) => risk.trim())
				.slice(0, 5)
				.map((risk) => ({ code: "model_noted", message: clip(risk, 300) })),
		];
		const id = newId("pat");
		return {
			status: "succeeded",
			next: "verify",
			summary: {
				attempt,
				patch_id: id,
				files: diff.files,
				changed_lines: changed,
				escalated,
				model_execution_id: call.modelExecutionId,
				impact: impact.available
					? {
							complete: impact.complete,
							symbols: impact.symbols.length,
							findings: impact.findings.length,
							untested: impact.symbols
								.filter((s) => s.tests === "none_identified")
								.map((s) => s.name),
							risk: {
								evidenced: impact.risk.evidenced.severity,
								plausible: impact.risk.plausible.severity,
							},
						}
					: impact,
			},
			persist: async (tx) => {
				await tx
					.update(patchProposals)
					.set({ status: "superseded", updatedAt: new Date() })
					.where(
						and(
							eq(patchProposals.investigationId, ctx.row.id),
							eq(patchProposals.status, "proposed"),
						),
					);
				await tx.insert(patchProposals).values({
					...base,
					id,
					status: "proposed",
					files: diff.files,
					diffSha256: blob.sha256,
					diffBytes: Buffer.byteLength(diff.diff),
					risks,
					impact,
				});
			},
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * The static impact of a generated patch: the staged copy's tree compared with
 * the investigated commit. Supplementary: a failure is recorded on the patch, never fatal.
 */
async function generatedPatchImpact(
	ctx: StageContext,
	dir: string,
): Promise<PatchImpactRecord> {
	const repo = await repositoryOf(ctx);
	if (!repo) return { available: false, reason: "repository_unavailable" };
	const tree = await git(dir, ["write-tree"]);
	const sha = tree.stdout.trim();
	if (!tree.ok || !/^[0-9a-f]{40}$/.test(sha))
		return { available: false, reason: "repository_unreadable" };
	try {
		const result = await computePatchImpact(ctx, {
			repositoryId: repo.id,
			repositoryName: repo.name,
			dir,
			base: { ref: null, sha: ctx.row.commitSha },
			head: { ref: null, sha, kind: "tree" },
			mergeBase: false,
			depth: 4,
			limit: 50,
			deadline: Date.now() + GRAPH_BUDGET_MS,
			signal: ctx.signal,
		});
		return { available: true, ...result };
	} catch (error) {
		if (error instanceof ContextError && error.code === "cancelled")
			throw error;
		return {
			available: false,
			reason:
				error instanceof ContextError ? error.code : "patch_impact_failed",
		};
	}
}

/** What the next patch attempt learns from the previous one (all of it treated as untrusted text). */
async function patchFeedback(
	ctx: StageContext,
	previous: typeof patchProposals.$inferSelect | undefined,
): Promise<{ kind: string; details: string[] } | null> {
	if (!previous) return null;
	if (previous.status === "apply_failed")
		return {
			kind: "apply_failed",
			details: [
				previous.applyError?.message ?? "The patch could not be applied",
				...(previous.applyError?.details ?? []).slice(0, 10),
			],
		};
	if (previous.status === "changes_requested" && previous.approval?.comment)
		return {
			kind: "changes_requested",
			details: [
				`A reviewer requested changes: ${clip(previous.approval.comment, 2000)}`,
			],
		};
	const [run] = await ctx.db
		.select()
		.from(verificationRuns)
		.where(eq(verificationRuns.patchId, previous.id))
		.limit(1);
	if (run?.outcome !== "failed") return null;
	return {
		kind: "verification_failed",
		details: run.checks
			.filter((check) => check.status === "failed")
			.map((check) => {
				const newly = Array.isArray(check.summary.newly_failing)
					? (check.summary.newly_failing as string[]).slice(0, 5)
					: [];
				return [
					`${check.kind}: ${check.reason ?? "failed"}`,
					check.summary.observation
						? `observation ${clip(JSON.stringify(check.summary.observation), 500)}`
						: null,
					newly.length > 0 ? `newly failing: ${newly.join("; ")}` : null,
				]
					.filter(Boolean)
					.join(" — ");
			}),
	};
}

async function verifyStage(ctx: StageContext): Promise<StageOutcome> {
	const [patch] = await ctx.db
		.select()
		.from(patchProposals)
		.where(
			and(
				eq(patchProposals.investigationId, ctx.row.id),
				eq(patchProposals.status, "proposed"),
			),
		)
		.orderBy(desc(patchProposals.attempt))
		.limit(1);
	if (!patch)
		return {
			status: "skipped",
			next: "write_report",
			summary: { reason: "no_proposed_patch" },
		};
	const startedAt = new Date();
	const pack = await loadPack(ctx);
	const repo = await repositoryOf(ctx);
	const baselineStep = await latestStep(
		ctx.db,
		ctx.row.id,
		"reproduce_baseline",
	);
	const baseline =
		(baselineStep?.summary.baseline as ReproductionStatus | undefined) ??
		"not_attempted";
	const plan = await latestStep(ctx.db, ctx.row.id, "plan_reproduction");
	const testSource =
		plan?.status === "succeeded"
			? await readBlobText(ctx.config, plan.summary.test_sha256 as string)
			: null;
	const browser = await browserPlanOf(ctx, plan);
	const blocked = (reason: string): CheckRecord[] =>
		(["reproduction", "unit_tests"] as const).map((kind) => ({
			kind,
			status: "blocked",
			reason,
			command: null,
			exit_code: null,
			duration_ms: null,
			summary: {},
			sandbox_run_ids: [],
		}));
	const environment = await sandboxEnvironment(ctx);
	const blocker = environment.blocker;
	const diff = blocker
		? null
		: await readBlobText(ctx.config, patch.diffSha256);
	// What runs must be byte-for-byte the diff the reviewer sees: its hash is the patch's identity.
	const intact = diff !== null && sha256Hex(diff) === patch.diffSha256;
	const checks = blocker
		? blocked(blocker.reason)
		: diff === null
			? blocked("diff_missing")
			: !intact
				? blocked("diff_integrity_failed")
				: await runChecks(ctx, {
						patchId: patch.id,
						diff,
						baseline,
						testSource,
						browser,
						baselineSuiteId: baselineStep?.summary.suite_run_id as
							| string
							| undefined,
						commands: repo?.commands ?? null,
						dependencies:
							environment.blocker === null ? environment.dependencies : null,
						relatedTests: [
							...new Set([
								...(pack.graph?.files ?? [])
									.filter((file) =>
										patch.files.some((changed) => changed.path === file.path),
									)
									.flatMap((file) =>
										file.tests
											.filter((test) => test.name !== "(whole file)")
											.map((test) => test.name),
									),
								// Test cases the patch's impact analysis links to the changed symbols.
								...(patch.impact?.available
									? patch.impact.tests.recommended
											.filter((test) => test.state === "relevant")
											.map((test) => test.name)
									: []),
							]),
						],
					});
	const derived = deriveVerificationOutcome(checks);
	const verificationEnvironment = environmentRecord(ctx, environment);
	const id = newId("ver");
	const stillFailing = (list: readonly CheckRecord[]) =>
		list.some(
			(check) =>
				check.kind === "reproduction" && check.reason === "repro_still_failing",
		);
	const priorRuns = await ctx.db
		.select({ checks: verificationRuns.checks })
		.from(verificationRuns)
		.innerJoin(patchProposals, eq(patchProposals.id, verificationRuns.patchId))
		.where(
			and(
				eq(verificationRuns.investigationId, ctx.row.id),
				eq(patchProposals.hypothesisId, patch.hypothesisId),
				ne(verificationRuns.patchId, patch.id),
			),
		);
	// Ruled out only after two clean patches for it left the reproduction failing.
	const rejected =
		stillFailing(checks) &&
		priorRuns.some((prior) => stillFailing(prior.checks));
	const retry =
		derived.outcome === "failed" &&
		patch.attempt < maxPatchAttempts(ctx.config);
	return {
		status: "succeeded",
		next: retry ? "generate_patch" : "write_report",
		summary: {
			verification_id: id,
			patch_id: patch.id,
			diff_sha256: patch.diffSha256,
			outcome: derived.outcome,
			reasons: derived.reasons,
			checks: checks.map(({ kind, status, reason }) => ({
				kind,
				status,
				reason,
			})),
			environment: verificationEnvironment,
		},
		persist: async (tx) => {
			await tx
				.delete(verificationRuns)
				.where(eq(verificationRuns.patchId, patch.id));
			await tx.insert(verificationRuns).values({
				id,
				investigationId: ctx.row.id,
				patchId: patch.id,
				status: "completed",
				outcome: derived.outcome,
				outcomeReasons: derived.reasons,
				checks,
				environment: verificationEnvironment,
				startedAt,
				finishedAt: new Date(),
			});
			if (derived.outcome === "verified" || rejected)
				await tx
					.update(hypotheses)
					.set({
						state: derived.outcome === "verified" ? "confirmed" : "rejected",
						updatedAt: new Date(),
					})
					.where(eq(hypotheses.id, patch.hypothesisId));
		},
	};
}

/** Baseline versus post-patch runs on fresh copies with exactly the stored, reviewed diff applied. */
async function runChecks(
	ctx: StageContext,
	input: {
		patchId: string;
		diff: string;
		baseline: ReproductionStatus;
		testSource: string | null;
		/** A browser reproduction plan, replayed after the patch instead of a node test. */
		browser: BrowserPlan | null;
		baselineSuiteId: string | undefined;
		commands: {
			test: string;
			typecheck?: string;
			lint?: string;
			build?: string;
		} | null;
		/** Tests the static graph links to the investigated code (reported, never decisive). */
		relatedTests: readonly string[];
		/** The sealed dependencies every run mounts read-only, when the repository has dependencies. */
		dependencies: PreparedDependencies | null;
	},
): Promise<CheckRecord[]> {
	const dependencies = input.dependencies;
	/** Why the last patched copy could not be used: the diff did not apply, or it changed dependency inputs. */
	let unusable: "patch_does_not_apply" | "dependency_snapshot_mismatch" =
		"patch_does_not_apply";
	const patched = async (name: string, withRepro: boolean) => {
		const dir = await runCopy(ctx, name);
		const applied = await applyStoredDiff(dir, input.diff);
		// A diff that changes manifests or the lockfile cannot run against dependencies prepared before it.
		const mismatch =
			applied.ok &&
			dependencies !== null &&
			!(await snapshotMatches(dependencies, workTreeReader(dir), ctx.config));
		if (!applied.ok || mismatch) {
			unusable = mismatch
				? "dependency_snapshot_mismatch"
				: "patch_does_not_apply";
			await rm(dir, { recursive: true, force: true });
			await rm(`${dir}.patch`, { force: true });
			return null;
		}
		if (withRepro && input.testSource)
			await writeReproTest(dir, input.testSource);
		return dir;
	};
	const unusableCheck = (): Pick<CheckRecord, "status" | "reason"> =>
		unusable === "dependency_snapshot_mismatch"
			? { status: "blocked", reason: unusable }
			: { status: "failed", reason: unusable };
	const check = (
		kind: CheckRecord["kind"],
		fields: Partial<CheckRecord>,
	): CheckRecord => ({
		kind,
		status: "not_attempted",
		reason: null,
		command: null,
		exit_code: null,
		duration_ms: null,
		summary: {},
		sandbox_run_ids: [],
		...fields,
	});
	const checks: CheckRecord[] = [];

	// Reproduction: the same test (or browser steps), twice, after the patch; meaningful only when the
	// baseline reproduced.
	const browser = input.browser;
	if (input.baseline === "reproduced" && (input.testSource || browser)) {
		const runs: Array<{
			id: string;
			exitCode: number | null;
			durationMs: number;
			classification: ReproductionRunResult | null;
		}> = [];
		for (const index of [1, 2]) {
			const dir = await patched(`verify-repro-${index}`, !browser);
			if (!dir) break;
			if (browser) {
				const run = await executeBrowser(ctx, {
					purpose: "repro_post_patch",
					index,
					dir,
					plan: browser,
					patchId: input.patchId,
					dependencies,
				});
				runs.push({
					id: run.id,
					exitCode: null,
					durationMs: run.result.durationMs,
					classification: run.classification,
				});
			} else {
				const run = await execute(ctx, {
					purpose: "repro_post_patch",
					index,
					dir,
					argv: REPRO_ARGV,
					env: { CI: "1" },
					patchId: input.patchId,
					dependencies,
				});
				runs.push({
					id: run.id,
					exitCode: run.result.exitCode,
					durationMs: run.result.durationMs,
					classification: run.classification,
				});
			}
		}
		if (runs.length < 2) checks.push(check("reproduction", unusableCheck()));
		else {
			const classified = runs
				.map((run) => run.classification)
				.filter((run): run is ReproductionRunResult => run !== null);
			checks.push(
				check("reproduction", {
					...reproductionCheck(input.baseline, classified),
					command: browser
						? `browser: ${browser.steps.length} steps against ${browser.target.start.join(" ")}`
						: REPRO_ARGV.join(" "),
					exit_code: runs.at(-1)?.exitCode ?? null,
					duration_ms: runs.reduce((sum, run) => sum + run.durationMs, 0),
					summary: {
						mode: browser ? "browser" : "node_test",
						runs: classified.map((run) => run.status),
						observation:
							classified.find((run) => run.observation)?.observation ?? null,
					},
					sandbox_run_ids: runs.map((run) => run.id),
				}),
			);
		}
	} else
		checks.push(check("reproduction", reproductionCheck(input.baseline, [])));

	// The regression suite and any other configured checks: baseline versus post-patch.
	const configured: Array<[CheckRecord["kind"], string]> = [];
	for (const [kind, command] of [
		["unit_tests", input.commands?.test],
		["typecheck", input.commands?.typecheck],
		["lint", input.commands?.lint],
		["build", input.commands?.build],
	] as const)
		if (command) configured.push([kind, command]);
	for (const [kind, command] of configured) {
		const parsed = parseRepositoryCommand(command);
		if (!parsed.ok) {
			checks.push(
				check(kind, {
					status: "blocked",
					reason: "command_not_allowed",
					command,
				}),
			);
			continue;
		}
		const env = kind === "unit_tests" ? SUITE_ENV : { CI: "1" };
		const baselineRun =
			(kind === "unit_tests"
				? await storedRun(ctx, input.baselineSuiteId)
				: null) ??
			(
				await execute(ctx, {
					purpose: `${kind}_baseline`,
					index: 1,
					dir: await runCopy(ctx, `verify-${kind}-baseline`),
					argv: parsed.argv,
					env,
					dependencies,
				})
			).result;
		const dir = await patched(`verify-${kind}`, false);
		if (!dir) {
			checks.push(check(kind, { ...unusableCheck(), command }));
			continue;
		}
		const post = await execute(ctx, {
			purpose: `${kind}_post_patch`,
			index: 1,
			dir,
			argv: parsed.argv,
			env,
			patchId: input.patchId,
			dependencies,
		});
		const result =
			kind === "unit_tests"
				? suiteCheck(baselineRun, post.result)
				: exitCodeCheck(baselineRun, post.result);
		checks.push(
			check(kind, {
				status: result.status,
				reason: result.reason,
				command,
				exit_code: post.result.exitCode,
				duration_ms: post.result.durationMs,
				summary:
					kind === "unit_tests" && input.relatedTests.length > 0
						? {
								...result.summary,
								graph_linked_tests: linkedTestOutcomes(
									input.relatedTests,
									post.result,
								),
							}
						: result.summary,
				sandbox_run_ids: [post.id],
			}),
		);
	}
	return checks;
}

/** Non-TAP checks (typecheck, lint, build) compare exit codes only. */
function exitCodeCheck(
	baseline: SandboxRunResult,
	post: SandboxRunResult,
): {
	status: CheckRecord["status"];
	reason: string | null;
	summary: Record<string, unknown>;
} {
	const summary = {
		baseline_exit_code: baseline.exitCode,
		exit_code: post.exitCode,
	};
	if (post.status !== "exited")
		return {
			status: "inconclusive",
			reason: post.status === "timed_out" ? "sandbox_timeout" : "sandbox_error",
			summary,
		};
	if (post.exitCode === 0) return { status: "passed", reason: null, summary };
	return baseline.exitCode !== 0
		? { status: "inconclusive", reason: "failing_at_baseline", summary }
		: { status: "failed", reason: "newly_failing", summary };
}

async function writeReportStage(ctx: StageContext): Promise<StageOutcome> {
	const report = await buildResolutionReport(ctx.db, ctx.row.id);
	const markdown = await storeText(ctx.config, report.markdown);
	const [last] = await ctx.db
		.select({ version: resolutionReports.version })
		.from(resolutionReports)
		.where(eq(resolutionReports.investigationId, ctx.row.id))
		.orderBy(desc(resolutionReports.version))
		.limit(1);
	const version = (last?.version ?? 0) + 1;
	const [proposed] = await ctx.db
		.select({ id: patchProposals.id })
		.from(patchProposals)
		.where(
			and(
				eq(patchProposals.investigationId, ctx.row.id),
				eq(patchProposals.status, "proposed"),
			),
		)
		.limit(1);
	await removeWorkspace(ctx.config, ctx.row.id);
	return {
		status: "succeeded",
		next: proposed ? "awaiting_approval" : "completed",
		summary: {
			report_version: version,
			verification_outcome: report.content.verification.outcome,
			baseline: report.content.reproduction.baseline,
		},
		persist: async (tx) => {
			await tx.insert(resolutionReports).values({
				id: newId("rpt"),
				investigationId: ctx.row.id,
				version,
				content: report.content,
				markdownSha256: markdown.sha256,
				generatedWith: report.content.generated_with,
			});
		},
	};
}

/**
 * Prepares (or reuses) the dependencies locked at the investigated commit.
 * Not required → skipped; a refused lockfile or no sandbox → blocked; a failed install → failed. None
 * of these is fatal: the sandbox stages then record `dependencies_not_prepared` with this reason.
 */
async function prepareDependenciesStage(
	ctx: StageContext,
): Promise<StageOutcome> {
	if (ctx.row.mode === "analysis_only")
		return {
			status: "skipped",
			summary: { reason: "analysis_only_requested" },
		};
	const base = await ensureBase(ctx);
	let outcome: EnsureResult;
	try {
		outcome = await ensureDependencySnapshot(ctx, {
			workspaceId: ctx.row.workspaceId,
			repositoryId: ctx.row.repositoryId,
			commitSha: ctx.row.commitSha,
			read: gitFileReader(base, ctx.row.commitSha),
			signal: ctx.signal,
		});
	} catch (error) {
		if (!(error instanceof ContextError)) throw error;
		return {
			status: "failed",
			summary: { reason: error.code, detail: error.message },
			error: {
				code: error.code,
				message: error.message,
				retryable: error.retryable,
			},
		};
	}
	throwIfStopped(ctx);
	switch (outcome.status) {
		case "not_required":
			return { status: "skipped", summary: { reason: outcome.reason } };
		case "blocked":
			return {
				status: "blocked",
				summary: { reason: outcome.code, detail: outcome.detail },
			};
		case "failed":
			return {
				status: "failed",
				summary: {
					snapshot_id: outcome.snapshotId,
					reason: outcome.code,
					detail: outcome.detail,
				},
				error: { code: outcome.code, message: outcome.detail, retryable: true },
			};
		case "ready": {
			const { snapshot } = outcome;
			return {
				status: "succeeded",
				summary: {
					snapshot_id: snapshot.id,
					reused: outcome.reused,
					manager: snapshot.manager,
					lockfile: snapshot.lockfile,
					registry: snapshot.registry,
					digest: snapshot.seal?.digest ?? null,
					files: snapshot.seal?.files ?? null,
					bytes: snapshot.seal?.bytes ?? null,
					mounts: snapshot.seal?.mounts ?? [],
					egress: snapshot.egress ?? null,
					duration_ms: snapshot.durationMs ?? null,
				},
			};
		}
	}
}

export const STAGES: Record<
	InvestigationStage,
	(ctx: StageContext) => Promise<StageOutcome>
> = {
	normalize: normalizeStage,
	collect_context: collectContextStage,
	prepare_dependencies: prepareDependenciesStage,
	plan_reproduction: planReproductionStage,
	reproduce_baseline: reproduceBaselineStage,
	generate_hypotheses: generateHypothesesStage,
	rank_hypotheses: rankHypothesesStage,
	generate_patch: generatePatchStage,
	verify: verifyStage,
	write_report: writeReportStage,
};
