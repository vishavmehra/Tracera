import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ImpactTarget,
	idSchema,
	type PatchImpactResult,
	type TestState,
} from "@tracera/contracts";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { z } from "zod";
import {
	analyzeImpact,
	cancelPatchAnalysis,
	createPatchAnalysis,
	getPatchAnalysis,
	listPatchAnalyses,
} from "./api.ts";
import { POLL_MS } from "./hooks.ts";
import { useRepository } from "./repository.tsx";
import {
	type ChangeImpactSchema,
	type PatchAnalysis,
	parseImpact,
} from "./schemas.ts";
import {
	Badge,
	Breadcrumbs,
	buttonClass,
	Chevron,
	Empty,
	ErrorNotice,
	Facts,
	hintClass,
	humanize,
	inputClass,
	Limitations,
	Loading,
	labelClass,
	linkClass,
	NotIndexed,
	notIndexed,
	panelClass,
	primaryButtonClass,
	QueryView,
	Section,
	Sha,
	StateBadge,
	Status,
	Time,
	type Tone,
} from "./ui.tsx";

type ChangeImpact = z.infer<typeof ChangeImpactSchema>;

const SEVERITY_TONES: Record<string, Tone> = {
	high: "bad",
	medium: "warn",
	low: "neutral",
};

/** One relationship per line: `from KIND to`, so a chain reads top to bottom. */
function Chain({
	links,
}: {
	links: ReadonlyArray<{ from: string; kind: string; to: string }>;
}) {
	return (
		<ol className="space-y-0.5 text-xs">
			{links.map((link) => (
				<li
					key={`${link.from}:${link.kind}:${link.to}`}
					className="break-all text-ink-2"
				>
					<code>{link.from}</code>{" "}
					<span className="text-ink-3">{link.kind}</span> <code>{link.to}</code>
				</li>
			))}
		</ol>
	);
}

/** Symbol, file, route, table, or configuration-key impact from the graph (POST …/impact). */
export function ImpactResults({
	repositoryId,
	data,
}: {
	repositoryId: string;
	data: ChangeImpact;
}) {
	const [showAll, setShowAll] = useState(false);
	const shown = showAll ? data.affected : data.affected.slice(0, 25);
	const groups = Object.entries(data.groups);
	return (
		<div className="space-y-5 text-sm">
			<div className="space-y-1">
				<p role="status">
					{data.affected.length} dependent
					{data.affected.length === 1 ? "" : "s"} reached in snapshot{" "}
					<Sha sha={data.snapshot.commit_sha} />
					{data.truncated && " (truncated)"}.
				</p>
				{groups.length > 0 && (
					<p className="flex flex-wrap gap-x-4 text-ink-3 text-xs">
						{groups.map(([group, n]) => (
							<span key={group}>
								{humanize(group)}{" "}
								<span className="font-medium text-ink tabular-nums">{n}</span>
							</span>
						))}
					</p>
				)}
			</div>
			{data.unresolved_targets.length > 0 && (
				<p className="border-warning border-l-2 pl-3 text-warning">
					{data.unresolved_targets.length} target(s) were not found in this
					snapshot.
				</p>
			)}
			{data.affected.length > 0 && (
				<ol className="divide-y divide-line border-line border-y">
					{shown.map((item) => (
						<li key={item.node.id} className="space-y-1.5 py-2.5">
							<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
								<Badge tone="neutral">{humanize(item.category)}</Badge>
								<Link
									to={`/repositories/${repositoryId}/nodes/${item.node.id}`}
									className={`${linkClass} break-all font-medium`}
								>
									{item.node.name}
								</Link>
								<code className="break-all text-ink-3 text-xs">
									{item.node.path ?? item.node.key}
								</code>
								<span className="flex flex-wrap gap-x-3 text-ink-3 text-xs">
									<span>Distance {item.distance}</span>
									<span>{humanize(item.certainty)}</span>
									<span>Score {item.score}</span>
								</span>
							</p>
							<Chain
								links={item.why.map((link) => ({
									from: link.from_key,
									kind: link.kind,
									to: link.to_key,
								}))}
							/>
						</li>
					))}
				</ol>
			)}
			{data.affected.length > 25 && (
				<button
					type="button"
					className={buttonClass}
					onClick={() => setShowAll(!showAll)}
				>
					{showAll ? "Show the first 25" : `Show all ${data.affected.length}`}
				</button>
			)}
			{data.untested_targets.length > 0 && (
				<div>
					<h4 className="font-semibold">No linked tests found for</h4>
					<p className="text-ink-3 text-xs">
						The graph links no test to these; that is not proof they are
						untested.
					</p>
					<ul className="mt-1.5 space-y-0.5">
						{data.untested_targets.map((key) => (
							<li key={key} className="break-all">
								<code className="text-xs">{key}</code>
							</li>
						))}
					</ul>
				</div>
			)}
			{data.owners.length > 0 && (
				<div>
					<h4 className="font-semibold">Declared owners</h4>
					<ul className="mt-1.5 space-y-0.5">
						{data.owners.map((owner) => (
							<li key={owner.owner}>
								{owner.owner}{" "}
								<span className="text-ink-3">
									({owner.files.length} file
									{owner.files.length === 1 ? "" : "s"}, {owner.basis})
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{data.recent_commits.length > 0 && (
				<div>
					<h4 className="font-semibold">Recent commits to the changed files</h4>
					<ul className="mt-1.5 divide-y divide-line border-line border-y">
						{data.recent_commits.map((commit) => (
							<li
								key={commit.sha}
								className="grid gap-x-4 py-1.5 sm:grid-cols-[7.5rem_6rem_minmax(0,1fr)]"
							>
								<Sha sha={commit.sha} />
								<span className="text-ink-3 tabular-nums">
									{commit.date.slice(0, 10)}
								</span>
								<span className="break-words">{commit.subject}</span>
							</li>
						))}
					</ul>
				</div>
			)}
			<Limitations items={data.limitations} />
		</div>
	);
}

const TARGET_KINDS = [
	["symbol", "Symbol"],
	["file", "File"],
	["route", "Route"],
	["table", "Table"],
	["config_key", "Config key"],
] as const;
type TargetKind = (typeof TARGET_KINDS)[number][0];

function targetOf(kind: TargetKind, form: FormData): ImpactTarget {
	const text = (name: string) => String(form.get(name) ?? "").trim();
	switch (kind) {
		case "symbol":
			return { kind, name: text("name"), path: text("path") || undefined };
		case "file":
			return { kind, path: text("path") };
		case "route":
			return { kind, method: text("method").toUpperCase(), path: text("path") };
		case "table":
		case "config_key":
			return { kind, name: text("name") };
	}
}

function SymbolImpact() {
	const repo = useRepository();
	const [kind, setKind] = useState<TargetKind>("symbol");
	const impact = useMutation({
		mutationFn: (target: ImpactTarget) =>
			analyzeImpact(repo.id, { targets: [target], depth: 6, limit: 150 }),
	});
	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		impact.mutate(targetOf(kind, new FormData(event.currentTarget)));
	};
	const nameField =
		kind === "symbol" || kind === "table" || kind === "config_key";
	const pathField = kind !== "table" && kind !== "config_key";
	return (
		<>
			<form
				onSubmit={onSubmit}
				className={`flex flex-wrap items-end gap-3 ${panelClass}`}
			>
				<div>
					<label htmlFor="target-kind" className={labelClass}>
						Target
					</label>
					<select
						id="target-kind"
						value={kind}
						onChange={(event) => setKind(event.target.value as TargetKind)}
						className={inputClass}
					>
						{TARGET_KINDS.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</div>
				{kind === "route" && (
					<div className="w-28">
						<label htmlFor="target-method" className={labelClass}>
							Method
						</label>
						<input
							id="target-method"
							name="method"
							required
							pattern="[A-Za-z]{3,7}"
							defaultValue="GET"
							className={`${inputClass} font-mono`}
						/>
					</div>
				)}
				{nameField && (
					<div className="min-w-0 flex-1 basis-48">
						<label htmlFor="target-name" className={labelClass}>
							Name
						</label>
						<input
							id="target-name"
							name="name"
							required
							maxLength={300}
							className={`${inputClass} font-mono`}
						/>
					</div>
				)}
				{pathField && (
					<div className="min-w-0 flex-1 basis-48">
						<label htmlFor="target-path" className={labelClass}>
							{kind === "route" ? "Route path" : "File path"}
							{kind === "symbol" && (
								<span className="font-normal text-ink-3"> (optional)</span>
							)}
						</label>
						<input
							id="target-path"
							name="path"
							required={kind !== "symbol"}
							maxLength={500}
							placeholder={kind === "route" ? "/api/orders/:id" : "src/…"}
							className={`${inputClass} font-mono`}
						/>
					</div>
				)}
				<button
					type="submit"
					className={primaryButtonClass}
					disabled={impact.isPending}
				>
					{impact.isPending ? "Analyzing…" : "Analyze impact"}
				</button>
			</form>
			<div className="mt-5">
				{notIndexed(impact.error) ? (
					<NotIndexed />
				) : impact.error ? (
					<ErrorNotice
						alert
						title="Impact analysis failed"
						error={impact.error}
					/>
				) : impact.data ? (
					<ImpactResults repositoryId={repo.id} data={impact.data} />
				) : null}
			</div>
		</>
	);
}

const ANALYSIS_ACTIVE = new Set(["queued", "running"]);

function PatchImpactForm() {
	const repo = useRepository();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [mode, setMode] = useState<"head" | "diff">("head");
	const create = useMutation({
		mutationFn: (form: FormData) => {
			const text = (name: string) => String(form.get(name) ?? "").trim();
			return createPatchAnalysis(repo.id, {
				base: text("base"),
				...(mode === "head"
					? { head: text("head"), merge_base: form.get("merge_base") === "on" }
					: { diff: String(form.get("diff") ?? ""), merge_base: false }),
				depth: 4,
				limit: 100,
			});
		},
		onSuccess: async ({ analysis }) => {
			await queryClient.invalidateQueries({
				queryKey: ["repositories", repo.id, "patch-impact"],
			});
			navigate(`/repositories/${repo.id}/patch-impact/${analysis.id}`);
		},
	});
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				create.mutate(new FormData(event.currentTarget));
			}}
			className={`space-y-4 ${panelClass}`}
		>
			<fieldset>
				<legend className={labelClass}>Compare</legend>
				<div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
					<label className="flex items-center gap-2">
						<input
							type="radio"
							name="mode"
							checked={mode === "head"}
							onChange={() => setMode("head")}
							className="size-4 accent-accent"
						/>
						Two revisions
					</label>
					<label className="flex items-center gap-2">
						<input
							type="radio"
							name="mode"
							checked={mode === "diff"}
							onChange={() => setMode("diff")}
							className="size-4 accent-accent"
						/>
						A unified diff on a base revision
					</label>
				</div>
			</fieldset>
			<div className="flex flex-wrap gap-3">
				<div className="min-w-0 flex-1 basis-40">
					<label htmlFor="base" className={labelClass}>
						Base
					</label>
					<input
						id="base"
						name="base"
						required
						defaultValue={repo.default_branch}
						maxLength={200}
						className={`${inputClass} font-mono`}
					/>
				</div>
				{mode === "head" && (
					<div className="min-w-0 flex-1 basis-40">
						<label htmlFor="head" className={labelClass}>
							Head
						</label>
						<input
							id="head"
							name="head"
							required
							maxLength={200}
							className={`${inputClass} font-mono`}
						/>
					</div>
				)}
			</div>
			{mode === "head" ? (
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						name="merge_base"
						className="size-4 accent-accent"
					/>
					Compare head with its merge base (pull-request style)
				</label>
			) : (
				<div>
					<label htmlFor="diff" className={labelClass}>
						Diff (<code>git diff</code> output)
					</label>
					<textarea
						id="diff"
						name="diff"
						required
						rows={8}
						maxLength={750_000}
						className={`${inputClass} font-mono text-xs sm:text-xs`}
					/>
					<p className={hintClass}>
						Applied to a Tracera-owned copy of the base; your working tree is
						never touched.
					</p>
				</div>
			)}
			{create.error && (
				<ErrorNotice
					alert
					title="Patch impact could not be requested"
					error={create.error}
				/>
			)}
			<button
				type="submit"
				className={primaryButtonClass}
				disabled={create.isPending}
			>
				{create.isPending ? "Requesting…" : "Analyze patch impact"}
			</button>
		</form>
	);
}

const describeHead = (analysis: PatchAnalysis) =>
	analysis.head.diff_sha256 ? (
		<>
			supplied diff <code>{analysis.head.diff_sha256.slice(0, 12)}</code>
		</>
	) : (
		<code>{analysis.head.ref ?? analysis.head.sha}</code>
	);

function PatchAnalysisList() {
	const repo = useRepository();
	const analyses = useQuery({
		queryKey: ["repositories", repo.id, "patch-impact"],
		queryFn: () => listPatchAnalyses(repo.id),
		refetchInterval: (query) =>
			query.state.data?.some((a) => ANALYSIS_ACTIVE.has(a.status))
				? POLL_MS
				: false,
	});
	return (
		<QueryView query={analyses} what="Patch analyses">
			{(items) =>
				items.length === 0 ? (
					<Empty>No patch analyses yet.</Empty>
				) : (
					<ul className="divide-y divide-line border-line border-y">
						{items.map((analysis) => (
							<li
								key={analysis.id}
								className="grid gap-x-4 gap-y-1 py-2.5 text-sm sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center"
							>
								<StateBadge value={analysis.status} />
								<Link
									to={`/repositories/${repo.id}/patch-impact/${analysis.id}`}
									className={`${linkClass} break-all`}
								>
									<code>
										{analysis.base.ref ?? analysis.base.sha?.slice(0, 12)}
									</code>{" "}
									to {describeHead(analysis)}
								</Link>
								<span className="text-ink-3 text-xs">
									<Time iso={analysis.created_at} />
								</span>
							</li>
						))}
					</ul>
				)
			}
		</QueryView>
	);
}

export function ImpactPage() {
	return (
		<>
			<Section title="Change impact" id="change-impact-heading">
				<p className="mb-4 max-w-[68ch] text-ink-2 text-sm">
					Dependents reached by walking resolved graph relationships backwards.
					Heuristic links are not followed, so the list is a floor.
				</p>
				<SymbolImpact />
			</Section>
			<Section title="Patch impact" id="patch-impact-heading">
				<p className="mb-4 max-w-[68ch] text-ink-2 text-sm">
					Static analysis of a change: nothing is executed, no model is called,
					and tests are only recommended.
				</p>
				<PatchImpactForm />
				<h3 className="mt-8 mb-2 font-semibold text-sm">Recent analyses</h3>
				<PatchAnalysisList />
			</Section>
		</>
	);
}

const TEST_STATE_TEXT: Record<TestState, string> = {
	relevant: "relevant tests linked",
	possible: "possible tests linked",
	none_identified: "none identified (not proof of untested)",
	unknown: "unknown",
};

function Severity({ value }: { value: string | null }) {
	return value ? (
		<Status tone={SEVERITY_TONES[value] ?? "neutral"} title={value}>
			{humanize(value)}
		</Status>
	) : (
		<span className="text-ink-3">None</span>
	);
}

/** A PatchImpactResult (`packages/contracts/src/patch-impact.ts`), as analysed or stored on a patch. */
export function PatchImpactView({ result }: { result: PatchImpactResult }) {
	const [allFindings, setAllFindings] = useState(false);
	const findings = allFindings ? result.findings : result.findings.slice(0, 15);
	const s = result.summary;
	return (
		<div className="space-y-6 text-sm">
			<div className="space-y-3">
				<Status tone={result.complete ? "done" : "warn"}>
					{result.complete ? "Complete" : "Incomplete"}
				</Status>
				<Facts
					items={[
						["Base", <Sha key="base" sha={result.base.sha} />],
						[
							`Head (${humanize(result.head.kind).toLowerCase()})`,
							<Sha key="head" sha={result.head.sha} />,
						],
						["Files", s.files],
						[
							"Symbols changed",
							s.symbols.modified +
								s.symbols.signature_changed +
								s.symbols.export_changed,
						],
						[
							"Symbols added / removed",
							`${s.symbols.added} / ${s.symbols.removed}`,
						],
						["Findings", s.findings],
						[
							"Evidenced risk",
							<Severity
								key="evidenced"
								value={result.risk.evidenced.severity}
							/>,
						],
						[
							"Plausible risk",
							<Severity
								key="plausible"
								value={result.risk.plausible.severity}
							/>,
						],
					]}
				/>
				{result.risk.factors.length > 0 && (
					<ul className="list-disc space-y-0.5 pl-5 text-ink-2">
						{result.risk.factors.map((factor) => (
							<li key={factor}>{factor}</li>
						))}
					</ul>
				)}
			</div>
			<div>
				<h4 className="font-semibold">
					Changed symbols ({result.symbols.length})
				</h4>
				{result.symbols.length === 0 ? (
					<p className="mt-1 text-ink-3">No parsed symbol changed.</p>
				) : (
					<ul className="mt-1.5 divide-y divide-line border-line border-y">
						{result.symbols.map((symbol) => (
							<li
								key={symbol.key}
								className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
							>
								<StateBadge value={symbol.change} />
								<span className="break-all font-medium">{symbol.name}</span>
								<code className="break-all text-ink-3 text-xs">
									{symbol.path}
								</code>
								<span className="flex flex-wrap gap-x-3 text-ink-3 text-xs">
									<span>
										{symbol.dependents} dependent
										{symbol.dependents === 1 ? "" : "s"}
									</span>
									<span>Tests: {TEST_STATE_TEXT[symbol.tests]}</span>
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
			<div>
				<h4 className="font-semibold">Findings ({result.findings.length})</h4>
				{result.findings.length === 0 ? (
					<p className="mt-1 text-ink-3">No dependents reached.</p>
				) : (
					<ol className="mt-1.5 divide-y divide-line border-line border-y">
						{findings.map((finding) => (
							<li key={finding.id} className="space-y-1.5 py-2.5">
								<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<code className="text-ink-3 text-xs">{finding.id}</code>
									<Severity value={finding.severity} />
									<span className="break-all font-medium">
										{finding.target.name}
									</span>
									{finding.target.path && (
										<code className="break-all text-ink-3 text-xs">
											{finding.target.path}
											{finding.target.line !== null &&
												`:${finding.target.line}`}
										</code>
									)}
									<span className="flex flex-wrap gap-x-3 text-ink-3 text-xs">
										<span>{humanize(finding.confidence)} confidence</span>
										<span>{humanize(finding.certainty)}</span>
										{finding.observed && <span>Observed</span>}
									</span>
								</p>
								<p className="max-w-[68ch] text-ink-2">{finding.reason}</p>
								<p className="text-ink-3 text-xs">
									From <span className="text-ink-2">{finding.origin.name}</span>{" "}
									({finding.origin.change})
								</p>
								<Chain links={finding.chain} />
							</li>
						))}
					</ol>
				)}
				{result.findings.length > 15 && (
					<button
						type="button"
						className={`mt-2 ${buttonClass}`}
						onClick={() => setAllFindings(!allFindings)}
					>
						{allFindings
							? "Show the first 15"
							: `Show all ${result.findings.length}`}
					</button>
				)}
			</div>
			{result.tests.recommended.length > 0 && (
				<div>
					<h4 className="font-semibold">Recommended tests (not run)</h4>
					<ul className="mt-1.5 space-y-0.5">
						{result.tests.recommended.map((test) => (
							<li key={`${test.path}:${test.name}`}>
								<span className="font-medium">{test.name}</span>{" "}
								<span className="text-ink-3">
									({test.state}) {test.reason}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{result.review_actions.length > 0 && (
				<div>
					<h4 className="font-semibold">Review actions</h4>
					<ul className="mt-1.5 list-disc space-y-1 pl-5">
						{result.review_actions.map((action) => (
							<li key={action.action} className="max-w-[68ch]">
								{action.action}{" "}
								<span className="text-ink-3 text-xs">
									({action.basis}
									{action.refs.length > 0 && `: ${action.refs.join(", ")}`})
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
			<details>
				<summary className="inline-flex cursor-pointer items-center gap-1.5 rounded font-semibold hover:text-ink">
					<Chevron />
					Files ({result.files.length})
				</summary>
				<ul className="mt-2 divide-y divide-line border-line border-y">
					{result.files.map((file) => (
						<li
							key={file.path}
							className="flex flex-wrap items-center gap-x-3 py-1.5"
						>
							<StateBadge value={file.status} />
							<code className="break-all text-xs">{file.path}</code>
							<span className="flex gap-x-3 text-ink-3 text-xs">
								<span>{humanize(file.category)}</span>
								{file.additions !== null && (
									<span className="tabular-nums">
										+{file.additions} −{file.deletions}
									</span>
								)}
							</span>
						</li>
					))}
				</ul>
			</details>
			<Limitations items={result.limitations} />
		</div>
	);
}

/** A stored result that does not match the shared contract is reported, never guessed at. */
export function StoredImpact({ value }: { value: unknown }) {
	const parsed = parseImpact(value);
	if (!parsed.success)
		return (
			<p className="text-warning">
				The stored impact result does not match the expected format and is not
				shown.
			</p>
		);
	return <PatchImpactView result={parsed.data} />;
}

export function PatchAnalysisPage() {
	const repo = useRepository();
	const { analysisId = "" } = useParams();
	const valid = idSchema("pia").safeParse(analysisId).success;
	const queryClient = useQueryClient();
	const analysis = useQuery({
		queryKey: ["patch-impact", analysisId],
		queryFn: () => getPatchAnalysis(analysisId),
		enabled: valid,
		refetchInterval: (query) =>
			ANALYSIS_ACTIVE.has(query.state.data?.status ?? "") ? POLL_MS : false,
	});
	const cancel = useMutation({
		mutationFn: () => cancelPatchAnalysis(analysisId),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["patch-impact", analysisId] }),
	});
	if (!valid) return <p className="mt-6">Not a patch analysis ID.</p>;
	return (
		<div className="mt-6">
			<Breadcrumbs
				items={[
					{
						key: "impact",
						label: "Impact",
						to: `/repositories/${repo.id}/impact`,
					},
					{ key: "analysis", label: "Patch impact" },
				]}
			/>
			<QueryView query={analysis} what="Patch analysis">
				{(data) => (
					<div className="mt-3 space-y-5">
						<title>{`Patch impact · ${repo.name} · Tracera`}</title>
						<div>
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
								<h2 className="font-semibold text-xl tracking-tight">
									Patch impact
								</h2>
								<StateBadge value={data.status} />
							</div>
							<p className="mt-1 text-ink-3 text-xs">
								Static analysis; no model was called and nothing was executed.
							</p>
						</div>
						<Facts
							items={[
								[
									"Base",
									<code key="base" className="break-all text-xs">
										{data.base.ref ?? data.base.sha}
									</code>,
								],
								[
									data.merge_base ? "Head (merge base)" : "Head",
									<span key="head" className="break-all text-xs">
										{describeHead(data)}
									</span>,
								],
								["Requested", <Time key="created" iso={data.created_at} />],
							]}
						/>
						{ANALYSIS_ACTIVE.has(data.status) && (
							<div className="flex flex-wrap items-center gap-3">
								<p role="status" className="text-sm">
									{data.progress
										? `Phase ${humanize(data.progress.phase)}…`
										: "Queued…"}
								</p>
								<button
									type="button"
									className={buttonClass}
									disabled={
										cancel.isPending || data.cancel_requested_at !== null
									}
									onClick={() => cancel.mutate()}
								>
									{data.cancel_requested_at
										? "Cancellation requested"
										: "Cancel"}
								</button>
							</div>
						)}
						{cancel.error && (
							<ErrorNotice
								alert
								title="Cancellation failed"
								error={cancel.error}
							/>
						)}
						{data.error && (
							<p className="border-error border-l-2 pl-3 text-error text-sm">
								<code>{data.error.code}</code>: {data.error.message}
								{data.error.retryable &&
									" (retryable: request the same analysis again)"}
							</p>
						)}
						{data.result !== null ? (
							<StoredImpact value={data.result} />
						) : !ANALYSIS_ACTIVE.has(data.status) ? (
							<p className="text-ink-3 text-sm">No result was stored.</p>
						) : (
							<Loading>Waiting for the analysis…</Loading>
						)}
					</div>
				)}
			</QueryView>
		</div>
	);
}
