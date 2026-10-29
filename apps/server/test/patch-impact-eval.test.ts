import { describe, expect, it } from "vitest";
import { runPatchImpactEval } from "../../../scripts/patch-impact-eval.ts";

// Patch impact evaluation [static analysis, deterministic, no model calls]: hand-labelled cases over a
// real three-package Git repository, graded at thresholds fixed before results were seen. Runs the
// same code as `npm run eval:patch-impact`, without writing a results file.
describe("patch impact evaluation", () => {
	it("meets every fixed threshold", async () => {
		const report = await runPatchImpactEval();
		const problems = report.cases.flatMap((c) =>
			[
				...c.impacts.missed.map((k) => `missed ${k}`),
				...c.impacts.extra.map((k) => `extra ${k}`),
				...c.invalid_chains.map((id) => `invalid chain ${id}`),
				...c.confidence_violations,
				...c.tests.wrong,
				...c.observed_missing.map((k) => `observed missing ${k}`),
				...(c.risk_ok ? [] : ["risk"]),
				...(c.complete_ok ? [] : ["completeness"]),
				...(c.stable ? [] : ["unstable"]),
			].map((problem) => `${c.id}: ${problem}`),
		);
		expect(problems).toEqual([]);
		expect(report.pass, JSON.stringify(report.metrics)).toBe(true);
	}, 180_000);
});
