import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	ids,
	json,
	renderApp,
	repository,
	session,
	sha,
	stubApi,
} from "./support.tsx";

// TEST DOUBLES ONLY: compact fixtures shaped like the server's views (see src/schemas.ts), used to
// check what the traces on the sign-in, investigation, and patch review pages say about stored data.

const at = "2026-10-24T09:00:00.000Z";
const more = {
	inv: "inv_01JC9Z3K8Q5V7W2X4Y6Z8A0B7J",
	bug: "bug_01JC9Z3K8Q5V7W2X4Y6Z8A0B8K",
	pat: "pat_01JC9Z3K8Q5V7W2X4Y6Z8A0B9M",
	ver: "ver_01JC9Z3K8Q5V7W2X4Y6Z8A0BAN",
	hyp: "hyp_01JC9Z3K8Q5V7W2X4Y6Z8A0BBP",
};
const ME = "GET /api/v1/auth/me";
const INV = `GET /api/v1/investigations/${more.inv}`;

const step = (stage: string, status = "succeeded") => ({
	stage,
	specialists: [],
	attempt: 1,
	status,
	started_at: at,
	finished_at: status === "running" ? null : at,
	summary: {},
	error: null,
});

const investigation = (overrides: Record<string, unknown> = {}) => ({
	id: more.inv,
	status: "awaiting_approval",
	state_version: 3,
	current_stage: null,
	mode: "full",
	mode_reason: null,
	bug_report_id: more.bug,
	repository_id: ids.repo,
	commit_sha: sha.indexed,
	flags: [],
	progress: { stage_index: 10, stage_count: 10, message: "Awaiting approval" },
	steps: [step("write_report")],
	needs_input: null,
	counts: { findings: 1, hypotheses: 1, reproductions: 1, patches: 1 },
	baseline_reproduction: { status: "reproduced", reason: null },
	latest_patch: { id: more.pat, status: "proposed" },
	latest_verification: {
		id: more.ver,
		outcome: "partially_verified",
		outcome_reasons: ["typecheck_not_attempted"],
	},
	inference: { provider: "mock", mock: true },
	failure: null,
	created_at: at,
	finished_at: null,
	...overrides,
});

const bugReport = {
	id: more.bug,
	status: "open",
	source_channel: "web",
	title: "Order total ignores string prices",
	description: "The total concatenates.",
	expected_behavior: null,
	actual_behavior: null,
	steps: [],
	severity: "high",
	repository_id: ids.repo,
	normalization: { status: "not_requested", summary: null },
	created_at: at,
};

const hypothesis = {
	id: more.hyp,
	handle: "HYP-1",
	rank: 1,
	title: "total adds strings",
	state: "proposed",
	label: "Possible cause",
	confidence: "medium",
	confidence_rationale: "",
	mechanism: "`sum += item.price` concatenates.",
	locations: [],
	supporting: [],
	contradicting: [],
	alternatives: [],
	next_check: "Convert the price.",
};

const findings = (facts: number, hypotheses: unknown[]) => ({
	reported_claims: [],
	observed_facts: Array.from({ length: facts }, (_, index) => ({
		handle: `FACT-${index + 1}`,
		kind: "repository_fact",
		basis: "observed",
		label: "Test command",
		content: "npm test",
	})),
	code_references: [],
	commits: [],
	experiments: [],
	model_observations: [],
	hypotheses,
	open_questions: [],
	insufficient_evidence: null,
	model_disclosure: {
		providers: ["mock"],
		models: ["mock-reasoner"],
		mock: true,
	},
});

/** The line style of each segment of a trace, in document order. */
const lines = (container: HTMLElement) =>
	[...container.querySelectorAll("[data-line]")].map((element) =>
		element.getAttribute("data-line"),
	);

/** The words of one stop of a trace: its label and what it says. */
const stopText = (list: HTMLElement, label: string) =>
	within(list).getByText(label).closest("li")?.textContent ?? "";

/** Waits until a trace says each stop's text and draws each line segment as expected. */
const expectTrace = (
	list: HTMLElement,
	says: Record<string, string>,
	segments: string[],
) =>
	waitFor(() => {
		for (const [label, text] of Object.entries(says))
			expect(stopText(list, label)).toContain(text);
		expect(lines(list)).toEqual(segments);
	});

const investigationRoutes = (
	inv: Record<string, unknown>,
	found: ReturnType<typeof findings>,
) => ({
	[ME]: json(session()),
	[INV]: json({ investigation: inv }),
	[`GET /api/v1/repositories/${ids.repo}`]: json({ repository: repository() }),
	[`GET /api/v1/bug-reports/${more.bug}`]: json({ bug_report: bugReport }),
	[`${INV}/findings`]: json(found),
	[`${INV}/reproductions`]: json({ items: [] }),
	[`${INV}/patches`]: json({ items: [] }),
});

describe("sign-in", () => {
	it("draws the product's trace with every line style it uses in the app", () => {
		stubApi({});
		renderApp("/sign-in");
		const plate = screen.getByRole("complementary", {
			name: "How Tracera works",
		});
		// Recorded steps are solid, the human decision is awaited (dashed), certainty is not established.
		expect(lines(plate)).toEqual([
			"solid",
			"solid",
			"solid",
			"dashed",
			"dotted",
		]);
		expect(within(plate).getByText("Certainty")).toBeTruthy();
	});
});

describe("investigation trace", () => {
	const flow: Array<{
		name: string;
		inv: Record<string, unknown>;
		found: ReturnType<typeof findings>;
		says: Record<string, string>;
		segments: string[];
	}> = [
		{
			name: "a proposed patch that awaits a decision",
			inv: investigation(),
			found: findings(1, [hypothesis]),
			says: {
				Evidence: "1 item",
				Hypothesis: "1 possible cause",
				Patch: "Proposed",
				Verification: "Partially verified",
				Report: "Written",
				Decision: "Awaiting decision",
			},
			segments: [
				"solid",
				"solid",
				"solid",
				"solid",
				"solid",
				"solid",
				"dashed",
			],
		},
		{
			name: "a stored verified outcome",
			inv: investigation({
				latest_verification: {
					id: more.ver,
					outcome: "verified",
					outcome_reasons: [],
				},
			}),
			found: findings(1, [hypothesis]),
			says: { Patch: "Proposed", Verification: "Verified" },
			segments: [
				"solid",
				"solid",
				"solid",
				"solid",
				"solid",
				"solid",
				"dashed",
			],
		},
		{
			name: "an approved patch",
			inv: investigation({
				status: "completed",
				latest_patch: { id: more.pat, status: "approved" },
			}),
			found: findings(1, [hypothesis]),
			says: { Patch: "Approved", Decision: "Approved" },
			segments: ["solid", "solid", "solid", "solid", "solid", "solid", "solid"],
		},
		{
			name: "a finished investigation that recorded nothing",
			inv: investigation({
				status: "completed",
				steps: [],
				counts: { findings: 0, hypotheses: 0, reproductions: 0, patches: 0 },
				baseline_reproduction: null,
				latest_patch: null,
				latest_verification: null,
			}),
			found: findings(0, []),
			says: {
				Evidence: "None recorded",
				Patch: "None recorded",
				Verification: "None recorded",
				Decision: "None recorded",
			},
			segments: Array(7).fill("dotted"),
		},
	];

	it.each(flow)(
		"says only what is stored for $name",
		async ({ inv, found, says, segments }) => {
			stubApi(investigationRoutes(inv, found));
			renderApp(`/investigations/${more.inv}`);
			const trace = await screen.findByRole("list", {
				name: "Investigation trace",
			});
			await expectTrace(trace, says, segments);
		},
	);

	it("shows verified only where a stored outcome says verified", async () => {
		stubApi(
			investigationRoutes(
				investigation({
					latest_verification: {
						id: more.ver,
						outcome: "partially_verified",
						outcome_reasons: ["typecheck_not_attempted"],
					},
				}),
				findings(1, [hypothesis]),
			),
		);
		renderApp(`/investigations/${more.inv}`);
		const trace = await screen.findByRole("list", {
			name: "Investigation trace",
		});
		expect(within(trace).queryByText("Verified")).toBeNull();
		expect(within(trace).getByText("Partially verified")).toBeTruthy();
	});

	it("pulses only the stop the worker is running, and draws the line toward it dashed", async () => {
		stubApi(
			investigationRoutes(
				investigation({
					status: "running",
					current_stage: "reproduce_baseline",
					steps: [
						step("collect_context"),
						step("reproduce_baseline", "running"),
					],
					baseline_reproduction: null,
					latest_patch: null,
					latest_verification: null,
					counts: { findings: 1, hypotheses: 0, reproductions: 0, patches: 0 },
				}),
				findings(1, []),
			),
		);
		renderApp(`/investigations/${more.inv}`);
		const trace = await screen.findByRole("list", {
			name: "Investigation trace",
		});
		await within(trace).findByText("1 item");
		expect(lines(trace)).toEqual([
			"solid",
			"dashed",
			"dotted",
			"dotted",
			"dotted",
			"dotted",
			"dotted",
		]);
		const pulsing = trace.querySelectorAll(".motion-safe\\:animate-live");
		expect(pulsing).toHaveLength(1);
		expect(pulsing[0]?.closest("li")?.textContent).toContain("Reproduction");
	});
});

describe("patch review trace", () => {
	const patch = (overrides: Record<string, unknown> = {}) => ({
		id: more.pat,
		investigation_id: more.inv,
		hypothesis_id: more.hyp,
		hypothesis_handle: "HYP-1",
		attempt: 1,
		status: "proposed",
		base_commit: sha.indexed,
		summary: "Convert prices",
		rationale: "Number() first.",
		expected_effect: "The total is 5.",
		risks: [],
		files: [
			{
				path: "src/cart/total.ts",
				change_type: "modified",
				additions: 1,
				deletions: 1,
			},
		],
		diff_sha256: "a".repeat(64),
		apply_error: null,
		impact: null,
		verification: {
			id: more.ver,
			outcome: "partially_verified",
			label: "Checks passed, but the type check was not run",
			outcome_reasons: ["typecheck_not_attempted"],
		},
		approval: null,
		model: { provider: "mock", model: "mock-reasoner" },
		created_at: at,
		...overrides,
	});
	const routes = (
		p: Record<string, unknown>,
		inv: Record<string, unknown>,
	) => ({
		...investigationRoutes(inv, findings(1, [hypothesis])),
		[`GET /api/v1/patches/${more.pat}`]: json({ patch: p }),
		[`GET /api/v1/patches/${more.pat}/diff`]: json({
			patch_id: more.pat,
			diff_sha256: "a".repeat(64),
			truncated: false,
			diff: "--- a/src/cart/total.ts\n+++ b/src/cart/total.ts\n@@ -1 +1 @@\n-old\n+new\n",
		}),
		[`GET /api/v1/verifications/${more.ver}`]: json({
			verification: {
				id: more.ver,
				patch_id: more.pat,
				status: "completed",
				outcome: "partially_verified",
				label: "Checks passed, but the type check was not run",
				outcome_reasons: ["typecheck_not_attempted"],
				checks: [],
				environment: null,
				started_at: at,
				finished_at: at,
			},
		}),
	});
	const review = `/investigations/${more.inv}/patches/${more.pat}`;

	const flow: Array<{
		name: string;
		p: Record<string, unknown>;
		inv: Record<string, unknown>;
		says: Record<string, string>;
		segments: string[];
	}> = [
		{
			name: "a proposed patch with partial verification",
			p: patch(),
			inv: investigation(),
			says: {
				Patch: "Proposed",
				Verification: "Partially verified",
				Decision: "Awaiting decision",
			},
			segments: ["solid", "dashed"],
		},
		{
			name: "an approved patch",
			p: patch({
				status: "approved",
				approval: {
					decision: "approved",
					outcome_at_decision: "partially_verified",
					comment: null,
					acknowledged_risks: [],
					decided_by: ids.user,
					decided_at: at,
				},
			}),
			inv: investigation({ status: "completed" }),
			says: { Patch: "Approved", Decision: "Approved" },
			segments: ["solid", "solid"],
		},
		{
			name: "a patch that was never verified",
			p: patch({ verification: null }),
			inv: investigation({ status: "completed", latest_verification: null }),
			says: { Patch: "Proposed", Verification: "Not run", Decision: "Not yet" },
			segments: ["dotted", "dotted"],
		},
	];

	it.each(flow)(
		"says only what is stored for $name",
		async ({ p, inv, says, segments }) => {
			stubApi(routes(p, inv));
			renderApp(review);
			const trace = await screen.findByRole("list", { name: "Patch trace" });
			await expectTrace(trace, says, segments);
		},
	);

	it("keeps a generated patch from reading as verified", async () => {
		stubApi(routes(patch({ verification: null }), investigation()));
		renderApp(review);
		await screen.findByText(/Not verified: no verification run exists/);
		expect(screen.queryByText("Verified")).toBeNull();
		expect(screen.getAllByText("Not verified").length).toBeGreaterThan(0);
	});
});
