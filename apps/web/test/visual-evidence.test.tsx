import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
	ScreenshotEvidence,
	validateScreenshot,
} from "../src/visual-evidence.tsx";
import {
	ids,
	json,
	problem,
	renderApp,
	repository,
	session,
	stubApi,
} from "./support.tsx";

// TEST DOUBLES ONLY: the API replies copy the server's view of GET /api/v1/evidence/{id}/observations
// (packages/contracts/src/visual.ts) so the screen's handling of each reading state can be checked.

const BUG = "bug_01JC9Z3K8Q5V7W2X4Y6Z8A0B8K";
const SHOT = "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C";
const DERIVED = "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B2D";
const MEX = "mex_01JC9Z3K8Q5V7W2X4Y6Z8A0B3E";
const at = "2026-10-29T09:00:00.000Z";

const bugReport = (evidence: unknown[] = [screenshot()]) =>
	json({ bug_report: { id: BUG, evidence } });
const screenshot = () => ({
	id: SHOT,
	kind: "screenshot",
	origin: "user_provided",
	mime_type: "image/png",
	size_bytes: 31_706,
	created_at: at,
});

const output = {
	summary: "A checkout page whose total reads $NaN.",
	visible_text: [
		{ text: "Total: $NaN", location: "order summary" },
		{ text: "Place order", location: "order summary button" },
	],
	error_messages: [
		{
			text: "Error: could not apply coupon SAVE10",
			location: "red banner below the heading",
		},
	],
	ui_elements: [
		{
			kind: "button",
			label: "Place order",
			state: "disabled",
			location: "order summary",
		},
	],
	observed_failure: "The order summary shows $NaN for the total.",
	observations: [{ statement: "The Total line reads $NaN", basis: "visible" }],
	inferences: [
		{
			statement: "The coupon discount is probably undefined",
			confidence: "medium",
		},
	],
	missing_information: ["The page address"],
};

const reading = (overrides: Record<string, unknown> = {}) => ({
	id: DERIVED,
	status: "succeeded",
	provenance: {
		task: "observe_screenshot",
		prompt_version: "observe_screenshot.v1",
		model: "muse-spark-1.3",
		provider: "meta",
		mode: "live",
		placeholder_provider: false,
		model_execution_id: MEX,
		source_evidence_id: SHOT,
		source_sha256: "0".repeat(64),
		redaction_count: 0,
	},
	output,
	error: null,
	created_at: at,
	...overrides,
});

const observations = (list: unknown[]) =>
	json({
		evidence_id: SHOT,
		kind: "screenshot",
		mime_type: "image/png",
		observations: list,
	});

const BUG_PATH = `GET /api/v1/bug-reports/${BUG}`;
const OBS_PATH = `GET /api/v1/evidence/${SHOT}/observations`;

function show(props: { active?: boolean } = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<ScreenshotEvidence bugReportId={BUG} version={1} {...props} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const panel = (name: string) =>
	screen
		.getByRole("heading", { level: 3, name })
		.closest("section") as HTMLElement;

describe("attaching a screenshot", () => {
	it.each([
		[{ type: "image/png", size: 10 }, null],
		[{ type: "image/jpeg", size: 10 }, null],
		[{ type: "image/webp", size: 10 }, null],
		[{ type: "image/gif", size: 10 }, "Use a PNG, JPEG, or WebP image."],
		[{ type: "image/svg+xml", size: 10 }, "Use a PNG, JPEG, or WebP image."],
		[{ type: "image/png", size: 0 }, "The file is empty."],
	])("checks %j", (file, expected) => {
		expect(validateScreenshot(file)).toBe(expected);
	});

	it("names the limit when an image is too large", () => {
		expect(
			validateScreenshot({ type: "image/png", size: 9 * 1024 * 1024 }),
		).toBe("The image is 9.0 MB; the limit is 8.0 MB.");
	});
});

describe("screenshot evidence on the investigation page", () => {
	it("shows the image and keeps what is visible, what is inferred, and what is missing in separate panels", async () => {
		stubApi({ [BUG_PATH]: bugReport(), [OBS_PATH]: observations([reading()]) });
		show();
		const image = (await screen.findByRole("img", {
			name: /Screenshot 1/,
		})) as HTMLImageElement;
		expect(image.getAttribute("src")).toBe(`/api/v1/evidence/${SHOT}/content`);
		await screen.findByRole("heading", {
			level: 3,
			name: "Observed in screenshot",
		});

		const observed = within(panel("Observed in screenshot"));
		expect(
			observed.getByText("The order summary shows $NaN for the total."),
		).toBeTruthy();
		expect(
			observed.getByText("Error: could not apply coupon SAVE10"),
		).toBeTruthy();
		expect(observed.getByText("The Total line reads $NaN")).toBeTruthy();
		expect(observed.queryByText(/probably undefined/)).toBeNull();

		const inferred = within(panel("Model inferences"));
		expect(
			inferred.getByText("The coupon discount is probably undefined"),
		).toBeTruthy();
		expect(inferred.getByText("medium confidence")).toBeTruthy();
		expect(inferred.queryByText(/\$NaN/)).toBeNull();

		expect(
			within(panel("Missing information")).getByText("The page address"),
		).toBeTruthy();
		expect(screen.getByText("[live]")).toBeTruthy();
		expect(screen.getByText("muse-spark-1.3 via meta")).toBeTruthy();
		expect(screen.queryByText("Placeholder provider")).toBeNull();
		// The panels never claim confirmation: inferences are explicitly unverified.
		expect(screen.queryByText(/confirmed|root cause|tests pass/i)).toBeNull();
	});

	it("labels a mock reading as a mock and a non-Meta provider as a placeholder", async () => {
		stubApi({
			[BUG_PATH]: bugReport(),
			[OBS_PATH]: observations([
				reading({
					provenance: {
						...reading().provenance,
						mode: "mock",
						provider: "mock",
						model: "mock-vision",
					},
					output: {
						...output,
						summary: "Mock inference: no model looked at this image.",
					},
				}),
			]),
		});
		show();
		expect(await screen.findByText("[mock]")).toBeTruthy();
		expect(
			screen.getByText(/No model looked at this image; the fields below/),
		).toBeTruthy();
	});

	it("flags a reading from a placeholder provider", async () => {
		stubApi({
			[BUG_PATH]: bugReport(),
			[OBS_PATH]: observations([
				reading({
					provenance: {
						...reading().provenance,
						provider: "nebius",
						model: "google/gemma-3-27b-it",
						placeholder_provider: true,
					},
				}),
			]),
		});
		show();
		expect(await screen.findByText("Placeholder provider")).toBeTruthy();
		expect(screen.getByText("[live]")).toBeTruthy();
	});

	it("offers to read an unread screenshot and sends the request with the CSRF header", async () => {
		const calls = stubApi({
			[BUG_PATH]: bugReport(),
			[OBS_PATH]: observations([]),
			[`POST /api/v1/evidence/${SHOT}/observations`]: json(
				{ job: { status: "queued" } },
				202,
			),
		});
		show();
		fireEvent.click(
			await screen.findByRole("button", { name: "Read screenshot" }),
		);
		expect(await screen.findByText("Reading the screenshot…")).toBeTruthy();
		const post = calls.find((call) => call.method === "POST");
		expect(post?.path).toBe(`/api/v1/evidence/${SHOT}/observations`);
		expect(post?.headers["x-tracera-csrf"]).toBe("1");
	});

	it("shows why a reading failed and offers another try", async () => {
		stubApi({
			[BUG_PATH]: bugReport(),
			[OBS_PATH]: observations([
				reading({
					status: "failed",
					output: null,
					error: {
						code: "image_too_large",
						message: "The image is 9437184 bytes; the limit is 8388608",
					},
				}),
			]),
		});
		show();
		expect(
			await screen.findByText("The screenshot could not be read"),
		).toBeTruthy();
		expect(screen.getByText("image_too_large")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
		expect(screen.queryByText("Model inferences")).toBeNull();
	});

	it("keeps the last good reading when a later attempt failed", async () => {
		stubApi({
			[BUG_PATH]: bugReport(),
			[OBS_PATH]: observations([
				reading({
					id: "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B4F",
					status: "failed",
					output: null,
					error: {
						code: "provider_unavailable",
						message: "Model provider error 503",
					},
				}),
				reading(),
			]),
		});
		show();
		expect(await screen.findByText("Observed in screenshot")).toBeTruthy();
		expect(
			screen.getByText(
				/A later attempt to read it failed \(provider_unavailable\)/,
			),
		).toBeTruthy();
	});

	it("renders nothing for a bug report without screenshots", async () => {
		const calls = stubApi({ [BUG_PATH]: bugReport([]) });
		const { container } = show();
		await waitFor(() =>
			expect(
				calls.some((call) => call.path === `/api/v1/bug-reports/${BUG}`),
			).toBe(true),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(container.textContent).toBe("");
		expect(calls.some((call) => call.path.includes("/observations"))).toBe(
			false,
		);
	});
});

const READY = "GET /readyz";
const LOC_PATH = `GET /api/v1/evidence/${SHOT}/locations`;
const ready = (mode: string) =>
	json({
		status: "ready",
		worker: "ok",
		sandbox: null,
		inference_provider: mode,
		inference_mode: mode,
	});
const location = (overrides: Record<string, unknown> = {}) => ({
	id: "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B5G",
	phrase: "button",
	status: "succeeded",
	provenance: {
		task: "locate_ui_element",
		prompt_version: "locate_ui_element.v1",
		model: "sam-3.1",
		provider: "meta",
		mode: "live",
		placeholder_provider: false,
		model_execution_id: MEX,
		source_evidence_id: SHOT,
		source_sha256: "0".repeat(64),
		phrase: "button",
	},
	boxes: [
		{
			x1: 794,
			y1: 541,
			x2: 911,
			y2: 578,
			width: 1280,
			height: 800,
			confidence: 0.73,
		},
	],
	error: null,
	created_at: at,
	...overrides,
});
const locations = (list: unknown[]) =>
	json({ evidence_id: SHOT, locations: list });

describe("locating an element on the screenshot", () => {
	it("is offered only when the server runs on a provider with a segmentation model", async () => {
		stubApi({
			[BUG_PATH]: bugReport(),
			[OBS_PATH]: observations([reading()]),
			[READY]: ready("mock"),
		});
		show();
		await screen.findByRole("heading", {
			level: 3,
			name: "Observed in screenshot",
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(screen.queryByText("Locate on the screenshot")).toBeNull();
	});

	it("draws located regions in percent of the image and calls them AI-located", async () => {
		stubApi({
			[BUG_PATH]: bugReport(),
			[OBS_PATH]: observations([reading()]),
			[READY]: ready("meta"),
			[LOC_PATH]: locations([location()]),
		});
		show();
		const region = await waitFor(() => {
			const found = document.querySelector(
				'[data-region="button"]',
			) as HTMLElement | null;
			if (!found) throw new Error("no region yet");
			return found;
		});
		expect(Number.parseFloat(region.style.left)).toBeCloseTo(
			(794 / 1280) * 100,
			3,
		);
		expect(Number.parseFloat(region.style.top)).toBeCloseTo(
			(541 / 800) * 100,
			3,
		);
		expect(Number.parseFloat(region.style.width)).toBeCloseTo(
			(118 / 1280) * 100,
			3,
		);
		expect(Number.parseFloat(region.style.height)).toBeCloseTo(
			(38 / 800) * 100,
			3,
		);
		expect(
			screen.getByText(/AI-located regions: where a model says it is/),
		).toBeTruthy();
		expect(screen.getByText("1 region · confidence 0.73")).toBeTruthy();
		expect(screen.getByText("sam-3.1 via meta")).toBeTruthy();

		fireEvent.click(screen.getByRole("checkbox"));
		expect(document.querySelector('[data-region="button"]')).toBeNull();
	});

	it("suggests the kinds of element the reading names and sends the phrase", async () => {
		const calls = stubApi({
			[BUG_PATH]: bugReport(),
			[OBS_PATH]: observations([reading()]),
			[READY]: ready("meta"),
			[LOC_PATH]: locations([]),
			[`POST /api/v1/evidence/${SHOT}/locate`]: json(
				{ job: { status: "queued" } },
				202,
			),
		});
		show();
		fireEvent.click(await screen.findByRole("button", { name: "button" }));
		expect(
			(screen.getByLabelText("Locate on the screenshot") as HTMLInputElement)
				.value,
		).toBe("button");
		fireEvent.click(screen.getByRole("button", { name: "Locate" }));
		expect(await screen.findByText("Locating…")).toBeTruthy();
		const post = calls.find((call) => call.method === "POST");
		expect(post?.body).toEqual({ phrase: "button" });
		expect(post?.headers["x-tracera-csrf"]).toBe("1");
	});

	it("reports nothing found and a failed search without drawing anything", async () => {
		stubApi({
			[BUG_PATH]: bugReport(),
			[OBS_PATH]: observations([reading()]),
			[READY]: ready("meta"),
			[LOC_PATH]: locations([
				location({
					id: "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B6H",
					phrase: "table",
					boxes: [],
				}),
				location({
					id: "evd_01JC9Z3K8Q5V7W2X4Y6Z8A0B7J",
					phrase: "banner",
					status: "failed",
					boxes: [],
					error: {
						code: "provider_unavailable",
						message: "Model provider error 503",
					},
				}),
			]),
		});
		show();
		expect(await screen.findByText("nothing found")).toBeTruthy();
		expect(screen.getByText("failed (provider_unavailable)")).toBeTruthy();
		expect(document.querySelector("[data-region]")).toBeNull();
	});
});

describe("attaching a screenshot when starting an investigation", () => {
	const REPORT = "POST /api/v1/bug-reports";
	const UPLOAD = `POST /api/v1/bug-reports/${BUG}/evidence`;
	const START = "POST /api/v1/investigations";
	const base = () => ({
		"GET /api/v1/auth/me": json(session()),
		"GET /api/v1/repositories": json({
			items: [repository()],
			next_cursor: null,
		}),
		[REPORT]: json(
			{
				bug_report: {
					id: BUG,
					status: "received",
					source_channel: "web",
					title: "Total shows NaN",
					description: "The total is NaN after a coupon.",
					expected_behavior: null,
					actual_behavior: null,
					steps: [],
					severity: "unknown",
					repository_id: ids.repo,
					normalization: { status: "pending", summary: null },
					created_at: at,
				},
			},
			201,
		),
	});

	async function submitWithScreenshot() {
		renderApp("/investigations/new");
		fireEvent.change(await screen.findByLabelText("Title"), {
			target: { value: "Total shows NaN" },
		});
		fireEvent.change(screen.getByLabelText("What happened"), {
			target: { value: "The total is NaN after a coupon." },
		});
		fireEvent.change(screen.getByLabelText(/Screenshot/), {
			target: {
				files: [
					new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", {
						type: "image/png",
					}),
				],
			},
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Start investigation" }),
		);
	}

	it("uploads the chosen screenshot to the saved report before the investigation starts", async () => {
		const calls = stubApi({
			...base(),
			[UPLOAD]: json({ evidence: { id: SHOT } }, 201),
			[START]: problem(503, "unavailable", "The queue is not available"),
		});
		await submitWithScreenshot();
		await screen.findByText(/the investigation could not start/);
		expect(
			calls.filter((call) => call.method === "POST").map((call) => call.path),
		).toEqual([
			"/api/v1/bug-reports",
			`/api/v1/bug-reports/${BUG}/evidence`,
			"/api/v1/investigations",
		]);
	});

	it("keeps the saved report and offers to go on without the screenshot when it cannot be attached", async () => {
		const calls = stubApi({
			...base(),
			[UPLOAD]: problem(413, "payload_too_large", "Images are limited to 8 MB"),
			[START]: problem(503, "unavailable", "The queue is not available"),
		});
		await submitWithScreenshot();
		expect(
			await screen.findByText(
				"The bug report was saved, but its screenshot could not be attached",
			),
		).toBeTruthy();
		expect(screen.getByText(/Images are limited to 8 MB/)).toBeTruthy();
		expect(calls.some((call) => call.path === "/api/v1/investigations")).toBe(
			false,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Start the investigation without the screenshot",
			}),
		);
		await waitFor(() =>
			expect(calls.some((call) => call.path === "/api/v1/investigations")).toBe(
				true,
			),
		);
	});
});
