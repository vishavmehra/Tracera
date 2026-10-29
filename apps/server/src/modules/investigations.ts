import {
	ACTIVE_INVESTIGATION_STATUSES,
	type CreateInvestigationRequest,
	INVESTIGATION_STAGES,
	type InvestigationStage,
	type InvestigationStatus,
	TERMINAL_INVESTIGATION_STATUSES,
} from "@tracera/contracts";
import { and, asc, desc, eq, inArray, lt, max, or, sql } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, pgErrorCode, withTransaction } from "../db/client.ts";
import {
	bugReports,
	hypotheses,
	investigationEvidence,
	investigationSteps,
	investigations,
	modelExecutions,
	patchProposals,
	sandboxRuns,
	verificationRuns,
} from "../db/schema.ts";
import type { ChatProvider } from "../inference/providers.ts";
import {
	generateHypothesesTask,
	generatePatchTask,
	normalizeBugReportTask,
	planReproductionTask,
} from "../inference/tasks.ts";
import { resolveCommit } from "../lib/git.ts";
import { AppError, decodeCursor, encodeCursor } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { enqueueStage, type StageJob } from "../queue.ts";
import type { SandboxExecutor } from "../sandbox/executor.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import { ContextError } from "./context.ts";
import { idempotent } from "./idempotency.ts";
import {
	defaultNext,
	escalationAvailable,
	FATAL_STAGES,
	type InvestigationRow,
	STAGE_SPECIALISTS,
	STAGE_TIMEOUT_MS,
	STAGE_TRANSITIONS,
	STAGES,
	type StageOutcome,
	type StageTarget,
	type StepError,
} from "./pipeline.ts";
import { getRepositoryRow } from "./repositories.ts";
import { removeWorkspace } from "./workspace.ts";

const STAGE_COUNT = INVESTIGATION_STAGES.length;
const isTerminal = (status: string) =>
	(TERMINAL_INVESTIGATION_STATUSES as readonly string[]).includes(status);
const bumpVersion = () => sql`${investigations.stateVersion} + 1`;
/** A step still `running` this long after its stage timeout lost its worker. */
const RECOVERY_GRACE_MS = 60_000;
const MAX_STAGE_ATTEMPTS = 3;

export const STAGE_MESSAGES: Record<InvestigationStage, string> = {
	normalize: "Normalizing the bug report",
	collect_context: "Collecting repository context",
	prepare_dependencies: "Preparing locked dependencies in an isolated sandbox",
	plan_reproduction: "Planning a reproduction test",
	reproduce_baseline: "Reproducing the bug in the sandbox",
	generate_hypotheses: "Forming evidence-linked hypotheses",
	rank_hypotheses: "Ranking hypotheses",
	generate_patch: "Generating a patch proposal",
	verify: "Verifying the patch in the sandbox",
	write_report: "Writing the resolution report",
};

/** Legal investigation status transitions. Anything else is a bug. */
export const STATUS_TRANSITIONS: Record<
	InvestigationStatus,
	readonly InvestigationStatus[]
> = {
	queued: ["running", "failed", "cancelled"],
	running: [
		"running",
		"needs_input",
		"awaiting_approval",
		"completed",
		"failed",
		"cancelled",
	],
	needs_input: ["queued", "cancelled"],
	awaiting_approval: ["queued", "completed", "cancelled"],
	failed: ["queued"],
	completed: [],
	cancelled: [],
};

export class IllegalTransitionError extends Error {
	override name = "IllegalTransitionError";
}

export function assertTransition(
	from: InvestigationStatus,
	to: InvestigationStatus,
): void {
	if (!STATUS_TRANSITIONS[from].includes(to))
		throw new IllegalTransitionError(
			`Illegal investigation transition ${from} → ${to}`,
		);
}

export function assertStageTransition(
	from: InvestigationStage,
	to: StageTarget,
): void {
	if (!STAGE_TRANSITIONS[from].includes(to))
		throw new IllegalTransitionError(
			`Illegal stage transition ${from} → ${to}`,
		);
}

export async function createInvestigation(
	deps: { pool: pg.Pool; db: Db; boss: PgBoss; config: Config },
	ctx: AuthContext,
	input: CreateInvestigationRequest,
	meta: { requestId: string; idempotencyKey: string | undefined },
) {
	const actor = actorOf(ctx);
	return idempotent(
		deps,
		{
			workspaceId: ctx.workspaceId,
			actorId: actor.id ?? ctx.userId,
			key: meta.idempotencyKey,
			methodPath: "POST /api/v1/investigations",
			body: input,
		},
		async ({ db, queueDb }) => {
			const [bug] = await db
				.select()
				.from(bugReports)
				.where(
					and(
						eq(bugReports.id, input.bug_report_id),
						eq(bugReports.workspaceId, ctx.workspaceId),
					),
				)
				.for("update")
				.limit(1);
			if (!bug)
				throw new AppError(
					404,
					"not_found",
					`Bug report ${input.bug_report_id} was not found`,
				);
			if (bug.status !== "open" && bug.status !== "investigating") {
				throw new AppError(
					409,
					"invalid_state",
					`Bug report is ${bug.status}; only open reports can be investigated`,
				);
			}
			const repositoryId = input.repository_id ?? bug.repositoryId;
			if (!repositoryId)
				throw new AppError(
					422,
					"repository_required",
					"Choose a repository for this investigation",
				);
			const repo = await getRepositoryRow(db, ctx.workspaceId, repositoryId);
			const [active] = await db
				.select({ id: investigations.id })
				.from(investigations)
				.where(
					and(
						eq(investigations.bugReportId, bug.id),
						inArray(investigations.status, [...ACTIVE_INVESTIGATION_STATUSES]),
					),
				)
				.limit(1);
			if (active) {
				throw new AppError(
					409,
					"investigation_active",
					"This bug report already has an active investigation",
					{
						extra: { investigation_id: active.id },
					},
				);
			}
			const commitSha = await resolveCommit(
				repo.sourceRef,
				input.commit ?? repo.defaultBranch,
			);
			if (!commitSha)
				throw new AppError(
					422,
					"commit_not_found",
					`${input.commit ?? repo.defaultBranch} does not resolve to a commit`,
				);
			// The requested mode is recorded as asked. Whether the sandbox can run is decided by each
			// sandbox stage at run time; the API never talks to Docker.
			const mode = input.mode ?? "full";
			const id = newId("inv");
			const inference = deps.config.inference;
			try {
				await db.insert(investigations).values({
					id,
					workspaceId: ctx.workspaceId,
					bugReportId: bug.id,
					repositoryId: repo.id,
					commitSha,
					status: "queued",
					mode,
					modeReason: mode === "analysis_only" ? "requested" : null,
					modelProfile: input.model_profile ?? "standard",
					interactive: input.interactive ?? ctx.kind === "session",
					flags:
						inference.provider === "openai_compatible"
							? ["placeholder_provider"]
							: [],
					progress: {
						stage_index: 0,
						stage_count: STAGE_COUNT,
						message: "Queued",
					},
					configSnapshot: {
						inference: {
							provider: inference.providerName,
							kind: inference.provider,
							model: inference.reasoningModel,
							task_models: inference.taskModels,
							escalation_model: escalationAvailable(deps.config)
								? inference.escalationModel
								: null,
						},
						prompt_versions: Object.fromEntries(
							[
								normalizeBugReportTask,
								planReproductionTask,
								generateHypothesesTask,
								generatePatchTask,
							].map((task) => [task.name, task.promptVersion]),
						),
						limits: {
							max_model_calls: inference.investigationMaxModelCalls,
							budget_usd: inference.investigationBudgetUsd,
						},
						sandbox: {
							mode: deps.config.sandboxMode,
							image: deps.config.sandboxImage,
							timeout_ms: deps.config.sandboxTimeoutMs,
						},
						repository_commands: repo.commands,
					},
					createdBy: ctx.userId,
				});
			} catch (error) {
				if (pgErrorCode(error) === "23505")
					throw new AppError(
						409,
						"investigation_active",
						"This bug report already has an active investigation",
					);
				throw error;
			}
			await db
				.update(bugReports)
				.set({ status: "investigating", updatedAt: new Date() })
				.where(eq(bugReports.id, bug.id));
			await audit(db, {
				workspaceId: ctx.workspaceId,
				actor,
				action: "investigation.created",
				targetType: "investigation",
				targetId: id,
				metadata: { bug_report_id: bug.id, repository_id: repo.id, mode },
				requestId: meta.requestId,
			});
			await enqueueStage(deps.boss, queueDb, {
				investigationId: id,
				stage: "normalize",
				attempt: 1,
			});
			return {
				status: 202,
				body: {
					investigation: await getInvestigationView(db, ctx.workspaceId, id),
				},
			};
		},
	);
}

export async function loadRow(
	db: Db,
	id: string,
): Promise<InvestigationRow | undefined> {
	const [row] = await db
		.select()
		.from(investigations)
		.where(eq(investigations.id, id))
		.limit(1);
	return row;
}

type ViewExtras = {
	counts: {
		findings: number;
		hypotheses: number;
		reproductions: number;
		patches: number;
	};
	baseline_reproduction: {
		status: string;
		reason: string | null;
		sandbox_run_ids: string[];
	} | null;
	latest_patch: { id: string; status: string; attempt: number } | null;
	latest_verification: {
		id: string;
		patch_id: string;
		outcome: string;
		outcome_reasons: string[];
	} | null;
};

const NO_EXTRAS: ViewExtras = {
	counts: { findings: 0, hypotheses: 0, reproductions: 0, patches: 0 },
	baseline_reproduction: null,
	latest_patch: null,
	latest_verification: null,
};

/**
 * One round trip (the database may be remote, ~100 ms each). A single statement also works inside
 * transactions, which own a single client.
 */
async function viewExtras(db: Db, id: string): Promise<ViewExtras> {
	const result = await db.execute<{
		findings: number;
		hypotheses: number;
		reproductions: number;
		patches: number;
		latest_patch: ViewExtras["latest_patch"];
		baseline: Record<string, unknown> | null;
		verification: ViewExtras["latest_verification"];
	}>(sql`
		select
			(select count(*)::int from ${investigationEvidence}
			  where ${investigationEvidence.investigationId} = ${id}
			    and ${investigationEvidence.kind} in ('repository_fact', 'model_observation')) as findings,
			(select count(*)::int from ${hypotheses} where ${hypotheses.investigationId} = ${id}) as hypotheses,
			(select count(*)::int from ${sandboxRuns}
			  where ${sandboxRuns.investigationId} = ${id} and ${sandboxRuns.purpose} like 'repro%') as reproductions,
			(select count(*)::int from ${patchProposals} where ${patchProposals.investigationId} = ${id}) as patches,
			(select json_build_object('id', p.id, 'status', p.status, 'attempt', p.attempt)
			   from ${patchProposals} p where p.investigation_id = ${id}
			  order by p.attempt desc limit 1) as latest_patch,
			(select s.summary from ${investigationSteps} s
			  where s.investigation_id = ${id} and s.stage = 'reproduce_baseline'
			  order by s.attempt desc limit 1) as baseline,
			(select json_build_object('id', v.id, 'patch_id', v.patch_id, 'outcome', v.outcome,
			                          'outcome_reasons', v.outcome_reasons)
			   from ${verificationRuns} v where v.investigation_id = ${id}
			  order by v.created_at desc limit 1) as verification`);
	const row = result.rows[0];
	const baseline = row?.baseline ?? null;
	return {
		counts: {
			findings: row?.findings ?? 0,
			hypotheses: row?.hypotheses ?? 0,
			reproductions: row?.reproductions ?? 0,
			patches: row?.patches ?? 0,
		},
		baseline_reproduction:
			baseline && typeof baseline.baseline === "string"
				? {
						status: baseline.baseline,
						reason: (baseline.reason as string | null) ?? null,
						sandbox_run_ids:
							(baseline.repro_run_ids as string[] | undefined) ?? [],
					}
				: null,
		latest_patch: row?.latest_patch ?? null,
		latest_verification: row?.verification ?? null,
	};
}

export async function getInvestigationView(
	db: Db,
	workspaceId: string,
	id: string,
) {
	const [row] = await db
		.select()
		.from(investigations)
		.where(
			and(
				eq(investigations.id, id),
				eq(investigations.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(404, "not_found", `Investigation ${id} was not found`);
	const steps = await db
		.select()
		.from(investigationSteps)
		.where(eq(investigationSteps.investigationId, id))
		.orderBy(asc(investigationSteps.createdAt));
	return toView(row, steps, await viewExtras(db, id));
}

/** Long-poll: waits up to wait_seconds for state_version to differ from known_version. */
export async function getInvestigation(
	db: Db,
	workspaceId: string,
	id: string,
	query: { wait_seconds: number; known_version?: number | undefined },
) {
	const deadline = Date.now() + query.wait_seconds * 1000;
	// Waiting polls only the version (one small query); the full view is built once, on return.
	while (query.known_version !== undefined && Date.now() < deadline) {
		const [row] = await db
			.select({ version: investigations.stateVersion })
			.from(investigations)
			.where(
				and(
					eq(investigations.id, id),
					eq(investigations.workspaceId, workspaceId),
				),
			)
			.limit(1);
		if (!row || row.version !== query.known_version) break;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return getInvestigationView(db, workspaceId, id);
}

export async function listInvestigations(
	db: Db,
	workspaceId: string,
	query: {
		limit: number;
		cursor?: string | undefined;
		bug_report_id?: string | undefined;
		status?: string | undefined;
	},
) {
	const cursor = decodeCursor(query.cursor);
	const rows = await db
		.select()
		.from(investigations)
		.where(
			and(
				eq(investigations.workspaceId, workspaceId),
				query.bug_report_id
					? eq(investigations.bugReportId, query.bug_report_id)
					: undefined,
				query.status
					? eq(
							investigations.status,
							query.status as InvestigationRow["status"],
						)
					: undefined,
				cursor
					? or(
							lt(investigations.createdAt, cursor.createdAt),
							and(
								eq(investigations.createdAt, cursor.createdAt),
								lt(investigations.id, cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(investigations.createdAt), desc(investigations.id))
		.limit(query.limit + 1);
	const page = rows.slice(0, query.limit);
	const last = page.at(-1);
	return {
		items: page.map((row) => toView(row, [], NO_EXTRAS)),
		next_cursor:
			rows.length > query.limit && last
				? encodeCursor(last.createdAt, last.id)
				: null,
	};
}

export async function cancelInvestigation(
	db: Db,
	ctx: AuthContext,
	id: string,
	requestId: string,
) {
	const view = await getInvestigationView(db, ctx.workspaceId, id);
	if (isTerminal(view.status))
		throw new AppError(
			409,
			"invalid_state",
			`Investigation is already ${view.status}`,
		);
	const row = await loadRow(db, id);
	if (!row)
		throw new AppError(404, "not_found", `Investigation ${id} was not found`);
	if (row.status === "running") {
		// The worker notices within a second, aborts model calls, and kills sandbox containers.
		await db
			.update(investigations)
			.set({
				cancelRequestedAt: new Date(),
				stateVersion: bumpVersion(),
				updatedAt: new Date(),
			})
			.where(eq(investigations.id, id));
	} else {
		await finalizeCancelled(db, { ...row, cancelRequestedAt: new Date() });
	}
	await audit(db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: "investigation.cancel_requested",
		targetType: "investigation",
		targetId: id,
		requestId,
	});
	return { investigation: await getInvestigationView(db, ctx.workspaceId, id) };
}

export async function retryInvestigation(
	deps: { pool: pg.Pool; db: Db; boss: PgBoss },
	ctx: AuthContext,
	id: string,
	requestId: string,
) {
	const view = await getInvestigationView(deps.db, ctx.workspaceId, id);
	if (view.status !== "failed")
		throw new AppError(
			409,
			"invalid_state",
			"Only failed investigations can be retried",
		);
	const stage = (view.failure?.stage ??
		view.current_stage ??
		"normalize") as InvestigationStage;
	const [last] = await deps.db
		.select({ attempt: max(investigationSteps.attempt) })
		.from(investigationSteps)
		.where(
			and(
				eq(investigationSteps.investigationId, id),
				eq(investigationSteps.stage, stage),
			),
		);
	const attempt = (last?.attempt ?? 0) + 1;
	try {
		await withTransaction(deps.pool, async ({ db, queueDb }) => {
			assertTransition("failed", "queued");
			await db
				.update(investigations)
				.set({
					status: "queued",
					failure: null,
					finishedAt: null,
					currentStage: stage,
					progress: {
						stage_index: INVESTIGATION_STAGES.indexOf(stage) + 1,
						stage_count: STAGE_COUNT,
						message: `Retrying: ${STAGE_MESSAGES[stage]}`,
					},
					stateVersion: bumpVersion(),
					updatedAt: new Date(),
				})
				.where(
					and(eq(investigations.id, id), eq(investigations.status, "failed")),
				);
			await db
				.update(bugReports)
				.set({ status: "investigating", updatedAt: new Date() })
				.where(eq(bugReports.id, view.bug_report_id));
			await audit(db, {
				workspaceId: ctx.workspaceId,
				actor: actorOf(ctx),
				action: "investigation.retried",
				targetType: "investigation",
				targetId: id,
				metadata: { stage, attempt },
				requestId,
			});
			await enqueueStage(deps.boss, queueDb, {
				investigationId: id,
				stage,
				attempt,
			});
		});
	} catch (error) {
		if (pgErrorCode(error) === "23505")
			throw new AppError(
				409,
				"investigation_active",
				"This bug report already has an active investigation",
			);
		throw error;
	}
	return {
		investigation: await getInvestigationView(deps.db, ctx.workspaceId, id),
	};
}

export async function listModelExecutions(
	db: Db,
	workspaceId: string,
	investigationId: string,
) {
	await getInvestigationView(db, workspaceId, investigationId);
	const rows = await db
		.select()
		.from(modelExecutions)
		.where(eq(modelExecutions.investigationId, investigationId))
		.orderBy(asc(modelExecutions.createdAt));
	const items = rows.map((row) => ({
		id: row.id,
		task: row.task,
		provider: row.provider,
		model: row.model,
		prompt_version: row.promptVersion,
		status: row.status,
		input_tokens: row.inputTokens,
		output_tokens: row.outputTokens,
		reasoning_tokens: row.reasoningTokens,
		cached_tokens: row.cachedTokens,
		latency_ms: row.latencyMs,
		estimated_cost_usd: Number(row.estimatedCostUsd),
		attempts: row.attempts,
		error: row.error ?? null,
		created_at: row.createdAt.toISOString(),
	}));
	const sum = (
		key:
			| "input_tokens"
			| "output_tokens"
			| "reasoning_tokens"
			| "estimated_cost_usd",
	) => items.reduce((total, item) => total + item[key], 0);
	return {
		items,
		totals: {
			requests: items.length,
			input_tokens: sum("input_tokens"),
			output_tokens: sum("output_tokens"),
			reasoning_tokens: sum("reasoning_tokens"),
			estimated_cost_usd:
				Math.round(sum("estimated_cost_usd") * 1_000_000) / 1_000_000,
		},
	};
}

// ---- Stage runner (worker) -------------------------------------------------------------------

export type StageDeps = {
	db: Db;
	pool: pg.Pool;
	boss: PgBoss;
	config: Config;
	provider: ChatProvider;
	executor: SandboxExecutor;
	log?: (message: string, fields: Record<string, unknown>) => void;
};

const stepWhere = (job: StageJob) =>
	and(
		eq(investigationSteps.investigationId, job.investigationId),
		eq(investigationSteps.stage, job.stage),
		eq(investigationSteps.attempt, job.attempt),
	);

/**
 * Executes one stage of one investigation. Idempotent per
 * (investigation, stage, attempt): jobs for terminal, cancelled, superseded, or already finished
 * steps do nothing. Stage outputs, the step result, and the next job commit in one transaction.
 */
export async function runInvestigationStage(
	deps: StageDeps,
	job: StageJob,
): Promise<void> {
	const row = await loadRow(deps.db, job.investigationId);
	if (!row || (row.status !== "queued" && row.status !== "running")) return;
	if (row.cancelRequestedAt) return cancelNow(deps, row, job);
	const [latest] = await deps.db
		.select({ attempt: max(investigationSteps.attempt) })
		.from(investigationSteps)
		.where(
			and(
				eq(investigationSteps.investigationId, row.id),
				eq(investigationSteps.stage, job.stage),
			),
		);
	if ((latest?.attempt ?? 0) > job.attempt) return; // superseded by a newer attempt
	const [existing] = await deps.db
		.select({ status: investigationSteps.status })
		.from(investigationSteps)
		.where(stepWhere(job))
		.limit(1);
	if (
		existing &&
		existing.status !== "running" &&
		existing.status !== "pending"
	)
		return; // finished earlier; its outcome and next job were committed together

	const start = await withTransaction(deps.pool, async ({ db }) => {
		const [current] = await db
			.select()
			.from(investigations)
			.where(eq(investigations.id, row.id))
			.for("update")
			.limit(1);
		if (
			!current ||
			(current.status !== "queued" && current.status !== "running")
		)
			return "skip" as const;
		if (current.cancelRequestedAt) return "cancel" as const;
		assertTransition(current.status, "running");
		await db
			.insert(investigationSteps)
			.values({
				id: newId("stp"),
				investigationId: row.id,
				stage: job.stage,
				attempt: job.attempt,
				status: "running",
				startedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: [
					investigationSteps.investigationId,
					investigationSteps.stage,
					investigationSteps.attempt,
				],
				set: { status: "running", startedAt: new Date(), error: null },
			});
		await db
			.update(investigations)
			.set({
				status: "running",
				currentStage: job.stage,
				startedAt: current.startedAt ?? new Date(),
				progress: {
					stage_index: INVESTIGATION_STAGES.indexOf(job.stage) + 1,
					stage_count: STAGE_COUNT,
					message: STAGE_MESSAGES[job.stage],
				},
				stateVersion: bumpVersion(),
				updatedAt: new Date(),
			})
			.where(eq(investigations.id, row.id));
		return "started" as const;
	});
	if (start === "skip") return;
	if (start === "cancel") {
		const fresh = await loadRow(deps.db, row.id);
		return fresh ? cancelNow(deps, fresh, job) : undefined;
	}

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort("stage_timeout"),
		STAGE_TIMEOUT_MS[job.stage],
	);
	const poll = setInterval(() => {
		loadRow(deps.db, row.id).then(
			(fresh) => {
				if (fresh?.cancelRequestedAt) controller.abort("cancelled");
			},
			() => undefined,
		);
	}, 1000);
	let outcome: StageOutcome;
	try {
		outcome = await STAGES[job.stage]({
			db: deps.db,
			pool: deps.pool,
			config: deps.config,
			provider: deps.provider,
			executor: deps.executor,
			row: { ...row, status: "running" },
			stage: job.stage,
			attempt: job.attempt,
			signal: controller.signal,
		});
	} catch (error) {
		outcome = errorOutcome(job.stage, error, controller.signal);
		deps.log?.("stage failed", {
			investigation_id: row.id,
			stage: job.stage,
			attempt: job.attempt,
			error: (error as Error).message,
		});
	} finally {
		clearTimeout(timer);
		clearInterval(poll);
	}
	const fresh = await loadRow(deps.db, row.id);
	if (!fresh) return;
	if (fresh.cancelRequestedAt) return cancelNow(deps, fresh, job);
	await complete(deps, fresh, job, outcome);
}

function errorOutcome(
	stage: InvestigationStage,
	error: unknown,
	signal: AbortSignal,
): StageOutcome {
	const fatal = FATAL_STAGES.has(stage);
	if (signal.aborted && signal.reason === "stage_timeout")
		return {
			status: "failed",
			fatal,
			error: {
				code: "stage_timeout",
				message: `The ${stage} stage exceeded its ${Math.round(STAGE_TIMEOUT_MS[stage] / 1000)} s time limit`,
				retryable: true,
			},
		};
	if (error instanceof ContextError)
		return {
			status: "failed",
			fatal,
			error: {
				code: error.code,
				message: error.message,
				retryable: error.retryable,
			},
		};
	return {
		status: "failed",
		fatal,
		error: {
			code: "stage_error",
			message: `The ${stage} stage failed unexpectedly`,
			retryable: true,
		},
	};
}

async function complete(
	deps: StageDeps,
	row: InvestigationRow,
	job: StageJob,
	outcome: StageOutcome,
) {
	const target = outcome.fatal
		? null
		: (outcome.next ?? defaultNext(job.stage));
	if (target) assertStageTransition(job.stage, target);
	await withTransaction(deps.pool, async ({ db, queueDb }) => {
		const [current] = await db
			.select()
			.from(investigations)
			.where(eq(investigations.id, row.id))
			.for("update")
			.limit(1);
		if (current?.status !== "running" || current.cancelRequestedAt) return;
		await outcome.persist?.(db);
		await db
			.update(investigationSteps)
			.set({
				status: outcome.status,
				finishedAt: new Date(),
				summary: { ...(outcome.summary ?? {}), next: target },
				error: outcome.error ?? null,
			})
			.where(stepWhere(job));
		const flags = [...new Set([...current.flags, ...(outcome.flags ?? [])])];
		if (!target) {
			await failInvestigationTx(
				db,
				{ ...current, flags },
				job.stage,
				outcome.error ?? {
					code: "stage_failed",
					message: `The ${job.stage} stage failed`,
					retryable: false,
				},
			);
			return;
		}
		if (target === "completed" || target === "awaiting_approval") {
			assertTransition("running", target);
			await db
				.update(investigations)
				.set({
					status: target,
					flags,
					currentStage: job.stage,
					finishedAt: target === "completed" ? new Date() : null,
					progress: {
						stage_index: STAGE_COUNT,
						stage_count: STAGE_COUNT,
						message:
							target === "completed" ? "Completed" : "Awaiting human approval",
					},
					stateVersion: bumpVersion(),
					updatedAt: new Date(),
				})
				.where(eq(investigations.id, row.id));
			if (target === "completed")
				await db
					.update(bugReports)
					.set({ status: "open", updatedAt: new Date() })
					.where(
						and(
							eq(bugReports.id, row.bugReportId),
							eq(bugReports.status, "investigating"),
						),
					);
			await audit(db, {
				workspaceId: row.workspaceId,
				actor: WORKER_ACTOR,
				action:
					target === "completed"
						? "investigation.completed"
						: "investigation.awaiting_approval",
				targetType: "investigation",
				targetId: row.id,
				metadata: { stage: job.stage },
			});
			return;
		}
		const [last] = await db
			.select({ attempt: max(investigationSteps.attempt) })
			.from(investigationSteps)
			.where(
				and(
					eq(investigationSteps.investigationId, row.id),
					eq(investigationSteps.stage, target),
				),
			);
		await db
			.update(investigations)
			.set({
				flags,
				progress: {
					stage_index: INVESTIGATION_STAGES.indexOf(target) + 1,
					stage_count: STAGE_COUNT,
					message: `Queued: ${STAGE_MESSAGES[target]}`,
				},
				stateVersion: bumpVersion(),
				updatedAt: new Date(),
			})
			.where(eq(investigations.id, row.id));
		await enqueueStage(deps.boss, queueDb, {
			investigationId: row.id,
			stage: target,
			attempt: (last?.attempt ?? 0) + 1,
		});
	});
	if (!target)
		await removeWorkspace(deps.config, row.id).catch(() => undefined);
}

async function cancelNow(
	deps: StageDeps,
	row: InvestigationRow,
	job: StageJob,
) {
	await deps.db
		.update(investigationSteps)
		.set({
			status: "cancelled",
			finishedAt: new Date(),
			error: {
				code: "cancelled",
				message: "Cancelled by user",
				retryable: false,
			},
		})
		.where(
			and(
				stepWhere(job),
				inArray(investigationSteps.status, ["pending", "running"]),
			),
		);
	await removeWorkspace(deps.config, row.id).catch(() => undefined);
	await finalizeCancelled(deps.db, row);
}

async function failInvestigationTx(
	db: Db,
	row: InvestigationRow,
	stage: InvestigationStage,
	error: StepError,
) {
	assertTransition(row.status, "failed");
	await db
		.update(investigations)
		.set({
			status: "failed",
			flags: row.flags,
			currentStage: stage,
			failure: {
				stage,
				code: error.code,
				message: error.message,
				retryable: error.retryable,
			},
			finishedAt: new Date(),
			progress: {
				stage_index: INVESTIGATION_STAGES.indexOf(stage) + 1,
				stage_count: STAGE_COUNT,
				message: error.message,
			},
			stateVersion: bumpVersion(),
			updatedAt: new Date(),
		})
		.where(eq(investigations.id, row.id));
	await db
		.update(bugReports)
		.set({ status: "open", updatedAt: new Date() })
		.where(
			and(
				eq(bugReports.id, row.bugReportId),
				eq(bugReports.status, "investigating"),
			),
		);
	await audit(db, {
		workspaceId: row.workspaceId,
		actor: WORKER_ACTOR,
		action: "investigation.failed",
		targetType: "investigation",
		targetId: row.id,
		metadata: { stage, code: error.code },
	});
}

export async function finalizeCancelled(db: Db, row: InvestigationRow) {
	await db.transaction(async (tx) => {
		const updated = await tx
			.update(investigations)
			.set({
				status: "cancelled",
				cancelRequestedAt: row.cancelRequestedAt ?? new Date(),
				finishedAt: new Date(),
				stateVersion: bumpVersion(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(investigations.id, row.id),
					inArray(investigations.status, [...ACTIVE_INVESTIGATION_STATUSES]),
				),
			)
			.returning({ id: investigations.id });
		if (updated.length === 0) return; // already terminal
		await tx
			.update(investigationSteps)
			.set({ status: "cancelled", finishedAt: new Date() })
			.where(
				and(
					eq(investigationSteps.investigationId, row.id),
					inArray(investigationSteps.status, ["pending", "running"]),
				),
			);
		await tx
			.update(patchProposals)
			.set({ status: "rejected", updatedAt: new Date() })
			.where(
				and(
					eq(patchProposals.investigationId, row.id),
					eq(patchProposals.status, "proposed"),
				),
			);
		await tx
			.update(bugReports)
			.set({ status: "open", updatedAt: new Date() })
			.where(
				and(
					eq(bugReports.id, row.bugReportId),
					eq(bugReports.status, "investigating"),
				),
			);
		await audit(tx as unknown as Db, {
			workspaceId: row.workspaceId,
			actor: WORKER_ACTOR,
			action: "investigation.cancelled",
			targetType: "investigation",
			targetId: row.id,
		});
	});
}

/**
 * Worker-restart recovery: a step still `running` well past its stage
 * timeout lost its worker. It is marked `failed` (`worker_lost`, never succeeded) and retried with a
 * new attempt, or the investigation fails after the last attempt. The stale job, if pg-boss later
 * redelivers it, sees the newer attempt and does nothing.
 */
export async function recoverStaleSteps(
	deps: { db: Db; pool: pg.Pool; boss: PgBoss },
	now = Date.now(),
): Promise<number> {
	const running = await deps.db
		.select({ step: investigationSteps })
		.from(investigationSteps)
		.innerJoin(
			investigations,
			eq(investigations.id, investigationSteps.investigationId),
		)
		.where(
			and(
				eq(investigationSteps.status, "running"),
				eq(investigations.status, "running"),
			),
		);
	let recovered = 0;
	for (const { step } of running) {
		if (
			!step.startedAt ||
			now - step.startedAt.getTime() <
				STAGE_TIMEOUT_MS[step.stage] + RECOVERY_GRACE_MS
		)
			continue;
		const done = await withTransaction(deps.pool, async ({ db, queueDb }) => {
			const [current] = await db
				.select()
				.from(investigations)
				.where(eq(investigations.id, step.investigationId))
				.for("update")
				.limit(1);
			const [fresh] = await db
				.select({ status: investigationSteps.status })
				.from(investigationSteps)
				.where(eq(investigationSteps.id, step.id))
				.limit(1);
			if (current?.status !== "running" || fresh?.status !== "running")
				return false;
			const error = {
				code: "worker_lost",
				message: `The ${step.stage} stage stopped without finishing (worker restart or crash)`,
				retryable: true,
			};
			await db
				.update(investigationSteps)
				.set({ status: "failed", finishedAt: new Date(), error })
				.where(eq(investigationSteps.id, step.id));
			if (step.attempt >= MAX_STAGE_ATTEMPTS)
				await failInvestigationTx(db, current, step.stage, error);
			else {
				await db
					.update(investigations)
					.set({
						progress: {
							stage_index: INVESTIGATION_STAGES.indexOf(step.stage) + 1,
							stage_count: STAGE_COUNT,
							message: `Retrying after a worker restart: ${STAGE_MESSAGES[step.stage]}`,
						},
						stateVersion: bumpVersion(),
						updatedAt: new Date(),
					})
					.where(eq(investigations.id, current.id));
				await enqueueStage(deps.boss, queueDb, {
					investigationId: current.id,
					stage: step.stage,
					attempt: step.attempt + 1,
				});
			}
			await audit(db, {
				workspaceId: current.workspaceId,
				actor: WORKER_ACTOR,
				action: "investigation.step_recovered",
				targetType: "investigation",
				targetId: current.id,
				metadata: { stage: step.stage, attempt: step.attempt },
			});
			return true;
		});
		if (done) recovered += 1;
	}
	return recovered;
}

function toView(
	row: InvestigationRow,
	steps: Array<typeof investigationSteps.$inferSelect>,
	extras: ViewExtras,
) {
	const inference = (row.configSnapshot.inference ?? {}) as {
		provider?: string;
		kind?: string;
		escalation_model?: string | null;
	};
	return {
		id: row.id,
		status: row.status,
		state_version: row.stateVersion,
		current_stage: row.currentStage,
		mode: row.mode,
		mode_reason: row.modeReason,
		model_profile: row.modelProfile,
		interactive: row.interactive,
		bug_report_id: row.bugReportId,
		repository_id: row.repositoryId,
		commit_sha: row.commitSha,
		flags: row.flags,
		progress: row.progress,
		steps: steps.map((step) => ({
			stage: step.stage,
			specialists: STAGE_SPECIALISTS[step.stage],
			attempt: step.attempt,
			status: step.status,
			started_at: step.startedAt?.toISOString() ?? null,
			finished_at: step.finishedAt?.toISOString() ?? null,
			summary: step.summary,
			error: step.error ?? null,
		})),
		needs_input: row.needsInput ?? null,
		...extras,
		inference: {
			provider: inference.provider ?? "unknown",
			mock: inference.kind === "mock",
			escalation_available: Boolean(inference.escalation_model),
		},
		failure: row.failure ?? null,
		created_at: row.createdAt.toISOString(),
		started_at: row.startedAt?.toISOString() ?? null,
		finished_at: row.finishedAt?.toISOString() ?? null,
	};
}
