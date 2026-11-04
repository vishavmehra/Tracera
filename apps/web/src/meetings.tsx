import {
	keepPreviousData,
	type UseQueryResult,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	type Integration,
	MEETING_CONSENT_STATEMENT,
	type Meeting,
	type MeetingProvider,
	type ProviderMeeting,
	TRANSCRIPT_EXTENSIONS,
	TRANSCRIPT_MAX_BYTES,
} from "@tracera/contracts";
import { type FormEvent, type RefObject, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
	ApiError,
	disconnectIntegration,
	GOOGLE_CONNECT_PATH,
	importProviderMeeting,
	listIntegrations,
	listMeetings,
	listProviderMeetings,
	uploadMeetingTranscript,
} from "./api.ts";
import { POLL_MS } from "./hooks.ts";
import {
	clock,
	countPhrases,
	ExtractionTag,
	formatBytes,
	isExtracting,
	MeetingStatusBadge,
	meetingTitle,
	PROVIDER_LABELS,
	plural,
	RepositoryOptions,
	sourceLabel,
	useRepositories,
	useRequestKey,
} from "./meeting-parts.tsx";
import { callbackOutcome, importBody, uploadBody } from "./meeting-wire.ts";
import {
	Badge,
	buttonClass,
	Empty,
	ErrorNotice,
	Glyph,
	hintClass,
	inputClass,
	Loading,
	labelClass,
	linkClass,
	panelClass,
	primaryButtonClass,
	QueryView,
	quietButtonClass,
	Section,
	Status,
	Time,
} from "./ui.tsx";

const RECEIVES =
	"Tracera receives the transcript text of meetings you can access: no video, audio, or screen shares. A transcript exists only if the meeting host's Google Workspace plan supports transcripts and the host turned them on.";

// ---- The result of the Google sign-in -----------------------------------------------------------

const BANNER_TONES = {
	done: "border-line-strong bg-surface",
	warn: "border-warning bg-warning/[0.07]",
	bad: "border-error bg-error/[0.07]",
} as const;

/** The page the Google callback returns to: `?integration=google&result=<code>`. */
function CallbackBanner() {
	const [params, setParams] = useSearchParams();
	const result = params.get("result");
	if (params.get("integration") !== "google" || !result) return null;
	// The value comes from the address bar: it only selects a message and is never shown.
	const outcome = callbackOutcome(result);
	return (
		<div
			role={outcome.tone === "bad" ? "alert" : "status"}
			className={`mt-6 flex items-start justify-between gap-4 border-l-2 py-2.5 pr-2 pl-3.5 text-sm ${BANNER_TONES[outcome.tone]}`}
		>
			<div className="min-w-0">
				<p className="flex items-center gap-2 font-medium">
					<Glyph tone={outcome.tone} />
					{outcome.title}
				</p>
				<p className="mt-0.5 text-ink-2">{outcome.detail}</p>
			</div>
			<button
				type="button"
				className={quietButtonClass}
				onClick={() => setParams({}, { replace: true })}
			>
				Dismiss<span className="sr-only"> this message</span>
			</button>
		</div>
	);
}

// ---- The Google Meet connection -----------------------------------------------------------------

type Connection = NonNullable<Integration["connection"]>;

function GoogleMeetPanel({
	integrations,
}: {
	integrations: UseQueryResult<Integration[]>;
}) {
	return (
		<section aria-labelledby="google-heading" className={panelClass}>
			<h2 id="google-heading" className="font-semibold text-base">
				Google Meet
			</h2>
			<p className="mt-1.5 text-ink-2">{RECEIVES}</p>
			<div className="mt-4">
				<QueryView query={integrations} what="Integrations">
					{(items) => {
						const google = items.find((item) => item.provider === "google");
						return google ? (
							<GoogleState integration={google} />
						) : (
							<Empty>The server did not list a Google integration.</Empty>
						);
					}}
				</QueryView>
			</div>
		</section>
	);
}

function GoogleState({ integration }: { integration: Integration }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const disconnect = useMutation({
		mutationFn: (id: string) => disconnectIntegration(id),
		onSuccess: async () => {
			setConfirming(false);
			queryClient.removeQueries({ queryKey: ["provider-meetings"] });
			await queryClient.invalidateQueries({ queryKey: ["integrations"] });
		},
	});
	const { connection, availability, missing } = integration;
	const available = availability === "available";
	return (
		<div className="space-y-4 text-sm">
			{availability === "not_implemented" && (
				<Status tone="neutral" size="sm">
					Not available yet
				</Status>
			)}
			{availability === "not_configured" && (
				<div>
					<Status tone="neutral" size="sm">
						Not configured on this server
					</Status>
					{missing.length > 0 ? (
						<>
							<p className="mt-2 text-ink-2">
								The server is missing these environment variables:
							</p>
							<ul className="mt-1.5 flex flex-wrap gap-2">
								{missing.map((name) => (
									<li key={name}>
										<code className="rounded-sm bg-elevated px-1.5 py-0.5 text-xs">
											{name}
										</code>
									</li>
								))}
							</ul>
						</>
					) : (
						<p className="mt-2 text-ink-2">
							The server did not say which settings are missing.
						</p>
					)}
					<p className="mt-2 text-ink-3 text-xs">
						Set them on the server to turn the connection on. Uploading a
						transcript works without it.
					</p>
				</div>
			)}
			{available && !connection && (
				<div>
					<Status tone="neutral" size="sm">
						Not connected
					</Status>
					<p className="mt-2 text-ink-2">
						Connecting sends you to Google to grant read access to your meeting
						transcripts. You can disconnect at any time.
					</p>
					<a
						href={GOOGLE_CONNECT_PATH}
						className={`${primaryButtonClass} mt-3`}
					>
						Connect Google Meet
					</a>
				</div>
			)}
			{connection && (
				<ConnectionDetails
					connection={connection}
					reconnect={available}
					confirming={confirming}
					trigger={trigger}
					onAsk={() => setConfirming(true)}
					onCancel={() => {
						setConfirming(false);
						trigger.current?.focus();
					}}
					onConfirm={() => disconnect.mutate(connection.id)}
					pending={disconnect.isPending}
				/>
			)}
			{disconnect.error && (
				<ErrorNotice
					alert
					title="Google Meet could not be disconnected"
					error={disconnect.error}
				/>
			)}
		</div>
	);
}

function ConnectionDetails({
	connection,
	reconnect,
	confirming,
	trigger,
	onAsk,
	onCancel,
	onConfirm,
	pending,
}: {
	connection: Connection;
	reconnect: boolean;
	confirming: boolean;
	trigger: RefObject<HTMLButtonElement | null>;
	onAsk: () => void;
	onCancel: () => void;
	onConfirm: () => void;
	pending: boolean;
}) {
	const attention = connection.status !== "active";
	return (
		<div>
			<Status
				tone={attention ? "warn" : "done"}
				size="sm"
				title={connection.status}
			>
				{attention ? `Needs reconnecting (${connection.status})` : "Connected"}
			</Status>
			<p className="mt-2 text-ink-3 text-xs">
				Connected <Time iso={connection.connected_at} />
				{connection.scopes.length > 0 && (
					<>
						. Access granted:{" "}
						{connection.scopes.map((scope) => (
							<code key={scope} title={scope} className="mr-2">
								{scope.split("/").at(-1)}
							</code>
						))}
					</>
				)}
			</p>
			{connection.last_error && (
				<p className="mt-2 break-words text-error">
					<code>{connection.last_error.code}</code>:{" "}
					{connection.last_error.message}
				</p>
			)}
			<div className="mt-3 flex flex-wrap gap-2">
				{attention && reconnect && (
					<a href={GOOGLE_CONNECT_PATH} className={primaryButtonClass}>
						Reconnect Google Meet
					</a>
				)}
				<button
					ref={trigger}
					type="button"
					className={buttonClass}
					aria-expanded={confirming}
					onClick={onAsk}
				>
					Disconnect
				</button>
			</div>
			{confirming && (
				<div className="mt-3 space-y-2 border-line-strong border-l-2 pl-3">
					<p className="text-ink-2">
						Tracera deletes its stored tokens and asks Google to revoke access.
						It cannot confirm that Google processed the revocation. Meetings you
						already imported stay.
					</p>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							className={buttonClass}
							disabled={pending}
							onClick={onConfirm}
						>
							{pending ? "Disconnecting…" : "Disconnect and delete tokens"}
						</button>
						<button
							type="button"
							className={quietButtonClass}
							onClick={onCancel}
						>
							Keep connected
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

// ---- Import from Google Meet --------------------------------------------------------------------

const dateTime = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});

function ConsentCheckbox({
	checked,
	onChange,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="flex items-start gap-2.5 text-ink-2 text-sm">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				className="mt-0.5 size-4 shrink-0 accent-link"
			/>
			<span>{MEETING_CONSENT_STATEMENT.text}</span>
		</label>
	);
}

function ImportSection({
	connection,
	imported,
}: {
	connection: Connection;
	imported: ReadonlyMap<string, string>;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const repositories = useRepositories();
	const [shown, setShown] = useState(false);
	const [consent, setConsent] = useState(false);
	const [repositoryId, setRepositoryId] = useState("");
	const keyFor = useRequestKey();
	const conferences = useQuery({
		queryKey: ["provider-meetings", connection.id],
		queryFn: () => listProviderMeetings(connection.id),
		enabled: shown,
		staleTime: 60_000,
	});
	const importMeeting = useMutation({
		mutationFn: (pick: { ref: string; title: string | undefined }) =>
			importProviderMeeting(
				connection.id,
				importBody({ ref: pick.ref, title: pick.title, repositoryId }),
				keyFor(`${connection.id}:${pick.ref}:${repositoryId}`),
			),
		onSuccess: async ({ meeting }) => {
			await queryClient.invalidateQueries({ queryKey: ["meetings"] });
			navigate(`/meetings/${meeting.id}`);
		},
	});
	const existing =
		importMeeting.error instanceof ApiError &&
		importMeeting.error.code === "conflict" &&
		typeof importMeeting.error.extra.meeting_id === "string"
			? importMeeting.error.extra.meeting_id
			: null;
	const rows = (conferences.data ?? []).flatMap((conference) =>
		conference.transcripts.map((transcript) => ({ conference, transcript })),
	);
	return (
		<Section
			title="Import from Google Meet"
			id="import-heading"
			actions={
				shown && (
					<button
						type="button"
						className={quietButtonClass}
						disabled={conferences.isFetching}
						onClick={() => void conferences.refetch()}
					>
						{conferences.isFetching ? "Loading…" : "Refresh"}
					</button>
				)
			}
		>
			<p className="max-w-2xl text-ink-2 text-sm">
				Lists recent conferences from your Google account and the transcripts
				Google has for them. Nothing is imported until you choose one and
				confirm the statement below.
			</p>
			<div className="mt-4 max-w-2xl space-y-4">
				<div>
					<label htmlFor="import-repository" className={labelClass}>
						Default repository (optional)
					</label>
					<select
						id="import-repository"
						value={repositoryId}
						onChange={(event) => setRepositoryId(event.target.value)}
						className={inputClass}
					>
						<RepositoryOptions
							items={repositories.data?.items}
							none="No default repository"
						/>
					</select>
				</div>
				<ConsentCheckbox checked={consent} onChange={setConsent} />
			</div>
			{!shown && (
				<button
					type="button"
					className={`${buttonClass} mt-4`}
					onClick={() => setShown(true)}
				>
					Show recent meetings
				</button>
			)}
			<div className="mt-5">
				{conferences.error && (
					<ErrorNotice
						title="Your Google Meet meetings could not be listed"
						error={conferences.error}
						onRetry={() => void conferences.refetch()}
					/>
				)}
				{shown && !conferences.data && !conferences.error && (
					<Loading>Asking Google for recent meetings…</Loading>
				)}
				{conferences.data && rows.length === 0 && (
					<Empty>
						{conferences.data.length === 0
							? "Google returned no recent conferences for this account."
							: "Google listed no transcripts for these conferences. A transcript exists only if the host's plan supports transcripts and the host turned them on."}
					</Empty>
				)}
				{importMeeting.error && (
					<div className="mb-4 space-y-2">
						<ErrorNotice
							alert
							title="The transcript could not be imported"
							error={importMeeting.error}
						/>
						{existing && (
							<Link to={`/meetings/${existing}`} className={linkClass}>
								Open the meeting that was imported before
							</Link>
						)}
					</div>
				)}
				{rows.length > 0 && (
					<ul className="divide-y divide-line">
						{rows.map(({ conference, transcript }) => (
							<ProviderRow
								key={transcript.provider_meeting_ref}
								conference={conference}
								transcript={transcript}
								importedAs={imported.get(transcript.provider_meeting_ref)}
								ready={consent}
								pending={
									importMeeting.isPending &&
									importMeeting.variables?.ref ===
										transcript.provider_meeting_ref
								}
								busy={importMeeting.isPending}
								onImport={() =>
									importMeeting.mutate({
										ref: transcript.provider_meeting_ref,
										title: conference.started_at
											? `Google Meet, ${dateTime(conference.started_at)}`
											: undefined,
									})
								}
							/>
						))}
					</ul>
				)}
			</div>
		</Section>
	);
}

function ProviderRow({
	conference,
	transcript,
	importedAs,
	ready,
	pending,
	busy,
	onImport,
}: {
	conference: ProviderMeeting;
	transcript: ProviderMeeting["transcripts"][number];
	importedAs: string | undefined;
	ready: boolean;
	pending: boolean;
	busy: boolean;
	onImport: () => void;
}) {
	return (
		<li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
			<div className="min-w-0 text-sm">
				<p className="font-medium">
					{conference.started_at ? (
						<>
							Meeting on <Time iso={conference.started_at} />
						</>
					) : (
						"Meeting (start time not reported)"
					)}
				</p>
				<p className="mt-0.5 break-words text-ink-3 text-xs">
					Transcript state <code>{transcript.state}</code>
					{conference.expires_at && (
						<>
							{" · "}Google keeps it until <Time iso={conference.expires_at} />
						</>
					)}
					{" · "}
					<code className="break-all">{transcript.provider_meeting_ref}</code>
				</p>
			</div>
			{importedAs ? (
				<Link to={`/meetings/${importedAs}`} className={`${linkClass} text-sm`}>
					Open imported meeting
				</Link>
			) : transcript.importable ? (
				<button
					type="button"
					className={buttonClass}
					disabled={!ready || busy}
					onClick={onImport}
					title={ready ? undefined : "Confirm the statement above first"}
				>
					{pending ? "Importing…" : "Import"}
				</button>
			) : (
				<span className="text-ink-3 text-xs">
					Not importable yet: entries can be imported once the transcript has
					ended
				</span>
			)}
		</li>
	);
}

// ---- Upload a transcript ------------------------------------------------------------------------

/** The server decodes and checks the bytes; this only spares a round trip for the obvious mistakes. */
function checkFile(file: File | null): string | null {
	if (!file) return "Choose a transcript file.";
	const dot = file.name.lastIndexOf(".");
	const extension = dot < 0 ? "" : file.name.slice(dot).toLowerCase();
	if (!(TRANSCRIPT_EXTENSIONS as readonly string[]).includes(extension))
		return `Use a ${TRANSCRIPT_EXTENSIONS.join(", ")} file.`;
	if (file.size === 0) return "This file is empty.";
	if (file.size > TRANSCRIPT_MAX_BYTES)
		return `This file is ${formatBytes(file.size)}; the limit is ${formatBytes(TRANSCRIPT_MAX_BYTES)}.`;
	return null;
}

const toBase64 = (file: File) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			resolve(url.slice(url.indexOf(",") + 1));
		};
		reader.onerror = () =>
			reject(reader.error ?? new Error("The file could not be read."));
		reader.readAsDataURL(file);
	});

type Draft = {
	file: File;
	title: string;
	provider: MeetingProvider;
	repositoryId: string;
};

const providerOf = (value: FormDataEntryValue | null): MeetingProvider =>
	value === "google_meet" || value === "teams" ? value : "other";

function UploadPanel() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const repositories = useRepositories();
	const [file, setFile] = useState<File | null>(null);
	const [consent, setConsent] = useState(false);
	const [issue, setIssue] = useState<string | null>(null);
	const keyFor = useRequestKey();
	const upload = useMutation({
		mutationFn: async (draft: Draft) => {
			const body = uploadBody({
				filename: draft.file.name,
				browserType: draft.file.type,
				dataBase64: await toBase64(draft.file),
				title: draft.title,
				provider: draft.provider,
				repositoryId: draft.repositoryId,
			});
			return uploadMeetingTranscript(
				body,
				keyFor(
					JSON.stringify([
						draft.file.name,
						draft.file.size,
						draft.file.lastModified,
						draft.title,
						draft.provider,
						draft.repositoryId,
					]),
				),
			);
		},
		onSuccess: async ({ meeting }) => {
			await queryClient.invalidateQueries({ queryKey: ["meetings"] });
			navigate(`/meetings/${meeting.id}`);
		},
	});
	const onSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const problem =
			checkFile(file) ??
			(consent
				? null
				: "Confirm that you are authorized to share this transcript.");
		setIssue(problem);
		if (problem || !file) return;
		const form = new FormData(event.currentTarget);
		upload.mutate({
			file,
			title: String(form.get("title") ?? "").trim(),
			provider: providerOf(form.get("provider")),
			repositoryId: String(form.get("repository_id") ?? ""),
		});
	};
	return (
		<section aria-labelledby="upload-heading" className={panelClass}>
			<h2 id="upload-heading" className="font-semibold text-base">
				Upload a transcript
			</h2>
			<p className="mt-1.5 text-ink-2">
				A WebVTT, SubRip, or text file: a Google Meet or Teams export, or lines
				that start with a speaker name and a colon. Up to{" "}
				{formatBytes(TRANSCRIPT_MAX_BYTES)}.
			</p>
			<form onSubmit={onSubmit} noValidate className="mt-4 space-y-4">
				<div>
					<label htmlFor="transcript-file" className={labelClass}>
						Transcript file
					</label>
					<input
						id="transcript-file"
						type="file"
						required
						accept={TRANSCRIPT_EXTENSIONS.join(",")}
						onChange={(event) => {
							setFile(event.target.files?.[0] ?? null);
							setIssue(null);
						}}
						className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-elevated file:px-3 file:py-1 file:text-ink`}
					/>
					{file && (
						<p className={hintClass}>
							{file.name}, {formatBytes(file.size)}
						</p>
					)}
				</div>
				<div>
					<label htmlFor="upload-title" className={labelClass}>
						Title (optional)
					</label>
					<input
						id="upload-title"
						name="title"
						maxLength={200}
						className={inputClass}
					/>
					<p className={hintClass}>Without a title, the file name is used.</p>
				</div>
				<div className="grid gap-4 sm:grid-cols-2">
					<div>
						<label htmlFor="upload-provider" className={labelClass}>
							Meeting tool
						</label>
						<select
							id="upload-provider"
							name="provider"
							defaultValue="other"
							className={inputClass}
						>
							{(Object.keys(PROVIDER_LABELS) as MeetingProvider[]).map(
								(provider) => (
									<option key={provider} value={provider}>
										{PROVIDER_LABELS[provider]}
									</option>
								),
							)}
						</select>
					</div>
					<div>
						<label htmlFor="upload-repository" className={labelClass}>
							Default repository (optional)
						</label>
						<select
							id="upload-repository"
							name="repository_id"
							defaultValue=""
							className={inputClass}
						>
							<RepositoryOptions
								items={repositories.data?.items}
								none="No default repository"
							/>
						</select>
					</div>
				</div>
				<ConsentCheckbox checked={consent} onChange={setConsent} />
				{issue && (
					<p role="alert" className="text-error text-sm">
						{issue}
					</p>
				)}
				{upload.error && (
					<ErrorNotice
						alert
						title="The transcript could not be uploaded"
						error={upload.error}
					/>
				)}
				<button
					type="submit"
					className={primaryButtonClass}
					disabled={upload.isPending}
				>
					{upload.isPending ? "Uploading…" : "Upload transcript"}
				</button>
			</form>
		</section>
	);
}

// ---- The list -----------------------------------------------------------------------------------

function MeetingRow({ meeting }: { meeting: Meeting }) {
	const phrases = countPhrases(meeting.candidate_counts);
	const { transcript } = meeting;
	return (
		<li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
			<div className="min-w-0">
				<Link
					to={`/meetings/${meeting.id}`}
					className="break-words font-medium text-ink hover:underline"
				>
					{meetingTitle(meeting)}
				</Link>
				<p className="mt-0.5 text-ink-3 text-xs">
					{sourceLabel(meeting)}
					{" · "}
					{meeting.occurred_at ? "Held " : "Added "}
					<Time iso={meeting.occurred_at ?? meeting.created_at} />
					{" · "}
					{plural(transcript.segment_count, "segment")}
					{transcript.duration_ms !== null &&
						`, ${clock(transcript.duration_ms)} long`}
				</p>
				<p className="mt-1 text-ink-2 text-xs">
					{phrases.length > 0
						? phrases.join(" · ")
						: isExtracting(meeting.status)
							? "Candidates appear here when extraction finishes."
							: "No candidates."}
				</p>
				{meeting.flags.length > 0 && (
					<p className="mt-1.5 flex flex-wrap gap-1.5">
						{meeting.flags.map((flag) => (
							<Badge key={flag} tone="warn">
								{flag === "injection_suspected"
									? "Contains instruction-like text"
									: flag.replaceAll("_", " ")}
							</Badge>
						))}
					</p>
				)}
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
				<ExtractionTag extraction={meeting.extraction} />
				<MeetingStatusBadge status={meeting.status} />
			</div>
		</li>
	);
}

const MAX_LIST = 100;

export function MeetingsPage() {
	const [limit, setLimit] = useState(25);
	const integrations = useQuery({
		queryKey: ["integrations"],
		queryFn: listIntegrations,
	});
	const meetings = useQuery({
		queryKey: ["meetings", limit],
		queryFn: () => listMeetings(limit),
		placeholderData: keepPreviousData,
		refetchInterval: (query) =>
			query.state.data?.items.some((meeting) => isExtracting(meeting.status))
				? POLL_MS
				: false,
	});
	const connection = integrations.data?.find(
		(item) => item.provider === "google",
	)?.connection;
	const imported = new Map(
		(meetings.data?.items ?? []).flatMap((meeting) =>
			meeting.provider_ref ? [[meeting.provider_ref, meeting.id] as const] : [],
		),
	);
	const working = meetings.data?.items.some((meeting) =>
		isExtracting(meeting.status),
	);
	return (
		<>
			<title>Meetings · Tracera</title>
			<h1 className="font-semibold text-2xl tracking-tight">Meetings</h1>
			<p className="mt-1.5 max-w-2xl text-ink-2 text-sm">
				Turn what was said in a meeting into bug candidates that cite the
				transcript. Nothing becomes a bug report until you review and confirm
				it.
			</p>
			<CallbackBanner />
			<div className="mt-8 grid items-start gap-6 lg:grid-cols-2">
				<GoogleMeetPanel integrations={integrations} />
				<UploadPanel />
			</div>
			{connection?.status === "active" && (
				<ImportSection connection={connection} imported={imported} />
			)}
			<Section
				title="Your meetings"
				id="meetings-heading"
				actions={working && <span>Updating while extraction runs</span>}
			>
				<QueryView query={meetings} what="Meetings">
					{(data) =>
						data.items.length === 0 ? (
							<Empty>
								No meetings yet.{" "}
								<button
									type="button"
									className={linkClass}
									onClick={() =>
										document.getElementById("transcript-file")?.focus()
									}
								>
									Upload a transcript
								</button>
								{connection?.status === "active"
									? " or import one from Google Meet."
									: " to get started."}
							</Empty>
						) : (
							<>
								<ul className="divide-y divide-line">
									{data.items.map((meeting) => (
										<MeetingRow key={meeting.id} meeting={meeting} />
									))}
								</ul>
								{data.next_cursor !== null &&
									(limit < MAX_LIST ? (
										<button
											type="button"
											className={`${buttonClass} mt-4`}
											onClick={() =>
												setLimit((value) => Math.min(value + 25, MAX_LIST))
											}
										>
											Show more meetings
										</button>
									) : (
										<p className="mt-4 text-ink-3 text-xs">
											Showing the newest {limit} meetings.
										</p>
									))}
							</>
						)
					}
				</QueryView>
			</Section>
		</>
	);
}
