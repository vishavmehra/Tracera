import path from "node:path";
import type {
	Citation,
	EvidenceBasis,
	HypothesesOutput,
	HypothesisState,
} from "@tracera/contracts";
import type { EvidenceItemKind, StoredCitation } from "../db/schema.ts";
import { REPRO_TEST_PATH } from "../sandbox/executor.ts";

// Pure validation of model output. Models propose; these rules decide
// what is stored, what state a claim is in, and whether an edit may be applied.

// ---- Reproduction tests -----------------------------------------------------------------------

const ALLOWED_BUILTINS = new Set([
	"node:test",
	"node:assert",
	"node:assert/strict",
]);
const FORBIDDEN_CODE: Array<[RegExp, string]> = [
	[/\bimport\s*\(/, "dynamic import() is not allowed"],
	[/\brequire\s*\(/, "require() is not allowed"],
	[
		/\bprocess\s*\.\s*(env|exit|kill|binding|dlopen|chdir|abort)\b/,
		"process.env, process.exit, and similar are not allowed",
	],
	[/\beval\s*\(/, "eval() is not allowed"],
	[/\bFunction\s*\(/, "the Function constructor is not allowed"],
	[/\b(fetch|WebSocket|XMLHttpRequest)\b/, "network access is not allowed"],
	[
		/\b(child_process|worker_threads)\b/,
		"spawning processes or threads is not allowed",
	],
];
const SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

/**
 * A model-written reproduction test may import only node:test, node:assert, and tracked repository
 * modules (relative to REPRO_TEST_PATH). The sandbox is the boundary; this is defense in depth.
 */
export function validateReproTest(
	source: string,
	trackedPaths: ReadonlySet<string>,
): { ok: true; imports: string[] } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	if (source.trim().length === 0 || source.length > 12_000)
		errors.push("The test must be between 1 and 12,000 characters");
	for (const [pattern, message] of FORBIDDEN_CODE)
		if (pattern.test(source)) errors.push(message);
	const imports: string[] = [];
	let importsTestRunner = false;
	for (const match of source.matchAll(SPECIFIER)) {
		const specifier = match[1] ?? match[2] ?? "";
		if (ALLOWED_BUILTINS.has(specifier)) {
			importsTestRunner ||= specifier === "node:test";
			continue;
		}
		if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
			errors.push(`Import ${JSON.stringify(specifier)} is not allowed`);
			continue;
		}
		const target = path.posix.normalize(
			path.posix.join(path.posix.dirname(REPRO_TEST_PATH), specifier),
		);
		if (
			target.startsWith("../") ||
			target.startsWith(".tracera/") ||
			!trackedPaths.has(target)
		) {
			errors.push(
				`Import ${JSON.stringify(specifier)} does not resolve to a tracked repository file`,
			);
			continue;
		}
		if (!imports.includes(target)) imports.push(target);
	}
	if (!importsTestRunner || !/\b(test|it)\s*\(/.test(source))
		errors.push("The file must define at least one node:test test");
	return errors.length === 0 ? { ok: true, imports } : { ok: false, errors };
}

// ---- Evidence citations and claim states -----------------------------------------------------

export type EvidenceIndexItem = {
	handle: string;
	kind: EvidenceItemKind;
	basis: EvidenceBasis;
	locator: Record<string, unknown>;
};
export type EvidenceIndex = ReadonlyMap<string, EvidenceIndexItem>;

type Hypothesis = HypothesesOutput["hypotheses"][number];
export type ValidatedHypothesis = Omit<
	Hypothesis,
	"locations" | "supporting" | "contradicting"
> & {
	locations: StoredCitation[];
	supporting: StoredCitation[];
	contradicting: StoredCitation[];
};
export type ValidatedObservation = Omit<
	HypothesesOutput["observations"][number],
	"citations"
> & { citations: StoredCitation[] };

function inFile(item: EvidenceIndexItem, start: number, end: number) {
	const lines = Number(item.locator.line_count);
	return (
		Number.isInteger(start) &&
		Number.isInteger(end) &&
		start >= 1 &&
		start <= end &&
		end <= lines
	);
}

function validCitation(
	citation: Citation,
	index: EvidenceIndex,
): StoredCitation | null {
	const item = index.get(citation.handle);
	if (!item) return null;
	if (item.kind !== "code_excerpt")
		return { handle: item.handle, start_line: null, end_line: null };
	if (citation.start_line === null || citation.end_line === null)
		return citation.start_line === citation.end_line
			? { handle: item.handle, start_line: null, end_line: null }
			: null;
	return inFile(item, citation.start_line, citation.end_line)
		? {
				handle: item.handle,
				start_line: citation.start_line,
				end_line: citation.end_line,
			}
		: null;
}

/**
 * Citation validation: unknown handles and impossible line ranges are dropped and
 * counted; a hypothesis without a valid location and a valid supporting citation is discarded, as is
 * an observation without a valid citation. Nothing the model claims to have read survives unchecked.
 */
export function validateHypotheses(
	output: HypothesesOutput,
	index: EvidenceIndex,
): {
	hypotheses: ValidatedHypothesis[];
	observations: ValidatedObservation[];
	invalidCitations: number;
	discarded: number;
} {
	let invalidCitations = 0;
	const keep = (citations: readonly Citation[]) => {
		const valid = citations
			.map((citation) => validCitation(citation, index))
			.filter((citation): citation is StoredCitation => citation !== null);
		invalidCitations += citations.length - valid.length;
		return valid;
	};
	const hypotheses: ValidatedHypothesis[] = [];
	let discarded = 0;
	for (const hypothesis of output.hypotheses) {
		const locations = hypothesis.locations.filter((location) => {
			const item = index.get(location.handle);
			return (
				item?.kind === "code_excerpt" &&
				inFile(item, location.start_line, location.end_line)
			);
		});
		invalidCitations += hypothesis.locations.length - locations.length;
		const supporting = keep(hypothesis.supporting);
		const contradicting = keep(hypothesis.contradicting);
		if (locations.length === 0 || supporting.length === 0) {
			discarded += 1;
			continue;
		}
		hypotheses.push({ ...hypothesis, locations, supporting, contradicting });
	}
	const observations = output.observations
		.map((observation) => ({
			...observation,
			citations: keep(observation.citations),
		}))
		.filter((observation) => observation.citations.length > 0);
	return { hypotheses, observations, invalidCitations, discarded };
}

const isObserved = (item: EvidenceIndexItem | undefined) =>
	item?.basis === "observed";
/** A reproduction only supports a cause when it actually reproduced the reported behavior. */
const isObservedSupport = (item: EvidenceIndexItem | undefined) =>
	isObserved(item) &&
	(item?.kind !== "reproduction" || item.locator.status === "reproduced");

/** Rule-driven claim state; `confirmed` and `rejected` are set after verification. */
export function hypothesisState(
	hypothesis: Pick<
		ValidatedHypothesis,
		"locations" | "supporting" | "contradicting"
	>,
	index: EvidenceIndex,
): Extract<HypothesisState, "proposed" | "supported" | "contradicted"> {
	if (hypothesis.contradicting.some((c) => isObserved(index.get(c.handle))))
		return "contradicted";
	if (
		hypothesis.locations.length > 0 &&
		hypothesis.supporting.some((c) => isObservedSupport(index.get(c.handle)))
	)
		return "supported";
	return "proposed";
}

const CONFIDENCE_POINTS = { high: 2, medium: 1, low: 0 } as const;

/**
 * Documented ranking heuristic: 3 per reproduced-run citation, 2 per location in
 * a file changed by a collected commit, 1 per other valid support, −4 per observed contradiction, plus
 * the model's confidence. Ties keep the model's order. Shown as a score, never as a probability.
 */
export function rankHypotheses<
	T extends Pick<
		ValidatedHypothesis,
		"locations" | "supporting" | "contradicting" | "confidence"
	>,
>(
	hypotheses: readonly T[],
	index: EvidenceIndex,
): Array<T & { score: number; rank: number }> {
	const changedFiles = new Set<string>();
	for (const item of index.values())
		if (item.kind === "commit" && Array.isArray(item.locator.files))
			for (const file of item.locator.files)
				if (typeof file === "string") changedFiles.add(file);
	const scored = hypotheses.map((hypothesis, order) => {
		let score = CONFIDENCE_POINTS[hypothesis.confidence];
		for (const citation of hypothesis.supporting) {
			const item = index.get(citation.handle);
			score +=
				item?.kind === "reproduction" && item.locator.status === "reproduced"
					? 3
					: 1;
		}
		for (const location of hypothesis.locations) {
			const file = index.get(location.handle)?.locator.path;
			if (typeof file === "string" && changedFiles.has(file)) score += 2;
		}
		for (const citation of hypothesis.contradicting)
			if (isObserved(index.get(citation.handle))) score -= 4;
		return { hypothesis, score, order };
	});
	scored.sort((a, b) => b.score - a.score || a.order - b.order);
	return scored.map(({ hypothesis, score }, position) => ({
		...hypothesis,
		score,
		rank: position + 1,
	}));
}

/** Patches target the best evidence-supported hypothesis; `proposed` ones only in analysis-only mode. */
export function selectPatchTarget<
	T extends { rank: number; state: HypothesisState },
>(hypotheses: readonly T[], mode: "full" | "analysis_only"): T | null {
	const byRank = [...hypotheses].sort((a, b) => a.rank - b.rank);
	return (
		byRank.find(
			(hypothesis) =>
				hypothesis.state === "supported" || hypothesis.state === "confirmed",
		) ??
		(mode === "analysis_only"
			? (byRank.find((hypothesis) => hypothesis.state === "proposed") ?? null)
			: null)
	);
}

// ---- Prompt-injection signal ------------------------------------------------------------------

const INJECTION_PATTERNS = [
	/ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?)/i,
	/disregard\s+(the\s+|all\s+)?(system|previous|prior)\s+(prompt|instructions)/i,
	/\byou are now\b/i,
	/\bsystem prompt\b/i,
	/\b(mark|report|set)\s+(this|the|it)\s+(bug\s+|issue\s+|patch\s+|fix\s+)?(as\s+)?(verified|fixed|resolved|confirmed)\b/i,
	/<\/?(tool_call|function_call|system)>/i,
];

/**
 * Flags untrusted text that tries to instruct the models (adds `injection_suspected` for reviewers).
 * Advisory only: statuses come from rules and sandbox facts, so this never changes an outcome.
 */
export function detectInjection(texts: readonly string[]): boolean {
	return texts.some((text) =>
		INJECTION_PATTERNS.some((pattern) => pattern.test(text)),
	);
}

// ---- Patch policy -----------------------------------------------------------------------------

const FORBIDDEN_PATHS: Array<[RegExp, string]> = [
	[/(^|\/)\.git(\/|$)/, "Git metadata"],
	[/^\.tracera(\/|$)/, "Tracera's own files"],
	[/(^|\/)node_modules(\/|$)/, "installed dependencies"],
	[/(^|\/)\.env($|\.)/, "environment files"],
	[/(^|\/)package\.json$/, "package manifests"],
	[
		/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
		"lockfiles",
	],
	[
		/^\.github\/|^\.circleci\/|^\.buildkite\/|(^|\/)\.gitlab-ci\.yml$|(^|\/)azure-pipelines\.yml$/,
		"CI configuration",
	],
	[/(^|\/)\.(npmrc|netrc)$|\.(pem|key|p12|pfx)$/, "credential files"],
];
const SAFE_PATH = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(\/[A-Za-z0-9._@+-]+)*$/;
const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

export type PatchRisk = { code: string; message: string };

/**
 * Static patch policy, checked before anything is written: repository-relative paths only, no
 * forbidden areas, no symlinks or submodules, new files only for tests, at most 5 files and 10 edits.
 * Exact-once matching, containment (lstat/realpath), and line limits are enforced at application.
 */
export function validatePatchEdits(
	edits: ReadonlyArray<{ path: string; search: string; replace: string }>,
	tree: ReadonlyMap<string, string>,
): { ok: boolean; errors: string[]; risks: PatchRisk[] } {
	const errors: string[] = [];
	const risks = new Map<string, PatchRisk>();
	if (edits.length === 0 || edits.length > 10)
		errors.push("A patch needs between 1 and 10 edits");
	if (new Set(edits.map((edit) => edit.path)).size > 5)
		errors.push("A patch may change at most 5 files");
	for (const edit of edits) {
		const name = JSON.stringify(edit.path);
		if (
			!SAFE_PATH.test(edit.path) ||
			edit.path.split("/").some((part) => part === "." || part === "..")
		) {
			errors.push(
				`${name}: paths must be repository-relative with / separators`,
			);
			continue;
		}
		const forbidden = FORBIDDEN_PATHS.find(([pattern]) =>
			pattern.test(edit.path),
		);
		if (forbidden) {
			errors.push(`${name}: changes to ${forbidden[1]} are not allowed`);
			continue;
		}
		if (edit.search === edit.replace)
			errors.push(`${name}: the edit changes nothing`);
		const mode = tree.get(edit.path);
		if (mode === undefined) {
			if (!TEST_PATH.test(edit.path))
				errors.push(`${name}: new files are allowed only for tests`);
			else if (edit.search !== "")
				errors.push(`${name}: a new file needs an empty search text`);
			else
				risks.set("adds_test", {
					code: "adds_test",
					message: "The patch adds a test file",
				});
			continue;
		}
		if (!REGULAR_FILE_MODES.has(mode)) {
			errors.push(`${name}: symlinks and submodules cannot be edited`);
			continue;
		}
		if (edit.search === "")
			errors.push(`${name}: search must quote existing text exactly`);
		if (TEST_PATH.test(edit.path))
			risks.set("modifies_existing_test", {
				code: "modifies_existing_test",
				message: "The patch changes an existing test",
			});
	}
	return { ok: errors.length === 0, errors, risks: [...risks.values()] };
}
