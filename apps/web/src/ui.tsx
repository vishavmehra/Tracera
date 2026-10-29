import type {
	EvidenceRef,
	SnapshotStatus,
	VerificationOutcome,
} from "@tracera/contracts";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "./api.ts";
import type {
	Coverage,
	ErrorInfo,
	Freshness,
	IndexProgress,
} from "./schemas.ts";

// Small display pieces. Every value shown comes from an API response; nothing here derives a status.

/** An enum value as words ("awaiting_approval" → "Awaiting approval"). Presentation only. */
export const humanize = (value: string) => {
	const words = value.replaceAll("_", " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
};

export function PageStatus({ children }: { children: ReactNode }) {
	return (
		<p role="status" className="px-4 py-16 text-center text-ink-3">
			{children}
		</p>
	);
}

export function ErrorNotice({
	title,
	error,
	onRetry,
	alert = false,
}: {
	title: string;
	error: unknown;
	onRetry?: () => void;
	alert?: boolean;
}) {
	const apiError = error instanceof ApiError ? error : null;
	return (
		<div
			role={alert ? "alert" : undefined}
			className="border-error border-l-2 bg-error/[0.07] py-2.5 pr-3 pl-3.5 text-ink-2 text-sm"
		>
			<p className="font-medium text-error">{title}</p>
			<p className="mt-0.5 break-words">
				{error instanceof Error ? error.message : "Unknown error."}
			</p>
			{apiError?.problem?.errors && (
				<ul className="mt-1 list-disc pl-5">
					{apiError.problem.errors.map((issue) => (
						<li key={`${issue.path}:${issue.message}`}>
							<code>{issue.path || "(request)"}</code>: {issue.message}
						</li>
					))}
				</ul>
			)}
			{apiError && (
				<p className="mt-1 flex flex-wrap gap-x-4 text-ink-3 text-xs">
					<span>
						Error code <code>{apiError.code}</code>
					</span>
					{apiError.problem ? (
						<span>
							Request <code>{apiError.problem.request_id}</code>
						</span>
					) : (
						<span>Detected by the web app</span>
					)}
				</p>
			)}
			{onRetry && (
				<button
					type="button"
					onClick={onRetry}
					className={`${buttonClass} mt-2`}
				>
					Try again
				</button>
			)}
		</div>
	);
}

const SHORT_TIME = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
const FULL_TIME = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "medium",
});

/** A compact local time; the full timestamp is in the tooltip and the `datetime` attribute. */
export function Time({
	iso,
	precise = false,
}: {
	iso: string;
	precise?: boolean;
}) {
	const date = new Date(iso);
	return (
		<time dateTime={iso} title={FULL_TIME.format(date)}>
			{(precise ? FULL_TIME : SHORT_TIME).format(date)}
		</time>
	);
}

/** Elapsed time between two stored timestamps; nothing is estimated. */
export function formatDuration(ms: number) {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
	const minutes = Math.floor(ms / 60_000);
	return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export const elapsed = (from: string | null, to: string | null) =>
	from && to ? new Date(to).getTime() - new Date(from).getTime() : null;

export function Sha({ sha }: { sha: string }) {
	return (
		<code className="font-mono" title={sha}>
			{sha.slice(0, 12)}
		</code>
	);
}

/**
 * Tones carry meaning (index.css), and each has its own shape so color is never the only cue:
 * `good` (green dot) only for passed or verified; `done` (steel dot) for finished work that verifies
 * nothing; `info` (blue dot) for recorded observations; `progress` (blue ring) for queued or running
 * work; `warn` (amber triangle) for attention; `bad` (red square) for failure; `uncertain` (violet
 * outline diamond) for unsupported or inferred content; `decision` (pink diamond) for human
 * decisions, which never imply verification; `neutral` (outline dot) for work that did not run.
 */
export type Tone =
	| "neutral"
	| "done"
	| "info"
	| "progress"
	| "good"
	| "warn"
	| "bad"
	| "uncertain"
	| "decision";

const TONE_TEXT: Record<Tone, string> = {
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

const GLYPHS: Record<Tone, string> = {
	neutral: "size-2 rounded-full border-[1.5px] border-ink-3",
	done: "size-2 rounded-full bg-trace-done",
	info: "size-2 rounded-full bg-info",
	progress: "size-2 rounded-full border-2 border-info",
	good: "size-2 rounded-full bg-success",
	warn: "size-2.5 bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]",
	bad: "size-2 rounded-[1px] bg-error",
	uncertain: "size-[7px] rotate-45 border-[1.5px] border-uncertain",
	decision: "size-[7px] rotate-45 bg-accent",
};

export function Glyph({
	tone,
	className = "",
}: {
	tone: Tone;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={`inline-block shrink-0 ${GLYPHS[tone]} ${className}`}
		/>
	);
}

/** A status as a shape and a word; `title` keeps the raw stored value for anyone who needs it. */
export function Status({
	tone,
	children,
	title,
	size = "xs",
}: {
	tone: Tone;
	children: ReactNode;
	title?: string;
	size?: "xs" | "sm";
}) {
	return (
		<span
			title={title}
			className={`inline-flex items-center gap-1.5 whitespace-nowrap font-medium ${size === "sm" ? "text-sm" : "text-xs"} ${TONE_TEXT[tone]}`}
		>
			<Glyph tone={tone} />
			{children}
		</span>
	);
}

/** Small categorical tags (node kinds, change types). Statuses use <Status>. */
export const TONES: Record<Tone, string> = {
	neutral: "bg-elevated text-ink-2",
	done: "bg-elevated text-ink-2",
	info: "bg-info/10 text-info",
	progress: "bg-info/10 text-info",
	good: "bg-success/10 text-success",
	warn: "bg-warning/10 text-warning",
	bad: "bg-error/10 text-error",
	uncertain: "bg-uncertain/10 text-uncertain",
	decision: "bg-plum/60 text-accent",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
	return (
		<span
			className={`inline-flex items-center whitespace-nowrap rounded-sm px-1.5 py-px font-medium text-[11px] leading-4 ${TONES[tone]}`}
		>
			{children}
		</span>
	);
}

const STATUS_TONES: Record<SnapshotStatus, Tone> = {
	queued: "progress",
	indexing: "progress",
	ready: "done",
	partial: "warn",
	failed: "bad",
	cancelled: "neutral",
};

/** The snapshot status as the API returned it. */
export function StatusBadge({ status }: { status: SnapshotStatus }) {
	return (
		<Status tone={STATUS_TONES[status]} title={status}>
			{humanize(status)}
		</Status>
	);
}

export const isActive = (status: SnapshotStatus | undefined) =>
	status === "queued" || status === "indexing";

export function IndexProgressView({ progress }: { progress: IndexProgress }) {
	const counted = progress.total > 0;
	return (
		<div className="space-y-1.5 text-sm">
			<p className="flex flex-wrap items-baseline gap-x-3">
				<span>
					Phase <span className="font-medium">{humanize(progress.phase)}</span>
				</span>
				{counted && (
					<span className="text-ink-3 tabular-nums">
						{progress.done} of {progress.total}
					</span>
				)}
			</p>
			{/* Without a total the phase has no countable steps, so the bar is indeterminate. */}
			<progress
				aria-label={`Indexing, phase ${progress.phase}`}
				className="h-1 w-full max-w-56 accent-link"
				max={counted ? progress.total : undefined}
				value={counted ? progress.done : undefined}
			/>
			<p className="text-ink-3 text-xs">
				Last worker update <Time iso={progress.updated_at} />
			</p>
		</div>
	);
}

export function SnapshotError({ error }: { error: ErrorInfo }) {
	return (
		<p className="break-words text-error">
			<code>{error.code}</code>: {error.message}
			{error.retryable === true && " (retryable)"}
		</p>
	);
}

/** A labelled count: a ruled row in detailed views, an inline pair in compact ones. */
function Fact({
	label,
	value,
	compact = false,
}: {
	label: string;
	value: ReactNode;
	compact?: boolean;
}) {
	const shown = value ?? (
		<span className="font-normal text-ink-3">Not reported</span>
	);
	return compact ? (
		<div className="flex items-baseline gap-1.5">
			<dt className="text-ink-3">{label}</dt>
			<dd className="font-medium text-ink tabular-nums">{shown}</dd>
		</div>
	) : (
		<div className="flex items-baseline justify-between gap-4 border-line/70 border-b py-1.5 last:border-b-0">
			<dt className="text-ink-3">{label}</dt>
			<dd className="text-right font-medium tabular-nums">{shown}</dd>
		</div>
	);
}

const factList = (detailed: boolean) =>
	detailed ? "mt-2" : "mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs";

/** Coverage counts as recorded by the indexer; absent fields stay "Not reported". */
export function CoverageFacts({
	coverage,
	detailed = false,
}: {
	coverage: Coverage;
	detailed?: boolean;
}) {
	const unresolved = coverage.unresolved;
	const unparsed = coverage.unsupported_code_files;
	const compact = !detailed;
	return (
		<>
			<Status tone={coverage.complete ? "done" : "warn"}>
				{coverage.complete ? "Complete" : "Partial"}
			</Status>
			<dl className={factList(detailed)}>
				{detailed && (
					<Fact label="Parsed files" value={coverage.parsed_files} />
				)}
				<Fact
					label="Parse failures"
					value={coverage.parse_failures?.length}
					compact={compact}
				/>
				<Fact
					label="Unresolved imports"
					value={unresolved?.imports}
					compact={compact}
				/>
				<Fact
					label="Unresolved calls"
					value={unresolved?.calls}
					compact={compact}
				/>
				<Fact
					label="Unresolved method calls"
					value={unresolved?.member_calls}
					compact={compact}
				/>
				<Fact
					label="Requests matching no route"
					value={unresolved?.requests}
					compact={compact}
				/>
				{detailed && (
					<>
						<Fact
							label="Unresolved route handlers"
							value={unresolved?.route_handlers}
						/>
						<Fact
							label="Routes with unknown prefix"
							value={unresolved?.routes_with_unknown_prefix}
						/>
						<Fact
							label="Truncated files"
							value={coverage.truncated_files?.length}
						/>
					</>
				)}
				<Fact
					compact={compact}
					label="Unparsed languages"
					value={
						unparsed &&
						(Object.keys(unparsed).length === 0
							? "none"
							: Object.entries(unparsed)
									.map(([language, files]) => `${language} (${files})`)
									.join(", "))
					}
				/>
			</dl>
		</>
	);
}

const FRESHNESS_REASONS: Record<string, string> = {
	ref_moved: "The ref has moved since indexing",
	extractor_outdated: "Indexed with an older extractor version",
	source_unavailable: "The source repository could not be read",
};

/** `stale` is true, false, or null (could not be checked), as the API reports it. */
export function FreshnessFacts({
	freshness,
	detailed = false,
}: {
	freshness: Freshness;
	detailed?: boolean;
}) {
	return (
		<>
			{freshness.stale === null ? (
				<Status tone="neutral">Freshness unknown</Status>
			) : freshness.stale ? (
				<Status tone="warn">Stale</Status>
			) : (
				<Status tone="done">Up to date</Status>
			)}
			{freshness.reasons.length > 0 && (
				<ul className="mt-2 list-disc pl-5">
					{freshness.reasons.map((reason) => (
						<li key={reason}>
							{FRESHNESS_REASONS[reason] ?? reason} (<code>{reason}</code>)
						</li>
					))}
				</ul>
			)}
			<dl className={factList(detailed)}>
				<Fact
					label="Ref"
					value={<code>{freshness.ref}</code>}
					compact={!detailed}
				/>
				<Fact
					label="Indexed commit"
					value={<Sha sha={freshness.indexed_commit} />}
					compact={!detailed}
				/>
				<Fact
					label="Current commit"
					value={
						freshness.current_commit ? (
							<Sha sha={freshness.current_commit} />
						) : (
							"unknown"
						)
					}
					compact={!detailed}
				/>
				{detailed && (
					<Fact label="Checked" value={<Time iso={freshness.checked_at} />} />
				)}
			</dl>
		</>
	);
}

// ---- Shared pieces for the intelligence and investigation screens ------------------------------

const control =
	"inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded px-3 font-medium text-sm transition-colors disabled:cursor-not-allowed";
// Disabled controls stay legible (muted text) instead of fading out.
export const buttonClass = `${control} border border-line-strong text-ink hover:border-trace-done hover:bg-interactive/40 disabled:border-line disabled:text-ink-3 disabled:hover:bg-transparent`;
export const primaryButtonClass = `${control} bg-primary text-on-primary hover:bg-primary-hover disabled:bg-elevated disabled:text-ink-3`;
export const quietButtonClass = `${control} px-2 text-ink-2 hover:bg-interactive/40 hover:text-ink disabled:text-ink-3`;
export const inputClass =
	"mt-1.5 block w-full min-w-0 rounded border border-line-strong bg-canvas px-3 py-2 text-base text-ink transition-colors hover:border-trace-done sm:text-sm";
export const linkClass = "text-link underline-offset-2 hover:underline";
export const labelClass = "font-medium text-ink text-sm";
export const hintClass = "mt-1 text-ink-3 text-xs";

/**
 * Provenance of model output: `[mock]` when the mock adapter produced it (never presented as a live
 * result), `[live]` when a real provider did. Shown at the boundary of each result.
 */
export function InferenceLabel({
	mock,
	detail,
}: {
	mock: boolean;
	detail?: ReactNode;
}) {
	return (
		<span
			title={
				mock
					? "Produced by the mock inference adapter, not a real model"
					: "Produced by a configured model provider"
			}
			className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-1.5 py-px font-semibold text-[11px] leading-4 ${mock ? "border-warning/45 text-warning" : "border-line-strong text-ink-2"}`}
		>
			{mock ? "[mock]" : "[live]"}
			{detail && <span className="font-normal text-ink-2">{detail}</span>}
		</span>
	);
}

export function Section({
	title,
	id,
	actions,
	children,
}: {
	title: string;
	id: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-labelledby={id} className="mt-10">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-line border-b pb-2">
				<h2 id={id} className="font-semibold text-base text-ink">
					{title}
				</h2>
				{actions && (
					<div className="flex flex-wrap items-center gap-2 text-ink-3 text-xs">
						{actions}
					</div>
				)}
			</div>
			<div className="mt-4">{children}</div>
		</section>
	);
}

/** A plane for documents and forms; most content sits directly on the canvas instead. */
export const panelClass =
	"rounded-md border border-line bg-surface p-4 text-sm sm:p-5";

export function Loading({ children }: { children: ReactNode }) {
	return (
		<p role="status" className="flex items-center gap-2 text-ink-3 text-sm">
			<Glyph tone="progress" className="motion-safe:animate-live" />
			{children}
		</p>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return (
		<div className="border-line-strong border-l-2 py-1 pl-3 text-ink-2 text-sm">
			{children}
		</div>
	);
}

/** Rotates when its disclosure opens; only a direct child of the open summary turns. */
export function Chevron({ className = "" }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 12 12"
			className={`size-3 shrink-0 text-ink-3 transition-transform motion-reduce:transition-none [details[open]>summary>&]:rotate-90 ${className}`}
		>
			<path
				d="M4.5 2.5 8 6l-3.5 3.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/** What the server says it could not see; shown wherever a result has limitations. */
export function Limitations({ items }: { items: string[] }) {
	if (items.length === 0) return null;
	return (
		<details className="mt-4 text-sm">
			<summary className="inline-flex cursor-pointer items-center gap-1.5 rounded text-ink-2 hover:text-ink">
				<Chevron />
				Limitations ({items.length})
			</summary>
			<ul className="mt-2 list-disc space-y-1 pl-9 text-ink-2">
				{items.map((item) => (
					<li key={item}>{item}</li>
				))}
			</ul>
		</details>
	);
}

/** Labelled values in a row that wraps; labels are sentence case, values carry the weight. */
export function Facts({
	items,
	className = "",
}: {
	items: ReadonlyArray<readonly [string, ReactNode] | null | false>;
	className?: string;
}) {
	return (
		<dl className={`flex flex-wrap gap-x-8 gap-y-3 ${className}`}>
			{items.map(
				(item) =>
					item && (
						<div key={item[0]} className="min-w-0">
							<dt className="text-ink-3 text-xs">{item[0]}</dt>
							<dd className="mt-0.5 break-words text-sm">{item[1]}</dd>
						</div>
					),
			)}
		</dl>
	);
}

export function Breadcrumbs({
	items,
}: {
	items: ReadonlyArray<{ label: ReactNode; to?: string; key: string }>;
}) {
	return (
		<nav aria-label="Breadcrumb">
			<ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-ink-3 text-xs">
				{items.map((item, index) => (
					<li key={item.key} className="flex min-w-0 items-center gap-x-1.5">
						{index > 0 && <span aria-hidden="true">/</span>}
						{item.to ? (
							<Link to={item.to} className="hover:text-ink hover:underline">
								{item.label}
							</Link>
						) : (
							<span aria-current="page" className="min-w-0 truncate">
								{item.label}
							</span>
						)}
					</li>
				))}
			</ol>
		</nav>
	);
}

export const location = (
	path: string | null,
	start: number | null,
	end: number | null,
) =>
	path === null
		? "(no file)"
		: start === null
			? path
			: end !== null && end !== start
				? `${path}:${start}-${end}`
				: `${path}:${start}`;

/** observed = a deterministic tool recorded it; reported = a person said it; inferred = a model said it. */
export const BASIS_TONES: Record<string, Tone> = {
	// Observed is a fact a tool recorded, not a verification: information blue, not success green.
	observed: "info",
	reported: "neutral",
	inferred: "uncertain",
};

/** One citation in the shared evidence shape: where it is, how it was obtained, and the excerpt. */
export function EvidenceView({ evidence }: { evidence: EvidenceRef }) {
	return (
		<div className="min-w-0 space-y-2">
			<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<code className="break-all text-ink text-xs">
					{location(evidence.path, evidence.start_line, evidence.end_line)}
				</code>
				{evidence.symbol && (
					<span className="text-ink-2 text-xs">{evidence.symbol}</span>
				)}
				<Status
					tone={BASIS_TONES[evidence.classification] ?? "neutral"}
					title={evidence.classification}
				>
					{humanize(evidence.classification)}
				</Status>
				<span className="text-ink-3 text-xs">
					{humanize(evidence.type)} via {evidence.method}
					{evidence.certainty && `, ${evidence.certainty}`}
					{evidence.commit_sha && (
						<>
							{" "}
							at <Sha sha={evidence.commit_sha} />
						</>
					)}
				</span>
			</p>
			{evidence.excerpt && (
				<CodeBlock
					text={evidence.excerpt}
					startLine={evidence.start_line}
					endLine={evidence.end_line}
				/>
			)}
			{evidence.limitations.length > 0 && (
				<p className="text-ink-3 text-xs">{evidence.limitations.join(" ")}</p>
			)}
		</div>
	);
}

/**
 * Code, logs, and excerpts. Line numbers appear only when the excerpt has exactly as many lines as the
 * cited range, so a number is never guessed; `highlight` marks lines that a claim cites.
 */
export function CodeBlock({
	text,
	startLine = null,
	endLine = null,
	highlight,
	caption,
	className = "",
}: {
	text: string;
	startLine?: number | null;
	endLine?: number | null;
	highlight?: ReadonlySet<number>;
	caption?: ReactNode;
	className?: string;
}) {
	const lines = text.replace(/\n$/, "").split("\n");
	const numbered =
		startLine !== null &&
		endLine !== null &&
		endLine - startLine + 1 === lines.length;
	return (
		<figure
			className={`min-w-0 overflow-hidden rounded border border-line bg-surface ${className}`}
		>
			{caption && (
				<figcaption className="border-line border-b px-3 py-1.5 text-ink-3 text-xs">
					{caption}
				</figcaption>
			)}
			<pre className="max-h-80 overflow-auto text-[12px] text-ink-2 leading-[1.65]">
				{numbered && startLine !== null ? (
					<code className="block min-w-max py-2">
						{lines.map((line, index) => {
							const cited = highlight?.has(startLine + index) === true;
							return (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond their position
									key={index}
									className={`grid grid-cols-[4ch_1fr] gap-3 border-l-2 pr-3 ${cited ? "border-accent bg-ocean/55 text-ink" : "border-transparent"}`}
								>
									<span
										aria-hidden="true"
										className={`select-none text-right ${cited ? "text-ink-2" : "text-ink-3/70"}`}
									>
										{startLine + index}
									</span>
									<span>
										{line || " "}
										{cited && <span className="sr-only"> (cited)</span>}
									</span>
								</span>
							);
						})}
					</code>
				) : (
					<code className="block min-w-max px-3 py-2">{text}</code>
				)}
			</pre>
		</figure>
	);
}

const OUTCOME_TONES: Record<VerificationOutcome, Tone> = {
	verified: "good",
	partially_verified: "warn",
	failed: "bad",
	inconclusive: "warn",
	// Could not run: attention required, not a failure of the patch.
	blocked: "warn",
	not_attempted: "neutral",
};

/** The stored outcome, with the server's label; "Verified" appears only when the outcome says so. */
export function OutcomeBadge({
	outcome,
	label,
}: {
	outcome: VerificationOutcome;
	label?: string;
}) {
	return (
		<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
			<Status tone={OUTCOME_TONES[outcome]} title={outcome}>
				{humanize(outcome)}
			</Status>
			{label && <span className="text-ink-2 text-xs">{label}</span>}
		</span>
	);
}

export const GENERIC_TONES: Record<string, Tone> = {
	queued: "progress",
	running: "progress",
	indexing: "progress",
	preparing: "progress",
	needs_input: "warn",
	awaiting_approval: "decision",
	// Finishing is not succeeding: a completed investigation may have found no fix.
	completed: "done",
	succeeded: "done",
	exited: "done",
	ready: "done",
	passed: "good",
	verified: "good",
	confirmed: "good",
	// The reported failure was observed: information, not a success.
	reproduced: "info",
	not_reproduced: "neutral",
	supported: "info",
	contradicted: "warn",
	partial: "warn",
	inconclusive: "warn",
	timeout: "bad",
	failed: "bad",
	error: "bad",
	apply_failed: "bad",
	cancelled: "neutral",
	blocked: "warn",
	skipped: "neutral",
	pending: "neutral",
	not_attempted: "neutral",
	open: "neutral",
	investigating: "progress",
	// A possible cause is a model's proposal until evidence supports it.
	proposed: "uncertain",
	// Human decisions use the brand tone: approval never reads as verification.
	approved: "decision",
	rejected: "neutral",
	changes_requested: "warn",
	superseded: "neutral",
};

/** Any status word as the API returned it, as a shape and words; the raw value is in the tooltip. */
export function StateBadge({
	value,
	size,
}: {
	value: string;
	size?: "xs" | "sm";
}) {
	return (
		<Status tone={GENERIC_TONES[value] ?? "neutral"} title={value} size={size}>
			{humanize(value)}
		</Status>
	);
}

/** The brand mark: a trace from an open node (the symptom) to a filled one (certainty). */
export function TraceMark({ className = "size-5" }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 20 20"
			className={`shrink-0 ${className}`}
		>
			<path
				d="M5.5 15H10l6-6V6.5"
				fill="none"
				stroke="var(--trace-done)"
				strokeWidth="1.75"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle
				cx="3.75"
				cy="15"
				r="1.9"
				fill="none"
				stroke="var(--trace-done)"
				strokeWidth="1.5"
			/>
			<circle cx="16" cy="4.25" r="2.5" fill="var(--brand-pink)" />
		</svg>
	);
}

/** A plain query-state switch: error, loading, then content. */
export function QueryView<T>({
	query,
	what,
	children,
}: {
	query: {
		data: T | undefined;
		error: unknown;
		refetch: () => unknown;
	};
	what: string;
	children: (data: T) => ReactNode;
}) {
	if (query.error)
		return (
			<ErrorNotice
				title={`${what} could not be loaded`}
				error={query.error}
				onRetry={() => void query.refetch()}
			/>
		);
	if (query.data === undefined)
		return <Loading>Loading {what.toLowerCase()}…</Loading>;
	return <>{children(query.data)}</>;
}

/** A "no usable snapshot" answer is a state of the repository, not a failure. */
export const notIndexed = (error: unknown) =>
	error instanceof ApiError &&
	(error.code === "graph_not_indexed" || error.code === "snapshot_not_ready");

export function NotIndexed() {
	return (
		<Empty>
			No usable snapshot yet: this needs a <code>ready</code> or{" "}
			<code>partial</code> snapshot. Check indexing on the Overview tab.
		</Empty>
	);
}
