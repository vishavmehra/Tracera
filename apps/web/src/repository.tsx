import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { idSchema } from "@tracera/contracts";
import { type FormEvent, useState } from "react";
import {
	NavLink,
	Outlet,
	useLocation,
	useNavigate,
	useOutletContext,
	useParams,
} from "react-router";
import {
	ApiError,
	cancelSnapshot,
	getRepository,
	listSnapshots,
	registerRepository,
	requestIndex,
} from "./api.ts";
import { POLL_MS, useSession } from "./hooks.ts";
import {
	Announcer,
	announcement,
	Facet,
	GraphFacets,
	SOURCE_LABELS,
	useProfile,
} from "./repositories.tsx";
import type { Repository, Snapshot } from "./schemas.ts";
import {
	Breadcrumbs,
	buttonClass,
	Empty,
	ErrorNotice,
	elapsed,
	Facts,
	formatDuration,
	hintClass,
	IndexProgressView,
	inputClass,
	isActive,
	Loading,
	labelClass,
	panelClass,
	primaryButtonClass,
	Section,
	Sha,
	SnapshotError,
	StatusBadge,
	Time,
} from "./ui.tsx";

// Tabs are a selection within the repository: the selected one carries an orchid edge.
const tabClass = ({ isActive }: { isActive: boolean }) =>
	`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
		isActive
			? "border-accent font-medium text-ink"
			: "border-transparent text-ink-3 hover:border-line-strong hover:text-ink"
	}`;

/** The repository header and its sections; each section reads the repository from the outlet context. */
export function RepositoryLayout() {
	const { repositoryId = "" } = useParams();
	const valid = idSchema("repo").safeParse(repositoryId).success;
	const { pathname } = useLocation();
	const repository = useQuery({
		queryKey: ["repositories", repositoryId],
		queryFn: () => getRepository(repositoryId),
		enabled: valid,
		// The header shows the newest snapshot's status; keep it current while indexing.
		refetchInterval: (query) =>
			isActive(query.state.data?.index?.status) ? POLL_MS : false,
	});
	const crumbs = (name: string) => (
		<Breadcrumbs
			items={[
				{ key: "list", label: "Repositories", to: "/" },
				{ key: "repo", label: name },
			]}
		/>
	);
	if (!valid || repository.error) {
		const heading =
			!valid ||
			(repository.error instanceof ApiError && repository.error.status === 404)
				? "Repository not found"
				: "Repository unavailable";
		return (
			<>
				<title>{`${heading} · Tracera`}</title>
				{crumbs(heading)}
				<h1 className="mt-3 mb-4 font-semibold text-2xl tracking-tight">
					{heading}
				</h1>
				{repository.error ? (
					<ErrorNotice
						title="This repository could not be loaded"
						error={repository.error}
						onRetry={() => void repository.refetch()}
					/>
				) : (
					<p>
						<code className="break-all">{repositoryId}</code> is not a
						repository ID.
					</p>
				)}
			</>
		);
	}
	if (!repository.data) return <Loading>Loading repository…</Loading>;
	const repo = repository.data;
	const base = `/repositories/${repo.id}`;
	return (
		<>
			<title>{`${repo.name} · Tracera`}</title>
			{crumbs(repo.name)}
			<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
				<h1 className="break-all font-semibold text-2xl tracking-tight">
					{repo.name}
				</h1>
				{repo.index && <StatusBadge status={repo.index.status} />}
			</div>
			<Facts
				className="mt-4"
				items={[
					[
						SOURCE_LABELS[repo.source_type] ?? repo.source_type,
						<code key="source" className="break-all text-[13px]">
							{repo.source_display}
						</code>,
					],
					[
						"Default branch",
						<span key="branch">
							<code className="text-[13px]">{repo.default_branch}</code>
							{repo.synthetic && (
								<span className="text-ink-3"> (synthetic fixture)</span>
							)}
						</span>,
					],
				]}
			/>
			<nav
				aria-label="Repository sections"
				className="mt-6 flex overflow-x-auto border-line border-b"
			>
				<NavLink to={base} end className={tabClass}>
					Overview
				</NavLink>
				<NavLink
					to={`${base}/explore`}
					className={({ isActive }) =>
						tabClass({ isActive: isActive || pathname.includes("/nodes/") })
					}
				>
					Explore
				</NavLink>
				<NavLink to={`${base}/questions`} className={tabClass}>
					Questions
				</NavLink>
				<NavLink
					to={`${base}/impact`}
					className={({ isActive }) =>
						tabClass({
							isActive: isActive || pathname.includes("/patch-impact/"),
						})
					}
				>
					Impact
				</NavLink>
			</nav>
			<Outlet context={repo} />
		</>
	);
}

/** The repository a section belongs to (set by RepositoryLayout). */
export const useRepository = () => useOutletContext<Repository>();

function IndexActions({
	repositoryId,
	newest,
}: {
	repositoryId: string;
	newest: Snapshot | null;
}) {
	const queryClient = useQueryClient();
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["repositories", repositoryId] });
	const index = useMutation({
		mutationFn: () => requestIndex(repositoryId),
		onSuccess: refresh,
	});
	const cancel = useMutation({
		mutationFn: (snapshotId: string) => cancelSnapshot(snapshotId),
		onSuccess: refresh,
	});
	const active = newest !== null && isActive(newest.status);
	const retry = newest?.status === "failed" || newest?.status === "cancelled";
	return (
		<div className="space-y-2">
			{active ? (
				<button
					type="button"
					className={buttonClass}
					disabled={cancel.isPending || newest.cancel_requested_at !== null}
					onClick={() => cancel.mutate(newest.id)}
				>
					{newest.cancel_requested_at
						? "Cancellation requested"
						: cancel.isPending
							? "Cancelling…"
							: "Cancel indexing"}
				</button>
			) : (
				<button
					type="button"
					className={primaryButtonClass}
					disabled={index.isPending}
					onClick={() => index.mutate()}
				>
					{index.isPending
						? "Requesting…"
						: retry
							? "Retry indexing"
							: newest
								? "Index default branch"
								: "Index now"}
				</button>
			)}
			{index.data && (
				<p role="status" className="text-ink-2 text-sm">
					Snapshot for <Sha sha={index.data.snapshot.commit_sha} /> is{" "}
					{index.data.snapshot.status}
					{index.data.snapshot.status === "ready" ||
					index.data.snapshot.status === "partial"
						? " (this commit was already indexed)."
						: "."}
				</p>
			)}
			{index.error && (
				<ErrorNotice
					alert
					title="Indexing could not be requested"
					error={index.error}
				/>
			)}
			{cancel.error && (
				<ErrorNotice alert title="Cancellation failed" error={cancel.error} />
			)}
		</div>
	);
}

export function RepositoryOverview() {
	const repo = useRepository();
	const snapshots = useQuery({
		queryKey: ["repositories", repo.id, "snapshots"],
		queryFn: () => listSnapshots(repo.id),
		refetchInterval: (query) =>
			query.state.data?.some((snapshot) => isActive(snapshot.status))
				? POLL_MS
				: false,
	});
	const newest = snapshots.data?.[0] ?? null;
	const usable =
		snapshots.data?.some(
			(s) => s.status === "ready" || s.status === "partial",
		) ?? false;
	const profile = useProfile(repo.id, newest, usable);
	return (
		<>
			<Section
				title="Graph"
				id="graph-heading"
				actions={
					snapshots.data && (
						<IndexActions repositoryId={repo.id} newest={newest} />
					)
				}
			>
				<div className="grid gap-x-12 gap-y-6 sm:grid-cols-2">
					{snapshots.error ? (
						<Facet title="Coverage and freshness" wide>
							<p>Not available until the snapshots load.</p>
						</Facet>
					) : snapshots.data ? (
						<GraphFacets
							hasSnapshot={newest !== null}
							usable={usable}
							profile={profile}
							detailed
						/>
					) : (
						<Facet title="Coverage and freshness" wide>
							<p className="text-ink-3">Loading…</p>
						</Facet>
					)}
				</div>
			</Section>

			<Section title="Recent snapshots" id="snapshots-heading">
				{snapshots.error ? (
					<ErrorNotice
						title="Snapshots could not be loaded"
						error={snapshots.error}
						onRetry={() => void snapshots.refetch()}
					/>
				) : !snapshots.data ? (
					<Loading>Loading snapshots…</Loading>
				) : snapshots.data.length === 0 ? (
					<Empty>
						No snapshots yet. Index the default branch to build the graph.
					</Empty>
				) : (
					<ol className="-mt-4 divide-y divide-line border-line border-b">
						{snapshots.data.map((snapshot) => {
							const took = elapsed(snapshot.started_at, snapshot.finished_at);
							return (
								<li
									key={snapshot.id}
									className="grid gap-x-6 gap-y-1.5 py-3 text-sm sm:grid-cols-[7rem_minmax(0,1fr)_auto]"
								>
									<div>
										<StatusBadge status={snapshot.status} />
									</div>
									<div className="min-w-0 space-y-1.5">
										<p className="flex flex-wrap items-baseline gap-x-3">
											<span className="break-all">
												<code>{snapshot.ref}</code> at{" "}
												<Sha sha={snapshot.commit_sha} />
											</span>
											<span className="text-ink-3 text-xs">
												Extractor {snapshot.extractor_version}
											</span>
										</p>
										{snapshot.progress && (
											<IndexProgressView progress={snapshot.progress} />
										)}
										{snapshot.cancel_requested_at && (
											<p>
												Cancellation requested{" "}
												<Time iso={snapshot.cancel_requested_at} />
											</p>
										)}
										{snapshot.error && <SnapshotError error={snapshot.error} />}
									</div>
									<p className="flex flex-wrap gap-x-4 text-ink-3 text-xs sm:flex-col sm:items-end sm:gap-0.5">
										<span>
											Requested <Time iso={snapshot.created_at} />
										</span>
										{snapshot.finished_at ? (
											<span>
												Finished <Time iso={snapshot.finished_at} />
												{took !== null && ` in ${formatDuration(took)}`}
											</span>
										) : (
											snapshot.started_at && (
												<span>
													Started <Time iso={snapshot.started_at} />
												</span>
											)
										)}
									</p>
								</li>
							);
						})}
					</ol>
				)}
			</Section>
			{snapshots.data && <Announcer text={announcement(repo.name, newest)} />}
		</>
	);
}

const COMMAND_FIELDS = [
	["install", "Install command", true, "npm ci"],
	["test", "Test command", true, "npm test"],
	["typecheck", "Typecheck command", false, ""],
	["lint", "Lint command", false, ""],
	["build", "Build command", false, ""],
] as const;

/** Owner-only registration of a local-path or fixture repository; indexing starts with it. */
export function RegisterRepositoryPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const session = useSession();
	const [sourceType, setSourceType] = useState<"fixture" | "local_path">(
		"fixture",
	);
	const register = useMutation({
		mutationFn: registerRepository,
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: ["repositories"] });
			navigate(`/repositories/${result.repository.id}`);
		},
	});
	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const text = (name: string) => String(form.get(name) ?? "").trim();
		const optional = (name: string) => text(name) || undefined;
		register.mutate({
			name: text("name"),
			source:
				sourceType === "fixture"
					? { type: "fixture", fixture: "bench-shop" }
					: { type: "local_path", path: text("path") },
			default_branch: optional("default_branch"),
			commands: {
				install: text("install"),
				test: text("test"),
				typecheck: optional("typecheck"),
				lint: optional("lint"),
				build: optional("build"),
			},
		});
	};
	const title = <title>Register repository · Tracera</title>;
	if (session.data && session.data.workspace.role !== "owner")
		return (
			<>
				{title}
				<h1 className="font-semibold text-2xl tracking-tight">
					Register a repository
				</h1>
				<p className="mt-3 text-sm">
					Only a workspace owner can register repositories. Your role is{" "}
					<code>{session.data.workspace.role}</code>.
				</p>
			</>
		);
	return (
		<>
			{title}
			<Breadcrumbs
				items={[
					{ key: "list", label: "Repositories", to: "/" },
					{ key: "new", label: "Register a repository" },
				]}
			/>
			<h1 className="mt-3 font-semibold text-2xl tracking-tight">
				Register a repository
			</h1>
			<p className="mt-1.5 max-w-2xl text-ink-2 text-sm">
				Tracera reads the repository through git and indexes it in the
				background. Commands are stored for sandboxed checks; they never run on
				the host.
			</p>
			<form
				onSubmit={onSubmit}
				className={`mt-8 max-w-xl space-y-5 ${panelClass}`}
			>
				<div>
					<label htmlFor="name" className={labelClass}>
						Name
					</label>
					<input
						id="name"
						name="name"
						required
						maxLength={100}
						pattern="[A-Za-z0-9._\-]+"
						aria-describedby="name-hint"
						className={inputClass}
					/>
					<p id="name-hint" className={hintClass}>
						Letters, digits, dot, dash, underscore; unique in the workspace.
					</p>
				</div>
				<fieldset>
					<legend className={labelClass}>Source</legend>
					<div className="mt-1 space-y-1">
						<label className="flex items-center gap-2">
							<input
								type="radio"
								name="source_type"
								value="fixture"
								checked={sourceType === "fixture"}
								onChange={() => setSourceType("fixture")}
							/>
							Bench Shop fixture
						</label>
						<label className="flex items-center gap-2">
							<input
								type="radio"
								name="source_type"
								value="local_path"
								checked={sourceType === "local_path"}
								onChange={() => setSourceType("local_path")}
							/>
							Local path
						</label>
						<p className="text-ink-3 text-xs">
							Git URL sources are not available yet (the API answers{" "}
							<code>source_type_not_available</code>).
						</p>
					</div>
				</fieldset>
				{sourceType === "local_path" && (
					<div>
						<label htmlFor="path" className={labelClass}>
							Repository path
						</label>
						<input
							id="path"
							name="path"
							required
							maxLength={1000}
							aria-describedby="path-hint"
							className={`${inputClass} font-mono`}
						/>
						<p id="path-hint" className={hintClass}>
							A git work tree inside a directory listed in the server's{" "}
							<code>TRACERA_REPO_ROOTS</code>.
						</p>
					</div>
				)}
				<div>
					<label htmlFor="default_branch" className={labelClass}>
						Default branch{" "}
						<span className="font-normal text-ink-3">(optional)</span>
					</label>
					<input
						id="default_branch"
						name="default_branch"
						maxLength={200}
						className={`${inputClass} font-mono`}
					/>
				</div>
				<fieldset className="space-y-3">
					<legend className={labelClass}>Commands</legend>
					<p className="text-ink-3 text-xs">
						One line each. At run time a command must be <code>npm test</code>,{" "}
						<code>npm run &lt;script&gt;</code>, or <code>node --test</code>.
						Anything else is blocked.
					</p>
					{COMMAND_FIELDS.map(([name, label, required, fallback]) => (
						<div key={name}>
							<label htmlFor={name} className={labelClass}>
								{label}
								{!required && <span className="text-ink-3"> (optional)</span>}
							</label>
							<input
								id={name}
								name={name}
								required={required}
								maxLength={500}
								defaultValue={fallback}
								className={`${inputClass} font-mono`}
							/>
						</div>
					))}
				</fieldset>
				{register.error && (
					<ErrorNotice
						alert
						title="Registration failed"
						error={register.error}
					/>
				)}
				<button
					type="submit"
					className={primaryButtonClass}
					disabled={register.isPending}
				>
					{register.isPending ? "Registering…" : "Register and index"}
				</button>
			</form>
		</>
	);
}
