import path from "node:path";
import { type ApprovalRequest, INVESTIGATION_STAGES } from "@tracera/contracts";
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, withTransaction } from "../db/client.ts";
import {
	bugReports,
	hypotheses,
	investigationEvidence,
	investigationSteps,
	investigations,
	modelExecutions,
	patchProposals,
	resolutionReports,
	sandboxRuns,
	verificationRuns,
} from "../db/schema.ts";
import { putBlob } from "../lib/fs.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { enqueueStage } from "../queue.ts";
import { audit } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import { assertTransition, STAGE_MESSAGES } from "./investigations.ts";
import { latestStep, maxPatchAttempts, readBlobText } from "./pipeline.ts";
import { buildResolutionReport, OUTCOME_LABEL, STATE_LABEL } from "./report.ts";

// Read models for findings, reproductions, patches, verification, and reports, plus the human
// approval decision. Every query is scoped to the caller's workspace; foreign IDs are 404.

const MAX_DIFF_BYTES = 200_000;

async function ownInvestigation(db: Db, workspaceId: string, id: string) {
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
	return row;
}

async function ownPatch(db: Db, workspaceId: string, id: string) {
	const [row] = await db
		.select({ patch: patchProposals, investigation: investigations })
		.from(patchProposals)
		.innerJoin(
			investigations,
			eq(investigations.id, patchProposals.investigationId),
		)
		.where(
			and(
				eq(patchProposals.id, id),
				eq(investigations.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row) throw new AppError(404, "not_found", `Patch ${id} was not found`);
	return row;
}

/** Facts, user claims, hypotheses, experiments, and confirmed findings, kept apart. */
export async function getFindings(db: Db, workspaceId: string, id: string) {
	await ownInvestigation(db, workspaceId, id);
	const [evidence, hypothesisRows, executions, hypothesesStep] =
		await Promise.all([
			db
				.select()
				.from(investigationEvidence)
				.where(eq(investigationEvidence.investigationId, id))
				.orderBy(
					asc(investigationEvidence.createdAt),
					asc(investigationEvidence.handle),
				),
			db
				.select()
				.from(hypotheses)
				.where(eq(hypotheses.investigationId, id))
				.orderBy(asc(hypotheses.rank)),
			db
				.select({
					provider: modelExecutions.provider,
					model: modelExecutions.model,
				})
				.from(modelExecutions)
				.where(eq(modelExecutions.investigationId, id)),
			latestStep(db, id, "generate_hypotheses"),
		]);
	const labelOf = (handle: string) =>
		evidence.find((item) => item.handle === handle)?.label ?? null;
	const cite = (citation: {
		handle: string;
		start_line: number | null;
		end_line: number | null;
	}) => ({ ...citation, label: labelOf(citation.handle) });
	const item = (row: (typeof evidence)[number]) => ({
		handle: row.handle,
		kind: row.kind,
		basis: row.basis,
		label: row.label,
		content: row.content,
		locator: row.locator,
		provenance: row.provenance,
	});
	const providers = [...new Set(executions.map((e) => e.provider))];
	return {
		reported_claims: evidence.filter((r) => r.basis === "reported").map(item),
		observed_facts: evidence
			.filter((r) => r.basis === "observed" && r.kind === "repository_fact")
			.map(item),
		code_references: evidence
			.filter((r) => r.kind === "code_excerpt")
			.map(item),
		commits: evidence.filter((r) => r.kind === "commit").map(item),
		experiments: evidence.filter((r) => r.kind === "reproduction").map(item),
		model_observations: evidence
			.filter((r) => r.basis === "inferred")
			.map(item),
		hypotheses: hypothesisRows.map((h) => ({
			id: h.id,
			handle: h.handle,
			rank: h.rank,
			title: h.title,
			state: h.state,
			label: STATE_LABEL[h.state],
			confidence: h.confidence,
			confidence_rationale: h.confidenceRationale,
			score: h.score,
			mechanism: h.mechanism,
			locations: h.locations.map(cite),
			supporting: h.supporting.map(cite),
			contradicting: h.contradicting.map(cite),
			alternatives: h.alternatives,
			next_check: h.nextCheck,
		})),
		confirmed_findings: hypothesisRows
			.filter((h) => h.state === "confirmed")
			.map((h) => ({ id: h.id, handle: h.handle, title: h.title })),
		open_questions:
			(hypothesesStep?.summary.missing_information as unknown[] | undefined) ??
			[],
		insufficient_evidence:
			hypothesesStep?.summary.insufficient_evidence === true
				? {
						reason:
							(hypothesesStep.summary.insufficient_evidence_reason as
								| string
								| null) ?? null,
					}
				: null,
		model_disclosure: {
			providers,
			models: [...new Set(executions.map((e) => e.model))],
			mock: providers.includes("mock"),
		},
	};
}

export async function listReproductions(
	db: Db,
	workspaceId: string,
	id: string,
) {
	await ownInvestigation(db, workspaceId, id);
	const rows = await db
		.select()
		.from(sandboxRuns)
		.where(eq(sandboxRuns.investigationId, id))
		.orderBy(asc(sandboxRuns.startedAt));
	return {
		items: rows.map((row) => ({
			id: row.id,
			purpose: row.purpose,
			patch_id: row.patchId,
			status: row.status,
			exit_code: row.exitCode,
			duration_ms: row.durationMs,
			truncated: row.truncated,
			argv: row.argv,
			image: row.image,
			result: row.result,
			started_at: row.startedAt.toISOString(),
			finished_at: row.finishedAt.toISOString(),
		})),
	};
}

function patchView(
	patch: typeof patchProposals.$inferSelect,
	verification: typeof verificationRuns.$inferSelect | null,
	hypothesisHandle: string | null,
) {
	return {
		id: patch.id,
		investigation_id: patch.investigationId,
		hypothesis_id: patch.hypothesisId,
		hypothesis_handle: hypothesisHandle,
		attempt: patch.attempt,
		status: patch.status,
		origin: "tracera_model" as const,
		base_commit: patch.baseCommit,
		summary: patch.summary,
		rationale: patch.rationale,
		expected_effect: patch.expectedEffect,
		risks: patch.risks,
		files: patch.files,
		diff_sha256: patch.diffSha256,
		apply_error: patch.applyError ?? null,
		// Static impact of the diff, or why it could not be computed.
		impact: patch.impact ?? null,
		verification: verification
			? {
					id: verification.id,
					outcome: verification.outcome,
					label: OUTCOME_LABEL[verification.outcome],
					outcome_reasons: verification.outcomeReasons,
				}
			: null,
		approval: patch.approval ?? null,
		model: patch.model ?? null,
		created_at: patch.createdAt.toISOString(),
	};
}

export async function listPatches(db: Db, workspaceId: string, id: string) {
	await ownInvestigation(db, workspaceId, id);
	const [patches, runs, hyps] = await Promise.all([
		db
			.select()
			.from(patchProposals)
			.where(eq(patchProposals.investigationId, id))
			.orderBy(asc(patchProposals.attempt)),
		db
			.select()
			.from(verificationRuns)
			.where(eq(verificationRuns.investigationId, id)),
		db
			.select({ id: hypotheses.id, handle: hypotheses.handle })
			.from(hypotheses)
			.where(eq(hypotheses.investigationId, id)),
	]);
	return {
		items: patches.map((patch) =>
			patchView(
				patch,
				runs.find((run) => run.patchId === patch.id) ?? null,
				hyps.find((h) => h.id === patch.hypothesisId)?.handle ?? null,
			),
		),
	};
}

export async function getPatch(db: Db, workspaceId: string, id: string) {
	const { patch } = await ownPatch(db, workspaceId, id);
	const [[run], [hypothesis]] = await Promise.all([
		db
			.select()
			.from(verificationRuns)
			.where(eq(verificationRuns.patchId, id))
			.limit(1),
		db
			.select({ handle: hypotheses.handle })
			.from(hypotheses)
			.where(eq(hypotheses.id, patch.hypothesisId))
			.limit(1),
	]);
	return patchView(patch, run ?? null, hypothesis?.handle ?? null);
}

/** The stored, reviewed diff: exactly what verification applied to its fresh copies. */
export async function getPatchDiff(
	db: Db,
	config: Pick<Config, "dataDir">,
	workspaceId: string,
	id: string,
) {
	const { patch } = await ownPatch(db, workspaceId, id);
	if (!patch.diffSha256)
		throw new AppError(
			409,
			"invalid_state",
			"This patch attempt was rejected before a diff was produced",
		);
	const diff = await readBlobText(config, patch.diffSha256);
	if (diff === null)
		throw new AppError(500, "internal_error", "The stored diff is missing");
	return {
		patch_id: patch.id,
		diff_sha256: patch.diffSha256,
		truncated: diff.length > MAX_DIFF_BYTES,
		diff: diff.slice(0, MAX_DIFF_BYTES),
	};
}

export async function getVerification(db: Db, workspaceId: string, id: string) {
	const [row] = await db
		.select({ run: verificationRuns })
		.from(verificationRuns)
		.innerJoin(
			investigations,
			eq(investigations.id, verificationRuns.investigationId),
		)
		.where(
			and(
				eq(verificationRuns.id, id),
				eq(investigations.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(404, "not_found", `Verification ${id} was not found`);
	const run = row.run;
	return {
		id: run.id,
		patch_id: run.patchId,
		investigation_id: run.investigationId,
		status: run.status,
		outcome: run.outcome,
		label: OUTCOME_LABEL[run.outcome],
		outcome_reasons: run.outcomeReasons,
		checks: run.checks,
		// Where the checks ran and with which dependencies; null for runs recorded before 0007.
		environment: run.environment ?? null,
		started_at: run.startedAt.toISOString(),
		finished_at: run.finishedAt.toISOString(),
	};
}

export async function getReport(
	db: Db,
	config: Pick<Config, "dataDir">,
	workspaceId: string,
	id: string,
	format: "json" | "markdown",
) {
	await ownInvestigation(db, workspaceId, id);
	const [report] = await db
		.select()
		.from(resolutionReports)
		.where(eq(resolutionReports.investigationId, id))
		.orderBy(desc(resolutionReports.version))
		.limit(1);
	if (!report)
		throw new AppError(404, "not_found", "No report has been written yet");
	if (format === "markdown")
		return {
			markdown: (await readBlobText(config, report.markdownSha256)) ?? "",
		};
	return {
		report: {
			id: report.id,
			version: report.version,
			created_at: report.createdAt.toISOString(),
			...report.content,
		},
	};
}

/**
 * The human decision on a proposed patch (session only; checked by the route). It records the
 * decision and the outcome the reviewer saw, regenerates the report, and changes no files anywhere.
 */
export async function decidePatch(
	deps: { pool: pg.Pool; db: Db; boss: PgBoss; config: Config },
	ctx: AuthContext,
	patchId: string,
	input: ApprovalRequest,
	requestId: string,
) {
	const { investigation } = await ownPatch(deps.db, ctx.workspaceId, patchId);
	return withTransaction(deps.pool, async ({ db, queueDb }) => {
		const [current] = await db
			.select()
			.from(investigations)
			.where(eq(investigations.id, investigation.id))
			.for("update")
			.limit(1);
		const [patch] = await db
			.select()
			.from(patchProposals)
			.where(eq(patchProposals.id, patchId))
			.limit(1);
		if (!current || !patch)
			throw new AppError(404, "not_found", `Patch ${patchId} was not found`);
		if (patch.status !== "proposed" || current.status !== "awaiting_approval")
			throw new AppError(
				409,
				"invalid_state",
				`The patch is ${patch.status} and the investigation is ${current.status}`,
			);
		const [run] = await db
			.select()
			.from(verificationRuns)
			.where(eq(verificationRuns.patchId, patchId))
			.limit(1);
		if (!run || run.id !== input.verification_id)
			throw new AppError(
				409,
				"stale_verification",
				"verification_id must be the latest verification run for this patch",
			);
		if (input.decision === "approved") {
			const required = [
				...new Set([
					...(run.outcome === "verified" ? [] : run.outcomeReasons),
					...patch.risks.map((risk) => risk.code),
				]),
			];
			const acknowledged = new Set(input.acknowledged_risks ?? []);
			const missing = required.filter((code) => !acknowledged.has(code));
			if (missing.length > 0)
				throw new AppError(
					422,
					"risks_not_acknowledged",
					"Acknowledge every outcome reason and risk before approving",
					{ extra: { required, missing } },
				);
		}
		if (
			input.decision === "changes_requested" &&
			patch.attempt >= maxPatchAttempts(deps.config)
		)
			throw new AppError(
				409,
				"patch_attempts_exhausted",
				"No patch attempts remain for this investigation",
			);
		const approval = {
			decision: input.decision,
			verification_id: run.id,
			outcome_at_decision: run.outcome,
			comment: input.comment ?? null,
			acknowledged_risks: input.acknowledged_risks ?? [],
			decided_by: ctx.userId,
			decided_at: new Date().toISOString(),
		};
		await db
			.update(patchProposals)
			.set({ status: input.decision, approval, updatedAt: new Date() })
			.where(eq(patchProposals.id, patchId));
		const next =
			input.decision === "changes_requested" ? "queued" : "completed";
		assertTransition(current.status, next);
		await db
			.update(investigations)
			.set({
				status: next,
				finishedAt: next === "completed" ? new Date() : null,
				progress: {
					stage_index:
						next === "completed"
							? INVESTIGATION_STAGES.length
							: INVESTIGATION_STAGES.indexOf("generate_patch") + 1,
					stage_count: INVESTIGATION_STAGES.length,
					message:
						next === "completed"
							? `Completed: patch ${input.decision}`
							: `Queued: ${STAGE_MESSAGES.generate_patch} (changes requested)`,
				},
				stateVersion: current.stateVersion + 1,
				updatedAt: new Date(),
			})
			.where(eq(investigations.id, current.id));
		if (next === "completed")
			await db
				.update(bugReports)
				.set({ status: "open", updatedAt: new Date() })
				.where(
					and(
						eq(bugReports.id, current.bugReportId),
						inArray(bugReports.status, ["investigating"]),
					),
				);
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: `patch.${input.decision}`,
			targetType: "patch",
			targetId: patchId,
			metadata: {
				investigation_id: current.id,
				verification_id: run.id,
				outcome_at_decision: run.outcome,
				acknowledged: approval.acknowledged_risks,
			},
			requestId,
		});
		if (next === "queued") {
			const [last] = await db
				.select({ attempt: max(investigationSteps.attempt) })
				.from(investigationSteps)
				.where(
					and(
						eq(investigationSteps.investigationId, current.id),
						eq(investigationSteps.stage, "generate_patch"),
					),
				);
			await enqueueStage(deps.boss, queueDb, {
				investigationId: current.id,
				stage: "generate_patch",
				attempt: (last?.attempt ?? 0) + 1,
			});
		} else {
			const report = await buildResolutionReport(db, current.id);
			const markdown = await putBlob(
				path.join(deps.config.dataDir, "blobs"),
				Buffer.from(report.markdown, "utf8"),
			);
			const [last] = await db
				.select({ version: resolutionReports.version })
				.from(resolutionReports)
				.where(eq(resolutionReports.investigationId, current.id))
				.orderBy(desc(resolutionReports.version))
				.limit(1);
			await db.insert(resolutionReports).values({
				id: newId("rpt"),
				investigationId: current.id,
				version: (last?.version ?? 0) + 1,
				content: report.content,
				markdownSha256: markdown.sha256,
				generatedWith: report.content.generated_with,
			});
		}
		return {
			approval: { patch_id: patchId, ...approval },
			investigation: { id: current.id, status: next },
		};
	});
}
