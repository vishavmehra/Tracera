import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	INVESTIGATION_STAGES,
	type InvestigationStage,
	type InvestigationStatus,
	idSchema,
	SeveritySchema,
	type StepStatus,
} from "@tracera/contracts";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
	ApiError,
	cancelInvestigation,
	createBugReport,
	createInvestigation,
	getBugReport,
	getFindings,
	getInvestigation,
	getRepository,
	listInvestigations,
	listPatches,
	listRepositories,
	listReproductions,
	retryInvestigation,
} from "./api.ts";
import { POLL_MS } from "./hooks.ts";
import type { Findings, Investigation } from "./schemas.ts";
import {
	BASIS_TONES,
	Breadcrumbs,
	buttonClass,
	Chevron,
	CodeBlock,
	Empty,
	ErrorNotice,
	elapsed,
	Facts,
	formatDuration,
	Glyph,
	hintClass,
	humanize,
	InferenceLabel,
	inputClass,
	labelClass,
	linkClass,
	location,
	OutcomeBadge,
	primaryButtonClass,
	QueryView,
	quietButtonClass,
	Section,
	Sha,
	StateBadge,
	Status,
	Time,
	type Tone,
} from "./ui.tsx";
import {
	ScreenshotEvidence,
	ScreenshotField,
	uploadScreenshot,
} from "./visual-evidence.tsx";

/** Statuses where the worker is still moving the investigation forward by itself. */
const WORKING: ReadonlySet<InvestigationStatus> = new Set([
	"queued",
	"running",
]);
const TERMINAL: ReadonlySet<InvestigationStatus> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

export const investigationQueryKey = (id: string) => ["investigations", id];

/** Polls while the worker is active; human-wait states (needs_input, awaiting_approval) do not poll. */
export function useInvestigation(id: string, enabled = true) {
	return useQuery({
		queryKey: investigationQueryKey(id),
		queryFn: () => getInvestigation(id),
		enabled,
		refetchInterval: (query) =>
			query.state.data && WORKING.has(query.state.data.status)
				? POLL_MS
				: false,
	});
}

export const bugReportQuery = (id: string) => ({
	queryKey: ["bug-reports", id],
	queryFn: () => getBugReport(id),
});

/**
 * The stored progress message without repeating the status word beside it: "Completed" is dropped,
 * and "Completed: patch rejected" next to a Completed status reads "Patch rejected".
 */
function progressMessage(investigation: Investigation) {
	const status = humanize(investigation.status).toLowerCase();
	const message = investigation.progress.message;
	if (message.toLowerCase() === status) return null;
	return message.toLowerCase().startsWith(`${status}: `)
		? humanize(message.slice(status.length + 2))
		: message;
}

// ---- Investigation list ------------------------------------------------------------------------

export function InvestigationsPage() {
	const investigations = useQuery({
		queryKey: ["investigations"],
		queryFn: listInvestigations,
		refetchInterval: (query) =>
			query.state.data?.items.some((item) => WORKING.has(item.status))
				? POLL_MS
				: false,
	});
	return (
		<>
			<title>Investigations · Tracera</title>
			<div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-line border-b pb-5">
				<div className="max-w-2xl">
					<h1 className="font-semibold text-2xl tracking-tight">
						Investigations
					</h1>
					<p className="mt-1.5 text-ink-2 text-sm">
						Bug reports traced through the code graph and the sandbox to a patch
						you decide on. Statuses and outcomes are the stored values.
					</p>
				</div>
				<Link to="/investigations/new" className={primaryButtonClass}>
					New investigation
				</Link>
			</div>
			<div className="mt-6">
				<QueryView query={investigations} what="Investigations">
					{(data) =>
						data.items.length === 0 ? (
							<Empty>
								No investigations yet.{" "}
								<Link to="/investigations/new" className={linkClass}>
									Start one from a bug report
								</Link>
								.
							</Empty>
						) : (
							<ul className="divide-y divide-line border-line border-y">
								{data.items.map((item) => (
									<InvestigationRow key={item.id} item={item} />
								))}
							</ul>
						)
					}
				</QueryView>
			</div>
		</>
	);
}

/** List items carry no bug title, so each row reads its bug report (cached for the detail page). */
function InvestigationRow({ item }: { item: Investigation }) {
	const bug = useQuery(bugReportQuery(item.bug_report_id));
	const message = progressMessage(item);
	return (
		<li className="grid gap-x-6 gap-y-1.5 py-4 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
			<div className="sm:pt-0.5">
				<StateBadge value={item.status} />
			</div>
			<div className="min-w-0">
				<Link
					to={`/investigations/${item.id}`}
					className="break-words font-medium text-ink underline-offset-2 hover:text-link hover:underline"
				>
					{bug.data?.title ?? <code className="text-sm">{item.id}</code>}
				</Link>
				{message && <p className="mt-1 text-ink-2 text-sm">{message}</p>}
				<p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-ink-3 text-xs">
					<code>{item.id}</code>
					<span>
						Commit <Sha sha={item.commit_sha} />
					</span>
					{item.mode === "analysis_only" && <span>Analysis only</span>}
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-3 text-ink-3 text-xs sm:flex-col sm:items-end sm:gap-1.5">
				<Time iso={item.created_at} />
				<InferenceLabel mock={item.inference.mock} />
			</div>
		</li>
	);
}

// ---- New investigation -------------------------------------------------------------------------

/** Creates the bug report, then the investigation; a failure in the second step keeps the report. */
export function NewInvestigationPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const repositories = useQuery({
		queryKey: ["repositories"],
		queryFn: listRepositories,
	});
	const [bugReportId, setBugReportId] = useState<string | null>(null);
	const [screenshotError, setScreenshotError] = useState<unknown>(null);
	const [options, setOptions] = useState<{
		repository_id: string;
		mode: "full" | "analysis_only";
	} | null>(null);
	const investigate = useMutation({
		mutationFn: (input: {
			bug_report_id: string;
			repository_id: string;
			mode: "full" | "analysis_only";
		}) => createInvestigation(input),
		onSuccess: async ({ investigation }) => {
			await queryClient.invalidateQueries({ queryKey: ["investigations"] });
			navigate(`/investigations/${investigation.id}`);
		},
	});
	const report = useMutation({ mutationFn: createBugReport });
	const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		// Read before the first await: the event's currentTarget is gone afterwards.
		const picked = event.currentTarget.elements.namedItem("screenshot");
		const screenshot =
			picked instanceof HTMLInputElement ? picked.files?.[0] : undefined;
		const text = (name: string) => String(form.get(name) ?? "").trim();
		const optional = (name: string) => text(name) || undefined;
		const chosen = {
			repository_id: text("repository_id"),
			mode:
				text("mode") === "analysis_only"
					? ("analysis_only" as const)
					: ("full" as const),
		};
		setOptions(chosen);
		const steps = text("steps")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const trace = text("trace");
		const severity = SeveritySchema.safeParse(text("severity"));
		const created = await report
			.mutateAsync({
				title: text("title"),
				description: text("description"),
				expected_behavior: optional("expected"),
				actual_behavior: optional("actual"),
				steps: steps.length > 0 ? steps : undefined,
				severity: severity.success ? severity.data : undefined,
				repository_id: chosen.repository_id,
				logs: trace ? [{ kind: "stack_trace", content: trace }] : undefined,
			})
			.catch(() => null);
		if (!created) return;
		setBugReportId(created.bug_report.id);
		if (screenshot && screenshot.size > 0)
			try {
				await uploadScreenshot(created.bug_report.id, screenshot);
			} catch (error) {
				setScreenshotError(error);
				return;
			}
		investigate.mutate({ bug_report_id: created.bug_report.id, ...chosen });
	};
	const active =
		investigate.error instanceof ApiError &&
		investigate.error.code === "investigation_active" &&
		typeof investigate.error.extra.investigation_id === "string"
			? investigate.error.extra.investigation_id
			: null;
	const field = (
		id: string,
		label: string,
		control: ReactNode,
		hint?: string,
	) => (
		<div>
			<label htmlFor={id} className={labelClass}>
				{label}
			</label>
			{control}
			{hint && <p className={hintClass}>{hint}</p>}
		</div>
	);
	return (
		<>
			<title>New investigation · Tracera</title>
			<Breadcrumbs
				items={[
					{ key: "list", label: "Investigations", to: "/investigations" },
					{ key: "new", label: "New investigation" },
				]}
			/>
			<h1 className="mt-3 font-semibold text-2xl tracking-tight">
				New investigation
			</h1>
			<p className="mt-1.5 max-w-2xl text-ink-2 text-sm">
				Describe the bug. Tracera stores it as a bug report and investigates it
				against the repository's indexed code: evidence, hypotheses, a sandboxed
				reproduction, and a proposed patch when the evidence allows.
			</p>
			<QueryView query={repositories} what="Repositories">
				{(data) =>
					data.items.length === 0 ? (
						<div className="mt-8">
							<Empty>
								An investigation needs a repository.{" "}
								<Link to="/" className={linkClass}>
									Register one first
								</Link>
								.
							</Empty>
						</div>
					) : (
						<form
							onSubmit={onSubmit}
							className="mt-8 grid max-w-5xl gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_17rem]"
						>
							<fieldset className="min-w-0 space-y-5">
								<legend className="mb-1 font-semibold text-base">
									The bug
								</legend>
								{field(
									"title",
									"Title",
									<input
										id="title"
										name="title"
										required
										maxLength={200}
										className={inputClass}
									/>,
								)}
								{field(
									"description",
									"What happened",
									<textarea
										id="description"
										name="description"
										required
										maxLength={20_000}
										rows={4}
										className={inputClass}
									/>,
									"Put code in backticks to keep it as code, for example `total(items)`.",
								)}
								<div className="grid gap-5 sm:grid-cols-2">
									{field(
										"expected",
										"Expected behavior (optional)",
										<textarea
											id="expected"
											name="expected"
											maxLength={5000}
											rows={2}
											className={inputClass}
										/>,
									)}
									{field(
										"actual",
										"Actual behavior (optional)",
										<textarea
											id="actual"
											name="actual"
											maxLength={5000}
											rows={2}
											className={inputClass}
										/>,
									)}
								</div>
								{field(
									"steps",
									"Steps to reproduce (optional)",
									<textarea
										id="steps"
										name="steps"
										rows={3}
										className={inputClass}
									/>,
									"One step per line.",
								)}
								{field(
									"trace",
									"Stack trace or log (optional)",
									<textarea
										id="trace"
										name="trace"
										rows={4}
										maxLength={200_000}
										className={`${inputClass} font-mono text-xs sm:text-xs`}
									/>,
									"Redacted on the server before any model sees it.",
								)}
								<ScreenshotField />
							</fieldset>
							<fieldset className="min-w-0 space-y-5 lg:border-line lg:border-l lg:pl-8">
								<legend className="mb-1 font-semibold text-base">
									Where to look
								</legend>
								{field(
									"repository_id",
									"Repository",
									<select
										id="repository_id"
										name="repository_id"
										required
										className={inputClass}
									>
										{data.items.map((repo) => (
											<option key={repo.id} value={repo.id}>
												{repo.name}
											</option>
										))}
									</select>,
								)}
								{field(
									"mode",
									"Mode",
									<select
										id="mode"
										name="mode"
										defaultValue="full"
										className={inputClass}
									>
										<option value="full">
											Full (sandboxed reproduction and verification)
										</option>
										<option value="analysis_only">
											Analysis only (no sandbox)
										</option>
									</select>,
									"Without a sandbox the server runs analysis only and says so.",
								)}
								{field(
									"severity",
									"Severity",
									<select
										id="severity"
										name="severity"
										defaultValue="unknown"
										className={inputClass}
									>
										{SeveritySchema.options.map((value) => (
											<option key={value} value={value}>
												{humanize(value)}
											</option>
										))}
									</select>,
								)}
								{report.error && (
									<ErrorNotice
										alert
										title="The bug report could not be created"
										error={report.error}
									/>
								)}
								{screenshotError !== null && (
									<div className="space-y-2">
										<ErrorNotice
											alert
											title="The bug report was saved, but its screenshot could not be attached"
											error={screenshotError}
										/>
										{bugReportId && options && (
											<button
												type="button"
												className={buttonClass}
												disabled={investigate.isPending}
												onClick={() => {
													setScreenshotError(null);
													investigate.mutate({
														bug_report_id: bugReportId,
														...options,
													});
												}}
											>
												Start the investigation without the screenshot
											</button>
										)}
									</div>
								)}
								{investigate.error && (
									<div className="space-y-2">
										<ErrorNotice
											alert
											title="The bug report was saved, but the investigation could not start"
											error={investigate.error}
										/>
										{active && (
											<Link
												to={`/investigations/${active}`}
												className={linkClass}
											>
												Open the active investigation
											</Link>
										)}
										{bugReportId && options && !active && (
											<button
												type="button"
												className={buttonClass}
												disabled={investigate.isPending}
												onClick={() =>
													investigate.mutate({
														bug_report_id: bugReportId,
														...options,
													})
												}
											>
												Try starting the investigation again
											</button>
										)}
									</div>
								)}
								<button
									type="submit"
									className={`${primaryButtonClass} w-full`}
									disabled={
										report.isPending ||
										investigate.isPending ||
										bugReportId !== null
									}
								>
									{report.isPending
										? "Saving the report…"
										: investigate.isPending
											? "Starting…"
											: "Start investigation"}
								</button>
							</fieldset>
						</form>
					)
				}
			</QueryView>
		</>
	);
}

// ---- Investigation detail ----------------------------------------------------------------------

type Step = Investigation["steps"][number];

const STEP_TONES: Record<StepStatus, Tone> = {
	pending: "neutral",
	running: "progress",
	succeeded: "done",
	failed: "bad",
	skipped: "neutral",
	blocked: "warn",
	cancelled: "neutral",
};

const STEP_TEXT: Record<Tone, string> = {
	neutral: "text-ink-3",
	done: "text-ink-2",
	info: "text-info",
	progress: "text-info",
	good: "text-success",
	warn: "text-warning",
	bad: "text-error",
	uncertain: "text-uncertain",
	decision: "text-accent",
};

/** A stage's node on the rail: its shape says what happened, independent of color. */
function StageNode({
	status,
	current,
}: {
	status: StepStatus | null;
	current: boolean;
}) {
	const shape =
		status === null
			? "size-1.5 rounded-full bg-line-strong"
			: status === "succeeded"
				? "size-2.5 rounded-full bg-trace-done"
				: status === "running"
					? "size-2.5 rounded-full border-2 border-info bg-canvas motion-safe:animate-live"
					: status === "failed"
						? "size-2.5 rounded-[2px] bg-error"
						: status === "blocked"
							? "size-3 bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]"
							: status === "skipped"
								? "size-2.5 rounded-full border-[1.5px] border-ink-3 border-dashed bg-canvas"
								: "size-2.5 rounded-full border-[1.5px] border-ink-3 bg-canvas";
	return (
		<span
			aria-hidden="true"
			className="relative grid size-4 shrink-0 place-items-center"
		>
			<span
				className={`${shape} ring-[3px] ring-canvas ${current ? "outline-2 outline-accent outline-offset-[3px]" : ""}`}
			/>
		</span>
	);
}

function stepsByStage(steps: Step[]) {
	const byStage = new Map<InvestigationStage, Step[]>();
	for (const step of steps) {
		const list = byStage.get(step.stage) ?? [];
		list.push(step);
		byStage.set(step.stage, list);
	}
	for (const list of byStage.values())
		list.sort((a, b) => a.attempt - b.attempt);
	return byStage;
}

function StageTiming({ step }: { step: Step }) {
	const ms = elapsed(step.started_at, step.finished_at);
	return (
		<>
			{step.started_at ? (
				<>
					Started <Time iso={step.started_at} precise />
				</>
			) : (
				"Not started"
			)}
			{step.finished_at && (
				<>
					, finished <Time iso={step.finished_at} precise />
				</>
			)}
			{ms !== null && ` (${formatDuration(ms)})`}
		</>
	);
}

function StageRow({
	stage,
	steps,
	current,
}: {
	stage: InvestigationStage;
	steps: Step[];
	current: boolean;
}) {
	const latest = steps.at(-1);
	if (!latest)
		return (
			<li className="flex items-center gap-3 py-1.5 text-ink-3 text-sm">
				<StageNode status={null} current={false} />
				<span className="min-w-0 flex-1">{humanize(stage)}</span>
				<span className="text-xs">No record</span>
			</li>
		);
	const tone = STEP_TONES[latest.status];
	const ms = elapsed(latest.started_at, latest.finished_at);
	const roles = latest.specialists ?? [];
	return (
		<li aria-current={current ? "step" : undefined}>
			<details>
				<summary className="-mx-1.5 flex cursor-pointer items-start gap-3 rounded px-1.5 py-1.5 text-sm hover:bg-interactive/30">
					<span className="mt-0.5">
						<StageNode status={latest.status} current={current} />
					</span>
					<span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
						<span className={current ? "font-semibold text-ink" : "text-ink"}>
							{humanize(stage)}
						</span>
						{latest.status === "succeeded" ? (
							<span className="sr-only">Succeeded</span>
						) : (
							<span className={`font-medium text-xs ${STEP_TEXT[tone]}`}>
								{humanize(latest.status)}
							</span>
						)}
					</span>
					{ms !== null && (
						<span className="pt-px text-ink-3 text-xs tabular-nums">
							{formatDuration(ms)}
						</span>
					)}
					<Chevron className="mt-1" />
				</summary>
				<div className="space-y-1 pt-0.5 pb-2 pl-7 text-ink-3 text-xs">
					<p>
						<StageTiming step={latest} />
					</p>
					{roles.length > 0 && (
						<p>
							Roles:{" "}
							<span className="text-ink-2">
								{roles.map((role) => humanize(role)).join(", ")}
							</span>
						</p>
					)}
					{steps.length > 1 && (
						<ol className="space-y-0.5">
							{steps.map((step) => (
								<li key={step.attempt}>
									Attempt {step.attempt}: {humanize(step.status)}
									{step.error && (
										<>
											{" "}
											(<code>{step.error.code}</code>)
										</>
									)}
								</li>
							))}
						</ol>
					)}
				</div>
			</details>
			{latest.error && (
				<p className="break-words pb-1.5 pl-7 text-error text-xs">
					<code>{latest.error.code}</code>: {latest.error.message}
				</p>
			)}
		</li>
	);
}

/**
 * Where the trace ends now, drawn like the brand mark's end node: a filled orchid node once the
 * investigation completed, the human-wait or failure shape otherwise, and an open node while running.
 */
function OutcomeNode({ status }: { status: InvestigationStatus }) {
	const shape =
		status === "completed"
			? "size-3 rounded-full bg-accent"
			: status === "failed"
				? "size-2.5 rounded-[2px] bg-error"
				: status === "awaiting_approval"
					? "size-2.5 rotate-45 bg-accent"
					: status === "needs_input"
						? "size-3 bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]"
						: status === "cancelled"
							? "size-2.5 rounded-full border-[1.5px] border-ink-3 bg-canvas"
							: "size-2.5 rounded-full border-[1.5px] border-info border-dashed bg-canvas";
	return (
		<span
			aria-hidden="true"
			className="grid size-4 shrink-0 place-items-center"
		>
			<span className={`${shape} ring-[3px] ring-canvas`} />
		</span>
	);
}

/** Every canonical stage in order, with what the server stored for it; nothing is inferred. */
function Workflow({ investigation }: { investigation: Investigation }) {
	const byStage = stepsByStage(investigation.steps);
	const live = !TERMINAL.has(investigation.status);
	const working = WORKING.has(investigation.status);
	const message = progressMessage(investigation);
	return (
		<section aria-labelledby="workflow-heading">
			<div className="flex items-baseline justify-between gap-3">
				<h2 id="workflow-heading" className="font-semibold text-sm">
					Workflow
				</h2>
				<p className="text-ink-3 text-xs tabular-nums">
					{byStage.size} of {INVESTIGATION_STAGES.length} stages recorded
				</p>
			</div>
			<ol className="relative mt-3 before:absolute before:top-3 before:bottom-4 before:left-[7.5px] before:w-px before:bg-trace">
				<li className="flex items-center gap-3 py-1.5 text-sm">
					<span
						aria-hidden="true"
						className="grid size-4 shrink-0 place-items-center"
					>
						<span className="size-2.5 rounded-full border-[1.5px] border-trace-done bg-canvas ring-[3px] ring-canvas" />
					</span>
					<span className="min-w-0 flex-1 text-ink-2">Opened</span>
					<span className="text-ink-3 text-xs">
						<Time iso={investigation.created_at} />
					</span>
				</li>
				{INVESTIGATION_STAGES.map((stage) => (
					<StageRow
						key={stage}
						stage={stage}
						steps={byStage.get(stage) ?? []}
						current={live && investigation.current_stage === stage}
					/>
				))}
				<li className="flex items-start gap-3 py-1.5 text-sm">
					<span className="mt-0.5">
						<OutcomeNode status={investigation.status} />
					</span>
					<span className="min-w-0 flex-1">
						<span className={working ? "text-ink-3" : "font-semibold"}>
							{working ? "Not finished" : humanize(investigation.status)}
						</span>
						{!working && message && (
							<span className="block text-ink-3 text-xs">{message}</span>
						)}
					</span>
					{investigation.finished_at && (
						<span className="text-ink-3 text-xs">
							<Time iso={investigation.finished_at} />
						</span>
					)}
				</li>
			</ol>
			<p className="mt-3 text-ink-3 text-xs">
				Stage records as stored, not a full event log.
			</p>
		</section>
	);
}

const CALL = /[A-Za-z_$][\w$.]*\((?:[^()\n]|\([^()\n]*\))*\)/g;

/** Backtick spans and call expressions (`name(args)`) in reported text are set as code. */
function withCode(text: string): ReactNode[] {
	const code = (value: string, key: string) => (
		<code
			key={key}
			className="rounded-sm bg-surface px-1 py-px text-[0.9em] text-ink"
		>
			{value}
		</code>
	);
	return text.split(/(`[^`\n]+`)/).flatMap<ReactNode>((part, index) => {
		if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
			return [code(part.slice(1, -1), `t${index}`)];
		const nodes: ReactNode[] = [];
		let last = 0;
		for (const match of part.matchAll(CALL)) {
			nodes.push(part.slice(last, match.index));
			nodes.push(code(match[0], `c${index}-${match.index}`));
			last = match.index + match[0].length;
		}
		nodes.push(part.slice(last));
		return nodes;
	});
}

type BugReport = Awaited<ReturnType<typeof getBugReport>>;

/** The report as the reporter wrote it: the symptom, then expected against actual behavior. */
function BugReportView({ report }: { report: BugReport }) {
	return (
		<div className="space-y-5">
			<blockquote className="border-trace border-l-2 pl-4">
				<p className="text-ink-3 text-xs">What happened</p>
				<p className="mt-1 max-w-[68ch] whitespace-pre-wrap break-words text-[15px] leading-relaxed">
					{withCode(report.description)}
				</p>
			</blockquote>
			{(report.expected_behavior || report.actual_behavior) && (
				<dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
					{(
						[
							["Expected", report.expected_behavior],
							["Actual", report.actual_behavior],
						] as const
					).map(([label, value]) => (
						<div key={label} className="min-w-0 border-line border-l-2 pl-4">
							<dt className="text-ink-3 text-xs">{label}</dt>
							<dd className="mt-1 whitespace-pre-wrap break-words">
								{value ? (
									withCode(value)
								) : (
									<span className="text-ink-3">Not given</span>
								)}
							</dd>
						</div>
					))}
				</dl>
			)}
			{report.steps.length > 0 && (
				<div>
					<p className="text-ink-3 text-xs">Steps to reproduce</p>
					<ol className="mt-1 list-decimal space-y-0.5 pl-5">
						{report.steps.map((step) => (
							<li key={step}>{withCode(step)}</li>
						))}
					</ol>
				</div>
			)}
		</div>
	);
}

const HYPOTHESIS_TONES: Record<string, Tone> = {
	proposed: "uncertain",
	supported: "info",
	contradicted: "warn",
	confirmed: "good",
	rejected: "neutral",
};

type EvidenceItem = Findings["observed_facts"][number];
type Cite = Findings["hypotheses"][number]["supporting"][number];

const EVIDENCE_GROUPS = [
	["reported_claims", "Reported claims"],
	["observed_facts", "Observed facts"],
	["code_references", "Relevant code"],
	["commits", "Commits"],
	["experiments", "Experiments"],
	["model_observations", "Model observations"],
] as const;

const evidenceId = (handle: string) => `evidence-${handle}`;

function evidenceIndex(findings: Findings) {
	const index = new Map<string, EvidenceItem>();
	for (const [key] of EVIDENCE_GROUPS)
		for (const item of findings[key]) index.set(item.handle, item);
	return index;
}

const lineNumber = (value: unknown) =>
	typeof value === "number" && Number.isInteger(value) ? value : null;

/** Code references carry their file and line range in the stored locator. */
function locatorOf(item: EvidenceItem | undefined) {
	const locator = item?.locator ?? {};
	return {
		path: typeof locator.path === "string" ? locator.path : null,
		start: lineNumber(locator.start_line),
		end: lineNumber(locator.end_line),
	};
}

/** Where a citation points: `path:line` for code, otherwise the evidence label and its lines. */
function citeWhere(cite: Cite, item: EvidenceItem | undefined) {
	const path = locatorOf(item).path;
	if (path) return location(path, cite.start_line, cite.end_line);
	const lines =
		cite.start_line === null
			? ""
			: cite.end_line !== null && cite.end_line !== cite.start_line
				? `, lines ${cite.start_line}-${cite.end_line}`
				: `, line ${cite.start_line}`;
	return `${cite.label ?? cite.handle}${lines}`;
}

/** The lines each evidence item has cited by any hypothesis, for highlighting in its excerpt. */
function citedLines(findings: Findings) {
	const cited = new Map<string, Set<number>>();
	for (const hypothesis of findings.hypotheses)
		for (const cite of [
			...hypothesis.locations,
			...hypothesis.supporting,
			...hypothesis.contradicting,
		]) {
			const lines = cited.get(cite.handle) ?? new Set<number>();
			cited.set(cite.handle, lines);
			if (cite.start_line === null) continue;
			const end = Math.min(
				cite.end_line ?? cite.start_line,
				cite.start_line + 500,
			);
			for (let line = cite.start_line; line <= end; line++) lines.add(line);
		}
	return cited;
}

/** A citation that opens the cited evidence below, marked with how that evidence was obtained. */
function CiteLink({ cite, item }: { cite: Cite; item?: EvidenceItem }) {
	const open = () => {
		const target = document.getElementById(evidenceId(cite.handle));
		if (target instanceof HTMLDetailsElement) target.open = true;
	};
	const where = citeWhere(cite, item);
	const content = (
		<>
			{item && <Glyph tone={BASIS_TONES[item.basis] ?? "neutral"} />}
			<code className="text-ink">{cite.handle}</code>
			{where !== cite.handle && (
				<span className="break-all text-ink-3">{where}</span>
			)}
		</>
	);
	const chip =
		"inline-flex max-w-full items-center gap-1.5 rounded-sm border border-line px-1.5 py-0.5 text-xs";
	return item ? (
		<a
			href={`#${evidenceId(cite.handle)}`}
			onClick={open}
			title={`${humanize(item.basis)} evidence: ${item.label}`}
			className={`${chip} hover:border-trace-done hover:bg-interactive/40`}
		>
			{content}
		</a>
	) : (
		<span className={chip}>{content}</span>
	);
}

function CiteList({
	cites,
	index,
	none,
}: {
	cites: Cite[];
	index: Map<string, EvidenceItem>;
	none: string;
}) {
	if (cites.length === 0) return <span className="text-ink-3">{none}</span>;
	return (
		<span className="flex flex-wrap gap-1.5">
			{cites.map((cite) => (
				<CiteLink
					key={`${cite.handle}:${cite.start_line}`}
					cite={cite}
					item={index.get(cite.handle)}
				/>
			))}
		</span>
	);
}

function Hypotheses({ findings }: { findings: Findings }) {
	const index = evidenceIndex(findings);
	return (
		<div className="space-y-6">
			{findings.insufficient_evidence && (
				<p className="border-uncertain border-l-2 bg-uncertain/[0.06] py-2.5 pr-3 pl-3.5 text-sm">
					<span className="font-medium text-uncertain">
						Insufficient evidence for a hypothesis.
					</span>{" "}
					{findings.insufficient_evidence.reason}
				</p>
			)}
			{findings.hypotheses.length === 0 ? (
				<Empty>No hypotheses yet.</Empty>
			) : (
				<ol className="space-y-8">
					{findings.hypotheses.map((hypothesis) => (
						<li
							key={hypothesis.id}
							className="grid gap-x-4 gap-y-2 sm:grid-cols-[3.5rem_minmax(0,1fr)]"
						>
							<code className="pt-0.5 text-ink-3 text-xs">
								{hypothesis.handle}
							</code>
							<div className="min-w-0 space-y-3">
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<Status
										tone={HYPOTHESIS_TONES[hypothesis.state] ?? "neutral"}
										title={hypothesis.state}
									>
										{hypothesis.label}
									</Status>
									<span className="text-ink-3 text-xs">
										{humanize(hypothesis.confidence)} confidence
									</span>
								</div>
								<h3 className="font-semibold text-[15px] text-ink leading-snug">
									{hypothesis.title}
								</h3>
								<p className="max-w-[68ch] whitespace-pre-wrap text-ink-2 leading-relaxed">
									{hypothesis.mechanism}
								</p>
								<dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
									{hypothesis.locations.length > 0 && (
										<>
											<dt className="text-ink-3">Located at</dt>
											<dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
												{hypothesis.locations.map((cite) => (
													<code
														key={`${cite.handle}:${cite.start_line}`}
														className="break-all text-xs"
													>
														{citeWhere(cite, index.get(cite.handle))}
													</code>
												))}
											</dd>
										</>
									)}
									<dt className="text-ink-3">Supported by</dt>
									<dd className="min-w-0">
										<CiteList
											cites={hypothesis.supporting}
											index={index}
											none="No supporting evidence"
										/>
									</dd>
									<dt className="text-ink-3">Contradicted by</dt>
									<dd className="min-w-0">
										<CiteList
											cites={hypothesis.contradicting}
											index={index}
											none="Nothing recorded"
										/>
									</dd>
									<dt className="text-ink-3">Next check</dt>
									<dd className="min-w-0 max-w-[68ch]">
										{hypothesis.next_check}
									</dd>
								</dl>
							</div>
						</li>
					))}
				</ol>
			)}
			{findings.open_questions.length > 0 && (
				<div className="text-sm">
					<h3 className="font-semibold">Open questions</h3>
					<ul className="mt-2 max-w-[68ch] space-y-2">
						{findings.open_questions.map((item) => (
							<li key={item.question}>
								<p>{item.question}</p>
								<p className="text-ink-3 text-xs">{item.why_it_matters}</p>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

const BASIS_LEGEND = [
	["observed", "Observed: recorded by a tool"],
	["reported", "Reported: from the bug report"],
	["inferred", "Inferred: stated by a model"],
] as const;

function EvidenceList({ findings }: { findings: Findings }) {
	const groups = EVIDENCE_GROUPS.filter(([key]) => findings[key].length > 0);
	if (groups.length === 0)
		return <Empty>No evidence has been collected yet.</Empty>;
	const cited = citedLines(findings);
	return (
		<div className="space-y-6">
			<ul className="flex flex-wrap gap-x-5 gap-y-1 text-ink-3 text-xs">
				{BASIS_LEGEND.map(([basis, text]) => (
					<li key={basis} className="inline-flex items-center gap-1.5">
						<Glyph tone={BASIS_TONES[basis] ?? "neutral"} />
						{text}
					</li>
				))}
				<li>
					<span className="font-medium text-accent">Cited</span>: a hypothesis
					relies on it
				</li>
			</ul>
			{groups.map(([key, title]) => (
				<div key={key}>
					<h3 className="font-medium text-ink-2 text-xs">
						{title} ({findings[key].length})
					</h3>
					<ul className="mt-1.5 divide-y divide-line border-line border-y">
						{findings[key].map((item) => {
							const where = locatorOf(item);
							return (
								<li key={item.handle}>
									<details
										id={evidenceId(item.handle)}
										className="scroll-mt-20"
									>
										<summary className="-mx-1.5 flex cursor-pointer items-center gap-3 rounded px-1.5 py-2 text-sm hover:bg-interactive/25">
											<Chevron />
											<span
												title={humanize(item.basis)}
												className="inline-flex"
											>
												<Glyph tone={BASIS_TONES[item.basis] ?? "neutral"} />
												<span className="sr-only">{humanize(item.basis)}</span>
											</span>
											<code className="w-20 shrink-0 text-ink-2 text-xs">
												{item.handle}
											</code>
											<span className="min-w-0 flex-1 break-words">
												{item.label}
											</span>
											{cited.has(item.handle) && (
												<span className="font-medium text-accent text-xs">
													Cited
												</span>
											)}
										</summary>
										{item.content ? (
											<CodeBlock
												text={item.content}
												startLine={where.start}
												endLine={where.end}
												highlight={cited.get(item.handle)}
												caption={where.path ?? undefined}
												className="mb-3 sm:ml-6"
											/>
										) : (
											<p className="pb-3 text-ink-3 text-xs sm:ml-6">
												No content was stored for this item.
											</p>
										)}
									</details>
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</div>
	);
}

function Reproduction({ investigation }: { investigation: Investigation }) {
	const runs = useQuery({
		queryKey: [
			"investigations",
			investigation.id,
			"reproductions",
			investigation.state_version,
		],
		queryFn: () => listReproductions(investigation.id),
	});
	const baseline = investigation.baseline_reproduction;
	return (
		<div className="space-y-5 text-sm">
			<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="text-ink-3">Baseline</span>
				{baseline ? (
					<StateBadge value={baseline.status} size="sm" />
				) : (
					<span className="text-ink-3">Not recorded yet</span>
				)}
				{baseline?.reason && (
					<code className="break-all text-ink-2 text-xs">
						{baseline.reason}
					</code>
				)}
			</p>
			<QueryView query={runs} what="Sandbox runs">
				{(items) =>
					items.length === 0 ? (
						<p className="text-ink-3">No sandbox run recorded.</p>
					) : (
						<div>
							<h3 className="font-medium text-ink-2 text-xs">
								Sandbox runs ({items.length})
							</h3>
							<ul className="mt-1.5 divide-y divide-line border-line border-y">
								{items.map((run) => (
									<li
										key={run.id}
										className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)_auto]"
									>
										<span className="font-medium">{humanize(run.purpose)}</span>
										<code className="order-last col-span-2 break-all text-ink-2 text-xs sm:order-none sm:col-span-1">
											{run.argv.join(" ")}
										</code>
										<span className="flex items-center justify-end gap-3 text-xs">
											<StateBadge value={run.status} />
											<span className="text-ink-3 tabular-nums">
												Exit {run.exit_code ?? "none"}
											</span>
											<span className="text-ink-3 tabular-nums">
												{formatDuration(run.duration_ms)}
											</span>
										</span>
										{run.truncated && (
											<span className="col-span-full text-ink-3 text-xs">
												Output truncated
											</span>
										)}
									</li>
								))}
							</ul>
						</div>
					)
				}
			</QueryView>
		</div>
	);
}

function Patches({ investigation }: { investigation: Investigation }) {
	const patches = useQuery({
		queryKey: [
			"investigations",
			investigation.id,
			"patches",
			investigation.state_version,
		],
		queryFn: () => listPatches(investigation.id),
	});
	return (
		<QueryView query={patches} what="Patches">
			{(items) =>
				items.length === 0 ? (
					<Empty>No patch has been proposed.</Empty>
				) : (
					<ul className="-mt-4 divide-y divide-line border-line border-b">
						{items.map((patch) => (
							<li
								key={patch.id}
								className="grid gap-x-6 gap-y-3 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
							>
								<div className="min-w-0 space-y-1.5">
									<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
										<span className="font-semibold">
											Attempt {patch.attempt}
										</span>
										<StateBadge value={patch.status} />
										{patch.hypothesis_handle && (
											<span className="text-ink-3 text-xs">
												for <code>{patch.hypothesis_handle}</code>
											</span>
										)}
									</p>
									<p className="max-w-[68ch] text-ink">{patch.summary}</p>
									<div>
										{patch.verification ? (
											<OutcomeBadge
												outcome={patch.verification.outcome}
												label={patch.verification.label}
											/>
										) : (
											<Status tone="neutral">No verification run</Status>
										)}
									</div>
								</div>
								<Link
									to={`/investigations/${investigation.id}/patches/${patch.id}`}
									className={buttonClass}
								>
									Review patch
								</Link>
							</li>
						))}
					</ul>
				)
			}
		</QueryView>
	);
}

/** The next useful step, from stored state only: decide, retry, read the report, or cancel. */
function NextActions({
	data,
	onCancel,
	cancelling,
	onRetry,
	retrying,
}: {
	data: Investigation;
	onCancel: () => void;
	cancelling: boolean;
	onRetry: () => void;
	retrying: boolean;
}) {
	const decide =
		data.status === "awaiting_approval" &&
		data.latest_patch?.status === "proposed"
			? data.latest_patch
			: null;
	const failed = data.status === "failed";
	const reportReady = data.steps.some(
		(step) => step.stage === "write_report" && step.status === "succeeded",
	);
	return (
		<div className="flex flex-wrap items-center gap-2 sm:justify-end">
			{!TERMINAL.has(data.status) && (
				<button
					type="button"
					className={quietButtonClass}
					disabled={cancelling}
					onClick={onCancel}
				>
					{cancelling ? "Cancelling…" : "Cancel investigation"}
				</button>
			)}
			{reportReady ? (
				<Link
					to={`/investigations/${data.id}/report`}
					className={decide || failed ? buttonClass : primaryButtonClass}
				>
					Open resolution report
				</Link>
			) : (
				<span className="text-ink-3 text-xs">
					{TERMINAL.has(data.status)
						? "No resolution report was written"
						: "The resolution report is written at the last stage"}
				</span>
			)}
			{failed && (
				<button
					type="button"
					className={primaryButtonClass}
					disabled={retrying}
					onClick={onRetry}
				>
					{retrying ? "Retrying…" : "Retry from the failed stage"}
				</button>
			)}
			{decide && (
				<Link
					to={`/investigations/${data.id}/patches/${decide.id}`}
					className={primaryButtonClass}
				>
					Review patch and decide
				</Link>
			)}
		</div>
	);
}

export function InvestigationPage() {
	const { investigationId = "" } = useParams();
	const valid = idSchema("inv").safeParse(investigationId).success;
	const queryClient = useQueryClient();
	const investigation = useInvestigation(investigationId, valid);
	const bugReportId = investigation.data?.bug_report_id;
	const bug = useQuery({
		...bugReportQuery(bugReportId ?? ""),
		enabled: bugReportId !== undefined,
	});
	const repositoryId = investigation.data?.repository_id;
	const repository = useQuery({
		queryKey: ["repositories", repositoryId],
		queryFn: () => getRepository(repositoryId ?? ""),
		enabled: repositoryId !== undefined,
	});
	const version = investigation.data?.state_version;
	const findings = useQuery({
		queryKey: ["investigations", investigationId, "findings", version],
		queryFn: () => getFindings(investigationId),
		enabled: version !== undefined,
	});
	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: investigationQueryKey(investigationId),
		});
	const cancel = useMutation({
		mutationFn: () => cancelInvestigation(investigationId),
		onSuccess: refresh,
	});
	const retry = useMutation({
		mutationFn: () => retryInvestigation(investigationId),
		onSuccess: refresh,
	});
	if (!valid)
		return (
			<p>
				<code className="break-all">{investigationId}</code> is not an
				investigation ID.
			</p>
		);
	return (
		<>
			<Breadcrumbs
				items={[
					{ key: "list", label: "Investigations", to: "/investigations" },
					{ key: "id", label: <code>{investigationId}</code> },
				]}
			/>
			<QueryView query={investigation} what="Investigation">
				{(data) => {
					const message = progressMessage(data);
					const models = findings.data?.model_disclosure.models.join(", ");
					return (
						<>
							<title>{`${bug.data?.title ?? "Investigation"} · Tracera`}</title>
							<header className="mt-3">
								<div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4">
									<div className="min-w-0 max-w-3xl flex-[1_1_26rem]">
										<h1 className="break-words font-semibold text-2xl leading-tight tracking-tight">
											{bug.data?.title ?? <code>{data.id}</code>}
										</h1>
										<div
											aria-live="polite"
											className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
										>
											<StateBadge value={data.status} size="sm" />
											{message && <span className="text-ink-2">{message}</span>}
											{data.progress.stage_index > 0 &&
												data.status !== "completed" && (
													<span className="text-ink-3 tabular-nums">
														Stage {data.progress.stage_index} of{" "}
														{data.progress.stage_count}
													</span>
												)}
										</div>
									</div>
									<NextActions
										data={data}
										onCancel={() => cancel.mutate()}
										cancelling={cancel.isPending}
										onRetry={() => retry.mutate()}
										retrying={retry.isPending}
									/>
								</div>
								<Facts
									className="mt-6 border-line border-y py-4"
									items={[
										[
											"Repository",
											<Link
												key="repository"
												to={`/repositories/${data.repository_id}`}
												className={linkClass}
											>
												{repository.data?.name ?? (
													<code className="text-xs">{data.repository_id}</code>
												)}
											</Link>,
										],
										["Commit", <Sha key="commit" sha={data.commit_sha} />],
										[
											"Mode",
											data.mode === "analysis_only" ? (
												<span key="mode" title={data.mode_reason ?? undefined}>
													{data.mode_reason
														? `Analysis only: ${data.mode_reason.replaceAll("_", " ")}`
														: "Analysis only"}
												</span>
											) : (
												"Full"
											),
										],
										[
											"Inference",
											<span
												key="inference"
												className="flex flex-wrap items-center gap-2"
											>
												<InferenceLabel
													mock={data.inference.mock}
													detail={models || data.inference.provider}
												/>
												{data.flags.map((flag) => (
													<Status key={flag} tone="warn" title={flag}>
														{humanize(flag)}
													</Status>
												))}
											</span>,
										],
										["Opened", <Time key="opened" iso={data.created_at} />],
										data.finished_at !== null && [
											"Finished",
											<Time key="finished" iso={data.finished_at} />,
										],
									]}
								/>
								{data.needs_input && (
									<div className="mt-5 border-warning border-l-2 bg-warning/[0.06] py-2.5 pr-3 pl-3.5 text-sm">
										<p className="font-medium text-warning">Input needed</p>
										<p className="mt-0.5">{data.needs_input.question}</p>
										<p className="mt-1 text-ink-3 text-xs">
											Code <code>{data.needs_input.code}</code>. Answering from
											the web app is not available yet.
										</p>
									</div>
								)}
								{data.failure && (
									<div className="mt-5 border-error border-l-2 bg-error/[0.07] py-2.5 pr-3 pl-3.5 text-sm">
										<p className="font-medium text-error">
											Failed at {humanize(data.failure.stage)}
										</p>
										<p className="mt-0.5 break-words">
											<code>{data.failure.code}</code>: {data.failure.message}
										</p>
										<p className="mt-1 text-ink-3 text-xs">
											{data.failure.retryable
												? "The server marks this failure as retryable."
												: "The server marks this failure as not retryable."}
										</p>
									</div>
								)}
								{cancel.error && (
									<div className="mt-4">
										<ErrorNotice
											alert
											title="Cancellation failed"
											error={cancel.error}
										/>
									</div>
								)}
								{retry.error && (
									<div className="mt-4">
										<ErrorNotice
											alert
											title="Retry failed"
											error={retry.error}
										/>
									</div>
								)}
							</header>

							<div className="mt-8 grid gap-x-12 gap-y-10 lg:grid-cols-[15.5rem_minmax(0,1fr)]">
								<div className="lg:sticky lg:top-20 lg:self-start">
									<Workflow investigation={data} />
								</div>
								<div className="min-w-0 [&>section:first-child]:mt-0">
									<Section
										title="Bug report"
										id="bug-heading"
										actions={
											bug.data && (
												<>
													<span>Reported via {bug.data.source_channel}</span>
													<span>Severity {bug.data.severity}</span>
													<StateBadge value={bug.data.status} />
												</>
											)
										}
									>
										<QueryView query={bug} what="Bug report">
											{(report) => <BugReportView report={report} />}
										</QueryView>
									</Section>

									<ScreenshotEvidence
										bugReportId={data.bug_report_id}
										version={data.state_version}
										active={WORKING.has(data.status)}
									/>

									<Section
										title="Findings"
										id="findings-heading"
										actions={
											findings.data && (
												<InferenceLabel
													mock={findings.data.model_disclosure.mock}
													detail={models || "no model called"}
												/>
											)
										}
									>
										<QueryView query={findings} what="Findings">
											{(value) => <Hypotheses findings={value} />}
										</QueryView>
									</Section>

									<Section title="Evidence" id="evidence-heading">
										<QueryView query={findings} what="Evidence">
											{(value) => <EvidenceList findings={value} />}
										</QueryView>
									</Section>

									<Section title="Reproduction" id="repro-heading">
										<Reproduction investigation={data} />
									</Section>

									<Section title="Patches" id="patches-heading">
										<Patches investigation={data} />
									</Section>
								</div>
							</div>
						</>
					);
				}}
			</QueryView>
		</>
	);
}
