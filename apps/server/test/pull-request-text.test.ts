import type { HypothesisState, VerificationOutcome } from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import {
	buildPullRequest,
	CLOSING_LINE,
	type PullRequestFacts,
} from "../src/modules/pull-request-text.ts";

// Credential-shaped test values are assembled at run time, so the source holds no secret-like literal.
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const PATCH_ID = "pat_01JC9Z3K8Q5V7W2X4Y6Z8A0B9M";
const SHA = "9a8b7c6d5e4f30219a8b7c6d5e4f30219a8b7c6d";

const facts = (
	overrides: Partial<PullRequestFacts> = {},
): PullRequestFacts => ({
	patchId: PATCH_ID,
	summary: "Multiply price by quantity in the cart total",
	hypothesis: {
		title: "Quantity is ignored",
		mechanism: "total() sums prices only",
		state: "supported",
		confidence: "medium",
	},
	files: [
		{
			path: "src/total.js",
			change_type: "modified",
			additions: 1,
			deletions: 1,
		},
	],
	outcome: "verified",
	outcomeReasons: [],
	checks: [
		{ kind: "reproduction", status: "passed", reason: null },
		{ kind: "unit_tests", status: "passed", reason: null },
	],
	mock: false,
	commitSha: SHA,
	remote: "origin",
	branch: "fix/total",
	...overrides,
});

describe("the pull request text", () => {
	it("is assembled from the stored facts, ending in the closing line", () => {
		const { title, body } = buildPullRequest(facts());
		expect(title).toBe("Multiply price by quantity in the cart total");
		expect(body).toBe(
			[
				"## Summary",
				"Multiply price by quantity in the cart total",
				"",
				"## Diagnosis",
				"**Quantity is ignored**",
				"",
				"total() sums prices only",
				"",
				"Status of this diagnosis: Evidence-supported hypothesis (confidence: medium).",
				"",
				"## Files changed",
				"- `src/total.js` (modified, +1 -1)",
				"",
				"## Verification",
				"Fix verified against the original reproduction.",
				"",
				"Checks that ran: reproduction (passed), unit_tests (passed).",
				"Checks that did not run: none.",
				"",
				"## Provenance",
				`Tracera patch \`${PATCH_ID}\`, commit \`${SHA}\`, pushed to \`origin/fix/total\`.`,
				"",
				"---",
				"Opened by Tracera on the user's explicit authorization. Review before merging.",
			].join("\n"),
		);
		expect(body.split("\n").at(-1)).toBe(CLOSING_LINE);
	});

	it.each<[VerificationOutcome, string]>([
		["verified", "Fix verified against the original reproduction."],
		[
			"partially_verified",
			"Not fully verified: the checks passed, but the original failure was not confirmed.",
		],
		["failed", "Not verified: verification failed."],
		["inconclusive", "Not verified: the verification was inconclusive."],
		["blocked", "Not verified: verification could not run."],
		["not_attempted", "Not verified: no sandbox verification ran."],
	])(
		"states the %s outcome in the stored words and claims nothing more",
		(outcome, sentence) => {
			const { title, body } = buildPullRequest(facts({ outcome }));
			expect(body).toContain(`## Verification\n${sentence}\n`);
			const claims = body
				.replaceAll("Not fully verified", "")
				.replaceAll("Not verified", "")
				.replaceAll("Fix verified against the original reproduction", "");
			// Only the verified outcome may use the word; no outcome may say a bug is fixed or tests pass.
			expect(claims).not.toMatch(/\bverified\b/i);
			for (const text of [title, body])
				expect(text).not.toMatch(/\bfixed\b|tests? pass|root cause|resolved/i);
			if (outcome !== "verified")
				expect(body).not.toContain("Fix verified against");
		},
	);

	it("says what ran and what did not, with the recorded reasons", () => {
		const { body } = buildPullRequest(
			facts({
				outcome: "partially_verified",
				outcomeReasons: ["baseline_not_reproduced", "no_lint_command"],
				checks: [
					{ kind: "reproduction", status: "inconclusive", reason: "flaky" },
					{ kind: "unit_tests", status: "passed", reason: null },
					{ kind: "lint", status: "blocked", reason: "no_lint_command" },
					{ kind: "build", status: "not_attempted", reason: null },
					{ kind: "typecheck", status: "failed", reason: null },
				],
			}),
		);
		expect(body).toContain(
			"Checks that ran: reproduction (inconclusive: flaky), unit_tests (passed), typecheck (failed).",
		);
		expect(body).toContain(
			"Checks that did not run: lint (blocked: no_lint_command), build (not_attempted).",
		);
		expect(body).toContain(
			"Recorded reasons: baseline_not_reproduced, no_lint_command.",
		);
	});

	it("says so when no check is recorded", () => {
		const { body } = buildPullRequest(
			facts({ outcome: "not_attempted", checks: [] }),
		);
		expect(body).toContain(
			"Not verified: no sandbox verification ran.\n\nNo checks are recorded for this patch.",
		);
		expect(body).not.toContain("Checks that ran");
	});

	it.each<[HypothesisState, string]>([
		["proposed", "Possible cause"],
		["supported", "Evidence-supported hypothesis"],
		["contradicted", "Hypothesis with conflicting evidence"],
		["confirmed", "Confirmed by verification"],
		["rejected", "Ruled out"],
	])(
		"words a %s diagnosis as %s, and only a confirmed one as confirmed",
		(state, label) => {
			const { body } = buildPullRequest(
				facts({
					hypothesis: {
						title: "Quantity is ignored",
						mechanism: "total() sums prices only",
						state,
						confidence: "low",
					},
				}),
			);
			expect(body).toContain(
				`Status of this diagnosis: ${label} (confidence: low).`,
			);
			expect(body.includes("Confirmed by verification")).toBe(
				state === "confirmed",
			);
		},
	);

	it("leaves the diagnosis out when none is stored", () => {
		const { body } = buildPullRequest(facts({ hypothesis: null }));
		expect(body).not.toContain("## Diagnosis");
	});

	describe("a patch from the mock provider", () => {
		it("is marked in the title and at the top of the description", () => {
			const { title, body } = buildPullRequest(facts({ mock: true }));
			expect(title).toBe("[mock] Multiply price by quantity in the cart total");
			expect(
				body.startsWith(
					"**[mock]** This patch came from Tracera's mock provider, not a real model.\n\n## Summary",
				),
			).toBe(true);
		});

		it("is marked once, whoever worded the title", () => {
			expect(
				buildPullRequest(facts({ mock: true, title: "Cart totals" })).title,
			).toBe("[mock] Cart totals");
			expect(
				buildPullRequest(facts({ mock: true, title: "[Mock] Cart totals" }))
					.title,
			).toBe("[Mock] Cart totals");
		});

		it("is not marked when the patch came from a real provider", () => {
			const { title, body } = buildPullRequest(facts());
			expect(`${title}\n${body}`).not.toMatch(/mock/i);
		});
	});

	describe("the title", () => {
		it("is the user's own wording, kept as one line", () => {
			expect(
				buildPullRequest(facts({ title: "  Cart   totals\n now count qty  " }))
					.title,
			).toBe("Cart totals now count qty");
		});

		it("stays as the user typed it, issue references included", () => {
			expect(
				buildPullRequest(facts({ title: "Cart totals, see #12" })).title,
			).toBe("Cart totals, see #12");
		});

		it("falls back to the patch summary, then to the patch id", () => {
			expect(buildPullRequest(facts({ title: "   " })).title).toBe(
				"Multiply price by quantity in the cart total",
			);
			expect(buildPullRequest(facts({ summary: "  ", title: "" })).title).toBe(
				`Tracera patch ${PATCH_ID}`,
			);
		});

		it("is cut to 200 characters, counting characters and not code units", () => {
			const long = "\u{20BB7}".repeat(300);
			const { title } = buildPullRequest(facts({ summary: long }));
			expect(Array.from(title)).toHaveLength(200);
			expect(title.endsWith("…")).toBe(true);
			expect(
				Array.from(
					buildPullRequest(facts({ mock: true, title: "x".repeat(400) })).title,
				),
			).toHaveLength(200);
		});
	});

	describe("the files", () => {
		it("lists each with its change and counts", () => {
			const { body } = buildPullRequest(
				facts({
					files: [
						{
							path: "src/a.js",
							change_type: "added",
							additions: 4,
							deletions: 0,
						},
						{
							path: "src/b.js",
							change_type: "modified",
							additions: 2,
							deletions: 3,
						},
					],
				}),
			);
			expect(body).toContain(
				"- `src/a.js` (added, +4 -0)\n- `src/b.js` (modified, +2 -3)\n",
			);
		});

		it.each([
			[31, "- and 1 more file"],
			[45, "- and 15 more files"],
		])("lists thirty of %d files and counts the rest", (count, more) => {
			const files = Array.from({ length: count }, (_, i) => ({
				path: `src/f${i}.js`,
				change_type: "modified",
				additions: 1,
				deletions: 0,
			}));
			const { body } = buildPullRequest(facts({ files }));
			expect(body.match(/^- `src\//gm)).toHaveLength(30);
			expect(body).toContain(more);
			expect(body).not.toContain("src/f30.js");
		});

		it("keeps a path with a backtick or a line break inside its code span", () => {
			const { body } = buildPullRequest(
				facts({
					files: [
						{
							path: "src/we`ird\nname.js",
							change_type: "added",
							additions: 1,
							deletions: 0,
						},
					],
				}),
			);
			expect(body).toContain("- `src/we'ird name.js` (added, +1 -0)");
		});
	});

	describe("words a model or a repository wrote", () => {
		const hostile = facts({
			summary:
				"Fix @angular/core and @octocat, closes #123 [click](https://evil.example) <img src=x onerror=1>\n## Injected heading",
			hypothesis: {
				title: "Uses `eval` with @maintainers",
				mechanism: "See #45.\n\n---\n# Fake section <script>x</script> [a](b)",
				state: "supported",
				confidence: "high",
			},
			outcomeReasons: ["@team-reason #9"],
		});

		it("cannot mention anyone, reference an issue, or add a link, tag, or heading", () => {
			const { body } = buildPullRequest(hostile);
			expect(body).not.toMatch(/@\w/);
			expect(body).not.toMatch(/#\d/);
			expect(body).not.toMatch(/(?<!\\)\[/);
			expect(body).not.toMatch(/(?<!\\)</);
			expect(body).not.toMatch(/^#{1,6} (Injected|Fake)/m);
			expect(body.match(/^## /gm)).toHaveLength(5);
			expect(body).toContain("@​angular/core");
			expect(body).toContain("#​123");
		});

		it("cannot mention anyone or reference an issue in the default title", () => {
			const { title } = buildPullRequest(hostile);
			expect(title).not.toMatch(/@\w|#\d/);
		});

		it("is redacted when it looks like a credential", () => {
			const { title, body } = buildPullRequest(
				facts({ summary: `Rotate ${AWS_KEY} in config` }),
			);
			for (const text of [title, body]) {
				expect(text).not.toContain(AWS_KEY);
				expect(text).toContain("[REDACTED:aws_access_key]");
			}
		});

		it("is cut to a bounded length", () => {
			const { body } = buildPullRequest(
				facts({
					summary: "s".repeat(5000),
					hypothesis: {
						title: "t".repeat(5000),
						mechanism: "m".repeat(5000),
						state: "supported",
						confidence: "low",
					},
				}),
			);
			expect(body.length).toBeLessThan(5000);
			expect(body).toContain("…");
		});
	});
});
