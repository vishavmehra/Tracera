import { useQuery } from "@tanstack/react-query";
import { idSchema } from "@tracera/contracts";
import { type FormEvent, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
	ApiError,
	analyzeImpact,
	getNode,
	nodeHistory,
	searchRepository,
	traceNode,
} from "./api.ts";
import { ImpactResults } from "./impact.tsx";
import { useRepository } from "./repository.tsx";
import type { GraphEdge, GraphNode } from "./schemas.ts";
import {
	Badge,
	Breadcrumbs,
	buttonClass,
	CodeBlock,
	Empty,
	ErrorNotice,
	EvidenceView,
	Facts,
	humanize,
	inputClass,
	Limitations,
	Loading,
	labelClass,
	linkClass,
	location,
	NotIndexed,
	notIndexed,
	primaryButtonClass,
	QueryView,
	Section,
	Sha,
	Status,
} from "./ui.tsx";

const nodePath = (repositoryId: string, nodeId: string) =>
	`/repositories/${repositoryId}/nodes/${nodeId}`;

export function ExplorePage() {
	const repo = useRepository();
	const [params, setParams] = useSearchParams();
	const q = params.get("q") ?? "";
	const search = useQuery({
		queryKey: ["repositories", repo.id, "search", q],
		queryFn: () => searchRepository(repo.id, q),
		enabled: q.length >= 2,
	});
	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const value = String(
			new FormData(event.currentTarget).get("q") ?? "",
		).trim();
		setParams(value ? { q: value } : {});
	};
	return (
		<Section title="Search the code graph" id="search-heading">
			<form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
				<div className="min-w-0 flex-1 basis-60">
					<label htmlFor="q" className={labelClass}>
						Symbol, file, route, table, or text
					</label>
					<input
						id="q"
						name="q"
						defaultValue={q}
						key={q}
						minLength={2}
						maxLength={100}
						required
						className={`${inputClass} font-mono`}
					/>
				</div>
				<button type="submit" className={primaryButtonClass}>
					Search
				</button>
			</form>
			<div className="mt-4">
				{q.length < 2 ? (
					<p className="text-ink-3 text-sm">
						Search ranks named entities and paths first, then text matches from
						the indexed snapshot. Open a result to see its relationships, flow,
						history, and impact.
					</p>
				) : notIndexed(search.error) ? (
					<NotIndexed />
				) : search.error ? (
					<ErrorNotice
						title="Search failed"
						error={search.error}
						onRetry={() => void search.refetch()}
					/>
				) : !search.data ? (
					<Loading>Searching…</Loading>
				) : (
					<>
						<p role="status" className="text-ink-3 text-sm">
							{search.data.results.length} result
							{search.data.results.length === 1 ? "" : "s"}
							{search.data.truncated && " (truncated)"} in snapshot{" "}
							<Sha sha={search.data.snapshot.commit_sha} />
						</p>
						{search.data.results.length === 0 ? (
							<div className="mt-3">
								<Empty>Nothing in this snapshot matches “{q}”.</Empty>
							</div>
						) : (
							<ul className="mt-3 divide-y divide-line border-line border-y">
								{search.data.results.map((result) => (
									<li
										key={`${result.node?.id ?? ""}${result.evidence.path}:${result.evidence.start_line}`}
										className="space-y-2 py-3 text-sm"
									>
										<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
											<Badge tone="neutral">
												{humanize(result.match.kind)}
											</Badge>
											{result.node ? (
												<Link
													to={nodePath(repo.id, result.node.id)}
													className={`font-medium ${linkClass} break-all`}
												>
													{result.node.name}
												</Link>
											) : null}
											<code className="break-all text-ink-2 text-xs">
												{location(
													result.evidence.path,
													result.evidence.start_line,
													result.evidence.end_line,
												)}
											</code>
											<span className="text-ink-3 text-xs">
												{humanize(result.match.reason)}
											</span>
										</p>
										{result.evidence.excerpt && (
											<CodeBlock
												text={result.evidence.excerpt}
												startLine={result.evidence.start_line}
												endLine={result.evidence.end_line}
											/>
										)}
									</li>
								))}
							</ul>
						)}
						<Limitations
							items={[
								...search.data.limitations,
								...(search.data.semantic && !search.data.semantic.available
									? [search.data.semantic.reason]
									: []),
							]}
						/>
					</>
				)}
			</div>
		</Section>
	);
}

function EdgeList({
	repositoryId,
	edges,
	direction,
	truncated,
}: {
	repositoryId: string;
	edges: GraphEdge[];
	direction: "outgoing" | "incoming";
	truncated: boolean;
}) {
	if (edges.length === 0)
		return <p className="text-ink-3 text-sm">None recorded.</p>;
	return (
		<>
			<ul className="divide-y divide-line border-line border-y text-sm">
				{edges.map((edge) => {
					const otherId =
						direction === "outgoing" ? edge.to_node_id : edge.from_node_id;
					const otherKey =
						direction === "outgoing"
							? (edge.to_key ?? edge.target_text ?? "(unresolved)")
							: edge.from_key;
					return (
						<li
							key={edge.id}
							className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-x-3 py-1.5"
						>
							<code className="text-ink-3 text-xs">{edge.kind}</code>
							{otherId ? (
								<Link
									to={nodePath(repositoryId, otherId)}
									className={`${linkClass} break-all`}
								>
									{otherKey}
								</Link>
							) : (
								<span className="break-all">{otherKey}</span>
							)}
							{edge.certainty === "exact" ? (
								<span />
							) : (
								<Status
									tone={edge.certainty === "resolved" ? "info" : "uncertain"}
									title={edge.certainty}
								>
									{humanize(edge.certainty)}
								</Status>
							)}
						</li>
					);
				})}
			</ul>
			{truncated && (
				<p className="mt-1 text-ink-3 text-xs">Only the first 100 are shown.</p>
			)}
		</>
	);
}

function NodeLink({
	repositoryId,
	node,
}: {
	repositoryId: string;
	node: GraphNode;
}) {
	return (
		<Link
			to={nodePath(repositoryId, node.id)}
			className={`${linkClass} break-all`}
		>
			{node.name}
		</Link>
	);
}

function TracePanel({
	repositoryId,
	nodeId,
}: {
	repositoryId: string;
	nodeId: string;
}) {
	const [direction, setDirection] = useState<"downstream" | "upstream" | null>(
		null,
	);
	const trace = useQuery({
		queryKey: ["trace", nodeId, direction],
		queryFn: () => traceNode(nodeId, direction ?? "downstream"),
		enabled: direction !== null,
	});
	return (
		<div className="text-sm">
			<div className="flex flex-wrap gap-2">
				<button
					type="button"
					className={buttonClass}
					aria-pressed={direction === "downstream"}
					onClick={() => setDirection("downstream")}
				>
					Trace downstream
				</button>
				<button
					type="button"
					className={buttonClass}
					aria-pressed={direction === "upstream"}
					onClick={() => setDirection("upstream")}
				>
					Trace upstream
				</button>
			</div>
			{direction && (
				<div className="mt-3">
					<QueryView query={trace} what="Flow trace">
						{(data) => (
							<>
								<p role="status" className="text-ink-3">
									{data.nodes.length} nodes, {data.edges.length} edges{" "}
									{data.direction}
									{data.truncated && " (truncated)"}.
								</p>
								<ol className="relative mt-3 before:absolute before:top-2 before:bottom-2 before:left-[7.5px] before:w-px before:bg-trace">
									{data.nodes.map((node) => (
										<li
											key={node.id}
											className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1"
										>
											<span
												aria-hidden="true"
												className="grid size-4 shrink-0 place-items-center"
											>
												<span
													className={`size-2.5 rounded-full ring-[3px] ring-canvas ${node.distance === 0 ? "bg-accent" : "bg-trace-done"}`}
												/>
											</span>
											<span className="sr-only">Distance {node.distance}:</span>
											<Badge tone="neutral">{node.kind}</Badge>
											<NodeLink repositoryId={repositoryId} node={node} />
											<code className="break-all text-ink-3 text-xs">
												{location(node.path, node.start_line, node.end_line)}
											</code>
											{node.distance > 0 && (
												<span
													aria-hidden="true"
													className="text-ink-3 text-xs tabular-nums"
												>
													{node.distance} {node.distance === 1 ? "hop" : "hops"}
												</span>
											)}
										</li>
									))}
								</ol>
								{data.gaps.length > 0 && (
									<div className="mt-3">
										<h4 className="font-medium">Gaps (not bridged)</h4>
										<ul className="mt-1 list-disc space-y-0.5 pl-5">
											{data.gaps.map((gap) => (
												<li
													key={`${gap.from_key}:${gap.kind}:${gap.target_text}`}
												>
													<code className="break-all">{gap.from_key}</code>:{" "}
													{gap.reason}
												</li>
											))}
										</ul>
									</div>
								)}
								<Limitations items={data.limitations} />
							</>
						)}
					</QueryView>
				</div>
			)}
		</div>
	);
}

function HistoryPanel({ nodeId }: { nodeId: string }) {
	const [open, setOpen] = useState(false);
	const history = useQuery({
		queryKey: ["history", nodeId],
		queryFn: () => nodeHistory(nodeId),
		enabled: open,
	});
	return (
		<div className="text-sm">
			{!open ? (
				<button
					type="button"
					className={buttonClass}
					onClick={() => setOpen(true)}
				>
					Load history and ownership
				</button>
			) : history.error instanceof ApiError &&
				history.error.code === "history_unavailable" ? (
				<p>History is not available for a node without a file.</p>
			) : (
				<QueryView query={history} what="History">
					{(data) => (
						<div className="space-y-4">
							<div>
								<h4 className="font-medium">
									Commits{" "}
									<span className="font-normal text-ink-3">
										({data.history.method})
									</span>
								</h4>
								{data.history.commits.length === 0 ? (
									<p className="text-ink-3">
										No commits found in the indexed window.
									</p>
								) : (
									<ul className="mt-1.5 divide-y divide-line border-line border-y">
										{data.history.commits.map((commit) => (
											<li
												key={commit.sha}
												className="grid gap-x-4 py-1.5 sm:grid-cols-[7.5rem_6rem_9rem_minmax(0,1fr)]"
											>
												<Sha sha={commit.sha} />
												<span className="text-ink-3 tabular-nums">
													{commit.date.slice(0, 10)}
												</span>
												<span className="truncate">{commit.author}</span>
												<span className="min-w-0 break-words">
													{commit.subject}
												</span>
											</li>
										))}
									</ul>
								)}
							</div>
							<div>
								<h4 className="font-medium">
									Last changed by{" "}
									<span className="font-normal text-ink-3">
										({data.blame.method}, {data.blame.lines} lines)
									</span>
								</h4>
								<ul className="mt-1 space-y-1">
									{data.blame.commits.map((commit) => (
										<li key={commit.sha} className="flex flex-wrap gap-x-2">
											<span>{commit.author}</span>
											<span className="text-ink-3">{commit.lines} lines</span>
											<Sha sha={commit.sha} />
											<span className="min-w-0 break-words text-ink-2">
												{commit.summary}
											</span>
										</li>
									))}
								</ul>
							</div>
							<div>
								<h4 className="font-medium">Declared owners (CODEOWNERS)</h4>
								{data.owners.length === 0 ? (
									<p className="text-ink-3">
										No CODEOWNERS entry covers this file.
									</p>
								) : (
									<ul className="mt-1 space-y-0.5">
										{data.owners.map((owner) => (
											<li key={owner.owner}>
												{owner.owner}
												{owner.pattern && (
													<span className="text-ink-3">
														{" "}
														via <code>{owner.pattern}</code>
													</span>
												)}
											</li>
										))}
									</ul>
								)}
							</div>
							<Limitations items={data.limitations} />
						</div>
					)}
				</QueryView>
			)}
		</div>
	);
}

function NodeImpactPanel({
	repositoryId,
	nodeId,
}: {
	repositoryId: string;
	nodeId: string;
}) {
	const [open, setOpen] = useState(false);
	const impact = useQuery({
		queryKey: ["impact", repositoryId, nodeId],
		queryFn: () =>
			analyzeImpact(repositoryId, {
				targets: [{ kind: "node", id: nodeId }],
				depth: 6,
				limit: 150,
			}),
		enabled: open,
	});
	return (
		<div className="text-sm">
			{!open ? (
				<button
					type="button"
					className={buttonClass}
					onClick={() => setOpen(true)}
				>
					Analyze change impact
				</button>
			) : (
				<QueryView query={impact} what="Change impact">
					{(data) => <ImpactResults repositoryId={repositoryId} data={data} />}
				</QueryView>
			)}
		</div>
	);
}

export function NodePage() {
	const repo = useRepository();
	const { nodeId = "" } = useParams();
	const valid = idSchema("gnd").safeParse(nodeId).success;
	const node = useQuery({
		queryKey: ["node", nodeId],
		queryFn: () => getNode(nodeId),
		enabled: valid,
	});
	if (!valid)
		return (
			<p className="mt-6">
				<code className="break-all">{nodeId}</code> is not a graph node ID.
			</p>
		);
	return (
		<div className="mt-6">
			<Breadcrumbs
				items={[
					{
						key: "search",
						label: "Search",
						to: `/repositories/${repo.id}/explore`,
					},
					{ key: "node", label: node.data?.node.name ?? "Graph node" },
				]}
			/>
			<QueryView query={node} what="Graph node">
				{(data) => (
					<>
						<title>{`${data.node.name} · ${repo.name} · Tracera`}</title>
						<div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
							<h2 className="break-all font-semibold text-xl tracking-tight">
								{data.node.name}
							</h2>
							<Badge tone="neutral">{data.node.kind}</Badge>
						</div>
						<Facts
							className="mt-3"
							items={[
								[
									"Key",
									<code key="key" className="break-all text-xs">
										{data.node.key}
									</code>,
								],
								[
									"Snapshot",
									<Sha key="snapshot" sha={data.snapshot.commit_sha} />,
								],
							]}
						/>
						<div className="mt-5">
							<EvidenceView evidence={data.evidence} />
						</div>
						<div className="mt-8 grid gap-x-10 gap-y-6 md:grid-cols-2">
							<div className="min-w-0">
								<h3 className="mb-2 font-semibold text-sm">
									Outgoing ({data.outgoing.length})
								</h3>
								<EdgeList
									repositoryId={repo.id}
									edges={data.outgoing}
									direction="outgoing"
									truncated={data.truncated.outgoing}
								/>
							</div>
							<div className="min-w-0">
								<h3 className="mb-2 font-semibold text-sm">
									Incoming ({data.incoming.length})
								</h3>
								<EdgeList
									repositoryId={repo.id}
									edges={data.incoming}
									direction="incoming"
									truncated={data.truncated.incoming}
								/>
							</div>
						</div>
						<Section title="Flow" id="flow-heading">
							<TracePanel repositoryId={repo.id} nodeId={data.node.id} />
						</Section>
						<Section title="History and ownership" id="history-heading">
							<HistoryPanel nodeId={data.node.id} />
						</Section>
						<Section title="Change impact" id="node-impact-heading">
							<NodeImpactPanel repositoryId={repo.id} nodeId={data.node.id} />
						</Section>
					</>
				)}
			</QueryView>
		</div>
	);
}
