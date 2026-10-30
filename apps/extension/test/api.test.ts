import { describe, expect, it } from "vitest";
import { ApiError, createApiClient } from "../src/api.ts";
import { type Call, fakeFetch, json, problem, TOKEN, ULID } from "./fakes.ts";

const BUG = `bug_${ULID}`;
const INV = `inv_${ULID}`;

const investigation = {
	id: INV,
	status: "queued",
	state_version: 0,
	current_stage: null,
	mode: "full",
	progress: { stage_index: 0, stage_count: 10, message: "Queued" },
	inference: { provider: "mock", mock: true },
	failure: null,
	latest_verification: null,
	extra_field: "ignored",
};

function client(answer: (call: Call) => Response | Promise<Response>) {
	const fake = fakeFetch(answer);
	return {
		api: createApiClient({
			apiUrl: "http://127.0.0.1:8787/",
			token: TOKEN,
			fetch: fake.fetch,
		}),
		calls: fake.calls,
	};
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ApiError);
	return error as ApiError;
}

describe("requests", () => {
	it("sends only the bearer token: no cookies, no redirects, an idempotency key on creates", async () => {
		const { api, calls } = client(() =>
			json(201, { bug_report: { id: BUG, status: "open" } }),
		);
		await api.createBugReport({ title: "t", description: "d" }, "key-1");
		const [call] = calls;
		expect(call?.url).toBe("http://127.0.0.1:8787/api/v1/bug-reports");
		expect(call?.init).toMatchObject({
			method: "POST",
			credentials: "omit",
			redirect: "error",
			cache: "no-store",
			body: JSON.stringify({ title: "t", description: "d" }),
		});
		expect(call?.init.headers).toEqual({
			accept: "application/json",
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
			"idempotency-key": "key-1",
		});
	});

	it("uploads the screenshot as multipart with a PNG file part and a JSON meta part", async () => {
		const { api, calls } = client(() =>
			json(201, {
				evidence: { id: `evd_${ULID}`, mime_type: "image/png", size_bytes: 3 },
			}),
		);
		const meta = {
			kind: "screenshot" as const,
			page_url: "https://shop.example/a",
		};
		await api.uploadScreenshot(
			BUG,
			{ bytes: new Uint8Array([1, 2, 3]), meta },
			"key-2",
		);
		const [call] = calls;
		expect(call?.url).toBe(
			`http://127.0.0.1:8787/api/v1/bug-reports/${BUG}/evidence`,
		);
		const form = call?.init.body as FormData;
		expect(JSON.parse(String(form.get("meta")))).toEqual(meta);
		const file = form.get("file") as File;
		expect(file.type).toBe("image/png");
		expect(file.name).toBe("screenshot.png");
		expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
		expect(call?.init.headers).not.toHaveProperty("content-type"); // the browser sets the boundary
	});

	it("long-polls an investigation with the known state version", async () => {
		const { api, calls } = client(() => json(200, { investigation }));
		const view = await api.investigation(INV, 3);
		expect(calls[0]?.url).toBe(
			`http://127.0.0.1:8787/api/v1/investigations/${INV}?wait_seconds=20&known_version=3`,
		);
		expect(view).toMatchObject({
			id: INV,
			status: "queued",
			inference: { mock: true },
		});
		expect(view).not.toHaveProperty("extra_field");
	});
});

describe("error states", () => {
	it("reports an unreachable API (network failure)", async () => {
		const { api } = client(() => {
			throw new TypeError("Failed to fetch");
		});
		const error = await failure(api.me());
		expect(error).toMatchObject({ status: 0, code: "network_error" });
		expect(error.message).toContain(
			"Could not reach Tracera at http://127.0.0.1:8787",
		);
	});

	it("reports a timeout", async () => {
		const { api } = client(() => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		expect(await failure(api.me())).toMatchObject({
			status: 0,
			code: "timeout",
		});
	});

	it.each([
		[401, "unauthenticated", "Sign in", /invalid, expired, or revoked/],
		[
			403,
			"insufficient_scope",
			"This token lacks the investigations:write scope",
			/lacks the investigations:write scope\. Create a token/,
		],
		[
			403,
			"session_required",
			"This operation requires a signed-in user session",
			/signed-in user session/,
		],
		[404, "not_found", "Bug report x was not found", /was not found/],
		[
			413,
			"payload_too_large",
			"The request body is too large",
			/larger than Tracera accepts \(10 MB\)/,
		],
		[
			415,
			"unsupported_media_type",
			"Only PNG, JPEG, and WebP images are accepted",
			/Only PNG/,
		],
		[
			422,
			"repository_required",
			"A repository is required",
			/repository is required/,
		],
		[500, "internal_error", "boom", /internal problem/],
	])("%i %s", async (status, code, detail, message) => {
		const { api } = client(() => problem(status, code, detail));
		const error = await failure(api.me());
		expect(error).toMatchObject({ status, code, requestId: "req-1" });
		expect(error.message).toMatch(message);
	});

	it("reports rate limiting with the wait from retry-after", async () => {
		const limited = client(() =>
			problem(429, "rate_limited", "Too many", {}, { "retry-after": "17" }),
		);
		const error = await failure(limited.api.me());
		expect(error).toMatchObject({
			status: 429,
			code: "rate_limited",
			retryAfterSeconds: 17,
		});
		expect(error.message).toContain("try again in 17 s");
		const unspecified = client(() => problem(429, "rate_limited", "Too many"));
		expect((await failure(unspecified.api.me())).retryAfterSeconds).toBeNull();
	});

	it("passes server validation errors through by path", async () => {
		const { api } = client(() =>
			problem(400, "validation_failed", "The request is invalid", {
				errors: [{ path: "title", message: "Too big" }],
			}),
		);
		const error = await failure(
			api.createBugReport({ title: "t", description: "d" }, "k"),
		);
		expect(error.fieldErrors).toEqual([{ path: "title", message: "Too big" }]);
	});

	it("keeps the existing investigation ID from an investigation_active conflict", async () => {
		const { api } = client(() =>
			problem(409, "investigation_active", "Already running", {
				investigation_id: INV,
			}),
		);
		const error = await failure(
			api.startInvestigation({ bug_report_id: BUG }, "k"),
		);
		expect(error).toMatchObject({
			code: "investigation_active",
			investigationId: INV,
		});
	});

	it("survives an error without problem details and refuses an unexpected success body", async () => {
		const { api } = client(
			() => new Response("<html>Bad gateway</html>", { status: 502 }),
		);
		expect(await failure(api.me())).toMatchObject({
			status: 502,
			code: "http_502",
		});
		const odd = client(() =>
			json(200, { bug_report: { id: "../../admin", status: "open" } }),
		);
		expect(
			await failure(
				odd.api.createBugReport({ title: "t", description: "d" }, "k"),
			),
		).toMatchObject({ code: "unexpected_response" });
	});
});
