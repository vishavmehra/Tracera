import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NormalizationOutput } from "@tracera/contracts";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
	bugReports,
	type EnvironmentInfo,
	evidenceAssets,
	type FieldProvenance,
	modelExecutions,
} from "../db/schema.ts";
import {
	createGateway,
	type GatewayDeps,
	InferenceError,
	type ModelExecutionRecord,
} from "../inference/gateway.ts";
import type { ChatProvider } from "../inference/providers.ts";
import {
	buildNormalizationInput,
	normalizeBugReportTask,
} from "../inference/tasks.ts";
import { newId } from "../lib/ids.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import { screenshotEvidenceForNormalization } from "./visual-evidence.ts";

type BugReportRow = typeof bugReports.$inferSelect;
const TEXT_KINDS = ["stack_trace", "log_file", "text_note"] as const;

export async function spentTodayUsd(
	db: Db,
	workspaceId: string,
): Promise<number> {
	const [row] = await db
		.select({
			total: sql<string>`coalesce(sum(${modelExecutions.estimatedCostUsd}), 0)`,
		})
		.from(modelExecutions)
		.where(
			and(
				eq(modelExecutions.workspaceId, workspaceId),
				gte(
					modelExecutions.createdAt,
					sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
				),
			),
		);
	return Number(row?.total ?? 0);
}

/** Per-investigation model budget (call count and estimated cost), checked before every call. */
export async function investigationLimit(
	db: Db,
	investigationId: string,
	inference: Config["inference"],
): Promise<{ code: string; message: string } | null> {
	const [row] = await db
		.select({
			calls: sql<number>`count(*)::int`,
			cost: sql<string>`coalesce(sum(${modelExecutions.estimatedCostUsd}), 0)`,
		})
		.from(modelExecutions)
		.where(
			and(
				eq(modelExecutions.investigationId, investigationId),
				sql`${modelExecutions.status} <> 'budget_exceeded'`,
			),
		);
	if ((row?.calls ?? 0) >= inference.investigationMaxModelCalls)
		return {
			code: "investigation_model_calls_exceeded",
			message: `This investigation reached its limit of ${inference.investigationMaxModelCalls} model calls`,
		};
	if (Number(row?.cost ?? 0) >= inference.investigationBudgetUsd)
		return {
			code: "investigation_budget_exceeded",
			message: `This investigation reached its inference budget of $${inference.investigationBudgetUsd}`,
		};
	return null;
}

/** Gateway bound to one workspace: budget and model-execution rows are scoped to it. */
export function workspaceGateway(
	deps: { db: Db; config: Config; provider: ChatProvider },
	scope: Parameters<typeof workspaceGatewayDeps>[1],
	options: { model?: string } = {},
) {
	return createGateway(workspaceGatewayDeps(deps, scope, options));
}

/** What workspaceGateway is built from, for adapters that are not chat calls (segmentation). */
export function workspaceGatewayDeps(
	deps: { db: Db; config: Config; provider: ChatProvider },
	scope: {
		workspaceId: string;
		bugReportId?: string | null;
		investigationId?: string | null;
		assessmentId?: string | null;
	},
	options: { model?: string } = {},
): GatewayDeps {
	const inference = deps.config.inference;
	const investigationId = scope.investigationId;
	return {
		provider: deps.provider,
		model: options.model ?? inference.taskModels.normalize_bug_report,
		timeoutMs: inference.timeoutMs,
		redactEmails: inference.redactEmails,
		maxConcurrency: inference.maxConcurrency,
		dailyBudgetUsd: inference.dailyBudgetUsd,
		maxImageBytes: inference.maxImageBytes,
		spentTodayUsd: () => spentTodayUsd(deps.db, scope.workspaceId),
		...(investigationId
			? {
					checkLimits: () =>
						investigationLimit(deps.db, investigationId, inference),
				}
			: {}),
		record: async (execution: ModelExecutionRecord) => {
			const id = newId("mex");
			await deps.db.insert(modelExecutions).values({
				id,
				workspaceId: scope.workspaceId,
				bugReportId: scope.bugReportId ?? null,
				investigationId: scope.investigationId ?? null,
				assessmentId: scope.assessmentId ?? null,
				task: execution.task,
				promptVersion: execution.promptVersion,
				provider: execution.provider,
				model: execution.model,
				requestHash: execution.requestHash,
				status: execution.status,
				inputTokens: execution.usage.inputTokens,
				outputTokens: execution.usage.outputTokens,
				reasoningTokens: execution.usage.reasoningTokens,
				cachedTokens: execution.usage.cachedTokens,
				latencyMs: execution.latencyMs,
				estimatedCostUsd: execution.estimatedCostUsd.toFixed(6),
				redactionCount: execution.redactionCount,
				attempts: execution.attempts,
				error: execution.error,
			});
			return id;
		},
	};
}

/**
 * Applies model output without ever overwriting user-provided values.
 * Every filled field is marked ai_inferred with the model's stated basis.
 */
export function mergeNormalization(
	row: BugReportRow,
	output: NormalizationOutput,
	modelExecutionId: string,
) {
	const provenance: Record<string, FieldProvenance> = {
		...row.fieldProvenance,
	};
	const basisOf = (field: string) =>
		output.field_basis.find((entry) => entry.field === field)?.basis ??
		"inferred";
	const mark = (field: string) => {
		provenance[field] = {
			source: "ai_inferred",
			basis: basisOf(field),
			model_execution_id: modelExecutionId,
		};
		filled.push(field);
	};
	const filled: string[] = [];
	const updates: Partial<BugReportRow> = {};

	if (!row.expectedBehavior && output.expected_behavior) {
		updates.expectedBehavior = output.expected_behavior;
		mark("expected_behavior");
	}
	if (!row.actualBehavior && output.actual_behavior) {
		updates.actualBehavior = output.actual_behavior;
		mark("actual_behavior");
	}
	if (row.steps.length === 0 && output.steps.length > 0) {
		updates.steps = output.steps;
		mark("steps");
	}
	const environment: EnvironmentInfo = { ...row.environment };
	for (const key of ["browser", "os", "viewport", "app_version"] as const) {
		const value = output.environment[key];
		if (value && !environment[key]) {
			environment[key] = value;
			mark(`environment.${key}`);
		}
	}
	if (filled.some((field) => field.startsWith("environment.")))
		updates.environment = environment;
	if (
		row.suspectedComponents.length === 0 &&
		output.suspected_components.length > 0
	) {
		updates.suspectedComponents = output.suspected_components.map((label) => ({
			label,
			source: "ai_inferred" as const,
		}));
	}
	updates.unresolvedQuestions = [
		...row.unresolvedQuestions.filter((q) => q.source !== "ai_inferred"),
		...output.unresolved_questions.map((q) => ({
			...q,
			source: "ai_inferred" as const,
		})),
	];
	updates.fieldProvenance = provenance;
	updates.normalizationResult = {
		summary: output.summary,
		suggested_title: output.title,
		severity_suggestion: output.severity_suggestion,
		affected_page: output.affected_page,
		search_terms: output.search_terms,
		ui_element_phrases: output.ui_element_phrases,
		model_execution_id: modelExecutionId,
		prompt_version: normalizeBugReportTask.promptVersion,
	};
	return { updates, filled };
}

export type NormalizationOutcome =
	| { ok: true; modelExecutionId: string; filled: string[] }
	| { ok: false; error: { code: string; message: string; retryable: boolean } };

/** Normalizes one bug report with the configured provider. Failures are recorded, never thrown. */
export async function runNormalization(
	deps: { db: Db; pool: pg.Pool; config: Config; provider: ChatProvider },
	bugReportId: string,
	context: { investigationId?: string | null } = {},
): Promise<NormalizationOutcome> {
	const [row] = await deps.db
		.select()
		.from(bugReports)
		.where(eq(bugReports.id, bugReportId))
		.limit(1);
	if (!row)
		return {
			ok: false,
			error: {
				code: "not_found",
				message: "Bug report not found",
				retryable: false,
			},
		};
	const evidence = await deps.db
		.select()
		.from(evidenceAssets)
		.where(
			and(
				eq(evidenceAssets.bugReportId, bugReportId),
				inArray(evidenceAssets.kind, [...TEXT_KINDS]),
			),
		);
	const blobsDir = path.join(deps.config.dataDir, "blobs", "sha256");
	const texts = await Promise.all(
		evidence.map(async (asset, index) => ({
			handle: `EV-${index + 1}`,
			kind: asset.kind,
			text: await readFile(
				path.join(
					blobsDir,
					asset.blobSha256.slice(0, 2),
					asset.blobSha256.slice(2, 4),
					asset.blobSha256,
				),
				"utf8",
			).catch(() => "[evidence content unavailable]"),
		})),
	);
	const gateway = workspaceGateway(deps, {
		workspaceId: row.workspaceId,
		bugReportId,
		investigationId: context.investigationId,
	});
	try {
		const screenshots = await screenshotEvidenceForNormalization(deps, {
			workspaceId: row.workspaceId,
			bugReportId,
			investigationId: context.investigationId,
		});
		const user = buildNormalizationInput(
			{
				title: row.title,
				description: row.description,
				expectedBehavior: row.expectedBehavior,
				actualBehavior: row.actualBehavior,
				steps: row.steps,
				environment: row.environment,
				affectedUrl: row.affectedUrl,
			},
			[...texts, ...screenshots.evidence],
			screenshots.unread,
		);
		const result = await gateway.run(normalizeBugReportTask, {
			user,
			cacheKey: bugReportId,
		});
		const { updates, filled } = mergeNormalization(
			row,
			result.output,
			result.modelExecutionId,
		);
		await deps.db
			.update(bugReports)
			.set({
				...updates,
				normalizationStatus: "done",
				normalizedAt: new Date(),
				normalizationError: null,
				updatedAt: new Date(),
			})
			.where(eq(bugReports.id, bugReportId));
		await audit(deps.db, {
			workspaceId: row.workspaceId,
			actor: WORKER_ACTOR,
			action: "bug_report.normalized",
			targetType: "bug_report",
			targetId: bugReportId,
			metadata: {
				model_execution_id: result.modelExecutionId,
				provider: gateway.providerName,
				model: gateway.model,
				filled,
			},
		});
		return { ok: true, modelExecutionId: result.modelExecutionId, filled };
	} catch (error) {
		const failure =
			error instanceof InferenceError
				? {
						code: error.code,
						message: error.message,
						retryable: error.retryable,
					}
				: {
						code: "normalization_failed",
						message: "Normalization failed unexpectedly",
						retryable: false,
					};
		await deps.db
			.update(bugReports)
			.set({
				normalizationStatus: "failed",
				normalizationError: { code: failure.code, message: failure.message },
				updatedAt: new Date(),
			})
			.where(eq(bugReports.id, bugReportId));
		await audit(deps.db, {
			workspaceId: row.workspaceId,
			actor: WORKER_ACTOR,
			action: "bug_report.normalization_failed",
			targetType: "bug_report",
			targetId: bugReportId,
			metadata: { code: failure.code },
		});
		if (!(error instanceof InferenceError)) throw error;
		return { ok: false, error: failure };
	}
}
