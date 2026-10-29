import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { EvidenceBasis } from "@tracera/contracts";
import type { Config } from "../config.ts";
import type { EvidenceItemKind, FieldProvenance } from "../db/schema.ts";
import { isPathInside } from "../lib/fs.ts";
import { git } from "../lib/git.ts";
import { TEST_FILE } from "./graph-extract.ts";
import { listTree, readBlob, type TreeEntry } from "./workspace.ts";

export { TEST_FILE };

// collect_context: deterministic, bounded evidence gathered with git plumbing
// on Tracera's clone. Repository content is untrusted data; it is quoted, never interpreted.

export class ContextError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(code: string, message: string, retryable = false) {
		super(message);
		this.code = code;
		this.retryable = retryable;
	}
}

export type PackItem = {
	handle: string;
	kind: EvidenceItemKind;
	basis: EvidenceBasis;
	label: string;
	content: string;
	locator: Record<string, unknown>;
	provenance: Record<string, unknown>;
};

/**
 * The registration may be stale: the path must still be a plain directory (not replaced by a link),
 * resolve to the registered location, sit inside an allowed root, and own a real `.git` directory
 * (a `.git` file can redirect git to any directory on the machine).
 */
export async function verifySourcePath(
	config: Pick<Config, "dataDir" | "repoRoots" | "sourceRoot">,
	repo: { sourceType: string; sourceRef: string },
): Promise<string> {
	const stat = await lstat(repo.sourceRef).catch(() => null);
	if (!stat)
		throw new ContextError(
			"repository_unavailable",
			"The registered repository path no longer exists",
		);
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new ContextError(
			"repository_path_not_allowed",
			"The registered repository path is no longer a plain directory",
		);
	const real = await realpath(repo.sourceRef);
	if (
		!(isPathInside(real, repo.sourceRef) && isPathInside(repo.sourceRef, real))
	)
		throw new ContextError(
			"repository_path_not_allowed",
			"The registered path now resolves somewhere else (a parent directory was replaced by a link)",
		);
	const roots =
		repo.sourceType === "fixture"
			? [path.join(config.dataDir, "fixtures")]
			: config.repoRoots;
	const realRoots = (
		await Promise.all(roots.map((root) => realpath(root).catch(() => null)))
	).filter((root): root is string => root !== null);
	const forbidden =
		isPathInside(config.sourceRoot, real) ||
		(repo.sourceType !== "fixture" && isPathInside(config.dataDir, real));
	if (forbidden || !realRoots.some((root) => isPathInside(root, real)))
		throw new ContextError(
			"repository_path_not_allowed",
			"The registered repository is outside the allowed roots",
		);
	const dotGit = await lstat(path.join(real, ".git")).catch(() => null);
	if (!dotGit)
		throw new ContextError(
			"not_a_git_repository",
			"The registered path is no longer a git repository",
		);
	if (!dotGit.isDirectory() || dotGit.isSymbolicLink())
		throw new ContextError(
			"repository_path_not_allowed",
			"The repository's .git must be a directory (gitdir redirects are not allowed)",
		);
	return real;
}

// ---- Search terms -----------------------------------------------------------------------------

export type SearchTerm = {
	term: string;
	weight: number;
	source:
		| "normalization"
		| "ui_phrase"
		| "quoted"
		| "identifier"
		| "phrase"
		| "keyword";
};

const MAX_TERMS = 20;
const STOPWORDS = new Set(
	"about after again all also and another any are because been before being but can cannot could did does doing done each even ever every for from get gets got had has have having here how into its just like many may more most much not now off once only other our out over please same see seems should show shows shown showing some still such than that the their them then there these they this those though through too under until very was were what when where which while who why will with would yes yet you your expected actual behavior behaviour step steps bug issue problem error wrong page site screen user users customer customers today yesterday update updated started happen happens happened instead correct incorrect displayed display look looks looked open opened click clicked read twice".split(
		" ",
	),
);
/** Prefix stems keep fixed-string search useful: "removing" → "remov" matches removeItem. */
const stem = (word: string) =>
	word.length >= 7 && word.endsWith("ing")
		? word.slice(0, -3)
		: word.length >= 6 && word.endsWith("ed")
			? word.slice(0, -2)
			: word.length >= 5 && word.endsWith("s") && !word.endsWith("ss")
				? word.slice(0, -1)
				: word;
const strings = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
const keywordsOf = (text: string) =>
	(text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter(
		(word) => !STOPWORDS.has(word),
	);

/** Literal search terms from the report (and normalization, when it ran). All of it is user text. */
export function extractSearchTerms(
	report: {
		title: string;
		description: string;
		expectedBehavior: string | null;
		actualBehavior: string | null;
		steps: string[];
	},
	normalized: { search_terms?: unknown; ui_element_phrases?: unknown } | null,
): SearchTerm[] {
	const terms = new Map<string, SearchTerm>();
	const add = (raw: string, weight: number, source: SearchTerm["source"]) => {
		const term = raw.trim();
		if (term.length < 3 || term.length > 60 || /[\r\n\0]/.test(term)) return;
		const key = term.toLowerCase();
		if ((terms.get(key)?.weight ?? -1) < weight)
			terms.set(key, { term, weight, source });
	};
	for (const term of strings(normalized?.search_terms))
		add(term, 3, "normalization");
	for (const phrase of strings(normalized?.ui_element_phrases))
		add(phrase, 2, "ui_phrase");
	const text = [
		report.title,
		report.description,
		report.expectedBehavior ?? "",
		report.actualBehavior ?? "",
		...report.steps,
	].join("\n");
	for (const match of text.matchAll(/["`]([^"`\n]{3,60})["`]/g))
		add(match[1] ?? "", 3, "quoted");
	for (const token of text.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? [])
		if (/[a-z][A-Z]/.test(token) || token.includes("_"))
			add(token, 3, "identifier");
	const title = keywordsOf(report.title);
	for (let i = 0; i + 1 < title.length; i++)
		add(`${title[i]}${title[i + 1]}`, 2, "phrase");
	for (const word of keywordsOf(`${report.title}\n${report.description}`))
		add(stem(word), 1, "keyword");
	return [...terms.values()]
		.sort((a, b) => b.weight - a.weight)
		.slice(0, MAX_TERMS);
}

// ---- Context pack -----------------------------------------------------------------------------

const MAX_HITS_PER_TERM = 50;
const MAX_TOTAL_HITS = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_EXCERPT_LINES = 160;
const CONTEXT_LINES = 15;
const MAX_EXCERPT_CHARS = 45_000;
const MAX_SOURCE_FILES = 6;
const MAX_TEST_FILES = 2;
const MAX_COMMITS = 5;
const MAX_LISTED_PATHS = 2000;
const IGNORED_DIR =
	/(^|\/)(node_modules|dist|build|out|coverage|vendor|target|\.next|\.nuxt|\.cache|\.turbo|\.git)(\/|$)/;
const SENSITIVE =
	/(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx)|id_rsa[^/]*|id_ed25519[^/]*|\.npmrc|\.netrc|[^/]*(secret|credential)[^/]*)$/i;
const CONFIG_FILE =
	/(^|\/)(tsconfig[^/]*\.json|(vitest|jest|vite|babel|eslint|rollup|webpack)\.config\.[cm]?[jt]s|\.eslintrc[^/]*|biome\.json|\.babelrc)$/;
const SOURCE_FILE = /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/;

export type SkipReason =
	| "ignored"
	| "sensitive"
	| "symlinks"
	| "submodules"
	| "large"
	| "binary";

/** Why a tracked entry is never read (null = readable). Shared by collect_context and graph indexing. */
export function skipReason(entry: TreeEntry): SkipReason | null {
	if (entry.type === "commit") return "submodules";
	if (entry.mode === "120000") return "symlinks";
	if (IGNORED_DIR.test(entry.path)) return "ignored";
	if (SENSITIVE.test(entry.path)) return "sensitive";
	if ((entry.size ?? 0) > MAX_FILE_BYTES) return "large";
	return null;
}

export type ContextPack = {
	version: 1;
	commit: {
		sha: string;
		date: string | null;
		subject: string | null;
		history_length: number;
	};
	snapshot_policy: string;
	tree: {
		files: number;
		listing: string[];
		listing_truncated: boolean;
		skipped: Record<SkipReason, { count: number; examples: string[] }>;
	};
	package_json: {
		name: string | null;
		type: string | null;
		scripts: Record<string, string>;
		dependencies: number;
		dev_dependencies: number;
	} | null;
	config_files: string[];
	search: {
		methods: string[];
		terms: Array<
			SearchTerm & { hits: number; files: string[]; timed_out: boolean }
		>;
		total_hits: number;
		truncated: boolean;
	};
	history: {
		commits: Array<{
			sha: string;
			date: string;
			subject: string;
			files: string[];
		}>;
		note: string | null;
	};
	selected: Array<{ path: string; reason: string; terms: string[] }>;
	items: PackItem[];
	/** Tracked file modes at the commit (repro-test import checks and the patch policy use them). */
	tracked_modes: Record<string, string>;
	limitations: string[];
	complete: boolean;
	/** Static-graph links for the selected source files; absent when the graph could not be built. */
	graph?: {
		extractor_version: string;
		coverage_complete: boolean;
		/** Per selected source file, the tests linked to it (names as the test runner reports them). */
		files: Array<{
			path: string;
			tests: Array<{ name: string; file: string }>;
		}>;
	};
};

const clip = (text: string, max: number) =>
	text.length > max
		? `${text.slice(0, max)}\n[truncated ${text.length - max} characters]`
		: text;
const oneLine = (text: string, max = 120) =>
	clip(text.replace(/\s+/g, " ").trim(), max);

export function parseGrep(output: string, commitSha: string) {
	const hits: Array<{ path: string; line: number }> = [];
	for (const record of output.split("\n")) {
		const [location, line] = record.split("\0");
		if (!location || !line || !location.startsWith(`${commitSha}:`)) continue;
		hits.push({
			path: location.slice(commitSha.length + 1),
			line: Number(line),
		});
	}
	return hits;
}

export function parseLog(output: string) {
	return output
		.split("\x1e")
		.filter((record) => record.trim())
		.map((record) => {
			const [header = "", ...rest] = record.split("\n");
			const [sha = "", date = "", subject = ""] = header.split("\x1f");
			return { sha, date, subject, files: rest.filter(Boolean) };
		})
		.filter((commit) => /^[0-9a-f]{40}$/.test(commit.sha));
}

function windows(lines: number[], lineCount: number): Array<[number, number]> {
	const merged: Array<[number, number]> = [];
	let total = 0;
	for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
		const start = Math.max(1, line - CONTEXT_LINES);
		const end = Math.min(lineCount, line + CONTEXT_LINES);
		const last = merged.at(-1);
		if (last && start <= last[1] + 1) {
			total += Math.max(0, end - last[1]);
			last[1] = Math.max(last[1], end);
		} else {
			if (total + (end - start + 1) > MAX_EXCERPT_LINES) break;
			merged.push([start, end]);
			total += end - start + 1;
		}
	}
	return merged;
}

/**
 * Builds the bounded context pack for one commit of Tracera's clone. Metadata and the tree are
 * required (failure → typed ContextError); search, history, and excerpts degrade to recorded
 * limitations when the time budget runs out, and the pack says it is incomplete.
 */
export async function buildContextPack(input: {
	dir: string;
	commitSha: string;
	terms: SearchTerm[];
	testCommand: string;
	deadline: number;
	signal?: AbortSignal;
}): Promise<ContextPack> {
	const { dir, commitSha } = input;
	const limitations: string[] = [];
	const remaining = () => input.deadline - Date.now();
	const stepTimeout = (cap: number) => Math.max(1, Math.min(cap, remaining()));
	const checkCancelled = () => {
		if (input.signal?.aborted)
			throw new ContextError("cancelled", "The investigation was cancelled");
	};
	const timeout = () =>
		new ContextError(
			"context_timeout",
			"Context collection exceeded its time budget",
			true,
		);
	if (remaining() <= 0) throw timeout();
	checkCancelled();

	const [meta, count] = await Promise.all([
		git(dir, ["log", "-1", "--format=%H%x1f%aI%x1f%s", commitSha], {
			timeoutMs: stepTimeout(10_000),
		}),
		git(dir, ["rev-list", "--count", commitSha], {
			timeoutMs: stepTimeout(10_000),
		}),
	]);
	if (meta.timedOut || count.timedOut) throw timeout();
	if (!meta.ok)
		throw new ContextError(
			"repository_unreadable",
			"git could not read the investigation commit",
		);
	const [, date = null, subject = null] = meta.stdout.trim().split("\x1f");
	const historyLength = Number(count.stdout.trim()) || 1;

	const tree = await listTree(dir, commitSha, stepTimeout(20_000));
	if (!tree)
		throw new ContextError(
			"repository_unreadable",
			"git could not list the repository tree",
		);
	if (tree.timedOut) throw timeout();
	const skipped: Record<SkipReason, string[]> = {
		ignored: [],
		sensitive: [],
		symlinks: [],
		submodules: [],
		large: [],
		binary: [],
	};
	const readable = new Map<string, TreeEntry>();
	const trackedModes: Record<string, string> = {};
	for (const entry of tree.entries) {
		trackedModes[entry.path] = entry.mode;
		const reason = skipReason(entry);
		if (reason) skipped[reason].push(entry.path);
		else readable.set(entry.path, entry);
	}

	let packageJson: ContextPack["package_json"] = null;
	if (readable.has("package.json")) {
		const text = await readBlob(
			dir,
			commitSha,
			"package.json",
			stepTimeout(5000),
		);
		try {
			const parsed = JSON.parse(text ?? "") as Record<string, unknown>;
			const scripts = Object.fromEntries(
				Object.entries((parsed.scripts as Record<string, unknown>) ?? {})
					.filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					)
					.slice(0, 30)
					.map(([name, command]) => [name, oneLine(command, 200)]),
			);
			const size = (value: unknown) =>
				value && typeof value === "object" ? Object.keys(value).length : 0;
			packageJson = {
				name:
					typeof parsed.name === "string" ? oneLine(parsed.name, 100) : null,
				type: typeof parsed.type === "string" ? oneLine(parsed.type, 20) : null,
				scripts,
				dependencies: size(parsed.dependencies),
				dev_dependencies: size(parsed.devDependencies),
			};
		} catch {
			limitations.push("package.json could not be parsed");
		}
	}

	// Search: fixed-string, case-insensitive git grep at the commit (no worktree reads).
	const termResults: ContextPack["search"]["terms"] = [];
	const hitsByFile = new Map<
		string,
		{ lines: Set<number>; terms: Set<string>; score: number }
	>();
	let totalHits = 0;
	let searchTruncated = false;
	for (const term of input.terms) {
		checkCancelled();
		if (remaining() <= 0) {
			limitations.push(
				`Search stopped before "${oneLine(term.term, 60)}": time budget exhausted`,
			);
			searchTruncated = true;
			break;
		}
		const result = await git(
			dir,
			[
				"grep",
				"-n",
				"-I",
				"-F",
				"-i",
				"-z",
				"--full-name",
				"-e",
				term.term,
				commitSha,
			],
			{ timeoutMs: stepTimeout(10_000), maxBytes: 4 * 1024 * 1024 },
		);
		if (result.timedOut) {
			limitations.push(`Search for "${oneLine(term.term, 60)}" timed out`);
			termResults.push({ ...term, hits: 0, files: [], timed_out: true });
			searchTruncated = true;
			continue;
		}
		const matches = parseGrep(result.stdout, commitSha).filter((hit) =>
			readable.has(hit.path),
		);
		const kept = matches.slice(
			0,
			Math.min(MAX_HITS_PER_TERM, MAX_TOTAL_HITS - totalHits),
		);
		if (kept.length < matches.length) searchTruncated = true;
		totalHits += kept.length;
		for (const hit of kept) {
			const file = hitsByFile.get(hit.path) ?? {
				lines: new Set<number>(),
				terms: new Set<string>(),
				score: 0,
			};
			file.lines.add(hit.line);
			if (!file.terms.has(term.term)) {
				file.terms.add(term.term);
				file.score += term.weight;
			}
			hitsByFile.set(hit.path, file);
		}
		termResults.push({
			...term,
			hits: kept.length,
			files: [...new Set(kept.map((hit) => hit.path))].slice(0, 10),
			timed_out: false,
		});
		if (totalHits >= MAX_TOTAL_HITS) {
			limitations.push(
				`Search stopped at the ${MAX_TOTAL_HITS}-line hit limit`,
			);
			searchTruncated = true;
			break;
		}
	}

	// History: recent commits at the commit, with the files they touched.
	let commits: ContextPack["history"]["commits"] = [];
	if (remaining() > 0) {
		const log = await git(
			dir,
			[
				"log",
				"--max-count=15",
				"--format=%x1e%H%x1f%aI%x1f%s",
				"--name-only",
				"--no-renames",
				commitSha,
			],
			{ timeoutMs: stepTimeout(10_000) },
		);
		if (log.timedOut) limitations.push("Reading git history timed out");
		else if (log.ok) commits = parseLog(log.stdout);
	} else limitations.push("Git history was not read: time budget exhausted");
	const nonRoot =
		historyLength > commits.length ? commits : commits.slice(0, -1);
	const recentFiles = new Set(nonRoot.slice(0, 5).flatMap((c) => c.files));

	// Choose files: search hits first, then recent changes, then a plain listing.
	const candidates = [...hitsByFile.entries()]
		.filter(([file]) => file !== "package.json")
		.map(([file, hit]) => ({
			path: file,
			reason: "git_grep",
			terms: [...hit.terms],
			lines: [...hit.lines],
			score:
				hit.score +
				Math.min(hit.lines.size, 5) * 0.2 +
				(recentFiles.has(file) ? 1 : 0),
		}))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	const selected: Array<{
		path: string;
		reason: string;
		terms: string[];
		lines: number[];
	}> = [];
	const room = (isTest: boolean) =>
		selected.filter((file) => TEST_FILE.test(file.path) === isTest).length <
		(isTest ? MAX_TEST_FILES : MAX_SOURCE_FILES);
	for (const candidate of candidates)
		if (room(TEST_FILE.test(candidate.path))) selected.push(candidate);
	let fallback: string | null = null;
	if (selected.length === 0) {
		const recent = [...recentFiles].filter(
			(file) =>
				readable.has(file) && SOURCE_FILE.test(file) && !TEST_FILE.test(file),
		);
		const listed = [...readable.keys()].filter(
			(file) => SOURCE_FILE.test(file) && !TEST_FILE.test(file),
		);
		const picks = recent.length > 0 ? recent : listed;
		fallback = recent.length > 0 ? "recent_change" : "listing_fallback";
		for (const file of picks.slice(0, 3))
			selected.push({ path: file, reason: fallback, terms: [], lines: [] });
	}
	// Related tests: test files that mention a selected module by name.
	const testFiles = [...readable.keys()].filter((file) => TEST_FILE.test(file));
	for (const source of selected.filter((file) => !TEST_FILE.test(file.path))) {
		if (!room(true) || remaining() <= 0) break;
		const base = path.posix.basename(source.path).replace(/\.[^.]+$/, "");
		for (const testFile of testFiles.slice(0, 30)) {
			if (!room(true)) break;
			if (selected.some((file) => file.path === testFile)) continue;
			const text = await readBlob(dir, commitSha, testFile, stepTimeout(5000));
			if (text?.includes(base))
				selected.push({
					path: testFile,
					reason: "related_test",
					terms: [],
					lines: [],
				});
		}
	}

	const items: PackItem[] = [];
	let code = 0;
	let chars = 0;
	const excerptSources = [
		...selected,
		...(readable.has("package.json")
			? [
					{
						path: "package.json",
						reason: "configuration",
						terms: [],
						lines: [],
					},
				]
			: []),
	];
	for (const file of excerptSources) {
		checkCancelled();
		if (remaining() <= 0) {
			limitations.push(
				`Excerpts stopped before ${file.path}: time budget exhausted`,
			);
			break;
		}
		const text = await readBlob(dir, commitSha, file.path, stepTimeout(5000));
		if (text === null) {
			limitations.push(`Could not read ${file.path}`);
			continue;
		}
		if (text.includes("\0")) {
			skipped.binary.push(file.path);
			continue;
		}
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (lines.length === 0) continue;
		const ranges: Array<[number, number]> =
			lines.length <= MAX_EXCERPT_LINES || file.lines.length === 0
				? [[1, Math.min(lines.length, MAX_EXCERPT_LINES)]]
				: windows(file.lines, lines.length);
		for (const [start, end] of ranges) {
			const body = lines
				.slice(start - 1, end)
				.map(
					(line, i) =>
						`${String(start + i).padStart(4)}| ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`,
				)
				.join("\n");
			if (chars + body.length > MAX_EXCERPT_CHARS) {
				limitations.push(
					`Excerpt budget reached; ${file.path} lines ${start}-${end} omitted`,
				);
				continue;
			}
			chars += body.length;
			code += 1;
			items.push({
				handle: `CODE-${code}`,
				kind: "code_excerpt",
				basis: "observed",
				label: `${file.path} lines ${start}-${end}`,
				content: body,
				locator: {
					path: file.path,
					start_line: start,
					end_line: end,
					line_count: lines.length,
				},
				provenance: { method: file.reason, terms: file.terms },
			});
		}
	}

	// Commits that touched the selected files (the root import is not a "change").
	const selectedPaths = new Set(selected.map((file) => file.path));
	let relevant = nonRoot
		.filter((commit) => commit.files.some((file) => selectedPaths.has(file)))
		.slice(0, MAX_COMMITS);
	if (relevant.length === 0) relevant = nonRoot.slice(0, 2);
	let commitNumber = 0;
	for (const commit of relevant) {
		if (remaining() <= 0) {
			limitations.push("Commit diffs stopped: time budget exhausted");
			break;
		}
		const touched = commit.files.filter(
			(file) => selectedPaths.has(file) && readable.has(file),
		);
		const show = await git(
			dir,
			[
				"show",
				"--format=",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--no-renames",
				"--unified=3",
				commit.sha,
				"--",
				...(touched.length > 0
					? touched
					: commit.files.filter((file) => readable.has(file)).slice(0, 5)),
			],
			{ timeoutMs: stepTimeout(10_000) },
		);
		commitNumber += 1;
		items.push({
			handle: `COMMIT-${commitNumber}`,
			kind: "commit",
			basis: "observed",
			label: `${commit.sha.slice(0, 10)} ${oneLine(commit.subject, 100)}`,
			content: [
				`Commit: ${commit.sha}`,
				`Date: ${commit.date}`,
				`Message: ${oneLine(commit.subject, 200)}`,
				`Files: ${commit.files.slice(0, 20).join(", ")}`,
				"",
				show.ok ? clip(show.stdout, 2500) : "(diff unavailable)",
			].join("\n"),
			locator: { sha: commit.sha, files: commit.files },
			provenance: { method: "git_log", touched_selected_files: touched },
		});
	}

	// Observed facts recorded by tools (FIND-n).
	const facts: Array<[string, string]> = [
		[
			"Snapshot policy",
			`The investigation analyzes the committed snapshot at ${commitSha.slice(0, 12)}. Uncommitted changes in the registered working tree are not inspected.`,
		],
	];
	if (totalHits === 0)
		facts.push([
			"No search matches",
			`No tracked file matched any search term (${input.terms.map((t) => JSON.stringify(t.term)).join(", ") || "none"}).${fallback ? ` Excerpts were chosen by ${fallback === "recent_change" ? "recent changes" : "file listing"} instead.` : ""}`,
		]);
	for (const file of selected
		.filter((f) => f.reason === "git_grep")
		.slice(0, 5))
		facts.push([
			`Search matches in ${file.path}`,
			`git grep (fixed string, case-insensitive) matched ${file.terms.map((t) => JSON.stringify(t)).join(", ")} in ${file.path} at line(s) ${[
				...file.lines,
			]
				.sort((a, b) => a - b)
				.slice(0, 10)
				.join(", ")}.`,
		]);
	facts.push([
		"Test command",
		`The registered test command is "${oneLine(input.testCommand, 100)}"${packageJson?.scripts.test ? `; package.json defines "test": "${packageJson.scripts.test}"` : ""}.`,
	]);
	facts.push([
		"Dependencies",
		packageJson
			? packageJson.dependencies + packageJson.dev_dependencies === 0
				? "package.json declares no dependencies."
				: `package.json declares ${packageJson.dependencies} dependencies and ${packageJson.dev_dependencies} dev dependencies; they are not installed in the sandbox.`
			: "There is no package.json at the repository root.",
	]);
	facts.push([
		"History",
		historyLength <= 1
			? "Only one commit is available, so there is no change history to compare against."
			: `${historyLength} commits of history; ${relevant.length} recent commit(s) were collected as evidence.`,
	]);
	const skippedCounts = Object.entries(skipped).filter(
		([, list]) => list.length > 0,
	);
	if (skippedCounts.length > 0)
		facts.push([
			"Skipped files",
			`Not read: ${skippedCounts.map(([reason, list]) => `${list.length} ${reason}`).join(", ")}.`,
		]);
	if (limitations.length > 0)
		facts.push([
			"Incomplete collection",
			`Context collection was incomplete: ${limitations.join("; ")}.`,
		]);
	facts.forEach(([label, content], i) => {
		items.push({
			handle: `FIND-${i + 1}`,
			kind: "repository_fact",
			basis: "observed",
			label,
			content,
			locator: {},
			provenance: { method: "collect_context" },
		});
	});

	const listing = [...readable.keys()];
	return {
		version: 1,
		commit: {
			sha: commitSha,
			date,
			subject: subject ? oneLine(subject, 200) : null,
			history_length: historyLength,
		},
		snapshot_policy: "committed_snapshot_only",
		tree: {
			files: tree.entries.length,
			listing: listing.slice(0, MAX_LISTED_PATHS),
			listing_truncated: listing.length > MAX_LISTED_PATHS,
			skipped: Object.fromEntries(
				Object.entries(skipped).map(([reason, list]) => [
					reason,
					{ count: list.length, examples: list.slice(0, 20) },
				]),
			) as ContextPack["tree"]["skipped"],
		},
		package_json: packageJson,
		config_files: listing.filter((file) => CONFIG_FILE.test(file)).slice(0, 20),
		search: {
			methods: [
				"git ls-tree",
				"git grep --fixed-strings --ignore-case",
				"git log --name-only",
				"git show",
			],
			terms: termResults,
			total_hits: totalHits,
			truncated: searchTruncated,
		},
		history: {
			commits: commits.map((commit) => ({
				...commit,
				subject: oneLine(commit.subject, 200),
			})),
			note: historyLength <= 1 ? "single_commit" : null,
		},
		selected: selected.map(({ path: file, reason, terms }) => ({
			path: file,
			reason,
			terms,
		})),
		items,
		tracked_modes: trackedModes,
		limitations,
		complete: limitations.length === 0,
	};
}

/** EV-n items: what the user reported (basis `reported`), never treated as observed fact. */
export function reportEvidenceItems(
	report: {
		title: string;
		description: string;
		expectedBehavior: string | null;
		actualBehavior: string | null;
		steps: string[];
		environment: Record<string, unknown>;
		affectedUrl: string | null;
		fieldProvenance: Record<string, FieldProvenance>;
	},
	assets: Array<{ id: string; kind: string; text: string }>,
): PackItem[] {
	const inferred = (field: string) =>
		report.fieldProvenance[field]?.source === "ai_inferred"
			? " (AI-inferred from the report)"
			: "";
	const lines = [
		`Title: ${report.title}`,
		`Description: ${report.description}`,
		report.expectedBehavior
			? `Expected behavior${inferred("expected_behavior")}: ${report.expectedBehavior}`
			: null,
		report.actualBehavior
			? `Actual behavior${inferred("actual_behavior")}: ${report.actualBehavior}`
			: null,
		report.steps.length > 0
			? `Steps${inferred("steps")}:\n${report.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}`
			: null,
		Object.keys(report.environment).length > 0
			? `Environment: ${JSON.stringify(report.environment)}`
			: null,
		report.affectedUrl ? `Affected URL: ${report.affectedUrl}` : null,
	].filter((line): line is string => line !== null);
	return [
		{
			handle: "EV-1",
			kind: "report_claim",
			basis: "reported",
			label: "Bug report as submitted",
			content: clip(lines.join("\n"), 12_000),
			locator: {},
			provenance: { source: "bug_report" },
		},
		...assets.map((asset, i) => ({
			handle: `EV-${i + 2}`,
			kind: "evidence_asset" as const,
			basis: "reported" as const,
			label: `${asset.kind} attached to the report`,
			content: clip(asset.text, 6000),
			locator: { evidence_asset_id: asset.id },
			provenance: { origin: "user_provided" },
		})),
	];
}
