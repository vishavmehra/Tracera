import { useQuery } from "@tanstack/react-query";
import type {
	Meeting,
	MeetingCandidateCounts,
	MeetingExtractionInfo,
	MeetingProvider,
} from "@tracera/contracts";
import { useRef } from "react";
import { listRepositories } from "./api.ts";
import { InferenceLabel, Status, type Tone } from "./ui.tsx";

// Pieces shared by the meetings list and the meeting page. Every word of status comes from a stored
// value; nothing here decides anything.

export const PROVIDER_LABELS: Record<MeetingProvider, string> = {
	google_meet: "Google Meet",
	teams: "Microsoft Teams",
	other: "Other tool",
};

const STATUS_WORDS: Record<Meeting["status"], { tone: Tone; words: string }> = {
	transcribed: { tone: "progress", words: "Waiting for extraction" },
	processing: { tone: "progress", words: "Extraction running" },
	extracted: { tone: "warn", words: "Candidates await review" },
	reviewed: { tone: "done", words: "No candidate awaits review" },
	failed: { tone: "bad", words: "Extraction failed" },
};

/** The stored meeting status as a shape and words; the raw value is in the tooltip. */
export function MeetingStatusBadge({ status }: { status: Meeting["status"] }) {
	const { tone, words } = STATUS_WORDS[status];
	return (
		<Status tone={tone} title={status}>
			{words}
		</Status>
	);
}

/** Extraction has not produced its result yet; the pages poll while this holds. */
export const isExtracting = (status: Meeting["status"]) =>
	status === "transcribed" || status === "processing";

export const meetingTitle = (
	meeting: Pick<Meeting, "title" | "source" | "provider" | "transcript">,
) =>
	meeting.title ??
	meeting.transcript.filename ??
	(meeting.source === "provider_api"
		? `${PROVIDER_LABELS[meeting.provider]} transcript`
		: "Untitled meeting");

export const sourceLabel = (meeting: Pick<Meeting, "source" | "provider">) =>
	meeting.source === "provider_api"
		? `Imported from ${PROVIDER_LABELS[meeting.provider]}`
		: `Uploaded transcript (${PROVIDER_LABELS[meeting.provider]})`;

export const plural = (count: number, one: string, many = `${one}s`) =>
	`${count} ${count === 1 ? one : many}`;

/** What is waiting on a person and what was decided, as plain phrases for the non-zero counts. */
export function countPhrases(counts: MeetingCandidateCounts): string[] {
	const phrases = [
		counts.bugs_pending > 0 &&
			`${plural(counts.bugs_pending, "bug candidate")} to review`,
		counts.other_discussion > 0 &&
			`${plural(counts.other_discussion, "other topic")} to review`,
		counts.bugs_confirmed > 0 && `${counts.bugs_confirmed} confirmed`,
		counts.dismissed > 0 && `${counts.dismissed} dismissed`,
		counts.rejected > 0 && `${counts.rejected} rejected by the citation check`,
		counts.possible_duplicates > 0 &&
			plural(counts.possible_duplicates, "possible duplicate"),
	];
	return phrases.filter((phrase): phrase is string => phrase !== false);
}

/** m:ss, or h:mm:ss from one hour on. */
export function clock(ms: number): string {
	const total = Math.floor(ms / 1000);
	const hours = Math.floor(total / 3600);
	const pad = (value: number) => String(value).padStart(2, "0");
	const minutes = Math.floor((total % 3600) / 60);
	return hours > 0
		? `${hours}:${pad(minutes)}:${pad(total % 60)}`
		: `${minutes}:${pad(total % 60)}`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
	return bytes < 1024 * 1024
		? `${trim(bytes / 1024)} KB`
		: `${trim(bytes / 1024 / 1024)} MB`;
}

/**
 * One Idempotency-Key per distinct request, kept until the request changes: a retry after a lost
 * response replays the stored answer instead of creating a second meeting.
 */
export function useRequestKey() {
	const last = useRef<{ signature: string; key: string } | null>(null);
	return (signature: string) => {
		if (last.current?.signature !== signature)
			last.current = { signature, key: crypto.randomUUID() };
		return last.current.key;
	};
}

/** The workspace's repositories, for the optional default repository of a meeting or a bug report. */
export const useRepositories = () =>
	useQuery({ queryKey: ["repositories"], queryFn: listRepositories });

export function RepositoryOptions({
	items,
	none,
}: {
	items: ReadonlyArray<{ id: string; name: string }> | undefined;
	none?: string;
}) {
	return (
		<>
			{none !== undefined && <option value="">{none}</option>}
			{items?.map((repository) => (
				<option key={repository.id} value={repository.id}>
					{repository.name}
				</option>
			))}
		</>
	);
}

/**
 * Whether a model produced the candidates: [mock] when the mock adapter ran, [live] otherwise.
 * Nothing is shown when no model was called, so a skipped extraction is never labelled live.
 */
export function ExtractionTag({
	extraction,
	detail = false,
}: {
	extraction: MeetingExtractionInfo | null;
	detail?: boolean;
}) {
	if (!extraction || extraction.selection === "none") return null;
	return (
		<InferenceLabel
			mock={extraction.mock}
			detail={
				detail ? `${extraction.provider} · ${extraction.model}` : undefined
			}
		/>
	);
}
