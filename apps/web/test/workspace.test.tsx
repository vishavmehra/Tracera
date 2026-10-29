import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	ApiError,
	analyzeImpact,
	decidePatch,
	searchRepository,
} from "../src/api.ts";
import {
	ids,
	json,
	problem,
	renderApp,
	repository,
	session,
	sha,
	snapshot,
	stubApi,
} from "./support.tsx";

// TEST DOUBLES ONLY: fixtures copy the server's view functions (see src/schemas.ts) so each screen's
// handling of loading, empty, error, and partial states can be checked without a server.

const at = "2026-10-24T09:00:00.000Z";
const more = {
	asm: "asm_01JC9Z3K8Q5V7W2X4Y6Z8A0B5G",
	asm2: "asm_01JC9Z3K8Q5V7W2X4Y6Z8A0B6H",
	inv: "inv_01JC9Z3K8Q5V7W2X4Y6Z8A0B7J",
	bug: "bug_01JC9Z3K8Q5V7W2X4Y6Z8A0B8K",
	pat: "pat_01JC9Z3K8Q5V7W2X4Y6Z8A0B9M",
	ver: "ver_01JC9Z3K8Q5V7W2X4Y6Z8A0BAN",
	hyp: "hyp_01JC9Z3K8Q5V7W2X4Y6Z8A0BBP",
	gnd: "gnd_01JC9Z3K8Q5V7W2X4Y6Z8A0BCQ",
};
const ME = "GET /api/v1/auth/me";
const REPO = `GET /api/v1/repositories/${ids.repo}`;
const base = {
	[ME]: json(session()),
	[REPO]: json({ repository: repository() }),
};

const evidence = (overrides: Record<string, unknown> = {}) => ({
	type: "code_excerpt",
	classification: "observed",
	handle: "CODE-1",
	repository_id: ids.repo,
	commit_sha: sha.indexed,
	snapshot_id: ids.snapNew,
	path: "src/cart/total.ts",
	start_line: 10,
	end_line: 14,
	symbol: "cartTotal",
	excerpt: "export function cartTotal() {}",
	method: "git_cat_file",
	certainty: "exact",
	collected_at: at,
	limitations: [],
	...overrides,
});

const answer = (overrides: Record<string, unknown> = {}) => ({
	inference_mode: "mock",
	status: "PARTIALLY_ANSWERED",
	model_status: "ANSWERED",
	downgrades: ["unsupported_claims"],
	summary: { text: "The total is computed in cartTotal.", basis: "inferred" },
	claims: [
		{
			statement: "cartTotal sums line items.",
			basis: "inferred",
			supported: true,
			evidence: [evidence()],
		},
		{
			statement: "Discounts apply after tax.",
			basis: "inferred",
			supported: false,
			evidence: [],
		},
	],
	unknowns: ["Where tax is configured"],
	follow_up_questions: ["Which tests cover cartTotal?"],
	confidence: "low",
	model_confidence: "high",
	confidence_rationale: "One claim is unsupported.",
	citations: { total: 2, invalid: 1 },
	model: { provider: "mock", model: "mock-reasoner" },
	limitations: ["Static answer from the indexed snapshot."],
	...overrides,
});

const assessment = (overrides: Record<string, unknown> = {}) => ({
	id: more.asm,
	kind: "question",
	repository_id: ids.repo,
	snapshot_id: ids.snapNew,
	commit_sha: sha.indexed,
	follow_up_of: null,
	request: "Where is the cart total computed?",
	targets: [],
	status: "completed",
	result: answer(),
	error: null,
	created_at: at,
	finished_at: at,
	...overrides,
});
const ASSESSMENT = `GET /api/v1/assessments/${more.asm}`;

describe("engineering questions", () => {
	it("separates supported from unsupported claims and labels mock output", async () => {
		stubApi({ ...base, [ASSESSMENT]: json({ assessment: assessment() }) });
		renderApp(`/repositories/${ids.repo}/questions/${more.asm}`);
		expect(await screen.findByText("Partially answered")).toBeTruthy();
		expect(screen.getByText("[mock]")).toBeTruthy();
		expect(screen.getByText("Downgraded by rules")).toBeTruthy();
		const supported = screen
			.getByText("cartTotal sums line items.")
			.closest("li");
		const unsupported = screen
			.getByText("Discounts apply after tax.")
			.closest("li");
		if (!supported || !unsupported) throw new Error("claims not rendered");
		expect(within(supported).getByText("Supported")).toBeTruthy();
		expect(within(supported).getByText("src/cart/total.ts:10-14")).toBeTruthy();
		expect(within(unsupported).getByText("Unsupported")).toBeTruthy();
		expect(within(unsupported).getByText("No valid citation.")).toBeTruthy();
	});

	it("asks a follow-up that carries the earlier question", async () => {
		const calls = stubApi({
			...base,
			[ASSESSMENT]: json({ assessment: assessment() }),
			[`POST /api/v1/repositories/${ids.repo}/questions`]: json(
				{
					assessment: assessment({
						id: more.asm2,
						status: "queued",
						result: null,
					}),
				},
				202,
			),
			[`GET /api/v1/assessments/${more.asm2}`]: json({
				assessment: assessment({
					id: more.asm2,
					status: "queued",
					result: null,
				}),
			}),
		});
		renderApp(`/repositories/${ids.repo}/questions/${more.asm}`);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Which tests cover cartTotal?",
			}),
		);
		const box = screen.getByLabelText("Ask a follow-up") as HTMLTextAreaElement;
		expect(box.value).toBe("Which tests cover cartTotal?");
		fireEvent.click(screen.getByRole("button", { name: "Ask follow-up" }));
		expect(await screen.findByText("Queued…")).toBeTruthy();
		const post = calls.find((call) => call.method === "POST");
		expect(post?.body).toEqual({
			question: "Which tests cover cartTotal?",
			follow_up_of: more.asm,
		});
		expect(post?.headers["x-tracera-csrf"]).toBe("1");
	});

	it("shows insufficient evidence and failures without inventing a verdict", async () => {
		stubApi({
			...base,
			[ASSESSMENT]: json({
				assessment: assessment({
					result: answer({
						status: "INSUFFICIENT_EVIDENCE",
						claims: [],
						downgrades: [],
					}),
				}),
			}),
		});
		renderApp(`/repositories/${ids.repo}/questions/${more.asm}`);
		expect(
			await screen.findByText(/evidence is not enough to answer/),
		).toBeTruthy();

		stubApi({
			...base,
			[ASSESSMENT]: json({
				assessment: assessment({
					status: "failed",
					result: {
						inference_mode: "mock",
						limitations: ["Partial coverage."],
					},
					error: {
						code: "model_output_invalid",
						message: "Did not match the schema",
					},
				}),
			}),
		});
		renderApp(`/repositories/${ids.repo}/questions/${more.asm}`);
		expect(await screen.findByText("model_output_invalid")).toBeTruthy();
		expect(screen.getByText("No verdict was produced.")).toBeTruthy();
	});

	it("reports a stored answer it cannot read instead of guessing", async () => {
		stubApi({
			...base,
			[ASSESSMENT]: json({
				assessment: assessment({ result: { status: "ANSWERED" } }),
			}),
		});
		renderApp(`/repositories/${ids.repo}/questions/${more.asm}`);
		expect(
			await screen.findByText(/does not match the expected format/),
		).toBeTruthy();
	});
});

const node = (overrides: Record<string, unknown> = {}) => ({
	id: more.gnd,
	key: "sym:src/cart/total.ts#cartTotal",
	kind: "function",
	name: "cartTotal",
	path: "src/cart/total.ts",
	start_line: 10,
	end_line: 14,
	language: "typescript",
	attributes: {},
	provenance: {},
	...overrides,
});

describe("exploration", () => {
	it("lists search results with how each matched and links to the node", async () => {
		stubApi({
			...base,
			[`GET /api/v1/repositories/${ids.repo}/search?q=cartTotal&mode=all&limit=40`]:
				json({
					snapshot: snapshot(),
					mode: "all",
					results: [
						{
							match: { kind: "function", reason: "exact_name" },
							node: node(),
							evidence: evidence({ type: "search_hit" }),
						},
					],
					hits: [],
					truncated: false,
					limitations: [],
					semantic: {
						available: false,
						reason: "No embedding provider is configured.",
					},
				}),
		});
		renderApp(`/repositories/${ids.repo}/explore?q=cartTotal`);
		const link = await screen.findByRole("link", { name: "cartTotal" });
		expect(link.getAttribute("href")).toBe(
			`/repositories/${ids.repo}/nodes/${more.gnd}`,
		);
		expect(screen.getByText("Exact name")).toBeTruthy();
		expect(screen.getByText("Limitations (1)")).toBeTruthy();
	});

	it("explains a repository without a usable snapshot", async () => {
		stubApi({
			...base,
			[`GET /api/v1/repositories/${ids.repo}/search?q=cart&mode=all&limit=40`]:
				problem(409, "graph_not_indexed"),
		});
		renderApp(`/repositories/${ids.repo}/explore?q=cart`);
		expect(await screen.findByText(/No usable snapshot yet/)).toBeTruthy();
	});

	it("sends query and body parameters the API expects", async () => {
		const calls = stubApi({
			"GET /api/v1/repositories/repo_1/search?q=a+%26+b&mode=all&limit=40":
				json({}),
			"POST /api/v1/repositories/repo_1/impact": json({}),
		});
		await searchRepository("repo_1", "a & b").catch(() => null);
		await analyzeImpact("repo_1", {
			targets: [{ kind: "symbol", name: "add" }],
			depth: 6,
			limit: 150,
		}).catch(() => null);
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"GET /api/v1/repositories/repo_1/search?q=a+%26+b&mode=all&limit=40",
			"POST /api/v1/repositories/repo_1/impact",
		]);
		expect(calls[1]?.headers["x-tracera-csrf"]).toBe("1");
	});
});

const investigation = (overrides: Record<string, unknown> = {}) => ({
	id: more.inv,
	status: "completed",
	state_version: 7,
	current_stage: null,
	mode: "analysis_only",
	mode_reason: "sandbox_unavailable",
	model_profile: "standard",
	interactive: true,
	bug_report_id: more.bug,
	repository_id: ids.repo,
	commit_sha: sha.indexed,
	flags: [],
	progress: { stage_index: 10, stage_count: 10, message: "Completed" },
	steps: [
		{
			stage: "collect_context",
			specialists: ["repository_mapping"],
			attempt: 1,
			status: "succeeded",
			started_at: at,
			finished_at: at,
			summary: {},
			error: null,
		},
		{
			stage: "reproduce_baseline",
			specialists: ["reproduction"],
			attempt: 1,
			status: "blocked",
			started_at: at,
			finished_at: at,
			summary: {},
			error: {
				code: "sandbox_unavailable",
				message: "Docker is not available",
			},
		},
	],
	needs_input: null,
	counts: { findings: 1, hypotheses: 1, reproductions: 0, patches: 0 },
	baseline_reproduction: {
		status: "blocked",
		reason: "sandbox_unavailable",
		sandbox_run_ids: [],
	},
	latest_patch: null,
	latest_verification: null,
	inference: { provider: "mock", mock: true, escalation_available: false },
	failure: null,
	created_at: at,
	started_at: at,
	finished_at: at,
	...overrides,
});
const bugReport = {
	id: more.bug,
	status: "open",
	source_channel: "web",
	title: "Cart total is wrong",
	description: "The total doubles discounts.",
	expected_behavior: null,
	actual_behavior: null,
	steps: [],
	environment: {},
	severity: "high",
	repository_id: ids.repo,
	normalization: { status: "not_requested", summary: null },
	created_at: at,
};
const findings = {
	reported_claims: [],
	observed_facts: [
		{
			handle: "FACT-1",
			kind: "repository_fact",
			basis: "observed",
			label: "Test command",
			content: "npm test",
		},
	],
	code_references: [],
	commits: [],
	experiments: [],
	model_observations: [],
	hypotheses: [
		{
			id: more.hyp,
			handle: "HYP-1",
			rank: 1,
			title: "Discount applied twice",
			state: "proposed",
			label: "Possible cause",
			confidence: "medium",
			confidence_rationale: "",
			score: 0.5,
			mechanism: "applyDiscount runs in two places.",
			locations: [],
			supporting: [
				{
					handle: "CODE-1",
					start_line: 3,
					end_line: 4,
					label: "src/cart/total.ts",
				},
			],
			contradicting: [],
			alternatives: [],
			next_check: "Reproduce with one discount.",
		},
	],
	confirmed_findings: [],
	open_questions: [],
	insufficient_evidence: null,
	model_disclosure: {
		providers: ["mock"],
		models: ["mock-reasoner"],
		mock: true,
	},
};
const INV = `GET /api/v1/investigations/${more.inv}`;
const investigationRoutes = (inv = investigation()) => ({
	[ME]: json(session()),
	[INV]: json({ investigation: inv }),
	[`GET /api/v1/bug-reports/${more.bug}`]: json({ bug_report: bugReport }),
	[`${INV}/findings`]: json(findings),
	[`${INV}/reproductions`]: json({ items: [] }),
	[`${INV}/patches`]: json({ items: [] }),
});

describe("investigation workspace", () => {
	it("shows stages, the analysis-only reason, and hypotheses as possible causes", async () => {
		stubApi(investigationRoutes());
		renderApp(`/investigations/${more.inv}`);
		expect(
			await screen.findByRole("heading", {
				level: 1,
				name: "Cart total is wrong",
			}),
		).toBeTruthy();
		expect(screen.getByText("Analysis only: sandbox unavailable")).toBeTruthy();
		const stages = screen.getByRole("region", { name: "Workflow" });
		expect(within(stages).getByText("Collect context")).toBeTruthy();
		expect(within(stages).getByText("sandbox_unavailable")).toBeTruthy();
		expect(await screen.findByText("Discount applied twice")).toBeTruthy();
		expect(screen.getByText("Possible cause")).toBeTruthy();
		expect(screen.getAllByText("[mock]").length).toBeGreaterThanOrEqual(2);
		expect(await screen.findByText("No patch has been proposed.")).toBeTruthy();
		expect(screen.queryByText(/verified/i)).toBeNull();
	});

	it("offers retry only for a failed investigation", async () => {
		const calls = stubApi({
			...investigationRoutes(
				investigation({
					status: "failed",
					failure: {
						stage: "collect_context",
						code: "context_timeout",
						message: "Timed out",
						retryable: true,
					},
				}),
			),
			[`POST /api/v1/investigations/${more.inv}/retry`]: json({}, 202),
		});
		renderApp(`/investigations/${more.inv}`);
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Retry from the failed stage",
			}),
		);
		expect(screen.getByText("context_timeout")).toBeTruthy();
		await screen.findByRole("button", { name: "Retry from the failed stage" });
		expect(
			calls.some(
				(call) => call.method === "POST" && call.path.endsWith("/retry"),
			),
		).toBe(true);
	});
});

const patch = (overrides: Record<string, unknown> = {}) => ({
	id: more.pat,
	investigation_id: more.inv,
	hypothesis_id: more.hyp,
	hypothesis_handle: "HYP-1",
	attempt: 1,
	status: "proposed",
	origin: "tracera_model",
	base_commit: sha.indexed,
	summary: "Apply the discount once",
	rationale: "Remove the second call.",
	expected_effect: "The total matches the expected value.",
	risks: [{ code: "touches_pricing", message: "Changes pricing code" }],
	files: [
		{
			path: "src/cart/total.ts",
			change_type: "modified",
			additions: 1,
			deletions: 2,
		},
	],
	diff_sha256: "a".repeat(64),
	apply_error: null,
	impact: { available: false, reason: "graph_not_indexed" },
	verification: {
		id: more.ver,
		outcome: "partially_verified",
		label: "Checks passed, but the original failure was not confirmed",
		outcome_reasons: ["baseline_not_reproduced"],
	},
	approval: null,
	model: { provider: "mock", model: "mock-reasoner" },
	created_at: at,
	...overrides,
});
const verification = (overrides: Record<string, unknown> = {}) => ({
	id: more.ver,
	patch_id: more.pat,
	investigation_id: more.inv,
	status: "completed",
	outcome: "partially_verified",
	label: "Checks passed, but the original failure was not confirmed",
	outcome_reasons: ["baseline_not_reproduced"],
	checks: [
		{
			kind: "unit_tests",
			status: "passed",
			reason: null,
			command: "npm test",
			exit_code: 0,
			duration_ms: 1200,
			summary: {},
			sandbox_run_ids: [],
		},
	],
	environment: {
		executor: "docker",
		image: "node@sha256:abc",
		network: "none",
		dependencies: null,
		dependencies_blocked: null,
	},
	started_at: at,
	finished_at: at,
	...overrides,
});
const reviewRoutes = (
	p = patch(),
	inv = investigation({
		status: "awaiting_approval",
		mode: "full",
		mode_reason: null,
	}),
) => ({
	...investigationRoutes(inv),
	[`GET /api/v1/patches/${more.pat}`]: json({ patch: p }),
	[`GET /api/v1/patches/${more.pat}/diff`]: json({
		patch_id: more.pat,
		diff_sha256: "a".repeat(64),
		truncated: false,
		diff: "--- a/src/cart/total.ts\n+++ b/src/cart/total.ts\n@@ -1 +1 @@\n-old\n+new\n",
	}),
	[`GET /api/v1/verifications/${more.ver}`]: json({
		verification: verification(),
	}),
});
const REVIEW = `/investigations/${more.inv}/patches/${more.pat}`;

describe("patch review and approval", () => {
	it("requires every outcome reason and risk to be acknowledged before approving", async () => {
		const calls = stubApi({
			...reviewRoutes(),
			[`POST /api/v1/patches/${more.pat}/approval`]: json(
				{ approval: {}, investigation: { id: more.inv, status: "completed" } },
				201,
			),
		});
		renderApp(REVIEW);
		const approve = await screen.findByRole("button", {
			name: "Approve unverified patch",
		});
		expect(screen.getAllByText(/partially_verified/).length).toBeGreaterThan(0);
		expect(
			screen.getByText(/does not apply, commit, or push anything/),
		).toBeTruthy();
		expect((approve as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(
			screen.getByRole("checkbox", { name: /baseline_not_reproduced/ }),
		);
		expect((approve as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole("checkbox", { name: /touches_pricing/ }));
		expect((approve as HTMLButtonElement).disabled).toBe(false);
		fireEvent.click(approve);
		await screen.findByRole("button", { name: "Approve unverified patch" });
		const post = calls.find((call) => call.method === "POST");
		expect(post?.path).toBe(`/api/v1/patches/${more.pat}/approval`);
		expect(post?.headers["x-tracera-csrf"]).toBe("1");
		expect(post?.body).toEqual({
			decision: "approved",
			verification_id: more.ver,
			acknowledged_risks: ["baseline_not_reproduced", "touches_pricing"],
		});
	});

	it("shows the verification checks, environment, and the diff", async () => {
		stubApi(reviewRoutes());
		renderApp(REVIEW);
		expect(await screen.findByText("Unit tests")).toBeTruthy();
		expect(screen.getByText("docker")).toBeTruthy();
		expect(await screen.findByText("+new")).toBeTruthy();
		expect(
			screen.getByText("Impact unavailable: graph_not_indexed"),
		).toBeTruthy();
	});

	it("never offers approval without a verification run", async () => {
		stubApi(reviewRoutes(patch({ verification: null })));
		renderApp(REVIEW);
		expect(
			await screen.findByText(/Not verified: no verification run exists/),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
	});

	it("shows a recorded decision instead of the form", async () => {
		stubApi(
			reviewRoutes(
				patch({
					status: "rejected",
					approval: {
						decision: "rejected",
						verification_id: more.ver,
						outcome_at_decision: "partially_verified",
						comment: "Too risky",
						acknowledged_risks: [],
						decided_by: ids.user,
						decided_at: at,
					},
				}),
				investigation({ status: "completed" }),
			),
		);
		renderApp(REVIEW);
		expect(await screen.findByText("Too risky")).toBeTruthy();
		expect(
			screen.getByText("No files were changed by this decision."),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /Approve|Reject patch/ }),
		).toBeNull();
	});

	it("keeps the server's list of unacknowledged items from a 422", async () => {
		stubApi({
			"POST /api/v1/patches/pat_1/approval": () =>
				new Response(
					JSON.stringify({
						type: "about:blank",
						title: "Unprocessable",
						status: 422,
						detail:
							"Acknowledge every outcome reason and risk before approving",
						code: "risks_not_acknowledged",
						request_id: "req-1",
						required: ["a", "b"],
						missing: ["b"],
					}),
					{
						status: 422,
						headers: { "content-type": "application/problem+json" },
					},
				),
		});
		const error = await decidePatch("pat_1", {
			decision: "approved",
			verification_id: more.ver,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).code).toBe("risks_not_acknowledged");
		expect((error as ApiError).extra.missing).toEqual(["b"]);
	});
});

describe("resolution report", () => {
	it("says when no report has been written yet", async () => {
		stubApi({
			[ME]: json(session()),
			[`GET /api/v1/investigations/${more.inv}/report`]: problem(
				404,
				"not_found",
				"No report has been written yet",
			),
		});
		renderApp(`/investigations/${more.inv}/report`);
		expect(
			await screen.findByText(/No report has been written yet\. It is written/),
		).toBeTruthy();
	});
});
