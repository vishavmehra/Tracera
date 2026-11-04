import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MEETING_CONSENT_STATEMENT } from "@tracera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Call,
	ids,
	json,
	problem,
	renderApp,
	repository,
	session,
	stubApi,
} from "./support.tsx";

// TEST DOUBLES ONLY: fixtures copy the meeting views in packages/contracts so each screen's handling of
// connection states, callback results, uploads, candidates, and the transcript can be checked without a
// server. Inference in these fixtures is the mock adapter unless a test says otherwise.

const at = "2026-10-24T09:00:00.000Z";
const SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";
const m = {
	mtg: "mtg_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
	mtg2: "mtg_01JC9Z3K8Q5V7W2X4Y6Z8A0B2D",
	cand: "cand_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
	seg1: "seg_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
	seg2: "seg_01JC9Z3K8Q5V7W2X4Y6Z8A0B2D",
	seg3: "seg_01JC9Z3K8Q5V7W2X4Y6Z8A0B3E",
	seg4: "seg_01JC9Z3K8Q5V7W2X4Y6Z8A0B4F",
	int: "int_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
	bug: "bug_01JC9Z3K8Q5V7W2X4Y6Z8A0B8K",
	oldBug: "bug_01JC9Z3K8Q5V7W2X4Y6Z8A0B9M",
	inv: "inv_01JC9Z3K8Q5V7W2X4Y6Z8A0B7J",
};
const MEETING = `/api/v1/meetings/${m.mtg}`;
const CANDIDATE = `${MEETING}/candidates/${m.cand}`;
const LIST = "GET /api/v1/meetings?limit=25";
const QUOTE = "it shows 023 instead of 5";

const extraction = (overrides: Record<string, unknown> = {}) => ({
	provider: "mock",
	model: "mock-reasoner",
	mock: true,
	prompt_version: "test",
	model_execution_id: null,
	selection: "all",
	segments_total: 4,
	segments_sent: 4,
	segments_with_signals: 2,
	items_proposed: 2,
	candidates: 2,
	rejected: 0,
	citations_total: 2,
	citations_invalid: 0,
	skipped_reason: null,
	started_at: at,
	finished_at: at,
	...overrides,
});

const meeting = (overrides: Record<string, unknown> = {}) => ({
	id: m.mtg,
	provider: "other",
	source: "upload_transcript",
	title: "Checkout triage",
	occurred_at: null,
	status: "extracted",
	repository_id: null,
	provider_ref: null,
	transcript: {
		format: "webvtt",
		timing: "exact",
		filename: "triage.vtt",
		content_type: "text/vtt",
		encoding: "utf-8",
		size_bytes: 1200,
		sha256: "a".repeat(64),
		segment_count: 4,
		speaker_labels: ["Dana Cruz", "Alex Kim"],
		duration_ms: 27_000,
		warnings: [],
	},
	speaker_map: {},
	flags: [],
	candidate_counts: {
		bugs_pending: 1,
		bugs_confirmed: 0,
		dismissed: 0,
		rejected: 0,
		other_discussion: 0,
		possible_duplicates: 0,
	},
	extraction: extraction(),
	failure: null,
	consent: {
		attested_by: ids.user,
		attested_at: at,
		statement: MEETING_CONSENT_STATEMENT.text,
	},
	created_by: ids.user,
	created_at: at,
	updated_at: at,
	...overrides,
});

const segment = (
	n: number,
	id: string,
	speaker: string,
	startMs: number,
	text: string,
) => ({
	id,
	index: n,
	speaker_label: speaker,
	speaker_name: null,
	start_ms: startMs,
	end_ms: startMs + 4000,
	text,
});
const segments = [
	segment(1, m.seg1, "Priya Sharma", 1000, "Thanks for joining the triage."),
	segment(
		2,
		m.seg2,
		"Dana Cruz",
		5000,
		`The cart total is wrong when a price is a string: ${QUOTE}.`,
	),
	segment(
		3,
		m.seg3,
		"Alex Kim",
		73_000,
		"I can reproduce it with the import feed.",
	),
	segment(4, m.seg4, "Priya Sharma", 3_700_000, "A CSV export would be nice."),
];

const candidate = (overrides: Record<string, unknown> = {}) => ({
	id: m.cand,
	meeting_id: m.mtg,
	ordinal: 1,
	kind: "bug",
	status: "pending_review",
	title: "Cart total is wrong for string prices",
	description: "The cart total shows 023 instead of 5.",
	expected_behavior: "5",
	actual_behavior: "023",
	steps: ["Add two items"],
	severity: "high",
	affected_area: null,
	citations: [
		{
			segment_id: m.seg2,
			index: 2,
			speaker_label: "Dana Cruz",
			speaker_name: null,
			start_ms: 5000,
			end_ms: 9000,
			quote: QUOTE,
			text: segments[1]?.text,
		},
	],
	support: {
		status: "supported",
		citations_valid: 1,
		citations_dropped: 0,
		reasons: [],
	},
	duplicate_of: null,
	field_sources: {
		title: "meeting_extracted",
		description: "meeting_extracted",
	},
	repository_id: null,
	model_execution_id: null,
	bug_report: null,
	investigation: null,
	review: null,
	created_at: at,
	updated_at: at,
	...overrides,
});

const filed = (overrides: Record<string, unknown> = {}) =>
	candidate({
		status: "confirmed",
		bug_report: { id: m.bug, status: "open" },
		review: { decided_by: ids.user, decided_at: at, reason: null },
		...overrides,
	});

const investigation = () => ({
	id: m.inv,
	status: "queued",
	state_version: 1,
	current_stage: null,
	mode: "analysis_only",
	mode_reason: null,
	bug_report_id: m.bug,
	repository_id: ids.repo,
	commit_sha: "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c",
	flags: [],
	progress: { stage_index: 0, stage_count: 9, message: "Queued" },
	steps: [],
	needs_input: null,
	counts: { findings: 0, hypotheses: 0, reproductions: 0, patches: 0 },
	baseline_reproduction: null,
	latest_patch: null,
	latest_verification: null,
	inference: { provider: "mock", mock: true },
	failure: null,
	created_at: at,
	finished_at: null,
});

const google = (overrides: Record<string, unknown> = {}) => ({
	provider: "google",
	meeting_provider: "google_meet",
	availability: "available",
	missing: [],
	scopes: [SCOPE],
	connection: null,
	...overrides,
});
const microsoft = {
	provider: "microsoft",
	meeting_provider: "teams",
	availability: "not_implemented",
	missing: [],
	scopes: [],
	connection: null,
};
const connection = (overrides: Record<string, unknown> = {}) => ({
	id: m.int,
	status: "active",
	scopes: [SCOPE],
	connected_at: at,
	last_error: null,
	...overrides,
});

const home = (
	integrations: unknown[],
	extra: Parameters<typeof stubApi>[0] = {},
) => ({
	"GET /api/v1/auth/me": json(session()),
	"GET /api/v1/integrations": json({ items: integrations }),
	[LIST]: json({ items: [], next_cursor: null }),
	"GET /api/v1/repositories": json({
		items: [repository()],
		next_cursor: null,
	}),
	...extra,
});

const detail = (extra: Parameters<typeof stubApi>[0] = {}) => ({
	"GET /api/v1/auth/me": json(session()),
	"GET /api/v1/repositories": json({
		items: [repository()],
		next_cursor: null,
	}),
	[`GET ${MEETING}`]: json({ meeting: meeting() }),
	[`GET ${MEETING}/segments?limit=200`]: json({
		items: segments,
		next_cursor: null,
	}),
	[`GET ${MEETING}/candidates`]: json({ items: [candidate()] }),
	...extra,
});

const sent = (calls: Call[], method: string, suffix: string) =>
	calls.find((call) => call.method === method && call.path.endsWith(suffix));
const press = async (name: string | RegExp) =>
	fireEvent.click(await screen.findByRole("button", { name }));

afterEach(() => {
	Reflect.deleteProperty(Element.prototype, "scrollIntoView");
	vi.restoreAllMocks();
});

describe("Google Meet connection", () => {
	it("explains a server without Google settings and names only the missing variables", async () => {
		stubApi(
			home([
				google({
					availability: "not_configured",
					missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
				}),
				microsoft,
			]),
		);
		renderApp("/meetings");
		expect(
			await screen.findByText("Not configured on this server"),
		).toBeTruthy();
		expect(screen.getByText("GOOGLE_CLIENT_ID")).toBeTruthy();
		expect(screen.getByText("GOOGLE_CLIENT_SECRET")).toBeTruthy();
		expect(
			screen.queryByRole("link", { name: "Connect Google Meet" }),
		).toBeNull();
		expect(screen.getByText(/no video, audio, or screen shares/)).toBeTruthy();
	});

	it("offers to connect when nothing is connected", async () => {
		stubApi(home([google(), microsoft]));
		renderApp("/meetings");
		const link = await screen.findByRole("link", {
			name: "Connect Google Meet",
		});
		expect(link.getAttribute("href")).toBe(
			"/api/v1/integrations/google/connect",
		);
		expect(screen.getByText("Not connected")).toBeTruthy();
	});

	it("shows the connection and disconnects after a confirmation", async () => {
		let connected = true;
		const calls = stubApi(
			home([], {
				"GET /api/v1/integrations": () =>
					json({
						items: [google({ connection: connected ? connection() : null })],
					}),
				[`DELETE /api/v1/integrations/${m.int}`]: () => {
					connected = false;
					return new Response(null, { status: 204 });
				},
			}),
		);
		renderApp("/meetings");
		expect(
			await screen.findByText("Connected", { selector: "span" }),
		).toBeTruthy();
		await press("Disconnect");
		expect(sent(calls, "DELETE", m.int)).toBeUndefined();
		expect(
			screen.getByText(/cannot confirm that Google processed/),
		).toBeTruthy();
		await press("Disconnect and delete tokens");
		expect(await screen.findByText("Not connected")).toBeTruthy();
		expect(sent(calls, "DELETE", m.int)?.headers["x-tracera-csrf"]).toBe("1");
	});

	it("asks to reconnect and shows the stored error code of an expired connection", async () => {
		stubApi(
			home([
				google({
					connection: connection({
						status: "expired",
						last_error: {
							code: "provider_token_expired",
							message: "Sign in again",
						},
					}),
				}),
			]),
		);
		renderApp("/meetings");
		expect(
			await screen.findByText("Needs reconnecting (expired)"),
		).toBeTruthy();
		expect(screen.getByText("provider_token_expired")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Reconnect Google Meet" }),
		).toBeTruthy();
	});

	it("shows the server's error code and request when the integrations cannot be read", async () => {
		stubApi(
			home([], {
				"GET /api/v1/integrations": problem(500, "internal_error", "Boom"),
			}),
		);
		renderApp("/meetings");
		expect(
			await screen.findByText("Integrations could not be loaded"),
		).toBeTruthy();
		expect(screen.getByText("internal_error")).toBeTruthy();
		expect(screen.getAllByText("req-test-1").length).toBeGreaterThan(0);
	});
});

describe("result of the Google sign-in", () => {
	it.each([
		["connected", "Google Meet connection completed"],
		["denied", "Google access was not granted"],
		[
			"invalid_state",
			"The connection attempt could not be matched to your session",
		],
		["scope_not_granted", "Transcript access was not granted"],
		["failed", "Google did not complete the connection"],
		["provider_unavailable", "Google could not be reached"],
		["provider_token_expired", "Google refused the authorization"],
		["provider_permission_denied", "Google refused access for this account"],
		["provider_request_failed", "Google rejected the connection request"],
		["provider_response_invalid", "Google answered in an unexpected way"],
		[
			"provider_artifact_unavailable",
			"Google could not complete the connection",
		],
	])("explains the result %s", async (result, title) => {
		stubApi(home([google(), microsoft]));
		renderApp(`/meetings?integration=google&result=${result}`);
		expect(await screen.findByText(title)).toBeTruthy();
	});

	it("shows the generic message for a code it does not know and echoes none of it", async () => {
		stubApi(home([google(), microsoft]));
		renderApp("/meetings?integration=google&result=some_new_code");
		expect(
			await screen.findByText("Google Meet could not be connected"),
		).toBeTruthy();
		expect(screen.queryByText(/some_new_code/)).toBeNull();
	});

	it("ignores a result that is not a plain code", async () => {
		stubApi(home([google(), microsoft]));
		renderApp(
			`/meetings?integration=google&result=${encodeURIComponent("Your account is locked, call us")}`,
		);
		expect(
			await screen.findByText("Google Meet could not be connected"),
		).toBeTruthy();
		expect(screen.queryByText(/account is locked/)).toBeNull();
	});

	it("dismisses the message and clears the address", async () => {
		stubApi(home([google(), microsoft]));
		const { router } = renderApp("/meetings?integration=google&result=denied");
		await screen.findByText("Google access was not granted");
		await press(/Dismiss/);
		await waitFor(() =>
			expect(screen.queryByText("Google access was not granted")).toBeNull(),
		);
		expect(router.state.location.search).toBe("");
	});
});

describe("uploading a transcript", () => {
	const file = (name = "triage.vtt", type = "text/vtt") =>
		new File(["WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello"], name, {
			type,
		});
	const choose = (selected: File) =>
		fireEvent.change(screen.getByLabelText("Transcript file"), {
			target: { files: [selected] },
		});
	const base = () => home([google({ availability: "not_configured" })]);

	it.each([
		["no file", () => undefined, "Choose a transcript file."],
		[
			"an unsupported extension",
			() => choose(file("notes.pdf", "application/pdf")),
			"Use a .vtt, .srt, .txt file.",
		],
		[
			"no consent",
			() => choose(file()),
			"Confirm that you are authorized to share this transcript.",
		],
	])("refuses %s without calling the API", async (_case, setup, message) => {
		const calls = stubApi(base());
		renderApp("/meetings");
		await screen.findByRole("heading", { name: "Upload a transcript" });
		setup();
		await press("Upload transcript");
		expect((await screen.findByRole("alert")).textContent).toBe(message);
		expect(calls.some((call) => call.method === "POST")).toBe(false);
	});

	it("sends the file as base64 with consent and an idempotency key, then opens the meeting", async () => {
		const calls = stubApi({
			...base(),
			"POST /api/v1/meetings": json(
				{ meeting: meeting({ status: "transcribed", extraction: null }) },
				202,
			),
			...detail(),
		});
		const { router } = renderApp("/meetings");
		await screen.findByRole("heading", { name: "Upload a transcript" });
		choose(file());
		fireEvent.change(screen.getByLabelText("Title (optional)"), {
			target: { value: "Checkout triage" },
		});
		fireEvent.click(screen.getByLabelText(MEETING_CONSENT_STATEMENT.text));
		await press("Upload transcript");
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/meetings/${m.mtg}`),
		);
		const upload = sent(calls, "POST", "/api/v1/meetings");
		expect(upload?.body).toEqual({
			provider: "other",
			consent_attested: true,
			title: "Checkout triage",
			transcript: {
				filename: "triage.vtt",
				content_type: "text/vtt",
				data_base64: btoa("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello"),
			},
		});
		expect(upload?.headers["idempotency-key"]).toMatch(/^[\x21-\x7E]{1,128}$/);
		expect(upload?.headers["x-tracera-csrf"]).toBe("1");
	});

	it("shows the server's validation errors with the code and request", async () => {
		stubApi({
			...base(),
			"POST /api/v1/meetings": new Response(
				JSON.stringify({
					type: "urn:tracera:problem:validation_failed",
					title: "Error",
					status: 422,
					detail: "The transcript could not be read",
					code: "validation_failed",
					request_id: "req-test-1",
					errors: [{ path: "transcript", message: "Not a text file" }],
				}),
				{
					status: 422,
					headers: { "content-type": "application/problem+json" },
				},
			),
		});
		renderApp("/meetings");
		await screen.findByRole("heading", { name: "Upload a transcript" });
		choose(file());
		fireEvent.click(screen.getByLabelText(MEETING_CONSENT_STATEMENT.text));
		await press("Upload transcript");
		expect(
			await screen.findByText("The transcript could not be uploaded"),
		).toBeTruthy();
		expect(screen.getByText(/Not a text file/)).toBeTruthy();
		expect(screen.getByText("validation_failed")).toBeTruthy();
	});
});

describe("importing from Google Meet", () => {
	const ref = "conferenceRecords/abc/transcripts/t1";
	const conferences = [
		{
			conference_ref: "conferenceRecords/abc",
			started_at: "2026-10-20T14:00:00.000Z",
			ended_at: "2026-10-20T14:30:00.000Z",
			expires_at: "2026-11-20T14:00:00.000Z",
			transcripts: [
				{
					provider_meeting_ref: ref,
					state: "ENDED",
					started_at: "2026-10-20T14:00:00.000Z",
					ended_at: "2026-10-20T14:30:00.000Z",
					importable: true,
				},
				{
					provider_meeting_ref: "conferenceRecords/abc/transcripts/t2",
					state: "STARTED",
					started_at: "2026-10-20T15:00:00.000Z",
					ended_at: null,
					importable: false,
				},
			],
		},
	];
	const connected = (extra: Parameters<typeof stubApi>[0] = {}) =>
		home([google({ connection: connection() })], {
			[`GET /api/v1/integrations/${m.int}/meetings`]: json({
				items: conferences,
			}),
			...extra,
		});
	const importPanel = async () => {
		fireEvent.click(
			await screen.findByRole("button", { name: "Show recent meetings" }),
		);
		await screen.findByText(ref);
		return within(
			screen.getByRole("region", { name: "Import from Google Meet" }),
		);
	};

	it("lists transcripts and imports one only after the statement is confirmed", async () => {
		const calls = stubApi(
			connected({
				[`POST /api/v1/integrations/${m.int}/import`]: json(
					{
						meeting: meeting({
							source: "provider_api",
							provider: "google_meet",
						}),
					},
					202,
				),
				...detail(),
			}),
		);
		const { router } = renderApp("/meetings");
		const panel = await importPanel();
		const buttons = panel.getAllByRole("button", { name: "Import" });
		expect(buttons).toHaveLength(1);
		const button = buttons[0] as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(panel.getByText(/Not importable yet/)).toBeTruthy();
		fireEvent.click(panel.getByLabelText(MEETING_CONSENT_STATEMENT.text));
		expect(button.disabled).toBe(false);
		fireEvent.click(button);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/meetings/${m.mtg}`),
		);
		const request = sent(calls, "POST", "/import");
		expect(request?.body).toMatchObject({
			provider_meeting_ref: ref,
			consent_attested: true,
			title: expect.stringContaining("Google Meet"),
		});
		expect(request?.headers["idempotency-key"]).toBeTruthy();
	});

	it("links to the meeting that was imported before when the server reports a conflict", async () => {
		stubApi(
			connected({
				[`POST /api/v1/integrations/${m.int}/import`]: new Response(
					JSON.stringify({
						type: "urn:tracera:problem:conflict",
						title: "Error",
						status: 409,
						detail: "This transcript was already imported",
						code: "conflict",
						request_id: "req-test-1",
						meeting_id: m.mtg2,
					}),
					{
						status: 409,
						headers: { "content-type": "application/problem+json" },
					},
				),
			}),
		);
		renderApp("/meetings");
		const panel = await importPanel();
		fireEvent.click(panel.getByLabelText(MEETING_CONSENT_STATEMENT.text));
		fireEvent.click(panel.getByRole("button", { name: "Import" }));
		const link = await screen.findByRole("link", {
			name: "Open the meeting that was imported before",
		});
		expect(link.getAttribute("href")).toBe(`/meetings/${m.mtg2}`);
		expect(screen.getByText("conflict")).toBeTruthy();
	});

	it("shows a transcript that is already in the list as imported", async () => {
		stubApi(
			connected({
				[LIST]: json({
					items: [
						meeting({ id: m.mtg2, provider_ref: ref, source: "provider_api" }),
					],
					next_cursor: null,
				}),
			}),
		);
		renderApp("/meetings");
		const panel = await importPanel();
		expect(
			panel
				.getByRole("link", { name: "Open imported meeting" })
				.getAttribute("href"),
		).toBe(`/meetings/${m.mtg2}`);
	});
});

describe("meeting list", () => {
	it("shows title, source, status, counts and the model label of each meeting", async () => {
		stubApi(
			home([google(), microsoft], {
				[LIST]: json({
					items: [
						meeting({
							candidate_counts: {
								bugs_pending: 2,
								bugs_confirmed: 1,
								dismissed: 0,
								rejected: 0,
								other_discussion: 1,
								possible_duplicates: 0,
							},
							flags: ["injection_suspected"],
						}),
						meeting({
							id: m.mtg2,
							title: null,
							transcript: {
								...meeting().transcript,
								filename: null,
								content_type: null,
								encoding: null,
							},
							source: "provider_api",
							provider: "google_meet",
							status: "reviewed",
							extraction: extraction({
								mock: false,
								provider: "live",
								model: "m1",
							}),
						}),
					],
					next_cursor: null,
				}),
			}),
		);
		renderApp("/meetings");
		const first = (
			await screen.findByRole("link", { name: "Checkout triage" })
		).closest("li");
		if (!first) throw new Error("row missing");
		expect(
			within(first).getByText(/Uploaded transcript \(Other tool\)/),
		).toBeTruthy();
		expect(within(first).getByText("Candidates await review")).toBeTruthy();
		expect(
			within(first).getByText(
				"2 bug candidates to review · 1 other topic to review · 1 confirmed",
			),
		).toBeTruthy();
		expect(within(first).getByText("[mock]")).toBeTruthy();
		expect(
			within(first).getByText("Contains instruction-like text"),
		).toBeTruthy();
		const second = screen
			.getByRole("link", { name: "Google Meet transcript" })
			.closest("li");
		if (!second) throw new Error("row missing");
		expect(within(second).getByText(/Imported from Google Meet/)).toBeTruthy();
		expect(within(second).getByText("[live]")).toBeTruthy();
		expect(within(second).getByText("No candidate awaits review")).toBeTruthy();
	});

	it("points to the next action when there are no meetings", async () => {
		stubApi(home([google(), microsoft]));
		renderApp("/meetings");
		expect(await screen.findByText(/No meetings yet/)).toBeTruthy();
		await press("Upload a transcript");
		expect(document.activeElement?.id).toBe("transcript-file");
	});

	it("keeps polling while a meeting is being processed and updates its status", async () => {
		let reads = 0;
		stubApi(
			home([google(), microsoft], {
				[LIST]: () =>
					json({
						items: [
							meeting({ status: reads++ === 0 ? "processing" : "extracted" }),
						],
						next_cursor: null,
					}),
			}),
		);
		renderApp("/meetings");
		expect(await screen.findByText("Extraction running")).toBeTruthy();
		expect(
			await screen.findByText("Candidates await review", {}, { timeout: 8000 }),
		).toBeTruthy();
	}, 15_000);

	it("shows the error code when the list cannot be read", async () => {
		stubApi(
			home([google(), microsoft], { [LIST]: problem(500, "internal_error") }),
		);
		renderApp("/meetings");
		expect(
			await screen.findByText("Meetings could not be loaded"),
		).toBeTruthy();
	});
});

describe("meeting page", () => {
	it("shows the transcript with times and speakers beside the candidates and their quotes", async () => {
		stubApi(detail());
		renderApp(`/meetings/${m.mtg}`);
		const article = await screen.findByRole("article", { name: /Candidate 1/ });
		expect(within(article).getByText("Proposed, not confirmed")).toBeTruthy();
		expect(within(article).getByText(new RegExp(`“${QUOTE}”`))).toBeTruthy();
		expect(
			within(article).getByText(/1 quote found in the cited segment/),
		).toBeTruthy();
		const transcript = within(
			await screen.findByRole("region", { name: "Transcript segments" }),
		);
		expect(transcript.getByText("0:05")).toBeTruthy();
		expect(transcript.getByText("1:01:40")).toBeTruthy();
		expect(transcript.getAllByText("Priya Sharma")).toHaveLength(2);
	});

	it("labels the extraction as mock when the mock adapter ran", async () => {
		stubApi(detail());
		renderApp(`/meetings/${m.mtg}`);
		await screen.findByRole("article", { name: /Candidate 1/ });
		expect(screen.getAllByText("[mock]").length).toBeGreaterThan(0);
		expect(screen.getByText(/No model analysed this transcript/)).toBeTruthy();
		expect(screen.queryByText("[live]")).toBeNull();
	});

	it("labels the extraction as live with the model name only when a real model ran", async () => {
		stubApi(
			detail({
				[`GET ${MEETING}`]: json({
					meeting: meeting({
						extraction: extraction({
							mock: false,
							provider: "live",
							model: "model-x",
						}),
					}),
				}),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		await waitFor(() =>
			expect(screen.getAllByText("[live]").length).toBeGreaterThan(0),
		);
		expect(screen.getAllByText("live · model-x").length).toBeGreaterThan(0);
		expect(screen.queryByText("[mock]")).toBeNull();
	});

	it("scrolls to and highlights the segment a citation points at, marking the quote", async () => {
		const scroll = vi.fn();
		Element.prototype.scrollIntoView = scroll;
		stubApi(detail());
		renderApp(`/meetings/${m.mtg}`);
		fireEvent.click(await screen.findByRole("button", { name: "Segment 2" }));
		const row = document.getElementById(`segment-${m.seg2}`);
		if (!row) throw new Error("segment row missing");
		await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
		expect(scroll.mock.contexts[0]).toBe(row);
		expect(within(row).getByText(QUOTE).tagName).toBe("MARK");
		expect(document.activeElement).toBe(row);
		expect(
			document
				.getElementById(`segment-${m.seg1}`)
				?.getAttribute("aria-current"),
		).toBeNull();
		expect(
			within(row).getByRole("button", { name: "candidate 1" }),
		).toBeTruthy();
	});

	it("files a bug report without starting an investigation, then offers to start one", async () => {
		const calls = stubApi(
			detail({
				[`POST ${CANDIDATE}/confirm`]: json(
					{
						candidate: filed(),
						bug_report: {
							id: m.bug,
							status: "open",
							title: "Cart total is wrong for string prices",
							source_channel: "meeting",
						},
						investigation: null,
						investigation_error: null,
					},
					201,
				),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		await press("Confirm and create bug report");
		expect(await screen.findByText("Bug report created")).toBeTruthy();
		expect(sent(calls, "POST", "/confirm")?.body).toEqual({
			start_investigation: false,
		});
		expect(screen.getByText("Confirmed by a person")).toBeTruthy();
		expect(screen.getByText(m.bug)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Start investigation" }),
		).toBeTruthy();
		expect(screen.queryByText(/verified|fixed/i)).toBeNull();
	});

	it("starts an investigation for the filed bug report in the chosen mode", async () => {
		const calls = stubApi(
			detail({
				[`GET ${MEETING}/candidates`]: json({ items: [filed()] }),
				"POST /api/v1/investigations": json(
					{ investigation: investigation() },
					201,
				),
			}),
		);
		const { router } = renderApp(`/meetings/${m.mtg}`);
		await screen.findByText("Bug report created");
		await screen.findByRole("option", { name: "bench-shop" });
		fireEvent.change(screen.getByLabelText("Repository"), {
			target: { value: ids.repo },
		});
		fireEvent.change(screen.getByLabelText("Mode"), {
			target: { value: "analysis_only" },
		});
		await press("Start investigation");
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/investigations/${m.inv}`),
		);
		expect(sent(calls, "POST", "/api/v1/investigations")?.body).toEqual({
			bug_report_id: m.bug,
			repository_id: ids.repo,
			mode: "analysis_only",
		});
	});

	it("links to the investigation when one already exists", async () => {
		stubApi(
			detail({
				[`GET ${MEETING}/candidates`]: json({
					items: [
						filed({
							investigation: {
								id: m.inv,
								status: "running",
								verification_outcome: null,
							},
						}),
					],
				}),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		const link = await screen.findByRole("link", {
			name: "Open the investigation",
		});
		expect(link.getAttribute("href")).toBe(`/investigations/${m.inv}`);
		expect(
			screen.queryByRole("button", { name: "Start investigation" }),
		).toBeNull();
	});

	it("dismisses a candidate with an optional reason", async () => {
		const calls = stubApi(
			detail({
				[`POST ${CANDIDATE}/dismiss`]: json({
					candidate: candidate({
						status: "dismissed",
						review: {
							decided_by: ids.user,
							decided_at: at,
							reason: "Old thread",
						},
					}),
				}),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		await press("Dismiss");
		fireEvent.change(await screen.findByLabelText("Reason (optional)"), {
			target: { value: "Old thread" },
		});
		await press("Dismiss candidate");
		expect(await screen.findByText(/: Old thread/)).toBeTruthy();
		expect(sent(calls, "POST", "/dismiss")?.body).toEqual({
			reason: "Old thread",
		});
		expect(screen.getByText("Dismissed", { selector: "span" })).toBeTruthy();
	});

	it("saves only the fields that were edited and marks them as edited by a person", async () => {
		const calls = stubApi(
			detail({
				[`PATCH ${CANDIDATE}`]: json({
					candidate: candidate({
						title: "Totals are wrong",
						field_sources: {
							title: "user_edited",
							description: "meeting_extracted",
						},
					}),
				}),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		await press("Edit");
		fireEvent.change(await screen.findByLabelText("Title"), {
			target: { value: "Totals are wrong" },
		});
		await press("Save changes");
		expect(await screen.findByText(/edited by a person: Title/)).toBeTruthy();
		expect(sent(calls, "PATCH", m.cand)?.body).toEqual({
			title: "Totals are wrong",
		});
		expect(screen.getByText("Totals are wrong")).toBeTruthy();
	});

	it("does not offer to file a candidate that is not a bug", async () => {
		stubApi(
			detail({
				[`GET ${MEETING}/candidates`]: json({
					items: [candidate({ kind: "feature_request", title: "CSV export" })],
				}),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		const button = await screen.findByRole("button", {
			name: "Confirm and create bug report",
		});
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByText(/Only bug candidates can be filed/)).toBeTruthy();
	});

	it("needs the possible duplicate to be acknowledged before filing", async () => {
		const calls = stubApi(
			detail({
				[`GET ${MEETING}/candidates`]: json({
					items: [
						candidate({
							duplicate_of: {
								type: "bug_report",
								id: m.oldBug,
								title: "Old totals report",
								similarity: 0.82,
							},
						}),
					],
				}),
				[`POST ${CANDIDATE}/confirm`]: json(
					{
						candidate: filed(),
						bug_report: {
							id: m.bug,
							status: "open",
							title: "t",
							source_channel: "meeting",
						},
						investigation: null,
						investigation_error: null,
					},
					201,
				),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		const button = (await screen.findByRole("button", {
			name: "Confirm and create bug report",
		})) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(
			screen.getByText(/text-similarity signal, not a decision/),
		).toBeTruthy();
		fireEvent.click(screen.getByLabelText(/looked at the possible duplicate/));
		expect(button.disabled).toBe(false);
		fireEvent.click(button);
		await screen.findByText("Bug report created");
		expect(sent(calls, "POST", "/confirm")?.body).toEqual({
			start_investigation: false,
			acknowledge_duplicate: true,
		});
	});

	it("says no model was called when extraction found nothing to send", async () => {
		stubApi(
			detail({
				[`GET ${MEETING}`]: json({
					meeting: meeting({
						status: "reviewed",
						extraction: extraction({
							selection: "none",
							skipped_reason: "no_bug_signals",
							segments_sent: 0,
						}),
					}),
				}),
				[`GET ${MEETING}/candidates`]: json({ items: [] }),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		expect(await screen.findByText("No model was called.")).toBeTruthy();
		expect(screen.getByText(/No candidates were proposed/)).toBeTruthy();
		expect(screen.queryByText("[mock]")).toBeNull();
		expect(screen.queryByText("[live]")).toBeNull();
	});

	it("shows that extraction is running while the meeting is processing", async () => {
		stubApi(
			detail({
				[`GET ${MEETING}`]: json({
					meeting: meeting({ status: "processing", extraction: null }),
				}),
				[`GET ${MEETING}/candidates`]: json({ items: [] }),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		expect(await screen.findByText("Extraction is running.")).toBeTruthy();
		expect(screen.getByTitle("processing")).toBeTruthy();
	});

	it("shows the failure and restarts extraction on request", async () => {
		const calls = stubApi(
			detail({
				[`GET ${MEETING}`]: json({
					meeting: meeting({
						status: "failed",
						extraction: null,
						failure: {
							code: "model_unavailable",
							message: "The model could not be reached",
						},
					}),
				}),
				[`GET ${MEETING}/candidates`]: json({ items: [] }),
				[`POST ${MEETING}/extract`]: json(
					{ meeting: meeting({ status: "transcribed", extraction: null }) },
					202,
				),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		expect(await screen.findByText("model_unavailable")).toBeTruthy();
		await press("Retry extraction");
		expect(
			await screen.findByText(
				"Extraction is queued. It starts when a worker picks it up.",
			),
		).toBeTruthy();
		expect(sent(calls, "POST", "/extract")).toBeTruthy();
	});

	it("warns when the transcript contains instruction-like text", async () => {
		stubApi(
			detail({
				[`GET ${MEETING}`]: json({
					meeting: meeting({ flags: ["injection_suspected"] }),
				}),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		expect(
			await screen.findByText("Instruction-like text found."),
		).toBeTruthy();
	});

	it("downloads the Markdown summary from the API", async () => {
		const blobs: Blob[] = [];
		URL.createObjectURL = vi.fn((blob: Blob) => {
			blobs.push(blob);
			return "blob:summary";
		});
		URL.revokeObjectURL = vi.fn();
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => undefined);
		stubApi(
			detail({
				[`GET ${MEETING}/summary?format=markdown`]: new Response(
					"# Summary text",
					{
						headers: { "content-type": "text/markdown" },
					},
				),
			}),
		);
		renderApp(`/meetings/${m.mtg}`);
		await press("Download summary (Markdown)");
		await waitFor(() => expect(click).toHaveBeenCalled());
		const text = await new Promise<string>((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.readAsText(blobs[0] ?? new Blob([]));
		});
		expect(text).toBe("# Summary text");
		Reflect.deleteProperty(URL, "createObjectURL");
		Reflect.deleteProperty(URL, "revokeObjectURL");
	});

	it("shows the code and request when the meeting does not exist", async () => {
		stubApi({
			"GET /api/v1/auth/me": json(session()),
			[`GET ${MEETING}`]: problem(
				404,
				"not_found",
				`Meeting ${m.mtg} was not found`,
			),
			[`GET ${MEETING}/segments?limit=200`]: problem(404, "not_found"),
			[`GET ${MEETING}/candidates`]: problem(404, "not_found"),
		});
		renderApp(`/meetings/${m.mtg}`);
		expect(await screen.findByText("Meeting could not be loaded")).toBeTruthy();
		expect(screen.getAllByText("not_found").length).toBeGreaterThan(0);
		expect(screen.getAllByText("req-test-1").length).toBeGreaterThan(0);
	});
});
