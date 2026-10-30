import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	DEFAULT_MAX_IMAGE_BYTES,
	type EvidenceObservation,
	type ScreenshotObservationOutput,
	VISION_IMAGE_MIME_TYPES,
} from "@tracera/contracts";
import { type ReactNode, useState } from "react";
import {
	ApiError,
	evidenceContentUrl,
	getBugReportScreenshots,
	getEvidenceObservations,
	requestEvidenceObservation,
} from "./api.ts";
import { POLL_MS } from "./hooks.ts";
import {
	Badge,
	buttonClass,
	Chevron,
	Empty,
	ErrorNotice,
	Glyph,
	hintClass,
	InferenceLabel,
	inputClass,
	Loading,
	Section,
	Status,
	Time,
	type Tone,
} from "./ui.tsx";
import { LocatePanel, RegionOverlay, useLocator } from "./visual-locate.tsx";

// Screenshots keep four kinds of claim apart: what is visible, what a model infers, what the repository
// confirms, and what execution verified. This file shows the first two and what could not be told; the
// other two come from the investigation's own findings.

const observationsKey = (evidenceId: string) => [
	"evidence",
	evidenceId,
	"observations",
];

const formatBytes = (bytes: number) =>
	bytes < 1024 * 1024
		? `${Math.max(1, Math.round(bytes / 1024))} KB`
		: `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// ---- Attaching a screenshot ---------------------------------------------------------------------

export const SCREENSHOT_ACCEPT = VISION_IMAGE_MIME_TYPES.join(",");

/** Why a file cannot be attached as a screenshot, or null. The server checks the bytes again. */
export function validateScreenshot(
	file: Pick<File, "type" | "size">,
	maxBytes = DEFAULT_MAX_IMAGE_BYTES,
): string | null {
	if (!(VISION_IMAGE_MIME_TYPES as readonly string[]).includes(file.type))
		return "Use a PNG, JPEG, or WebP image.";
	if (file.size === 0) return "The file is empty.";
	if (file.size > maxBytes)
		return `The image is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`;
	return null;
}

/** A file input for the new-investigation form; read it with `new FormData(form).get(name)`. */
export function ScreenshotField({
	name = "screenshot",
	maxBytes = DEFAULT_MAX_IMAGE_BYTES,
}: {
	name?: string;
	maxBytes?: number;
}) {
	const [problem, setProblem] = useState<string | null>(null);
	return (
		<div>
			<label htmlFor={name} className="font-medium text-ink text-sm">
				Screenshot (optional)
			</label>
			<input
				id={name}
				name={name}
				type="file"
				accept={SCREENSHOT_ACCEPT}
				aria-describedby={`${name}-hint`}
				onChange={(event) => {
					const file = event.currentTarget.files?.[0];
					const reason = file ? validateScreenshot(file, maxBytes) : null;
					setProblem(reason);
					// A rejected file must not be submitted by accident.
					if (reason) event.currentTarget.value = "";
				}}
				className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-elevated file:px-3 file:py-1 file:text-ink-2 file:text-sm`}
			/>
			<p id={`${name}-hint`} className={hintClass}>
				PNG, JPEG, or WebP up to {formatBytes(maxBytes)}. A model reads it, so
				hide anything private first.
			</p>
			{problem && (
				<p role="alert" className="mt-1 text-error text-xs">
					{problem}
				</p>
			)}
		</div>
	);
}

/**
 * Uploads a screenshot to a bug report (`POST /api/v1/bug-reports/{id}/evidence`) and returns the new
 * evidence ID.
 */
export async function uploadScreenshot(
	bugReportId: string,
	file: File,
): Promise<string> {
	const form = new FormData();
	form.set("file", file);
	form.set("meta", JSON.stringify({ kind: "screenshot" }));
	let response: Response;
	try {
		response = await fetch(
			`/api/v1/bug-reports/${encodeURIComponent(bugReportId)}/evidence`,
			{
				method: "POST",
				headers: { accept: "application/json", "x-tracera-csrf": "1" },
				credentials: "same-origin",
				body: form,
			},
		);
	} catch {
		throw new ApiError(
			0,
			"network_error",
			"The Tracera API could not be reached.",
		);
	}
	const body = (await response.json().catch(() => undefined)) as
		| { evidence?: { id?: unknown }; code?: unknown; detail?: unknown }
		| undefined;
	if (!response.ok)
		throw new ApiError(
			response.status,
			typeof body?.code === "string" ? body.code : "unexpected_response",
			typeof body?.detail === "string"
				? body.detail
				: `The server answered HTTP ${response.status}.`,
		);
	if (typeof body?.evidence?.id !== "string")
		throw new ApiError(
			response.status,
			"invalid_response",
			"The upload response did not name the stored evidence.",
		);
	return body.evidence.id;
}

// ---- What a screenshot shows ----------------------------------------------------------------------

function Panel({
	tone,
	title,
	caption,
	children,
}: {
	tone: Tone;
	title: string;
	caption: string;
	children: ReactNode;
}) {
	return (
		<section className="min-w-0">
			<h3 className="flex items-center gap-2 font-semibold text-ink text-sm">
				<Glyph tone={tone} />
				{title}
			</h3>
			<p className="mt-0.5 text-ink-3 text-xs">{caption}</p>
			<div className="mt-3">{children}</div>
		</section>
	);
}

const subheading = "font-medium text-ink-2 text-xs";

function Located({ text, location }: { text: string; location: string }) {
	return (
		<li className="break-words">
			<q className="whitespace-pre-wrap">{text}</q>
			<span className="ml-2 inline-block text-ink-3 text-xs">{location}</span>
		</li>
	);
}

function Disclosure({
	title,
	count,
	open = false,
	children,
}: {
	title: string;
	count: number;
	open?: boolean;
	children: ReactNode;
}) {
	if (count === 0) return null;
	return (
		<details open={open} className="text-sm">
			<summary className="inline-flex cursor-pointer items-center gap-1.5 rounded text-ink-2 hover:text-ink">
				<Chevron />
				{title} ({count})
			</summary>
			<div className="mt-2">{children}</div>
		</details>
	);
}

/** The "Observed in screenshot" content: only what the model says is visible. */
export function ObservedInScreenshot({
	output,
}: {
	output: ScreenshotObservationOutput;
}) {
	return (
		<div className="space-y-4">
			<p className="max-w-[68ch] break-words text-[15px] leading-relaxed">
				{output.summary}
			</p>
			{output.observed_failure && (
				<div className="border-warning border-l-2 bg-warning/[0.06] py-2 pr-3 pl-3.5 text-sm">
					<p className="font-medium text-warning">Observed failure</p>
					<p className="mt-0.5 break-words">{output.observed_failure}</p>
				</div>
			)}
			{output.error_messages.length > 0 && (
				<div>
					<h4 className={subheading}>
						Error messages ({output.error_messages.length})
					</h4>
					<ul className="mt-1 space-y-1 text-sm">
						{output.error_messages.map((item) => (
							<Located
								key={`${item.location}:${item.text}`}
								text={item.text}
								location={item.location}
							/>
						))}
					</ul>
				</div>
			)}
			{output.observations.length > 0 && (
				<div>
					<h4 className={subheading}>What is visible</h4>
					<ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
						{output.observations.map((item) => (
							<li key={item.statement} className="break-words">
								{item.statement}
							</li>
						))}
					</ul>
				</div>
			)}
			<Disclosure
				title="Visible text"
				count={output.visible_text.length}
				open={output.visible_text.length <= 8}
			>
				<ul className="space-y-0.5 text-sm">
					{output.visible_text.map((item, index) => (
						<Located
							// The same text can appear twice on a screen; its position keeps the keys unique.
							// biome-ignore lint/suspicious/noArrayIndexKey: transcribed lines have no identity
							key={index}
							text={item.text}
							location={item.location}
						/>
					))}
				</ul>
			</Disclosure>
			<Disclosure title="Interface elements" count={output.ui_elements.length}>
				<ul className="space-y-0.5 text-sm">
					{output.ui_elements.map((item, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: listed elements have no identity
						<li key={index} className="break-words">
							<span className="text-ink-3">{item.kind}</span> {item.label}
							{item.state && (
								<span className="ml-1 text-ink-3 text-xs">[{item.state}]</span>
							)}
							<span className="ml-2 text-ink-3 text-xs">{item.location}</span>
						</li>
					))}
				</ul>
			</Disclosure>
		</div>
	);
}

function ReadingHeader({ reading }: { reading: EvidenceObservation }) {
	const p = reading.provenance;
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-3 text-xs">
			<InferenceLabel
				mock={p.mode === "mock"}
				detail={`${p.model} via ${p.provider}`}
			/>
			{p.placeholder_provider && (
				<Status
					tone="warn"
					title="The provider is not Meta's own API, so this reading says nothing about Meta's models"
				>
					Placeholder provider
				</Status>
			)}
			<span>
				Read <Time iso={reading.created_at} />
			</span>
			<span title={p.prompt_version}>{p.task}</span>
		</div>
	);
}

/** The three claim groups of one reading, kept in separate panels. */
export function ReadingPanels({ reading }: { reading: EvidenceObservation }) {
	const output = reading.output;
	if (!output) return null;
	return (
		<div className="space-y-6">
			<ReadingHeader reading={reading} />
			{reading.provenance.mode === "mock" && (
				<p className="text-sm text-warning">
					[mock] No model looked at this image; the fields below are
					placeholders.
				</p>
			)}
			<Panel
				tone="info"
				title="Observed in screenshot"
				caption="Read from the pixels by a model. It can contain reading errors and has not been checked against the repository."
			>
				<ObservedInScreenshot output={output} />
			</Panel>
			<Panel
				tone="uncertain"
				title="Model inferences"
				caption="Guesses. None of this is visible in the image and none of it is verified."
			>
				{output.inferences.length === 0 ? (
					<p className="text-ink-3 text-sm">The model made no inferences.</p>
				) : (
					<ul className="space-y-1.5 text-sm">
						{output.inferences.map((item) => (
							<li key={item.statement} className="flex items-start gap-2">
								<Badge tone="uncertain">{item.confidence} confidence</Badge>
								<span className="min-w-0 break-words">{item.statement}</span>
							</li>
						))}
					</ul>
				)}
			</Panel>
			<Panel
				tone="neutral"
				title="Missing information"
				caption="What the model could not tell from the image."
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
	);
}

type Screenshot = Awaited<ReturnType<typeof getBugReportScreenshots>>[number];

/** The kinds of interface element the reading names, as suggestions for what to locate. */
const kindsOf = (output: ScreenshotObservationOutput | null | undefined) =>
	[
		...new Set(
			(output?.ui_elements ?? [])
				.map((element) => element.kind.trim().toLowerCase())
				.filter((kind) => kind.length > 0 && kind.length <= 80),
		),
	].slice(0, 6);

function ScreenshotCard({
	item,
	number,
	version,
	active,
}: {
	item: Screenshot;
	number: number;
	version: number | undefined;
	active: boolean;
}) {
	const queryClient = useQueryClient();
	const locator = useLocator(item.id, version);
	const [requested, setRequested] = useState(false);
	const observations = useQuery({
		queryKey: [...observationsKey(item.id), version],
		queryFn: () => getEvidenceObservations(item.id),
		// The investigation's own stages read the screenshot, so poll while it runs or a read was asked for.
		refetchInterval: (query) =>
			(active || requested) &&
			!query.state.data?.observations.some((o) => o.status === "succeeded")
				? POLL_MS
				: false,
	});
	const read = useMutation({
		mutationFn: () => requestEvidenceObservation(item.id),
		onSuccess: () => {
			setRequested(true);
			void queryClient.invalidateQueries({
				queryKey: observationsKey(item.id),
			});
		},
	});
	const list = observations.data?.observations ?? [];
	const current = list.find((o) => o.status === "succeeded");
	const latest = list[0];
	const url = evidenceContentUrl(item.id);
	return (
		<article className="grid gap-x-8 gap-y-5 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
			<div className="min-w-0">
				<figure>
					<div className="relative inline-block max-w-full align-top">
						<a
							href={url}
							target="_blank"
							rel="noreferrer"
							title="Open the full image"
							className="block"
						>
							<img
								src={url}
								alt={`Screenshot ${number} attached to the bug report`}
								loading="lazy"
								className="block max-h-80 w-auto max-w-full rounded border border-line bg-surface object-contain"
							/>
						</a>
						<RegionOverlay locations={locator.drawn} />
					</div>
					<figcaption className="mt-1.5 text-ink-3 text-xs">
						Screenshot {number} · {item.mime_type} ·{" "}
						{formatBytes(item.size_bytes)} · attached{" "}
						<Time iso={item.created_at} />
					</figcaption>
				</figure>
				{locator.available && (
					<LocatePanel locator={locator} kinds={kindsOf(current?.output)} />
				)}
			</div>
			<div className="min-w-0 space-y-4">
				{observations.error ? (
					<ErrorNotice
						title="The screenshot reading could not be loaded"
						error={observations.error}
						onRetry={() => void observations.refetch()}
					/>
				) : observations.data === undefined ? (
					<Loading>Loading the screenshot reading…</Loading>
				) : current ? (
					<>
						<ReadingPanels reading={current} />
						{latest &&
							latest.id !== current.id &&
							latest.status === "failed" && (
								<p className="text-sm text-warning">
									A later attempt to read it failed
									{latest.error ? ` (${latest.error.code})` : ""}; the reading
									above is the last that succeeded.
								</p>
							)}
					</>
				) : latest?.status === "failed" ? (
					<div className="space-y-3">
						<div className="border-error border-l-2 bg-error/[0.07] py-2.5 pr-3 pl-3.5 text-sm">
							<p className="font-medium text-error">
								The screenshot could not be read
							</p>
							<p className="mt-0.5 break-words">
								<code>{latest.error?.code}</code>: {latest.error?.message}
							</p>
						</div>
						<ReadButton
							label="Try again"
							pending={read.isPending}
							onClick={() => read.mutate()}
						/>
					</div>
				) : active || requested ? (
					<Loading>Reading the screenshot…</Loading>
				) : (
					<div className="space-y-3">
						<Empty>This screenshot has not been read yet.</Empty>
						<ReadButton
							label="Read screenshot"
							pending={read.isPending}
							onClick={() => read.mutate()}
						/>
					</div>
				)}
				{read.error && (
					<ErrorNotice
						alert
						title="The read could not be requested"
						error={read.error}
					/>
				)}
			</div>
		</article>
	);
}

function ReadButton({
	label,
	pending,
	onClick,
}: {
	label: string;
	pending: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={buttonClass}
			disabled={pending}
			onClick={onClick}
		>
			{pending ? "Requesting…" : label}
		</button>
	);
}

/**
 * The investigation page's screenshot section: the image and, beside it, what a model read from it.
 * Renders nothing for a bug report without screenshots.
 */
export function ScreenshotEvidence({
	bugReportId,
	version,
	active = false,
}: {
	bugReportId: string;
	/** The investigation's state version; a new one refreshes the readings. */
	version?: number | undefined;
	/** True while the investigation is working, when its stages may read the screenshot. */
	active?: boolean;
}) {
	const screenshots = useQuery({
		queryKey: ["bug-reports", bugReportId, "screenshots", version],
		queryFn: () => getBugReportScreenshots(bugReportId),
	});
	const items = screenshots.data ?? [];
	if (items.length === 0) return null;
	return (
		<Section
			title={items.length === 1 ? "Screenshot" : "Screenshots"}
			id="screenshot-heading"
		>
			<div className="space-y-10">
				{items.map((item, index) => (
					<ScreenshotCard
						key={item.id}
						item={item}
						number={index + 1}
						version={version}
						active={active}
					/>
				))}
			</div>
		</Section>
	);
}
