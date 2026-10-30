import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import type { RuntimeEvidenceResponse, RuntimeRun } from "@tracera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeEvidence } from "../src/runtime-evidence.tsx";
import { json, problem, stubApi } from "./support.tsx";

// TEST DOUBLES ONLY: the evidence below copies the shape of GET /api/v1/patches/{id}/runtime-evidence
// so each state of the panel can be checked without a server or a sandbox.

const PATCH = "pat_01JC9Z3K8Q5V7W2X4Y6Z8A0B9M";
const ROUTE = `GET /api/v1/patches/${PATCH}/runtime-evidence`;
const at = "2026-10-26T09:00:00.000Z";

const step = (
	index: number,
	label: string,
	status: "passed" | "failed" | "skipped",
	extra: Record<string, unknown> = {},
) => ({
	index,
	action: label.startsWith("Expect") ? "expect_text" : "click",
	label,
	status,
	assertion: label.startsWith("Expect"),
	message: null,
	expected: null,
	actual: null,
	...extra,
});

const run = (
	phase: "before" | "after",
	overrides: Record<string, unknown> = {},
): RuntimeRun =>
	({
		run_id: `sbx_${phase === "before" ? "01JC9Z3K8Q5V7W2X4Y6Z8A0BAA" : "01JC9Z3K8Q5V7W2X4Y6Z8A0BBB"}`,
		phase,
		patch_id: phase === "after" ? PATCH : null,
		status: "exited",
		reproduction: {
			status: phase === "before" ? "reproduced" : "not_reproduced",
			reason: null,
		},
		sandbox: { kind: "docker" },
		startup: {
			state: "started",
			reason: null,
			image: "node@sha256:app",
			browser_image: "mcr.microsoft.com/playwright@sha256:browser",
			start: "npm run start",
			port: 4173,
			ready_path: "/health",
			health: {
				ok: true,
				status: 200,
				attempts: 2,
				waited_ms: 640,
				error: null,
			},
			page: { loaded: true, error: null },
		},
		steps:
			phase === "before"
				? [
						step(0, "Click link “Add one Desk lamp”", "passed"),
						step(
							1,
							'Expect test id "shipping" to equal "Shipping: Free"',
							"failed",
							{
								expected: "Shipping: Free",
								actual: "Shipping: $4.99",
							},
						),
						step(2, "Expect no console errors", "skipped"),
					]
				: [
						step(0, "Click link “Add one Desk lamp”", "passed"),
						step(
							1,
							'Expect test id "shipping" to equal "Shipping: Free"',
							"passed",
						),
						step(2, "Expect no console errors", "passed"),
					],
		assertions:
			phase === "before"
				? { passed: 0, failed: 1, skipped: 1 }
				: { passed: 2, failed: 0, skipped: 0 },
		final_path: "/cart?qty=2",
		console_errors: 0,
		page_errors: 0,
		blocked_requests: 0,
		failed_requests: 0,
		screenshot: {
			evidence_id: `evd_${phase}`,
			mime: "image/png",
			bytes: 40_960,
			sha256: "a".repeat(64),
			captured_at: at,
			url: `/api/v1/repro-screenshots/evd_${phase}`,
		},
		started_at: at,
		duration_ms: 5_000,
		...overrides,
	}) as RuntimeRun;

const evidence = (
	overrides: Partial<RuntimeEvidenceResponse> = {},
): RuntimeEvidenceResponse => ({
	patch_id: PATCH,
	investigation_id: "inv_01JC9Z3K8Q5V7W2X4Y6Z8A0B7J",
	sandbox_mode: "docker",
	verification: {
		id: "ver_01JC9Z3K8Q5V7W2X4Y6Z8A0BAN",
		outcome: "verified",
		reproduction_check: { status: "passed", reason: null },
	},
	before: [run("before"), run("before")],
	after: [run("after"), run("after")],
	visual_fix: { claimable: true, reason: "post_patch_assertions_passed" },
	...overrides,
});

function renderPanel() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<RuntimeEvidence patchId={PATCH} />
		</QueryClientProvider>,
	);
}
afterEach(cleanup);

describe("runtime evidence panel", () => {
	it("shows before and after side by side with startup status, step outcomes, and screenshots", async () => {
		stubApi({ [ROUTE]: json(evidence()) });
		renderPanel();
		const before = await screen.findByRole("region", {
			name: "Before: reproduced in sandbox",
		});
		const after = screen.getByRole("region", { name: "After patch: sandbox" });
		expect(within(before).getByText("App started in sandbox")).toBeTruthy();
		expect(
			within(before).getByText(/\/health answered 200 after 2 tries/),
		).toBeTruthy();
		// The failed assertion says what was expected and what the page showed.
		expect(within(before).getByText("Shipping: $4.99")).toBeTruthy();
		expect(within(before).getAllByText("Failed").length).toBe(1);
		expect(within(before).getByText("Skipped")).toBeTruthy();
		expect(within(after).queryByText("Failed")).toBeNull();
		expect(within(after).getAllByText("Passed").length).toBe(3);
		const shots = screen.getAllByRole("img");
		expect(shots.map((img) => img.getAttribute("src"))).toEqual([
			"/api/v1/repro-screenshots/evd_before",
			"/api/v1/repro-screenshots/evd_after",
		]);
		expect(screen.getByText("Post-patch assertions passed")).toBeTruthy();
		expect(
			screen.getByText(/2 assertions passed in each of 2 runs/),
		).toBeTruthy();
		expect(screen.queryByText(/Test double/)).toBeNull();
	});

	it("claims nothing when a post-patch assertion still fails", async () => {
		const failing = run("after", {
			reproduction: { status: "reproduced", reason: null },
			assertions: { passed: 0, failed: 1, skipped: 1 },
			steps: [
				step(
					0,
					'Expect test id "shipping" to equal "Shipping: Free"',
					"failed",
					{ expected: "Shipping: Free", actual: "Shipping: $4.99" },
				),
			],
		});
		stubApi({
			[ROUTE]: json(
				evidence({
					after: [failing, failing],
					visual_fix: {
						claimable: false,
						reason: "post_patch_assertion_failed",
					},
				}),
			),
		});
		renderPanel();
		expect(
			await screen.findByText("No fix is claimed from this evidence"),
		).toBeTruthy();
		expect(
			screen.getByText("An assertion still failed against the patched app."),
		).toBeTruthy();
		expect(screen.queryByText("Post-patch assertions passed")).toBeNull();
	});

	it("shows why the app did not start, with no screenshot to look at", async () => {
		const down = run("after", {
			status: "exited",
			reproduction: { status: "blocked", reason: "app_start_failed" },
			startup: {
				...run("after").startup,
				state: "failed",
				reason: "health_check_failed",
				health: {
					ok: false,
					status: null,
					attempts: 120,
					waited_ms: 45_000,
					error: "ECONNREFUSED",
				},
				page: { loaded: false, error: null },
			},
			steps: [],
			assertions: { passed: 0, failed: 0, skipped: 0 },
			screenshot: null,
			final_path: null,
		});
		stubApi({
			[ROUTE]: json(
				evidence({
					after: [down],
					visual_fix: { claimable: false, reason: "post_patch_run_incomplete" },
				}),
			),
		});
		renderPanel();
		expect(
			await screen.findByText("App did not start: health check failed"),
		).toBeTruthy();
		expect(
			screen.getByText(/gave no answer in 45 s \(ECONNREFUSED\)/),
		).toBeTruthy();
		expect(
			screen.getByText(
				/No screenshot was stored for this run: the app never showed a page/,
			),
		).toBeTruthy();
		expect(screen.getByText("No step ran in this run.")).toBeTruthy();
	});

	it("labels a test double as not a real sandbox run", async () => {
		stubApi({
			[ROUTE]: json(
				evidence({
					before: [run("before", { sandbox: { kind: "fake" } })],
					after: [run("after", { sandbox: { kind: "fake" } })],
				}),
			),
		});
		renderPanel();
		expect(
			await screen.findByText("Test double: not a real sandbox run"),
		).toBeTruthy();
	});

	it("renders nothing for a patch with no browser runs, or when the endpoint is unknown", async () => {
		stubApi({ [ROUTE]: json(evidence({ before: [], after: [] })) });
		const { container } = renderPanel();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(container.textContent).toBe("");
		cleanup();
		stubApi({ [ROUTE]: problem(404, "not_found") });
		const second = renderPanel();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(second.container.textContent).toBe("");
	});

	it("reports a failed load instead of hiding it", async () => {
		stubApi({ [ROUTE]: problem(500, "internal_error", "boom") });
		renderPanel();
		expect(
			await screen.findByText("Runtime evidence could not be loaded"),
		).toBeTruthy();
	});

	it("replaces a missing screenshot file with a plain note", async () => {
		stubApi({ [ROUTE]: json(evidence()) });
		renderPanel();
		const before = await screen.findByRole("region", {
			name: "Before: reproduced in sandbox",
		});
		fireEvent.error(within(before).getByRole("img"));
		expect(
			within(before).getByText(/its file is not available on this server/),
		).toBeTruthy();
		expect(within(before).queryByRole("img")).toBeNull();
		// The other run's picture is untouched.
		expect(screen.getAllByRole("img")).toHaveLength(1);
	});
});

describe("runtime evidence panel when the sandbox is disabled", () => {
	const NO_SANDBOX =
		"No sandbox in this environment: the app was not started and nothing was verified here";
	const disabled = (
		verification: RuntimeEvidenceResponse["verification"],
	): RuntimeEvidenceResponse =>
		evidence({ sandbox_mode: "disabled", before: [], after: [], verification });

	it.each([
		[
			"a blocked verification with its reason",
			{
				id: "ver_01JC9Z3K8Q5V7W2X4Y6Z8A0BAN",
				outcome: "blocked",
				reproduction_check: {
					status: "blocked",
					reason: "sandbox_unavailable",
				},
			},
			"Blocked",
			"Reproduction check: blocked (sandbox unavailable)",
		],
		[
			"a verification that was not attempted",
			{
				id: "ver_01JC9Z3K8Q5V7W2X4Y6Z8A0BAN",
				outcome: "not_attempted",
				reproduction_check: null,
			},
			"Not attempted",
			null,
		],
	])(
		"says nothing ran here and shows the outcome as reported: %s",
		async (_name, verification, outcome, check) => {
			stubApi({ [ROUTE]: json(disabled(verification)) });
			const { container } = renderPanel();
			expect(await screen.findByText(NO_SANDBOX)).toBeTruthy();
			expect(screen.getByText("Verification outcome:")).toBeTruthy();
			expect(screen.getByText(outcome)).toBeTruthy();
			if (check) expect(container.textContent).toContain(check);
			else expect(container.textContent).not.toContain("Reproduction check");
			// Never a success state, a picture, or a claim about the patch.
			expect(screen.queryByRole("img")).toBeNull();
			expect(
				screen.queryByRole("region", { name: /^(Before|After)/ }),
			).toBeNull();
			expect(screen.queryByText("Post-patch assertions passed")).toBeNull();
			expect(screen.queryByText("Verified")).toBeNull();
		},
	);

	it("says there is no verification when none was recorded", async () => {
		stubApi({ [ROUTE]: json(disabled(null)) });
		renderPanel();
		expect(await screen.findByText(NO_SANDBOX)).toBeTruthy();
		expect(
			screen.getByText("No verification was recorded for this patch."),
		).toBeTruthy();
		expect(screen.queryByText("Verification outcome:")).toBeNull();
	});

	it("shows recorded runs when there are some, whatever the mode", async () => {
		stubApi({
			[ROUTE]: json(evidence({ sandbox_mode: "disabled" })),
		});
		renderPanel();
		expect(
			await screen.findByRole("region", { name: "After patch: sandbox" }),
		).toBeTruthy();
		expect(screen.queryByText(NO_SANDBOX)).toBeNull();
	});
});
