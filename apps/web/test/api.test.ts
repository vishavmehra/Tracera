import { describe, expect, it, vi } from "vitest";
import {
	ApiError,
	getSession,
	isSignedOut,
	listRepositories,
	signIn,
	signOut,
} from "../src/api.ts";
import {
	json,
	problem,
	repository,
	session,
	signedIn,
	stubApi,
} from "./support.tsx";

const credentials = { email: "owner@example.com", password: "correct horse" };

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	if (!(error instanceof ApiError))
		throw new Error(`Expected an ApiError, got ${String(error)}`);
	return error;
}

describe("API client", () => {
	it("reads with the session cookie and without the CSRF header", async () => {
		const calls = stubApi({ "GET /api/v1/auth/me": json(session()) });
		const result = await getSession();
		expect(result.workspace.role).toBe("owner");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.credentials).toBe("same-origin");
		expect(calls[0]?.headers["x-tracera-csrf"]).toBeUndefined();
	});

	it("sends the CSRF header and a JSON body on sign-in", async () => {
		const calls = stubApi({ "POST /api/v1/auth/login": json(signedIn()) });
		await signIn(credentials);
		expect(calls[0]?.headers).toMatchObject({
			"x-tracera-csrf": "1",
			"content-type": "application/json",
		});
		expect(calls[0]?.body).toEqual(credentials);
		expect(calls[0]?.credentials).toBe("same-origin");
	});

	it("signs out with the CSRF header, no body, and a 204 answer", async () => {
		const calls = stubApi({
			"POST /api/v1/auth/logout": new Response(null, { status: 204 }),
		});
		await expect(signOut()).resolves.toBeUndefined();
		expect(calls[0]?.headers["x-tracera-csrf"]).toBe("1");
		// Fastify rejects an empty body declared as JSON, so no content type is sent.
		expect(calls[0]?.headers["content-type"]).toBeUndefined();
	});

	it("surfaces problem+json errors with their code, detail, and request ID", async () => {
		stubApi({
			"POST /api/v1/auth/login": problem(
				403,
				"csrf_failed",
				"Cookie-authenticated changes require the X-Tracera-CSRF header and a same-origin request",
			),
		});
		const error = await rejection(signIn(credentials));
		expect(error.status).toBe(403);
		expect(error.code).toBe("csrf_failed");
		expect(error.message).toMatch(/same-origin request/);
		expect(error.problem?.request_id).toBe("req-test-1");
	});

	it("treats 401 as signed out, except for rejected credentials", async () => {
		stubApi({
			"GET /api/v1/auth/me": problem(401, "unauthenticated"),
			"POST /api/v1/auth/login": problem(401, "invalid_credentials"),
		});
		expect(isSignedOut(await rejection(getSession()))).toBe(true);
		expect(isSignedOut(await rejection(signIn(credentials)))).toBe(false);
	});

	it("reports an error without problem details as detected by the client", async () => {
		stubApi({
			"GET /api/v1/repositories": new Response("Bad gateway", { status: 502 }),
		});
		const error = await rejection(listRepositories());
		expect(error.status).toBe(502);
		expect(error.code).toBe("unexpected_response");
		expect(error.problem).toBeNull();
	});

	it("rejects a successful response with an unexpected shape instead of using it", async () => {
		stubApi({
			"GET /api/v1/repositories": json({
				items: [repository({ index: { status: "finished" } })],
				next_cursor: null,
			}),
		});
		const error = await rejection(listRepositories());
		expect(error.code).toBe("invalid_response");
		expect(error.message).toMatch(/items\.0\.index/);
		expect(error.problem).toBeNull();
	});

	it("rejects a successful response that is not JSON", async () => {
		stubApi({
			"GET /api/v1/repositories": new Response("<!doctype html>", {
				status: 200,
			}),
		});
		expect((await rejection(listRepositories())).code).toBe("invalid_response");
	});

	it("reports a network failure as status 0", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		const error = await rejection(getSession());
		expect(error.status).toBe(0);
		expect(error.code).toBe("network_error");
	});
});
