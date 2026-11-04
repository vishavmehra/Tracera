import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitHubInstallationSchema } from "@tracera/contracts";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { z } from "zod";
import {
	connectGitHubRepository,
	getGitHubInstallUrl,
	getGitHubStatus,
	getRepositorySync,
	listGitHubRepositories,
	syncRepository,
} from "./api.ts";
import { POLL_MS, useIsOwner } from "./hooks.ts";
import type { GitHubRepositoryListSchema } from "./schemas.ts";
import {
	buttonClass,
	ErrorNotice,
	inputClass,
	labelClass,
	linkClass,
	primaryButtonClass,
	Sha,
	Time,
} from "./ui.tsx";

type GitHubInstallation = z.infer<typeof GitHubInstallationSchema>;
type Candidate = z.infer<
	typeof GitHubRepositoryListSchema
>["repositories"][number];

/** The install page is on GitHub; anything else the server sent is refused. */
const GITHUB_ORIGIN = "https://github.com/";

/** What the API reports about one connected repository's synchronization, and a Sync button. */
export function SyncLine({ repositoryId }: { repositoryId: string }) {
	const queryClient = useQueryClient();
	const sync = useQuery({
		queryKey: ["repositories", repositoryId, "sync"],
		queryFn: () => getRepositorySync(repositoryId),
		refetchInterval: (query) =>
			query.state.data && query.state.data.summary.pending > 0
				? POLL_MS
				: false,
	});
	const syncNow = useMutation({
		mutationFn: () => syncRepository(repositoryId),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: ["repositories", repositoryId, "sync"],
			}),
	});
	const data = sync.data;
	const lastDelivery = data?.deliveries.recent[0];
	return (
		<div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-ink-2 text-xs">
			{sync.error ? (
				<ErrorNotice
					title="Sync status could not be loaded"
					error={sync.error}
					onRetry={() => void sync.refetch()}
				/>
			) : !data ? (
				<p role="status">Loading sync status…</p>
			) : (
				<p>
					{data.latest_indexed ? (
						<>
							Indexed <Sha sha={data.latest_indexed.commit_sha} />
							{data.last_synced_at && (
								<>
									{" "}
									(<Time iso={data.last_synced_at} />)
								</>
							)}
						</>
					) : (
						"Not indexed yet"
					)}
					{" · "}
					{data.summary.pending} pending, {data.summary.failed} failed
					{lastDelivery && (
						<>
							{" · "}last webhook <Time iso={lastDelivery.received_at} /> (
							{lastDelivery.event}, {lastDelivery.status})
						</>
					)}
				</p>
			)}
			{data?.summary.last_failure && (
				<p className="text-error">
					Last failure: <code>{data.summary.last_failure.code}</code>,{" "}
					{data.summary.last_failure.message}
				</p>
			)}
			<button
				type="button"
				className={buttonClass}
				disabled={syncNow.isPending}
				onClick={() => syncNow.mutate()}
			>
				{syncNow.isPending ? "Syncing…" : "Sync"}
			</button>
			{syncNow.error && (
				<ErrorNotice
					title="Sync could not be requested"
					error={syncNow.error}
					alert
				/>
			)}
		</div>
	);
}

/** The repositories one installation can access: pick one to connect it, then sync it. */
function InstallationRepositories({
	installation,
}: {
	installation: GitHubInstallation;
}) {
	const queryClient = useQueryClient();
	const [commands, setCommands] = useState({
		install: "npm ci --ignore-scripts",
		test: "npm test",
	});
	const repositories = useQuery({
		queryKey: ["github", "installations", installation.id, "repositories"],
		queryFn: () => listGitHubRepositories(installation.id),
	});
	const connect = useMutation({
		mutationFn: (repository: Candidate) =>
			connectGitHubRepository(installation.id, {
				github_repository_id: repository.github_repository_id,
				commands,
			}),
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: ["github"] }),
				queryClient.invalidateQueries({ queryKey: ["repositories"] }),
			]),
	});
	if (repositories.error)
		return (
			<ErrorNotice
				title="The installation's repositories could not be loaded"
				error={repositories.error}
				onRetry={() => void repositories.refetch()}
			/>
		);
	if (!repositories.data) return <p role="status">Loading repositories…</p>;
	return (
		<div className="mt-3">
			<div className="grid gap-3 sm:grid-cols-2">
				<label className={labelClass}>
					Install command
					<input
						className={inputClass}
						value={commands.install}
						onChange={(event) =>
							setCommands({ ...commands, install: event.target.value })
						}
					/>
				</label>
				<label className={labelClass}>
					Test command
					<input
						className={inputClass}
						value={commands.test}
						onChange={(event) =>
							setCommands({ ...commands, test: event.target.value })
						}
					/>
				</label>
			</div>
			{connect.error && (
				<div className="mt-3">
					<ErrorNotice
						title="The repository could not be connected"
						error={connect.error}
						alert
					/>
				</div>
			)}
			{repositories.data.repositories.length === 0 ? (
				<p className="mt-3 text-ink-3 text-sm">
					The installation grants access to no repositories. Change its
					repository access on GitHub.
				</p>
			) : (
				<ul className="mt-2 divide-y divide-line">
					{repositories.data.repositories.map((repository) => (
						<li key={repository.github_repository_id} className="py-2.5">
							<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
								<span className="font-medium text-sm">
									{repository.full_name}
								</span>
								<span className="text-ink-3 text-xs">
									{repository.private ? "private" : "public"}
									{repository.archived && ", archived"}
									{repository.default_branch && (
										<>
											, branch <code>{repository.default_branch}</code>
										</>
									)}
								</span>
								{repository.connected_repository_id ? (
									<Link
										to={`/repositories/${repository.connected_repository_id}`}
										className={`${linkClass} text-sm`}
									>
										Open in Tracera
									</Link>
								) : (
									<button
										type="button"
										className={primaryButtonClass}
										disabled={connect.isPending}
										onClick={() => connect.mutate(repository)}
									>
										Connect
									</button>
								)}
							</div>
							{repository.connected_repository_id && (
								<SyncLine repositoryId={repository.connected_repository_id} />
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** The repositories page's GitHub panel: not configured, not connected, or connected. */
export function GitHubCard() {
	const owner = useIsOwner();
	const [params] = useSearchParams();
	const status = useQuery({
		queryKey: ["github", "status"],
		queryFn: getGitHubStatus,
	});
	const install = useMutation({
		mutationFn: getGitHubInstallUrl,
		onSuccess: ({ url }) => {
			if (!url.startsWith(GITHUB_ORIGIN))
				throw new Error("The server returned an unexpected install address.");
			window.location.assign(url);
		},
	});
	const returned = params.get("github_error");
	let body: ReactNode;
	if (status.error)
		body = (
			<ErrorNotice
				title="GitHub status could not be loaded"
				error={status.error}
				onRetry={() => void status.refetch()}
			/>
		);
	else if (!status.data) body = <p role="status">Loading GitHub…</p>;
	else if (!status.data.configured)
		body = (
			<>
				<p className="text-sm">GitHub is not configured on this server.</p>
				<p className="mt-1 text-ink-3 text-xs">
					Unset variables:{" "}
					{status.data.missing.map((name, index) => (
						<span key={name}>
							{index > 0 && ", "}
							<code>{name}</code>
						</span>
					))}
				</p>
			</>
		);
	else {
		const { installations, app_error: appError } = status.data;
		body = (
			<>
				{appError && (
					<p className="mb-2 text-error text-sm">
						GitHub reported <code>{appError.code}</code>: {appError.message}
					</p>
				)}
				{installations.length === 0 ? (
					<p className="text-sm">No GitHub account is connected.</p>
				) : (
					<ul className="space-y-4">
						{installations.map((installation) => (
							<li key={installation.id}>
								<p className="text-sm">
									<span className="font-medium">
										{installation.account_login}
									</span>{" "}
									<span className="text-ink-3 text-xs">
										({installation.account_type}, {installation.status},{" "}
										{installation.repository_selection === "all"
											? "all repositories"
											: "selected repositories"}
										)
									</span>
								</p>
								{installation.permission_problems.length > 0 && (
									<p className="mt-1 text-error text-xs">
										Missing permissions:{" "}
										{installation.permission_problems.join(", ")}
									</p>
								)}
								{owner &&
									installation.status === "active" &&
									installation.permission_problems.length === 0 && (
										<InstallationRepositories installation={installation} />
									)}
							</li>
						))}
					</ul>
				)}
				{owner ? (
					<div className="mt-3">
						<button
							type="button"
							className={
								installations.length === 0 ? primaryButtonClass : buttonClass
							}
							disabled={install.isPending}
							onClick={() => install.mutate()}
						>
							Connect GitHub
						</button>
					</div>
				) : (
					<p className="mt-2 text-ink-3 text-xs">
						A workspace owner connects GitHub accounts and repositories.
					</p>
				)}
			</>
		);
	}
	return (
		<section
			aria-labelledby="github-heading"
			className="mt-5 rounded-lg border border-line px-4 py-4"
		>
			<h2 id="github-heading" className="font-semibold text-[15px]">
				GitHub
			</h2>
			<div className="mt-2">{body}</div>
			{install.error && (
				<div className="mt-3">
					<ErrorNotice
						title="GitHub could not be opened"
						error={install.error}
						alert
					/>
				</div>
			)}
			{returned && (
				<p role="alert" className="mt-3 text-error text-sm">
					The GitHub connection did not complete (<code>{returned}</code>).
				</p>
			)}
		</section>
	);
}
