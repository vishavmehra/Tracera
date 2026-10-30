import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { idSchema } from "@tracera/contracts";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import {
	ApiError,
	decidePatch,
	getPatch,
	getPatchDiff,
	getReport,
	getVerification,
} from "./api.ts";
import { StoredImpact } from "./impact.tsx";
import {
	bugReportQuery,
	investigationQueryKey,
	useInvestigation,
} from "./investigations.tsx";
import { PublicationPanel } from "./publication.tsx";
import {
	type Check,
	type Investigation,
	type Patch,
	parseUnavailableImpact,
	type Verification,
	type VerificationEnvironment,
} from "./schemas.ts";
import {
	Breadcrumbs,
	buttonClass,
	Chevron,
	CodeBlock,
	Empty,
	ErrorNotice,
	Facts,
	formatDuration,
	Glyph,
	hintClass,
	humanize,
	InferenceLabel,
	inputClass,
	Limitations,
	Loading,
	labelClass,
	linkClass,
	OutcomeBadge,
	primaryButtonClass,
	QueryView,
	Section,
	Sha,
	StateBadge,
	Status,
	Time,
} from "./ui.tsx";

function Checks({ checks }: { checks: Check[] }) {
	if (checks.length === 0)
		return <p className="text-ink-3 text-sm">No check was recorded.</p>;
	return (
		<ul className="divide-y divide-line border-line border-y text-sm">
			{checks.map((check) => (
				<li key={check.kind} className="py-2">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<StateBadge value={check.status} />
						<span className="font-medium">{humanize(check.kind)}</span>
						{check.command && (
							<code className="break-all text-ink-2 text-xs">
								{check.command}
							</code>
						)}
						<span className="ml-auto flex gap-3 text-ink-3 text-xs tabular-nums">
							{check.exit_code !== null && <span>Exit {check.exit_code}</span>}
							{check.duration_ms !== null && (
								<span>{formatDuration(check.duration_ms)}</span>
							)}
						</span>
					</div>
					{check.reason && (
						<p className="mt-0.5 text-ink-3 text-xs">
							Reason <code className="text-ink-2">{check.reason}</code>
						</p>
					)}
				</li>
			))}
		</ul>
	);
}

function Environment({
	environment,
}: {
	environment: VerificationEnvironment;
}) {
	return (
		<dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
			<dt className="text-ink-3">Executor</dt>
			<dd>{environment.executor}</dd>
			<dt className="text-ink-3">Image</dt>
			<dd className="break-all font-mono">{environment.image ?? "none"}</dd>
			<dt className="text-ink-3">Network</dt>
			<dd>{environment.network}</dd>
			<dt className="text-ink-3">Dependencies</dt>
			<dd className="break-all">
				{environment.dependencies
					? `${environment.dependencies.manager}, lockfile ${environment.dependencies.lockfile_sha256.slice(0, 12)}`
					: (environment.dependencies_blocked ?? "none declared")}
			</dd>
		</dl>
	);
}

/** Environment from the verification route when it has one, else from the latest report. */
function VerificationEnvironmentView({
	verification,
	investigationId,
}: {
	verification: Verification;
	investigationId: string;
}) {
	const report = useQuery({
		queryKey: ["investigations", investigationId, "report"],
		queryFn: () => getReport(investigationId),
		enabled: !verification.environment,
		retry: false,
	});
	if (verification.environment)
		return <Environment environment={verification.environment} />;
	const fromReport = report.data?.verification.environment;
	if (fromReport) return <Environment environment={fromReport} />;
	if (report.isLoading) return <Loading>Loading the environment…</Loading>;
	return (
		<p className="text-ink-3 text-xs">
			The verification environment was not reported.
		</p>
	);
}

function VerificationPanel({ patch }: { patch: Patch }) {
	const verification = useQuery({
		queryKey: ["verifications", patch.verification?.id],
		queryFn: () => getVerification(patch.verification?.id ?? ""),
		enabled: patch.verification !== null,
	});
	if (!patch.verification)
		return (
			<Empty>
				Not verified: no verification run exists for this patch, so it is a
				proposal only.
			</Empty>
		);
	return (
		<QueryView query={verification} what="Verification">
			{(run) => (
				<div className="space-y-5">
					<div className="space-y-1">
						<OutcomeBadge outcome={run.outcome} />
						<p className="text-ink">{run.label}</p>
						<p className="text-ink-3 text-xs">
							Run {run.status}, finished <Time iso={run.finished_at} />
						</p>
					</div>
					{run.outcome_reasons.length > 0 && (
						<div>
							<h3 className="font-medium text-sm">Why not fully verified</h3>
							<ul className="mt-1.5 space-y-1">
								{run.outcome_reasons.map((reason) => (
									<li key={reason} className="flex items-center gap-2">
										<Glyph tone="warn" />
										<code className="break-all text-xs">{reason}</code>
									</li>
								))}
							</ul>
						</div>
					)}
					<div>
						<h3 className="mb-1.5 font-medium text-sm">Checks</h3>
						<Checks checks={run.checks} />
					</div>
					<div>
						<h3 className="mb-1.5 font-medium text-sm">Environment</h3>
						<VerificationEnvironmentView
							verification={run}
							investigationId={patch.investigation_id}
						/>
					</div>
				</div>
			)}
		</QueryView>
	);
}

/** Every outcome reason (unless verified) and every risk code must be acknowledged to approve. */
export const requiredAcknowledgements = (
	patch: Patch,
	verification: Verification,
) => [
	...new Set([
		...(verification.outcome === "verified"
			? []
			: verification.outcome_reasons),
		...patch.risks.map((risk) => risk.code),
	]),
];

type Decision = "approved" | "rejected" | "changes_requested";
const DECISIONS: Array<[Decision, string]> = [
	["approved", "Approve"],
	["changes_requested", "Request changes"],
	["rejected", "Reject"],
];

function ApprovalForm({
	patch,
	verification,
	investigation,
}: {
	patch: Patch;
	verification: Verification;
	investigation: Investigation;
}) {
	const queryClient = useQueryClient();
	const [decision, setDecision] = useState<Decision>("approved");
	const required = requiredAcknowledgements(patch, verification);
	const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(
		new Set(),
	);
	const decide = useMutation({
		mutationFn: (input: { comment?: string }) =>
			decidePatch(patch.id, {
				decision,
				verification_id: verification.id,
				comment: input.comment,
				acknowledged_risks:
					decision === "approved" ? [...acknowledged] : undefined,
			}),
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: ["patches", patch.id] }),
				queryClient.invalidateQueries({
					queryKey: investigationQueryKey(investigation.id),
				}),
			]),
	});
	const missing = required.filter((code) => !acknowledged.has(code));
	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const comment = String(
			new FormData(event.currentTarget).get("comment") ?? "",
		).trim();
		decide.mutate({ comment: comment || undefined });
	};
	const serverMissing =
		decide.error instanceof ApiError &&
		Array.isArray(decide.error.extra.missing)
			? (decide.error.extra.missing as unknown[]).map(String)
			: [];
	return (
		<form onSubmit={onSubmit} className="space-y-5 text-sm">
			<p className="text-ink-2">
				Your decision is recorded with the verification outcome you saw. It does
				not apply, commit, or push anything.
			</p>
			<fieldset>
				<legend className={labelClass}>Decision</legend>
				<div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
					{DECISIONS.map(([value, label]) => (
						<label key={value} className="flex items-center gap-2">
							<input
								type="radio"
								name="decision"
								value={value}
								checked={decision === value}
								onChange={() => setDecision(value)}
								className="size-4 accent-accent"
							/>
							{label}
						</label>
					))}
				</div>
			</fieldset>
			{decision === "approved" && required.length > 0 && (
				<fieldset className="border-warning/60 border-l-2 pl-3">
					<legend className={`${labelClass} float-left w-full`}>
						Acknowledge before approving
					</legend>
					<p className={`${hintClass} clear-left pt-1`}>
						{verification.outcome === "verified"
							? "The patch was verified, but it carries risks."
							: `The outcome is ${verification.outcome}, not verified.`}{" "}
						Approving means accepting each of these.
					</p>
					<div className="mt-2.5 space-y-2">
						{required.map((code) => {
							const risk = patch.risks.find((item) => item.code === code);
							return (
								<label key={code} className="flex items-start gap-2.5">
									<input
										type="checkbox"
										className="mt-0.5 size-4 shrink-0 accent-accent"
										checked={acknowledged.has(code)}
										onChange={(event) => {
											const next = new Set(acknowledged);
											if (event.target.checked) next.add(code);
											else next.delete(code);
											setAcknowledged(next);
										}}
									/>
									<span className="min-w-0">
										<code className="break-all text-xs">{code}</code>
										{risk && (
											<span className="block text-ink-2">{risk.message}</span>
										)}
									</span>
								</label>
							);
						})}
					</div>
				</fieldset>
			)}
			<div>
				<label htmlFor="comment" className={labelClass}>
					Comment{decision === "changes_requested" ? "" : " (optional)"}
				</label>
				<textarea
					id="comment"
					name="comment"
					rows={3}
					maxLength={5000}
					required={decision === "changes_requested"}
					className={inputClass}
				/>
			</div>
			{decide.error && (
				<ErrorNotice
					alert
					title="The decision was not recorded"
					error={decide.error}
				/>
			)}
			{serverMissing.length > 0 && (
				<p className="text-error text-sm">
					Still unacknowledged: {serverMissing.join(", ")}
				</p>
			)}
			<div className="space-y-1.5">
				<button
					type="submit"
					className={`${primaryButtonClass} w-full`}
					disabled={
						decide.isPending || (decision === "approved" && missing.length > 0)
					}
				>
					{decide.isPending
						? "Recording…"
						: decision === "approved"
							? verification.outcome === "verified"
								? "Approve verified patch"
								: "Approve unverified patch"
							: decision === "rejected"
								? "Reject patch"
								: "Request changes"}
				</button>
				{decision === "approved" && missing.length > 0 && (
					<p className="text-center text-ink-3 text-xs">
						{missing.length} item{missing.length === 1 ? "" : "s"} left to
						acknowledge.
					</p>
				)}
			</div>
		</form>
	);
}

function ApprovalSection({
	patch,
	investigation,
}: {
	patch: Patch;
	investigation: Investigation;
}) {
	const verification = useQuery({
		queryKey: ["verifications", patch.verification?.id],
		queryFn: () => getVerification(patch.verification?.id ?? ""),
		enabled: patch.verification !== null,
	});
	if (patch.approval)
		return (
			<div className="space-y-2 text-sm">
				<StateBadge value={patch.approval.decision} size="sm" />
				<p className="text-ink-2">
					Decided <Time iso={patch.approval.decided_at} /> with the outcome{" "}
					<code className="text-xs">{patch.approval.outcome_at_decision}</code>
				</p>
				{patch.approval.comment && (
					<blockquote className="whitespace-pre-wrap border-line-strong border-l-2 pl-3">
						{patch.approval.comment}
					</blockquote>
				)}
				{patch.approval.acknowledged_risks.length > 0 && (
					<p className="text-xs">
						Acknowledged: {patch.approval.acknowledged_risks.join(", ")}
					</p>
				)}
				<p className="text-ink-3 text-xs">
					No files were changed by this decision.
				</p>
			</div>
		);
	if (patch.status !== "proposed")
		return (
			<p className="text-ink-3 text-sm">
				This patch is {humanize(patch.status).toLowerCase()}; no decision can be
				made.
			</p>
		);
	if (investigation.status !== "awaiting_approval")
		return (
			<p className="text-ink-3 text-sm">
				Decisions open when the investigation is awaiting approval (it is{" "}
				{humanize(investigation.status).toLowerCase()}).
			</p>
		);
	if (!patch.verification)
		return (
			<p className="text-ink-3 text-sm">
				A decision needs a completed verification run.
			</p>
		);
	return (
		<QueryView query={verification} what="Verification">
			{(run) => (
				<ApprovalForm
					patch={patch}
					verification={run}
					investigation={investigation}
				/>
			)}
		</QueryView>
	);
}

type DiffLine = {
	kind: "hunk" | "add" | "del" | "context" | "meta";
	text: string;
	old: number | null;
	new: number | null;
};
type DiffFile = { path: string; lines: DiffLine[] };

/**
 * Splits a unified diff into files and numbered lines. Hunk headers carry the line counts, so a
 * removed line that itself starts with "--" is still read as content, never as a file header.
 */
export function parseDiff(diff: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | null = null;
	let oldLine = 0;
	let newLine = 0;
	let oldLeft = 0;
	let newLeft = 0;
	const current = () => {
		if (!file) {
			file = { path: "(diff)", lines: [] };
			files.push(file);
		}
		return file;
	};
	for (const text of diff.replace(/\n$/, "").split("\n")) {
		if (oldLeft > 0 || newLeft > 0) {
			const target = current();
			if (text.startsWith("+")) {
				target.lines.push({ kind: "add", text, old: null, new: newLine++ });
				newLeft--;
			} else if (text.startsWith("-")) {
				target.lines.push({ kind: "del", text, old: oldLine++, new: null });
				oldLeft--;
			} else if (text.startsWith("\\")) {
				target.lines.push({ kind: "meta", text, old: null, new: null });
			} else {
				target.lines.push({
					kind: "context",
					text,
					old: oldLine++,
					new: newLine++,
				});
				oldLeft--;
				newLeft--;
			}
			continue;
		}
		const header = /^diff --git a\/(.+?) b\//.exec(text);
		if (header) {
			file = { path: header[1] ?? "(diff)", lines: [] };
			files.push(file);
			file.lines.push({ kind: "meta", text, old: null, new: null });
			continue;
		}
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
		if (hunk) {
			oldLine = Number(hunk[1]);
			oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			newLine = Number(hunk[3]);
			newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
			current().lines.push({ kind: "hunk", text, old: null, new: null });
			continue;
		}
		const target = current();
		if (text.startsWith("+++ ") && !text.endsWith("/dev/null"))
			target.path = text.slice(4).replace(/^b\//, "");
		target.lines.push({ kind: "meta", text, old: null, new: null });
	}
	return files;
}

const LINE_STYLES: Record<DiffLine["kind"], string> = {
	add: "bg-diff-add text-diff-add-fg",
	del: "bg-diff-del text-diff-del-fg",
	context: "text-ink-2",
	hunk: "",
	meta: "",
};

function DiffFileView({ file }: { file: DiffFile }) {
	const added = file.lines.filter((line) => line.kind === "add").length;
	const removed = file.lines.filter((line) => line.kind === "del").length;
	return (
		<figure className="min-w-0 overflow-hidden rounded border border-line bg-surface">
			<figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-line border-b bg-elevated/50 px-3 py-1.5 text-xs">
				<code className="break-all text-ink">{file.path}</code>
				<span className="flex gap-2 tabular-nums">
					<span className="text-diff-add-fg">+{added}</span>
					<span className="text-diff-del-fg">−{removed}</span>
				</span>
			</figcaption>
			<pre className="max-h-[36rem] overflow-auto text-[12px] leading-[1.65]">
				<code className="block min-w-max py-1">
					{file.lines.map((line, index) =>
						line.kind === "meta" ? null : line.kind === "hunk" ? (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
								key={index}
								className="block bg-ocean/35 px-3 py-0.5 text-link"
							>
								{line.text}
							</span>
						) : (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
								key={index}
								className={`grid grid-cols-[4ch_4ch_1fr] gap-x-3 pr-3 ${LINE_STYLES[line.kind]}`}
							>
								<span
									aria-hidden="true"
									className="select-none text-right text-ink-3/70"
								>
									{line.old ?? ""}
								</span>
								<span
									aria-hidden="true"
									className="select-none text-right text-ink-3/70"
								>
									{line.new ?? ""}
								</span>
								<span>{line.text || " "}</span>
							</span>
						),
					)}
				</code>
			</pre>
		</figure>
	);
}

function Diff({ patchId }: { patchId: string }) {
	const diff = useQuery({
		queryKey: ["patches", patchId, "diff"],
		queryFn: () => getPatchDiff(patchId),
		retry: false,
	});
	if (diff.error instanceof ApiError && diff.error.code === "invalid_state")
		return <p className="text-ink-3 text-sm">{diff.error.message}</p>;
	return (
		<QueryView query={diff} what="Diff">
			{(data) => (
				<div className="space-y-3">
					{parseDiff(data.diff).map((file, index) => (
						<DiffFileView
							// biome-ignore lint/suspicious/noArrayIndexKey: a diff may name a file twice
							key={`${file.path}:${index}`}
							file={file}
						/>
					))}
					<details className="text-sm">
						<summary className="inline-flex cursor-pointer items-center gap-1.5 rounded text-ink-2 hover:text-ink">
							<Chevron />
							Raw diff
						</summary>
						<CodeBlock text={data.diff} className="mt-2" />
					</details>
					<p className="text-ink-3 text-xs">
						Stored diff sha256 <code>{data.diff_sha256.slice(0, 16)}</code>
						{data.truncated && ", truncated at 200,000 characters"}
					</p>
				</div>
			)}
		</QueryView>
	);
}

function ImpactPanel({ impact }: { impact: unknown }) {
	if (impact === null)
		return (
			<p className="text-ink-3 text-sm">
				No impact was computed for this patch.
			</p>
		);
	const unavailable = parseUnavailableImpact(impact);
	if (unavailable.success)
		return (
			<p className="text-ink-3 text-sm">
				Impact unavailable: {unavailable.data.reason}
			</p>
		);
	return <StoredImpact value={impact} />;
}

/** "Investigations / <bug title> / <page>", with the bug title once the cached report loads. */
function InvestigationCrumbs({
	investigationId,
	page,
}: {
	investigationId: string;
	page: string;
}) {
	const investigation = useInvestigation(investigationId);
	const bugId = investigation.data?.bug_report_id;
	const bug = useQuery({
		...bugReportQuery(bugId ?? ""),
		enabled: bugId !== undefined,
	});
	return (
		<Breadcrumbs
			items={[
				{ key: "list", label: "Investigations", to: "/investigations" },
				{
					key: "investigation",
					label: bug.data?.title ?? <code>{investigationId}</code>,
					to: `/investigations/${investigationId}`,
				},
				{ key: "page", label: page },
			]}
		/>
	);
}

export function PatchReviewPage() {
	const { investigationId = "", patchId = "" } = useParams();
	const valid =
		idSchema("inv").safeParse(investigationId).success &&
		idSchema("pat").safeParse(patchId).success;
	const investigation = useInvestigation(investigationId, valid);
	const patch = useQuery({
		queryKey: ["patches", patchId],
		queryFn: () => getPatch(patchId),
		enabled: valid,
	});
	if (!valid) return <p>Not a patch ID.</p>;
	return (
		<QueryView query={patch} what="Patch">
			{(data) => {
				const added = data.files.reduce((sum, file) => sum + file.additions, 0);
				const removed = data.files.reduce(
					(sum, file) => sum + file.deletions,
					0,
				);
				return (
					<>
						<title>{`Patch review · Tracera`}</title>
						<InvestigationCrumbs
							investigationId={investigationId}
							page={`Patch attempt ${data.attempt}`}
						/>
						<header className="mt-3">
							<h1 className="font-semibold text-2xl leading-tight tracking-tight">
								Patch attempt {data.attempt}
							</h1>
							<div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
								<StateBadge value={data.status} size="sm" />
								{data.verification ? (
									<OutcomeBadge
										outcome={data.verification.outcome}
										label={data.verification.label}
									/>
								) : (
									<Status tone="neutral">Not verified</Status>
								)}
							</div>
							<Facts
								className="mt-6 border-line border-y py-4"
								items={[
									["Base commit", <Sha key="base" sha={data.base_commit} />],
									data.hypothesis_handle !== null && [
										"For hypothesis",
										<code key="hypothesis">{data.hypothesis_handle}</code>,
									],
									data.model !== null && [
										"Proposed by",
										<InferenceLabel
											key="model"
											mock={data.model.provider === "mock"}
											detail={`${data.model.provider}/${data.model.model}`}
										/>,
									],
									[
										"Files",
										<span key="files" className="tabular-nums">
											{data.files.length}{" "}
											<span className="text-diff-add-fg">+{added}</span>{" "}
											<span className="text-diff-del-fg">−{removed}</span>
										</span>,
									],
									["Proposed", <Time key="created" iso={data.created_at} />],
								]}
							/>
						</header>

						<div className="mt-8 grid gap-x-12 gap-y-2 lg:grid-cols-[minmax(0,1fr)_21rem]">
							<div className="min-w-0 [&>section:first-child]:mt-0">
								<Section title="Change" id="change-heading">
									<div className="max-w-[68ch] space-y-3 text-sm">
										<p className="font-medium text-[15px] text-ink">
											{data.summary}
										</p>
										<p className="whitespace-pre-wrap text-ink-2 leading-relaxed">
											{data.rationale}
										</p>
										<p>
											<span className="text-ink-3">Expected effect: </span>
											{data.expected_effect}
										</p>
										{data.apply_error && (
											<p className="border-error border-l-2 pl-3 text-error">
												<code>{data.apply_error.code}</code>:{" "}
												{data.apply_error.message}
											</p>
										)}
									</div>
								</Section>

								<Section
									title={`Diff (${data.files.length} ${data.files.length === 1 ? "file" : "files"})`}
									id="diff-heading"
								>
									<ul className="mb-3 space-y-1 text-sm">
										{data.files.map((file) => (
											<li
												key={file.path}
												className="flex flex-wrap items-center gap-x-3"
											>
												<StateBadge value={file.change_type} />
												<code className="break-all text-xs">{file.path}</code>
												<span className="text-ink-3 text-xs tabular-nums">
													+{file.additions} −{file.deletions}
												</span>
											</li>
										))}
									</ul>
									<Diff patchId={data.id} />
								</Section>

								<Section
									title="Static impact of the diff"
									id="patch-impact-heading"
								>
									<ImpactPanel impact={data.impact} />
								</Section>
							</div>

							<div className="min-w-0 lg:border-line lg:border-l lg:pl-8 lg:[&>section:first-child]:mt-0">
								<Section title="Verification" id="verification-heading">
									<VerificationPanel patch={data} />
								</Section>

								<Section title="Risks" id="risks-heading">
									{data.risks.length === 0 ? (
										<p className="text-ink-3 text-sm">
											No risk was recorded for this patch.
										</p>
									) : (
										<ul className="space-y-2 text-sm">
											{data.risks.map((risk) => (
												<li key={risk.code} className="flex gap-2.5">
													<Glyph tone="warn" className="mt-1.5" />
													<span className="min-w-0">
														<code className="break-all text-xs">
															{risk.code}
														</code>
														<span className="block text-ink-2">
															{risk.message}
														</span>
													</span>
												</li>
											))}
										</ul>
									)}
								</Section>

								<Section title="Decision" id="approval-heading">
									<QueryView query={investigation} what="Investigation">
										{(inv) => (
											<ApprovalSection patch={data} investigation={inv} />
										)}
									</QueryView>
								</Section>

								<PublicationPanel patch={data} />
							</div>
						</div>
					</>
				);
			}}
		</QueryView>
	);
}

export function ReportPage() {
	const { investigationId = "" } = useParams();
	const valid = idSchema("inv").safeParse(investigationId).success;
	const report = useQuery({
		queryKey: ["investigations", investigationId, "report"],
		queryFn: () => getReport(investigationId),
		enabled: valid,
		retry: false,
	});
	if (!valid) return <p>Not an investigation ID.</p>;
	const crumbs = (
		<InvestigationCrumbs
			investigationId={investigationId}
			page="Resolution report"
		/>
	);
	if (report.error instanceof ApiError && report.error.status === 404)
		return (
			<>
				{crumbs}
				<h1 className="mt-3 font-semibold text-2xl tracking-tight">
					Resolution report
				</h1>
				<div className="mt-6">
					<Empty>
						No report has been written yet. It is written when the investigation
						finishes its last stage.
					</Empty>
				</div>
			</>
		);
	return (
		<>
			{crumbs}
			<QueryView query={report} what="Report">
				{(data) => (
					<article className="max-w-3xl">
						<title>{`Report · ${data.original_issue.title} · Tracera`}</title>
						<header className="mt-3">
							<p className="text-ink-3 text-sm">Resolution report</p>
							<h1 className="mt-1 break-words font-semibold text-2xl leading-tight tracking-tight">
								{data.original_issue.title}
							</h1>
							<div className="mt-2.5">
								<OutcomeBadge
									outcome={data.verification.outcome}
									label={data.verification.label}
								/>
							</div>
							<div className="mt-6 flex flex-wrap items-end justify-between gap-4 border-line border-y py-4">
								<Facts
									items={[
										["Version", data.version],
										["Written", <Time key="written" iso={data.created_at} />],
										["Assembled by", humanize(data.generated_with.method)],
										[
											"Inference",
											<span
												key="inference"
												className="flex flex-wrap items-center gap-2"
											>
												<InferenceLabel
													mock={data.generated_with.mock}
													detail={
														data.generated_with.models.join(", ") || undefined
													}
												/>
												{data.generated_with.placeholder_provider && (
													<Status tone="warn">Placeholder provider</Status>
												)}
											</span>,
										],
									]}
								/>
								<a
									href={`/api/v1/investigations/${investigationId}/report?format=markdown`}
									className={buttonClass}
								>
									Download Markdown
								</a>
							</div>
						</header>
						<Section title="Reproduction" id="r-repro">
							<div className="space-y-1.5 text-sm">
								<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<StateBadge value={data.reproduction.baseline} size="sm" />
									<span>{data.reproduction.label}</span>
									{data.reproduction.reason && (
										<code className="text-ink-2 text-xs">
											{data.reproduction.reason}
										</code>
									)}
								</p>
								<p className="max-w-[68ch] text-ink-2 leading-relaxed">
									{data.reproduction.summary}
								</p>
							</div>
						</Section>
						<Section title="Root cause" id="r-cause">
							{data.confirmed_findings.length === 0 ? (
								<p className="text-sm">
									No finding was confirmed by verification.
								</p>
							) : (
								<ul className="space-y-4 text-sm">
									{data.confirmed_findings.map((finding) => (
										<li key={finding.handle} className="space-y-1">
											<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
												<Status tone="good">Confirmed</Status>
												<code className="text-ink-3 text-xs">
													{finding.handle}
												</code>
											</p>
											<p className="font-semibold text-[15px]">
												{finding.title}
											</p>
											<p className="max-w-[68ch] whitespace-pre-wrap text-ink-2 leading-relaxed">
												{finding.mechanism}
											</p>
										</li>
									))}
								</ul>
							)}
							{data.unverified_hypotheses.length > 0 && (
								<>
									<h3 className="mt-6 font-semibold text-sm">
										Unverified hypotheses
									</h3>
									<ul className="mt-2 space-y-2 text-sm">
										{data.unverified_hypotheses.map((hypothesis) => (
											<li
												key={hypothesis.handle}
												className="grid gap-x-3 sm:grid-cols-[3.5rem_minmax(0,1fr)]"
											>
												<code className="text-ink-3 text-xs">
													{hypothesis.handle}
												</code>
												<span>
													{hypothesis.title}
													<span className="block text-ink-3 text-xs">
														{hypothesis.label}, {hypothesis.confidence}{" "}
														confidence
													</span>
												</span>
											</li>
										))}
									</ul>
								</>
							)}
						</Section>
						<Section title="Proposed change" id="r-change">
							{data.proposed_change ? (
								<div className="space-y-2 text-sm">
									<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
										<StateBadge value={data.proposed_change.status} />
										<Link
											to={`/investigations/${investigationId}/patches/${data.proposed_change.patch_id}`}
											className={`${linkClass} font-medium`}
										>
											{data.proposed_change.summary}
										</Link>
									</p>
									<ul className="space-y-0.5">
										{data.proposed_change.files.map((file) => (
											<li key={file.path}>
												<code className="break-all text-ink-2 text-xs">
													{file.path}
												</code>
											</li>
										))}
									</ul>
									{data.proposed_change.risks.length > 0 && (
										<ul className="space-y-1 pt-1">
											{data.proposed_change.risks.map((risk) => (
												<li key={risk.code} className="flex gap-2.5">
													<Glyph tone="warn" className="mt-1.5" />
													<span>
														<code className="text-xs">{risk.code}</code>{" "}
														<span className="text-ink-2">{risk.message}</span>
													</span>
												</li>
											))}
										</ul>
									)}
								</div>
							) : (
								<p className="text-sm">No patch was proposed.</p>
							)}
						</Section>
						<Section title="Verification" id="r-verification">
							<div className="space-y-4">
								{data.verification.reasons.length > 0 && (
									<ul className="space-y-1">
										{data.verification.reasons.map((reason) => (
											<li key={reason} className="flex items-center gap-2">
												<Glyph tone="warn" />
												<code className="text-xs">{reason}</code>
											</li>
										))}
									</ul>
								)}
								<Checks checks={data.verification.checks} />
								{data.verification.environment ? (
									<Environment environment={data.verification.environment} />
								) : (
									<p className="text-ink-3 text-xs">
										The verification environment was not recorded.
									</p>
								)}
							</div>
						</Section>
						<Section title="Decisions" id="r-decisions">
							{data.decisions.length === 0 ? (
								<p className="text-sm">No human decision has been recorded.</p>
							) : (
								<ul className="space-y-2 text-sm">
									{data.decisions.map((decision) => (
										<li key={`${decision.at}:${decision.decision}`}>
											<p className="flex flex-wrap items-center gap-x-3">
												<StateBadge value={decision.decision} />
												<span className="text-ink-3 text-xs">
													<Time iso={decision.at} />
												</span>
											</p>
											{decision.comment && (
												<p className="mt-1 border-line-strong border-l-2 pl-3 text-ink-2">
													{decision.comment}
												</p>
											)}
										</li>
									))}
								</ul>
							)}
						</Section>
						<Section title="Next step" id="r-next">
							<p className="max-w-[68ch] text-sm leading-relaxed">
								{data.recommended_next_step}
							</p>
							<Limitations items={data.limitations} />
						</Section>
						<details className="mt-10 text-sm">
							<summary className="inline-flex cursor-pointer items-center gap-1.5 rounded text-ink-2 hover:text-ink">
								<Chevron />
								Original description
							</summary>
							<CodeBlock
								text={data.original_issue.description}
								className="mt-2"
							/>
						</details>
					</article>
				)}
			</QueryView>
		</>
	);
}
