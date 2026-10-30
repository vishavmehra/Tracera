import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/api.ts";
import {
	BUG_REPORT_ID,
	buildSubmission,
	formatConsole,
	NO_PROGRESS,
	type Progress,
	parseSteps,
	previewRequests,
	type ReportForm,
	type Submission,
	type SubmissionInput,
	scrubSecrets,
	stripUrl,
	submit,
} from "../src/submission.ts";
import { type Call, fakeFetch, json, problem, TOKEN, ULID } from "./fakes.ts";

const BUG = `bug_${ULID}`;
const EVD = `evd_${ULID}`;
const INV = `inv_${ULID}`;
const REPO = `repo_${ULID}`;
const OTHER_INV = "inv_01JC9Z3K8Q5V7W2X4Y6Z8A0B1D";
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7,
]);
const REDACTED = { x: 1, y: 2, width: 3, height: 4 };
const OUTLINED = { x: 10, y: 10, width: 20, height: 8 };

function input(
	form: Partial<ReportForm> = {},
	overrides: Partial<SubmissionInput> = {},
): SubmissionInput {
	return {
		form: {
			title: "  Average order value is wrong ",
			description: "The dashboard shows $12.40.",
			expected: "$24.80",
			actual: "   ",
			steps: "1. Open /dashboard\n\n- Read Average order value\n",
			severity: "high",
			repository_id: REPO,
			include_title: true,
			include_console: true,
			...form,
		},
		page: {
			url: "https://shop.example/dashboard?session=abc123#orders",
			title: "Dashboard · Shop",
			viewport: { width: 1280, height: 720 },
			device_pixel_ratio: 2,
		},
		captured_at: "2026-10-25T10:00:00.000Z",
		environment: {
			browser: "Google Chrome 141.0.7390.55",
			os: "Windows 19.0.0",
			user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0",
		},
		screenshot: {
			bytes: PNG,
			marks: [
				{ kind: "redact", rect: REDACTED },
				{ kind: "box", rect: OUTLINED },
			],
		},
		console: {
			active: true,
			started_at: "2026-10-25T09:59:00.000Z",
			entries: [
				{
					level: "error",
					message: "TypeError: total is undefined; token=abcd1234efgh",
					source: "https://shop.example/app.js?v=3:10:5",
					at: "2026-10-25T09:59:30.000Z",
				},
			],
		},
		can_investigate: true,
		...overrides,
	};
}

function build(value: SubmissionInput): Submission {
	let n = 0;
	const result = buildSubmission(value, () => `key-${++n}`);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return result.submission;
}

describe("buildSubmission", () => {
	it("builds the report and screenshot metadata from the form and page, stripped and validated", () => {
		const submission = build(input());
		expect(submission.report).toEqual({
			title: "Average order value is wrong",
			description: "The dashboard shows $12.40.",
			expected_behavior: "$24.80",
			steps: ["Open /dashboard", "Read Average order value"],
			severity: "high",
			repository_id: REPO,
			affected_url: "https://shop.example/dashboard",
			environment: {
				browser: "Google Chrome 141.0.7390.55",
				os: "Windows 19.0.0",
				user_agent:
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0",
				viewport: { width: 1280, height: 720 },
			},
			logs: [{ kind: "log_file", content: expect.any(String) }],
		});
		expect(submission.screenshot).toEqual({
			bytes: PNG,
			meta: {
				kind: "screenshot",
				captured_at: "2026-10-25T10:00:00.000Z",
				page_url: "https://shop.example/dashboard",
				page_title: "Dashboard · Shop",
				viewport: { width: 1280, height: 720 },
				device_pixel_ratio: 2,
				client_redactions: [REDACTED],
				client_annotations: [OUTLINED],
			},
		});
		expect(submission.investigation).toEqual({ repository_id: REPO });
		expect(submission.keys).toEqual({
			report: "key-1",
			screenshot: "key-2",
			investigation: "key-3",
		});
		// Nothing anywhere in the payload keeps the page's query string, fragment, or the console secret.
		const sent = JSON.stringify([
			submission.report,
			submission.screenshot.meta,
		]);
		expect(sent).not.toMatch(/session=abc123|#orders|v=3|abcd1234efgh/);
	});

	it("leaves out what the user left empty or declined", () => {
		const submission = build(
			input({
				expected: "",
				steps: "",
				severity: "",
				repository_id: "",
				include_title: false,
				include_console: false,
			}),
		);
		expect(Object.keys(submission.report).sort()).toEqual([
			"affected_url",
			"description",
			"environment",
			"title",
		]);
		expect(submission.screenshot.meta).not.toHaveProperty("page_title");
		expect(submission.investigation).toBeNull();
	});

	it("starts no investigation when the token cannot, and drops non-web addresses", () => {
		const submission = build(
			input(
				{},
				{
					can_investigate: false,
					page: {
						url: "chrome-extension://abc/editor.html",
						title: null,
						viewport: null,
						device_pixel_ratio: null,
					},
				},
			),
		);
		expect(submission.investigation).toBeNull();
		expect(submission.report).not.toHaveProperty("affected_url");
		expect(submission.screenshot.meta).toEqual({
			kind: "screenshot",
			captured_at: "2026-10-25T10:00:00.000Z",
			client_redactions: [REDACTED],
			client_annotations: [OUTLINED],
		});
	});

	it("reports field errors from the shared contract schema and the 10 MB image limit", () => {
		const result = buildSubmission(
			input(
				{ title: " ", description: "", expected: "x".repeat(5001) },
				{
					screenshot: {
						bytes: new Uint8Array(10 * 1024 * 1024 + 1),
						marks: [],
					},
				},
			),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.map((error) => error.field).sort()).toEqual([
			"description",
			"expected",
			"screenshot",
			"title",
		]);
	});
});

describe("page-reported text", () => {
	it.each([
		[
			"Authorization: Bearer abcdefghijklmnopqrstuv",
			"Authorization: Bearer [REDACTED]",
		],
		[
			"authorization=Basic dXNlcjpwYXNzd29yZA==",
			"authorization=Basic [REDACTED]",
		],
		[
			"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
			"jwt [REDACTED:jwt]",
		],
		[`pat ${TOKEN}`, "pat [REDACTED:tracera_token]"],
		["password=hunter2hunter2 ok", "password=[REDACTED] ok"],
		[
			"GET https://api.shop.example/v1/orders?key=secret#x failed",
			"GET https://api.shop.example/v1/orders failed",
		],
		["https://alice:pw@db.example/x", "https://[REDACTED]@db.example/x"],
		["user alice@example.com not found", "user [REDACTED:email] not found"],
		["plain message", "plain message"],
	])("scrubs %j", (text, expected) => {
		expect(scrubSecrets(text)).toBe(expected);
	});

	it("labels console messages as page-reported and stays within the API's 200 KB log limit", () => {
		const capture = input().console;
		if (!capture) throw new Error("fixture");
		const text = formatConsole(capture);
		expect(text).toContain("Page-reported and unverified");
		expect(text).toContain(
			"[error] TypeError: total is undefined; token=[REDACTED]",
		);
		expect(text).toContain("(at https://shop.example/app.js)");
		const huge = formatConsole({
			...capture,
			entries: Array.from({ length: 200 }, () => ({
				level: "warning" as const,
				message: "w".repeat(2000),
				source: null,
				at: "2026-10-25T09:59:30.000Z",
			})),
		});
		expect(huge.length).toBeLessThanOrEqual(200_000);
		expect(huge.endsWith("[truncated by the extension]")).toBe(true);
	});

	it("parses steps one per line without list markers", () => {
		expect(parseSteps("1) Open\n  2. Click Save \n* Wait\n\n• Done")).toEqual([
			"Open",
			"Click Save",
			"Wait",
			"Done",
		]);
	});

	it("strips query strings and fragments and refuses non-web URLs", () => {
		expect(stripUrl("https://a.example/p/q?x=1#y")).toBe(
			"https://a.example/p/q",
		);
		expect(stripUrl("file:///C:/secret.html")).toBeNull();
		expect(stripUrl("not a url")).toBeNull();
	});
});

/** The API as the extension sees it, with a route per request. */
function fakeApi(route: (call: Call) => Response) {
	const { fetch, calls } = fakeFetch(route);
	return {
		api: createApiClient({
			apiUrl: "http://127.0.0.1:8787",
			token: TOKEN,
			fetch,
		}),
		calls,
	};
}

const investigationView = (id: string, status = "queued") => ({
	id,
	status,
	state_version: 0,
	current_stage: null,
	mode: "full",
	progress: { stage_index: 0, stage_count: 10, message: "Queued" },
	inference: { provider: "mock", mock: true },
	failure: null,
	latest_verification: null,
});

const happyRoute = (call: Call) => {
	const path = new URL(call.url).pathname;
	if (path === "/api/v1/bug-reports")
		return json(201, { bug_report: { id: BUG, status: "open" } });
	if (path === `/api/v1/bug-reports/${BUG}/evidence`)
		return json(201, {
			evidence: { id: EVD, mime_type: "image/png", size_bytes: PNG.length },
		});
	if (path === "/api/v1/investigations")
		return json(202, { investigation: investigationView(INV) });
	return problem(404, "not_found", "No route");
};

describe("submit", () => {
	it("sends exactly what the preview shows, and the only image sent is the rendered one", async () => {
		const submission = build(input());
		const preview = previewRequests(submission);
		const { api, calls } = fakeApi(happyRoute);
		const progress = await submit(api, submission, NO_PROGRESS, () => {});

		expect(
			calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`),
		).toEqual(
			preview.map(
				(request) =>
					`${request.method} ${request.path.replace(BUG_REPORT_ID, BUG)}`,
			),
		);
		const [report, upload, investigation] = calls;
		expect(JSON.parse(String(report?.init.body))).toEqual(preview[0]?.body);
		const form = upload?.init.body as FormData;
		const previewUpload = preview[1]?.body as {
			meta: unknown;
			file: { name: string; type: string; size_bytes: number };
		};
		expect(JSON.parse(String(form.get("meta")))).toEqual(previewUpload.meta);
		const file = form.get("file") as File;
		expect({ name: file.name, type: file.type, size_bytes: file.size }).toEqual(
			previewUpload.file,
		);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
		expect(JSON.parse(String(investigation?.init.body))).toEqual({
			...(preview[2]?.body as object),
			bug_report_id: BUG,
		});
		expect(
			calls.map(
				(call) =>
					(call.init.headers as Record<string, string>)["idempotency-key"],
			),
		).toEqual(["key-1", "key-2", "key-3"]);
		expect(progress).toMatchObject({
			bug_report_id: BUG,
			evidence_id: EVD,
			investigation: { id: INV, status: "queued" },
		});
	});

	it("resumes after a failure without repeating completed steps, using the same keys", async () => {
		const submission = build(input());
		let uploadAttempts = 0;
		const { api, calls } = fakeApi((call) => {
			if (call.url.endsWith("/evidence") && ++uploadAttempts === 1)
				return problem(500, "internal_error", "boom");
			return happyRoute(call);
		});
		let saved: Progress = NO_PROGRESS;
		await expect(
			submit(api, submission, NO_PROGRESS, (progress) => {
				saved = progress;
			}),
		).rejects.toMatchObject({ status: 500 });
		expect(saved).toEqual({
			bug_report_id: BUG,
			evidence_id: null,
			investigation: null,
		});

		const done = await submit(api, submission, saved, () => {});
		expect(done.evidence_id).toBe(EVD);
		const paths = calls.map((call) => new URL(call.url).pathname);
		expect(paths.filter((path) => path === "/api/v1/bug-reports")).toHaveLength(
			1,
		);
		expect(
			calls
				.filter((call) => call.url.endsWith("/evidence"))
				.map(
					(call) =>
						(call.init.headers as Record<string, string>)["idempotency-key"],
				),
		).toEqual(["key-2", "key-2"]);
	});

	it("follows an investigation that is already active instead of failing", async () => {
		const submission = build(input());
		const { api, calls } = fakeApi((call) => {
			const path = new URL(call.url).pathname;
			if (path === "/api/v1/investigations")
				return problem(409, "investigation_active", "Already active", {
					investigation_id: OTHER_INV,
				});
			if (path === `/api/v1/investigations/${OTHER_INV}`)
				return json(200, {
					investigation: investigationView(OTHER_INV, "running"),
				});
			return happyRoute(call);
		});
		const progress = await submit(api, submission, NO_PROGRESS, () => {});
		expect(progress.investigation).toMatchObject({
			id: OTHER_INV,
			status: "running",
		});
		expect(calls.at(-1)?.init.method).toBe("GET");
	});

	it("creates only the report and screenshot when no investigation is requested", async () => {
		const submission = build(input({ repository_id: "" }));
		const { api, calls } = fakeApi(happyRoute);
		const progress = await submit(api, submission, NO_PROGRESS, () => {});
		expect(calls).toHaveLength(2);
		expect(progress.investigation).toBeNull();
	});
});
