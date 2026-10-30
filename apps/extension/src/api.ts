import {
	type CreateBugReportRequest,
	type CreateInvestigationRequest,
	InvestigationStatusSchema,
	idSchema,
	ProblemSchema,
	type ScreenshotEvidenceMeta,
} from "@tracera/contracts";
import { z } from "zod";

// Response shapes the extension relies on. Unknown fields are ignored, and IDs are checked before
// they are used in a URL path.
const MeSchema = z.object({
	user: z.object({ email: z.string().nullish() }),
	workspace: z.object({ name: z.string().nullish() }),
	auth: z.object({
		type: z.enum(["session", "token"]),
		scopes: z.array(z.string()).nullable(),
	}),
});
const RepositoriesSchema = z.object({
	items: z.array(z.object({ id: idSchema("repo"), name: z.string() })),
});
const BugReportSchema = z.object({
	bug_report: z.object({ id: idSchema("bug"), status: z.string() }),
});
const EvidenceSchema = z.object({
	evidence: z.object({
		id: idSchema("evd"),
		mime_type: z.string(),
		size_bytes: z.number(),
	}),
});
export const InvestigationViewSchema = z.object({
	id: idSchema("inv"),
	status: InvestigationStatusSchema,
	state_version: z.number().int(),
	current_stage: z.string().nullable(),
	mode: z.string(),
	progress: z.object({ message: z.string() }).nullish(),
	inference: z.object({ provider: z.string(), mock: z.boolean() }),
	failure: z.object({ message: z.string() }).nullish(),
	latest_verification: z.object({ outcome: z.string() }).nullish(),
});
const InvestigationSchema = z.object({
	investigation: InvestigationViewSchema,
});

export type Me = z.infer<typeof MeSchema>;
export type InvestigationView = z.infer<typeof InvestigationViewSchema>;
export type ScreenshotUpload = {
	bytes: Uint8Array;
	meta: ScreenshotEvidenceMeta;
};

/** A failed call with a message for the user; `status` 0 means no HTTP response arrived. */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly requestId: string | null;
	readonly fieldErrors: { path: string; message: string }[];
	readonly retryAfterSeconds: number | null;
	readonly investigationId: string | null;

	constructor(init: {
		status: number;
		code: string;
		message: string;
		requestId?: string | null;
		fieldErrors?: { path: string; message: string }[];
		retryAfterSeconds?: number | null;
		investigationId?: string | null;
	}) {
		super(init.message);
		this.name = "ApiError";
		this.status = init.status;
		this.code = init.code;
		this.requestId = init.requestId ?? null;
		this.fieldErrors = init.fieldErrors ?? [];
		this.retryAfterSeconds = init.retryAfterSeconds ?? null;
		this.investigationId = init.investigationId ?? null;
	}
}

/** What the user reads for an error response; the server's `detail` is shown as plain text only. */
export function describeError(
	status: number,
	code: string,
	detail: string | null,
	retryAfterSeconds: number | null,
): string {
	if (status === 401)
		return "Tracera rejected the token: it is invalid, expired, or revoked. Create a new token and save it in the settings.";
	if (code === "insufficient_scope")
		return `${detail ? detail.replace(/([^.!?])$/, "$1.") : "The token lacks a required scope."} Create a token with the scopes listed in the settings.`;
	if (status === 403) return detail ?? "Tracera refused this request.";
	if (status === 404)
		return (
			detail ??
			"Not found. It may have been deleted, or it belongs to another workspace."
		);
	if (status === 413)
		return "The screenshot is larger than this Tracera server accepts. Select a smaller region and try again.";
	if (status === 415)
		return detail ?? "Tracera does not accept this file type.";
	if (status === 429)
		return `Tracera is limiting requests${retryAfterSeconds ? `; try again in ${retryAfterSeconds} s` : ""}.`;
	if (status >= 500)
		return "Tracera had an internal problem. Try again in a moment.";
	return detail ?? `Tracera answered with status ${status}.`;
}

/**
 * The REST client used by the extension pages. Requests carry only the bearer token: `credentials:
 * "omit"` keeps the browser from attaching a Tracera session cookie, and redirects are refused so the
 * token is never forwarded to another URL.
 */
export function createApiClient(options: {
	apiUrl: string;
	token: string;
	fetch?: typeof fetch;
}) {
	const base = options.apiUrl.replace(/\/+$/, "");
	const origin = new URL(base).origin;
	const send = options.fetch ?? ((input, init) => fetch(input, init));

	async function call<T>(
		method: "GET" | "POST",
		path: string,
		schema: z.ZodType<T>,
		request: {
			json?: unknown;
			form?: FormData;
			idempotencyKey?: string;
			timeoutMs?: number;
		} = {},
	): Promise<T> {
		const headers: Record<string, string> = {
			accept: "application/json",
			authorization: `Bearer ${options.token}`,
		};
		if (request.json !== undefined)
			headers["content-type"] = "application/json";
		if (request.idempotencyKey)
			headers["idempotency-key"] = request.idempotencyKey;
		let response: Response;
		try {
			response = await send(`${base}${path}`, {
				method,
				headers,
				body:
					request.json !== undefined
						? JSON.stringify(request.json)
						: request.form,
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
				signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
			});
		} catch (error) {
			const timedOut = error instanceof Error && error.name === "TimeoutError";
			throw new ApiError({
				status: 0,
				code: timedOut ? "timeout" : "network_error",
				message: timedOut
					? `Tracera at ${origin} did not answer in time. Check that the API is running, then retry.`
					: `Could not reach Tracera at ${origin}. Check that the API is running and the URL in the settings, then retry.`,
			});
		}
		const body: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const problem = ProblemSchema.safeParse(body);
			const retryAfter = Number(response.headers.get("retry-after"));
			const retryAfterSeconds =
				Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
			const code = problem.success
				? problem.data.code
				: `http_${response.status}`;
			const existing = idSchema("inv").safeParse(
				(body as { investigation_id?: unknown } | undefined)?.investigation_id,
			);
			throw new ApiError({
				status: response.status,
				code,
				message: describeError(
					response.status,
					code,
					problem.success ? problem.data.detail : null,
					retryAfterSeconds,
				),
				requestId: problem.success ? problem.data.request_id : null,
				fieldErrors: problem.success ? (problem.data.errors ?? []) : [],
				retryAfterSeconds,
				investigationId: existing.success ? existing.data : null,
			});
		}
		const parsed = schema.safeParse(body);
		if (!parsed.success)
			throw new ApiError({
				status: response.status,
				code: "unexpected_response",
				message: `Tracera at ${origin} answered with an unexpected response. Check the API URL in the settings.`,
			});
		return parsed.data;
	}

	return {
		origin,
		me: () => call("GET", "/api/v1/auth/me", MeSchema),
		repositories: async () =>
			(await call("GET", "/api/v1/repositories", RepositoriesSchema)).items,
		createBugReport: async (body: CreateBugReportRequest, key: string) =>
			(
				await call("POST", "/api/v1/bug-reports", BugReportSchema, {
					json: body,
					idempotencyKey: key,
				})
			).bug_report,
		uploadScreenshot: async (
			bugReportId: string,
			screenshot: ScreenshotUpload,
			key: string,
		) => {
			const form = new FormData();
			form.set("meta", JSON.stringify(screenshot.meta));
			form.set(
				"file",
				new Blob([new Uint8Array(screenshot.bytes)], { type: "image/png" }),
				"screenshot.png",
			);
			return (
				await call(
					"POST",
					`/api/v1/bug-reports/${bugReportId}/evidence`,
					EvidenceSchema,
					{ form, idempotencyKey: key, timeoutMs: 300_000 },
				)
			).evidence;
		},
		startInvestigation: async (body: CreateInvestigationRequest, key: string) =>
			(
				await call("POST", "/api/v1/investigations", InvestigationSchema, {
					json: body,
					idempotencyKey: key,
				})
			).investigation,
		/** With `knownVersion`, long-polls: the server answers when the state changes or after 20 s. */
		investigation: async (id: string, knownVersion?: number) =>
			(
				await call(
					"GET",
					`/api/v1/investigations/${id}${knownVersion === undefined ? "" : `?wait_seconds=20&known_version=${knownVersion}`}`,
					InvestigationSchema,
					{ timeoutMs: 35_000 },
				)
			).investigation,
	};
}

export type ApiClient = ReturnType<typeof createApiClient>;
