import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.ts";
import {
	RecordingEvidence,
	sendRecording,
	VisualEvidence,
} from "../src/visual-recording.tsx";
import {
	ids,
	json,
	problem,
	renderApp,
	repository,
	session,
} from "./support.tsx";

// TEST DOUBLES ONLY: the API replies copy the server's view of GET /api/v1/bug-reports/{id}/recordings
// (packages/contracts/src/recording.ts) so the screen's handling of each state can be checked, and a fake
// frame source stands in for the browser's video element, which jsdom cannot play.

vi.mock("../src/keyframes.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/keyframes.ts")>();
	const open: import("../src/keyframes.ts").OpenFrameSource = async () => ({
		durationSeconds: 3,
		frameAt: async (_seconds, format) =>
			new Blob([new Uint8Array(64)], { type: format.type }),
		close: () => {},
	});
	return {
		...real,
		extractKeyframes: (
			file: File,
			options: Parameters<typeof real.extractKeyframes>[1] = {},
		) => real.extractKeyframes(file, { ...options, open }),
	};
});

const BUG = "bug_01JC9Z3K8Q5V7W2X4Y6Z8A0B8K";
const REC = "rec_abcdefgh1234";
const F1 = "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C";
const F2 = "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B2D";
const F3 = "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B3E";
const ANALYSIS = "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B4F";
const MEX = "mex_01JC9Z3K8Q5V7W2X4Y6Z8A0B5G";
const at = "2026-10-29T09:00:00.000Z";

const output = {
	summary: "The cart total turns into $NaN after a coupon error.",
	timeline: [
		{
			timestamp_seconds: 7.4,
			statement: "The total reads $NaN",
			basis: "visible",
		},
		{
			timestamp_seconds: 0,
			statement: "The checkout page shows a $49.60 total",
			basis: "visible",
		},
		{
			timestamp_seconds: 3.8,
			statement: "A red banner reports a coupon error",
			basis: "visible",
		},
		{
			timestamp_seconds: 1.5,
			statement: "The user clicked Apply coupon SAVE10",
			basis: "inferred",
		},
	],
	error_messages: [
		{ text: "Error: could not apply coupon SAVE10", timestamp_seconds: 3.8 },
	],
	failing_element: "red banner",
	reproduction_steps: [
		{ step: "Open the checkout page" },
		{ step: "Click Apply coupon SAVE10" },
	],
	missing_information: ["What happened between the frames"],
};

const box = {
	x1: 260,
	y1: 228,
	x2: 476,
	y2: 268,
	width: 1280,
	height: 720,
	confidence: 0.87,
};
const frames = (count = 3) =>
	[F1, F2, F3].slice(0, count).map((id, index) => ({
		id,
		index,
		timestamp_ms: [0, 3800, 7400][index] as number,
		observation: "succeeded",
		regions: index === 1 ? [box] : [],
	}));
const analysis = (overrides: Record<string, unknown> = {}) => ({
	id: ANALYSIS,
	status: "succeeded",
	model: "muse-spark-1.3",
	provider: "meta",
	mode: "live",
	placeholder_provider: false,
	model_execution_id: MEX,
	frames_read: 3,
	output,
	error: null,
	created_at: at,
	...overrides,
});
const recording = (overrides: Record<string, unknown> = {}) => ({
	recording_id: REC,
	name: "checkout.webm",
	duration_ms: 7500,
	frame_count: 3,
	status: "succeeded",
	error: null,
	frames: frames(),
	region_phrase: "red banner",
	analysis: analysis(),
	...overrides,
});

type Seen = {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body: unknown;
};
/** Replaces fetch; the handler answers by request, anything else is a 404. */
function serve(handler: (seen: Seen) => Response | undefined): Seen[] {
	const seen: Seen[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init: RequestInit = {}) => {
			const entry: Seen = {
				method: init.method ?? "GET",
				url: new URL(input, "http://localhost"),
				headers: { ...(init.headers as Record<string, string>) },
				body: init.body,
			};
			seen.push(entry);
			return (
				handler(entry) ??
				problem(404, "not_found", `No test reply for ${entry.method} ${input}`)
			);
		}),
	);
	return seen;
}

const RECORDINGS = `/api/v1/bug-reports/${BUG}/recordings`;
const listing = (recordings: unknown[]) => (seen: Seen) =>
	seen.method === "GET" && seen.url.pathname === RECORDINGS
		? json({ recordings })
		: undefined;

function show(props: { active?: boolean } = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<RecordingEvidence bugReportId={BUG} version={1} {...props} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const panel = (name: string) =>
	screen
		.getByRole("heading", { level: 3, name })
		.closest("section") as HTMLElement;
const video = (name = "demo.webm", type = "video/webm") =>
	new File([new Uint8Array(1000)], name, { type });

describe("a screen recording on the investigation page", () => {
	it("keeps what the keyframes show, what is inferred, and what is missing in separate panels", async () => {
		serve(listing([recording()]));
		const { container } = show();
		await screen.findByRole("heading", { level: 2, name: "Screen recording" });

		// Worded as sampled keyframes at stated times, never as a watched video.
		expect(
			screen.getByText(
				/Analyzed 3 keyframes sampled at these timestamps: 0:00\.0, 0:03\.8, 0:07\.4\./,
			),
		).toBeTruthy();
		expect(screen.getByText(/Only the frames were uploaded/)).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/watched/i);

		const seen = within(panel("Seen in the keyframes"));
		expect(seen.getByText(/turns into \$NaN/)).toBeTruthy();
		expect(seen.getByText("red banner")).toBeTruthy();
		expect(seen.getByText("Error: could not apply coupon SAVE10")).toBeTruthy();
		// The visible timeline is in time order, whatever order the model gave.
		const timeline = within(
			seen.getByText("What is visible, by time").parentElement as HTMLElement,
		);
		expect(
			timeline.getAllByRole("listitem").map((item) => item.textContent),
		).toEqual([
			"0:00.0 The checkout page shows a $49.60 total",
			"0:03.8 A red banner reports a coupon error",
			"0:07.4 The total reads $NaN",
		]);
		expect(seen.queryByText(/clicked Apply coupon/)).toBeNull();

		const guessed = within(panel("Model inferences about the recording"));
		expect(
			guessed.getByText(/The user clicked Apply coupon SAVE10/),
		).toBeTruthy();
		expect(guessed.getByText("Open the checkout page")).toBeTruthy();
		expect(guessed.getByText(/a guess, not a verified procedure/)).toBeTruthy();
		expect(guessed.queryByText(/\$NaN/)).toBeNull();
		expect(
			within(panel("Not determinable from the keyframes")).getByText(
				"What happened between the frames",
			),
		).toBeTruthy();

		expect(screen.getByText("[live]")).toBeTruthy();
		expect(screen.getByText("muse-spark-1.3 via meta")).toBeTruthy();
		expect(screen.queryByText("Placeholder provider")).toBeNull();
		expect(document.body.textContent).not.toMatch(
			/confirmed|root cause|tests pass/i,
		);

		// The frame with the located region is shown first, with the region drawn as a display aid.
		const image = screen.getByRole("img", {
			name: "Keyframe 2 of 3 at 0:03.8",
		}) as HTMLImageElement;
		expect(image.getAttribute("src")).toBe(`/api/v1/evidence/${F2}/content`);
		const overlay = container.querySelector('[data-region="red banner"]');
		expect(overlay).toBeTruthy();
		expect(
			screen.getByText(/located here by a segmentation model/),
		).toBeTruthy();

		// Choosing another frame shows it without the region.
		const strip = within(screen.getByRole("list", { name: "Keyframes" }));
		fireEvent.click(strip.getAllByRole("button")[0] as HTMLElement);
		const first = screen.getByRole("img", {
			name: "Keyframe 1 of 3 at 0:00.0",
		}) as HTMLImageElement;
		expect(first.getAttribute("src")).toBe(`/api/v1/evidence/${F1}/content`);
		expect(container.querySelector("[data-region]")).toBeNull();
		expect(strip.getAllByRole("button")[0]?.getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	it("labels a mock analysis as a mock", async () => {
		serve(
			listing([
				recording({
					analysis: analysis({
						mode: "mock",
						provider: "mock",
						model: "mock-reasoner",
					}),
				}),
			]),
		);
		show();
		expect(await screen.findByText("[mock]")).toBeTruthy();
		expect(
			screen.getByText(/No model looked at these frames; the fields below/),
		).toBeTruthy();
	});

	it("analyzes only the keyframes that were read and says how many were not", async () => {
		serve(
			listing([
				recording({
					frames: frames().map((frame) =>
						frame.index === 2 ? { ...frame, observation: "failed" } : frame,
					),
				}),
			]),
		);
		show();
		expect(
			await screen.findByText(
				/Analyzed 2 keyframes sampled at these timestamps: 0:00.0, 0:03.8./,
			),
		).toBeTruthy();
		expect(
			screen.getByText(/1 of the 3 keyframes could not be read/),
		).toBeTruthy();
	});

	it("says when the segmentation model drew no region for the failing element", async () => {
		serve(
			listing([
				recording({
					frames: frames().map((frame) => ({ ...frame, regions: [] })),
				}),
			]),
		);
		const { container } = show();
		expect(
			await screen.findByText(/No region is drawn for/, { exact: false }),
		).toBeTruthy();
		expect(container.querySelector("[data-region]")).toBeNull();
		expect(
			screen.queryByText(/located here by a segmentation model/),
		).toBeNull();
	});

	it("shows arriving, queued, and running recordings without claiming an analysis", async () => {
		serve(
			listing([
				recording({
					status: "receiving",
					frames: frames(2),
					frame_count: 5,
					analysis: null,
					region_phrase: null,
				}),
			]),
		);
		const view = show();
		expect(
			await screen.findByText("Receiving keyframes (2 of 5)"),
		).toBeTruthy();
		expect(
			screen.getByText(
				/2 of 5 keyframes sampled from the recording have arrived/,
			),
		).toBeTruthy();
		expect(
			screen.getByText(/starts when every keyframe has arrived/),
		).toBeTruthy();
		expect(screen.queryByText(/Analyzed \d+ keyframe/)).toBeNull();
		expect(
			screen.queryByRole("heading", {
				level: 3,
				name: "Seen in the keyframes",
			}),
		).toBeNull();
		view.unmount();

		for (const [status, text] of [
			["queued", "Waiting for the keyframes to be analyzed…"],
			["processing", "Reading the keyframes…"],
		] as const) {
			serve(
				listing([recording({ status, analysis: null, region_phrase: null })]),
			);
			const next = show();
			expect(await screen.findByText(text)).toBeTruthy();
			expect(screen.queryByText(/Analyzed \d+ keyframe/)).toBeNull();
			next.unmount();
		}
	});

	it("shows why an analysis failed and asks for another one", async () => {
		const seen = serve((request) =>
			request.method === "POST" && request.url.pathname === RECORDINGS
				? json({ job: { status: "queued" } }, 202)
				: listing([
						recording({
							status: "failed",
							analysis: null,
							region_phrase: null,
							error: {
								code: "frames_unreadable",
								message: "None of the keyframes could be read",
							},
						}),
					])(request),
		);
		show();
		expect(await screen.findByText("frames_unreadable")).toBeTruthy();
		expect(
			screen.getByText(/None of the keyframes could be read/),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() =>
			expect(seen.some((s) => s.method === "POST")).toBe(true),
		);
		const retry = seen.find((s) => s.method === "POST");
		expect(retry?.headers["x-tracera-csrf"]).toBe("1");
		expect(JSON.parse(String(retry?.body))).toEqual({ recording_id: REC });
	});

	it("offers only a way to attach a recording when the bug report has none", async () => {
		serve(listing([]));
		show();
		expect(await screen.findByText("Attach a screen recording")).toBeTruthy();
		expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
	});

	it("is shown beside the screenshots on the investigation page", async () => {
		serve((request) =>
			request.url.pathname === `/api/v1/bug-reports/${BUG}`
				? json({ bug_report: { id: BUG, evidence: [] } })
				: listing([recording()])(request),
		);
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={queryClient}>
				<MemoryRouter>
					<VisualEvidence bugReportId={BUG} version={1} />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		expect(
			await screen.findByRole("heading", {
				level: 2,
				name: "Screen recording",
			}),
		).toBeTruthy();
		expect(screen.queryByRole("heading", { name: "Screenshot" })).toBeNull();
	});
});

const isFrameUpload = (s: Seen) =>
	s.method === "POST" &&
	s.url.pathname === `/api/v1/bug-reports/${BUG}/evidence`;
const partsOf = (s: Seen) => {
	const form = s.body as FormData;
	return {
		file: form.get("file") as File,
		meta: JSON.parse(String(form.get("meta"))) as {
			kind: string;
			source_recording: Record<string, unknown>;
		},
	};
};

describe("sending a recording as keyframes", () => {
	const frameUploads = (seen: Seen[]) => seen.filter(isFrameUpload);
	const accept = (seen: Seen) =>
		isFrameUpload(seen)
			? json({ evidence: { id: F1, kind: "screenshot" } }, 201)
			: undefined;

	it("uploads only the frames, in order, with their tags, and never the recording", async () => {
		const seen = serve(accept);
		const file = video("checkout.webm");
		const sent = await sendRecording(BUG, file, { recordingId: REC });
		expect(sent).toEqual({ recordingId: REC, frames: 12 });

		const uploads = frameUploads(seen);
		expect(uploads).toHaveLength(12);
		expect(seen).toHaveLength(12);
		expect(uploads.map((u) => partsOf(u).meta.source_recording.index)).toEqual(
			Array.from({ length: 12 }, (_, i) => i),
		);
		const first = uploads[0] as Seen;
		expect(first.headers["x-tracera-csrf"]).toBe("1");
		expect(partsOf(first).meta).toEqual({
			kind: "screenshot",
			source_recording: {
				recording_id: REC,
				name: "checkout.webm",
				index: 0,
				count: 12,
				timestamp_ms: 0,
				duration_ms: 3000,
			},
		});
		expect(partsOf(uploads.at(-1) as Seen).meta.source_recording).toMatchObject(
			{ index: 11, timestamp_ms: 2900 },
		);
		// Only still images are sent, never the recording.
		for (const upload of uploads) {
			const sentFile = partsOf(upload).file;
			expect(sentFile.type).toBe("image/png");
			expect(sentFile.name).toMatch(/^keyframe-\d+\.png$/);
			expect(sentFile.size).toBeLessThan(file.size);
		}
	});

	it("stops at the first refused frame and says why", async () => {
		let count = 0;
		const seen = serve((request) =>
			isFrameUpload(request) && ++count === 3
				? problem(409, "recording_mismatch", "A different number of frames")
				: accept(request),
		);
		const error = await sendRecording(BUG, video(), { recordingId: REC }).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ status: 409, code: "recording_mismatch" });
		expect(frameUploads(seen)).toHaveLength(3);
	});

	it("reports progress while it reads and uploads", async () => {
		serve(accept);
		const steps: string[] = [];
		await sendRecording(BUG, video(), {
			recordingId: REC,
			onProgress: ({ phase, done, total }) =>
				steps.push(`${phase} ${done}/${total}`),
		});
		expect(steps[0]).toBe("reading 1/12");
		expect(steps).toContain("reading 12/12");
		expect(steps).toContain("uploading 1/12");
		expect(steps.at(-1)).toBe("uploading 12/12");
	});

	it("attaches a recording to a bug report that has none", async () => {
		const seen = serve((request) => accept(request) ?? listing([])(request));
		show();
		fireEvent.click(await screen.findByText("Attach a screen recording"));
		const input = screen.getByLabelText(/Screen recording/) as HTMLInputElement;
		const attach = screen.getByRole("button", { name: "Attach recording" });
		expect((attach as HTMLButtonElement).disabled).toBe(true);

		// A file that is not a video is refused and not sent.
		fireEvent.change(input, {
			target: { files: [video("notes.png", "image/png")] },
		});
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Use a video file such as WebM, MP4, or MOV.",
		);
		expect((attach as HTMLButtonElement).disabled).toBe(true);

		fireEvent.change(input, { target: { files: [video()] } });
		await waitFor(() =>
			expect((attach as HTMLButtonElement).disabled).toBe(false),
		);
		fireEvent.click(attach);
		await waitFor(() => expect(frameUploads(seen)).toHaveLength(12));
		// The list is read again once the frames are in.
		await waitFor(() =>
			expect(
				seen.filter((s) => s.method === "GET" && s.url.pathname === RECORDINGS)
					.length,
			).toBeGreaterThan(1),
		);
	});
});

describe("the new investigation form with a recording", () => {
	const INV = "inv_01JC9Z3K8Q5V7W2X4Y6Z8A0B7J";
	const bug = {
		id: BUG,
		status: "open",
		source_channel: "web",
		title: "Total is NaN",
		description: "Applying SAVE10 makes the total NaN.",
		expected_behavior: null,
		actual_behavior: null,
		steps: [],
		environment: {},
		severity: "unknown",
		repository_id: ids.repo,
		normalization: { status: "not_requested", summary: null },
		created_at: at,
	};
	const created = {
		id: INV,
		status: "queued",
		state_version: 1,
		current_stage: null,
		mode: "analysis_only",
		mode_reason: null,
		model_profile: "standard",
		interactive: true,
		bug_report_id: BUG,
		repository_id: ids.repo,
		commit_sha: "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c",
		flags: [],
		progress: { stage_index: 0, stage_count: 10, message: "Queued" },
		steps: [],
		needs_input: null,
		counts: { findings: 0, hypotheses: 0, reproductions: 0, patches: 0 },
		baseline_reproduction: null,
		latest_patch: null,
		latest_verification: null,
		inference: { provider: "mock", mock: true, escalation_available: false },
		failure: null,
		created_at: at,
		started_at: null,
		finished_at: null,
	};

	function routes(failFrame = 0) {
		let frames = 0;
		return serve((request) => {
			const { pathname } = request.url;
			if (request.method === "GET" && pathname === "/api/v1/auth/me")
				return json(session());
			if (request.method === "GET" && pathname === "/api/v1/repositories")
				return json({ items: [repository()], next_cursor: null });
			if (request.method === "POST" && pathname === "/api/v1/bug-reports")
				return json({ bug_report: bug }, 201);
			if (isFrameUpload(request)) {
				frames += 1;
				return frames === failFrame
					? problem(413, "payload_too_large", "The image is too large")
					: json({ evidence: { id: F1, kind: "screenshot" } }, 201);
			}
			if (request.method === "POST" && pathname === "/api/v1/investigations")
				return json({ investigation: created }, 201);
			return undefined;
		});
	}

	async function fillIn(file: File | null) {
		await screen.findByLabelText("Title");
		fireEvent.change(screen.getByLabelText("Title"), {
			target: { value: "Total is NaN" },
		});
		fireEvent.change(screen.getByLabelText("What happened"), {
			target: { value: "Applying SAVE10 makes the total NaN." },
		});
		if (file)
			fireEvent.change(screen.getByLabelText(/Screen recording/), {
				target: { files: [file] },
			});
	}

	it("sends the report, then the keyframes, then starts the investigation", async () => {
		const seen = routes();
		const { router } = renderApp("/investigations/new");
		await fillIn(video("checkout.webm"));
		fireEvent.click(
			screen.getByRole("button", { name: "Start investigation" }),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/investigations/${INV}`),
		);
		const order = seen
			.filter((s) => s.method === "POST")
			.map((s) =>
				isFrameUpload(s) ? "frame" : s.url.pathname.replace("/api/v1/", ""),
			);
		expect(order).toEqual([
			"bug-reports",
			...Array.from({ length: 12 }, () => "frame"),
			"investigations",
		]);
	});

	it("keeps the bug report and offers a retry or a start without the recording when a frame is refused", async () => {
		const seen = routes(5);
		const { router } = renderApp("/investigations/new");
		await fillIn(video());
		fireEvent.click(
			screen.getByRole("button", { name: "Start investigation" }),
		);
		expect(
			await screen.findByText(
				"The bug report was saved, but its recording could not be sent",
			),
		).toBeTruthy();
		expect(screen.getByText(/The image is too large/)).toBeTruthy();
		// The investigation was not started.
		expect(seen.some((s) => s.url.pathname === "/api/v1/investigations")).toBe(
			false,
		);
		expect(router.state.location.pathname).toBe("/investigations/new");

		fireEvent.click(
			screen.getByRole("button", { name: "Start without the recording" }),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/investigations/${INV}`),
		);
		// One bug report only, and the frames that were refused were not sent again.
		expect(
			seen.filter(
				(s) => s.method === "POST" && s.url.pathname === "/api/v1/bug-reports",
			),
		).toHaveLength(1);
	});

	it("starts at once when no recording was chosen", async () => {
		const seen = routes();
		const { router } = renderApp("/investigations/new");
		await fillIn(null);
		fireEvent.click(
			screen.getByRole("button", { name: "Start investigation" }),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/investigations/${INV}`),
		);
		expect(seen.some(isFrameUpload)).toBe(false);
	});
});
