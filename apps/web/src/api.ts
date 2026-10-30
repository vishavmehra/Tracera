import {
	type ActionRequest,
	type ApprovalRequest,
	type AskQuestionRequest,
	type ChangeImpactRequest,
	type CreateBugReportRequest,
	type CreateInvestigationRequest,
	type CreateRepositoryRequest,
	type LoginRequest,
	type PatchImpactRequest,
	type Problem,
	ProblemSchema,
} from "@tracera/contracts";
import { z } from "zod";
import {
	ApprovalResponseSchema,
	AssessmentResponseSchema,
	BugReportResponseSchema,
	ChangeImpactSchema,
	FindingsSchema,
	HistorySchema,
	InvestigationListSchema,
	InvestigationResponseSchema,
	NodeDetailSchema,
	PatchActionListSchema,
	PatchActionResponseSchema,
	PatchAnalysisListSchema,
	PatchAnalysisResponseSchema,
	PatchDiffSchema,
	PatchListSchema,
	PatchResponseSchema,
	ProfileSchema,
	ReadinessSchema,
	RegisterResponseSchema,
	ReportSchema,
	RepositoryListSchema,
	RepositoryResponseSchema,
	ReproductionListSchema,
	SearchResponseSchema,
	SessionSchema,
	SignInResponseSchema,
	SnapshotListSchema,
	SnapshotResponseSchema,
	TraceSchema,
	VerificationResponseSchema,
} from "./schemas.ts";

/**
 * A failed API call. `problem` is the server's RFC 9457 body; when it is null the web app detected the
 * failure itself (no response, or a response without problem details or with an unexpected shape).
 * `extra` keeps the problem's additional members (for example `investigation_id` on
 * `investigation_active`, or `missing` on `risks_not_acknowledged`).
 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly problem: Problem | null;
	readonly extra: Record<string, unknown>;

	constructor(
		status: number,
		code: string,
		message: string,
		problem: Problem | null = null,
		extra: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.problem = problem;
		this.extra = extra;
	}
}

/** The session is missing or expired. A rejected sign-in (`invalid_credentials`) is not a sign-out. */
export const isSignedOut = (error: unknown): boolean =>
	error instanceof ApiError &&
	error.status === 401 &&
	error.code !== "invalid_credentials";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Query = Record<string, string | number | boolean | undefined>;

const withQuery = (path: string, query?: Query) => {
	if (!query) return path;
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query))
		if (value !== undefined) params.set(key, String(value));
	const text = params.toString();
	return text ? `${path}?${text}` : path;
};

async function send(
	path: string,
	init: { method?: Method; body?: unknown; accept?: string },
): Promise<Response> {
	const method = init.method ?? "GET";
	const headers: Record<string, string> = {
		accept: init.accept ?? "application/json",
	};
	// The session cookie is an ambient credential, so the API refuses cookie-authenticated mutations
	// without this header and a same-origin Origin. Browsers set Origin.
	if (method !== "GET") headers["x-tracera-csrf"] = "1";
	if (init.body !== undefined) headers["content-type"] = "application/json";
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			headers,
			credentials: "same-origin",
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});
	} catch {
		throw new ApiError(
			0,
			"network_error",
			"The Tracera API could not be reached.",
		);
	}
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => undefined);
		const problem = ProblemSchema.safeParse(body);
		if (problem.success)
			throw new ApiError(
				response.status,
				problem.data.code,
				problem.data.detail,
				problem.data,
				body as Record<string, unknown>,
			);
		throw new ApiError(
			response.status,
			"unexpected_response",
			`The server answered HTTP ${response.status} without problem details.`,
		);
	}
	return response;
}

async function request<T>(
	path: string,
	schema: z.ZodType<T>,
	init: { method?: Method; body?: unknown; query?: Query } = {},
): Promise<T> {
	const url = withQuery(path, init.query);
	const response = await send(url, init);
	const body: unknown = await response.json().catch(() => undefined);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		const fields = parsed.error.issues
			.slice(0, 3)
			.map((issue) => issue.path.map(String).join(".") || "(root)")
			.join(", ");
		throw new ApiError(
			response.status,
			"invalid_response",
			`The response from ${path} did not have the expected shape (${fields}).`,
		);
	}
	return parsed.data;
}

const enc = encodeURIComponent;
const repositoryPath = (id: string) => `/api/v1/repositories/${enc(id)}`;

// ---- Auth ----
export const signIn = (input: LoginRequest) =>
	request("/api/v1/auth/login", SignInResponseSchema, {
		method: "POST",
		body: input,
	});
/** 204 No Content: there is no body to validate. */
export const signOut = () =>
	request("/api/v1/auth/logout", z.undefined(), { method: "POST" });
export const getSession = () => request("/api/v1/auth/me", SessionSchema);
/** Public readiness: inference mode, worker liveness, sandbox availability. */
export const getReadiness = async () => {
	// 503 is a valid answer here (not ready), with the same body.
	const response = await fetch("/readyz", {
		headers: { accept: "application/json" },
	}).catch(() => null);
	if (!response)
		throw new ApiError(
			0,
			"network_error",
			"The Tracera API could not be reached.",
		);
	const parsed = ReadinessSchema.safeParse(
		await response.json().catch(() => undefined),
	);
	if (!parsed.success)
		throw new ApiError(
			response.status,
			"invalid_response",
			"Unexpected /readyz response.",
		);
	return parsed.data;
};

// ---- Repositories and indexing ----
export const listRepositories = () =>
	request("/api/v1/repositories", RepositoryListSchema);
export const getRepository = async (id: string) =>
	(await request(repositoryPath(id), RepositoryResponseSchema)).repository;
export const registerRepository = (input: CreateRepositoryRequest) =>
	request("/api/v1/repositories", RegisterResponseSchema, {
		method: "POST",
		body: input,
	});
export const listSnapshots = async (id: string) =>
	(await request(`${repositoryPath(id)}/snapshots`, SnapshotListSchema))
		.snapshots;
export const getProfile = (id: string) =>
	request(`${repositoryPath(id)}/profile`, ProfileSchema);
export const requestIndex = (id: string, ref?: string) =>
	request(`${repositoryPath(id)}/index`, SnapshotResponseSchema, {
		method: "POST",
		body: ref ? { ref } : {},
	});
export const cancelSnapshot = (snapshotId: string) =>
	request(
		`/api/v1/snapshots/${enc(snapshotId)}/cancel`,
		SnapshotResponseSchema,
		{
			method: "POST",
		},
	);

// ---- Graph exploration ----
export const searchRepository = (id: string, q: string) =>
	request(`${repositoryPath(id)}/search`, SearchResponseSchema, {
		query: { q, mode: "all", limit: 40 },
	});
export const getNode = (nodeId: string) =>
	request(`/api/v1/graph/nodes/${enc(nodeId)}`, NodeDetailSchema);
export const traceNode = (
	nodeId: string,
	direction: "downstream" | "upstream",
) =>
	request(`/api/v1/graph/nodes/${enc(nodeId)}/trace`, TraceSchema, {
		query: { direction },
	});
export const nodeHistory = (nodeId: string) =>
	request(`/api/v1/graph/nodes/${enc(nodeId)}/history`, HistorySchema);
export const analyzeImpact = (id: string, input: ChangeImpactRequest) =>
	request(`${repositoryPath(id)}/impact`, ChangeImpactSchema, {
		method: "POST",
		body: input,
	});

// ---- Questions ----
export const askQuestion = (id: string, input: AskQuestionRequest) =>
	request(`${repositoryPath(id)}/questions`, AssessmentResponseSchema, {
		method: "POST",
		body: input,
	});
export const getAssessment = async (id: string) =>
	(await request(`/api/v1/assessments/${enc(id)}`, AssessmentResponseSchema))
		.assessment;

// ---- Patch impact ----
export const createPatchAnalysis = (id: string, input: PatchImpactRequest) =>
	request(`${repositoryPath(id)}/patch-impact`, PatchAnalysisResponseSchema, {
		method: "POST",
		body: input,
	});
export const listPatchAnalyses = async (id: string) =>
	(await request(`${repositoryPath(id)}/patch-impact`, PatchAnalysisListSchema))
		.analyses;
export const getPatchAnalysis = async (id: string) =>
	(
		await request(
			`/api/v1/patch-impact/${enc(id)}`,
			PatchAnalysisResponseSchema,
		)
	).analysis;
export const cancelPatchAnalysis = (id: string) =>
	request(
		`/api/v1/patch-impact/${enc(id)}/cancel`,
		PatchAnalysisResponseSchema,
		{
			method: "POST",
		},
	);

// ---- Bug reports and investigations ----
export const createBugReport = (input: CreateBugReportRequest) =>
	request("/api/v1/bug-reports", BugReportResponseSchema, {
		method: "POST",
		body: input,
	});
export const getBugReport = async (id: string) =>
	(await request(`/api/v1/bug-reports/${enc(id)}`, BugReportResponseSchema))
		.bug_report;
export const createInvestigation = (input: CreateInvestigationRequest) =>
	request("/api/v1/investigations", InvestigationResponseSchema, {
		method: "POST",
		body: input,
	});
export const listInvestigations = () =>
	request("/api/v1/investigations", InvestigationListSchema, {
		query: { limit: 50 },
	});
const investigationPath = (id: string) => `/api/v1/investigations/${enc(id)}`;
export const getInvestigation = async (id: string) =>
	(await request(investigationPath(id), InvestigationResponseSchema))
		.investigation;
export const cancelInvestigation = (id: string) =>
	request(`${investigationPath(id)}/cancel`, z.unknown(), { method: "POST" });
export const retryInvestigation = (id: string) =>
	request(`${investigationPath(id)}/retry`, z.unknown(), { method: "POST" });
export const getFindings = (id: string) =>
	request(`${investigationPath(id)}/findings`, FindingsSchema);
export const listReproductions = async (id: string) =>
	(
		await request(
			`${investigationPath(id)}/reproductions`,
			ReproductionListSchema,
		)
	).items;
export const listPatches = async (id: string) =>
	(await request(`${investigationPath(id)}/patches`, PatchListSchema)).items;
export const getReport = async (id: string) =>
	(await request(`${investigationPath(id)}/report`, ReportSchema)).report;

// ---- Patches, verification, approval ----
export const getPatch = async (id: string) =>
	(await request(`/api/v1/patches/${enc(id)}`, PatchResponseSchema)).patch;
export const getPatchDiff = (id: string) =>
	request(`/api/v1/patches/${enc(id)}/diff`, PatchDiffSchema);
export const getVerification = async (id: string) =>
	(
		await request(
			`/api/v1/verifications/${enc(id)}`,
			VerificationResponseSchema,
		)
	).verification;
/** Session only on the server; it records a decision and changes no files. */
export const decidePatch = (id: string, input: ApprovalRequest) =>
	request(`/api/v1/patches/${enc(id)}/approval`, ApprovalResponseSchema, {
		method: "POST",
		body: input,
	});

// ---- Authorized actions on an approved patch (apply, commit, push) ----
export const listPatchActions = (id: string) =>
	request(`/api/v1/patches/${enc(id)}/actions`, PatchActionListSchema);
/** Owner session only on the server; each call is one explicitly authorized action. */
export const requestPatchAction = async (id: string, input: ActionRequest) =>
	(
		await request(
			`/api/v1/patches/${enc(id)}/actions`,
			PatchActionResponseSchema,
			{
				method: "POST",
				body: input,
			},
		)
	).action;
export const patchDownloadPath = (id: string) =>
	`/api/v1/patches/${enc(id)}/download`;
