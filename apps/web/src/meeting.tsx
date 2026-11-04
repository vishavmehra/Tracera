import {
	type InfiniteData,
	type UseInfiniteQueryResult,
	type UseQueryResult,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	type Meeting,
	type MeetingCandidate,
	MeetingCandidateKindSchema,
	SeveritySchema,
	type TranscriptSegment,
	type UpdateMeetingCandidateRequest,
} from "@tracera/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
	ApiError,
	confirmMeetingCandidate,
	createInvestigation,
	dismissMeetingCandidate,
	getMeeting,
	getMeetingSummaryMarkdown,
	listMeetingCandidates,
	listMeetingSegments,
	requestMeetingExtraction,
	updateMeetingCandidate,
} from "./api.ts";
import { POLL_MS } from "./hooks.ts";
import {
	clock,
	ExtractionTag,
	formatBytes,
	isExtracting,
	MeetingStatusBadge,
	meetingTitle,
	plural,
	RepositoryOptions,
	sourceLabel,
	useRepositories,
} from "./meeting-parts.tsx";
import { candidatePatch, confirmBody } from "./meeting-wire.ts";
import {
	Badge,
	Breadcrumbs,
	buttonClass,
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
	OutcomeBadge,
	panelClass,
	primaryButtonClass,
	QueryView,
	quietButtonClass,
	SnapshotError,
	StateBadge,
	Status,
	Time,
	type Tone,
} from "./ui.tsx";

type Citation = MeetingCandidate["citations"][number];
type Highlight = { segmentId: string; quote: string | null };
type SegmentPages = InfiniteData<
	Awaited<ReturnType<typeof listMeetingSegments>>,
	unknown
>;
type SegmentsQuery = UseInfiniteQueryResult<SegmentPages>;

const FORMAT_LABELS: Record<Meeting["transcript"]["format"], string> = {
	webvtt: "WebVTT",
	srt: "SubRip",
	speaker_text: "Speaker lines",
	plain_text: "Plain text",
	meet_entries: "Google Meet entries",
};

const segmentDomId = (id: string) => `segment-${id}`;
const candidateDomId = (id: string) => `candidate-${id}`;
const speakerOf = (item: {
	speaker_name: string | null;
	speaker_label: string | null;
}) => item.speaker_name ?? item.speaker_label ?? "Unknown speaker";

const KIND_LABELS: Record<MeetingCandidate["kind"], string> = {
	bug: "Bug",
	feature_request: "Feature request",
	question: "Question",
	other: "Other topic",
};

const CANDIDATE_STATUS: Record<
	MeetingCandidate["status"],
	{ tone: Tone; words: string }
> = {
	pending_review: { tone: "uncertain", words: "Proposed, not confirmed" },
	confirmed: { tone: "decision", words: "Confirmed by a person" },
	dismissed: { tone: "neutral", words: "Dismissed" },
	rejected: { tone: "neutral", words: "Rejected: no valid citation" },
};

const SUPPORT_REASONS: Record<string, string> = {
	unknown_segment: "a cited segment was not among those sent",
	quote_not_in_segment: "a quote was not found in the segment it cites",
	no_valid_citation: "no citation passed the check",
};

// ---- The page -----------------------------------------------------------------------------------

export function MeetingPage() {
	const { meetingId = "" } = useParams();
	const queryClient = useQueryClient();
	const meeting = useQuery({
		queryKey: ["meeting", meetingId],
		queryFn: () => getMeeting(meetingId),
		refetchInterval: (query) =>
			query.state.data && isExtracting(query.state.data.status)
				? POLL_MS
				: false,
	});
	const candidates = useQuery({
		queryKey: ["meeting-candidates", meetingId],
		queryFn: () => listMeetingCandidates(meetingId),
	});
	const segments = useInfiniteQuery({
		queryKey: ["meeting-segments", meetingId],
		queryFn: ({ pageParam }) => listMeetingSegments(meetingId, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.next_cursor ?? undefined,
	});
	// Candidates are written when extraction finishes: read them again when the status moves.
	const status = meeting.data?.status;
	const seen = useRef(status);
	useEffect(() => {
		if (
			seen.current !== undefined &&
			status !== undefined &&
			seen.current !== status
		)
			void queryClient.invalidateQueries({
				queryKey: ["meeting-candidates", meetingId],
			});
		seen.current = status;
	}, [status, meetingId, queryClient]);
	return (
		<>
			{!meeting.data && (
				<Breadcrumbs
					items={[
						{ key: "list", label: "Meetings", to: "/meetings" },
						{ key: "this", label: "Meeting" },
					]}
				/>
			)}
			<div className={meeting.data ? undefined : "mt-6"}>
				<QueryView query={meeting} what="Meeting">
					{(data) => (
						<MeetingView
							meeting={data}
							candidates={candidates}
							segments={segments}
						/>
					)}
				</QueryView>
			</div>
		</>
	);
}

function MeetingView({
	meeting,
	candidates,
	segments,
}: {
	meeting: Meeting;
	candidates: UseQueryResult<MeetingCandidate[]>;
	segments: SegmentsQuery;
}) {
	const queryClient = useQueryClient();
	const [highlight, setHighlight] = useState<Highlight | null>(null);
	const title = meetingTitle(meeting);
	const hasSegment = (data: SegmentPages | undefined, id: string) =>
		data?.pages.some((page) => page.items.some((s) => s.id === id)) === true;
	/** Loads transcript pages until the cited segment is on screen, then marks it. */
	const reveal = async (citation: Citation) => {
		let data = segments.data;
		let more = segments.hasNextPage;
		while (!hasSegment(data, citation.segment_id) && more) {
			const next = await segments.fetchNextPage();
			if (next.isError) break;
			data = next.data;
			more = next.hasNextPage;
		}
		setHighlight({ segmentId: citation.segment_id, quote: citation.quote });
	};
	const changed = (next: MeetingCandidate) => {
		queryClient.setQueryData<MeetingCandidate[]>(
			["meeting-candidates", meeting.id],
			(old) => old?.map((item) => (item.id === next.id ? next : item)),
		);
		void queryClient.invalidateQueries({ queryKey: ["meeting", meeting.id] });
		void queryClient.invalidateQueries({ queryKey: ["meetings"] });
	};
	const citedBy = new Map<string, number[]>();
	for (const candidate of candidates.data ?? [])
		for (const citation of candidate.citations)
			citedBy.set(citation.segment_id, [
				...(citedBy.get(citation.segment_id) ?? []),
				candidate.ordinal,
			]);
	const byOrdinal = new Map(
		(candidates.data ?? []).map((candidate) => [
			candidate.ordinal,
			candidate.id,
		]),
	);
	return (
		<>
			<title>{`${title} · Meetings · Tracera`}</title>
			<Breadcrumbs
				items={[
					{ key: "list", label: "Meetings", to: "/meetings" },
					{ key: "this", label: title },
				]}
			/>
			<MeetingHeader meeting={meeting} title={title} />
			<div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
				<CandidatesSection
					meeting={meeting}
					candidates={candidates}
					onCite={(citation) => void reveal(citation)}
					onChanged={changed}
				/>
				<TranscriptPanel
					meeting={meeting}
					segments={segments}
					highlight={highlight}
					citedBy={citedBy}
					onBack={(ordinal) => {
						const id = byOrdinal.get(ordinal);
						const card = id && document.getElementById(candidateDomId(id));
						if (!card) return;
						card.scrollIntoView({ block: "start" });
						card.focus({ preventScroll: true });
					}}
				/>
			</div>
		</>
	);
}

// ---- Header: what this meeting is, where it came from, how it was read -------------------------

function MeetingHeader({
	meeting,
	title,
}: {
	meeting: Meeting;
	title: string;
}) {
	const queryClient = useQueryClient();
	const { transcript, extraction } = meeting;
	const summary = useMutation({
		mutationFn: async () => {
			const text = await getMeetingSummaryMarkdown(meeting.id);
			const url = URL.createObjectURL(
				new Blob([text], { type: "text/markdown;charset=utf-8" }),
			);
			const link = Object.assign(document.createElement("a"), {
				href: url,
				download: `meeting-summary-${meeting.id}.md`,
			});
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		},
	});
	const retry = useMutation({
		mutationFn: () => requestMeetingExtraction(meeting.id),
		onSuccess: async (next) => {
			queryClient.setQueryData(["meeting", meeting.id], next);
			await queryClient.invalidateQueries({ queryKey: ["meetings"] });
		},
	});
	return (
		<>
			<div className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
				<div className="min-w-0">
					<h1 className="break-words font-semibold text-2xl tracking-tight">
						{title}
					</h1>
					<p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
						<MeetingStatusBadge status={meeting.status} />
						<ExtractionTag extraction={extraction} />
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					{meeting.status === "failed" && (
						<button
							type="button"
							className={buttonClass}
							disabled={retry.isPending}
							onClick={() => retry.mutate()}
						>
							{retry.isPending ? "Starting…" : "Retry extraction"}
						</button>
					)}
					<button
						type="button"
						className={buttonClass}
						disabled={summary.isPending}
						onClick={() => summary.mutate()}
					>
						{summary.isPending ? "Preparing…" : "Download summary (Markdown)"}
					</button>
				</div>
			</div>
			{(summary.error || retry.error) && (
				<div className="mt-4 space-y-3">
					{summary.error && (
						<ErrorNotice
							alert
							title="The summary could not be downloaded"
							error={summary.error}
						/>
					)}
					{retry.error && (
						<ErrorNotice
							alert
							title="Extraction could not be restarted"
							error={retry.error}
						/>
					)}
				</div>
			)}
			<Facts
				className="mt-5"
				items={[
					["Source", sourceLabel(meeting)],
					meeting.occurred_at
						? ["Held", <Time key="held" iso={meeting.occurred_at} />]
						: null,
					["Added", <Time key="added" iso={meeting.created_at} />],
					[
						"Transcript",
						`${FORMAT_LABELS[transcript.format]}, ${plural(transcript.segment_count, "segment")}, ${formatBytes(transcript.size_bytes)}${transcript.duration_ms === null ? "" : `, ${clock(transcript.duration_ms)} long`}`,
					],
					transcript.speaker_labels.length > 0 && [
						"Speakers",
						plural(transcript.speaker_labels.length, "label"),
					],
				]}
			/>
			{meeting.flags.includes("injection_suspected") && (
				<p
					role="note"
					className="mt-4 border-warning border-l-2 bg-warning/[0.07] py-2 pr-3 pl-3.5 text-ink-2 text-sm"
				>
					<span className="font-medium text-warning">
						Instruction-like text found.
					</span>{" "}
					The transcript contains wording that reads like instructions to an AI
					assistant. Tracera treats it as data only; compare each candidate with
					its quotes before you confirm it.
				</p>
			)}
			{meeting.status === "failed" && meeting.failure && (
				<div
					role="alert"
					className="mt-4 border-error border-l-2 bg-error/[0.07] py-2.5 pr-3 pl-3.5 text-sm"
				>
					<p className="font-medium text-error">Extraction failed</p>
					<SnapshotError error={meeting.failure} />
				</div>
			)}
			<Limitations items={transcript.warnings} />
		</>
	);
}

/** How the candidates were produced, from the stored extraction record. */
function ExtractionNote({ meeting }: { meeting: Meeting }) {
	const ex = meeting.extraction;
	if (isExtracting(meeting.status))
		return (
			<Loading>
				{meeting.status === "transcribed"
					? "Extraction is queued. It starts when a worker picks it up."
					: "Extraction is running."}
			</Loading>
		);
	if (!ex) return null;
	return (
		<div className="space-y-1.5 text-ink-2 text-xs">
			<p className="flex flex-wrap items-center gap-x-2 gap-y-1">
				{ex.selection === "none" ? (
					<span className="font-medium text-ink">No model was called.</span>
				) : (
					<ExtractionTag extraction={ex} detail />
				)}
				<span>
					Finished <Time iso={ex.finished_at} />
				</span>
			</p>
			{ex.skipped_reason === "no_bug_signals" && (
				<p>
					No segment contained wording that points to a defect, so nothing was
					sent to a model.
				</p>
			)}
			{ex.selection !== "none" && (
				<>
					<p>
						{ex.mock
							? "No model analysed this transcript: the candidates are scripted test output."
							: "A model proposed the candidates. Code then checked that every quote appears in the segment it cites."}
					</p>
					<p>
						{ex.segments_sent} of {ex.segments_total} segments were sent
						{ex.selection === "signal_windows"
							? " (those with bug signals and their neighbours)"
							: ""}
						. {ex.items_proposed} items were proposed, {ex.rejected} rejected
						for lacking a valid citation. {ex.citations_invalid} of{" "}
						{ex.citations_total} citations failed the quote check and were
						dropped.
					</p>
				</>
			)}
		</div>
	);
}

// ---- Candidates ---------------------------------------------------------------------------------

function CandidatesSection({
	meeting,
	candidates,
	onCite,
	onChanged,
}: {
	meeting: Meeting;
	candidates: UseQueryResult<MeetingCandidate[]>;
	onCite: (citation: Citation) => void;
	onChanged: (candidate: MeetingCandidate) => void;
}) {
	return (
		<section aria-labelledby="candidates-heading" className="min-w-0">
			<h2
				id="candidates-heading"
				className="border-line border-b pb-2 font-semibold text-base"
			>
				Candidates
			</h2>
			<p className="mt-3 max-w-2xl text-ink-2 text-sm">
				Proposed from the transcript. Nothing here is a bug report until you
				confirm it.
			</p>
			<div className="mt-3">
				<ExtractionNote meeting={meeting} />
			</div>
			<div className="mt-6">
				<QueryView query={candidates} what="Candidates">
					{(items) => {
						const pending = items.filter((c) => c.status === "pending_review");
						const groups: Array<[string, MeetingCandidate[]]> = [
							[
								"Bug candidates to review",
								pending.filter((c) => c.kind === "bug"),
							],
							["Other topics", pending.filter((c) => c.kind !== "bug")],
							[
								"Decided",
								items.filter(
									(c) => c.status === "confirmed" || c.status === "dismissed",
								),
							],
						];
						const rejected = items.filter((c) => c.status === "rejected");
						if (items.length === 0)
							return isExtracting(meeting.status) ? null : (
								<Empty>
									No candidates were proposed from this transcript. That does
									not mean no bug was discussed.
								</Empty>
							);
						return (
							<div className="space-y-8">
								{groups.map(
									([label, group]) =>
										group.length > 0 && (
											<section key={label} aria-label={label}>
												<h3 className="mb-3 font-medium text-ink text-sm">
													{label} ({group.length})
												</h3>
												<ul className="space-y-4">
													{group.map((candidate) => (
														<li key={candidate.id}>
															<CandidateCard
																meeting={meeting}
																candidate={candidate}
																onCite={onCite}
																onChanged={onChanged}
															/>
														</li>
													))}
												</ul>
											</section>
										),
								)}
								{rejected.length > 0 && (
									<details className="text-sm">
										<summary className="cursor-pointer text-ink-2 hover:text-ink">
											Rejected by the citation check ({rejected.length})
										</summary>
										<ul className="mt-2 list-disc space-y-1 pl-6 text-ink-2">
											{rejected.map((candidate) => (
												<li key={candidate.id} className="break-words">
													{candidate.title}
													<span className="text-ink-3 text-xs">
														{" "}
														(
														{candidate.support.reasons
															.map((r) => SUPPORT_REASONS[r] ?? humanize(r))
															.join("; ") || "no valid citation"}
														)
													</span>
												</li>
											))}
										</ul>
									</details>
								)}
							</div>
						);
					}}
				</QueryView>
			</div>
		</section>
	);
}

function supportText(support: MeetingCandidate["support"]) {
	const reasons = support.reasons
		.map((reason) => SUPPORT_REASONS[reason] ?? humanize(reason))
		.join("; ");
	if (support.status === "supported")
		return `${plural(support.citations_valid, "quote")} found in the cited ${support.citations_valid === 1 ? "segment" : "segments"}.`;
	const total = support.citations_valid + support.citations_dropped;
	return support.status === "partially_supported"
		? `${support.citations_valid} of ${total} citations passed the check; ${support.citations_dropped} dropped (${reasons}).`
		: `No citation passed the check (${reasons}).`;
}

function CandidateCard({
	meeting,
	candidate,
	onCite,
	onChanged,
}: {
	meeting: Meeting;
	candidate: MeetingCandidate;
	onCite: (citation: Citation) => void;
	onChanged: (candidate: MeetingCandidate) => void;
}) {
	const [mode, setMode] = useState<"view" | "edit" | "dismiss">("view");
	const card = useRef<HTMLElement>(null);
	// A decision removes the controls that had focus: continue from the card itself.
	const decided = useRef(candidate.status);
	useEffect(() => {
		if (decided.current === candidate.status) return;
		decided.current = candidate.status;
		card.current?.focus();
	}, [candidate.status]);
	const pending = candidate.status === "pending_review";
	const edited = Object.entries(candidate.field_sources)
		.filter(([, source]) => source === "user_edited")
		.map(([field]) => humanize(field));
	const state = CANDIDATE_STATUS[candidate.status];
	return (
		<article
			id={candidateDomId(candidate.id)}
			ref={card}
			tabIndex={-1}
			aria-label={`Candidate ${candidate.ordinal}: ${candidate.title}`}
			className={panelClass}
		>
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<span className="font-medium text-ink-3 text-xs">
					Candidate {candidate.ordinal}
				</span>
				<Badge tone="neutral">{KIND_LABELS[candidate.kind]}</Badge>
				<Badge tone={candidate.severity === "unknown" ? "neutral" : "warn"}>
					{candidate.severity === "unknown"
						? "Severity not set"
						: `Severity ${candidate.severity}`}
				</Badge>
				<span className="ml-auto">
					<Status tone={state.tone} title={candidate.status}>
						{state.words}
					</Status>
				</span>
			</header>
			{mode === "edit" ? (
				<EditCandidate
					meeting={meeting}
					candidate={candidate}
					onCancel={() => setMode("view")}
					onSaved={(next) => {
						setMode("view");
						onChanged(next);
					}}
				/>
			) : (
				<CandidateFields candidate={candidate} />
			)}
			<div className="mt-4">
				<p className="text-ink-3 text-xs">Evidence from the transcript</p>
				<ul className="mt-2 space-y-3">
					{candidate.citations.map((citation) => (
						<li key={citation.segment_id}>
							<p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
								<button
									type="button"
									className={`${linkClass} font-medium`}
									title="Show this segment in the transcript"
									onClick={() => onCite(citation)}
								>
									Segment {citation.index}
								</button>
								{citation.start_ms !== null && (
									<span className="text-ink-3 tabular-nums">
										{clock(citation.start_ms)}
									</span>
								)}
								<span className="text-ink-2">{speakerOf(citation)}</span>
							</p>
							<blockquote className="mt-1 break-words border-line-strong border-l-2 pl-3 text-ink-2">
								“{citation.quote ?? citation.text}”
							</blockquote>
							{citation.quote === null && (
								<p className={hintClass}>
									Added by a person: the whole segment is shown.
								</p>
							)}
						</li>
					))}
				</ul>
				<p
					className={`mt-2 text-xs ${candidate.support.status === "supported" ? "text-ink-3" : "text-warning"}`}
				>
					{supportText(candidate.support)}
				</p>
			</div>
			{candidate.duplicate_of && (
				<DuplicateNote
					candidate={candidate}
					onChanged={onChanged}
					meeting={meeting}
				/>
			)}
			<p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-3 text-xs">
				<ExtractionTag extraction={meeting.extraction} detail />
				<span>
					Proposed from the transcript
					{edited.length > 0 && `; edited by a person: ${edited.join(", ")}`}
				</span>
			</p>
			{pending && mode === "view" && (
				<CandidateActions
					meeting={meeting}
					candidate={candidate}
					onEdit={() => setMode("edit")}
					onDismiss={() => setMode("dismiss")}
					onChanged={onChanged}
				/>
			)}
			{pending && mode === "dismiss" && (
				<DismissForm
					meeting={meeting}
					candidate={candidate}
					onCancel={() => setMode("view")}
					onDone={onChanged}
				/>
			)}
			{candidate.status === "confirmed" && (
				<Filed meeting={meeting} candidate={candidate} />
			)}
			{candidate.status === "dismissed" && candidate.review && (
				<p className="mt-4 text-ink-3 text-xs">
					Dismissed <Time iso={candidate.review.decided_at} />
					{candidate.review.reason && `: ${candidate.review.reason}`}
				</p>
			)}
		</article>
	);
}

function CandidateFields({ candidate }: { candidate: MeetingCandidate }) {
	return (
		<>
			<h4
				id={`${candidateDomId(candidate.id)}-title`}
				className="mt-3 break-words font-semibold text-base text-ink"
			>
				{candidate.title}
			</h4>
			<p className="mt-1.5 whitespace-pre-line break-words text-ink-2">
				{candidate.description}
			</p>
			{(candidate.expected_behavior || candidate.actual_behavior) && (
				<dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
					{candidate.expected_behavior && (
						<div className="min-w-0">
							<dt className="text-ink-3 text-xs">Expected</dt>
							<dd className="break-words">{candidate.expected_behavior}</dd>
						</div>
					)}
					{candidate.actual_behavior && (
						<div className="min-w-0">
							<dt className="text-ink-3 text-xs">Actual</dt>
							<dd className="break-words">{candidate.actual_behavior}</dd>
						</div>
					)}
				</dl>
			)}
			{candidate.steps.length > 0 && (
				<div className="mt-3 text-sm">
					<p className="text-ink-3 text-xs">Steps mentioned</p>
					<ol className="mt-1 list-decimal space-y-0.5 pl-5 text-ink-2">
						{candidate.steps.map((step) => (
							<li key={step} className="break-words">
								{step}
							</li>
						))}
					</ol>
				</div>
			)}
			{candidate.affected_area && (
				<p className="mt-3 break-words text-ink-3 text-xs">
					Area mentioned: {candidate.affected_area}
				</p>
			)}
		</>
	);
}

function DuplicateNote({
	meeting,
	candidate,
	onChanged,
}: {
	meeting: Meeting;
	candidate: MeetingCandidate;
	onChanged: (candidate: MeetingCandidate) => void;
}) {
	const clear = useMutation({
		mutationFn: () =>
			updateMeetingCandidate(meeting.id, candidate.id, { not_duplicate: true }),
		onSuccess: onChanged,
	});
	const duplicate = candidate.duplicate_of;
	if (!duplicate) return null;
	return (
		<div className="mt-4 border-warning border-l-2 bg-warning/[0.07] py-2 pr-3 pl-3.5 text-sm">
			<p className="font-medium text-warning">Possible duplicate</p>
			<p className="mt-0.5 break-words text-ink-2">
				Similar to the{" "}
				{duplicate.type === "bug_report" ? "bug report" : "candidate"} “
				{duplicate.title}” (<code>{duplicate.id}</code>, text similarity{" "}
				{duplicate.similarity.toFixed(2)}). This is a text-similarity signal,
				not a decision.
			</p>
			{candidate.status === "pending_review" && (
				<button
					type="button"
					className={`${quietButtonClass} mt-1.5`}
					disabled={clear.isPending}
					onClick={() => clear.mutate()}
				>
					{clear.isPending ? "Saving…" : "I checked: not a duplicate"}
				</button>
			)}
			{clear.error && (
				<ErrorNotice
					alert
					title="The flag could not be cleared"
					error={clear.error}
				/>
			)}
		</div>
	);
}

function CandidateActions({
	meeting,
	candidate,
	onEdit,
	onDismiss,
	onChanged,
}: {
	meeting: Meeting;
	candidate: MeetingCandidate;
	onEdit: () => void;
	onDismiss: () => void;
	onChanged: (candidate: MeetingCandidate) => void;
}) {
	const repositories = useRepositories();
	const known = candidate.repository_id ?? meeting.repository_id;
	const [repositoryId, setRepositoryId] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	const confirm = useMutation({
		mutationFn: () =>
			confirmMeetingCandidate(
				meeting.id,
				candidate.id,
				confirmBody({
					repositoryKnown: Boolean(known),
					repositoryId,
					duplicate: Boolean(candidate.duplicate_of),
				}),
			),
		onSuccess: (done) => onChanged(done.candidate),
	});
	const isBug = candidate.kind === "bug";
	const blocked = !isBug
		? "Only bug candidates can be filed. Use Edit to change the type if this is a defect."
		: candidate.duplicate_of && !acknowledged
			? "Acknowledge the possible duplicate first."
			: null;
	const note = `confirm-note-${candidate.id}`;
	return (
		<div className="mt-5 border-line border-t pt-4">
			{isBug && candidate.duplicate_of && (
				<label className="mb-3 flex items-start gap-2.5 text-ink-2 text-sm">
					<input
						type="checkbox"
						checked={acknowledged}
						onChange={(event) => setAcknowledged(event.target.checked)}
						className="mt-0.5 size-4 shrink-0 accent-link"
					/>
					<span>
						I looked at the possible duplicate and still want to file this.
					</span>
				</label>
			)}
			{isBug && !known && (
				<div className="mb-3 max-w-sm">
					<label htmlFor={`repo-${candidate.id}`} className={labelClass}>
						Repository for the bug report (optional)
					</label>
					<select
						id={`repo-${candidate.id}`}
						value={repositoryId}
						onChange={(event) => setRepositoryId(event.target.value)}
						className={inputClass}
					>
						<RepositoryOptions
							items={repositories.data?.items}
							none="No repository yet"
						/>
					</select>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				<button
					type="button"
					className={primaryButtonClass}
					disabled={blocked !== null || confirm.isPending}
					aria-describedby={blocked ? note : undefined}
					onClick={() => confirm.mutate()}
				>
					{confirm.isPending ? "Creating…" : "Confirm and create bug report"}
				</button>
				<button type="button" className={buttonClass} onClick={onEdit}>
					Edit
				</button>
				<button type="button" className={buttonClass} onClick={onDismiss}>
					Dismiss
				</button>
			</div>
			<p id={note} className={hintClass}>
				{blocked ??
					"Creates a bug report from this candidate. It does not start an investigation."}
			</p>
			{confirm.error && (
				<div className="mt-3">
					<ErrorNotice
						alert
						title="The bug report could not be created"
						error={confirm.error}
					/>
				</div>
			)}
		</div>
	);
}

function DismissForm({
	meeting,
	candidate,
	onCancel,
	onDone,
}: {
	meeting: Meeting;
	candidate: MeetingCandidate;
	onCancel: () => void;
	onDone: (candidate: MeetingCandidate) => void;
}) {
	const dismiss = useMutation({
		mutationFn: (reason: string) =>
			dismissMeetingCandidate(meeting.id, candidate.id, reason || undefined),
		onSuccess: onDone,
	});
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		dismiss.mutate(
			String(new FormData(event.currentTarget).get("reason") ?? "").trim(),
		);
	};
	return (
		<form onSubmit={submit} className="mt-5 border-line border-t pt-4">
			<label htmlFor={`reason-${candidate.id}`} className={labelClass}>
				Reason (optional)
			</label>
			<textarea
				id={`reason-${candidate.id}`}
				name="reason"
				rows={2}
				maxLength={500}
				className={inputClass}
			/>
			{dismiss.error && (
				<div className="mt-3">
					<ErrorNotice
						alert
						title="The candidate could not be dismissed"
						error={dismiss.error}
					/>
				</div>
			)}
			<div className="mt-3 flex flex-wrap gap-2">
				<button
					type="submit"
					className={buttonClass}
					disabled={dismiss.isPending}
				>
					{dismiss.isPending ? "Dismissing…" : "Dismiss candidate"}
				</button>
				<button type="button" className={quietButtonClass} onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}

function EditCandidate({
	meeting,
	candidate,
	onCancel,
	onSaved,
}: {
	meeting: Meeting;
	candidate: MeetingCandidate;
	onCancel: () => void;
	onSaved: (candidate: MeetingCandidate) => void;
}) {
	const repositories = useRepositories();
	const [nothing, setNothing] = useState(false);
	const save = useMutation({
		mutationFn: (patch: UpdateMeetingCandidateRequest) =>
			updateMeetingCandidate(meeting.id, candidate.id, patch),
		onSuccess: onSaved,
	});
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const text = (name: string) => String(form.get(name) ?? "").trim();
		const patch = candidatePatch(candidate, text);
		setNothing(Object.keys(patch).length === 0);
		if (Object.keys(patch).length > 0) save.mutate(patch);
	};
	const id = (name: string) => `${name}-${candidate.id}`;
	return (
		<form onSubmit={submit} className="mt-4 space-y-4">
			<div className="grid gap-4 sm:grid-cols-2">
				<div>
					<label htmlFor={id("kind")} className={labelClass}>
						Type
					</label>
					<select
						id={id("kind")}
						name="kind"
						defaultValue={candidate.kind}
						className={inputClass}
					>
						{MeetingCandidateKindSchema.options.map((kind) => (
							<option key={kind} value={kind}>
								{KIND_LABELS[kind]}
							</option>
						))}
					</select>
				</div>
				<div>
					<label htmlFor={id("severity")} className={labelClass}>
						Severity
					</label>
					<select
						id={id("severity")}
						name="severity"
						defaultValue={candidate.severity}
						className={inputClass}
					>
						{SeveritySchema.options.map((value) => (
							<option key={value} value={value}>
								{humanize(value)}
							</option>
						))}
					</select>
				</div>
			</div>
			<div>
				<label htmlFor={id("title")} className={labelClass}>
					Title
				</label>
				<input
					id={id("title")}
					name="title"
					defaultValue={candidate.title}
					maxLength={200}
					className={inputClass}
				/>
			</div>
			<div>
				<label htmlFor={id("description")} className={labelClass}>
					Description
				</label>
				<textarea
					id={id("description")}
					name="description"
					rows={4}
					defaultValue={candidate.description}
					className={inputClass}
				/>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<div>
					<label htmlFor={id("expected")} className={labelClass}>
						Expected behavior
					</label>
					<textarea
						id={id("expected")}
						name="expected"
						rows={2}
						defaultValue={candidate.expected_behavior ?? ""}
						className={inputClass}
					/>
				</div>
				<div>
					<label htmlFor={id("actual")} className={labelClass}>
						Actual behavior
					</label>
					<textarea
						id={id("actual")}
						name="actual"
						rows={2}
						defaultValue={candidate.actual_behavior ?? ""}
						className={inputClass}
					/>
				</div>
			</div>
			<div>
				<label htmlFor={id("steps")} className={labelClass}>
					Steps (one per line)
				</label>
				<textarea
					id={id("steps")}
					name="steps"
					rows={3}
					defaultValue={candidate.steps.join("\n")}
					className={inputClass}
				/>
			</div>
			<div className="max-w-sm">
				<label htmlFor={id("repository_id")} className={labelClass}>
					Repository
				</label>
				<select
					id={id("repository_id")}
					name="repository_id"
					defaultValue={candidate.repository_id ?? ""}
					className={inputClass}
				>
					<RepositoryOptions
						items={repositories.data?.items}
						none="No repository"
					/>
				</select>
			</div>
			{nothing && <p className="text-ink-3 text-sm">Nothing was changed.</p>}
			{save.error && (
				<ErrorNotice
					alert
					title="The candidate could not be saved"
					error={save.error}
				/>
			)}
			<div className="flex flex-wrap gap-2">
				<button
					type="submit"
					className={primaryButtonClass}
					disabled={save.isPending}
				>
					{save.isPending ? "Saving…" : "Save changes"}
				</button>
				<button type="button" className={quietButtonClass} onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}

// ---- After a confirmation -----------------------------------------------------------------------

function Filed({
	meeting,
	candidate,
}: {
	meeting: Meeting;
	candidate: MeetingCandidate;
}) {
	const { bug_report: bug, investigation } = candidate;
	return (
		<div className="mt-5 space-y-3 border-line border-t pt-4 text-sm">
			<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="font-medium">Bug report created</span>
				{bug && (
					<>
						<code className="text-xs">{bug.id}</code>
						<StateBadge value={bug.status} />
					</>
				)}
				{candidate.review && (
					<span className="text-ink-3 text-xs">
						Confirmed <Time iso={candidate.review.decided_at} />
					</span>
				)}
			</p>
			{investigation ? (
				<p className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<span>Investigation</span>
					<StateBadge value={investigation.status} />
					{investigation.verification_outcome && (
						<OutcomeBadge outcome={investigation.verification_outcome} />
					)}
					<Link
						to={`/investigations/${investigation.id}`}
						className={linkClass}
					>
						Open the investigation
					</Link>
				</p>
			) : (
				bug && (
					<StartInvestigation
						meeting={meeting}
						candidate={candidate}
						bugReportId={bug.id}
					/>
				)
			)}
		</div>
	);
}

function StartInvestigation({
	meeting,
	candidate,
	bugReportId,
}: {
	meeting: Meeting;
	candidate: MeetingCandidate;
	bugReportId: string;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const repositories = useRepositories();
	const [repositoryId, setRepositoryId] = useState(
		candidate.repository_id ?? meeting.repository_id ?? "",
	);
	const [mode, setMode] = useState<"full" | "analysis_only">("full");
	const start = useMutation({
		mutationFn: () =>
			createInvestigation({
				bug_report_id: bugReportId,
				repository_id: repositoryId,
				mode,
			}),
		onSuccess: async ({ investigation }) => {
			await queryClient.invalidateQueries({ queryKey: ["investigations"] });
			await queryClient.invalidateQueries({
				queryKey: ["meeting-candidates", meeting.id],
			});
			navigate(`/investigations/${investigation.id}`);
		},
	});
	const active =
		start.error instanceof ApiError &&
		start.error.code === "investigation_active" &&
		typeof start.error.extra.investigation_id === "string"
			? start.error.extra.investigation_id
			: null;
	const id = (name: string) => `${name}-${candidate.id}`;
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				start.mutate();
			}}
			className="grid gap-3 sm:grid-cols-2"
		>
			<div>
				<label htmlFor={id("inv-repo")} className={labelClass}>
					Repository
				</label>
				<select
					id={id("inv-repo")}
					value={repositoryId}
					required
					onChange={(event) => setRepositoryId(event.target.value)}
					className={inputClass}
				>
					<RepositoryOptions
						items={repositories.data?.items}
						none="Choose a repository"
					/>
				</select>
			</div>
			<div>
				<label htmlFor={id("inv-mode")} className={labelClass}>
					Mode
				</label>
				<select
					id={id("inv-mode")}
					value={mode}
					onChange={(event) =>
						setMode(
							event.target.value === "analysis_only" ? "analysis_only" : "full",
						)
					}
					className={inputClass}
				>
					<option value="full">
						Full (sandboxed reproduction and verification)
					</option>
					<option value="analysis_only">Analysis only (no sandbox)</option>
				</select>
				<p className={hintClass}>
					Without a sandbox the server runs analysis only and says so.
				</p>
			</div>
			<div className="space-y-2 sm:col-span-2">
				{start.error && (
					<ErrorNotice
						alert
						title="The investigation could not start"
						error={start.error}
					/>
				)}
				{active && (
					<Link to={`/investigations/${active}`} className={linkClass}>
						Open the active investigation
					</Link>
				)}
				<button
					type="submit"
					className={primaryButtonClass}
					disabled={start.isPending || repositoryId === ""}
				>
					{start.isPending ? "Starting…" : "Start investigation"}
				</button>
			</div>
		</form>
	);
}

// ---- Transcript ---------------------------------------------------------------------------------

/** The range of `quote` inside `text`, ignoring case and the quote marks around it. */
function findQuote(text: string, quote: string): [number, number] | null {
	const core = quote.trim().replace(/^["'“”‘’\s]+|["'“”‘’.,;:!?\s]+$/g, "");
	const lower = text.toLowerCase();
	if (!core || lower.length !== text.length) return null;
	const at = lower.indexOf(core.toLowerCase());
	return at < 0 ? null : [at, at + core.length];
}

function SegmentRow({
	segment,
	timing,
	highlight,
	cited,
	onBack,
}: {
	segment: TranscriptSegment;
	timing: Meeting["transcript"]["timing"];
	highlight: Highlight | null;
	cited: number[];
	onBack: (ordinal: number) => void;
}) {
	const marked = highlight?.segmentId === segment.id ? highlight : null;
	const active = marked !== null;
	const range = marked?.quote ? findQuote(segment.text, marked.quote) : null;
	return (
		<li
			id={segmentDomId(segment.id)}
			tabIndex={-1}
			aria-current={active ? "true" : undefined}
			className={`grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2 border-l-2 py-2 pr-2 pl-2 outline-none ${active ? "border-accent bg-interactive/50 text-ink" : "border-transparent"}`}
		>
			<span
				aria-hidden="true"
				className="text-right text-ink-3 text-xs tabular-nums"
			>
				{segment.index}
			</span>
			<div className="min-w-0">
				<p className="flex flex-wrap items-baseline gap-x-2 text-xs">
					{segment.start_ms !== null && timing !== "none" && (
						<span className="text-ink-3 tabular-nums">
							{clock(segment.start_ms)}
						</span>
					)}
					<span className="font-medium text-ink-2">{speakerOf(segment)}</span>
				</p>
				<p className="mt-0.5 break-words text-sm">
					<span className="sr-only">Segment {segment.index}: </span>
					{range ? (
						<>
							{segment.text.slice(0, range[0])}
							<mark className="rounded-sm bg-accent/25 px-0.5 text-ink">
								{segment.text.slice(range[0], range[1])}
							</mark>
							{segment.text.slice(range[1])}
						</>
					) : (
						segment.text
					)}
				</p>
				{cited.length > 0 && (
					<p className="mt-1 flex flex-wrap items-center gap-x-2 text-ink-3 text-xs">
						Cited by
						{cited.map((ordinal) => (
							<button
								key={ordinal}
								type="button"
								className={linkClass}
								onClick={() => onBack(ordinal)}
							>
								candidate {ordinal}
							</button>
						))}
					</p>
				)}
			</div>
		</li>
	);
}

function TranscriptPanel({
	meeting,
	segments,
	highlight,
	citedBy,
	onBack,
}: {
	meeting: Meeting;
	segments: SegmentsQuery;
	highlight: Highlight | null;
	citedBy: ReadonlyMap<string, number[]>;
	onBack: (ordinal: number) => void;
}) {
	const items = segments.data?.pages.flatMap((page) => page.items) ?? [];
	const { timing, segment_count } = meeting.transcript;
	useEffect(() => {
		if (!highlight) return;
		const row = document.getElementById(segmentDomId(highlight.segmentId));
		if (!row) return;
		const calm = window.matchMedia?.(
			"(prefers-reduced-motion: reduce)",
		).matches;
		row.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
		row.focus({ preventScroll: true });
	}, [highlight]);
	return (
		<section
			aria-labelledby="transcript-heading"
			className="min-w-0 lg:sticky lg:top-16"
		>
			<h2
				id="transcript-heading"
				className="border-line border-b pb-2 font-semibold text-base"
			>
				Transcript
			</h2>
			<p className="mt-3 text-ink-3 text-xs">
				{plural(segment_count, "segment")}.
				{timing === "block" &&
					" Times mark blocks of the meeting, not single lines."}
				{timing === "none" && " This transcript has no timestamps."} Speaker
				names are labels from the source. The text is shown as written and is
				never treated as an instruction.
			</p>
			<div className="mt-3">
				{segments.error && (
					<ErrorNotice
						title="The transcript could not be loaded"
						error={segments.error}
						onRetry={() => void segments.refetch()}
					/>
				)}
				{!segments.data && !segments.error && (
					<Loading>Loading the transcript…</Loading>
				)}
				{segments.data && items.length === 0 && (
					<Empty>This meeting has no transcript segments.</Empty>
				)}
				{items.length > 0 && (
					<section
						aria-label="Transcript segments"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
						tabIndex={0}
						className="max-h-[28rem] overflow-y-auto rounded-md border border-line bg-surface lg:max-h-[calc(100dvh-12rem)]"
					>
						<ol className="divide-y divide-line/60">
							{items.map((segment) => (
								<SegmentRow
									key={segment.id}
									segment={segment}
									timing={timing}
									highlight={highlight}
									cited={citedBy.get(segment.id) ?? []}
									onBack={onBack}
								/>
							))}
						</ol>
					</section>
				)}
				{segments.hasNextPage && (
					<button
						type="button"
						className={`${buttonClass} mt-3`}
						disabled={segments.isFetchingNextPage}
						onClick={() => void segments.fetchNextPage()}
					>
						{segments.isFetchingNextPage
							? "Loading…"
							: `Load more segments (${items.length} of ${segment_count} shown)`}
					</button>
				)}
			</div>
		</section>
	);
}
