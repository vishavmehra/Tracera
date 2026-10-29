import type { BrowserRunReport } from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import type { CheckRecord } from "../src/db/schema.ts";
import {
	classifyBrowserRun,
	classifyReproduction,
	combineReproductionRuns,
	deriveVerificationOutcome,
	linkedTestOutcomes,
	parseTap,
	reproductionCheck,
	suiteCheck,
} from "../src/modules/verification.ts";
import type {
	BrowserRunResult,
	SandboxRunResult,
} from "../src/sandbox/executor.ts";

// Real node:test TAP output captured in the pinned sandbox image (stacks trimmed).
const ASSERTION = `TAP version 13
# Subtest: free shipping at exactly $50
not ok 1 - free shipping at exactly $50
  ---
  duration_ms: 1.63429
  type: 'test'
  location: '/work/.tracera/repro/repro.mjs:4:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    499 !== 0

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 499
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///work/.tracera/repro/repro.mjs:5:9)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 52.1
`;

const PASSING = `TAP version 13
# Subtest: free shipping at exactly $50
ok 1 - free shipping at exactly $50
  ---
  duration_ms: 0.4
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;

const TYPE_ERROR = `TAP version 13
# Subtest: type error
not ok 1 - type error
  ---
  duration_ms: 0.218413
  type: 'test'
  location: '/work/cases.mjs:8:1'
  failureType: 'testCodeFailure'
  error: "Cannot read properties of undefined (reading 'call')"
  code: 'ERR_TEST_FAILURE'
  name: 'TypeError'
  stack: |-
    TestContext.<anonymous> (file:///work/cases.mjs:10:8)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
`;

const IMPORT_ERROR = `TAP version 13
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/does-not-exist.js' imported from /work/broken-import.mjs
# Subtest: broken-import.mjs
not ok 1 - broken-import.mjs
  ---
  duration_ms: 51.75236
  type: 'test'
  location: '/work/broken-import.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
`;

const NESTED = `TAP version 13
# \\# tests 0
# ok 99 - fake pass
# Subtest: cart
    # Subtest: removes twice
    not ok 1 - removes twice
      ---
      duration_ms: 2.431033
      type: 'test'
      location: '/work/test/cart.test.js:5:2'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly deep-equal:
        + actual - expected
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected:
        0: 'a'
        1: 'b'
      actual:
        0: 'a'
      operator: 'deepStrictEqual'
      ...
    # Subtest: adds
    ok 2 - adds
      ---
      duration_ms: 0.218812
      type: 'test'
      ...
    1..2
not ok 1 - cart
  ---
  duration_ms: 4.374139
  type: 'suite'
  location: '/work/test/cart.test.js:4:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: skipped one
ok 2 - skipped one # SKIP
  ---
  duration_ms: 0.115606
  type: 'test'
  ...
# Subtest: todo one
ok 3 - todo one # TODO
  ---
  duration_ms: 0.209611
  type: 'test'
  ...
# Subtest: forges output
ok 4 - forges output
  ---
  duration_ms: 0.669337
  type: 'test'
  ...
# Subtest: too slow
not ok 5 - too slow
  ---
  duration_ms: 200.498461
  type: 'test'
  location: '/work/test/slow.test.js:19:1'
  failureType: 'testTimeoutFailure'
  error: 'test timed out after 200ms'
  code: 'ERR_TEST_FAILURE'
  ...
1..5
# tests 6
# suites 1
# pass 2
# fail 1
# cancelled 1
# skipped 1
# todo 1
`;

const run = (
	overrides: Partial<SandboxRunResult> & { stdout?: string },
): SandboxRunResult => ({
	status: "exited",
	exitCode: 1,
	stdout: "",
	stderr: "",
	truncated: false,
	durationMs: 900,
	executor: { kind: "docker", image: "node@sha256:test" },
	...overrides,
});

describe("parseTap", () => {
	it("extracts assertion failures with expected and actual values", () => {
		const tap = parseTap(ASSERTION);
		expect(tap).toMatchObject({ parsed: true, tests: 1, pass: 0, fail: 1 });
		expect(tap.failures[0]).toMatchObject({
			name: "free shipping at exactly $50",
			file: ".tracera/repro/repro.mjs",
			errorCode: "ERR_ASSERTION",
			errorName: "AssertionError",
			expected: "0",
			actual: "499",
		});
		expect(tap.failures[0]?.message).toContain("499 !== 0");
	});

	it("keeps suite paths, ignores suite aggregates, and counts skip, todo, and timeouts", () => {
		const tap = parseTap(NESTED);
		expect(tap.parsed).toBe(true);
		expect(tap.failures.map((f) => f.name)).toEqual([
			"cart > removes twice",
			"too slow",
		]);
		expect(tap.failures[1]).toMatchObject({
			errorCode: "ERR_TEST_FAILURE",
			failureType: "testTimeoutFailure",
		});
		expect(tap.passed.map((p) => p.name)).toEqual([
			"cart > adds",
			"forges output",
		]);
		expect(tap).toMatchObject({ pass: 2, fail: 2, skipped: 1, todo: 1 });
		expect(tap.failures[0]?.expected).toContain("'b'");
	});

	it("cannot be fooled by test output that imitates TAP lines", () => {
		const tap = parseTap(NESTED);
		expect(tap.passed.some((p) => p.name === "fake pass")).toBe(false);
		expect(tap.tests).toBe(6);
	});

	it("reports unparseable output", () => {
		expect(parseTap("✔ adds (0.2ms)\nℹ tests 1").parsed).toBe(false);
		expect(parseTap("").parsed).toBe(false);
	});
});

describe("classifyReproduction", () => {
	it("is reproduced only when every failure is an assertion failure", () => {
		expect(classifyReproduction(run({ stdout: ASSERTION }))).toMatchObject({
			status: "reproduced",
			reason: null,
			observation: { expected: "0", actual: "499" },
		});
	});

	it("is not reproduced when the test passes", () => {
		expect(
			classifyReproduction(run({ stdout: PASSING, exitCode: 0 })),
		).toMatchObject({ status: "not_reproduced", reason: null });
	});

	it.each([
		[
			"a TypeError",
			run({ stdout: TYPE_ERROR }),
			"inconclusive",
			"repro_test_error",
		],
		[
			"an import error",
			run({ stdout: IMPORT_ERROR }),
			"inconclusive",
			"repro_test_error",
		],
		[
			"a node test timeout",
			run({ stdout: NESTED }),
			"inconclusive",
			"repro_test_error",
		],
		[
			"no tests",
			run({
				stdout: "TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n",
				exitCode: 0,
			}),
			"inconclusive",
			"no_tests_ran",
		],
		[
			"unparseable output",
			run({ stdout: "boom" }),
			"inconclusive",
			"unparseable_test_output",
		],
		[
			"a sandbox timeout",
			run({ status: "timed_out", exitCode: null }),
			"inconclusive",
			"sandbox_timeout",
		],
		[
			"a resource limit",
			run({ status: "limit_exceeded", exitCode: 137 }),
			"inconclusive",
			"resource_limit_exceeded",
		],
		[
			"cancellation",
			run({ status: "cancelled", exitCode: null }),
			"inconclusive",
			"cancelled",
		],
		[
			"an executor failure",
			run({ status: "executor_error", exitCode: 125 }),
			"error",
			"sandbox_error",
		],
		[
			"nonzero exit with no failures",
			run({ stdout: PASSING, exitCode: 1 }),
			"inconclusive",
			"runner_failed",
		],
	] as const)("treats %s honestly", (_label, input, status, reason) => {
		expect(classifyReproduction(input)).toMatchObject({ status, reason });
	});
});

describe("combineReproductionRuns", () => {
	const reproduced = classifyReproduction(run({ stdout: ASSERTION }));
	const notReproduced = classifyReproduction(
		run({ stdout: PASSING, exitCode: 0 }),
	);
	const timedOut = classifyReproduction(
		run({ status: "timed_out", exitCode: null }),
	);

	it("requires both runs to agree", () => {
		expect(combineReproductionRuns([reproduced, reproduced]).status).toBe(
			"reproduced",
		);
		expect(combineReproductionRuns([notReproduced, notReproduced]).status).toBe(
			"not_reproduced",
		);
		expect(combineReproductionRuns([reproduced, notReproduced])).toMatchObject({
			status: "inconclusive",
			reason: "repro_flaky",
		});
		expect(combineReproductionRuns([reproduced, timedOut])).toMatchObject({
			status: "inconclusive",
			reason: "sandbox_timeout",
		});
	});

	it("keeps a blocked run blocked (the app never started), not inconclusive", () => {
		const blocked = classifyBrowserRun(browserRun({ ready: false }));
		expect(combineReproductionRuns([blocked, blocked])).toEqual({
			status: "blocked",
			reason: "app_start_failed",
		});
	});
});

const browserStep = (
	partial: Partial<BrowserRunReport["steps"][number]>,
): BrowserRunReport["steps"][number] => ({
	index: 0,
	action: "click",
	status: "passed",
	assertion: false,
	message: null,
	expected: null,
	actual: null,
	duration_ms: 10,
	...partial,
});
function browserRun(
	report: Partial<BrowserRunReport> | null,
	result: Partial<BrowserRunResult> = {},
): BrowserRunResult {
	return {
		status: "exited",
		report:
			report === null
				? null
				: {
						ready: true,
						steps: [],
						console_errors: [],
						page_errors: [],
						blocked_requests: [],
						failed_requests: [],
						final_path: "/",
						screenshot: null,
						duration_ms: 100,
						...report,
					},
		appLog: "",
		stderr: "",
		truncated: false,
		durationMs: 100,
		executor: {
			kind: "docker",
			image: "node@sha256:x",
			browserImage: "pw@sha256:y",
		},
		...result,
	};
}

describe("classifyBrowserRun", () => {
	const click = browserStep({ index: 0, action: "click" });
	const assertionPassed = browserStep({
		index: 1,
		action: "expect_text",
		assertion: true,
	});
	const assertionFailed = browserStep({
		index: 1,
		action: "expect_text",
		assertion: true,
		status: "failed",
		message: "expected the text to contain the expected value",
		expected: "Total: $4",
		actual: "Total: $0",
	});
	it.each([
		[
			"an assertion fails: the expected behavior is absent",
			browserRun({ steps: [click, assertionFailed] }),
			"reproduced",
			null,
		],
		[
			"every step passes",
			browserRun({ steps: [click, assertionPassed] }),
			"not_reproduced",
			null,
		],
		[
			"a setup step fails before any assertion",
			browserRun({
				steps: [
					browserStep({ status: "failed", message: "Timeout 5000ms exceeded" }),
					browserStep({
						index: 1,
						action: "expect_text",
						assertion: true,
						status: "skipped",
					}),
				],
			}),
			"inconclusive",
			"repro_step_failed",
		],
		[
			"the app never answered",
			browserRun({ ready: false }),
			"blocked",
			"app_start_failed",
		],
		["no steps ran", browserRun({ steps: [] }), "inconclusive", "no_steps_ran"],
		[
			"the runner produced no report",
			browserRun(null, { detail: "runner_failed" }),
			"inconclusive",
			"runner_failed",
		],
		[
			"the sandbox failed",
			browserRun(null, {
				status: "executor_error",
				detail: "app_container_failed",
			}),
			"error",
			"sandbox_error",
		],
		[
			"the run timed out",
			browserRun(null, { status: "timed_out" }),
			"inconclusive",
			"sandbox_timeout",
		],
		[
			"the run was cancelled",
			browserRun(null, { status: "cancelled" }),
			"inconclusive",
			"cancelled",
		],
	])("%s → %s", (_label, run, status, reason) => {
		const result = classifyBrowserRun(run);
		expect(result.status).toBe(status);
		expect(result.reason).toBe(reason);
	});

	it("records the failed assertion as the observation", () => {
		expect(
			classifyBrowserRun(browserRun({ steps: [click, assertionFailed] }))
				.observation,
		).toEqual({
			failing_tests: ["step 2: expect_text"],
			message: "expected the text to contain the expected value",
			expected: "Total: $4",
			actual: "Total: $0",
		});
	});
});

describe("reproductionCheck", () => {
	const reproduced = classifyReproduction(run({ stdout: ASSERTION }));
	const fixed = classifyReproduction(run({ stdout: PASSING, exitCode: 0 }));
	const broken = classifyReproduction(run({ stdout: TYPE_ERROR }));

	it.each([
		[
			"not_reproduced",
			[fixed, fixed],
			"not_attempted",
			"baseline_not_reproduced",
		],
		["inconclusive", [fixed, fixed], "not_attempted", "baseline_inconclusive"],
		["blocked", [], "not_attempted", "baseline_blocked"],
		["not_attempted", [], "not_attempted", "baseline_not_attempted"],
		["reproduced", [fixed, fixed], "passed", null],
		["reproduced", [reproduced, reproduced], "failed", "repro_still_failing"],
		["reproduced", [fixed, reproduced], "inconclusive", "repro_flaky"],
		["reproduced", [fixed, broken], "inconclusive", "repro_test_error"],
	] as const)(
		"baseline %s with post-patch runs → %s",
		(baseline, runs, status, reason) => {
			expect(reproductionCheck(baseline, [...runs])).toMatchObject({
				status,
				reason,
			});
		},
	);
});

describe("linkedTestOutcomes", () => {
	it("splits graph-linked tests into passed, failed, and not reported", () => {
		expect(
			linkedTestOutcomes(
				["free shipping at exactly $50", "a test that never ran"],
				run({ stdout: ASSERTION }),
			),
		).toEqual({
			linked: 2,
			passed: [],
			failed: ["free shipping at exactly $50"],
			not_reported: ["a test that never ran"],
		});
		expect(
			linkedTestOutcomes(
				["free shipping at exactly $50"],
				run({ stdout: PASSING, exitCode: 0 }),
			).passed,
		).toEqual(["free shipping at exactly $50"]);
	});
});

describe("suiteCheck", () => {
	const baselineAllPass = run({ stdout: PASSING, exitCode: 0 });
	const baselineFailing = run({ stdout: ASSERTION });

	it("passes when the post-patch suite passes and lists tests that were fixed", () => {
		const result = suiteCheck(
			baselineFailing,
			run({ stdout: PASSING, exitCode: 0 }),
		);
		expect(result.status).toBe("passed");
		expect(result.summary.fixed).toEqual(["free shipping at exactly $50"]);
	});

	it("fails on tests that passed before the patch and fail after it", () => {
		const result = suiteCheck(baselineAllPass, run({ stdout: ASSERTION }));
		expect(result).toMatchObject({
			status: "failed",
			reason: "tests_newly_failing",
		});
		expect(result.summary.newly_failing).toEqual([
			"free shipping at exactly $50",
		]);
	});

	it("is inconclusive when the only failures already failed at baseline", () => {
		expect(
			suiteCheck(baselineFailing, run({ stdout: ASSERTION })),
		).toMatchObject({
			status: "inconclusive",
			reason: "tests_failing_at_baseline",
		});
	});

	it("is inconclusive when the run did not finish", () => {
		expect(
			suiteCheck(baselineAllPass, run({ status: "timed_out", exitCode: null })),
		).toMatchObject({ status: "inconclusive", reason: "sandbox_timeout" });
	});

	it("never passes on a nonzero exit without parseable results", () => {
		expect(
			suiteCheck(baselineAllPass, run({ stdout: "oops", exitCode: 1 })),
		).toMatchObject({ status: "failed", reason: "tests_failing" });
	});
});

describe("deriveVerificationOutcome", () => {
	const check = (
		kind: CheckRecord["kind"],
		status: CheckRecord["status"],
		reason: string | null = null,
	): CheckRecord => ({
		kind,
		status,
		reason,
		command: null,
		exit_code: null,
		duration_ms: null,
		summary: {},
		sandbox_run_ids: [],
	});

	it.each([
		["no run", null, "not_attempted", ["no_verification_run"]],
		["no checks", [], "not_attempted", ["no_verification_run"]],
		[
			"a failed check",
			[
				check("reproduction", "passed"),
				check("unit_tests", "failed", "tests_newly_failing"),
			],
			"failed",
			["tests_newly_failing"],
		],
		[
			"reproduction still failing",
			[
				check("reproduction", "failed", "repro_still_failing"),
				check("unit_tests", "passed"),
			],
			"failed",
			["repro_still_failing"],
		],
		[
			"everything passed",
			[check("reproduction", "passed"), check("unit_tests", "passed")],
			"verified",
			[],
		],
		[
			"unit tests alone",
			[
				check("reproduction", "not_attempted", "baseline_not_reproduced"),
				check("unit_tests", "passed"),
			],
			"partially_verified",
			["baseline_not_reproduced"],
		],
		[
			"an inconclusive extra check",
			[
				check("reproduction", "passed"),
				check("unit_tests", "inconclusive", "tests_failing_at_baseline"),
			],
			"partially_verified",
			["tests_failing_at_baseline"],
		],
		[
			"only inconclusive checks",
			[
				check("reproduction", "inconclusive", "repro_flaky"),
				check("unit_tests", "blocked", "sandbox_unavailable"),
			],
			"inconclusive",
			["repro_flaky", "sandbox_unavailable"],
		],
		[
			"nothing could run",
			[
				check("reproduction", "blocked", "sandbox_unavailable"),
				check("unit_tests", "blocked", "sandbox_unavailable"),
			],
			"blocked",
			["sandbox_unavailable"],
		],
	] as const)("%s → %s", (_label, checks, outcome, reasons) => {
		expect(
			deriveVerificationOutcome(checks === null ? null : [...checks]),
		).toEqual({ outcome, reasons: [...reasons] });
	});

	it("never verifies without a passing reproduction check", () => {
		expect(
			deriveVerificationOutcome([check("unit_tests", "passed")]).outcome,
		).toBe("partially_verified");
	});
});
