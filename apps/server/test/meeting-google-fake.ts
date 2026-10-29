import { readFileSync } from "node:fs";
import type { FetchLike } from "../src/modules/meeting-google.ts";

/** Recorded synthetic Meet REST v2 and OAuth responses (fixtures/meetings/meet-rest-v2.json). */
export const MEET = JSON.parse(
	readFileSync(
		new URL("./fixtures/meetings/meet-rest-v2.json", import.meta.url),
		"utf8",
	),
) as Record<string, unknown>;

export type GoogleCall = {
	method: string;
	url: URL;
	headers: Headers;
	body: string | null;
	redirect: RequestInit["redirect"];
	hasSignal: boolean;
};

/**
 * A fake of Google's OAuth and Meet endpoints. Routes are "METHOD path" (Meet) or "METHOD origin+path"
 * (OAuth; the token endpoint adds the grant type). Unknown routes answer 404 like Google.
 */
export function fakeGoogle(
	overrides: Record<string, { status: number; body: unknown }> = {},
) {
	const calls: GoogleCall[] = [];
	const routes: Record<string, unknown> = {
		"POST https://oauth2.googleapis.com/token authorization_code": MEET.token,
		"POST https://oauth2.googleapis.com/token refresh_token": MEET.refreshed,
		"POST https://oauth2.googleapis.com/revoke": {},
		"GET /v2/conferenceRecords": MEET.conferenceRecords,
		"GET /v2/conferenceRecords/abc-123/transcripts":
			MEET["transcripts:abc-123"],
		"GET /v2/conferenceRecords/def-456/transcripts":
			MEET["transcripts:def-456"],
		"GET /v2/conferenceRecords/abc-123/transcripts/tr-1":
			MEET["transcript:tr-1"],
		"GET /v2/conferenceRecords/abc-123/transcripts/tr-1/entries":
			MEET["entries:page1"],
		"GET /v2/conferenceRecords/abc-123/transcripts/tr-1/entries?pageToken=page-2":
			MEET["entries:page2"],
		"GET /v2/conferenceRecords/abc-123/participants": MEET.participants,
	};
	const fetchImpl: FetchLike = async (raw, init) => {
		const url = new URL(raw);
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? init.body : null;
		calls.push({
			method,
			url,
			headers: new Headers(init.headers),
			body,
			redirect: init.redirect,
			hasSignal: init.signal instanceof AbortSignal,
		});
		const page = url.searchParams.get("pageToken");
		const key =
			url.host === "meet.googleapis.com"
				? `${method} ${url.pathname}${page ? `?pageToken=${page}` : ""}`
				: `${method} ${url.origin}${url.pathname}${
						url.pathname === "/token"
							? ` ${new URLSearchParams(body ?? "").get("grant_type")}`
							: ""
					}`;
		const override = overrides[key];
		if (override)
			return Response.json(override.body, { status: override.status });
		if (!(key in routes))
			return Response.json(
				{ error: { code: 404, status: "NOT_FOUND" } },
				{ status: 404 },
			);
		return Response.json(routes[key]);
	};
	return { fetchImpl, calls };
}
