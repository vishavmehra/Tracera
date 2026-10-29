import type {
	HypothesisState,
	InvestigationStage,
	ReproductionStatus,
	VerificationOutcome,
} from "@tracera/contracts";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
	bugReports,
	type CheckRecord,
	hypotheses,
	investigationEvidence,
	investigationSteps,
	investigations,
	modelExecutions,
	patchProposals,
	repositories,
	type VerificationEnvironment,
	verificationRuns,
} from "../db/schema.ts";
import { deriveVerificationOutcome } from "./verification.ts";

// The resolution report is assembled by code from stored rows. It uses
// the deterministic template only: no model writes prose, so no sentence can claim more than the data.

type StoredImpact = (typeof patchProposals.$inferSelect)["impact"];

/** The report's view of a patch's stored impact: changed code, its tests, and the top findings. */
function impactSummary(
	impact: StoredImpact,
): NonNullable<ResolutionReportContent["proposed_change"]>["impact"] {
	if (!impact) return null;
	if (!impact.available)
		return {
			available: false,
			reason: impact.reason,
			complete: false,
			changed: [],
			findings: [],
			risk: { evidenced: null, plausible: null },
			limitations: [],
		};
	return {
		available: true,
		reason: null,
		complete: impact.complete,
		changed: impact.symbols.map((s) => ({
			name: s.name,
			path: s.path,
			change: s.change,
			tests: s.tests,
		})),
		findings: impact.findings.slice(0, 10).map((f) => ({
			id: f.id,
			target: f.target.name,
			path: f.target.path,
			reason: f.reason,
			severity: f.severity,
			confidence: f.confidence,
		})),
		risk: {
			evidenced: impact.risk.evidenced.severity,
			plausible: impact.risk.plausible.severity,
		},
		limitations: impact.limitations,
	};
}

export const OUTCOME_LABEL: Record<VerificationOutcome, string> = {
	verified: "Fix verified against the original reproduction",
	partially_verified:
		"Checks passed, but the original failure was not confirmed",
	failed: "Verification failed",
	inconclusive: "Verification inconclusive",
	blocked: "Verification could not run",
	not_attempted: "Not verified",
};
export const STATE_LABEL: Record<HypothesisState, string> = {
	proposed: "Possible cause",
	supported: "Evidence-supported hypothesis",
	contradicted: "Hypothesis with conflicting evidence",
	confirmed: "Confirmed by verification",
	rejected: "Ruled out",
};
const BASELINE_LABEL: Record<ReproductionStatus, string> = {
	reproduced: "Reproduced in the sandbox",
	not_reproduced: "Not reproduced",
	inconclusive: "Inconclusive",
	blocked: "Blocked",
	error: "Error",
	not_attempted: "Not attempted",
};

export type ResolutionReportContent = {
	investigation_id: string;
	generated_at: string;
	generated_with: {
		method: "deterministic_template";
		providers: string[];
		models: string[];
		prompt_versions: string[];
		mock: boolean;
		placeholder_provider: boolean;
	};
	original_issue: {
		bug_report_id: string;
		title: string;
		reported_via: string;
		description: string;
		expected_behavior: { value: string; source: string } | null;
		actual_behavior: { value: string; source: string } | null;
	};
	repository: { name: string; commit_sha: string };
	reported_claims: Array<{ handle: string; label: string }>;
	observed_facts: Array<{ handle: string; statement: string }>;
	reproduction: {
		baseline: ReproductionStatus;
		label: string;
		reason: string | null;
		test: {
			path: string;
			sha256: string;
			expected_observation: string | null;
		} | null;
		evidence_handle: string | null;
		summary: string;
	};
	confirmed_findings: Array<{
		handle: string;
		title: string;
		mechanism: string;
		locations: string[];
	}>;
	unverified_hypotheses: Array<{
		handle: string;
		title: string;
		state: HypothesisState;
		label: string;
		confidence: string;
		confidence_rationale: string;
		score: number;
		mechanism: string;
		locations: string[];
		supporting: string[];
		contradicting: string[];
		next_check: string;
		alternatives: string[];
	}>;
	model_observations: Array<{ handle: string; statement: string }>;
	proposed_change: {
		patch_id: string;
		attempt: number;
		status: string;
		hypothesis_handle: string | null;
		files: Array<{
			path: string;
			change_type: string;
			additions: number;
			deletions: number;
		}>;
		summary: string;
		rationale: string;
		expected_effect: string;
		risks: Array<{ code: string; message: string }>;
		diff_sha256: string | null;
		/** Static impact of the diff: changed code, its tests, what it reaches. */
		impact: {
			available: boolean;
			reason: string | null;
			complete: boolean;
			changed: Array<{
				name: string;
				path: string;
				change: string;
				tests: string;
			}>;
			findings: Array<{
				id: string;
				target: string;
				path: string | null;
				reason: string;
				severity: string;
				confidence: string;
			}>;
			risk: { evidenced: string | null; plausible: string | null };
			limitations: string[];
		} | null;
	} | null;
	patch_attempts: Array<{
		attempt: number;
		status: string;
		outcome: VerificationOutcome | null;
		problem: string | null;
	}>;
	verification: {
		verification_id: string | null;
		outcome: VerificationOutcome;
		label: string;
		reasons: string[];
		/** What the checks ran against (null for verifications stored before migration 0007). */
		environment: VerificationEnvironment | null;
		checks: Array<
			Pick<
				CheckRecord,
				| "kind"
				| "status"
				| "reason"
				| "command"
				| "exit_code"
				| "duration_ms"
				| "summary"
			>
		>;
	};
	limitations: string[];
	recommended_next_step: string;
	decisions: Array<{
		decision: string;
		by: string;
		at: string;
		comment: string | null;
	}>;
	usage: {
		model_calls: number;
		input_tokens: number;
		output_tokens: number;
		estimated_cost_usd: number;
	};
};

type StepNote = (
	summary: Record<string, unknown>,
	code: string | null,
) => string | null;
/** One line on what the checks ran against: the sandbox, its network, and the exact dependencies. */
function environmentLines(
	environment: VerificationEnvironment | null,
): string[] {
	if (!environment) return [];
	const short = (value: string) => value.slice(0, 12);
	const dependencies = environment.dependencies
		? `${environment.dependencies.manager} snapshot ${environment.dependencies.snapshot_id} (lockfile ${short(environment.dependencies.lockfile_sha256)}, artifact ${short(environment.dependencies.digest)}), installed without lifecycle scripts from ${environment.dependencies.registry} and mounted read-only`
		: environment.dependencies_blocked
			? `not prepared (${environment.dependencies_blocked}); checks that need them did not run`
			: "none required";
	return [
		"",
		`Environment: ${environment.executor} sandbox${environment.image ? ` (${environment.image})` : ""}, network ${environment.network}; dependencies: ${dependencies}.`,
	];
}

const STAGE_NOTES: Array<[InvestigationStage, StepNote]> = [
	[
		"normalize",
		(_summary, code) =>
			code
				? `Normalization failed (${code}); the investigation used the report fields as submitted.`
				: null,
	],
	[
		"prepare_dependencies",
		(summary, code) => {
			const reason = code ?? summary.reason;
			if (
				!reason ||
				reason === "no_dependencies" ||
				reason === "no_package_json" ||
				reason === "analysis_only_requested"
			)
				return null;
			return `Dependencies were not prepared (${String(reason)})${
				typeof summary.detail === "string" ? `: ${summary.detail}` : ""
			}. Sandbox checks that need them did not run.`;
		},
	],
	[
		"plan_reproduction",
		(summary, code) => {
			if (code) return `No reproduction test was produced (${code}).`;
			if (summary.reason === "reproduction_not_feasible")
				return `The planner judged the bug not reproducible with a Node.js test: ${String(summary.infeasible_reason ?? "")}`.trim();
			if (summary.reason === "analysis_only_requested")
				return "Analysis-only mode: no reproduction or verification ran.";
			return null;
		},
	],
	[
		"generate_hypotheses",
		(summary) => {
			const notes: string[] = [];
			if (summary.insufficient_evidence)
				notes.push(
					`The analysis reported insufficient evidence: ${String(summary.insufficient_evidence_reason ?? "no reason given")}.`,
				);
			if (Number(summary.invalid_citations) > 0)
				notes.push(
					`${summary.invalid_citations} citation(s) to evidence that was never collected were removed.`,
				);
			if (Number(summary.discarded) > 0)
				notes.push(
					`${summary.discarded} hypothesis(es) without valid code locations or supporting evidence were discarded.`,
				);
			return notes.join(" ") || null;
		},
	],
	[
		"rank_hypotheses",
		(summary) =>
			summary.reason === "no_supported_hypothesis"
				? "No hypothesis was supported by observed evidence, so no patch was generated."
				: null,
	],
	[
		"generate_patch",
		(summary, code) => {
			if (summary.reason === "patch_attempts_exhausted")
				return "The patch attempt limit was reached.";
			if (code === "patch_rejected_by_policy" || code === "patch_apply_failed")
				return `A patch attempt was rejected before verification (${code}).`;
			return code ? `Patch generation failed (${code}).` : null;
		},
	],
];

const location = (
	citation: {
		handle: string;
		start_line: number | null;
		end_line: number | null;
	},
	paths: Map<string, string>,
) =>
	`${paths.get(citation.handle) ?? citation.handle}${citation.start_line ? `:${citation.start_line}-${citation.end_line}` : ""} (${citation.handle})`;

export async function buildResolutionReport(
	db: Db,
	investigationId: string,
): Promise<{ content: ResolutionReportContent; markdown: string }> {
	const [row] = await db
		.select()
		.from(investigations)
		.where(eq(investigations.id, investigationId))
		.limit(1);
	if (!row) throw new Error(`Investigation ${investigationId} not found`);
	const byInvestigation = row.id;
	// Sequential on purpose: approval rebuilds the report inside a transaction, on one client.
	const bugRows = await db
		.select()
		.from(bugReports)
		.where(eq(bugReports.id, row.bugReportId))
		.limit(1);
	const repoRows = await db
		.select()
		.from(repositories)
		.where(eq(repositories.id, row.repositoryId))
		.limit(1);
	const steps = await db
		.select()
		.from(investigationSteps)
		.where(eq(investigationSteps.investigationId, byInvestigation))
		.orderBy(asc(investigationSteps.createdAt));
	const evidence = await db
		.select()
		.from(investigationEvidence)
		.where(eq(investigationEvidence.investigationId, byInvestigation))
		.orderBy(
			asc(investigationEvidence.createdAt),
			asc(investigationEvidence.handle),
		);
	const hypothesisRows = await db
		.select()
		.from(hypotheses)
		.where(eq(hypotheses.investigationId, byInvestigation))
		.orderBy(asc(hypotheses.rank));
	const patches = await db
		.select()
		.from(patchProposals)
		.where(eq(patchProposals.investigationId, byInvestigation))
		.orderBy(asc(patchProposals.attempt));
	const runs = await db
		.select()
		.from(verificationRuns)
		.where(eq(verificationRuns.investigationId, byInvestigation));
	const executions = await db
		.select()
		.from(modelExecutions)
		.where(eq(modelExecutions.investigationId, byInvestigation));
	const [bug] = bugRows;
	const [repo] = repoRows;
	if (!bug || !repo) throw new Error("Investigation rows are missing");
	const latest = new Map<InvestigationStage, (typeof steps)[number]>();
	for (const step of steps) {
		const current = latest.get(step.stage);
		if (!current || step.attempt >= current.attempt)
			latest.set(step.stage, step);
	}
	const paths = new Map(
		evidence
			.filter((item) => typeof item.locator.path === "string")
			.map((item) => [item.handle, item.locator.path as string]),
	);
	const labelOf = (handle: string) => {
		const item = evidence.find((entry) => entry.handle === handle);
		return item ? `${handle}: ${item.label}` : handle;
	};

	const baselineStep = latest.get("reproduce_baseline");
	const baseline =
		(baselineStep?.summary.baseline as ReproductionStatus | undefined) ??
		"not_attempted";
	const repro = [...evidence]
		.reverse()
		.find((item) => item.kind === "reproduction");
	const planStep = latest.get("plan_reproduction");
	const reproduction: ResolutionReportContent["reproduction"] = {
		baseline,
		label: BASELINE_LABEL[baseline],
		reason: (baselineStep?.summary.reason as string | null | undefined) ?? null,
		test:
			planStep?.status === "succeeded" &&
			typeof planStep.summary.test_sha256 === "string"
				? {
						path: String(planStep.summary.test_path),
						sha256: planStep.summary.test_sha256,
						expected_observation:
							(planStep.summary.expected_observation as string | undefined) ??
							null,
					}
				: planStep?.status === "succeeded" &&
						planStep.summary.mode === "browser" &&
						typeof planStep.summary.steps_sha256 === "string"
					? {
							// Browser reproduction: validated steps, not a test file.
							path: `browser steps (${String(planStep.summary.step_count)}) against ${String(planStep.summary.start)}`,
							sha256: planStep.summary.steps_sha256,
							expected_observation:
								(planStep.summary.expected_observation as string | undefined) ??
								null,
						}
					: null,
		evidence_handle: repro?.handle ?? null,
		summary:
			repro?.content.split("\n")[0] ??
			(baselineStep?.summary.detail
				? `The baseline reproduction was not run: ${String(baselineStep.summary.detail)}.`
				: "No baseline reproduction ran."),
	};

	const patch =
		[...patches]
			.reverse()
			.find((p) => p.status !== "apply_failed" && p.status !== "superseded") ??
		null;
	const run = patch ? (runs.find((r) => r.patchId === patch.id) ?? null) : null;
	const derived = run
		? { outcome: run.outcome, reasons: run.outcomeReasons }
		: deriveVerificationOutcome(null);
	const providers = [...new Set(executions.map((e) => e.provider))];
	const mock = providers.includes("mock");
	const flags = new Set(row.flags);

	const limitations: string[] = [];
	if (mock)
		limitations.push(
			"Generated with mock inference: no model analysed this report.",
		);
	if (flags.has("placeholder_provider"))
		limitations.push(
			`Inference used a placeholder provider (${providers.join(", ") || "none"}), not the Meta Model API.`,
		);
	const context = latest.get("collect_context");
	for (const note of (context?.summary.limitations as string[] | undefined) ??
		[])
		limitations.push(`Context collection: ${note}`);
	for (const [stage, note] of STAGE_NOTES) {
		const step = latest.get(stage);
		const text = step ? note(step.summary, step.error?.code ?? null) : null;
		if (text) limitations.push(text);
	}
	if (baseline === "not_reproduced")
		limitations.push(
			"The reported behavior was not reproduced at this commit, so a fix cannot be confirmed against it.",
		);
	else if (baseline !== "reproduced" && baselineStep?.summary.detail)
		limitations.push(
			`Baseline reproduction: ${String(baselineStep.summary.detail)}.`,
		);
	if (derived.outcome !== "verified" && patch)
		limitations.push(
			`The proposed change is not verified (${derived.reasons.join(", ") || derived.outcome}).`,
		);
	if (flags.has("injection_suspected"))
		limitations.push(
			"Some report, repository, or test-output text looked like instructions to the AI. It was handled as data and changed no status, but review the evidence carefully.",
		);
	if (flags.has("escalation_unavailable"))
		limitations.push(
			"No escalation model was configured for a further patch attempt.",
		);
	limitations.push(
		"Tracera never modified the registered repository: patches were applied only to temporary copies. Approval changes no files.",
	);

	const missing = (latest.get("generate_hypotheses")?.summary
		.missing_information ?? []) as Array<{ question: string }>;
	const recommended = (() => {
		const reasons = derived.reasons.join(", ");
		if (patch && derived.outcome === "verified")
			return "Review the diff and the evidence, then approve or reject the patch. Approval does not change files; apply the patch yourself after review.";
		if (patch && derived.outcome === "partially_verified")
			return `Review carefully: some checks passed but the original failure was not confirmed (${reasons}).`;
		if (patch && derived.outcome === "failed")
			return `The proposed change did not pass verification (${reasons}). Review the remaining hypotheses or add details to the report.`;
		if (patch)
			return `Verification did not reach a conclusion (${reasons}). Resolve the cause and start a new investigation.`;
		if (baseline === "not_reproduced")
			return "Check the report's steps, data, and version: the described behavior did not occur at this commit.";
		if (hypothesisRows.length === 0)
			return missing.length > 0
				? `Add the missing information to the report: ${missing.map((m) => m.question).join(" ")}`
				: "Tracera could not ground a cause in the collected evidence. Add reproduction steps, logs, or the affected code area to the report.";
		return "Review the hypotheses and their evidence; none was strong enough to patch.";
	})();

	const content: ResolutionReportContent = {
		investigation_id: row.id,
		generated_at: new Date().toISOString(),
		generated_with: {
			method: "deterministic_template",
			providers,
			models: [...new Set(executions.map((e) => e.model))],
			prompt_versions: [...new Set(executions.map((e) => e.promptVersion))],
			mock,
			placeholder_provider: flags.has("placeholder_provider"),
		},
		original_issue: {
			bug_report_id: bug.id,
			title: bug.title,
			reported_via: bug.sourceChannel,
			description: bug.description,
			expected_behavior: bug.expectedBehavior
				? {
						value: bug.expectedBehavior,
						source:
							bug.fieldProvenance.expected_behavior?.source ?? "user_provided",
					}
				: null,
			actual_behavior: bug.actualBehavior
				? {
						value: bug.actualBehavior,
						source:
							bug.fieldProvenance.actual_behavior?.source ?? "user_provided",
					}
				: null,
		},
		repository: { name: repo.name, commit_sha: row.commitSha },
		reported_claims: evidence
			.filter((item) => item.basis === "reported")
			.map((item) => ({ handle: item.handle, label: item.label })),
		observed_facts: evidence
			.filter(
				(item) => item.basis === "observed" && item.kind === "repository_fact",
			)
			.map((item) => ({ handle: item.handle, statement: item.content })),
		reproduction,
		confirmed_findings: hypothesisRows
			.filter((h) => h.state === "confirmed")
			.map((h) => ({
				handle: h.handle,
				title: h.title,
				mechanism: h.mechanism,
				locations: h.locations.map((l) => location(l, paths)),
			})),
		unverified_hypotheses: hypothesisRows
			.filter((h) => h.state !== "confirmed")
			.map((h) => ({
				handle: h.handle,
				title: h.title,
				state: h.state,
				label: STATE_LABEL[h.state],
				confidence: h.confidence,
				confidence_rationale: h.confidenceRationale,
				score: h.score,
				mechanism: h.mechanism,
				locations: h.locations.map((l) => location(l, paths)),
				supporting: h.supporting.map((c) => labelOf(c.handle)),
				contradicting: h.contradicting.map((c) => labelOf(c.handle)),
				next_check: h.nextCheck,
				alternatives: h.alternatives,
			})),
		model_observations: evidence
			.filter((item) => item.basis === "inferred")
			.map((item) => ({ handle: item.handle, statement: item.content })),
		proposed_change: patch
			? {
					patch_id: patch.id,
					attempt: patch.attempt,
					status: patch.status,
					hypothesis_handle:
						hypothesisRows.find((h) => h.id === patch.hypothesisId)?.handle ??
						null,
					files: patch.files,
					summary: patch.summary,
					rationale: patch.rationale,
					expected_effect: patch.expectedEffect,
					risks: patch.risks,
					diff_sha256: patch.diffSha256,
					impact: impactSummary(patch.impact),
				}
			: null,
		patch_attempts: patches.map((p) => {
			const verification = runs.find((r) => r.patchId === p.id);
			return {
				attempt: p.attempt,
				status: p.status,
				outcome: verification?.outcome ?? null,
				problem:
					p.applyError?.code ??
					(verification && verification.outcome !== "verified"
						? verification.outcomeReasons.join(", ")
						: null),
			};
		}),
		verification: {
			verification_id: run?.id ?? null,
			outcome: derived.outcome,
			label: OUTCOME_LABEL[derived.outcome],
			reasons: derived.reasons,
			environment: run?.environment ?? null,
			checks: (run?.checks ?? []).map(
				({
					kind,
					status,
					reason,
					command,
					exit_code,
					duration_ms,
					summary,
				}) => ({
					kind,
					status,
					reason,
					command,
					exit_code,
					duration_ms,
					summary,
				}),
			),
		},
		limitations,
		recommended_next_step: recommended,
		decisions: patches.flatMap((p) =>
			p.approval
				? [
						{
							decision: p.approval.decision,
							by: p.approval.decided_by,
							at: p.approval.decided_at,
							comment: p.approval.comment,
						},
					]
				: [],
		),
		usage: {
			model_calls: executions.length,
			input_tokens: executions.reduce((sum, e) => sum + e.inputTokens, 0),
			output_tokens: executions.reduce((sum, e) => sum + e.outputTokens, 0),
			estimated_cost_usd:
				Math.round(
					executions.reduce((sum, e) => sum + Number(e.estimatedCostUsd), 0) *
						1_000_000,
				) / 1_000_000,
		},
	};
	return { content, markdown: renderMarkdown(content) };
}

export function renderMarkdown(report: ResolutionReportContent): string {
	const list = (items: string[]) =>
		items.length > 0 ? items.map((item) => `- ${item}`) : ["- None"];
	const change = report.proposed_change;
	return [
		...(report.generated_with.mock
			? [
					"> **Generated with mock inference.** No model analysed this report.",
					"",
				]
			: []),
		`# Resolution report: ${report.original_issue.title}`,
		"",
		`Investigation \`${report.investigation_id}\` · repository \`${report.repository.name}\` at \`${report.repository.commit_sha.slice(0, 12)}\` · generated ${report.generated_at}`,
		"",
		`**Verification:** ${report.verification.label}${report.verification.reasons.length > 0 ? ` (${report.verification.reasons.join(", ")})` : ""}`,
		`**Baseline reproduction:** ${report.reproduction.label}`,
		"",
		"## Original issue (as reported)",
		"",
		report.original_issue.description,
		...(report.original_issue.expected_behavior
			? [
					`- Expected (${report.original_issue.expected_behavior.source}): ${report.original_issue.expected_behavior.value}`,
				]
			: []),
		...(report.original_issue.actual_behavior
			? [
					`- Actual (${report.original_issue.actual_behavior.source}): ${report.original_issue.actual_behavior.value}`,
				]
			: []),
		"",
		"## Reproduction",
		"",
		report.reproduction.summary,
		...(report.reproduction.test
			? [
					`- Test: \`${report.reproduction.test.path}\` (sha256 ${report.reproduction.test.sha256.slice(0, 12)})`,
				]
			: []),
		"",
		"## Confirmed findings",
		"",
		...list(
			report.confirmed_findings.map(
				(f) =>
					`**${f.title}** (${f.handle}): ${f.mechanism} — ${f.locations.join(", ")}`,
			),
		),
		"",
		"## Unverified hypotheses",
		"",
		...list(
			report.unverified_hypotheses.map(
				(h) =>
					`${h.label}: **${h.title}** (${h.handle}, confidence ${h.confidence}, ranking score ${h.score}) — ${h.locations.join(", ")}. Next check: ${h.next_check}`,
			),
		),
		"",
		"## Observed facts",
		"",
		...list(report.observed_facts.map((f) => `${f.handle}: ${f.statement}`)),
		"",
		"## Proposed change",
		"",
		...(change
			? [
					`Patch \`${change.patch_id}\` (attempt ${change.attempt}, ${change.status}) for ${change.hypothesis_handle ?? "a hypothesis"}: ${change.summary}`,
					...change.files.map(
						(f) =>
							`- \`${f.path}\` (${f.change_type}, +${f.additions}/-${f.deletions})`,
					),
					...change.risks.map((r) => `- Risk (${r.code}): ${r.message}`),
					...(change.impact
						? [
								"",
								"### Changed code and its tests (static analysis)",
								"",
								...(change.impact.available
									? [
											...change.impact.changed.map(
												(c) =>
													`- ${c.name} (\`${c.path}\`): ${c.change.replace(/_/g, " ")}; tests: ${c.tests.replace(/_/g, " ")}`,
											),
											...change.impact.findings.map(
												(f) =>
													`- Reaches ${f.target}${f.path ? ` (\`${f.path}\`)` : ""}: ${f.reason} (${f.severity} severity, ${f.confidence} confidence)`,
											),
											`- Risk: evidenced ${change.impact.risk.evidenced ?? "none"}, plausible ${change.impact.risk.plausible ?? "none"}${change.impact.complete ? "" : " (partial analysis)"}`,
											'- "None identified" means no test case reaches the code through static links; it is not proof that the code is untested.',
										]
									: [`- Not available: ${change.impact.reason}`]),
							]
						: []),
				]
			: ["- No patch was proposed."]),
		"",
		"## Verification checks",
		"",
		...list(
			report.verification.checks.map((c) => {
				const linked = c.summary.graph_linked_tests as
					| {
							linked: number;
							passed: string[];
							failed: string[];
							not_reported: string[];
					  }
					| undefined;
				return `${c.kind}: ${c.status}${c.reason ? ` (${c.reason})` : ""}${c.command ? ` — \`${c.command}\`` : ""}${
					linked
						? `; of ${linked.linked} test(s) the static graph links to the investigated code: ${linked.passed.length} passed, ${linked.failed.length} failed, ${linked.not_reported.length} not reported (informational)`
						: ""
				}`;
			}),
		),
		...environmentLines(report.verification.environment),
		"",
		"## Limitations",
		"",
		...list(report.limitations),
		"",
		"## Recommended next step",
		"",
		report.recommended_next_step,
		"",
		"## Decisions",
		"",
		...list(
			report.decisions.map(
				(d) =>
					`${d.decision} by ${d.by} at ${d.at}${d.comment ? `: ${d.comment}` : ""}`,
			),
		),
		"",
		`Model usage: ${report.usage.model_calls} call(s), ${report.usage.input_tokens} input and ${report.usage.output_tokens} output tokens, estimated $${report.usage.estimated_cost_usd} (${report.generated_with.models.join(", ") || "no model"}).`,
		"",
	].join("\n");
}
