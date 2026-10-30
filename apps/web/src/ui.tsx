import type {
	EvidenceRef,
	SnapshotStatus,
	VerificationOutcome,
} from "@tracera/contracts";
import { type CSSProperties, type ReactNode, useId } from "react";
import { Link, NavLink } from "react-router";
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

/** The one h1 of a page: large, tight, and balanced across lines. */
export const titleClass =
	"break-words font-semibold text-[1.75rem] leading-tight tracking-tight";

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
			className="flex gap-2.5 rounded-lg border border-error/35 bg-error/[0.06] px-3.5 py-3 text-ink-2 text-sm"
		>
			<Glyph tone="bad" className="mt-[7px]" />
			<div className="min-w-0">
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
 * `good` (green dot) only for passed or verified; `done` (graphite dot) for finished work that
 * verifies nothing; `info` (black dot) for recorded observations; `progress` (orange ring) for queued
 * or running work; `warn` (amber triangle) for attention; `bad` (red square) for failure; `uncertain`
 * (violet outline diamond) for unsupported or inferred content; `decision` (orange diamond) for human
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

/** Text colors by tone, for a word that sits beside a shape of its own (a node on the trace). */
export const TONE_TEXT: Record<Tone, string> = {
	neutral: "text-ink-3",
	done: "text-ink-2",
	info: "text-info",
	progress: "text-link",
	good: "text-success",
	warn: "text-warning",
	bad: "text-error",
	uncertain: "text-uncertain",
	decision: "text-link",
};

const GLYPHS: Record<Tone, string> = {
	neutral: "size-2 rounded-full border-[1.5px] border-ink-3",
	done: "size-2 rounded-full bg-trace-done",
	info: "size-2 rounded-full bg-info",
	progress: "size-2 rounded-full border-2 border-trace-reached",
	good: "size-2 rounded-full bg-success",
	warn: "size-2.5 bg-warning [clip-path:polygon(50%_0,100%_100%,0_100%)]",
	bad: "size-2 rounded-[1px] bg-error",
	uncertain: "size-[7px] rotate-45 border-[1.5px] border-uncertain",
	decision: "size-[7px] rotate-45 bg-trace-reached",
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

/** Small categorical tags (node kinds, change types) as tinted pills. Statuses use <Status>. */
export const TONES: Record<Tone, string> = {
	neutral: "bg-elevated text-ink-2 ring-line-strong",
	done: "bg-elevated text-ink-2 ring-line-strong",
	info: "bg-info/[0.07] text-info ring-info/25",
	progress: "bg-accent/10 text-link ring-accent/35",
	good: "bg-success/10 text-success ring-success/30",
	warn: "bg-warning/10 text-warning ring-warning/35",
	bad: "bg-error/10 text-error ring-error/30",
	uncertain: "bg-uncertain/10 text-uncertain ring-uncertain/30",
	decision: "bg-wash text-link ring-accent/40",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
	return (
		<span
			className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-[11px] leading-4 ring-1 ring-inset ${TONES[tone]}`}
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
				className="h-1.5 w-full max-w-56"
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
		<div className="flex items-baseline justify-between gap-4 border-line border-b py-1.5 last:border-b-0">
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

// Controls respond to a press with a small, fast scale (transform only), and never animate "all".
const control =
	"inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3.5 font-medium text-sm transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 motion-reduce:active:scale-100";
// Disabled controls stay legible (muted text) instead of fading out. White text sits on the deeper
// orange fill because the brand orange itself is too light to carry text.
export const buttonClass = `${control} border border-line-strong bg-canvas text-ink hover:border-control hover:bg-surface disabled:border-line disabled:bg-surface disabled:text-ink-3 disabled:hover:border-line`;
export const primaryButtonClass = `${control} bg-primary text-on-primary hover:bg-primary-hover disabled:bg-elevated disabled:text-ink-3`;
export const quietButtonClass = `${control} px-2.5 text-ink-2 hover:bg-elevated hover:text-ink disabled:text-ink-3 disabled:hover:bg-transparent`;
// The edge of an input is the only cue to where it is, so it takes the stronger control border.
export const inputClass =
	"mt-1.5 block w-full min-w-0 rounded-md border border-control bg-canvas px-3 py-2 text-base text-ink transition-colors duration-150 hover:border-ink-3 sm:text-sm";
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
			className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm border px-1.5 py-px font-medium text-[11px] leading-4 ${mock ? "border-warning/50 bg-warning/10 text-warning" : "border-line-strong bg-elevated text-ink-2"}`}
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
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-line border-b pb-2">
				<h2 id={id} className="font-semibold text-base text-ink tracking-tight">
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

/** The box shared by cards, panels, and tables: the raised plane for documents. */
export const cardClass = "rounded-lg border border-line bg-surface";

/** A plane for documents and forms; most content sits directly on the canvas instead. */
export const panelClass = `${cardClass} p-4 text-sm sm:p-5`;

export function Loading({ children }: { children: ReactNode }) {
	return (
		<p role="status" className="flex items-center gap-2 text-ink-3 text-sm">
			<Glyph tone="progress" className="motion-safe:animate-live" />
			{children}
		</p>
	);
}

/** Nothing here yet: drawn with the dotted edge the trace uses for "not established". */
export function Empty({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-lg border border-line-strong border-dashed px-4 py-3 text-ink-2 text-sm">
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
			className={`size-3 shrink-0 text-ink-3 transition-transform duration-150 ease-out motion-reduce:transition-none [details[open]>summary>&]:rotate-90 ${className}`}
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
		<dl className={`flex flex-wrap gap-x-10 gap-y-3 ${className}`}>
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
							<Link
								to={item.to}
								className="transition-colors hover:text-ink hover:underline"
							>
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
	// Observed is a fact a tool recorded, not a verification: a plain dark dot, not success green.
	observed: "info",
	reported: "neutral",
	inferred: "uncertain",
};

/** A short mono label for a citation or an item in the evidence trail, such as a handle or an ID. */
export function Handle({
	children,
	className = "",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<code
			className={`rounded-sm bg-elevated px-1.5 py-px font-medium text-[11.5px] text-ink-2 ${className}`}
		>
			{children}
		</code>
	);
}

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
			className={`min-w-0 overflow-hidden rounded-lg border border-line bg-surface ${className}`}
		>
			{caption && (
				<figcaption className="border-line border-b bg-elevated/60 px-3 py-1.5 font-mono text-ink-2 text-xs">
					{caption}
				</figcaption>
			)}
			<pre className="max-h-80 overflow-auto text-[12.5px] text-ink leading-[1.65]">
				{numbered && startLine !== null ? (
					<code className="block min-w-max py-2">
						{lines.map((line, index) => {
							const cited = highlight?.has(startLine + index) === true;
							return (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond their position
									key={index}
									className={`grid grid-cols-[4ch_1fr] gap-3 border-l-2 pr-3 pl-2 ${cited ? "border-accent bg-wash" : "border-transparent"}`}
								>
									<span
										aria-hidden="true"
										className="select-none text-right text-ink-3 tabular-nums"
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

// ---- Diffs ---------------------------------------------------------------------------------------

export type DiffLine = {
	kind: "hunk" | "add" | "del" | "context" | "meta";
	text: string;
	old: number | null;
	new: number | null;
};
export type DiffFile = { path: string; lines: DiffLine[] };

// Added and removed lines carry a tinted row and a bar at the edge; the sign stays in the text, so
// the change is readable without color.
const DIFF_ROWS: Record<DiffLine["kind"], string> = {
	add: "bg-diff-add text-diff-add-fg shadow-[inset_2px_0_0_var(--success)]",
	del: "bg-diff-del text-diff-del-fg shadow-[inset_2px_0_0_var(--error)]",
	context: "text-ink-2",
	hunk: "",
	meta: "",
};

/** One file of a unified diff, with old and new line numbers. Parsing happens where the diff is read. */
export function DiffFileView({ file }: { file: DiffFile }) {
	const added = file.lines.filter((line) => line.kind === "add").length;
	const removed = file.lines.filter((line) => line.kind === "del").length;
	return (
		<figure className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
			<figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-line border-b bg-elevated/60 px-3 py-2 text-xs">
				<code className="break-all text-ink">{file.path}</code>
				<span className="flex gap-2 font-medium tabular-nums">
					<span className="text-diff-add-fg">+{added}</span>
					<span className="text-diff-del-fg">−{removed}</span>
				</span>
			</figcaption>
			<pre className="max-h-[36rem] overflow-auto text-[12.5px] leading-[1.65]">
				<code className="block min-w-max py-1">
					{file.lines.map((line, index) =>
						line.kind === "meta" ? null : line.kind === "hunk" ? (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
								key={index}
								className="my-0.5 block bg-elevated/70 px-3 py-0.5 text-ink-3"
							>
								{line.text}
							</span>
						) : (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
								key={index}
								className={`grid grid-cols-[4ch_4ch_1fr] gap-x-3 pr-3 pl-3 ${DIFF_ROWS[line.kind]}`}
							>
								<span
									aria-hidden="true"
									className="select-none text-right text-ink-3 tabular-nums"
								>
									{line.old ?? ""}
								</span>
								<span
									aria-hidden="true"
									className="select-none text-right text-ink-3 tabular-nums"
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

const OUTCOME_TONES: Record<VerificationOutcome, Tone> = {
	verified: "good",
	partially_verified: "warn",
	failed: "bad",
	inconclusive: "warn",
	// Could not run: attention required, not a failure of the patch.
	blocked: "warn",
	not_attempted: "neutral",
};

/** The tone of a stored verification outcome; "good" only for `verified`. */
export const outcomeTone = (outcome: VerificationOutcome): Tone =>
	OUTCOME_TONES[outcome];

/** The stored outcome, with the server's label; "Verified" appears only when the outcome says so. */
export function OutcomeBadge({
	outcome,
	label,
	size,
}: {
	outcome: VerificationOutcome;
	label?: string;
	size?: "xs" | "sm";
}) {
	return (
		<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
			<Status tone={OUTCOME_TONES[outcome]} title={outcome} size={size}>
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
	// The reported failure was observed: a recorded fact, not a success.
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

/**
 * The brand mark: an orange tile around a trace from an open node (the symptom) to a filled one
 * (certainty).
 */
export function TraceMark({ className = "size-5" }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 24 24"
			className={`shrink-0 ${className}`}
		>
			<rect
				x="0.5"
				y="0.5"
				width="23"
				height="23"
				rx="6.5"
				fill="var(--accent)"
			/>
			<path
				d="M7.5 16.5H12l4.5-4.5V8"
				fill="none"
				stroke="#fff"
				strokeWidth="1.9"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle
				cx="6.5"
				cy="16.5"
				r="1.8"
				fill="var(--accent)"
				stroke="#fff"
				strokeWidth="1.6"
			/>
			<circle cx="16.5" cy="7" r="2.4" fill="#fff" />
		</svg>
	);
}

// ---- The trace: one line whose style says how much is established ----------------------------------

type NodeShape = "circle" | "triangle" | "square" | "diamond";

const NODE_SHAPES: Record<Tone, NodeShape> = {
	neutral: "circle",
	done: "circle",
	info: "circle",
	progress: "circle",
	good: "circle",
	warn: "triangle",
	bad: "square",
	uncertain: "diamond",
	decision: "diamond",
};

const NODE_COLORS: Record<Tone, string> = {
	neutral: "text-ink-3",
	done: "text-ink",
	info: "text-info",
	progress: "text-trace-reached",
	good: "text-success",
	warn: "text-warning",
	bad: "text-error",
	uncertain: "text-uncertain",
	decision: "text-trace-reached",
};

/**
 * A stop on the trace. The shape says what happened (circle: recorded, triangle: needs attention,
 * square: failed, diamond: a proposal or a human decision) and `open` draws it hollow where nothing is
 * established. `current` rings the last stop the stored data reaches.
 */
export function TraceNode({
	tone = "done",
	open = false,
	current = false,
	live = false,
	className = "size-4",
}: {
	tone?: Tone;
	open?: boolean;
	current?: boolean;
	/** Work is running at this node right now: the one ambient motion on the page. */
	live?: boolean;
	className?: string;
}) {
	const shape = NODE_SHAPES[tone];
	const paint = open
		? {
				fill: "var(--background)",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinejoin: "round" as const,
			}
		: { fill: "currentColor", stroke: "none" };
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 16 16"
			className={`trace-node relative z-10 shrink-0 ${NODE_COLORS[tone]} ${live ? "rounded-full motion-safe:animate-live" : ""} ${className}`}
		>
			{current && (
				<circle cx="8" cy="8" r="7.5" fill="currentColor" opacity="0.14" />
			)}
			{shape === "circle" && <circle cx="8" cy="8" r="4.6" {...paint} />}
			{shape === "triangle" && <polygon points="8,2.5 14,13 2,13" {...paint} />}
			{shape === "square" && (
				<rect x="3.5" y="3.5" width="9" height="9" rx="1.2" {...paint} />
			)}
			{shape === "diamond" && <polygon points="8,2 14,8 8,14 2,8" {...paint} />}
		</svg>
	);
}

/** One stop of a trace or timeline: what is there, and whether stored data stands behind it. */
export type TraceStop = {
	key: string;
	label: string;
	value?: ReactNode;
	tone?: Tone;
	/** Hollow node: reported or awaited, not established. Defaults to hollow until reached. */
	open?: boolean;
	/** A recorded fact stands behind this stop, so the line into it is solid. */
	reached: boolean;
	/** Work is in flight toward this stop or a decision awaits: the line into it is dashed. */
	pending?: boolean;
	/** The node pulses: the worker is running at this stop right now. */
	live?: boolean;
	/** An in-page anchor, for a stop that has its own section on the page. */
	href?: string;
	/** A route, for a stop that lives on another page. */
	to?: string;
};

type LineKind = "solid" | "dashed" | "dotted";

/** The line into a stop: solid when established, dashed when pending, dotted when not reached. */
const lineInto = (stop: Pick<TraceStop, "reached" | "pending">): LineKind =>
	stop.reached ? "solid" : stop.pending ? "dashed" : "dotted";

/**
 * The stops of an investigation drawn as one line. Each stop links where it has somewhere to go, so
 * the strip is also the table of contents. Below the sm breakpoint only the last reached stop is
 * labelled on screen, and every stop stays in the list for assistive technology. `intro` draws the
 * line once on mount (the sign-in page); elsewhere it extends only when new work lands.
 */
export function TraceStrip({
	stops,
	label,
	className = "",
	intro = false,
}: {
	stops: readonly TraceStop[];
	label: string;
	className?: string;
	intro?: boolean;
}) {
	const current = stops.findLastIndex((stop) => stop.reached);
	return (
		<ol
			aria-label={label}
			className={`flex max-sm:pb-10 ${intro ? "trace-intro" : ""} ${className}`}
		>
			{stops.map((stop, index) => {
				const next = stops[index + 1];
				const last = next === undefined;
				const isCurrent = index === current;
				const text = (
					<span
						className={`min-w-0 ${
							isCurrent
								? `max-sm:absolute max-sm:top-7 max-sm:whitespace-nowrap ${last ? "max-sm:right-0 max-sm:text-right" : "max-sm:left-0"}`
								: "max-sm:sr-only"
						}`}
					>
						<span className="block font-medium text-ink-2 text-xs">
							{stop.label}
						</span>{" "}
						{stop.value !== undefined && (
							<span className="mt-0.5 block text-ink text-sm leading-snug">
								{stop.value}
							</span>
						)}
					</span>
				);
				const body = (
					<>
						<TraceNode
							tone={stop.tone ?? (stop.reached ? "done" : "neutral")}
							open={stop.open ?? !stop.reached}
							current={isCurrent}
							live={stop.live}
						/>
						{text}
					</>
				);
				const wrap =
					"group -my-1.5 flex flex-col gap-2.5 rounded-sm py-1.5 pr-3";
				return (
					<li
						key={stop.key}
						style={{ "--i": index } as CSSProperties}
						className="relative min-w-0 flex-1 last:flex-none sm:last:flex-1"
					>
						{next && (
							<span
								aria-hidden="true"
								data-axis="h"
								data-line={lineInto(next)}
								className="trace-seg top-[7px] right-[-8px] left-2"
							/>
						)}
						{stop.to ? (
							<Link to={stop.to} className={`${wrap} hover:[&_span]:underline`}>
								{body}
							</Link>
						) : stop.href ? (
							<a
								href={stop.href}
								className={`${wrap} hover:[&_span]:underline`}
							>
								{body}
							</a>
						) : (
							<div className={wrap}>{body}</div>
						)}
					</li>
				);
			})}
		</ol>
	);
}

/** A stop on a vertical timeline, with the content that sits beside its node. */
export type TimelineStop = TraceStop & {
	body: ReactNode;
	/** The stop the work is at now; marked for assistive technology as the current step. */
	current?: boolean;
};

/**
 * The same trace turned vertical, for a list of stages: each row's content sits beside its node and
 * the line runs through the whole list. The node is level with the first line of the row.
 */
export function Timeline({
	stops,
	className = "",
}: {
	stops: readonly TimelineStop[];
	className?: string;
}) {
	return (
		<ol className={className}>
			{stops.map((stop, index) => {
				const next = stops[index + 1];
				return (
					<li
						key={stop.key}
						aria-current={stop.current ? "step" : undefined}
						style={{ "--i": index } as CSSProperties}
						className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 py-1.5"
					>
						{next && (
							<span
								aria-hidden="true"
								data-axis="v"
								data-line={lineInto(next)}
								className="trace-seg top-4 bottom-[-1rem] left-[7px]"
							/>
						)}
						<span className="mt-2">
							<TraceNode
								tone={stop.tone ?? (stop.reached ? "done" : "neutral")}
								open={stop.open ?? !stop.reached}
								current={stop.current}
								live={stop.live}
							/>
						</span>
						<div className="min-w-0">{stop.body}</div>
					</li>
				);
			})}
		</ol>
	);
}

/**
 * The trace at row size: nodes and line, no words, for scanning where each item of a list got to.
 * It is one image to assistive technology; `label` says what it shows in words.
 */
export function TraceMini({
	stops,
	label,
}: {
	stops: readonly TraceStop[];
	label: string;
}) {
	return (
		<span role="img" aria-label={label} className="inline-flex items-center">
			{stops.map((stop, index) => {
				const next = stops[index + 1];
				return (
					<span
						key={stop.key}
						className={`relative inline-flex ${next ? "w-[26px]" : ""}`}
					>
						{next && (
							<span
								aria-hidden="true"
								data-axis="h"
								data-line={lineInto(next)}
								className="trace-seg top-[5px] right-[-6px] left-1.5"
							/>
						)}
						<TraceNode
							tone={stop.tone ?? (stop.reached ? "done" : "neutral")}
							open={stop.open ?? !stop.reached}
							live={stop.live}
							className="size-3"
						/>
					</span>
				);
			})}
		</span>
	);
}

// ---- Page structure: icons, page header, cards, tables, tabs ---------------------------------------

/** Line icons for navigation and actions. Add the shapes here, then name the icon where it is used. */
const ICONS = {
	repository: (
		<>
			<path d="M6 3v12" />
			<circle cx="18" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
			<path d="M18 9a9 9 0 0 1-9 9" />
		</>
	),
	investigation: (
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</>
	),
	"chevron-down": <path d="m6 9 6 6 6-6" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

/** Decorative: the label next to an icon carries the meaning, so it is hidden from assistive technology. */
export function Icon({
	name,
	className = "size-5",
}: {
	name: IconName;
	className?: string;
}) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={`shrink-0 ${className}`}
		>
			{ICONS[name]}
		</svg>
	);
}

/**
 * The top of a page: breadcrumbs, the one h1, a description, and the page's actions, over a rule.
 * `children` sits under the title row (status, facts) and above the rule.
 */
export function PageHeader({
	title,
	description,
	actions,
	crumbs,
	children,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	crumbs?: ReactNode;
	children?: ReactNode;
}) {
	return (
		// A div, not a <header>: the shell owns the page's one banner landmark.
		<div className="border-line border-b pb-6">
			{crumbs}
			<div
				className={`flex flex-wrap items-end justify-between gap-x-8 gap-y-4 ${crumbs ? "mt-3" : ""}`}
			>
				<div className="min-w-0 max-w-2xl">
					<h1 className={titleClass}>{title}</h1>
					{description && (
						<p className="mt-2 text-ink-2 text-sm">{description}</p>
					)}
				</div>
				{actions && (
					<div className="flex flex-wrap items-center gap-2">{actions}</div>
				)}
			</div>
			{children}
		</div>
	);
}

/**
 * Grouped content in a box: an optional title row (a heading, with counts or actions on the right)
 * over a padded body. The title names the region for assistive technology.
 */
export function Card({
	title,
	actions,
	className = "",
	children,
}: {
	title?: ReactNode;
	actions?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const headingId = useId();
	return (
		<section
			aria-labelledby={title ? headingId : undefined}
			className={`${cardClass} ${className}`}
		>
			{(title || actions) && (
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-line border-b px-4 py-3 sm:px-5">
					{title && (
						<h2 id={headingId} className="font-semibold text-ink text-sm">
							{title}
						</h2>
					)}
					{actions && (
						<div className="flex flex-wrap items-center gap-2 text-ink-2 text-xs">
							{actions}
						</div>
					)}
				</div>
			)}
			<div className="p-4 text-sm sm:p-5">{children}</div>
		</section>
	);
}

/**
 * A callout beside the content it concerns: a shape, a title, and a few lines on a tinted plane. A
 * dashed outline marks what is inferred rather than recorded, the same way the trace draws it.
 */
export function Notice({
	tone,
	title,
	children,
	role,
}: {
	tone: "warn" | "bad" | "uncertain" | "decision" | "info";
	title: ReactNode;
	children?: ReactNode;
	role?: "alert" | "status";
}) {
	const plane = {
		warn: "border-warning/40 bg-warning/[0.07]",
		bad: "border-error/35 bg-error/[0.06]",
		uncertain: "border-uncertain/40 border-dashed bg-uncertain/[0.05]",
		decision: "border-accent/45 bg-wash",
		info: "border-line-strong bg-surface",
	}[tone];
	const text = {
		warn: "text-warning",
		bad: "text-error",
		uncertain: "text-uncertain",
		decision: "text-link",
		info: "text-ink",
	}[tone];
	return (
		<div
			role={role}
			className={`flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm ${plane}`}
		>
			<Glyph tone={tone === "info" ? "done" : tone} className="mt-[7px]" />
			<div className="min-w-0">
				<p className={`font-medium ${text}`}>{title}</p>
				{children && <div className="mt-0.5 text-ink-2">{children}</div>}
			</div>
		</div>
	);
}

/**
 * A data table that scrolls inside its own frame, so a wide table never widens the page. The scroll
 * frame takes focus so a keyboard user can scroll it; the caption names the table and is not drawn.
 */
export function Table({
	caption,
	children,
}: {
	caption: string;
	children: ReactNode;
}) {
	return (
		<section
			aria-label={caption}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to scroll by keyboard
			tabIndex={0}
			className={`overflow-x-auto ${cardClass}`}
		>
			<table className="w-full border-collapse text-left text-sm [&_tbody_tr:last-child>*]:border-b-0">
				<caption className="sr-only">{caption}</caption>
				{children}
			</table>
		</section>
	);
}

/** Header and body cell styles for <Table>. Headers are sentence case, never uppercase. */
export const thClass =
	"whitespace-nowrap border-line border-b px-4 py-2.5 font-medium text-ink-2 text-xs";
export const tdClass = "border-line border-b px-4 py-3 align-top";

const tabClass = (active: boolean) =>
	`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 font-medium text-sm transition-colors duration-150 ${
		active
			? "border-accent text-ink"
			: "border-transparent text-ink-3 hover:border-line-strong hover:text-ink"
	}`;

/**
 * Section tabs for the page below a header: links that go to routes, with the current one underlined
 * in the brand color. `also` keeps a tab marked on pages that belong to it but are not its own route.
 */
export function TabNav({
	label,
	items,
	className = "",
}: {
	label: string;
	items: ReadonlyArray<{
		to: string;
		label: string;
		end?: boolean;
		also?: boolean;
	}>;
	className?: string;
}) {
	return (
		<nav
			aria-label={label}
			className={`flex overflow-x-auto border-line border-b ${className}`}
		>
			{items.map((item) => (
				<NavLink
					key={item.to}
					to={item.to}
					end={item.end}
					className={({ isActive }) => tabClass(isActive || item.also === true)}
				>
					{item.label}
				</NavLink>
			))}
		</nav>
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
