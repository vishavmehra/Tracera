import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { integrationConnections } from "../src/db/schema.ts";
import {
	MEETING_EXTRACT_QUEUE,
	runMeetingExtraction,
} from "../src/modules/meeting-extract.ts";
import {
	addMember,
	asSession,
	createOwner,
	createTestContext,
	login,
	resetDatabase,
	scriptedProvider,
	type TestContext,
} from "./helpers.ts";
import { fakeGoogle } from "./meeting-google-fake.ts";

let ctx: TestContext;
let session: ReturnType<typeof asSession>;
let google: ReturnType<typeof fakeGoogle>;
const REF = "conferenceRecords/abc-123/transcripts/tr-1";

beforeAll(async () => {
	ctx = await createTestContext({
		GOOGLE_CLIENT_ID: "client-123.apps.googleusercontent.com",
		GOOGLE_CLIENT_SECRET: "synthetic-client-secret",
		GOOGLE_REDIRECT_URI:
			"http://127.0.0.1:8787/api/v1/integrations/google/callback",
		TRACERA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
	});
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
		MEETING_EXTRACT_QUEUE,
	]);
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
	google = fakeGoogle();
	vi.stubGlobal("fetch", google.fetchImpl);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

/** Connect → Google consent (simulated) → callback; returns the connection id. */
async function connect(as = session): Promise<string> {
	const start = await as("GET", "/api/v1/integrations/google/connect");
	expect(start.statusCode).toBe(302);
	const consent = new URL(String(start.headers.location));
	expect(consent.origin).toBe("https://accounts.google.com");
	const state = consent.searchParams.get("state") ?? "";
	const back = await as(
		"GET",
		`/api/v1/integrations/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
	);
	expect(back.statusCode).toBe(302);
	expect(back.headers.location).toBe(
		`${ctx.config.api.publicUrl}/meetings?integration=google&result=connected`,
	);
	const listed = (await as("GET", "/api/v1/integrations")).json().items[0];
	expect(listed).toMatchObject({
		provider: "google",
		availability: "available",
	});
	return listed.connection.id as string;
}

describe("Google Meet import (synthetic recorded responses)", () => {
	it("connects with state and PKCE and stores only sealed tokens", async () => {
		const forged = await session(
			"GET",
			"/api/v1/integrations/google/callback?code=x&state=forged",
		);
		expect(forged.headers.location).toMatch(/result=invalid_state$/);
		const id = await connect();
		const exchange = new URLSearchParams(google.calls[0]?.body ?? "");
		expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const [row] = await ctx.db
			.select()
			.from(integrationConnections)
			.where(eq(integrationConnections.id, id));
		expect(row).toMatchObject({
			status: "active",
			scopes: [expect.stringContaining("meetings.space.readonly")],
		});
		expect(JSON.stringify(row)).not.toMatch(/synthetic-(access|refresh)-token/);
		// A state works once.
		const replay = await session(
			"GET",
			`/api/v1/integrations/google/callback?code=auth-code&state=${new URL(String((await session("GET", "/api/v1/integrations/google/connect")).headers.location)).searchParams.get("state")}`,
		);
		expect(replay.headers.location).toMatch(/result=connected$/);
	});

	it("lists conferences and imports a transcript into the shared meeting engine", async () => {
		const id = await connect();
		const listed = await session("GET", `/api/v1/integrations/${id}/meetings`);
		expect(listed.statusCode).toBe(200);
		expect(listed.json().items[0].transcripts[0]).toMatchObject({
			provider_meeting_ref: REF,
			importable: true,
		});
		const unattested = await session(
			"POST",
			`/api/v1/integrations/${id}/import`,
			{
				provider_meeting_ref: REF,
			},
		);
		expect(unattested.json().code).toBe("consent_required");
		const imported = await session(
			"POST",
			`/api/v1/integrations/${id}/import`,
			{
				provider_meeting_ref: REF,
				consent_attested: true,
				title: "Checkout triage",
			},
		);
		expect(imported.statusCode, imported.body).toBe(202);
		const meeting = imported.json().meeting;
		expect(meeting).toMatchObject({
			provider: "google_meet",
			source: "provider_api",
			provider_ref: REF,
			occurred_at: "2026-10-20T14:00:05.000Z",
			transcript: {
				format: "meet_entries",
				timing: "exact",
				filename: null,
				content_type: "application/json",
				segment_count: 4,
			},
		});
		const segments = (
			await session("GET", `/api/v1/meetings/${meeting.id}/segments`)
		).json();
		expect(segments.items[1]).toMatchObject({
			speaker_label: "Dana Cruz",
			start_ms: 5000,
		});
		// Same extraction as an upload.
		const { rows } = await ctx.pool.query<{ id: string }>(
			"SELECT id FROM pgboss.job WHERE name = $1 AND data->>'meetingId' = $2",
			[MEETING_EXTRACT_QUEUE, meeting.id],
		);
		expect(rows).toHaveLength(1);
		await runMeetingExtraction(
			{
				db: ctx.db,
				pool: ctx.pool,
				config: ctx.config,
				provider: scriptedProvider({
					extract_meeting_bugs: {
						items: [
							{
								kind: "bug",
								title: "Checkout button cut off on small phones",
								description:
									"The order summary card overflows on small phones.",
								expected_behavior: null,
								actual_behavior: "The checkout button is cut off",
								steps: [],
								severity_suggestion: "unknown",
								affected_area: "cart",
								citations: [
									{ handle: "SEG-2", quote: "the checkout button is cut off" },
									{
										handle: "SEG-4",
										quote: "still cut off after the last deploy",
									},
								],
							},
						],
					},
				}),
			},
			meeting.id,
		);
		const candidates = (
			await session("GET", `/api/v1/meetings/${meeting.id}/candidates`)
		).json();
		expect(candidates.items[0]).toMatchObject({
			status: "pending_review",
			support: { status: "supported", citations_valid: 2 },
		});
		const again = await session("POST", `/api/v1/integrations/${id}/import`, {
			provider_meeting_ref: REF,
			consent_attested: true,
		});
		expect([again.statusCode, again.json().code]).toEqual([409, "conflict"]);
		// Only the fixed Google hosts were called.
		expect(new Set(google.calls.map((c) => c.url.host))).toEqual(
			new Set(["oauth2.googleapis.com", "meet.googleapis.com"]),
		);
	});

	it("refreshes an expired access token, and marks the connection expired when Google refuses", async () => {
		const id = await connect();
		await ctx.db
			.update(integrationConnections)
			.set({ accessTokenExpiresAt: new Date(0) })
			.where(eq(integrationConnections.id, id));
		expect(
			(await session("GET", `/api/v1/integrations/${id}/meetings`)).statusCode,
		).toBe(200);
		const refresh = google.calls.find((c) =>
			c.body?.includes("grant_type=refresh_token"),
		);
		expect(new URLSearchParams(refresh?.body ?? "").get("refresh_token")).toBe(
			"1//synthetic-refresh-token",
		);
		const meetAfterRefresh = google.calls.filter(
			(c) => c.url.host === "meet.googleapis.com",
		);
		expect(meetAfterRefresh[0]?.headers.get("authorization")).toBe(
			"Bearer ya29.synthetic-access-token-2",
		);

		vi.stubGlobal(
			"fetch",
			fakeGoogle({
				"GET /v2/conferenceRecords": { status: 401, body: {} },
				"POST https://oauth2.googleapis.com/token refresh_token": {
					status: 400,
					body: { error: "invalid_grant" },
				},
			}).fetchImpl,
		);
		const refused = await session("GET", `/api/v1/integrations/${id}/meetings`);
		expect([refused.statusCode, refused.json().code]).toEqual([
			409,
			"provider_token_expired",
		]);
		const listed = (await session("GET", "/api/v1/integrations")).json()
			.items[0];
		expect(listed.connection).toMatchObject({
			status: "expired",
			last_error: { code: "provider_token_expired" },
		});
	});

	it("keeps connections private to their user and revokes on disconnect", async () => {
		const owner = await createOwner(ctx.db);
		await addMember(ctx.db, owner.workspaceId);
		const id = await connect();
		const member = asSession(ctx, await login(ctx, "member@example.com"));
		for (const [method, url, body] of [
			["GET", `/api/v1/integrations/${id}/meetings`, undefined],
			[
				"POST",
				`/api/v1/integrations/${id}/import`,
				{ provider_meeting_ref: REF, consent_attested: true },
			],
			["DELETE", `/api/v1/integrations/${id}`, undefined],
		] as const)
			expect((await member(method, url, body)).statusCode).toBe(404);
		expect(
			(await member("GET", "/api/v1/integrations")).json().items[0].connection,
		).toBeNull();
		expect(
			(await session("DELETE", `/api/v1/integrations/${id}`)).statusCode,
		).toBe(204);
		const revoke = google.calls.find((c) => c.url.pathname === "/revoke");
		expect(new URLSearchParams(revoke?.body ?? "").get("token")).toBe(
			"1//synthetic-refresh-token",
		);
		expect(await ctx.db.select().from(integrationConnections)).toHaveLength(0);
	});
});
