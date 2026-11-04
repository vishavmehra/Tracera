import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	CreateRepositoryRequestSchema,
	type MeetingCandidate,
	type MeetingExtractionOutput,
	type MeetingProvider,
	MeetingSummarySchema,
	ProblemSchema,
	TRANSCRIPT_MAX_BYTES,
} from "@tracera/contracts";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
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
import * as web from "../../web/src/api.ts";
import {
	CALLBACK_OUTCOMES,
	callbackOutcome,
	candidatePatch,
	confirmBody,
	importBody,
	uploadBody,
} from "../../web/src/meeting-wire.ts";
import { meetingSessions } from "../src/db/schema.ts";
import { createMockProvider } from "../src/inference/mock.ts";
import {
	type ChatProvider,
	ProviderError,
} from "../src/inference/providers.ts";
import {
	MEETING_EXTRACT_QUEUE,
	runMeetingExtraction,
} from "../src/modules/meeting-extract.ts";
import {
	createOwner,
	createTestContext,
	makeGitRepo,
	PASSWORD,
	repositoryBody,
	resetDatabase,
	scriptedProvider,
	type TestContext,
} from "./helpers.ts";
import { fakeGoogle, MEET } from "./meeting-google-fake.ts";

// The Meetings pages' own API client, request builders, and response schemas run against the real
// API here. Every call the client makes goes through a fetch that hands the request to the app under
// test and returns what the app answered, so a response the client cannot parse, or a request the
// server refuses, fails in this file instead of on first use in a browser. Inference is the mock
// adapter or a scripted test double ([mock]); Google is a recorded fake; nothing here reaches a
// network or a model.

const MEET_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";
const REF = "conferenceRecords/abc-123/transcripts/tr-1";
const TOKEN_ROUTE =
	"POST https://oauth2.googleapis.com/token authorization_code";

let ctx: TestContext;
let google = fakeGoogle();
/** The browser's cookie jar: one session cookie. */
const jar = { cookie: "" };

const fixture = (name: string) =>
	readFileSync(new URL(`./fixtures/meetings/${name}`, import.meta.url));

// ---- The browser -------------------------------------------------------------------------------

const toResponse = (res: LightMyRequestResponse) => {
	const headers = new Headers();
	for (const [name, value] of Object.entries(res.headers)) {
		if (Array.isArray(value)) for (const v of value) headers.append(name, v);
		else if (value !== undefined) headers.set(name, String(value));
	}
	const noBody = [204, 205, 304].includes(res.statusCode);
	return new Response(noBody ? null : res.body, {
		status: res.statusCode,
		headers,
	});
};

/**
 * The global fetch for these tests. A path is the page calling its own API; an absolute URL is the
 * server calling Google, which the recorded fake answers.
 */
const webFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const target =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	if (!target.startsWith("/")) return google.fetchImpl(target, init ?? {});
	const method = (init?.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE";
	const headers = Object.fromEntries(new Headers(init?.headers));
	if (jar.cookie) headers.cookie = jar.cookie;
	// A browser adds Origin to its same-origin mutations, and the API refuses cookie-authenticated ones without it.
	if (method !== "GET") headers.origin = ctx.config.api.publicOrigin;
	const response = await ctx.app.inject({
		method,
		url: target,
		headers,
		...(typeof init?.body === "string" ? { payload: init.body } : {}),
	});
	const setCookie = response.headers["set-cookie"];
	if (setCookie) jar.cookie = String(setCookie).split(";")[0] ?? "";
	return toResponse(response);
}) as typeof fetch;

/** A top-level navigation: the cookie travels, there is no CSRF header, and redirects are not followed. */
const navigate = (path: string) =>
	ctx.app.inject({ method: "GET", url: path, headers: { cookie: jar.cookie } });

const signInAs = (email = "owner@example.com", password = PASSWORD) =>
	web.signIn({ email, password });

/** The error the page's client raises for a call that must fail. */
async function failure(call: Promise<unknown>): Promise<web.ApiError> {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(web.ApiError);
	return error as web.ApiError;
}

/** Every error the client raises must carry the server's problem body, which the error panel reads. */
function expectProblem(error: web.ApiError, status: number, code: string) {
	expect([error.status, error.code]).toEqual([status, code]);
	expect(ProblemSchema.safeParse(error.problem).success).toBe(true);
	expect(error.problem?.request_id).toMatch(/\S/);
	expect(error.problem?.status).toBe(status);
}

// ---- What the pages do -------------------------------------------------------------------------

/** A file chosen in the upload form, sent the way the page sends it. */
function upload(
	file: string,
	browserType: string,
	provider: MeetingProvider,
	options: { bytes?: Buffer; filename?: string; title?: string } = {},
) {
	return web.uploadMeetingTranscript(
		uploadBody({
			filename: options.filename ?? file,
			browserType,
			dataBase64: (options.bytes ?? fixture(file)).toString("base64"),
			title: options.title ?? "",
			provider,
			repositoryId: "",
		}),
		crypto.randomUUID(),
	);
}

/** The worker, run by hand: takes the queued job and runs the extraction with the given provider. */
async function extract(meetingId: string, provider: ChatProvider) {
	const { rows } = await ctx.pool.query<{ id: string }>(
		"SELECT id FROM pgboss.job WHERE name = $1 AND state = 'created' AND data->>'meetingId' = $2",
		[MEETING_EXTRACT_QUEUE, meetingId],
	);
	expect(rows).toHaveLength(1);
	await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [rows[0]?.id]);
	await runMeetingExtraction(
		{ db: ctx.db, pool: ctx.pool, config: ctx.config, provider },
		meetingId,
	);
}

/** What the edit form holds, read the way the page reads it. */
const formValues = (values: Record<string, string>) => (name: string) =>
	(values[name] ?? "").trim();

type Item = MeetingExtractionOutput["items"][number];
const bugItem = (overrides: Partial<Item>): Item => ({
	kind: "bug",
	title: "Cart total shows NaN after applying the SAVE10 coupon",
	description:
		"With two items in the cart and the SAVE10 coupon applied, the total shows NaN.",
	expected_behavior: "The discounted total is shown",
	actual_behavior: "The total shows NaN",
	steps: ["Add two items to the cart", "Apply the SAVE10 coupon"],
	severity_suggestion: "unknown",
	affected_area: "cart",
	citations: [],
	...overrides,
});

/** What a model could return for teams.vtt: a bug, its duplicate, a feature request, an invented bug. */
const teamsExtraction: MeetingExtractionOutput = {
	items: [
		bugItem({
			citations: [
				{
					handle: "SEG-2",
					quote: "the total shows NaN instead of the discounted price",
				},
				{
					handle: "SEG-4",
					quote: "It only breaks after the coupon is applied",
				},
			],
		}),
		bugItem({
			title: "Coupon total is NaN",
			description: "The total is NaN once a coupon is used.",
			expected_behavior: null,
			steps: [],
			citations: [
				{ handle: "SEG-4", quote: "only breaks after the coupon is applied" },
			],
		}),
		bugItem({
			kind: "feature_request",
			title: "Dark mode for the dashboard",
			description: "Customers ask for a dark mode on the dashboard.",
			expected_behavior: null,
			actual_behavior: null,
			steps: [],
			affected_area: "dashboard",
			citations: [
				{ handle: "SEG-5", quote: "customers keep asking for a dark mode" },
			],
		}),
		bugItem({
			title: "Checkout crashes on submit",
			description: "Not said in the meeting.",
			citations: [
				{ handle: "SEG-9", quote: "the checkout crashes on submit" },
				{ handle: "SEG-1", quote: "this sentence is not in the segment" },
			],
		}),
	],
};

// ---- Google is not configured on the server ------------------------------------------------------

describe("without Google settings on the server", () => {
	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(async () => ctx.close());
	beforeEach(async () => {
		await resetDatabase(ctx.pool);
		await ctx.pool.query("DELETE FROM pgboss.job WHERE name = $1", [
			MEETING_EXTRACT_QUEUE,
		]);
		await createOwner(ctx.db);
		jar.cookie = "";
		vi.stubGlobal("fetch", webFetch);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("names the missing settings, refuses to connect, and still takes an upload", async () => {
		await signInAs();
		const items = await web.listIntegrations();
		expect(items.map((item) => [item.provider, item.availability])).toEqual([
			["google", "not_configured"],
			["microsoft", "not_implemented"],
		]);
		expect(items[0]).toMatchObject({
			missing: [
				"GOOGLE_CLIENT_ID",
				"GOOGLE_CLIENT_SECRET",
				"GOOGLE_REDIRECT_URI",
				"TRACERA_ENCRYPTION_KEY",
			],
			connection: null,
		});

		// The link on the page is a navigation: the server answers with a problem body, not a redirect.
		const connect = await navigate(web.GOOGLE_CONNECT_PATH);
		expect([connect.statusCode, connect.json().code]).toEqual([
			409,
			"integration_not_configured",
		]);
		expect(ProblemSchema.safeParse(connect.json()).success).toBe(true);

		const { meeting } = await upload("teams.vtt", "text/vtt", "teams");
		expect(meeting).toMatchObject({ status: "transcribed", provider: "teams" });
	});
});

// ---- Google is configured ----------------------------------------------------------------------

describe("with Google settings on the server", () => {
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
		google = fakeGoogle();
		jar.cookie = "";
		vi.stubGlobal("fetch", webFetch);
		await signInAs();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Connect → Google consent (simulated) → callback, as the browser walks it. */
	async function connect(): Promise<string> {
		const start = await navigate(web.GOOGLE_CONNECT_PATH);
		expect(start.statusCode).toBe(302);
		const consent = new URL(String(start.headers.location));
		expect(`${consent.origin}${consent.pathname}`).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(consent.searchParams.get("scope")).toBe(MEET_SCOPE);
		expect(consent.searchParams.get("redirect_uri")).toBe(
			ctx.config.meetings.google?.redirectUri,
		);
		const state = consent.searchParams.get("state") ?? "";
		const back = await navigate(
			`/api/v1/integrations/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
		);
		expect(back.headers.location).toBe(
			`${ctx.config.api.publicUrl}/meetings?integration=google&result=connected`,
		);
		const connection = (await web.listIntegrations()).find(
			(item) => item.provider === "google",
		)?.connection;
		expect(connection).toBeTruthy();
		return connection?.id ?? "";
	}

	it("connects, lists conferences, imports a transcript, and disconnects", async () => {
		const before = await web.listIntegrations();
		expect(before.find((item) => item.provider === "google")).toMatchObject({
			meeting_provider: "google_meet",
			availability: "available",
			missing: [],
			scopes: [MEET_SCOPE],
			connection: null,
		});

		const id = await connect();
		const connected = (await web.listIntegrations()).find(
			(item) => item.provider === "google",
		);
		expect(connected?.connection).toMatchObject({
			id,
			status: "active",
			scopes: [MEET_SCOPE],
			last_error: null,
		});

		const conferences = await web.listProviderMeetings(id);
		expect(conferences.map((c) => c.conference_ref)).toEqual([
			"conferenceRecords/abc-123",
			"conferenceRecords/def-456",
		]);
		expect(
			conferences.flatMap((c) =>
				c.transcripts.map((t) => [t.provider_meeting_ref, t.importable]),
			),
		).toEqual([
			[REF, true],
			["conferenceRecords/def-456/transcripts/tr-2", false],
		]);

		// The page always sends the attestation; the server still refuses a request without it.
		const unattested = await failure(
			web.importProviderMeeting(
				id,
				{ provider_meeting_ref: REF },
				crypto.randomUUID(),
			),
		);
		expectProblem(unattested, 422, "consent_required");

		const key = crypto.randomUUID();
		const body = importBody({
			ref: REF,
			title: "Google Meet, checkout triage",
			repositoryId: "",
		});
		const { meeting } = await web.importProviderMeeting(id, body, key);
		expect(meeting).toMatchObject({
			provider: "google_meet",
			source: "provider_api",
			provider_ref: REF,
			status: "transcribed",
			title: "Google Meet, checkout triage",
			transcript: { format: "meet_entries", filename: null, segment_count: 4 },
		});
		// A retry after a lost response replays the stored answer instead of importing twice.
		const replay = await web.importProviderMeeting(id, body, key);
		expect(replay.meeting.id).toBe(meeting.id);
		// Another key is a second import of the same transcript: the page offers the existing meeting.
		const again = await failure(
			web.importProviderMeeting(id, body, crypto.randomUUID()),
		);
		expectProblem(again, 409, "conflict");
		expect(again.extra.meeting_id).toBe(meeting.id);

		// Same extraction path as an upload, and the imported meeting is what the list matches by provider_ref.
		await extract(meeting.id, createMockProvider());
		const listed = await web.listMeetings(25);
		expect(listed.items.map((m) => [m.id, m.provider_ref])).toEqual([
			[meeting.id, REF],
		]);
		expect(listed.items[0]?.extraction?.mock).toBe(true);

		await expect(web.disconnectIntegration(id)).resolves.toBeUndefined();
		const after = (await web.listIntegrations()).find(
			(item) => item.provider === "google",
		);
		expect(after?.connection).toBeNull();
		expect((await failure(web.disconnectIntegration(id))).status).toBe(404);
		// The imported meeting stays.
		expect((await web.getMeeting(meeting.id)).provider_ref).toBe(REF);
	});

	it("shows an expired connection and says why listing fails", async () => {
		const id = await connect();
		google = fakeGoogle({
			"GET /v2/conferenceRecords": { status: 401, body: {} },
			"POST https://oauth2.googleapis.com/token refresh_token": {
				status: 400,
				body: { error: "invalid_grant" },
			},
		});
		await ctx.pool.query(
			"UPDATE integration_connections SET access_token_expires_at = now() - interval '1 hour' WHERE id = $1",
			[id],
		);
		const refused = await failure(web.listProviderMeetings(id));
		expectProblem(refused, 409, "provider_token_expired");
		const listed = (await web.listIntegrations()).find(
			(item) => item.provider === "google",
		);
		expect(listed?.connection).toMatchObject({
			status: "expired",
			last_error: { code: "provider_token_expired" },
		});
		expect(listed?.connection?.last_error?.message).toMatch(/\S/);
	});

	it("sends the browser back with exactly the results the page explains", async () => {
		const ok = (state: string) => `code=auth-code&state=${state}`;
		const refused = (status: number, body: unknown = {}) => ({
			[TOKEN_ROUTE]: { status, body },
		});
		const scenarios: Array<{
			result: string;
			query: (state: string) => string;
			google?: Record<string, { status: number; body: unknown }>;
			offline?: boolean;
		}> = [
			{ result: "connected", query: ok },
			{ result: "invalid_state", query: () => "code=auth-code&state=forged" },
			{ result: "invalid_state", query: () => "code=auth-code" },
			{ result: "denied", query: (s) => `error=access_denied&state=${s}` },
			{ result: "failed", query: (s) => `error=server_error&state=${s}` },
			{ result: "failed", query: (s) => `state=${s}` },
			{
				result: "scope_not_granted",
				query: ok,
				google: refused(200, { ...(MEET.token as object), scope: "openid" }),
			},
			{
				result: "provider_token_expired",
				query: ok,
				google: refused(400, { error: "invalid_grant" }),
			},
			{ result: "provider_token_expired", query: ok, google: refused(401) },
			{ result: "provider_permission_denied", query: ok, google: refused(403) },
			{
				result: "provider_artifact_unavailable",
				query: ok,
				google: refused(404),
			},
			{ result: "provider_unavailable", query: ok, google: refused(429) },
			{ result: "provider_unavailable", query: ok, google: refused(503) },
			{ result: "provider_unavailable", query: ok, offline: true },
			{
				result: "provider_request_failed",
				query: ok,
				google: refused(400, { error: "redirect_uri_mismatch" }),
			},
			{ result: "provider_response_invalid", query: ok, google: refused(200) },
		];
		const seen = new Set<string>();
		for (const scenario of scenarios) {
			const start = await navigate(web.GOOGLE_CONNECT_PATH);
			const state =
				new URL(String(start.headers.location)).searchParams.get("state") ?? "";
			google = fakeGoogle(scenario.google);
			if (scenario.offline)
				vi.stubGlobal(
					"fetch",
					(input: string | URL | Request, init?: RequestInit) =>
						String(input).startsWith("/")
							? webFetch(input, init)
							: Promise.reject(new TypeError("fetch failed")),
				);
			const back = await navigate(
				`/api/v1/integrations/google/callback?${scenario.query(state)}`,
			);
			vi.stubGlobal("fetch", webFetch);
			expect([scenario.result, back.statusCode]).toEqual([
				scenario.result,
				302,
			]);
			const target = new URL(String(back.headers.location));
			expect(`${target.origin}${target.pathname}`).toBe(
				`${ctx.config.api.publicUrl}/meetings`,
			);
			expect(target.searchParams.get("integration")).toBe("google");
			// Nothing but the code travels in the address: no token, no Google text.
			expect([...target.searchParams.keys()].sort()).toEqual([
				"integration",
				"result",
			]);
			const result = target.searchParams.get("result") ?? "";
			expect([scenario.result, result]).toEqual([
				scenario.result,
				scenario.result,
			]);
			seen.add(result);
		}
		// The page has a message for every one of them, and none that the server cannot send.
		expect([...seen].sort()).toEqual(Object.keys(CALLBACK_OUTCOMES).sort());
		// Anything else gets the generic message and none of its text.
		for (const hostile of [
			"provider_something_new",
			"<img src=x onerror=alert(1)>",
			"Your account is locked, call us",
			"__proto__",
			"constructor",
			"toString",
			"",
		]) {
			const outcome = callbackOutcome(hostile);
			expect(outcome.title).toBe("Google Meet could not be connected");
			if (hostile) expect(JSON.stringify(outcome)).not.toContain(hostile);
		}
	});

	it("uploads VTT, SRT, and text the way the page sends them, then reads them back", async () => {
		const cases: Array<
			[string, string, MeetingProvider, string, number, string | null]
		> = [
			["teams.vtt", "text/vtt", "teams", "webvtt", 6, "text/vtt"],
			[
				"captions.srt",
				"application/x-subrip",
				"other",
				"srt",
				4,
				"application/x-subrip",
			],
			// A browser that does not know .srt reports no type at all, and the server stores none.
			["captions.srt", "", "other", "srt", 4, null],
			["plain.txt", "text/plain", "other", "plain_text", 3, "text/plain"],
			[
				"meet-export.txt",
				"text/plain",
				"google_meet",
				"speaker_text",
				7,
				"text/plain",
			],
		];
		const created: string[] = [];
		for (const [file, type, provider, format, segments, stored] of cases) {
			const { meeting } = await upload(file, type, provider);
			expect(meeting).toMatchObject({
				provider,
				source: "upload_transcript",
				status: "transcribed",
				title: null,
				extraction: null,
				failure: null,
				transcript: {
					format,
					segment_count: segments,
					filename: file,
					content_type: stored,
				},
			});
			created.push(meeting.id);
		}

		const read = await web.getMeeting(created[0] ?? "");
		expect(read.transcript.speaker_labels).toEqual([
			"Priya Sharma",
			"Alex Kim",
			"Jordan Lee",
		]);
		const everything = await web.listMeetings(25);
		expect(everything.items.map((m) => m.id)).toEqual([...created].reverse());
		expect(everything.next_cursor).toBeNull();
		// The "Show more" button depends on a cursor appearing exactly when more exist.
		const first = await web.listMeetings(2);
		expect(first.items).toHaveLength(2);
		expect(first.next_cursor).toEqual(expect.any(String));

		const page = await web.listMeetingSegments(created[0] ?? "");
		expect(page.items.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(page.items[1]).toMatchObject({
			speaker_label: "Alex Kim",
			speaker_name: null,
			start_ms: 4900,
			end_ms: 11_350,
		});
		expect(page.next_cursor).toBeNull();
		expect(await web.listMeetingCandidates(created[0] ?? "")).toEqual([]);
	});

	it("pages through a long transcript with the cursor the server hands out", async () => {
		const lines = Array.from(
			{ length: 450 },
			(_, i) => `Alex Kim: line number ${i + 1} of the call`,
		).join("\n");
		const { meeting } = await upload("long.txt", "text/plain", "other", {
			bytes: Buffer.from(lines),
		});
		expect(meeting.transcript.segment_count).toBe(450);
		const sizes: number[] = [];
		const indexes: number[] = [];
		let cursor: string | undefined;
		do {
			const page = await web.listMeetingSegments(meeting.id, cursor);
			sizes.push(page.items.length);
			indexes.push(...page.items.map((s) => s.index));
			cursor = page.next_cursor ?? undefined;
		} while (cursor);
		expect(sizes).toEqual([200, 200, 50]);
		expect(indexes).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
	});

	it("accepts the largest file the page allows", async () => {
		const line = `Alex Kim: ${"lorem ipsum ".repeat(85)}\n`;
		const lines = Math.floor(TRANSCRIPT_MAX_BYTES / line.length);
		const rest = TRANSCRIPT_MAX_BYTES - lines * line.length;
		const bytes = Buffer.from(
			`${line.repeat(lines)}Alex Kim: ${"y".repeat(rest - 11)}
`,
		);
		expect(bytes.length).toBe(TRANSCRIPT_MAX_BYTES);
		const { meeting } = await upload("largest.txt", "text/plain", "other", {
			bytes,
		});
		expect(meeting.transcript).toMatchObject({
			size_bytes: TRANSCRIPT_MAX_BYTES,
			segment_count: lines + 1,
		});
	});

	it("reviews candidates through edit, confirm, dismiss, and investigation [mock]", async () => {
		const { repository } = await web.registerRepository(
			CreateRepositoryRequestSchema.parse(
				repositoryBody(makeGitRepo(ctx.repoRoot)),
			),
		);
		expect((await web.listRepositories()).items.map((r) => r.id)).toEqual([
			repository.id,
		]);

		const { meeting } = await upload("teams.vtt", "text/vtt", "teams", {
			title: "Checkout standup",
		});
		// The mock adapter proposes nothing, and says so everywhere the page shows it.
		await extract(meeting.id, createMockProvider());
		const mocked = await web.getMeeting(meeting.id);
		expect(mocked.extraction).toMatchObject({ mock: true, candidates: 0 });
		const mockedSummary = await web.getMeetingSummaryMarkdown(meeting.id);
		expect(mockedSummary).toContain("[mock]");

		// "Extract again" queues a new run; the scripted double stands in for a model.
		const queued = await web.requestMeetingExtraction(meeting.id);
		expect(queued).toMatchObject({ status: "transcribed", failure: null });
		await extract(
			meeting.id,
			scriptedProvider({ extract_meeting_bugs: teamsExtraction }),
		);
		const extracted = await web.getMeeting(meeting.id);
		expect(extracted).toMatchObject({
			status: "extracted",
			candidate_counts: { bugs_pending: 2, rejected: 1 },
			extraction: { mock: false, candidates: 3, rejected: 1 },
		});

		const candidates = await web.listMeetingCandidates(meeting.id);
		const [first, duplicate, feature, invented] = candidates as [
			MeetingCandidate,
			MeetingCandidate,
			MeetingCandidate,
			MeetingCandidate,
		];
		expect(candidates.map((c) => [c.ordinal, c.kind, c.status])).toEqual([
			[1, "bug", "pending_review"],
			[2, "bug", "pending_review"],
			[3, "feature_request", "pending_review"],
			[4, "bug", "rejected"],
		]);
		expect(duplicate.duplicate_of).toMatchObject({
			type: "candidate",
			id: first.id,
		});

		// Edit: only what the reviewer changed is sent.
		const unchanged = formValues({
			kind: first.kind,
			severity: first.severity,
			title: first.title,
			description: first.description,
			expected: first.expected_behavior ?? "",
			actual: first.actual_behavior ?? "",
			steps: first.steps.join("\n"),
			repository_id: first.repository_id ?? "",
		});
		expect(candidatePatch(first, unchanged)).toEqual({});
		const patch = candidatePatch(
			first,
			formValues({
				kind: first.kind,
				severity: "high",
				title: "Cart total is NaN with the SAVE10 coupon",
				description: first.description,
				expected: "",
				actual: first.actual_behavior ?? "",
				steps: "Add two items\n\n  Apply the SAVE10 coupon  \n",
				repository_id: "",
			}),
		);
		expect(patch).toEqual({
			severity: "high",
			title: "Cart total is NaN with the SAVE10 coupon",
			expected_behavior: null,
			steps: ["Add two items", "Apply the SAVE10 coupon"],
		});
		const edited = await web.updateMeetingCandidate(
			meeting.id,
			first.id,
			patch,
		);
		expect(edited).toMatchObject({
			severity: "high",
			expected_behavior: null,
			steps: ["Add two items", "Apply the SAVE10 coupon"],
			field_sources: { title: "user_edited", description: "meeting_extracted" },
		});
		// "I checked: not a duplicate", then dismiss with a reason.
		const cleared = await web.updateMeetingCandidate(meeting.id, duplicate.id, {
			not_duplicate: true,
		});
		expect(cleared.duplicate_of).toBeNull();
		const dismissed = await web.dismissMeetingCandidate(
			meeting.id,
			duplicate.id,
			"Same as the first",
		);
		expect(dismissed).toMatchObject({
			status: "dismissed",
			review: { reason: "Same as the first" },
		});
		const quiet = await web.dismissMeetingCandidate(meeting.id, feature.id);
		expect(quiet).toMatchObject({
			status: "dismissed",
			review: { reason: null },
		});
		// A rejected candidate can be neither confirmed nor dismissed.
		for (const attempt of [
			() =>
				web.confirmMeetingCandidate(
					meeting.id,
					invented.id,
					confirmBody({
						repositoryKnown: false,
						repositoryId: "",
						duplicate: false,
					}),
				),
			() => web.dismissMeetingCandidate(meeting.id, invented.id),
		])
			expectProblem(await failure(attempt()), 409, "invalid_state");

		// Confirm files the report only; the page starts the investigation as a separate step.
		const confirmed = await web.confirmMeetingCandidate(
			meeting.id,
			first.id,
			confirmBody({
				repositoryKnown: false,
				repositoryId: repository.id,
				duplicate: false,
			}),
		);
		expect(confirmed).toMatchObject({
			candidate: {
				status: "confirmed",
				repository_id: repository.id,
				bug_report: { status: "open" },
				investigation: null,
			},
			bug_report: {
				title: "Cart total is NaN with the SAVE10 coupon",
				source_channel: "meeting",
			},
			investigation: null,
			investigation_error: null,
		});
		expectProblem(
			await failure(
				web.confirmMeetingCandidate(
					meeting.id,
					first.id,
					confirmBody({
						repositoryKnown: true,
						repositoryId: "",
						duplicate: false,
					}),
				),
			),
			409,
			"invalid_state",
		);
		expect(
			(await web.getBugReport(confirmed.bug_report.id)).source_channel,
		).toBe("meeting");

		// Start the investigation from the confirmed candidate, with the repository the page offers.
		const { investigation } = await web.createInvestigation({
			bug_report_id: confirmed.bug_report.id,
			repository_id: repository.id,
			mode: "full",
		});
		expect(investigation).toMatchObject({
			status: "queued",
			bug_report_id: confirmed.bug_report.id,
		});
		expect((await web.getInvestigation(investigation.id)).id).toBe(
			investigation.id,
		);
		expect((await web.listInvestigations()).items.map((i) => i.id)).toContain(
			investigation.id,
		);
		const second = await failure(
			web.createInvestigation({
				bug_report_id: confirmed.bug_report.id,
				repository_id: repository.id,
				mode: "full",
			}),
		);
		expectProblem(second, 409, "investigation_active");
		expect(second.extra.investigation_id).toBe(investigation.id);

		const after = await web.listMeetingCandidates(meeting.id);
		expect(after[0]?.investigation).toMatchObject({
			id: investigation.id,
			status: "queued",
			verification_outcome: null,
		});
		const reviewed = await web.getMeeting(meeting.id);
		expect(reviewed).toMatchObject({
			status: "reviewed",
			candidate_counts: { bugs_pending: 0, bugs_confirmed: 1 },
		});

		// The summary the page downloads is the server's Markdown, without the mock label now.
		const markdown = await web.getMeetingSummaryMarkdown(meeting.id);
		const summary = MeetingSummarySchema.parse(
			(
				await ctx.app.inject({
					method: "GET",
					url: `/api/v1/meetings/${meeting.id}/summary`,
					headers: { cookie: jar.cookie },
				})
			).json().summary,
		);
		expect(markdown.split("\n")[0]).toBe(summary.markdown.split("\n")[0]);
		expect(markdown).toContain("Cart total is NaN with the SAVE10 coupon");
		expect(markdown).not.toContain("[mock]");
		const raw = await navigate(
			`/api/v1/meetings/${meeting.id}/summary?format=markdown`,
		);
		expect(raw.headers["content-type"]).toMatch(/^text\/markdown/);

		// A second meeting repeats the report: the page must acknowledge the flagged duplicate.
		const { meeting: later } = await upload("teams.vtt", "text/vtt", "teams");
		await extract(
			later.id,
			scriptedProvider({
				extract_meeting_bugs: {
					items: [
						bugItem({
							title: "Cart total is NaN with the SAVE10 coupon",
							citations: teamsExtraction.items[0]?.citations ?? [],
						}),
					],
				},
			}),
		);
		const [repeat] = await web.listMeetingCandidates(later.id);
		expect(repeat?.duplicate_of).toMatchObject({
			type: "bug_report",
			id: confirmed.bug_report.id,
		});
		expectProblem(
			await failure(
				web.confirmMeetingCandidate(
					later.id,
					repeat?.id ?? "",
					confirmBody({
						repositoryKnown: false,
						repositoryId: "",
						duplicate: false,
					}),
				),
			),
			409,
			"duplicate_unacknowledged",
		);
		const acknowledged = await web.confirmMeetingCandidate(
			later.id,
			repeat?.id ?? "",
			confirmBody({
				repositoryKnown: false,
				repositoryId: repository.id,
				duplicate: true,
			}),
		);
		expect(acknowledged.candidate.status).toBe("confirmed");
	});

	it("retries a failed extraction and refuses a second one while one runs", async () => {
		const { meeting } = await upload("teams.vtt", "text/vtt", "teams");
		await extract(
			meeting.id,
			scriptedProvider({
				extract_meeting_bugs: new ProviderError(
					"provider_auth_failed",
					"Invalid key",
					false,
				),
			}),
		);
		const failed = await web.getMeeting(meeting.id);
		expect(failed).toMatchObject({
			status: "failed",
			failure: { code: "provider_auth_failed" },
		});
		expect(failed.failure?.message).toMatch(/\S/);

		const retried = await web.requestMeetingExtraction(meeting.id);
		expect(retried).toMatchObject({ status: "transcribed", failure: null });
		await extract(
			meeting.id,
			scriptedProvider({ extract_meeting_bugs: { items: [] } }),
		);
		expect((await web.getMeeting(meeting.id)).status).toBe("extracted");

		await ctx.db
			.update(meetingSessions)
			.set({ status: "processing", extractionStartedAt: new Date() })
			.where(eq(meetingSessions.id, meeting.id));
		const running = await failure(web.requestMeetingExtraction(meeting.id));
		expectProblem(running, 409, "invalid_state");
		expect(running.extra.meeting_status).toBe("processing");
	});

	it("answers every failure with the problem body the error panel reads", async () => {
		const { meeting } = await upload("teams.vtt", "text/vtt", "teams");
		const body = (bytes: Buffer, filename = "notes.txt") =>
			uploadBody({
				filename,
				browserType: "text/plain",
				dataBase64: bytes.toString("base64"),
				title: "",
				provider: "other",
				repositoryId: "",
			});
		const send = (input: ReturnType<typeof body>) =>
			web.uploadMeetingTranscript(input, crypto.randomUUID());

		// 422: the attestation is the server's rule, whatever the form does.
		expectProblem(
			await failure(
				send({ ...body(fixture("teams.vtt")), consent_attested: false }),
			),
			422,
			"consent_required",
		);
		// 422 and 415: content the server cannot read as a transcript.
		expectProblem(
			await failure(send(body(Buffer.from("not a vtt file"), "broken.vtt"))),
			422,
			"transcript_invalid",
		);
		expectProblem(
			await failure(
				send(
					body(
						Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
					),
				),
			),
			415,
			"unsupported_media_type",
		);
		// 413, from the transcript limit and from the request body limit.
		expectProblem(
			await failure(send(body(Buffer.alloc(TRANSCRIPT_MAX_BYTES + 1, "a")))),
			413,
			"payload_too_large",
		);
		expectProblem(
			await failure(send(body(Buffer.alloc(6 * 1024 * 1024, "a")))),
			413,
			"payload_too_large",
		);
		// 400 with a list of fields.
		const invalid = await failure(
			web.updateMeetingCandidate(
				meeting.id,
				"cand_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
				{
					title: "",
				},
			),
		);
		expectProblem(invalid, 400, "validation_failed");
		expect(invalid.problem?.errors?.[0]).toMatchObject({ path: "title" });

		// 404: an ID that is malformed, one that is unknown, and one that belongs to another workspace.
		expectProblem(await failure(web.getMeeting("not-an-id")), 404, "not_found");
		expectProblem(
			await failure(web.getMeeting("mtg_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C")),
			404,
			"not_found",
		);
		await createOwner(ctx.db, "other@example.com");
		await signInAs("other@example.com");
		for (const call of [
			() => web.getMeeting(meeting.id),
			() => web.listMeetingSegments(meeting.id),
			() => web.listMeetingCandidates(meeting.id),
			() => web.requestMeetingExtraction(meeting.id),
			() => web.getMeetingSummaryMarkdown(meeting.id),
		])
			expectProblem(await failure(call()), 404, "not_found");
		expect((await web.listMeetings(25)).items).toEqual([]);
		expectProblem(
			await failure(
				web.disconnectIntegration("int_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C"),
			),
			404,
			"not_found",
		);

		// 401: a signed-out page is told to sign in; a wrong password is not a sign-out.
		const wrong = await failure(
			signInAs("other@example.com", "wrong-password"),
		);
		expect([wrong.status, wrong.code, web.isSignedOut(wrong)]).toEqual([
			401,
			"invalid_credentials",
			false,
		]);
		jar.cookie = "";
		const signedOut = await failure(web.listMeetings(25));
		expect(signedOut.status).toBe(401);
		expect(web.isSignedOut(signedOut)).toBe(true);
		expect(ProblemSchema.safeParse(signedOut.problem).success).toBe(true);
	});
});
