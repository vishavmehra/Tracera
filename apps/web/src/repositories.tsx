import {
	keepPreviousData,
	type UseQueryResult,
	useQuery,
} from "@tanstack/react-query";
import type { SnapshotStatus } from "@tracera/contracts";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ApiError, getProfile, listRepositories } from "./api.ts";
import { POLL_MS, useIsOwner } from "./hooks.ts";
import type { Profile, Repository, RepositoryIndex } from "./schemas.ts";
import {
	CoverageFacts,
	Empty,
	ErrorNotice,
	FreshnessFacts,
	IndexProgressView,
	isActive,
	primaryButtonClass,
	Sha,
	SnapshotError,
	StatusBadge,
	Time,
} from "./ui.tsx";

export { POLL_MS };

export const SOURCE_LABELS: Record<string, string> = {
	local_path: "Local path",
	fixture: "Fixture",
	git_url: "Git URL",
};

/**
 * Coverage and freshness of the newest usable snapshot. The key carries the newest snapshot's ID and
 * status, so the profile is fetched again when indexing finishes, not on every progress poll.
 */
export function useProfile(
	repositoryId: string,
	newest: { id: string; status: SnapshotStatus } | null,
	/** Whether a ready or partial snapshot is known; without one the API can only answer 409. */
	usable: boolean,
) {
	return useQuery({
		queryKey: [
			"repositories",
			repositoryId,
			"profile",
			newest?.id,
			newest?.status,
		],
		queryFn: () => getProfile(repositoryId),
		enabled: newest !== null && usable,
		placeholderData: keepPreviousData,
	});
}

export function Facet({
	title,
	wide = false,
	children,
}: {
	title: string;
	wide?: boolean;
	children: ReactNode;
}) {
	return (
		<div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
			<h3 className="font-medium text-ink-2 text-xs">{title}</h3>
			<div className="mt-1.5 space-y-1.5 text-sm">{children}</div>
		</div>
	);
}

/** Announces status and phase changes to screen readers; progress counts are read from the bar. */
export function Announcer({ text }: { text: string }) {
	return (
		<p role="status" className="sr-only">
			{text}
		</p>
	);
}

export const announcement = (
	name: string,
	snapshot: Pick<RepositoryIndex, "status" | "progress"> | null,
) =>
	snapshot
		? `${name}: ${snapshot.status}${snapshot.progress ? `, ${snapshot.progress.phase}` : ""}`
		: `${name}: no snapshot`;

function LatestSnapshot({ index }: { index: RepositoryIndex | null }) {
	if (!index) return <p>No snapshot yet.</p>;
	return (
		<>
			<p className="flex flex-wrap items-center gap-2">
				<StatusBadge status={index.status} />
				<span>
					commit <Sha sha={index.commit_sha} />
				</span>
			</p>
			{index.progress && <IndexProgressView progress={index.progress} />}
			{index.error && <SnapshotError error={index.error} />}
			<p className="text-ink-3 text-xs">
				{index.finished_at ? (
					<>
						Finished <Time iso={index.finished_at} />
					</>
				) : (
					<>
						Requested <Time iso={index.created_at} />
					</>
				)}
			</p>
		</>
	);
}

export function GraphFacets({
	hasSnapshot,
	usable,
	profile,
	detailed = false,
}: {
	hasSnapshot: boolean;
	usable: boolean;
	profile: UseQueryResult<Profile>;
	detailed?: boolean;
}) {
	const title = "Coverage and freshness";
	if (!hasSnapshot)
		return (
			<Facet title={title} wide>
				<p>Not available: the repository has no snapshot.</p>
			</Facet>
		);
	if (!usable)
		return (
			<Facet title={title} wide>
				<p>
					Shown once a snapshot finishes as <code>ready</code> or{" "}
					<code>partial</code>.
				</p>
			</Facet>
		);
	if (profile.error)
		return (
			<Facet title={title} wide>
				{profile.error instanceof ApiError &&
				profile.error.code === "graph_not_indexed" ? (
					<p>
						No usable snapshot yet: none has finished as <code>ready</code> or{" "}
						<code>partial</code> (<code>graph_not_indexed</code>).
					</p>
				) : (
					<ErrorNotice
						title="Coverage and freshness could not be loaded"
						error={profile.error}
						onRetry={() => void profile.refetch()}
					/>
				)}
			</Facet>
		);
	if (!profile.data)
		return (
			<Facet title={title} wide>
				<p className="text-ink-3">Loading coverage and freshness…</p>
			</Facet>
		);
	const { snapshot, coverage, freshness, latest_snapshot } = profile.data;
	const parseFailures = coverage?.parse_failures ?? [];
	const notes = coverage?.notes ?? [];
	return (
		<>
			<Facet title="Coverage">
				<p className="text-ink-3 text-xs">
					Snapshot <Sha sha={snapshot.commit_sha} /> ({snapshot.status}), the
					newest usable one.
					{latest_snapshot && ` A newer snapshot is ${latest_snapshot.status}.`}
				</p>
				{coverage ? (
					<CoverageFacts coverage={coverage} detailed={detailed} />
				) : (
					<p>Coverage was not recorded for this snapshot.</p>
				)}
			</Facet>
			<Facet title="Freshness">
				<FreshnessFacts freshness={freshness} detailed={detailed} />
			</Facet>
			{detailed && parseFailures.length > 0 && (
				<Facet title={`Parse failures (${parseFailures.length} listed)`} wide>
					<ul className="space-y-1">
						{parseFailures.map((failure) => (
							<li key={`${failure.path}:${failure.line}`} className="break-all">
								<code>
									{failure.path}
									{failure.line !== null && `:${failure.line}`}
								</code>{" "}
								<span className="break-words text-ink-2">
									{failure.message}
								</span>
							</li>
						))}
					</ul>
				</Facet>
			)}
			{detailed && notes.length > 0 && (
				<Facet title="Indexer notes" wide>
					<ul className="list-disc space-y-1 pl-5">
						{notes.map((note) => (
							<li key={note}>{note}</li>
						))}
					</ul>
				</Facet>
			)}
		</>
	);
}

function RepositoryRow({ repository }: { repository: Repository }) {
	const { index } = repository;
	// The newest snapshot alone cannot tell whether an older one is usable, so the profile is asked
	// (it answers 409 graph_not_indexed when none is); the repository page knows all snapshots.
	const usable = index !== null;
	const profile = useProfile(
		repository.id,
		index && { id: index.snapshot_id, status: index.status },
		usable,
	);
	return (
		<li className="py-5">
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<h2 className="font-semibold text-[15px]">
					<Link
						to={`/repositories/${repository.id}`}
						className="text-ink underline-offset-2 hover:text-link hover:underline"
					>
						{repository.name}
					</Link>
				</h2>
				<p className="text-ink-3 text-xs">
					{SOURCE_LABELS[repository.source_type] ?? repository.source_type},
					branch <code>{repository.default_branch}</code>
					{repository.synthetic && ", synthetic fixture"}
				</p>
			</div>
			<div className="mt-3 grid gap-x-10 gap-y-4 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,1fr)]">
				<Facet title="Latest snapshot">
					<LatestSnapshot index={index} />
				</Facet>
				<GraphFacets
					hasSnapshot={index !== null}
					usable={usable}
					profile={profile}
				/>
			</div>
			<Announcer text={announcement(repository.name, index)} />
		</li>
	);
}

export function RepositoriesPage() {
	const repositories = useQuery({
		queryKey: ["repositories"],
		queryFn: listRepositories,
		refetchInterval: (query) =>
			query.state.data?.items.some((repository) =>
				isActive(repository.index?.status),
			)
				? POLL_MS
				: false,
	});
	const owner = useIsOwner();
	let content: ReactNode;
	if (repositories.error)
		content = (
			<ErrorNotice
				title="Repositories could not be loaded"
				error={repositories.error}
				onRetry={() => void repositories.refetch()}
			/>
		);
	else if (!repositories.data)
		content = <p role="status">Loading repositories…</p>;
	else if (repositories.data.items.length === 0)
		content = (
			<Empty>
				<p className="font-medium text-ink">
					No repositories in this workspace yet.
				</p>
				<p className="mt-1">
					{owner ? (
						<>
							<Link to="/repositories/new" className="text-link underline">
								Register a repository
							</Link>{" "}
							(a local git work tree or the Bench Shop fixture) to build its
							graph.
						</>
					) : (
						"A workspace owner registers repositories; ask an owner to add one."
					)}
				</p>
			</Empty>
		);
	else
		content = (
			<>
				<ul className="divide-y divide-line border-line border-b">
					{repositories.data.items.map((repository) => (
						<RepositoryRow key={repository.id} repository={repository} />
					))}
				</ul>
				{repositories.data.next_cursor !== null && (
					<p className="text-ink-3 text-sm">
						The API returned more repositories than this page shows.
					</p>
				)}
			</>
		);
	return (
		<>
			<title>Repositories · Tracera</title>
			<div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-line border-b pb-5">
				<div className="max-w-2xl">
					<h1 className="font-semibold text-2xl tracking-tight">
						Repositories
					</h1>
					<p className="mt-1.5 text-ink-2 text-sm">
						Snapshot status, graph coverage, and freshness as the API reports
						them.
					</p>
				</div>
				{owner && (
					<Link to="/repositories/new" className={primaryButtonClass}>
						Register repository
					</Link>
				)}
			</div>
			<div className="mt-2">{content}</div>
		</>
	);
}
