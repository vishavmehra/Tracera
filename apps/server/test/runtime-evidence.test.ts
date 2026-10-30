import {
	type BrowserRunReport,
	BrowserRunReportSchema,
	type BrowserStep,
	type RuntimeRun,
} from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import {
	browserEvidenceFields,
	describeStep,
	isPng,
	phaseOf,
	sandboxModeOf,
	startupRecord,
	visualFixClaim,
} from "../src/modules/browser-evidence.ts";
import { clip } from "../src/sandbox/browser-runner.ts";
import type { BrowserRunResult } from "../src/sandbox/executor.ts";
import { TINY_PNG } from "./png.ts";

// Pure rules for the runtime evidence of browser runs (no database, no Docker).

const step = (partial: Partial<BrowserStep>): BrowserStep => ({
	action: "goto",
	target: null,
	value: null,
	path: null,
	key: null,
	width: null,
	height: null,
	match: null,
	timeout_ms: null,
	...partial,
});
const target = {
	start: ["npm", "run", "start"],
	app: { port: 4173, readyPath: "/health" },
};
const startup = (
	overrides: Partial<NonNullable<BrowserRunReport["startup"]>> = {},
) => ({
	health_path: "/health",
	health_ok: true,
	health_status: 200,
	health_attempts: 2,
	health_waited_ms: 640,
	health_error: null,
	page_loaded: true,
	page_error: null,
	...overrides,
});
const report = (
	overrides: Partial<BrowserRunReport> = {},
): BrowserRunReport => ({
	ready: true,
	startup: startup(),
	steps: [],
	console_errors: [],
	page_errors: [],
	blocked_requests: [],
	failed_requests: [],
	final_path: "/cart",
	screenshot: null,
	duration_ms: 900,
	...overrides,
});
const run = (overrides: Partial<BrowserRunResult> = {}): BrowserRunResult => ({
	status: "exited",
	report: report(),
	appLog: "",
	stderr: "",
	truncated: false,
	durationMs: 900,
	executor: {
		kind: "docker",
		image: "node@sha256:app",
		browserImage: "pw@sha256:browser",
	},
	...overrides,
});

describe("startup record", () => {
	it.each([
		["the app answered and the page loaded", run(), "started", null],
		[
			"the health check never succeeded",
			run({
				report: report({
					ready: false,
					startup: startup({
						health_ok: false,
						health_status: null,
						health_error: "ECONNREFUSED",
						page_loaded: false,
					}),
				}),
			}),
			"failed",
			"health_check_failed",
		],
		[
			"the app exited before the browser joined",
			run({
				report: report({
					ready: false,
					startup: startup({
						health_ok: false,
						health_status: null,
						health_error: "app_exited",
						page_loaded: false,
					}),
				}),
			}),
			"failed",
			"app_exited_before_ready",
		],
		[
			"the first page did not load",
			run({
				report: report({
					startup: startup({
						page_loaded: false,
						page_error: "page.goto: Timeout 15000ms exceeded.",
					}),
				}),
			}),
			"failed",
			"page_load_failed",
		],
		[
			"the app container could not start",
			run({
				status: "executor_error",
				report: null,
				detail: "app_container_failed",
			}),
			"failed",
			"app_container_failed",
		],
		[
			"the run timed out before reporting",
			run({ status: "timed_out", report: null }),
			"unknown",
			"timed_out",
		],
		[
			"the runner produced no report",
			run({ status: "executor_error", report: null, detail: "runner_failed" }),
			"unknown",
			"runner_failed",
		],
	] as const)("%s", (_name, result, state, reason) => {
		const record = startupRecord(result, target);
		expect(record).toMatchObject({
			state,
			reason,
			image: "node@sha256:app",
			browser_image: "pw@sha256:browser",
			start: "npm run start",
			port: 4173,
			ready_path: "/health",
		});
	});

	it("keeps the health check and page facts, and invents none without a report", () => {
		expect(startupRecord(run(), target)).toMatchObject({
			health: {
				ok: true,
				status: 200,
				attempts: 2,
				waited_ms: 640,
				error: null,
			},
			page: { loaded: true, error: null },
		});
		expect(
			startupRecord(run({ status: "timed_out", report: null }), target),
		).toMatchObject({
			health: null,
			page: null,
		});
	});
});

describe("claims from stored post-patch runs", () => {
	const after = (
		overrides: Partial<Pick<RuntimeRun, "status" | "assertions">> & {
			state?: "started" | "failed";
		} = {},
	) => ({
		status: overrides.status ?? "exited",
		startup: {
			...startupRecord(run(), target),
			state: overrides.state ?? "started",
		},
		assertions: overrides.assertions ?? { passed: 3, failed: 0, skipped: 0 },
	});
	const verified = { reproductionStatus: "passed" };

	it.each([
		[
			"a passed reproduction check and clean runs",
			verified,
			[after(), after()],
			true,
			"post_patch_assertions_passed",
		],
		["no verification", null, [after()], false, "no_verification"],
		["no post-patch run", verified, [], false, "no_post_patch_run"],
		[
			"a run that did not finish",
			verified,
			[after({ status: "timed_out" })],
			false,
			"post_patch_run_incomplete",
		],
		[
			"an app that did not start",
			verified,
			[after({ state: "failed" })],
			false,
			"post_patch_run_incomplete",
		],
		[
			"one failing assertion among passing runs",
			verified,
			[after(), after({ assertions: { passed: 2, failed: 1, skipped: 0 } })],
			false,
			"post_patch_assertion_failed",
		],
		[
			"no assertion that passed",
			verified,
			[after({ assertions: { passed: 0, failed: 0, skipped: 2 } })],
			false,
			"no_assertion_passed",
		],
		[
			"a reproduction check that did not pass",
			{ reproductionStatus: "failed" },
			[after()],
			false,
			"reproduction_check_not_passed",
		],
		[
			"no reproduction check",
			{ reproductionStatus: null },
			[after()],
			false,
			"reproduction_check_not_passed",
		],
	] as const)("%s", (_name, verification, runs, claimable, reason) => {
		expect(visualFixClaim({ verification, after: runs })).toEqual({
			claimable,
			reason,
		});
	});
});

describe("describing steps", () => {
	it.each([
		[step({ action: "goto", path: "/cart" }), "Open /cart"],
		[
			step({
				action: "click",
				target: {
					by: "role",
					value: "link",
					name: "Add one Desk lamp",
					exact: null,
				},
			}),
			'Click link "Add one Desk lamp"',
		],
		[
			step({
				action: "expect_text",
				target: { by: "test_id", value: "shipping", name: null, exact: null },
				value: "Shipping: Free",
				match: "equals",
			}),
			'Expect test id "shipping" to equal "Shipping: Free"',
		],
		[
			step({ action: "expect_url", path: "/cart?qty=2" }),
			"Expect the page to be /cart?qty=2",
		],
		[
			step({ action: "set_viewport", width: 375, height: 812 }),
			"Set the viewport to 375×812",
		],
		[step({ action: "expect_no_console_errors" }), "Expect no console errors"],
	])("%#", (planned, words) => {
		expect(describeStep(planned)).toBe(words);
	});

	it("labels the report's steps from the plan and bounds what it stores", () => {
		const steps = [
			step({ action: "goto", path: "/cart" }),
			step({ action: "expect_no_console_errors" }),
		];
		const fields = browserEvidenceFields({
			result: run({
				report: report({
					steps: [
						{
							index: 0,
							action: "goto",
							status: "passed",
							assertion: false,
							message: null,
							expected: null,
							actual: null,
							duration_ms: 3,
						},
						{
							index: 1,
							action: "expect_no_console_errors",
							status: "failed",
							assertion: true,
							message: "m".repeat(900),
							expected: "e".repeat(900),
							actual: "a".repeat(900),
							duration_ms: 4,
						},
					],
				}),
			}),
			plan: { steps, target },
			purpose: "repro_baseline",
			screenshotEvidenceId: "evd_x",
		});
		expect(fields).toMatchObject({
			phase: "before",
			executor_kind: "docker",
			screenshot_evidence_id: "evd_x",
			startup: { state: "started" },
		});
		expect(fields.step_results.map((item) => item.label)).toEqual([
			"Open /cart",
			"Expect no console errors",
		]);
		expect(fields.step_results[1]?.message?.length).toBeLessThanOrEqual(501);
		expect(fields.step_results[1]?.actual?.length).toBeLessThanOrEqual(301);
	});

	it("puts baseline runs before the patch and every other run after it", () => {
		expect(phaseOf("repro_baseline")).toBe("before");
		expect(phaseOf("repro_post_patch")).toBe("after");
	});
});

describe("the sandbox mode an investigation ran under", () => {
	it.each([
		[
			"its own snapshot",
			{ sandbox: { mode: "disabled" } },
			"docker",
			"disabled",
		],
		[
			"its own snapshot over this environment",
			{ sandbox: { mode: "docker" } },
			"disabled",
			"docker",
		],
		[
			"this environment when the snapshot predates it",
			{ inference: {} },
			"disabled",
			"disabled",
		],
		[
			"this environment when the snapshot's value is unknown",
			{ sandbox: { mode: "vm" } },
			"docker",
			"docker",
		],
		[
			"this environment when the snapshot's value is not text",
			{ sandbox: null },
			"fake",
			"fake",
		],
	] as const)("uses %s", (_name, snapshot, current, expected) => {
		expect(sandboxModeOf(snapshot, current)).toBe(expected);
	});
});

describe("screenshots and the report contract", () => {
	it("accepts PNG bytes only", () => {
		expect(isPng(TINY_PNG)).toBe(true);
		expect(isPng(Buffer.from("<html><script>alert(1)</script></html>"))).toBe(
			false,
		);
		expect(isPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]))).toBe(
			false,
		);
		expect(isPng(TINY_PNG.subarray(0, 8))).toBe(false);
	});

	it("clips every runner string within the contract's limits", () => {
		const long = "x".repeat(5000);
		expect(clip(long, 1000)).toHaveLength(1000);
		expect(clip("short", 1000)).toBe("short");
		expect(clip(null, 10)).toBeNull();
		const bounded = report({
			steps: [
				{
					index: 0,
					action: "expect_text",
					status: "failed",
					assertion: true,
					message: clip(long, 2000),
					expected: clip(long, 1000),
					actual: clip(long, 1000),
					duration_ms: 1,
				},
			],
			console_errors: [clip(long, 1000) ?? ""],
			blocked_requests: [clip(long, 300) ?? ""],
			startup: startup({
				health_error: clip(long, 100),
				page_error: clip(long, 500),
			}),
		});
		expect(BrowserRunReportSchema.safeParse(bounded).success).toBe(true);
	});

	it("parses the runner's report with startup facts, and without them", () => {
		expect(BrowserRunReportSchema.safeParse(report()).success).toBe(true);
		const { startup: _omitted, ...older } = report();
		expect(BrowserRunReportSchema.safeParse(older).success).toBe(true);
		expect(
			BrowserRunReportSchema.safeParse(
				report({ startup: { ...startup(), health_attempts: -1 } }),
			).success,
		).toBe(false);
	});
});
