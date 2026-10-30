import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActionRequest, VerificationOutcome } from "@tracera/contracts";
import { type ReactNode, useId, useState } from "react";
import {
	ApiError,
	listPatchActions,
	patchDownloadPath,
	requestPatchAction,
} from "./api.ts";
import type { Patch, PatchAction } from "./schemas.ts";
import {
	buttonClass,
	Empty,
	ErrorNotice,
	Facts,
	hintClass,
	humanize,
	inputClass,
	labelClass,
	linkClass,
	OutcomeBadge,
	primaryButtonClass,
	QueryView,
	Section,
	Sha,
	StateBadge,
	Time,
} from "./ui.tsx";

// Apply, commit, and push are three separate decisions on an approved patch. Each has its own
// confirmation, nothing here runs on its own, and every result shown is what the server read back
// from git.

/** Outcomes that mean no check ran, so nothing may be said about where verification happened. */
const NOT_RUN = new Set(["blocked", "not_attempted"]);

/** What to do next, by the server's stable code. */
const RECOVERY: Record<string, string> = {
	working_tree_dirty:
		"Commit or stash your edits to those files, then apply again.",
	patch_does_not_apply:
		"Those files differ from the commit the patch was verified against (or use other line endings). Nothing was written. Ask for a new patch attempt, or apply the downloaded patch by hand.",
	secret_detected:
		"Remove the secret-like content, or apply the patch to your working tree and commit it yourself after reviewing it.",
	branch_exists: "Choose a branch name that does not exist yet.",
	invalid_branch_name: "Choose another branch name.",
	commit_required:
		"Commit the patch to a branch first; a push sends that commit.",
	default_branch_refused:
		"Tracera never pushes to a default branch. Push to a new branch name and open a pull request from it.",
	non_fast_forward:
		"The remote branch has commits yours lacks. Tracera never force-pushes: choose a different remote branch name, or reconcile it outside Tracera.",
	remote_auth_failed:
		"git has no working credentials for this remote. Sign in with git outside Tracera (a credential helper or an SSH key), then try again.",
	remote_not_found:
		"Use the name of a remote configured in the repository (see `git remote`).",
	branch_changed:
		"The branch no longer holds the commit Tracera made. Commit again to a new branch.",
	action_in_progress:
		"Another action is running for this repository. Wait for it to finish.",
	acknowledgement_mismatch:
		"Reload the page: the recorded verification outcome differs from the one you acknowledged.",
	owner_required: "Only a workspace owner can change the repository.",
};

export function PublicationPanel({ patch }: { patch: Patch }) {
	if (
		patch.status !== "approved" ||
		patch.approval?.decision !== "approved" ||
		!patch.verification
	)
		return null;
	return (
		<Section title="Apply and publish" id="publication-heading">
			<Actions
				patch={patch}
				outcome={patch.verification.outcome}
				outcomeLabel={patch.verification.label}
			/>
		</Section>
	);
}

function useRunAction(patchId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: ActionRequest) => requestPatchAction(patchId, input),
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: ["patch-actions", patchId] }),
	});
}

function Actions({
	patch,
	outcome,
	outcomeLabel,
}: {
	patch: Patch;
	outcome: VerificationOutcome;
	outcomeLabel: string;
}) {
	const actions = useQuery({
		queryKey: ["patch-actions", patch.id],
		queryFn: () => listPatchActions(patch.id),
	});
	const [acknowledged, setAcknowledged] = useState(false);
	return (
		<QueryView query={actions} what="Actions">
			{({ target, items }) => (
				<div className="space-y-5 text-sm">
					<Facts
						items={[
							[
								"Target",
								target.path ? (
									<code key="path" className="break-all text-xs">
										{target.path}
									</code>
								) : (
									"Not a local path"
								),
							],
							["Verified against", <Sha key="base" sha={patch.base_commit} />],
							[
								"Verification outcome",
								<OutcomeBadge
									key="outcome"
									outcome={outcome}
									label={outcomeLabel}
								/>,
							],
						]}
					/>
					{target.local ? (
						<>
							<label className="flex items-start gap-2.5">
								<input
									type="checkbox"
									className="mt-0.5 size-4 shrink-0 accent-accent"
									checked={acknowledged}
									onChange={(event) => setAcknowledged(event.target.checked)}
								/>
								<span>
									{outcome === "verified"
										? "I reviewed the diff and the verification result, and I authorize each action below one at a time."
										: `I understand the outcome is ${outcome}, not verified, and I accept the risk of changing my repository with this patch.`}
								</span>
							</label>
							<ApplyStep
								patch={patch}
								path={target.path ?? ""}
								auth={{
									acknowledged_outcome: outcome,
									acknowledged_risks: acknowledged,
								}}
							/>
							<CommitStep
								patch={patch}
								suggestedBranch={target.suggested_branch}
								auth={{
									acknowledged_outcome: outcome,
									acknowledged_risks: acknowledged,
								}}
							/>
							<PushStep
								patch={patch}
								committed={items.find(
									(item) =>
										item.kind === "commit" && item.status === "succeeded",
								)}
								auth={{
									acknowledged_outcome: outcome,
									acknowledged_risks: acknowledged,
								}}
							/>
						</>
					) : (
						<Empty>
							This repository was not registered from a local path, so Tracera
							cannot change it. The approved patch can still be downloaded.
						</Empty>
					)}
					<p>
						<a
							className={linkClass}
							href={patchDownloadPath(patch.id)}
							download
						>
							Download patch
						</a>
					</p>
					<Recorded items={items} baseCommit={patch.base_commit} />
				</div>
			)}
		</QueryView>
	);
}

type Authorization = {
	acknowledged_outcome: VerificationOutcome;
	acknowledged_risks: boolean;
};

/** One action: its description, optional fields, and a button that asks again before it runs. */
function Step({
	title,
	hint,
	confirm,
	confirmLabel,
	ready,
	pending,
	error,
	onRun,
	children,
}: {
	title: string;
	hint: string;
	confirm: string;
	confirmLabel: string;
	ready: boolean;
	pending: boolean;
	error: unknown;
	onRun: () => void;
	children?: ReactNode;
}) {
	const [confirming, setConfirming] = useState(false);
	return (
		<div className="space-y-2 border-line border-t pt-4">
			<h3 className="font-medium text-ink">{title}</h3>
			<p className={hintClass}>{hint}</p>
			{children}
			{confirming ? (
				<fieldset className="space-y-2">
					<legend className="sr-only">Confirm: {title}</legend>
					<p className="border-warning/60 border-l-2 pl-3">{confirm}</p>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							className={primaryButtonClass}
							disabled={pending || !ready}
							onClick={() => {
								setConfirming(false);
								onRun();
							}}
						>
							{confirmLabel}
						</button>
						<button
							type="button"
							className={buttonClass}
							onClick={() => setConfirming(false)}
						>
							Cancel
						</button>
					</div>
				</fieldset>
			) : (
				<button
					type="button"
					className={buttonClass}
					disabled={!ready || pending}
					onClick={() => setConfirming(true)}
				>
					{pending ? "Running…" : title}
				</button>
			)}
			{error ? <RunError error={error} /> : null}
		</div>
	);
}

function RunError({ error }: { error: unknown }) {
	const code = error instanceof ApiError ? error.code : null;
	return (
		<div className="space-y-1">
			<ErrorNotice alert title="The action did not run" error={error} />
			{code !== null && RECOVERY[code] && (
				<p className={hintClass}>{RECOVERY[code]}</p>
			)}
		</div>
	);
}

function ApplyStep({
	patch,
	path,
	auth,
}: {
	patch: Patch;
	path: string;
	auth: Authorization;
}) {
	const run = useRunAction(patch.id);
	return (
		<Step
			title="Apply to my working tree"
			hint="Writes this patch's files into your checkout. It refuses if any of those files has uncommitted changes, and it stages and commits nothing."
			confirm={`Write ${patch.files.length} ${patch.files.length === 1 ? "file" : "files"} into ${path}?`}
			confirmLabel="Confirm apply"
			ready={auth.acknowledged_risks}
			pending={run.isPending}
			error={run.error}
			onRun={() => run.mutate({ kind: "apply", ...auth })}
		/>
	);
}

function CommitStep({
	patch,
	suggestedBranch,
	auth,
}: {
	patch: Patch;
	suggestedBranch: string;
	auth: Authorization;
}) {
	const run = useRunAction(patch.id);
	const branchId = useId();
	const messageId = useId();
	const [branch, setBranch] = useState(suggestedBranch);
	const [message, setMessage] = useState("");
	return (
		<Step
			title="Commit to a new branch"
			hint="Creates a new branch from the commit the patch was verified against, in a temporary worktree. Your checkout, index, and files are not touched."
			confirm={`Create branch ${branch.trim() || suggestedBranch} with this patch as one commit?`}
			confirmLabel="Confirm commit"
			ready={auth.acknowledged_risks}
			pending={run.isPending}
			error={run.error}
			onRun={() =>
				run.mutate({
					kind: "commit",
					branch: branch.trim() || undefined,
					message: message.trim() || undefined,
					...auth,
				})
			}
		>
			<div>
				<label htmlFor={branchId} className={labelClass}>
					Branch
				</label>
				<input
					id={branchId}
					className={inputClass}
					value={branch}
					maxLength={200}
					onChange={(event) => setBranch(event.target.value)}
				/>
			</div>
			<div>
				<label htmlFor={messageId} className={labelClass}>
					Commit message (optional)
				</label>
				<textarea
					id={messageId}
					className={inputClass}
					rows={2}
					maxLength={2000}
					value={message}
					placeholder="Defaults to the patch summary and its verification outcome"
					onChange={(event) => setMessage(event.target.value)}
				/>
			</div>
		</Step>
	);
}

function PushStep({
	patch,
	committed,
	auth,
}: {
	patch: Patch;
	committed: PatchAction | undefined;
	auth: Authorization;
}) {
	const run = useRunAction(patch.id);
	const remoteId = useId();
	const branchId = useId();
	const [remote, setRemote] = useState("origin");
	const [typed, setTyped] = useState<string | null>(null);
	const remoteBranch = (typed ?? committed?.result?.branch ?? "").trim();
	return (
		<Step
			title="Push branch"
			hint={
				committed
					? "Pushes the branch Tracera created to a remote and branch you name, with your own git credentials. It is never forced, and default branches are refused."
					: "Commit to a new branch first; a push sends that commit."
			}
			confirm={`Push ${committed?.result?.branch ?? "the branch"} to ${remote.trim()}/${remoteBranch}?`}
			confirmLabel="Confirm push"
			ready={
				auth.acknowledged_risks &&
				committed !== undefined &&
				remote.trim() !== "" &&
				remoteBranch !== ""
			}
			pending={run.isPending}
			error={run.error}
			onRun={() =>
				run.mutate({
					kind: "push",
					remote: remote.trim(),
					remote_branch: remoteBranch,
					...auth,
				})
			}
		>
			<div>
				<label htmlFor={remoteId} className={labelClass}>
					Remote
				</label>
				<input
					id={remoteId}
					className={inputClass}
					value={remote}
					maxLength={64}
					onChange={(event) => setRemote(event.target.value)}
				/>
			</div>
			<div>
				<label htmlFor={branchId} className={labelClass}>
					Remote branch
				</label>
				<input
					id={branchId}
					className={inputClass}
					value={typed ?? committed?.result?.branch ?? ""}
					maxLength={200}
					onChange={(event) => setTyped(event.target.value)}
				/>
			</div>
		</Step>
	);
}

function ChangedFiles({
	files,
}: {
	files: NonNullable<NonNullable<PatchAction["result"]>["changed_files"]>;
}) {
	if (files.length === 0) return null;
	return (
		<ul className="mt-1 space-y-0.5">
			{files.map((file) => (
				<li key={file.path} className="flex flex-wrap items-center gap-x-2">
					<StateBadge value={file.status} />
					<code className="break-all text-xs">{file.path}</code>
				</li>
			))}
		</ul>
	);
}

/** Only what the action's record says: git's output for successes, the stable code for the rest. */
function Outcome({
	action,
	baseCommit,
}: {
	action: PatchAction;
	baseCommit: string;
}) {
	const result = action.result;
	if (action.status === "failed" || action.status === "refused")
		return (
			<div className="mt-1">
				<code className="text-xs">{action.error_code}</code>
				{result?.detail && (
					<span className="text-ink-2">: {result.detail}</span>
				)}
				{RECOVERY[action.error_code ?? ""] && (
					<p className={hintClass}>{RECOVERY[action.error_code ?? ""]}</p>
				)}
			</div>
		);
	if (action.status !== "succeeded" || !result) return null;
	if (action.kind === "apply")
		return (
			<div className="mt-1 space-y-1">
				<p>
					{`Applied to your working tree. ${
						NOT_RUN.has(action.acknowledged_outcome ?? "")
							? "No verification ran for this patch."
							: "Verification ran in the isolated sandbox."
					}`}
				</p>
				<ChangedFiles files={result.changed_files ?? []} />
				{result.head_commit && result.head_commit !== baseCommit && (
					<p className="text-warning">
						Your checkout was at <Sha sha={result.head_commit} />, not the
						commit the patch was verified against (<Sha sha={baseCommit} />
						).
					</p>
				)}
			</div>
		);
	if (action.kind === "commit")
		return (
			<div className="mt-1 space-y-1">
				<p>
					Committed {result.commit_sha && <Sha sha={result.commit_sha} />} on
					branch <code className="break-all text-xs">{result.branch}</code>.
					Your checkout was not touched.
				</p>
				<ChangedFiles files={result.changed_files ?? []} />
			</div>
		);
	return (
		<p className="mt-1">
			Pushed <code className="break-all text-xs">{result.pushed_ref}</code> to{" "}
			<code className="text-xs">{result.remote}</code>
			{result.commit_sha && (
				<>
					{" "}
					at <Sha sha={result.commit_sha} />
				</>
			)}
			.
		</p>
	);
}

function Recorded({
	items,
	baseCommit,
}: {
	items: PatchAction[];
	baseCommit: string;
}) {
	if (items.length === 0) return null;
	return (
		<div aria-live="polite" className="border-line border-t pt-4">
			<h3 className="font-medium text-ink">Recorded actions</h3>
			<ul className="mt-2 space-y-3">
				{items.map((action) => (
					<li key={action.id}>
						<div className="flex flex-wrap items-center gap-x-3">
							<span className="font-medium">{humanize(action.kind)}</span>
							<StateBadge value={action.status} />
							<span className="text-ink-3 text-xs">
								<Time iso={action.created_at} />
							</span>
						</div>
						<Outcome action={action} baseCommit={baseCommit} />
					</li>
				))}
			</ul>
		</div>
	);
}
