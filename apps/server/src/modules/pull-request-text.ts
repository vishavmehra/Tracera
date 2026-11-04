import type { HypothesisState, VerificationOutcome } from "@tracera/contracts";
import { redactSecrets } from "../lib/redact.ts";
import { OUTCOME_LABEL, STATE_LABEL } from "./report.ts";

// The title and description of a pull request are assembled by code from stored rows, never by a model,
// so no sentence can claim more than the data does. Text that a model or a repository wrote is quoted
// as inert single lines: it cannot add a link, a heading, an @-mention, or an issue reference.

export const CLOSING_LINE =
	"Opened by Tracera on the user's explicit authorization. Review before merging.";

const MAX_TITLE = 200;
const MAX_LISTED_FILES = 30;
const NOT_RUN = new Set(["blocked", "not_attempted"]);

/** Only a verified outcome may speak of verification; every other sentence says what did not happen. */
const OUTCOME_SENTENCE: Record<VerificationOutcome, string> = {
	verified: `${OUTCOME_LABEL.verified}.`,
	partially_verified:
		"Not fully verified: the checks passed, but the original failure was not confirmed.",
	failed: "Not verified: verification failed.",
	inconclusive: "Not verified: the verification was inconclusive.",
	blocked: "Not verified: verification could not run.",
	not_attempted: "Not verified: no sandbox verification ran.",
};

export type PullRequestFacts = {
	patchId: string;
	summary: string;
	hypothesis: {
		title: string;
		mechanism: string;
		state: HypothesisState;
		confidence: string;
	} | null;
	files: ReadonlyArray<{
		path: string;
		change_type: string;
		additions: number;
		deletions: number;
	}>;
	outcome: VerificationOutcome;
	outcomeReasons: readonly string[];
	checks: ReadonlyArray<{
		kind: string;
		status: string;
		reason: string | null;
	}>;
	/** The patch came from the mock provider. */
	mock: boolean;
	commitSha: string;
	remote: string;
	/** The remote branch the pull request is opened from. */
	branch: string;
	/** The user's own title; the patch summary stands in when absent. */
	title?: string | undefined;
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const cut = (text: string, max: number) => {
	const chars = Array.from(text);
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};
/** Breaks the @-mention and #-reference patterns with an invisible character. */
const unlinked = (text: string) =>
	text.replace(/@(?=\w)/g, "@​").replace(/#(?=\d)/g, "#​");
/** Model or repository text as one line that renders as plain text. */
const inert = (text: string, max: number) =>
	unlinked(cut(oneLine(text), max)).replace(/[\\`[<]/g, "\\$&");
const code = (text: string) => `\`${oneLine(text).replaceAll("`", "'")}\``;

function titleOf(facts: PullRequestFacts): string {
	const chosen = oneLine(facts.title ?? "");
	// The patch summary is the model's wording; the user's own title is theirs to word.
	const base =
		chosen ||
		unlinked(oneLine(facts.summary)) ||
		`Tracera patch ${facts.patchId}`;
	return cut(
		facts.mock && !/^\[mock\]/i.test(base) ? `[mock] ${base}` : base,
		MAX_TITLE,
	);
}

function verificationLines(facts: PullRequestFacts): string[] {
	const ran = facts.checks.filter((check) => !NOT_RUN.has(check.status));
	const didNot = facts.checks.filter((check) => NOT_RUN.has(check.status));
	const describe = (check: PullRequestFacts["checks"][number]) =>
		`${check.kind} (${check.status}${check.reason ? `: ${inert(check.reason, 80)}` : ""})`;
	const lines = [OUTCOME_SENTENCE[facts.outcome], ""];
	if (facts.checks.length === 0)
		lines.push("No checks are recorded for this patch.");
	else {
		lines.push(
			`Checks that ran: ${ran.length ? ran.map(describe).join(", ") : "none"}.`,
		);
		lines.push(
			`Checks that did not run: ${didNot.length ? didNot.map(describe).join(", ") : "none"}.`,
		);
	}
	if (facts.outcomeReasons.length > 0)
		lines.push(
			"",
			`Recorded reasons: ${facts.outcomeReasons.map((reason) => inert(reason, 80)).join(", ")}.`,
		);
	return lines;
}

/** The pull request title and description for a patch, from stored facts only. */
export function buildPullRequest(facts: PullRequestFacts): {
	title: string;
	body: string;
} {
	const listed = facts.files.slice(0, MAX_LISTED_FILES);
	const more = facts.files.length - listed.length;
	const lines: string[] = [];
	if (facts.mock)
		lines.push(
			"**[mock]** This patch came from Tracera's mock provider, not a real model.",
			"",
		);
	lines.push("## Summary", inert(facts.summary, 1000), "");
	if (facts.hypothesis)
		lines.push(
			"## Diagnosis",
			`**${inert(facts.hypothesis.title, 200)}**`,
			"",
			inert(facts.hypothesis.mechanism, 1500),
			"",
			`Status of this diagnosis: ${STATE_LABEL[facts.hypothesis.state]} (confidence: ${inert(facts.hypothesis.confidence, 20)}).`,
			"",
		);
	lines.push(
		"## Files changed",
		...listed.map(
			(file) =>
				`- ${code(cut(file.path, 300))} (${inert(file.change_type, 20)}, +${file.additions} -${file.deletions})`,
		),
		...(more > 0
			? [`- and ${more} more ${more === 1 ? "file" : "files"}`]
			: []),
		"",
		"## Verification",
		...verificationLines(facts),
		"",
		"## Provenance",
		`Tracera patch ${code(facts.patchId)}, commit ${code(facts.commitSha)}, pushed to ${code(`${facts.remote}/${facts.branch}`)}.`,
		"",
		"---",
		CLOSING_LINE,
	);
	return {
		title: redactSecrets(titleOf(facts), { redactEmails: false }).text,
		body: redactSecrets(lines.join("\n"), { redactEmails: false }).text,
	};
}
