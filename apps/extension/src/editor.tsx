import { SeveritySchema } from "@tracera/contracts";
import {
	type FormEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	StrictMode,
	useEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
	type ApiClient,
	ApiError,
	createApiClient,
	type InvestigationView,
	type Me,
} from "./api.ts";
import { chromeApi } from "./chrome.ts";
import {
	type Mark,
	type MarkKind,
	type Rgba,
	regionToImageRect,
	renderMarks,
	toPixelRect,
} from "./image.ts";
import { type Capture, CaptureResultSchema, sendCommand } from "./messages.ts";
import { loadState, type Settings } from "./settings.ts";
import {
	buildSubmission,
	type FieldError,
	NO_PROGRESS,
	type Progress,
	previewRequests,
	type ReportForm,
	SETTLED_STATUSES,
	type Step,
	type Submission,
	scrubSecrets,
	stripUrl,
	submit,
} from "./submission.ts";
import "./ui.css";

type Environment = {
	browser: string | null;
	os: string | null;
	user_agent: string | null;
};
type Loaded = {
	capture: Capture;
	settings: Settings;
	base: Rgba;
	client: ApiClient;
};

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);
const humanize = (value: string) =>
	value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The capture as editable pixels, cropped to the selected region when there is one. */
async function decode(capture: Capture): Promise<Rgba> {
	const image = new Image();
	image.src = capture.image;
	await image.decode();
	const full = { width: image.naturalWidth, height: image.naturalHeight };
	const area = (capture.region &&
		regionToImageRect(capture.region.rect, capture.region.viewport, full)) ?? {
		x: 0,
		y: 0,
		...full,
	};
	const canvas = new OffscreenCanvas(area.width, area.height);
	const context = canvas.getContext("2d");
	if (!context)
		throw new Error("This browser could not prepare the screenshot.");
	context.drawImage(
		image,
		area.x,
		area.y,
		area.width,
		area.height,
		0,
		0,
		area.width,
		area.height,
	);
	const data = context.getImageData(0, 0, area.width, area.height);
	return { width: data.width, height: data.height, data: data.data };
}

/** PNG bytes of exactly these pixels; this is the file that is uploaded. */
async function encodePng(image: Rgba): Promise<Uint8Array> {
	const canvas = new OffscreenCanvas(image.width, image.height);
	const context = canvas.getContext("2d");
	if (!context)
		throw new Error("This browser could not encode the screenshot.");
	context.putImageData(
		new ImageData(image.data, image.width, image.height),
		0,
		0,
	);
	const blob = await canvas.convertToBlob({ type: "image/png" });
	return new Uint8Array(await blob.arrayBuffer());
}

type UserAgentData = {
	brands?: { brand: string; version: string }[];
	platform?: string;
	getHighEntropyValues?(hints: string[]): Promise<{
		fullVersionList?: { brand: string; version: string }[];
		platformVersion?: string;
	}>;
};

async function readEnvironment(): Promise<Environment> {
	const data = (navigator as Navigator & { userAgentData?: UserAgentData })
		.userAgentData;
	const high = await data
		?.getHighEntropyValues?.(["fullVersionList", "platformVersion"])
		.catch(() => undefined);
	const brands = (high?.fullVersionList ?? data?.brands ?? []).filter(
		(entry) => !/not.?a.?brand/i.test(entry.brand),
	);
	const browser =
		brands.find((entry) => entry.brand !== "Chromium") ?? brands[0];
	return {
		browser: browser ? `${browser.brand} ${browser.version}` : null,
		os: data?.platform
			? `${data.platform}${high?.platformVersion ? ` ${high.platformVersion}` : ""}`
			: null,
		user_agent: navigator.userAgent,
	};
}

async function load(): Promise<Loaded> {
	const state = await loadState(chromeApi().storage.local);
	if (state.step !== "ready")
		throw new Error(
			"Finish the setup first: click the Tracera button in the toolbar.",
		);
	const id = location.hash.slice(1);
	if (!/^[0-9a-f]{32}$/.test(id))
		throw new Error(
			"There is no capture to edit. Use the Tracera button to capture a page.",
		);
	const result = await sendCommand(
		{ type: "tracera:take-capture", capture_id: id },
		CaptureResultSchema,
	);
	if (!result.ok) throw new Error(result.error);
	return {
		capture: result.capture,
		settings: state.settings,
		base: await decode(result.capture),
		client: createApiClient({
			apiUrl: state.settings.api_url,
			token: state.settings.token,
		}),
	};
}

function Field({
	label,
	error,
	children,
}: {
	label: string;
	error?: string;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: every caller passes the input, textarea, or select as children
		<label className="field">
			<span>{label}</span>
			{children}
			{error && <span className="field-error">{error}</span>}
		</label>
	);
}

function Screenshot({
	base,
	marks,
	tool,
	onMark,
}: {
	base: Rgba;
	marks: Mark[];
	tool: MarkKind;
	onMark: (mark: Mark) => void;
}) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const [drag, setDrag] = useState<{
		x0: number;
		y0: number;
		x1: number;
		y1: number;
	} | null>(null);

	// The visible canvas shows exactly the pixels that will be uploaded.
	useEffect(() => {
		const context = canvas.current?.getContext("2d");
		if (!context) return;
		const image = renderMarks(base, marks);
		context.putImageData(
			new ImageData(image.data, image.width, image.height),
			0,
			0,
		);
	}, [base, marks]);

	const point = (event: ReactPointerEvent) => {
		const box = canvas.current?.getBoundingClientRect();
		return box
			? { x: event.clientX - box.left, y: event.clientY - box.top }
			: { x: 0, y: 0 };
	};
	const end = (event: ReactPointerEvent) => {
		const box = canvas.current?.getBoundingClientRect();
		if (!drag || !box) return;
		setDrag(null);
		const { x, y } = point(event);
		const scale = base.width / box.width;
		const rect = toPixelRect(
			{
				x: drag.x0 * scale,
				y: drag.y0 * scale,
				width: (x - drag.x0) * scale,
				height: (y - drag.y0) * scale,
			},
			base.width,
			base.height,
		);
		if (rect && rect.width >= 3 && rect.height >= 3)
			onMark({ kind: tool, rect });
	};

	return (
		<div
			className="canvas-wrap"
			onPointerDown={(event) => {
				event.currentTarget.setPointerCapture(event.pointerId);
				const { x, y } = point(event);
				setDrag({ x0: x, y0: y, x1: x, y1: y });
			}}
			onPointerMove={(event) => {
				if (!drag) return;
				const { x, y } = point(event);
				setDrag({ ...drag, x1: x, y1: y });
			}}
			onPointerUp={end}
			onPointerCancel={() => setDrag(null)}
		>
			<canvas
				ref={canvas}
				width={base.width}
				height={base.height}
				aria-label={`Screenshot, ${base.width} by ${base.height} pixels. Drag on it to add the selected mark.`}
			/>
			{drag && (
				<div
					className={`drag-rect ${tool}`}
					style={{
						left: Math.min(drag.x0, drag.x1),
						top: Math.min(drag.y0, drag.y1),
						width: Math.abs(drag.x1 - drag.x0),
						height: Math.abs(drag.y1 - drag.y0),
					}}
				/>
			)}
		</div>
	);
}

const STATUS_TONE: Record<string, string> = {
	completed: "success",
	failed: "error",
	cancelled: "muted",
	needs_input: "warning",
	awaiting_approval: "warning",
};

function InvestigationCard({
	view,
	webUrl,
	pollError,
}: {
	view: InvestigationView;
	webUrl: string;
	pollError: string | null;
}) {
	const settled = SETTLED_STATUSES.has(view.status);
	return (
		<section className="card stack-tight" aria-live="polite">
			<div className="row spread">
				<h2>Investigation</h2>
				<span
					className={`status ${view.inference.mock ? "status-uncertain" : "status-muted"}`}
					title={`Inference provider: ${view.inference.provider}`}
				>
					{view.inference.mock ? "[mock]" : "[live]"}
				</span>
			</div>
			<p className="mono">{view.id}</p>
			<div className="row">
				<span className={`status status-${STATUS_TONE[view.status] ?? "info"}`}>
					{!settled && <span className="live-dot" aria-hidden="true" />}
					{humanize(view.status)}
				</span>
				{view.current_stage && (
					<span className="small secondary">
						Stage: {humanize(view.current_stage)}
					</span>
				)}
			</div>
			{view.progress?.message && (
				<p className="small secondary">{view.progress.message}</p>
			)}
			{view.mode === "analysis_only" && (
				<p className="small muted">
					Analysis only: no sandboxed reproduction or verification.
				</p>
			)}
			{view.latest_verification && (
				<p className="small">
					Verification outcome recorded by Tracera:{" "}
					<strong>{humanize(view.latest_verification.outcome)}</strong>
				</p>
			)}
			{view.failure && (
				<p className="alert alert-error small">{view.failure.message}</p>
			)}
			{pollError && <p className="alert alert-warning small">{pollError}</p>}
			<a
				className="btn btn-primary"
				href={`${webUrl}/investigations/${view.id}`}
				target="_blank"
				rel="noopener noreferrer"
			>
				Open in Tracera
			</a>
		</section>
	);
}

type Access =
	| { status: "loading" }
	| { status: "error"; message: string }
	| {
			status: "ready";
			me: Me;
			repositories: { id: string; name: string }[] | null;
			problem: string | null;
	  };

type Stage =
	| { kind: "edit" }
	| { kind: "preview"; submission: Submission; imageUrl: string }
	| {
			kind: "send";
			submission: Submission;
			imageUrl: string;
			progress: Progress;
			step: Step | null;
			error: ApiError | null;
	  };

function Report({ capture, settings, base, client }: Loaded) {
	const [marks, setMarks] = useState<Mark[]>([]);
	const [tool, setTool] = useState<MarkKind>("box");
	const consoleEntries = capture.console?.entries ?? [];
	const [form, setForm] = useState<ReportForm>({
		title: "",
		description: "",
		expected: "",
		actual: "",
		steps: "",
		severity: "",
		repository_id: "",
		include_title: true,
		include_console: consoleEntries.length > 0,
	});
	const [errors, setErrors] = useState<FieldError[]>([]);
	const [access, setAccess] = useState<Access>({ status: "loading" });
	const [environment, setEnvironment] = useState<Environment | null>(null);
	const [stage, setStage] = useState<Stage>({ kind: "edit" });
	const [investigation, setInvestigation] = useState<InvestigationView | null>(
		null,
	);
	const [pollError, setPollError] = useState<string | null>(null);

	const scopes =
		access.status === "ready" ? (access.me.auth.scopes ?? []) : null;
	const canInvestigate = scopes?.includes("investigations:write") ?? false;
	const canPoll = scopes?.includes("investigations:read") ?? false;

	useEffect(() => {
		void readEnvironment().then(setEnvironment);
		void (async () => {
			try {
				const me = await client.me();
				const scopes = me.auth.scopes ?? [];
				if (!scopes.includes("repositories:read")) {
					setAccess({
						status: "ready",
						me,
						repositories: null,
						problem:
							"The token lacks repositories:read, so the repository list is unavailable and no investigation can start from here.",
					});
					return;
				}
				const repositories = await client.repositories();
				setAccess({ status: "ready", me, repositories, problem: null });
				const [only] = repositories;
				if (repositories.length === 1 && only)
					setForm((current) => ({ ...current, repository_id: only.id }));
			} catch (error) {
				setAccess({ status: "error", message: messageOf(error) });
			}
		})();
	}, [client]);

	// Follows the investigation with long polling until it settles or needs a person in the web app.
	const investigationId = investigation?.id;
	useEffect(() => {
		if (!investigationId || !canPoll) return;
		let stopped = false;
		void (async () => {
			// The first read returns at once; later ones wait for the state version to change.
			let view: InvestigationView | null = null;
			let failures = 0;
			while (!stopped && !(view && SETTLED_STATUSES.has(view.status))) {
				try {
					view = await client.investigation(
						investigationId,
						view?.state_version,
					);
					failures = 0;
					setPollError(null);
					if (!stopped) setInvestigation(view);
				} catch (error) {
					const fatal =
						error instanceof ApiError &&
						error.status >= 400 &&
						error.status < 500 &&
						error.status !== 429;
					setPollError(
						`${messageOf(error)} ${fatal ? "Status updates stopped; open the investigation in Tracera." : "Retrying…"}`,
					);
					if (fatal) return;
					failures += 1;
					await new Promise((resolve) =>
						setTimeout(resolve, Math.min(30_000, 2_000 * 2 ** failures)),
					);
				}
			}
		})();
		return () => {
			stopped = true;
		};
	}, [investigationId, canPoll, client]);

	const fieldError = (field: FieldError["field"]) =>
		errors.find((error) => error.field === field)?.message;
	const set =
		<K extends keyof ReportForm>(key: K) =>
		(value: ReportForm[K]) =>
			setForm((current) => ({ ...current, [key]: value }));

	async function review(event: FormEvent) {
		event.preventDefault();
		const bytes = await encodePng(renderMarks(base, marks));
		const result = buildSubmission({
			form,
			page: capture.page,
			captured_at: capture.captured_at,
			environment: environment ?? {
				browser: null,
				os: null,
				user_agent: navigator.userAgent,
			},
			screenshot: { bytes, marks },
			console: capture.console,
			can_investigate: canInvestigate,
		});
		if (!result.ok) {
			setErrors(result.errors);
			return;
		}
		setErrors([]);
		setStage({
			kind: "preview",
			submission: result.submission,
			imageUrl: URL.createObjectURL(
				new Blob([new Uint8Array(bytes)], { type: "image/png" }),
			),
		});
	}

	async function send(
		submission: Submission,
		imageUrl: string,
		from: Progress,
	) {
		let progress = from;
		const update = (
			next: Progress,
			step: Step | null,
			error: ApiError | null,
		) =>
			setStage({
				kind: "send",
				submission,
				imageUrl,
				progress: next,
				step,
				error,
			});
		try {
			progress = await submit(client, submission, from, (next, step) => {
				progress = next;
				update(next, step, null);
			});
			update(progress, null, null);
			if (progress.investigation) setInvestigation(progress.investigation);
		} catch (error) {
			update(
				progress,
				null,
				error instanceof ApiError
					? error
					: new ApiError({
							status: 0,
							code: "client_error",
							message: messageOf(error),
						}),
			);
		}
	}

	const backToEdit = () => {
		if (stage.kind !== "edit") URL.revokeObjectURL(stage.imageUrl);
		setStage({ kind: "edit" });
	};
	const redactions = marks.filter((mark) => mark.kind === "redact").length;
	const pageUrl = stripUrl(capture.page.url);

	const main =
		stage.kind === "edit" ? (
			<>
				<div className="toolbar" role="toolbar" aria-label="Screenshot marks">
					<button
						type="button"
						className="btn"
						aria-pressed={tool === "box"}
						onClick={() => setTool("box")}
					>
						<span className="legend-box" aria-hidden="true" /> Outline
					</button>
					<button
						type="button"
						className="btn"
						aria-pressed={tool === "redact"}
						onClick={() => setTool("redact")}
					>
						<span className="legend-redact" aria-hidden="true" /> Black out
					</button>
					<button
						type="button"
						className="btn btn-quiet"
						disabled={marks.length === 0}
						onClick={() => setMarks((current) => current.slice(0, -1))}
					>
						Undo
					</button>
					<button
						type="button"
						className="btn btn-quiet"
						disabled={marks.length === 0}
						onClick={() => setMarks([])}
					>
						Clear marks
					</button>
				</div>
				<p className="small muted">
					Drag on the screenshot to {tool === "box" ? "outline" : "black out"}{" "}
					an area. Blacked-out areas are replaced by black pixels in the file
					itself before upload; {redactions} so far.
				</p>
				<Screenshot
					base={base}
					marks={marks}
					tool={tool}
					onMark={(mark) => setMarks((current) => [...current, mark])}
				/>
			</>
		) : (
			<>
				<h2>The screenshot exactly as it will be uploaded</h2>
				<img
					className="preview-image"
					src={stage.imageUrl}
					alt="The screenshot as it will be uploaded, with marks in the pixels"
				/>
				<p className="small muted">
					PNG, {base.width} × {base.height} px,{" "}
					{Math.ceil(stage.submission.screenshot.bytes.length / 1024)} KB.
				</p>
			</>
		);

	let side: ReactNode;
	if (stage.kind === "edit") {
		side = (
			<form className="stack" onSubmit={review} noValidate>
				{access.status === "error" && (
					<p className="alert alert-error small">{access.message}</p>
				)}
				{access.status === "ready" && access.problem && (
					<p className="alert alert-warning small">{access.problem}</p>
				)}
				<Field label="Title" error={fieldError("title")}>
					<input
						value={form.title}
						maxLength={200}
						required
						aria-invalid={fieldError("title") ? true : undefined}
						onChange={(event) => set("title")(event.currentTarget.value)}
					/>
				</Field>
				<Field label="What happened" error={fieldError("description")}>
					<textarea
						value={form.description}
						maxLength={20_000}
						required
						aria-invalid={fieldError("description") ? true : undefined}
						onChange={(event) => set("description")(event.currentTarget.value)}
					/>
				</Field>
				<Field label="Expected" error={fieldError("expected")}>
					<textarea
						value={form.expected}
						maxLength={5000}
						onChange={(event) => set("expected")(event.currentTarget.value)}
					/>
				</Field>
				<Field label="Actual" error={fieldError("actual")}>
					<textarea
						value={form.actual}
						maxLength={5000}
						onChange={(event) => set("actual")(event.currentTarget.value)}
					/>
				</Field>
				<Field
					label="Steps to reproduce, one per line"
					error={fieldError("steps")}
				>
					<textarea
						value={form.steps}
						onChange={(event) => set("steps")(event.currentTarget.value)}
					/>
				</Field>
				<div className="row">
					<Field label="Severity" error={fieldError("severity")}>
						<select
							value={form.severity}
							onChange={(event) =>
								set("severity")(
									event.currentTarget.value as ReportForm["severity"],
								)
							}
						>
							<option value="">Not set</option>
							{SeveritySchema.options.map((severity) => (
								<option key={severity} value={severity}>
									{humanize(severity)}
								</option>
							))}
						</select>
					</Field>
					<Field label="Repository" error={fieldError("repository_id")}>
						<select
							value={form.repository_id}
							disabled={
								access.status !== "ready" || access.repositories === null
							}
							onChange={(event) =>
								set("repository_id")(event.currentTarget.value)
							}
						>
							<option value="">
								{access.status === "loading" ? "Loading…" : "None"}
							</option>
							{access.status === "ready" &&
								access.repositories?.map((repository) => (
									<option key={repository.id} value={repository.id}>
										{repository.name}
									</option>
								))}
						</select>
					</Field>
				</div>
				<section className="card stack-tight small" aria-label="Page details">
					<h3>Page details sent with the report</h3>
					<p className="secondary">
						Address:{" "}
						{pageUrl ? <code>{pageUrl}</code> : "not a web address, left out"}
						{pageUrl && " (query string and fragment removed)"}
					</p>
					{capture.page.viewport && (
						<p className="secondary">
							Viewport: {capture.page.viewport.width} ×{" "}
							{capture.page.viewport.height} CSS px
							{capture.page.device_pixel_ratio
								? ` at ${capture.page.device_pixel_ratio}× pixel ratio`
								: ""}
						</p>
					)}
					<p className="secondary">
						Browser: {environment?.browser ?? "unknown"}
						{environment?.os ? ` on ${environment.os}` : ""}
					</p>
					{capture.page.title && (
						<label className="check">
							<input
								type="checkbox"
								checked={form.include_title}
								onChange={(event) =>
									set("include_title")(event.currentTarget.checked)
								}
							/>
							<span>
								Include the page title: <q>{capture.page.title}</q>
							</span>
						</label>
					)}
				</section>
				{consoleEntries.length > 0 && (
					<section
						className="card stack-tight small"
						aria-label="Console diagnostics"
					>
						<label className="check">
							<input
								type="checkbox"
								checked={form.include_console}
								onChange={(event) =>
									set("include_console")(event.currentTarget.checked)
								}
							/>
							<span>
								Include {consoleEntries.length} console message(s) recorded with
								your opt-in. They are page-reported: the page's scripts wrote
								them. Likely secrets and email addresses are removed.
							</span>
						</label>
						<ol className="console-list">
							{consoleEntries.slice(0, 50).map((entry, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
								<li key={index}>
									[{entry.level}] {scrubSecrets(entry.message).slice(0, 300)}
								</li>
							))}
						</ol>
					</section>
				)}
				{capture.console && consoleEntries.length === 0 && (
					<p className="small muted">
						Console recording was on, but the page logged no errors or warnings.
					</p>
				)}
				{capture.notes.map((note) => (
					<p key={note} className="alert alert-info small">
						{note}
					</p>
				))}
				{fieldError("page") && (
					<p className="alert alert-error small">{fieldError("page")}</p>
				)}
				{fieldError("screenshot") && (
					<p className="alert alert-error small">{fieldError("screenshot")}</p>
				)}
				{!canInvestigate && access.status === "ready" && (
					<p className="small muted">
						This token cannot start investigations, so only the report is
						created.
					</p>
				)}
				<button type="submit" className="btn btn-primary">
					Review what will be sent
				</button>
			</form>
		);
	} else if (stage.kind === "preview") {
		const { submission, imageUrl } = stage;
		side = (
			<div className="stack">
				<h2>Review before sending</h2>
				<p className="small secondary">
					These requests go to <code>{client.origin}</code> with your token, in
					this order. Nothing else is sent. Values in braces are filled in by
					Tracera's answers.
				</p>
				{previewRequests(submission).map((request, index) => (
					<div key={request.path} className="stack-tight">
						<h3>
							{index + 1}. {request.method} {request.path}
						</h3>
						<pre className="payload">
							{JSON.stringify(request.body, null, 2)}
						</pre>
					</div>
				))}
				{!submission.investigation && (
					<p className="alert alert-info small">
						No investigation will start:{" "}
						{canInvestigate
							? "choose a repository to investigate."
							: "the token cannot start investigations."}
					</p>
				)}
				<div className="row">
					<button
						type="button"
						className="btn btn-primary"
						onClick={() => send(submission, imageUrl, NO_PROGRESS)}
					>
						Send to Tracera
					</button>
					<button type="button" className="btn" onClick={backToEdit}>
						Back to editing
					</button>
				</div>
			</div>
		);
	} else {
		const { submission, imageUrl, progress, step, error } = stage;
		const row = (label: string, id: string | null, active: boolean) => (
			<li>
				<span
					className={`status ${id ? "status-success" : error && active ? "status-error" : "status-muted"}`}
				>
					{id ? "Done" : active ? (error ? "Failed" : "Working") : "Waiting"}
				</span>
				<span>
					{label}
					{id && (
						<>
							{" "}
							<code>{id}</code>
						</>
					)}
				</span>
			</li>
		);
		const current: Step | null =
			step ??
			(!progress.bug_report_id
				? "report"
				: !progress.evidence_id
					? "screenshot"
					: submission.investigation && !progress.investigation
						? "investigation"
						: null);
		side = (
			<div className="stack">
				<h2>Sending to Tracera</h2>
				<ol className="steps">
					{row(
						"Create the bug report",
						progress.bug_report_id,
						current === "report",
					)}
					{row(
						"Upload the screenshot",
						progress.evidence_id,
						current === "screenshot",
					)}
					{submission.investigation &&
						row(
							"Start the investigation",
							progress.investigation?.id ?? null,
							current === "investigation",
						)}
				</ol>
				{error && (
					<div className="alert alert-error small stack-tight" role="alert">
						<p>{error.message}</p>
						{error.fieldErrors.map((item) => (
							<p key={item.path}>
								<code>{item.path}</code>: {item.message}
							</p>
						))}
						{error.requestId && (
							<p className="muted">
								Request ID <code>{error.requestId}</code>
							</p>
						)}
						<div className="row">
							<button
								type="button"
								className="btn btn-primary"
								onClick={() => send(submission, imageUrl, progress)}
							>
								Retry
							</button>
							{!progress.bug_report_id && (
								<button type="button" className="btn" onClick={backToEdit}>
									Back to editing
								</button>
							)}
						</div>
					</div>
				)}
				{investigation && (
					<InvestigationCard
						view={investigation}
						webUrl={settings.web_url}
						pollError={
							canPoll
								? pollError
								: "The token lacks investigations:read, so the status is not followed here."
						}
					/>
				)}
				{!error &&
					!current &&
					!submission.investigation &&
					progress.bug_report_id && (
						<p className="alert alert-info small">
							Report <code>{progress.bug_report_id}</code> is in Tracera. Start
							an investigation for it from the{" "}
							<a
								href={`${settings.web_url}/investigations`}
								target="_blank"
								rel="noopener noreferrer"
							>
								web app
							</a>
							.
						</p>
					)}
			</div>
		);
	}

	return (
		<div className="editor">
			<main className="editor-main">
				<header className="row spread">
					<div className="brand">
						<span className="brand-mark" aria-hidden="true" />
						<h1>New bug report</h1>
					</div>
					<span className="small muted">
						Captured {new Date(capture.captured_at).toLocaleString()}
					</span>
				</header>
				{main}
			</main>
			<aside className="editor-side" aria-label="Report">
				{side}
			</aside>
		</div>
	);
}

// Started once per page: taking a capture is one-shot, so it must not repeat on a re-render.
const loading = load();

function Editor() {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	useEffect(() => {
		loading.then(setLoaded, (error: unknown) => setProblem(messageOf(error)));
	}, []);
	if (problem)
		return (
			<main className="editor-main stack">
				<div className="brand">
					<span className="brand-mark" aria-hidden="true" />
					<h1>Tracera</h1>
				</div>
				<p className="alert alert-error">{problem}</p>
			</main>
		);
	if (!loaded)
		return (
			<main className="editor-main">
				<p className="muted">Preparing the screenshot…</p>
			</main>
		);
	return <Report {...loaded} />;
}

const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<StrictMode>
			<Editor />
		</StrictMode>,
	);
