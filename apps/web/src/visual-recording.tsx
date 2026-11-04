import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	RecordingAnalysisOutput,
	RecordingFrameTag,
	RecordingState,
} from "@tracera/contracts";
import { type ReactNode, useRef, useState } from "react";
import {
	evidenceContentUrl,
	getBugReportRecordings,
	requestRecordingRetry,
} from "./api.ts";
import { POLL_MS } from "./hooks.ts";
import {
	clockLabel,
	describeSampling,
	extractKeyframes,
	type OpenFrameSource,
	RECORDING_LIMITS,
	validateRecording,
} from "./keyframes.ts";
import {
	Badge,
	buttonClass,
	ErrorNotice,
	hintClass,
	InferenceLabel,
	inputClass,
	Loading,
	Section,
	Status,
	type Tone,
} from "./ui.tsx";
import {
	Panel,
	ScreenshotEvidence,
	subheading,
	uploadScreenshot,
} from "./visual-evidence.tsx";
import { RegionOverlay } from "./visual-locate.tsx";

// A screen recording is read as a handful of still frames. The browser takes them from the file and
// uploads only those; the recording itself never leaves the computer. Everything shown here says so:
// it was analyzed as keyframes at stated times, never "watched".

const recordingsKey = (bugReportId: string) => [
	"bug-reports",
	bugReportId,
	"recordings",
];

// ---- Sending a recording --------------------------------------------------------------------------

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** A file input for a recording. `onFile` gets the chosen file, or null when it was refused or cleared. */
export function RecordingField({
	name = "recording",
	label = "Screen recording (optional)",
	onFile,
}: {
	name?: string;
	label?: string;
	onFile?: (file: File | null) => void;
}) {
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<div>
			<label htmlFor={name} className="font-medium text-ink text-sm">
				{label}
			</label>
			<input
				id={name}
				name={name}
				type="file"
				accept="video/*"
				aria-describedby={`${name}-hint`}
				onChange={(event) => {
					const file = event.currentTarget.files?.[0] ?? null;
					const reason = file ? validateRecording(file) : null;
					setProblem(reason);
					// A rejected file must not be submitted by accident.
					if (reason) event.currentTarget.value = "";
					onFile?.(reason ? null : file);
				}}
				className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-elevated file:px-3 file:py-1 file:text-ink-2 file:text-sm`}
			/>
			<p id={`${name}-hint`} className={hintClass}>
				WebM, MP4, or MOV up to {megabytes(RECORDING_LIMITS.maxBytes)} and{" "}
				{RECORDING_LIMITS.maxSeconds / 60} minutes. Your browser takes up to{" "}
				{RECORDING_LIMITS.innerFrames + 2} still frames from it and uploads only
				those; the recording itself never leaves your computer. A model reads
				the frames, so hide anything private first.
			</p>
			{problem && (
				<p role="alert" className="mt-1 text-error text-xs">
					{problem}
				</p>
			)}
		</div>
	);
}

const newRecordingId = () => {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return `rec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

export type SendProgress = {
	phase: "reading" | "uploading";
	done: number;
	total: number;
};

/**
 * Takes the keyframes of a recording in the browser and uploads them one by one. Sending the same
 * recording ID again resumes: frames the server already holds are not stored twice.
 */
export async function sendRecording(
	bugReportId: string,
	file: File,
	options: {
		recordingId?: string;
		open?: OpenFrameSource;
		onProgress?: (progress: SendProgress) => void;
	} = {},
): Promise<{ recordingId: string; frames: number }> {
	const recordingId = options.recordingId ?? newRecordingId();
	const { durationMs, frames } = await extractKeyframes(file, {
		...(options.open ? { open: options.open } : {}),
		onProgress: (done, total) =>
			options.onProgress?.({ phase: "reading", done, total }),
	});
	for (const [position, frame] of frames.entries()) {
		const source_recording: RecordingFrameTag = {
			recording_id: recordingId,
			name: file.name.slice(0, 150),
			index: frame.index,
			count: frames.length,
			timestamp_ms: frame.timestampMs,
			duration_ms: durationMs,
		};
		await uploadScreenshot(
			bugReportId,
			new File(
				[frame.blob],
				`keyframe-${frame.index + 1}.${frame.mimeType === "image/png" ? "png" : "jpg"}`,
				{ type: frame.mimeType },
			),
			{ source_recording },
		);
		options.onProgress?.({
			phase: "uploading",
			done: position + 1,
			total: frames.length,
		});
	}
	return { recordingId, frames: frames.length };
}

/** Sends recordings one at a time and keeps the progress; a retry reuses the recording's ID. */
export function useRecordingUpload() {
	const [progress, setProgress] = useState<SendProgress | null>(null);
	const recordingId = useRef<string | null>(null);
	const mutation = useMutation({
		mutationFn: ({
			bugReportId,
			file,
		}: {
			bugReportId: string;
			file: File;
		}) => {
			recordingId.current ??= newRecordingId();
			return sendRecording(bugReportId, file, {
				recordingId: recordingId.current,
				onProgress: setProgress,
			});
		},
		onSettled: () => setProgress(null),
		// The next recording gets its own ID once this one is in.
		onSuccess: () => {
			recordingId.current = null;
		},
	});
	return { ...mutation, progress };
}

export function UploadStatus({
	upload,
	title = "The recording could not be sent",
}: {
	upload: Pick<
		ReturnType<typeof useRecordingUpload>,
		"isPending" | "progress" | "error"
	>;
	title?: string;
}) {
	return (
		<>
			{upload.isPending && (
				<Loading>
					{upload.progress
						? `${upload.progress.phase === "reading" ? "Taking keyframes" : "Uploading keyframes"}: ${upload.progress.done} of ${upload.progress.total}…`
						: "Opening the recording…"}
				</Loading>
			)}
			{upload.error && <ErrorNotice alert title={title} error={upload.error} />}
		</>
	);
}

// ---- What a recording shows -----------------------------------------------------------------------

const STATUS: Record<
	RecordingState["status"],
	{ tone: Tone; label: (r: RecordingState) => string }
> = {
	receiving: {
		tone: "progress",
		label: (r) =>
			`Receiving keyframes (${r.frames.length} of ${r.frame_count})`,
	},
	queued: { tone: "progress", label: () => "Waiting to be analyzed" },
	processing: { tone: "progress", label: () => "Analyzing" },
	succeeded: { tone: "done", label: () => "Analyzed" },
	failed: { tone: "bad", label: () => "Could not be analyzed" },
};

type TimelineEntry = RecordingAnalysisOutput["timeline"][number];

const byTime = <T extends { timestamp_seconds: number | null }>(items: T[]) =>
	[...items].sort(
		(a, b) =>
			(a.timestamp_seconds ?? Number.POSITIVE_INFINITY) -
			(b.timestamp_seconds ?? Number.POSITIVE_INFINITY),
	);

const when = (seconds: number | null) => (
	<>
		<span className="inline-block font-mono text-ink-3 text-xs">
			{seconds === null ? "time unknown" : clockLabel(seconds)}
		</span>{" "}
	</>
);

function Timeline({ items }: { items: TimelineEntry[] }) {
	return (
		<ol className="space-y-1 text-sm">
			{byTime(items).map((item, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: timeline entries have no identity
				<li key={index} className="break-words">
					{when(item.timestamp_seconds)}
					{item.statement}
				</li>
			))}
		</ol>
	);
}

function List({ children }: { children: ReactNode }) {
	return <div className="space-y-4">{children}</div>;
}

function RecordingCard({
	bugReportId,
	recording,
}: {
	bugReportId: string;
	recording: RecordingState;
}) {
	const queryClient = useQueryClient();
	const frames = recording.frames;
	const [selected, setSelected] = useState<number | null>(null);
	const current =
		frames.find((f) => f.index === selected) ??
		frames.find((f) => f.regions.length > 0) ??
		frames[0];
	const retry = useMutation({
		mutationFn: () =>
			requestRecordingRetry(bugReportId, recording.recording_id),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: recordingsKey(bugReportId) }),
	});
	const analysis = recording.analysis;
	const output = analysis?.output ?? null;
	const phrase = recording.region_phrase;
	// Only frames that were read were analyzed.
	const read = frames.filter((f) => f.observation === "succeeded");
	const seconds = read.map((f) => f.timestamp_ms / 1000);
	const settled = recording.status === "succeeded" && analysis && output;
	return (
		<article className="space-y-5">
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
				<h3 className="min-w-0 break-words font-semibold text-ink">
					{recording.name || "Screen recording"}
				</h3>
				<Status tone={STATUS[recording.status].tone}>
					{STATUS[recording.status].label(recording)}
				</Status>
				{analysis && (
					<InferenceLabel
						mock={analysis.mode === "mock"}
						detail={`${analysis.model} via ${analysis.provider}`}
					/>
				)}
				{analysis?.placeholder_provider && (
					<Badge tone="warn">Placeholder provider</Badge>
				)}
			</header>
			<p className="max-w-[68ch] text-ink-2 text-sm">
				{settled
					? describeSampling(seconds)
					: `${frames.length} of ${recording.frame_count} keyframes sampled from the recording have arrived.`}{" "}
				{settled &&
					read.length < frames.length &&
					`${frames.length - read.length} of the ${frames.length} keyframes could not be read and are not part of the analysis. `}
				Only the frames were uploaded; the recording itself stayed on the
				computer it came from.
			</p>
			{current && (
				<div className="min-w-0">
					<figure>
						<div className="relative inline-block max-w-full align-top">
							<a
								href={evidenceContentUrl(current.id)}
								target="_blank"
								rel="noreferrer"
								title="Open the full frame"
								className="block"
							>
								<img
									src={evidenceContentUrl(current.id)}
									alt={`Keyframe ${current.index + 1} of ${recording.frame_count} at ${clockLabel(current.timestamp_ms / 1000)}`}
									className="block max-h-80 w-auto max-w-full rounded border border-line bg-surface object-contain"
								/>
							</a>
							<RegionOverlay
								locations={
									phrase && current.regions.length > 0
										? [{ id: current.id, phrase, boxes: current.regions }]
										: []
								}
							/>
						</div>
						<figcaption className="mt-1.5 text-ink-3 text-xs">
							Keyframe {current.index + 1} of {recording.frame_count} at{" "}
							{clockLabel(current.timestamp_ms / 1000)}
							{phrase && current.regions.length > 0 && (
								<>
									{" "}
									· <q>{phrase}</q> located here by a segmentation model: a
									display aid, not proof of a defect
								</>
							)}
							{settled &&
								phrase &&
								!frames.some((frame) => frame.regions.length > 0) && (
									<>
										{" "}
										· No region is drawn for <q>{phrase}</q>: the segmentation
										model found nothing in the frames it was asked about, or it
										was not run
									</>
								)}
						</figcaption>
					</figure>
					<ul
						aria-label="Keyframes"
						// Relative so the screen-reader-only text stays inside the scrolling strip.
						className="relative mt-3 flex gap-2 overflow-x-auto pb-1"
					>
						{frames.map((frame) => (
							<li key={frame.id} className="shrink-0">
								<button
									type="button"
									aria-pressed={frame.id === current.id}
									onClick={() => setSelected(frame.index)}
									className={`block rounded border p-0.5 text-left ${frame.id === current.id ? "border-trace-done" : "border-line hover:border-line-strong"}`}
								>
									<img
										src={evidenceContentUrl(frame.id)}
										alt=""
										loading="lazy"
										className="block h-14 w-auto rounded-sm"
									/>
									<span className="block px-0.5 font-mono text-[11px] text-ink-3">
										{clockLabel(frame.timestamp_ms / 1000)}
										{frame.regions.length > 0 && (
											<span className="sr-only"> (region located)</span>
										)}
									</span>
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
			{recording.status === "queued" && (
				<Loading>Waiting for the keyframes to be analyzed…</Loading>
			)}
			{recording.status === "processing" && (
				<Loading>Reading the keyframes…</Loading>
			)}
			{recording.status === "receiving" && (
				<p className="text-ink-3 text-sm">
					The analysis starts when every keyframe has arrived.
				</p>
			)}
			{recording.status === "failed" && (
				<div className="space-y-3">
					<div className="border-error border-l-2 bg-error/[0.07] py-2.5 pr-3 pl-3.5 text-sm">
						<p className="font-medium text-error">
							The recording could not be analyzed
						</p>
						<p className="mt-0.5 break-words">
							<code>{recording.error?.code}</code>: {recording.error?.message}
						</p>
					</div>
					<button
						type="button"
						className={buttonClass}
						disabled={retry.isPending}
						onClick={() => retry.mutate()}
					>
						{retry.isPending ? "Requesting…" : "Try again"}
					</button>
					{retry.error && (
						<ErrorNotice
							alert
							title="The analysis could not be requested"
							error={retry.error}
						/>
					)}
				</div>
			)}
			{settled && (
				<div className="space-y-6">
					{analysis.mode === "mock" && (
						<p className="text-sm text-warning">
							[mock] No model looked at these frames; the fields below are
							placeholders.
						</p>
					)}
					<Panel
						tone="info"
						title="Seen in the keyframes"
						caption="Read from the sampled frames by a model. It can contain reading errors and has not been checked against the repository or by running anything."
					>
						<List>
							<p className="max-w-[68ch] break-words text-[15px] leading-relaxed">
								{output.summary}
							</p>
							{output.failing_element && (
								<div className="border-warning border-l-2 bg-warning/[0.06] py-2 pr-3 pl-3.5 text-sm">
									<p className="font-medium text-warning">
										Element that looks wrong
									</p>
									<p className="mt-0.5 break-words">{output.failing_element}</p>
								</div>
							)}
							{output.error_messages.length > 0 && (
								<div>
									<h4 className={subheading}>
										Error messages ({output.error_messages.length})
									</h4>
									<ul className="mt-1 space-y-1 text-sm">
										{output.error_messages.map((item, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: transcribed messages have no identity
											<li key={index} className="break-words">
												{when(item.timestamp_seconds)}
												<q className="whitespace-pre-wrap">{item.text}</q>
											</li>
										))}
									</ul>
								</div>
							)}
							{output.timeline.some((e) => e.basis === "visible") && (
								<div>
									<h4 className={subheading}>What is visible, by time</h4>
									<div className="mt-1">
										<Timeline
											items={output.timeline.filter(
												(e) => e.basis === "visible",
											)}
										/>
									</div>
								</div>
							)}
						</List>
					</Panel>
					<Panel
						tone="uncertain"
						title="Model inferences about the recording"
						caption="Guesses about what happened between and beyond the frames. None of this is visible in a frame and none of it is verified."
					>
						{output.timeline.every((e) => e.basis !== "inferred") &&
						output.reproduction_steps.length === 0 ? (
							<p className="text-ink-3 text-sm">
								The model made no inferences.
							</p>
						) : (
							<List>
								{output.timeline.some((e) => e.basis === "inferred") && (
									<Timeline
										items={output.timeline.filter(
											(e) => e.basis === "inferred",
										)}
									/>
								)}
								{output.reproduction_steps.length > 0 && (
									<div>
										<h4 className={subheading}>
											Candidate reproduction steps (a guess, not a verified
											procedure)
										</h4>
										<ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
											{output.reproduction_steps.map((item, index) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: ordered steps are identified by position
												<li key={index} className="break-words">
													{item.step}
												</li>
											))}
										</ol>
									</div>
								)}
							</List>
						)}
					</Panel>
					<Panel
						tone="neutral"
						title="Not determinable from the keyframes"
						caption="What the model could not tell from the sampled frames."
					>
						{output.missing_information.length === 0 ? (
							<p className="text-ink-3 text-sm">The model listed nothing.</p>
						) : (
							<ul className="list-disc space-y-0.5 pl-5 text-sm">
								{output.missing_information.map((item) => (
									<li key={item} className="break-words">
										{item}
									</li>
								))}
							</ul>
						)}
					</Panel>
				</div>
			)}
		</article>
	);
}

function AttachRecording({
	bugReportId,
	another = false,
}: {
	bugReportId: string;
	another?: boolean;
}) {
	const queryClient = useQueryClient();
	const upload = useRecordingUpload();
	const [file, setFile] = useState<File | null>(null);
	return (
		<form
			className="mt-6 max-w-xl space-y-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (!file) return;
				upload.mutate(
					{ bugReportId, file },
					{
						onSuccess: () =>
							queryClient.invalidateQueries({
								queryKey: recordingsKey(bugReportId),
							}),
					},
				);
			}}
		>
			<RecordingField
				name="attached-recording"
				label={another ? "Attach another screen recording" : "Screen recording"}
				onFile={setFile}
			/>
			<button
				type="submit"
				className={buttonClass}
				disabled={!file || upload.isPending}
			>
				{upload.isPending ? "Sending…" : "Attach recording"}
			</button>
			<UploadStatus upload={upload} />
		</form>
	);
}

/**
 * The investigation page's screen recording section: the sampled frames and, beside them, what a model
 * read from them. A bug report without a recording shows only a way to attach one.
 */
export function RecordingEvidence({
	bugReportId,
	version,
	active = false,
}: {
	bugReportId: string;
	/** The investigation's state version; a new one refreshes the analysis. */
	version?: number | undefined;
	/** True while the investigation is working, when its stages may wait for the analysis. */
	active?: boolean;
}) {
	const recordings = useQuery({
		queryKey: [...recordingsKey(bugReportId), version],
		queryFn: () => getBugReportRecordings(bugReportId),
		refetchInterval: (query) =>
			(query.state.data ?? []).some(
				(r) =>
					r.status === "queued" ||
					r.status === "processing" ||
					(active && r.status !== "succeeded"),
			)
				? POLL_MS
				: false,
	});
	const items = recordings.data ?? [];
	if (recordings.error)
		return (
			<Section title="Screen recording" id="recording-heading">
				<ErrorNotice
					title="The screen recordings could not be loaded"
					error={recordings.error}
					onRetry={() => void recordings.refetch()}
				/>
			</Section>
		);
	if (recordings.data === undefined) return null;
	if (items.length === 0)
		return (
			<details className="mt-10 text-sm">
				<summary className="cursor-pointer text-ink-2 hover:text-ink">
					Attach a screen recording
				</summary>
				<AttachRecording bugReportId={bugReportId} />
			</details>
		);
	return (
		<Section
			title={items.length === 1 ? "Screen recording" : "Screen recordings"}
			id="recording-heading"
		>
			<div className="space-y-12">
				{items.map((recording) => (
					<RecordingCard
						key={recording.recording_id}
						bugReportId={bugReportId}
						recording={recording}
					/>
				))}
			</div>
			<AttachRecording bugReportId={bugReportId} another />
		</Section>
	);
}

/** Screenshots and screen recordings of a bug report, as the investigation page shows them. */
export function VisualEvidence(props: {
	bugReportId: string;
	version?: number | undefined;
	active?: boolean;
}) {
	return (
		<>
			<ScreenshotEvidence {...props} />
			<RecordingEvidence {...props} />
		</>
	);
}
