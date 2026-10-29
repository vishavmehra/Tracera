import type { ProviderMeeting } from "@tracera/contracts";
import { z } from "zod";
import { AppError } from "../lib/http.ts";
import {
	assembleTranscript,
	MAX_SEGMENTS,
	type ParsedTranscript,
} from "./meeting-parse.ts";

// Google Meet adapter: it only fetches artifacts and maps them to the shared transcript
// shape. Endpoints are constants; user input reaches a URL only as a validated resource name.
// Follows the Meet REST API reference (conferenceRecords, transcripts, transcripts.entries,
// participants) and Google's OAuth web-server flow.

export const GOOGLE_AUTHORIZE_URL =
	"https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const MEET_API_BASE = "https://meet.googleapis.com/v2/";
/** Read access to Meet artifacts of conferences the user organized or joined (a sensitive scope). */
export const MEET_SCOPE =
	"https://www.googleapis.com/auth/meetings.space.readonly";

export type GoogleClient = {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
};
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
/** Looked up at call time so tests can stub the global fetch. */
export const defaultFetch: FetchLike = (url, init) =>
	globalThis.fetch(url, init);

const REQUEST_TIMEOUT_MS = 15_000;
const CONFERENCES_PER_LISTING = 20;
const MAX_PARTICIPANTS = 5000;
const CONFERENCE_NAME = /^conferenceRecords\/[A-Za-z0-9_-]{1,200}$/;
const TRANSCRIPT_NAME =
	/^conferenceRecords\/[A-Za-z0-9_-]{1,200}\/transcripts\/[A-Za-z0-9_-]{1,200}$/;

// Provider responses are untrusted input: parsed, never passed through.
const TokenResponseSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().int().positive().optional(),
	refresh_token: z.string().min(1).optional(),
	scope: z.string().optional(),
});
const TokenErrorSchema = z.object({ error: z.string() });
const ConferenceSchema = z.object({
	name: z.string().regex(CONFERENCE_NAME),
	startTime: z.string().optional(),
	endTime: z.string().optional(),
	expireTime: z.string().optional(),
});
const TranscriptSchema = z.object({
	name: z.string().regex(TRANSCRIPT_NAME),
	state: z.string().default("STATE_UNSPECIFIED"),
	startTime: z.string().optional(),
	endTime: z.string().optional(),
});
const EntrySchema = z.object({
	participant: z.string().optional(),
	text: z.string().default(""),
	startTime: z.string().optional(),
	endTime: z.string().optional(),
});
const ParticipantSchema = z.object({
	name: z.string(),
	signedinUser: z.object({ displayName: z.string().optional() }).optional(),
	anonymousUser: z.object({ displayName: z.string().optional() }).optional(),
	phoneUser: z.object({ displayName: z.string().optional() }).optional(),
});
const nextPageToken = z.string().optional();
const ConferencePage = z.object({
	conferenceRecords: z.array(ConferenceSchema).default([]),
	nextPageToken,
});
const TranscriptPage = z.object({
	transcripts: z.array(TranscriptSchema).default([]),
	nextPageToken,
});
const EntryPage = z.object({
	transcriptEntries: z.array(EntrySchema).default([]),
	nextPageToken,
});
const ParticipantPage = z.object({
	participants: z.array(ParticipantSchema).default([]),
	nextPageToken,
});

export type GoogleTokens = {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: Date | null;
	scopes: string[];
};

/** RFC 3339 with up to nanoseconds → epoch ms (fractions beyond milliseconds are dropped). */
function epochMs(value: string | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
	return Number.isNaN(ms) ? null : ms;
}
const isoOrNull = (value: string | undefined) => {
	const ms = epochMs(value);
	return ms === null ? null : new Date(ms).toISOString();
};

/** Status codes from Google become stable Tracera codes; Google's response text is never echoed. */
function providerError(status: number): AppError {
	if (status === 401)
		return new AppError(
			409,
			"provider_token_expired",
			"Google no longer accepts this connection; reconnect your Google account",
		);
	if (status === 403)
		return new AppError(
			409,
			"provider_permission_denied",
			"Google refused access: the account needs a Workspace edition with Meet transcripts, and an administrator may block this app",
		);
	if (status === 404)
		return new AppError(
			404,
			"provider_artifact_unavailable",
			"Google has no such conference or transcript, or it expired (Meet keeps transcript entries for 30 days)",
		);
	if (status === 429 || status >= 500)
		return new AppError(
			503,
			"provider_unavailable",
			"Google is unavailable or rate-limited; try again later",
		);
	return new AppError(
		502,
		"provider_request_failed",
		`Google refused the request (HTTP ${status})`,
	);
}

async function send(
	fetchImpl: FetchLike,
	url: string,
	init: RequestInit,
): Promise<{ status: number; ok: boolean; json: unknown }> {
	let response: Response;
	try {
		// No redirects: a token must never follow a response to another host.
		response = await fetchImpl(url, {
			...init,
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		throw new AppError(
			503,
			"provider_unavailable",
			"Google did not answer; try again later",
		);
	}
	const json = await response.json().catch(() => null);
	return { status: response.status, ok: response.ok, json };
}

function parsed<T>(schema: z.ZodType<T>, json: unknown): T {
	const result = schema.safeParse(json);
	if (!result.success)
		throw new AppError(
			502,
			"provider_response_invalid",
			"Google returned an unexpected response",
		);
	return result.data;
}

async function meetGet<T>(
	fetchImpl: FetchLike,
	accessToken: string,
	resource: string,
	query: Record<string, string>,
	schema: z.ZodType<T>,
): Promise<T> {
	const url = new URL(resource, MEET_API_BASE);
	if (
		url.origin !== "https://meet.googleapis.com" ||
		!url.pathname.startsWith("/v2/")
	)
		throw new AppError(422, "validation_failed", "Invalid Meet resource name");
	for (const [key, value] of Object.entries(query))
		url.searchParams.set(key, value);
	const response = await send(fetchImpl, url.toString(), {
		headers: {
			authorization: `Bearer ${accessToken}`,
			accept: "application/json",
		},
	});
	if (!response.ok) throw providerError(response.status);
	return parsed(schema, response.json);
}

// ---- OAuth (authorization code with PKCE; offline access for a refresh token) -----------------

export function authorizationUrl(
	client: GoogleClient,
	input: { state: string; codeChallenge: string },
): string {
	const url = new URL(GOOGLE_AUTHORIZE_URL);
	url.search = new URLSearchParams({
		client_id: client.clientId,
		redirect_uri: client.redirectUri,
		response_type: "code",
		scope: MEET_SCOPE,
		access_type: "offline",
		prompt: "consent",
		state: input.state,
		code_challenge: input.codeChallenge,
		code_challenge_method: "S256",
	}).toString();
	return url.toString();
}

async function tokenRequest(
	fetchImpl: FetchLike,
	form: Record<string, string>,
): Promise<GoogleTokens> {
	const response = await send(fetchImpl, GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams(form).toString(),
	});
	if (!response.ok) {
		if (
			TokenErrorSchema.safeParse(response.json).data?.error === "invalid_grant"
		)
			throw new AppError(
				409,
				"provider_token_expired",
				"Google refused the authorization (expired or revoked); reconnect your Google account",
			);
		throw providerError(response.status);
	}
	const tokens = parsed(TokenResponseSchema, response.json);
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token ?? null,
		expiresAt: tokens.expires_in
			? new Date(Date.now() + tokens.expires_in * 1000)
			: null,
		scopes: (tokens.scope ?? "").split(" ").filter(Boolean),
	};
}

export const exchangeCode = (
	client: GoogleClient,
	code: string,
	codeVerifier: string,
	fetchImpl: FetchLike = defaultFetch,
) =>
	tokenRequest(fetchImpl, {
		grant_type: "authorization_code",
		code,
		code_verifier: codeVerifier,
		client_id: client.clientId,
		client_secret: client.clientSecret,
		redirect_uri: client.redirectUri,
	});

export const refreshAccessToken = (
	client: GoogleClient,
	refreshToken: string,
	fetchImpl: FetchLike = defaultFetch,
) =>
	tokenRequest(fetchImpl, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: client.clientId,
		client_secret: client.clientSecret,
	});

/** Best effort: revoking the refresh token also revokes its access tokens. */
export async function revokeToken(
	token: string,
	fetchImpl: FetchLike = defaultFetch,
): Promise<boolean> {
	const response = await send(fetchImpl, GOOGLE_REVOKE_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token }).toString(),
	}).catch(() => null);
	return response?.ok ?? false;
}

// ---- Meet REST v2 -----------------------------------------------------------------------------

/** Runs at most `limit` calls at a time, keeping the order of `items`. */
async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	const lane = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, lane),
	);
	return results;
}

/** Recent conferences (newest first, as the API sorts them) with their transcripts. */
export async function listConferences(
	accessToken: string,
	fetchImpl: FetchLike = defaultFetch,
): Promise<ProviderMeeting[]> {
	const conferences = await meetGet(
		fetchImpl,
		accessToken,
		"conferenceRecords",
		{ pageSize: String(CONFERENCES_PER_LISTING) },
		ConferencePage,
	);
	return mapLimit(conferences.conferenceRecords, 4, async (conference) => {
		const transcripts = await meetGet(
			fetchImpl,
			accessToken,
			`${conference.name}/transcripts`,
			{ pageSize: "100" },
			TranscriptPage,
		);
		return {
			conference_ref: conference.name,
			started_at: isoOrNull(conference.startTime),
			ended_at: isoOrNull(conference.endTime),
			expires_at: isoOrNull(conference.expireTime),
			transcripts: transcripts.transcripts.map((transcript) => ({
				provider_meeting_ref: transcript.name,
				state: transcript.state,
				started_at: isoOrNull(transcript.startTime),
				ended_at: isoOrNull(transcript.endTime),
				importable:
					transcript.state === "ENDED" || transcript.state === "FILE_GENERATED",
			})),
		};
	});
}

export type MeetTranscriptArtifact = {
	transcript: z.infer<typeof TranscriptSchema>;
	participants: Array<{ name: string; display_name: string | null }>;
	entries: Array<z.infer<typeof EntrySchema>>;
};

async function allPages<T>(
	load: (
		pageToken: string | undefined,
	) => Promise<{ items: T[]; next?: string | undefined }>,
	max: number,
	onOverflow: () => never,
): Promise<T[]> {
	const items: T[] = [];
	let token: string | undefined;
	do {
		const page = await load(token);
		items.push(...page.items);
		if (items.length > max) onOverflow();
		token = page.next;
	} while (token);
	return items;
}

/** One transcript's entries and the conference's participants (for speaker names). */
export async function fetchMeetTranscript(
	accessToken: string,
	transcriptRef: string,
	fetchImpl: FetchLike = defaultFetch,
): Promise<MeetTranscriptArtifact> {
	if (!TRANSCRIPT_NAME.test(transcriptRef))
		throw new AppError(
			422,
			"validation_failed",
			"Expected conferenceRecords/{id}/transcripts/{id}",
		);
	const conferenceRef = transcriptRef.slice(
		0,
		transcriptRef.indexOf("/transcripts/"),
	);
	const get = <T>(
		resource: string,
		query: Record<string, string>,
		schema: z.ZodType<T>,
	) => meetGet(fetchImpl, accessToken, resource, query, schema);
	const transcript = await get(transcriptRef, {}, TranscriptSchema);
	const entries = await allPages(
		async (pageToken) => {
			const page = await get(
				`${transcriptRef}/entries`,
				{ pageSize: "100", ...(pageToken ? { pageToken } : {}) },
				EntryPage,
			);
			return { items: page.transcriptEntries, next: page.nextPageToken };
		},
		MAX_SEGMENTS,
		() => {
			throw new AppError(
				422,
				"transcript_too_many_segments",
				`The transcript has more than ${MAX_SEGMENTS} entries`,
			);
		},
	);
	// Speaker names are a convenience: beyond the cap, unnamed speakers get "Participant n".
	const participants: Array<z.infer<typeof ParticipantSchema>> = [];
	let pageToken: string | undefined;
	do {
		const page = await get(
			`${conferenceRef}/participants`,
			{ pageSize: "250", ...(pageToken ? { pageToken } : {}) },
			ParticipantPage,
		);
		participants.push(...page.participants);
		pageToken = page.nextPageToken;
	} while (pageToken && participants.length < MAX_PARTICIPANTS);
	return {
		transcript,
		participants: participants.map((p) => ({
			name: p.name,
			display_name:
				p.signedinUser?.displayName ??
				p.anonymousUser?.displayName ??
				p.phoneUser?.displayName ??
				null,
		})),
		entries,
	};
}

/** Maps Meet transcript entries into the shared transcript shape (times relative to its start). */
export function meetTranscriptToSegments(
	artifact: MeetTranscriptArtifact,
): ParsedTranscript {
	const names = new Map(
		artifact.participants.map((p) => [p.name, p.display_name] as const),
	);
	const unnamed = new Map<string, string>();
	const speaker = (participant: string | undefined) => {
		if (!participant) return null;
		const name = names.get(participant);
		if (name) return name;
		if (!unnamed.has(participant))
			unnamed.set(participant, `Participant ${unnamed.size + 1}`);
		return unnamed.get(participant) ?? null;
	};
	const origin =
		epochMs(artifact.transcript.startTime) ??
		epochMs(artifact.entries[0]?.startTime);
	const offset = (time: string | undefined) => {
		const ms = epochMs(time);
		return ms === null || origin === null ? null : Math.max(0, ms - origin);
	};
	return assembleTranscript(
		"meet_entries",
		origin === null ? "none" : "exact",
		artifact.entries.map((entry) => ({
			speaker: speaker(entry.participant),
			startMs: offset(entry.startTime),
			endMs: offset(entry.endTime),
			text: entry.text,
		})),
		unnamed.size > 0
			? [
					`${unnamed.size} speaker(s) had no participant name and are labelled Participant n`,
				]
			: [],
	);
}
