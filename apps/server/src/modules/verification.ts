import type {
	CheckStatus,
	ReproductionStatus,
	VerificationOutcome,
} from "@tracera/contracts";
import type { CheckRecord } from "../db/schema.ts";
import type {
	BrowserRunResult,
	SandboxRunResult,
} from "../sandbox/executor.ts";

// Pure interpretation of sandbox facts. Shared by the investigation
// pipeline and the evaluator so both apply identical rules. Test output is untrusted: node:test prefixes
// anything a test prints with "# " and escapes "#", so test points and summaries cannot be forged.

export type TapTest = { name: string; file: string | null };
export type TapFailure = TapTest & {
	errorCode: string | null;
	errorName: string | null;
	failureType: string | null;
	message: string;
	expected: string | null;
	actual: string | null;
};
export type TapSummary = {
	parsed: boolean;
	tests: number;
	pass: number;
	fail: number;
	skipped: number;
	todo: number;
	passed: TapTest[];
	failures: TapFailure[];
	/** Reporter summary lines disagreed with the test points (informational). */
	summaryMismatch: boolean;
};

const POINT = /^( *)(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/;
const SUBTEST = /^( *)# Subtest: (.*)$/;
const SUMMARY = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/;

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}…` : text;
const unescapeName = (name: string) =>
	name.replace(/\\#/g, "#").replace(/\\\\/g, "\\");

function scalar(raw: string): string {
	const value = raw.trim();
	if (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		return value.slice(1, -1).replace(/''/g, "'");
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			return JSON.parse(value) as string;
		} catch {
			return value.slice(1, -1);
		}
	}
	return value === "~" ? "" : value;
}

/** Reads the YAML diagnostics block after a test point (keys at `indent`); returns the next line index. */
function readDiagnostics(
	lines: string[],
	start: number,
	indent: number,
): { fields: Record<string, string>; next: number } {
	const fields: Record<string, string> = {};
	const pad = " ".repeat(indent);
	if (lines[start] !== `${pad}---`) return { fields, next: start };
	let i = start + 1;
	const keyLine = new RegExp(`^ {${indent}}([A-Za-z_]+):(?: (.*))?$`);
	while (i < lines.length && lines[i] !== `${pad}...`) {
		const match = keyLine.exec(lines[i] ?? "");
		i += 1;
		if (!match?.[1]) continue;
		const rest = match[2] ?? "";
		if (rest === "" || /^[|>][-+]?$/.test(rest)) {
			const block: string[] = [];
			while (
				i < lines.length &&
				lines[i] !== `${pad}...` &&
				((lines[i] ?? "").trim() === "" ||
					(lines[i] ?? "").startsWith(`${pad} `))
			) {
				block.push((lines[i] ?? "").slice(indent + 2));
				i += 1;
			}
			fields[match[1]] = block.join("\n").trim();
		} else {
			fields[match[1]] = scalar(rest);
		}
	}
	return { fields, next: i + 1 };
}

const fileOf = (location: string | undefined) =>
	location ? location.replace(/^\/work\//, "").replace(/:\d+:\d+$/, "") : null;

export function parseTap(output: string): TapSummary {
	const lines = output.split(/\r?\n/);
	const open: Array<{ indent: number; name: string }> = [];
	const passed: TapTest[] = [];
	const failures: TapFailure[] = [];
	const summary: Record<string, number> = {};
	let skipped = 0;
	let todo = 0;
	let sawVersion = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.startsWith("TAP version")) {
			sawVersion = true;
			continue;
		}
		const subtest = SUBTEST.exec(line);
		if (subtest) {
			open.push({
				indent: subtest[1]?.length ?? 0,
				name: unescapeName(subtest[2] ?? ""),
			});
			continue;
		}
		const total = SUMMARY.exec(line);
		if (total?.[1]) {
			summary[total[1]] = Number(total[2]);
			continue;
		}
		const point = POINT.exec(line);
		if (!point) continue;
		const indent = point[1]?.length ?? 0;
		const name = unescapeName(point[3] ?? "");
		const own = open.findLastIndex((entry) => entry.indent === indent);
		if (own !== -1) open.splice(own);
		const fullName = [
			...open.filter((entry) => entry.indent < indent).map((e) => e.name),
			name,
		].join(" > ");
		const { fields, next } = readDiagnostics(lines, i + 1, indent + 2);
		i = next - 1;
		if (fields.type === "suite") continue;
		if (point[4] === "SKIP") skipped += 1;
		else if (point[4] === "TODO") todo += 1;
		else if (point[2] === "ok")
			passed.push({ name: fullName, file: fileOf(fields.location) });
		else
			failures.push({
				name: fullName,
				file: fileOf(fields.location),
				errorCode: fields.code ?? null,
				errorName: fields.name ?? null,
				failureType: fields.failureType ?? null,
				message: clip(fields.error ?? "", 500),
				expected:
					fields.expected === undefined ? null : clip(fields.expected, 300),
				actual: fields.actual === undefined ? null : clip(fields.actual, 300),
			});
	}
	const tests = passed.length + failures.length + skipped + todo;
	return {
		parsed: sawVersion && summary.tests !== undefined,
		tests,
		pass: passed.length,
		fail: failures.length,
		skipped,
		todo,
		passed,
		failures,
		summaryMismatch: summary.tests !== undefined && summary.tests !== tests,
	};
}

export type ReproductionRunResult = {
	status: ReproductionStatus;
	reason: string | null;
	observation: {
		failing_tests: string[];
		message: string | null;
		expected: string | null;
		actual: string | null;
	} | null;
	tap: TapSummary;
};

const UNFINISHED: Record<string, string> = {
	timed_out: "sandbox_timeout",
	limit_exceeded: "resource_limit_exceeded",
	cancelled: "cancelled",
};

/** `reproduced` only when the test ran and every failure is an assertion about the expected behavior. */
export function classifyReproduction(
	run: SandboxRunResult,
): ReproductionRunResult {
	const tap = parseTap(run.stdout);
	const observation = () => {
		const first = tap.failures[0];
		return {
			failing_tests: tap.failures.map((failure) => failure.name),
			message: first?.message ?? null,
			expected: first?.expected ?? null,
			actual: first?.actual ?? null,
		};
	};
	const result = (
		status: ReproductionStatus,
		reason: string | null,
		withObservation = false,
	): ReproductionRunResult => ({
		status,
		reason,
		observation: withObservation ? observation() : null,
		tap,
	});
	if (run.status === "executor_error") return result("error", "sandbox_error");
	const unfinished = UNFINISHED[run.status];
	if (unfinished) return result("inconclusive", unfinished);
	if (!tap.parsed) return result("inconclusive", "unparseable_test_output");
	if (tap.pass + tap.fail === 0) return result("inconclusive", "no_tests_ran");
	if (tap.failures.length > 0)
		return tap.failures.every(
			(failure) => failure.errorCode === "ERR_ASSERTION",
		)
			? result("reproduced", null, true)
			: result("inconclusive", "repro_test_error", true);
	return run.exitCode === 0
		? result("not_reproduced", null)
		: result("inconclusive", "runner_failed");
}

/**
 * A browser run: the steps' assertions encode the expected behavior, so a failed assertion
 * means the reported behavior was observed (`reproduced`); a failed setup step proves nothing
 * (`inconclusive`); an app that never answered its ready path could not be tried (`blocked`).
 */
export function classifyBrowserRun(
	run: BrowserRunResult,
): ReproductionRunResult {
	const tap = parseTap("");
	const result = (
		status: ReproductionStatus,
		reason: string | null,
		observation: ReproductionRunResult["observation"] = null,
	): ReproductionRunResult => ({ status, reason, observation, tap });
	if (run.status === "executor_error") return result("error", "sandbox_error");
	const unfinished = UNFINISHED[run.status];
	if (unfinished) return result("inconclusive", unfinished);
	const report = run.report;
	if (!report) return result("inconclusive", "runner_failed");
	if (!report.ready) return result("blocked", "app_start_failed");
	const failed = report.steps.find((step) => step.status === "failed");
	if (failed && !failed.assertion)
		return result("inconclusive", "repro_step_failed");
	if (failed)
		return result("reproduced", null, {
			failing_tests: [`step ${failed.index + 1}: ${failed.action}`],
			message: failed.message,
			expected: failed.expected,
			actual: failed.actual,
		});
	const ran = report.steps.filter((step) => step.status === "passed");
	if (ran.length === 0) return result("inconclusive", "no_steps_ran");
	return result("not_reproduced", null);
}

/** Runs must agree; a mixed result is flaky, never reproduced (determinism check). */
export function combineReproductionRuns(
	runs: readonly ReproductionRunResult[],
): { status: ReproductionStatus; reason: string | null } {
	const first = runs[0];
	if (!first) return { status: "not_attempted", reason: "no_runs" };
	const problem = runs.find(
		(run) => run.status !== "reproduced" && run.status !== "not_reproduced",
	);
	if (problem)
		return {
			status:
				problem.status === "error" || problem.status === "blocked"
					? problem.status
					: "inconclusive",
			reason: problem.reason,
		};
	return runs.every((run) => run.status === first.status)
		? { status: first.status, reason: null }
		: { status: "inconclusive", reason: "repro_flaky" };
}

const BASELINE_REASON: Record<string, string> = {
	not_reproduced: "baseline_not_reproduced",
	inconclusive: "baseline_inconclusive",
	error: "baseline_inconclusive",
	blocked: "baseline_blocked",
	not_attempted: "baseline_not_attempted",
};

export function reproductionCheck(
	baseline: ReproductionStatus | null,
	post: readonly ReproductionRunResult[],
): { status: CheckStatus; reason: string | null } {
	if (baseline !== "reproduced")
		return {
			status: "not_attempted",
			reason: BASELINE_REASON[baseline ?? "not_attempted"] ?? null,
		};
	const combined = combineReproductionRuns(post);
	if (combined.status === "not_reproduced")
		return { status: "passed", reason: null };
	if (combined.status === "reproduced")
		return { status: "failed", reason: "repro_still_failing" };
	return {
		status: "inconclusive",
		reason: combined.reason ?? "repro_inconclusive",
	};
}

export type SuiteCheckSummary = {
	tests: number;
	passed: number;
	failed: number;
	newly_failing: string[];
	still_failing: string[];
	fixed: string[];
};

/**
 * Compares a post-patch suite run with the baseline run. Tests are matched by full name (passing
 * test points carry no file location in node:test TAP).
 */
export function suiteCheck(
	baseline: SandboxRunResult | null,
	post: SandboxRunResult,
): { status: CheckStatus; reason: string | null; summary: SuiteCheckSummary } {
	const postTap = parseTap(post.stdout);
	const baseTap = baseline ? parseTap(baseline.stdout) : null;
	const baseFailing = new Set(baseTap?.failures.map((test) => test.name));
	const postPassing = new Set(postTap.passed.map((test) => test.name));
	const summary: SuiteCheckSummary = {
		tests: postTap.tests,
		passed: postTap.pass,
		failed: postTap.fail,
		newly_failing: [],
		still_failing: [],
		fixed: (baseTap?.failures ?? [])
			.filter((test) => postPassing.has(test.name))
			.map((test) => test.name),
	};
	const verdict = (status: CheckStatus, reason: string | null) => ({
		status,
		reason,
		summary,
	});
	if (post.status === "executor_error")
		return verdict("inconclusive", "sandbox_error");
	const unfinished = UNFINISHED[post.status];
	if (unfinished) return verdict("inconclusive", unfinished);
	if (post.exitCode === 0) return verdict("passed", null);
	if (!baseline) return verdict("inconclusive", "no_baseline_comparison");
	const baselineFailed = baseline.exitCode !== 0;
	if (!postTap.parsed || postTap.failures.length === 0 || !baseTap?.parsed)
		return baselineFailed
			? verdict("inconclusive", "tests_failing_at_baseline")
			: verdict(
					"failed",
					postTap.failures.length > 0 ? "tests_newly_failing" : "tests_failing",
				);
	for (const test of postTap.failures)
		(baseFailing.has(test.name)
			? summary.still_failing
			: summary.newly_failing
		).push(test.name);
	return summary.newly_failing.length > 0
		? verdict("failed", "tests_newly_failing")
		: verdict("inconclusive", "tests_failing_at_baseline");
}

/**
 * How the tests the static graph links to the investigated code fared in a suite run. Informational:
 * it never changes a check status or the verification outcome.
 */
export function linkedTestOutcomes(
	linked: readonly string[],
	run: SandboxRunResult,
): {
	linked: number;
	passed: string[];
	failed: string[];
	not_reported: string[];
} {
	const tap = parseTap(run.stdout);
	const passed = new Set(tap.passed.map((test) => test.name));
	const failed = new Set(tap.failures.map((test) => test.name));
	const outcome = {
		linked: linked.length,
		passed: [] as string[],
		failed: [] as string[],
		not_reported: [] as string[],
	};
	for (const name of linked)
		(passed.has(name)
			? outcome.passed
			: failed.has(name)
				? outcome.failed
				: outcome.not_reported
		).push(name);
	return outcome;
}

/**
 * The only writer of verification outcomes: rules evaluated in order, first match
 * wins. A passing test suite alone can never produce `verified`.
 */
export function deriveVerificationOutcome(
	checks: readonly CheckRecord[] | null,
): { outcome: VerificationOutcome; reasons: string[] } {
	if (!checks || checks.length === 0)
		return { outcome: "not_attempted", reasons: ["no_verification_run"] };
	const reasonsWhere = (keep: (check: CheckRecord) => boolean) => [
		...new Set(
			checks
				.filter(keep)
				.map((check) => check.reason ?? `${check.kind}_${check.status}`),
		),
	];
	if (checks.some((check) => check.status === "failed"))
		return {
			outcome: "failed",
			reasons: reasonsWhere((check) => check.status === "failed"),
		};
	const reproduction = checks.find((check) => check.kind === "reproduction");
	if (
		reproduction?.status === "passed" &&
		checks.every((check) => check.status === "passed")
	)
		return { outcome: "verified", reasons: [] };
	const notPassed = reasonsWhere((check) => check.status !== "passed");
	if (checks.some((check) => check.status === "passed"))
		return {
			outcome: "partially_verified",
			reasons:
				notPassed.length > 0 ? notPassed : ["reproduction_check_missing"],
		};
	if (checks.some((check) => check.status === "inconclusive"))
		return { outcome: "inconclusive", reasons: notPassed };
	return { outcome: "blocked", reasons: notPassed };
}
