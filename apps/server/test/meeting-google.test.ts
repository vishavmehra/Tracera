import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { AppError } from "../src/lib/http.ts";
import {
	authorizationUrl,
	exchangeCode,
	fetchMeetTranscript,
	listConferences,
	MEET_SCOPE,
	meetTranscriptToSegments,
	refreshAccessToken,
} from "../src/modules/meeting-google.ts";
import { openSecret, sealSecret } from "../src/modules/meeting-integrations.ts";
import { fakeGoogle } from "./meeting-google-fake.ts";

const client = {
	clientId: "client-123.apps.googleusercontent.com",
	clientSecret: "synthetic-client-secret",
	redirectUri: "http://127.0.0.1:8787/api/v1/integrations/google/callback",
};

async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AppError)
			return { status: error.status, code: error.code };
		throw error;
	}
	throw new Error("expected a failure");
}

describe("Google OAuth", () => {
	it("builds a fixed authorization URL with PKCE, offline access, and only the Meet read scope", () => {
		const url = new URL(
			authorizationUrl(client, { state: "s1", codeChallenge: "c1" }),
		);
		expect(url.origin + url.pathname).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: client.clientId,
			redirect_uri: client.redirectUri,
			response_type: "code",
			scope: MEET_SCOPE,
			access_type: "offline",
			prompt: "consent",
			state: "s1",
			code_challenge: "c1",
			code_challenge_method: "S256",
		});
	});

	it("exchanges and refreshes tokens with fixed endpoints and maps refusals", async () => {
		const google = fakeGoogle();
		const tokens = await exchangeCode(
			client,
			"code-1",
			"verifier-1",
			google.fetchImpl,
		);
		expect(tokens).toMatchObject({
			accessToken: "ya29.synthetic-access-token",
			refreshToken: "1//synthetic-refresh-token",
			scopes: [MEET_SCOPE],
		});
		expect(tokens.expiresAt?.getTime()).toBeGreaterThan(Date.now());
		const sent = Object.fromEntries(
			new URLSearchParams(google.calls[0]?.body ?? ""),
		);
		expect(sent).toEqual({
			grant_type: "authorization_code",
			code: "code-1",
			code_verifier: "verifier-1",
			client_id: client.clientId,
			client_secret: client.clientSecret,
			redirect_uri: client.redirectUri,
		});
		expect(google.calls[0]).toMatchObject({
			redirect: "error",
			hasSignal: true,
		});
		expect(
			(await refreshAccessToken(client, "rt", google.fetchImpl)).refreshToken,
		).toBeNull();

		const revoked = fakeGoogle({
			"POST https://oauth2.googleapis.com/token refresh_token": {
				status: 400,
				body: {
					error: "invalid_grant",
					error_description: "Token has been expired or revoked.",
				},
			},
		});
		expect(
			await failure(refreshAccessToken(client, "rt", revoked.fetchImpl)),
		).toEqual({
			status: 409,
			code: "provider_token_expired",
		});
		const down = fakeGoogle({
			"POST https://oauth2.googleapis.com/token authorization_code": {
				status: 503,
				body: {},
			},
		});
		expect(
			await failure(exchangeCode(client, "c", "v", down.fetchImpl)),
		).toEqual({
			status: 503,
			code: "provider_unavailable",
		});
		const garbage = fakeGoogle({
			"POST https://oauth2.googleapis.com/token authorization_code": {
				status: 200,
				body: { token: "no access_token field" },
			},
		});
		expect(
			await failure(exchangeCode(client, "c", "v", garbage.fetchImpl)),
		).toEqual({
			status: 502,
			code: "provider_response_invalid",
		});
		const offline = async () => {
			throw new TypeError("fetch failed");
		};
		expect(await failure(exchangeCode(client, "c", "v", offline))).toEqual({
			status: 503,
			code: "provider_unavailable",
		});
	});
});

describe("Meet REST v2", () => {
	it("lists conferences with their transcripts using the bearer token", async () => {
		const google = fakeGoogle();
		const meetings = await listConferences("tok", google.fetchImpl);
		expect(meetings).toEqual([
			{
				conference_ref: "conferenceRecords/abc-123",
				started_at: "2026-10-20T14:00:00.123Z",
				ended_at: "2026-10-20T14:09:12.000Z",
				expires_at: "2026-11-19T14:09:12.000Z",
				transcripts: [
					{
						provider_meeting_ref: "conferenceRecords/abc-123/transcripts/tr-1",
						state: "FILE_GENERATED",
						started_at: "2026-10-20T14:00:05.000Z",
						ended_at: "2026-10-20T14:09:10.000Z",
						importable: true,
					},
				],
			},
			expect.objectContaining({
				conference_ref: "conferenceRecords/def-456",
				transcripts: [
					expect.objectContaining({ state: "STARTED", importable: false }),
				],
			}),
		]);
		expect(google.calls[0]?.url.searchParams.get("pageSize")).toBe("20");
		for (const call of google.calls) {
			expect(call.url.origin).toBe("https://meet.googleapis.com");
			expect(call.headers.get("authorization")).toBe("Bearer tok");
			expect(call.redirect).toBe("error");
		}
	});

	it("fetches every entry page and maps entries to segments with participant names", async () => {
		const google = fakeGoogle();
		const artifact = await fetchMeetTranscript(
			"tok",
			"conferenceRecords/abc-123/transcripts/tr-1",
			google.fetchImpl,
		);
		expect(artifact.entries).toHaveLength(4);
		const parsed = meetTranscriptToSegments(artifact);
		expect(parsed).toMatchObject({
			format: "meet_entries",
			timing: "exact",
			speakers: ["Priya Sharma", "Dana Cruz", "+1 555-0100", "Participant 1"],
			durationMs: 119_000,
			warnings: [
				"1 speaker(s) had no participant name and are labelled Participant n",
			],
		});
		expect(parsed.segments[0]).toEqual({
			index: 1,
			speaker: "Priya Sharma",
			startMs: 1500,
			endMs: 4000,
			text: "Thanks for joining the triage call.",
		});
		expect(google.calls.map((c) => c.url.pathname + c.url.search)).toEqual([
			"/v2/conferenceRecords/abc-123/transcripts/tr-1",
			"/v2/conferenceRecords/abc-123/transcripts/tr-1/entries?pageSize=100",
			"/v2/conferenceRecords/abc-123/transcripts/tr-1/entries?pageSize=100&pageToken=page-2",
			"/v2/conferenceRecords/abc-123/participants?pageSize=250",
		]);
	});

	it("maps Google's statuses to stable codes and never builds URLs from bad references", async () => {
		const ref = "conferenceRecords/abc-123/transcripts/tr-1";
		for (const [status, expected] of [
			[401, { status: 409, code: "provider_token_expired" }],
			[403, { status: 409, code: "provider_permission_denied" }],
			[404, { status: 404, code: "provider_artifact_unavailable" }],
			[429, { status: 503, code: "provider_unavailable" }],
		] as const) {
			const google = fakeGoogle({ [`GET /v2/${ref}`]: { status, body: {} } });
			expect(
				await failure(fetchMeetTranscript("tok", ref, google.fetchImpl)),
			).toEqual(expected);
		}
		const google = fakeGoogle();
		for (const bad of [
			"conferenceRecords/abc-123/transcripts/../../x",
			"https://evil.example/conferenceRecords/a/transcripts/b",
			"conferenceRecords/a",
		])
			expect(
				await failure(fetchMeetTranscript("tok", bad, google.fetchImpl)),
			).toEqual({
				status: 422,
				code: "validation_failed",
			});
		expect(google.calls).toHaveLength(0);
	});
});

describe("token sealing and configuration", () => {
	it("seals tokens with AES-256-GCM bound to the key and the row purpose", () => {
		const key = randomBytes(32);
		const sealed = sealSecret(key, "ya29.secret", "int_1:access");
		expect(sealed).not.toContain("ya29");
		expect(openSecret(key, sealed, "int_1:access")).toBe("ya29.secret");
		const [v, iv, tag, data = ""] = sealed.split(".");
		const flipped = `${data.slice(0, -2)}${data.endsWith("A") ? "B" : "A"}${data.slice(-1)}`;
		expect(() =>
			openSecret(key, [v, iv, tag, flipped].join("."), "int_1:access"),
		).toThrow();
		expect(() => openSecret(key, sealed, "int_2:access")).toThrow();
		expect(() => openSecret(randomBytes(32), sealed, "int_1:access")).toThrow();
	});

	it("reports a missing or partial Google setup as not configured and refuses malformed values", () => {
		const base = { DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db" };
		const key = randomBytes(32).toString("base64");
		const google = {
			GOOGLE_CLIENT_ID: client.clientId,
			GOOGLE_CLIENT_SECRET: client.clientSecret,
			GOOGLE_REDIRECT_URI: client.redirectUri,
		};
		expect(loadConfig(base).meetings).toMatchObject({
			google: null,
			googleMissing: [
				"GOOGLE_CLIENT_ID",
				"GOOGLE_CLIENT_SECRET",
				"GOOGLE_REDIRECT_URI",
				"TRACERA_ENCRYPTION_KEY",
			],
		});
		expect(loadConfig({ ...base, ...google }).meetings).toMatchObject({
			google: null,
			googleMissing: ["TRACERA_ENCRYPTION_KEY"],
		});
		const configured = loadConfig({
			...base,
			...google,
			TRACERA_ENCRYPTION_KEY: key,
		}).meetings;
		expect(configured.google).toEqual(client);
		expect(configured.encryptionKey?.length).toBe(32);
		expect(() =>
			loadConfig({ ...base, TRACERA_ENCRYPTION_KEY: "too-short" }),
		).toThrow(ConfigError);
		expect(() =>
			loadConfig({
				...base,
				GOOGLE_REDIRECT_URI: "http://127.0.0.1:8787/elsewhere",
			}),
		).toThrow(ConfigError);
		expect(
			loadConfig({ ...base, TRACERA_MODEL_MEETING: "m1" }).meetings.model,
		).toBe("m1");
	});
});
