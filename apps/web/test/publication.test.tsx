import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PublicationPanel } from "../src/publication.tsx";
import { type Patch, PatchSchema } from "../src/schemas.ts";
import { json, problem, stubApi } from "./support.tsx";

// TEST DOUBLES ONLY: replies copy the server's view functions (see src/schemas.ts) so the panel's
// states can be checked without a server or a repository.

const PAT = "pat_01JC9Z3K8Q5V7W2X4Y6Z8A0B9M";
const BASE = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c";
const at = "2026-10-24T09:00:00.000Z";
const ACTIONS = `/api/v1/patches/${PAT}/actions`;

const patch = (overrides: Record<string, unknown> = {}): Patch =>
	PatchSchema.parse({
		id: PAT,
		investigation_id: "inv_01JC9Z3K8Q5V7W2X4Y6Z8A0B7J",
		hypothesis_handle: "HYP-1",
		attempt: 1,
		status: "approved",
		base_commit: BASE,
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
			outcome: "verified",
			label: "Reproduced, fixed, and checks passed",
			outcome_reasons: [],
		},
		approval: {
			decision: "approved",
			outcome_at_decision: "verified",
			comment: null,
			acknowledged_risks: [],
			decided_by: "usr_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
			decided_at: at,
		},
		model: null,
		created_at: at,
		...overrides,
	});

const action = (overrides: Record<string, unknown> = {}) => ({
	id: "act_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
	kind: "apply",
	status: "succeeded",
	acknowledged_outcome: "verified",
	params: {},
	result: {
		changed_files: [{ path: "src/total.js", status: "modified" }],
		head_commit: BASE,
	},
	error_code: null,
	created_at: at,
	finished_at: at,
	...overrides,
});
const committed = action({
	id: "act_01JC9Z3K8Q5V7W2X4Y6Z8A0B2D",
	kind: "commit",
	result: {
		commit_sha: "9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d",
		branch: `tracera/${PAT}`,
		changed_files: [{ path: "src/total.js", status: "modified" }],
	},
});
const target = (overrides: Record<string, unknown> = {}) => ({
	repository_name: "demo",
	local: true,
	path: "C:/dev/demo",
	base_commit: BASE,
	suggested_branch: `tracera/${PAT}`,
	...overrides,
});
const listing = (items: unknown[], overrides: Record<string, unknown> = {}) =>
	json({ target: target(overrides), items });

function renderPanel(value: Patch) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<PublicationPanel patch={value} />
		</QueryClientProvider>,
	);
}

const button = (name: string | RegExp) =>
	screen.getByRole("button", { name }) as HTMLButtonElement;
const acknowledge = async () =>
	fireEvent.click(await screen.findByRole("checkbox"));

describe("the apply and publish panel", () => {
	it("shows nothing until the patch is approved", () => {
		const calls = stubApi({});
		const { container } = renderPanel(
			patch({ status: "proposed", approval: null }),
		);
		expect(container.innerHTML).toBe("");
		expect(calls).toEqual([]);
	});

	it("says a repository that is not a local path cannot be changed, and still offers the download", async () => {
		stubApi({
			[`GET ${ACTIONS}`]: listing([], { local: false, path: null }),
		});
		renderPanel(patch());
		expect(
			await screen.findByText(/not registered from a local path/),
		).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
		const link = screen.getByRole("link", { name: "Download patch" });
		expect(link.getAttribute("href")).toBe(`/api/v1/patches/${PAT}/download`);
	});

	it("shows the target and outcome, and keeps every action off until the outcome is acknowledged", async () => {
		stubApi({ [`GET ${ACTIONS}`]: listing([]) });
		renderPanel(patch());
		expect(await screen.findByText("C:/dev/demo")).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: "Apply and publish" }),
		).toBeTruthy();
		const apply = button("Apply to my working tree");
		const commit = button("Commit to a new branch");
		expect(apply.disabled).toBe(true);
		expect(commit.disabled).toBe(true);
		expect(button("Push branch").disabled).toBe(true);
		expect(screen.getByText(/Commit to a new branch first/)).toBeTruthy();
		await acknowledge();
		expect(apply.disabled).toBe(false);
		expect(commit.disabled).toBe(false);
		// No commit exists yet, so there is nothing to push.
		expect(button("Push branch").disabled).toBe(true);
	});

	it("asks again before applying, then reports what git changed and what was verified where", async () => {
		let items: unknown[] = [];
		const calls = stubApi({
			[`GET ${ACTIONS}`]: () => listing(items),
			[`POST ${ACTIONS}`]: () => {
				items = [action()];
				return json({ action: action() }, 201);
			},
		});
		renderPanel(patch());
		await acknowledge();
		fireEvent.click(button("Apply to my working tree"));
		// The first click only asks: nothing was sent.
		expect(calls.filter((call) => call.method === "POST")).toEqual([]);
		const confirmation = screen.getByRole("group", {
			name: "Confirm: Apply to my working tree",
		});
		expect(
			within(confirmation).getByText("Write 1 file into C:/dev/demo?"),
		).toBeTruthy();
		fireEvent.click(
			within(confirmation).getByRole("button", { name: "Cancel" }),
		);
		expect(calls.filter((call) => call.method === "POST")).toEqual([]);

		fireEvent.click(button("Apply to my working tree"));
		fireEvent.click(button("Confirm apply"));
		expect(
			await screen.findByText(
				"Applied to your working tree. Verification ran in the isolated sandbox.",
			),
		).toBeTruthy();
		expect(screen.getByText("src/total.js")).toBeTruthy();
		const post = calls.find((call) => call.method === "POST");
		expect(post?.headers["x-tracera-csrf"]).toBe("1");
		expect(post?.body).toEqual({
			kind: "apply",
			acknowledged_outcome: "verified",
			acknowledged_risks: true,
		});
	});

	it("never says verification ran in the sandbox when no check ran", async () => {
		stubApi({
			[`GET ${ACTIONS}`]: listing([
				action({ acknowledged_outcome: "not_attempted" }),
			]),
		});
		renderPanel(
			patch({
				verification: {
					id: "ver_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
					outcome: "not_attempted",
					label: "No check was attempted",
					outcome_reasons: ["sandbox_unavailable"],
				},
			}),
		);
		expect(
			await screen.findByText(
				"Applied to your working tree. No verification ran for this patch.",
			),
		).toBeTruthy();
		expect(screen.queryByText(/isolated sandbox/)).toBeNull();
	});

	it("warns when the checkout was not at the commit the patch was verified against", async () => {
		stubApi({
			[`GET ${ACTIONS}`]: listing([
				action({
					result: {
						changed_files: [],
						head_commit: "ffffffffffffffffffffffffffffffffffffffff",
					},
				}),
			]),
		});
		renderPanel(patch());
		expect(
			await screen.findByText(/not the commit the patch was verified against/),
		).toBeTruthy();
	});

	it("puts the unverified outcome in the acknowledgement and sends it", async () => {
		const calls = stubApi({
			[`GET ${ACTIONS}`]: listing([]),
			[`POST ${ACTIONS}`]: json({ action: action() }, 201),
		});
		renderPanel(
			patch({
				verification: {
					id: "ver_01JC9Z3K8Q5V7W2X4Y6Z8A0B1C",
					outcome: "partially_verified",
					label: "Checks passed, but the original failure was not confirmed",
					outcome_reasons: ["baseline_not_reproduced"],
				},
			}),
		);
		expect(
			await screen.findByLabelText(
				/outcome is partially_verified, not verified/,
			),
		).toBeTruthy();
		await acknowledge();
		fireEvent.click(button("Apply to my working tree"));
		fireEvent.click(button("Confirm apply"));
		await screen.findByRole("button", { name: "Apply to my working tree" });
		expect(calls.find((call) => call.method === "POST")?.body).toEqual({
			kind: "apply",
			acknowledged_outcome: "partially_verified",
			acknowledged_risks: true,
		});
	});

	it("commits with the typed branch and leaves a blank message to the server", async () => {
		const calls = stubApi({
			[`GET ${ACTIONS}`]: listing([]),
			[`POST ${ACTIONS}`]: json({ action: committed }, 201),
		});
		renderPanel(patch());
		await acknowledge();
		const branch = screen.getByLabelText("Branch") as HTMLInputElement;
		expect(branch.value).toBe(`tracera/${PAT}`);
		fireEvent.change(branch, { target: { value: "fix/cart-total" } });
		fireEvent.click(button("Commit to a new branch"));
		expect(screen.getByText(/Create branch fix\/cart-total/)).toBeTruthy();
		fireEvent.click(button("Confirm commit"));
		await screen.findByRole("button", { name: "Commit to a new branch" });
		expect(calls.find((call) => call.method === "POST")?.body).toEqual({
			kind: "commit",
			branch: "fix/cart-total",
			acknowledged_outcome: "verified",
			acknowledged_risks: true,
		});
	});

	it("offers a push once a commit exists, defaulting to its branch", async () => {
		const calls = stubApi({
			[`GET ${ACTIONS}`]: listing([committed]),
			[`POST ${ACTIONS}`]: json(
				{ action: action({ kind: "push", result: { remote: "origin" } }) },
				201,
			),
		});
		renderPanel(patch());
		expect(await screen.findByText(/^Committed\s+on branch/)).toBeTruthy();
		expect(screen.getByText(/Your checkout was not touched/)).toBeTruthy();
		await acknowledge();
		const remoteBranch = screen.getByLabelText(
			"Remote branch",
		) as HTMLInputElement;
		expect(remoteBranch.value).toBe(`tracera/${PAT}`);
		expect(button("Push branch").disabled).toBe(false);
		fireEvent.change(remoteBranch, { target: { value: "fix/total" } });
		fireEvent.click(button("Push branch"));
		expect(
			screen.getByText(`Push tracera/${PAT} to origin/fix/total?`),
		).toBeTruthy();
		fireEvent.click(button("Confirm push"));
		await screen.findByRole("button", { name: "Push branch" });
		expect(calls.find((call) => call.method === "POST")?.body).toEqual({
			kind: "push",
			remote: "origin",
			remote_branch: "fix/total",
			acknowledged_outcome: "verified",
			acknowledged_risks: true,
		});
	});

	it("shows the stable code and the way forward when the server refuses", async () => {
		stubApi({
			[`GET ${ACTIONS}`]: listing([]),
			[`POST ${ACTIONS}`]: problem(
				409,
				"working_tree_dirty",
				"A file the patch changes has local edits",
			),
		});
		renderPanel(patch());
		await acknowledge();
		fireEvent.click(button("Apply to my working tree"));
		fireEvent.click(button("Confirm apply"));
		const alert = await screen.findByRole("alert");
		expect(within(alert).getByText("working_tree_dirty")).toBeTruthy();
		expect(screen.getByText(/Commit or stash your edits/)).toBeTruthy();
	});

	it("lists a failed push by its code with recovery options, never as pushed", async () => {
		stubApi({
			[`GET ${ACTIONS}`]: listing([
				action({
					kind: "push",
					status: "failed",
					result: { detail: "The remote branch has newer commits" },
					error_code: "non_fast_forward",
				}),
			]),
		});
		renderPanel(patch());
		expect(await screen.findByText("non_fast_forward")).toBeTruthy();
		expect(screen.getByText(/never force-pushes/)).toBeTruthy();
		expect(screen.queryByText(/Pushed/)).toBeNull();
	});
});
