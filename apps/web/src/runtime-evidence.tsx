import { useQuery } from "@tanstack/react-query";
import type {
	RuntimeEvidenceResponse,
	RuntimePhase,
	RuntimeRun,
	RuntimeStartup,
	RuntimeStep,
} from "@tracera/contracts";
import { useState } from "react";
import { ApiError, getRuntimeEvidence } from "./api.ts";
import {
	Empty,
	ErrorNotice,
	formatDuration,
	Glyph,
	humanize,
	linkClass,
	Section,
	Status,
	type Tone,
} from "./ui.tsx";

// The patch review page's runtime evidence: the same sandboxed browser steps before and after the
// patch, side by side, with how the app started, each step's outcome, and the screenshots. It shows
// recorded results only; "fix" wording appears only when the stored post-patch assertions passed.

const STEP_TONE: Record<RuntimeStep["status"], Tone> = {
	passed: "good",
	failed: "bad",
	skipped: "neutral",
};

/** What the stored post-patch records allow saying, in words (reason codes from the server). */
const CLAIM_TEXT: Record<string, string> = {
	post_patch_assertions_passed:
		"Every assertion passed against the patched app in the sandbox.",
	no_verification:
		"No verification ran for this patch, so nothing is claimed about its effect.",
	no_post_patch_run: "No browser run was recorded after the patch.",
	post_patch_run_incomplete:
		"A browser run after the patch did not finish, so its result cannot be read.",
	post_patch_assertion_failed:
		"An assertion still failed against the patched app.",
	no_assertion_passed: "No assertion passed after the patch.",
	reproduction_check_not_passed:
		"The verification's reproduction check did not pass.",
};

const STARTUP_TONE: Record<RuntimeStartup["state"], Tone> = {
	started: "good",
	failed: "bad",
	unknown: "warn",
};

function Startup({ run }: { run: RuntimeRun }) {
	const { startup } = run;
	const health = startup.health;
	return (
		<div className="space-y-0.5 text-sm">
			<Status tone={STARTUP_TONE[startup.state]} size="sm">
				{startup.state === "started"
					? "App started in sandbox"
					: startup.state === "failed"
						? `App did not start: ${humanize(startup.reason ?? "unknown").toLowerCase()}`
						: `App start not confirmed: ${humanize(startup.reason ?? "unknown").toLowerCase()}`}
			</Status>
			<p className="break-words text-ink-3 text-xs">
				<code>{startup.start}</code> on port {startup.port}
				{health &&
					(health.ok
						? `, ${startup.ready_path} answered ${health.status} after ${health.attempts} ${health.attempts === 1 ? "try" : "tries"} (${formatDuration(health.waited_ms)})`
						: `, ${startup.ready_path} gave no answer in ${formatDuration(health.waited_ms)}${health.error ? ` (${health.error})` : ""}`)}
				{startup.page && !startup.page.loaded && (
					<>
						, the first page did not load
						{startup.page.error ? `: ${startup.page.error}` : ""}
					</>
				)}
			</p>
		</div>
	);
}

function Steps({ steps }: { steps: RuntimeStep[] }) {
	if (steps.length === 0)
		return <p className="text-ink-3 text-sm">No step ran in this run.</p>;
	return (
		<ol className="divide-y divide-line border-line border-y text-sm">
			{steps.map((step) => (
				<li key={step.index} className="flex items-start gap-2.5 py-1.5">
					<Glyph tone={STEP_TONE[step.status]} className="mt-1.5" />
					<span className="min-w-0 flex-1">
						<span className="break-words">{step.label}</span>
						{step.assertion && (
							<span className="ml-2 text-ink-3 text-xs">assertion</span>
						)}
						{step.status === "failed" && (
							<span className="mt-0.5 block break-words text-ink-2 text-xs">
								{step.expected !== null || step.actual !== null ? (
									<>
										Expected <code>{step.expected ?? "(none)"}</code>, saw{" "}
										<code>{step.actual ?? "(nothing)"}</code>
									</>
								) : (
									(step.message ?? "The step failed.")
								)}
							</span>
						)}
					</span>
					<span className="shrink-0 text-ink-3 text-xs">
						{humanize(step.status)}
					</span>
				</li>
			))}
		</ol>
	);
}

/** The stored picture; says so when its file is not on this server (evidence recorded in another environment). */
function Screenshot({
	phase,
	run,
	shot,
}: {
	phase: RuntimePhase;
	run: RuntimeRun;
	shot: NonNullable<RuntimeRun["screenshot"]>;
}) {
	const [missing, setMissing] = useState(false);
	if (missing)
		return (
			<Empty>
				A screenshot was recorded for this run, but its file is not available on
				this server.
			</Empty>
		);
	return (
		<figure className="space-y-1">
			<a
				href={shot.url}
				target="_blank"
				rel="noopener noreferrer"
				className="block"
			>
				<img
					src={shot.url}
					alt={`The page ${phase === "before" ? "before" : "after"} the patch, as the sandboxed browser saw it after the last step`}
					loading="lazy"
					onError={() => setMissing(true)}
					className="block h-auto w-full rounded border border-line bg-elevated"
				/>
			</a>
			<figcaption className="flex flex-wrap gap-x-3 text-ink-3 text-xs">
				<span>
					PNG, {Math.max(1, Math.round(shot.bytes / 1024))} KB
					{run.final_path && <>, at {run.final_path}</>}
				</span>
				<a
					href={shot.url}
					target="_blank"
					rel="noopener noreferrer"
					className={linkClass}
				>
					Open full size
				</a>
			</figcaption>
		</figure>
	);
}

function PhasePanel({
	phase,
	runs,
}: {
	phase: RuntimePhase;
	runs: RuntimeRun[];
}) {
	const shown = runs.find((run) => run.screenshot) ?? runs[0];
	const statuses = [...new Set(runs.map((run) => run.reproduction.status))];
	const only = statuses.length === 1 ? statuses[0] : undefined;
	const title =
		phase === "after"
			? "After patch: sandbox"
			: only === "reproduced"
				? "Before: reproduced in sandbox"
				: only !== undefined
					? `Before: ${humanize(only).toLowerCase()} in sandbox`
					: runs.length === 0
						? "Before: no browser run"
						: "Before: runs disagreed";
	return (
		<section aria-label={title} className="min-w-0 space-y-3">
			<h3 className="font-semibold text-sm">{title}</h3>
			{!shown ? (
				<Empty>No browser run was recorded for this phase.</Empty>
			) : (
				<>
					<Startup run={shown} />
					{shown.screenshot ? (
						<Screenshot phase={phase} run={shown} shot={shown.screenshot} />
					) : (
						<Empty>
							No screenshot was stored for this run
							{shown.startup.state === "started"
								? "."
								: ": the app never showed a page."}
						</Empty>
					)}
					<Steps steps={shown.steps} />
					<p className="text-ink-3 text-xs">
						{runs.length === 1 ? "1 run" : `${runs.length} runs`}:{" "}
						{runs
							.map((run) => humanize(run.reproduction.status).toLowerCase())
							.join(", ")}
						. Showing run {runs.indexOf(shown) + 1}.
					</p>
					<details className="text-xs">
						<summary className="cursor-pointer text-ink-2 hover:text-ink">
							Where this ran
						</summary>
						<dl className="mt-2 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1">
							<dt className="text-ink-3">Run</dt>
							<dd>
								<code className="break-all">{shown.run_id}</code>
							</dd>
							<dt className="text-ink-3">Sandbox</dt>
							<dd>{shown.sandbox.kind}</dd>
							<dt className="text-ink-3">App image</dt>
							<dd className="break-all font-mono">{shown.startup.image}</dd>
							<dt className="text-ink-3">Browser image</dt>
							<dd className="break-all font-mono">
								{shown.startup.browser_image}
							</dd>
							{shown.screenshot && (
								<>
									<dt className="text-ink-3">Screenshot</dt>
									<dd className="break-all font-mono">
										sha256 {shown.screenshot.sha256}
									</dd>
								</>
							)}
						</dl>
					</details>
				</>
			)}
		</section>
	);
}

/** How many assertions passed, per run, in words. */
function passedText(runs: RuntimeRun[]) {
	const counts = runs.map((run) => run.assertions.passed);
	const noun = (count: number) => `${count} assertion${count === 1 ? "" : "s"}`;
	if (runs.length === 1) return `${noun(counts[0] ?? 0)} passed in the run.`;
	return counts.every((count) => count === counts[0])
		? `${noun(counts[0] ?? 0)} passed in each of ${runs.length} runs.`
		: `Assertions passed in ${runs.length} runs (${counts.join(", ")}).`;
}

function Claim({ data }: { data: RuntimeEvidenceResponse }) {
	const { visual_fix: claim, after } = data;
	return (
		<div className="space-y-1">
			<Status tone={claim.claimable ? "good" : "neutral"} size="sm">
				{claim.claimable
					? "Post-patch assertions passed"
					: "No fix is claimed from this evidence"}
			</Status>
			<p className="max-w-[68ch] text-ink-2 text-sm">
				{CLAIM_TEXT[claim.reason] ?? humanize(claim.reason)}
				{claim.claimable && ` ${passedText(after)}`}
			</p>
		</div>
	);
}

/**
 * The sandbox was disabled, so no app started and nothing ran. Says that, and shows the verification
 * outcome as stored; nothing here can read as a success.
 */
function NoSandbox({
	verification,
}: {
	verification: RuntimeEvidenceResponse["verification"];
}) {
	const check = verification?.reproduction_check;
	return (
		<div className="space-y-1.5">
			<p className="flex items-start gap-2 font-medium text-sm text-warning">
				<Glyph tone="warn" className="mt-1" />
				<span>
					No sandbox in this environment: the app was not started and nothing
					was verified here
				</span>
			</p>
			<p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ink-2 text-sm">
				{verification ? (
					<>
						<span>Verification outcome:</span>
						<Status tone="warn" size="sm" title={verification.outcome}>
							{humanize(verification.outcome)}
						</Status>
						{check && (
							<span className="text-ink-3 text-xs">
								Reproduction check: {humanize(check.status).toLowerCase()}
								{check.reason && ` (${humanize(check.reason).toLowerCase()})`}
							</span>
						)}
					</>
				) : (
					<span>No verification was recorded for this patch.</span>
				)}
			</p>
		</div>
	);
}

/** Renders nothing for a patch whose verification used no browser run, unless the sandbox was disabled. */
export function RuntimeEvidence({ patchId }: { patchId: string }) {
	const evidence = useQuery({
		queryKey: ["patches", patchId, "runtime-evidence"],
		queryFn: () => getRuntimeEvidence(patchId),
	});
	const data = evidence.data;
	if (evidence.isLoading) return null;
	// A server without this endpoint, or a patch it does not know, has no runtime evidence to show.
	if (evidence.error instanceof ApiError && evidence.error.status === 404)
		return null;
	const noRuns = data && data.before.length === 0 && data.after.length === 0;
	if (data && noRuns && data.sandbox_mode !== "disabled") return null;
	const real = data
		? [...data.before, ...data.after].every(
				(run) => run.sandbox.kind === "docker",
			)
		: true;
	return (
		<Section title="Runtime evidence" id="runtime-evidence-heading">
			{evidence.error || !data ? (
				<ErrorNotice
					title="Runtime evidence could not be loaded"
					error={evidence.error}
					onRetry={() => void evidence.refetch()}
				/>
			) : noRuns ? (
				<NoSandbox verification={data.verification} />
			) : (
				<div className="space-y-5">
					<p className="max-w-[68ch] text-ink-2 text-sm">
						The same browser steps ran against the app in the sandbox before and
						after the patch. These are the recorded results, not a model's
						description.{" "}
						{!real && (
							<Status tone="warn">Test double: not a real sandbox run</Status>
						)}
					</p>
					<Claim data={data} />
					<div className="grid gap-x-8 gap-y-8 md:grid-cols-2">
						<PhasePanel phase="before" runs={data.before} />
						<PhasePanel phase="after" runs={data.after} />
					</div>
				</div>
			)}
		</Section>
	);
}
