import {
	type CreateBugReportRequest,
	CreateBugReportRequestSchema,
	MAX_IMAGE_EVIDENCE_BYTES,
	ScreenshotEvidenceMetaSchema,
	type Severity,
} from "@tracera/contracts";
import {
	type ApiClient,
	ApiError,
	type InvestigationView,
	type ScreenshotUpload,
} from "./api.ts";
import type { Mark } from "./image.ts";
import type { ConsoleCapture } from "./messages.ts";

export type ReportForm = {
	title: string;
	description: string;
	expected: string;
	actual: string;
	steps: string;
	severity: Severity | "";
	repository_id: string;
	include_title: boolean;
	include_console: boolean;
};

export type SubmissionInput = {
	form: ReportForm;
	page: {
		url: string | null;
		title: string | null;
		viewport: { width: number; height: number } | null;
		device_pixel_ratio: number | null;
	};
	captured_at: string;
	environment: {
		browser: string | null;
		os: string | null;
		user_agent: string | null;
	};
	/** The PNG exactly as it will be uploaded, with marks already burned into the pixels. */
	screenshot: { bytes: Uint8Array; marks: readonly Mark[] };
	console: ConsoleCapture | null;
	can_investigate: boolean;
};

/** Everything that leaves the browser, built once: the preview shows it and `submit` sends it unchanged. */
export type Submission = {
	report: CreateBugReportRequest;
	screenshot: ScreenshotUpload;
	investigation: { repository_id: string } | null;
	keys: { report: string; screenshot: string; investigation: string };
};

export type FieldError = {
	field: keyof ReportForm | "screenshot" | "page";
	message: string;
};

export const BUG_REPORT_ID = "{bug_report_id}";
const MAX_LOG_CHARS = 200_000;

/** The page address without its query string or fragment, which may hold tokens; null unless http(s). */
export function stripUrl(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return `${url.origin}${url.pathname}`;
	} catch {
		return null;
	}
}

const SECRETS: [RegExp, string][] = [
	[/\btrc_pat_[A-Za-z0-9]{20,}/g, "[REDACTED:tracera_token]"],
	[
		/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
		"[REDACTED:jwt]",
	],
	[/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g, "Bearer [REDACTED]"],
	[/\b[Bb]asic\s+[A-Za-z0-9+/]{8,}=*/g, "Basic [REDACTED]"],
	[/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED:key]"],
	[/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:key]"],
	[
		/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g,
		"[REDACTED:github]",
	],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws]"],
	[/\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED:google]"],
	[
		// The scheme word stays readable; the credential after it is handled by the patterns above.
		/\b(api[_-]?key|secret|token|password|passwd|authorization|session|cookie)(\s*[:=]\s*)(["']?)(?!(?:Bearer|Basic)\b)[^\s"',;]{4,}\3/gi,
		"$1$2[REDACTED]",
	],
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, "$1[REDACTED]@"],
	[/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1"],
	[/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:email]"],
];

/** Removes likely credentials, query strings, and email addresses from page-reported text. */
export function scrubSecrets(text: string): string {
	return SECRETS.reduce(
		(out, [pattern, replacement]) => out.replace(pattern, replacement),
		text,
	);
}

/** Console records as one plain-text log, labelled page-reported, scrubbed, and within the API limit. */
export function formatConsole(capture: ConsoleCapture): string {
	const lines = capture.entries.map(
		(entry) =>
			`${entry.at} [${entry.level}] ${scrubSecrets(entry.message).replace(/\r?\n/g, "\n    ")}${entry.source ? ` (at ${scrubSecrets(entry.source)})` : ""}`,
	);
	const text = [
		"Console messages reported by the page after the user opted in to recording in the Tracera extension.",
		"Page-reported and unverified: the page's own scripts can write or alter them.",
		`Recording started ${capture.started_at}; ${capture.entries.length} message(s).`,
		"",
		...lines,
	].join("\n");
	return text.length <= MAX_LOG_CHARS
		? text
		: `${text.slice(0, MAX_LOG_CHARS - 40)}\n[truncated by the extension]`;
}

/** List markers are dropped because the API keeps steps as an ordered array. */
export const parseSteps = (text: string) =>
	text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, "").trim())
		.filter(Boolean);

const FIELD_OF: Record<string, FieldError["field"]> = {
	title: "title",
	description: "description",
	expected_behavior: "expected",
	actual_behavior: "actual",
	steps: "steps",
	severity: "severity",
	repository_id: "repository_id",
};

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(
			([, v]) =>
				v !== undefined &&
				v !== null &&
				v !== "" &&
				!(Array.isArray(v) && v.length === 0) &&
				!(
					typeof v === "object" &&
					!Array.isArray(v) &&
					Object.keys(v).length === 0
				),
		),
	) as Partial<T>;
}

/**
 * Builds the requests from the form, the page context, and the rendered screenshot, validated with the
 * same contract schemas the API uses. Empty fields are left out so the server does not record them as
 * user-provided; the URL loses its query string and fragment before it is ever shown or sent.
 */
export function buildSubmission(
	input: SubmissionInput,
	newKey: () => string = () => crypto.randomUUID(),
): { ok: true; submission: Submission } | { ok: false; errors: FieldError[] } {
	const { form, page } = input;
	const url = stripUrl(page.url);
	const includeConsole =
		form.include_console &&
		input.console !== null &&
		input.console.entries.length > 0;
	const report = CreateBugReportRequestSchema.safeParse(
		compact({
			title: form.title,
			description: form.description,
			expected_behavior: form.expected.trim(),
			actual_behavior: form.actual.trim(),
			steps: parseSteps(form.steps),
			severity: form.severity,
			repository_id: form.repository_id,
			affected_url: url,
			environment: compact({
				browser: input.environment.browser,
				os: input.environment.os,
				user_agent: input.environment.user_agent,
				viewport: page.viewport,
			}),
			logs:
				includeConsole && input.console
					? [
							{
								kind: "log_file" as const,
								content: formatConsole(input.console),
							},
						]
					: undefined,
		}),
	);
	const marks = (kind: Mark["kind"]) =>
		input.screenshot.marks
			.filter((mark) => mark.kind === kind)
			.map((mark) => mark.rect);
	const meta = ScreenshotEvidenceMetaSchema.safeParse(
		compact({
			kind: "screenshot",
			captured_at: input.captured_at,
			page_url: url,
			page_title: form.include_title
				? page.title?.trim().slice(0, 300)
				: undefined,
			viewport: page.viewport,
			device_pixel_ratio: page.device_pixel_ratio,
			client_redactions: marks("redact"),
			client_annotations: marks("box"),
		}),
	);
	const errors: FieldError[] = [];
	if (!report.success)
		for (const issue of report.error.issues)
			errors.push({
				field: FIELD_OF[String(issue.path[0])] ?? "page",
				message: issue.message,
			});
	if (!meta.success)
		errors.push({
			field: "page",
			message: "The page details could not be attached.",
		});
	if (input.screenshot.bytes.length > MAX_IMAGE_EVIDENCE_BYTES)
		errors.push({
			field: "screenshot",
			message: "The screenshot is larger than 10 MB. Select a smaller region.",
		});
	if (!report.success || !meta.success || errors.length > 0)
		return { ok: false, errors };
	return {
		ok: true,
		submission: {
			report: report.data,
			screenshot: { bytes: input.screenshot.bytes, meta: meta.data },
			investigation:
				input.can_investigate && report.data.repository_id
					? { repository_id: report.data.repository_id }
					: null,
			keys: { report: newKey(), screenshot: newKey(), investigation: newKey() },
		},
	};
}

/** The requests in the order they are sent, as the preview shows them. */
export function previewRequests(submission: Submission) {
	return [
		{ method: "POST", path: "/api/v1/bug-reports", body: submission.report },
		{
			method: "POST",
			path: `/api/v1/bug-reports/${BUG_REPORT_ID}/evidence`,
			body: {
				meta: submission.screenshot.meta,
				file: {
					name: "screenshot.png",
					type: "image/png",
					size_bytes: submission.screenshot.bytes.length,
				},
			},
		},
		...(submission.investigation
			? [
					{
						method: "POST",
						path: "/api/v1/investigations",
						body: { bug_report_id: BUG_REPORT_ID, ...submission.investigation },
					},
				]
			: []),
	];
}

export type Progress = {
	bug_report_id: string | null;
	evidence_id: string | null;
	investigation: InvestigationView | null;
};
export type Step = "report" | "screenshot" | "investigation";
export const NO_PROGRESS: Progress = {
	bug_report_id: null,
	evidence_id: null,
	investigation: null,
};

/**
 * Sends the submission, resuming after the last completed step. Each step has its own idempotency key,
 * so retrying after a lost response replays the stored result instead of creating a duplicate.
 */
export async function submit(
	client: ApiClient,
	submission: Submission,
	from: Progress,
	onProgress: (progress: Progress, next: Step | null) => void,
): Promise<Progress> {
	let progress = from;
	const advance = (patch: Partial<Progress>, next: Step | null) => {
		progress = { ...progress, ...patch };
		onProgress(progress, next);
	};
	let bugReportId = progress.bug_report_id;
	if (!bugReportId) {
		onProgress(progress, "report");
		bugReportId = (
			await client.createBugReport(submission.report, submission.keys.report)
		).id;
		advance({ bug_report_id: bugReportId }, "screenshot");
	}
	if (!progress.evidence_id) {
		onProgress(progress, "screenshot");
		const evidence = await client.uploadScreenshot(
			bugReportId,
			submission.screenshot,
			submission.keys.screenshot,
		);
		advance(
			{ evidence_id: evidence.id },
			submission.investigation ? "investigation" : null,
		);
	}
	if (submission.investigation && !progress.investigation) {
		onProgress(progress, "investigation");
		const body = { bug_report_id: bugReportId, ...submission.investigation };
		const investigation = await client
			.startInvestigation(body, submission.keys.investigation)
			.catch(async (error: unknown) => {
				// Someone already started one for this report: follow it instead of failing.
				if (
					error instanceof ApiError &&
					error.code === "investigation_active" &&
					error.investigationId
				)
					return client.investigation(error.investigationId);
				throw error;
			});
		advance({ investigation }, null);
	}
	return progress;
}

/** States after which an investigation needs a person in the web app, or is finished. */
export const SETTLED_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"awaiting_approval",
	"needs_input",
]);
