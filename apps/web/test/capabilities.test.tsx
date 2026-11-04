import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { CapabilitiesResponse } from "@tracera/contracts";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import {
	EnvironmentChip,
	PublicationGate,
	ReproductionNotice,
	VerificationNotice,
} from "../src/capabilities.tsx";
import { type Patch, PatchSchema } from "../src/schemas.ts";
import { json, problem, renderApp, session, stubApi } from "./support.tsx";

// TEST DOUBLES ONLY: replies copy the shape of the server's capability listing so each
// environment's wording and gating can be checked without a server.

const PAT = "pat_01JC9Z3K8Q5V7W2X4Y6Z8A0B9M";
const CAPABILITIES = "GET /api/v1/capabilities";
const at = "2026-10-24T09:00:00.000Z";

const item = (
	id: string,
	label: string,
	status: CapabilitiesResponse["items"][number]["status"],
	reason: string,
) => ({ id, label, status, reason });

const HOSTED: CapabilitiesResponse = {
	environment: "hosted",
	inference: { mode: "live", provider: "nebius" },
	items: [
		item("patch_download", "Patch download", "available", "Download it."),
		item(
			"sandbox_verification",
			"Sandbox reproduction and verification",
			"unavailable",
			"Reproduction and verification need the Docker sandbox, and this hosted environment has none.",
		),
		item(
			"authorized_actions",
			"Apply, commit, and push",
			"unavailable",
			"Applying, committing, and pushing run in the local app.",
		),
	],
};
const LOCAL: CapabilitiesResponse = {
	environment: "local",
	inference: { mode: "mock", provider: "mock" },
	items: [
		item("sandbox_verification", "Sandbox", "available", "Runs in Docker."),
		item("authorized_actions", "Apply", "available", "Can be applied."),
	],
};

function withClient(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const patch = (overrides: Record<string, unknown> = {}): Patch =>
	PatchSchema.parse({
		id: PAT,
		investigation_id: "inv_01JC9Z3K8Q5V7W2X4Y6Z8A0B7J",
		hypothesis_handle: "HYP-1",
		attempt: 1,
		status: "approved",
		base_commit: "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c",
		summary: "Multiply price by quantity",
		rationale: "The reduce ignored the quantity.",
		expected_effect: "Totals include quantities.",
		risks: [],
		files: [
			{
				path: "src/total.js",
				change_type: "modified",
				additions: 1,
				deletions: 1,
			},
		],
		diff_sha256: "a".repeat(64),
		apply_error: null,
		impact: null,
		verification: {
			id: "ver_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
			outcome: "not_attempted",
			label: "Not attempted",
			outcome_reasons: ["sandbox_unavailable"],
		},
		approval: {
			decision: "approved",
			outcome_at_decision: "not_attempted",
			comment: null,
			acknowledged_risks: [],
			decided_by: "usr_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
			decided_at: at,
		},
		model: null,
		created_at: at,
		...overrides,
	});

/** Waits for the one capabilities request to settle, then lets the component re-render. */
async function settled(calls: Array<{ path: string }>) {
	await waitFor(() =>
		expect(calls.some((call) => call.path === "/api/v1/capabilities")).toBe(
			true,
		),
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the environment chip", () => {
	it("names a hosted demo with live inference and what is not usable there", async () => {
		stubApi({ [CAPABILITIES]: json(HOSTED) });
		withClient(<EnvironmentChip />);
		const chip = await screen.findByTitle(
			"Not usable here: Sandbox reproduction and verification, Apply, commit, and push",
		);
		expect(chip.textContent).toContain("Hosted demo");
		expect(chip.textContent).toContain("[live]");
	});

	it("names the local app and flags mock inference", async () => {
		stubApi({ [CAPABILITIES]: json(LOCAL) });
		withClient(<EnvironmentChip />);
		const chip = await screen.findByTitle("Everything listed is usable here");
		expect(chip.textContent).toContain("Local");
		expect(chip.textContent).toContain("[mock]");
	});

	it("shows nothing when the answer cannot be read, rather than a guess", async () => {
		const calls = stubApi({ [CAPABILITIES]: problem(500, "internal_error") });
		const { container } = withClient(<EnvironmentChip />);
		await settled(calls);
		expect(container.innerHTML).toBe("");
	});

	it("is part of the signed-in shell and asks the server once", async () => {
		const calls = stubApi({
			"GET /api/v1/auth/me": json(session()),
			"GET /api/v1/repositories": json({ items: [], next_cursor: null }),
			[CAPABILITIES]: json(HOSTED),
		});
		renderApp("/");
		await screen.findByText(/Hosted demo/);
		expect(
			calls.filter((call) => call.path === "/api/v1/capabilities"),
		).toHaveLength(1);
	});
});

describe("the apply and publish gate", () => {
	it("replaces the panel on a hosted server with an explanation, and keeps the download", async () => {
		stubApi({ [CAPABILITIES]: json(HOSTED) });
		withClient(<PublicationGate patch={patch()} />);
		expect(
			await screen.findByText(
				/Applying, committing, and pushing run in the local app, where Tracera can reach your working tree\. This hosted demo generates and reviews patches\. Download the patch to apply it yourself\./,
			),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Download patch" }).getAttribute("href"),
		).toBe(`/api/v1/patches/${PAT}/download`);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("shows the panel where the server says actions are available", async () => {
		stubApi({
			[CAPABILITIES]: json(LOCAL),
			[`GET /api/v1/patches/${PAT}/actions`]: json({
				target: {
					repository_name: "demo",
					local: true,
					path: "C:/dev/demo",
					base_commit: "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c",
					suggested_branch: `tracera/${PAT}`,
				},
				items: [],
			}),
		});
		withClient(<PublicationGate patch={patch()} />);
		expect(
			await screen.findByRole("button", { name: "Apply to my working tree" }),
		).toBeTruthy();
	});

	it("offers no action when the answer cannot be read", async () => {
		stubApi({ [CAPABILITIES]: problem(500, "internal_error") });
		withClient(<PublicationGate patch={patch()} />);
		expect(
			await screen.findByText(/could not confirm that this environment/),
		).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.getByRole("link", { name: "Download patch" })).toBeTruthy();
	});

	it("shows nothing until the patch is approved", async () => {
		const calls = stubApi({ [CAPABILITIES]: json(HOSTED) });
		const { container } = withClient(
			<PublicationGate patch={patch({ status: "proposed", approval: null })} />,
		);
		await settled(calls);
		expect(container.innerHTML).toBe("");
	});
});

describe("the verification and reproduction notices", () => {
	it("says the fix was not run when the sandbox is unavailable and nothing ran", async () => {
		stubApi({ [CAPABILITIES]: json(HOSTED) });
		withClient(<VerificationNotice patch={patch()} />);
		expect(
			await screen.findByText(
				"No sandbox in this environment: the fix was not run here.",
			),
		).toBeTruthy();
		expect(screen.getByText(/this hosted environment has none/)).toBeTruthy();
	});

	it("does not call a patch unrun when its record shows it was verified elsewhere", async () => {
		const calls = stubApi({ [CAPABILITIES]: json(HOSTED) });
		const { container } = withClient(
			<VerificationNotice
				patch={patch({
					verification: {
						id: "ver_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
						outcome: "verified",
						label: "Reproduced, fixed, and checks passed",
						outcome_reasons: [],
					},
				})}
			/>,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.innerHTML).toBe("");
		expect(calls).toEqual([]);
	});

	it("says nothing when the sandbox is available or the answer is unknown", async () => {
		for (const reply of [json(LOCAL), problem(500, "internal_error")]) {
			const calls = stubApi({ [CAPABILITIES]: reply });
			const { container, unmount } = withClient(
				<VerificationNotice patch={patch()} />,
			);
			await settled(calls);
			expect(container.innerHTML).toBe("");
			unmount();
		}
	});

	it("covers the reproduction section only when no reproduction ran", async () => {
		stubApi({ [CAPABILITIES]: json(HOSTED) });
		for (const baseline of [null, { status: "blocked" }]) {
			const { unmount } = withClient(
				<ReproductionNotice baseline={baseline} />,
			);
			expect(
				await screen.findByText(/nothing was reproduced here/),
			).toBeTruthy();
			unmount();
		}
		const { container } = withClient(
			<ReproductionNotice baseline={{ status: "reproduced" }} />,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.innerHTML).toBe("");
	});
});
