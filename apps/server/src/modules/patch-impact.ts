import path from "node:path";
import type {
	EvidenceConfidence,
	FileCategory,
	FileParseStatus,
	ImpactLink,
	PatchImpactResult,
	ImpactSeverity as Severity,
	SymbolChange,
	TestState,
} from "@tracera/contracts";
import { type GraphEdge, type GraphNode, SYMBOL_KINDS } from "./graph-build.ts";
import {
	CODE_LANGUAGES,
	languageOf,
	PARSED_LANGUAGES,
	TEST_FILE,
} from "./graph-extract.ts";

// Patch impact: what a patch changes and what that change can reach,
// computed from the static graphs of the base and head revisions. Pure: callers supply the graphs,
// the diff, and file texts. Every finding carries the chain of graph edges that supports it, and
// the chain's weakest link sets its certainty; nothing is inferred from names alone except
// explicitly labelled "possible" tests.

export const PATCH_IMPACT_VERSION = "patch-impact.v1";

export type LineRange = { start: number; end: number };
export type DiffSection = {
	base: LineRange[];
	head: LineRange[];
	binary: boolean;
};
export type DiffEntry = {
	status: "added" | "deleted" | "modified" | "renamed" | "copied";
	path: string;
	old_path: string | null;
	additions: number | null;
	deletions: number | null;
};
export type GraphView = {
	nodes: readonly GraphNode[];
	edges: readonly GraphEdge[];
	/** Whether every parseable file of the revision was parsed (graph coverage). */
	complete: boolean;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Changed line ranges of each file section of a unified diff, in diff order, on both sides. A
 * pure insertion between lines n and n + 1 of one side is `{start: n + 1, end: n}` on that side.
 */
export function diffSections(diff: string): DiffSection[] {
	const sections: DiffSection[] = [];
	let current: DiffSection | null = null;
	let inHunk = false;
	let base = 0;
	let head = 0;
	let blockBase: LineRange | null = null;
	let blockHead: LineRange | null = null;
	const flush = () => {
		if (current && blockBase) current.base.push(blockBase);
		if (current && blockHead) current.head.push(blockHead);
		blockBase = null;
		blockHead = null;
	};
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			flush();
			current = { base: [], head: [], binary: false };
			sections.push(current);
			inHunk = false;
			continue;
		}
		if (!current) continue;
		const hunk = HUNK.exec(line);
		if (hunk) {
			flush();
			base = hunk[2] === "0" ? Number(hunk[1]) + 1 : Number(hunk[1]);
			head = hunk[4] === "0" ? Number(hunk[3]) + 1 : Number(hunk[3]);
			inHunk = true;
			continue;
		}
		// Before a section's first hunk come its headers (index, mode, ---, +++); inside a hunk a
		// removed line that starts with "--" is still a removed line.
		if (!inHunk) {
			if (/^Binary files .* differ$/.test(line)) current.binary = true;
			continue;
		}
		const mark = line[0];
		if (mark === "-") {
			blockBase ??= { start: base, end: base - 1 };
			blockBase.end = base;
			blockHead ??= { start: head, end: head - 1 };
			base += 1;
		} else if (mark === "+") {
			blockHead ??= { start: head, end: head - 1 };
			blockHead.end = head;
			blockBase ??= { start: base, end: base - 1 };
			head += 1;
		} else if (mark !== "\\") {
			flush();
			base += 1;
			head += 1;
		}
	}
	flush();
	return sections;
}

/** `git diff --name-status -z` records (with rename detection), in diff order. */
export function parseNameStatus(
	output: string,
): Array<Pick<DiffEntry, "status" | "path" | "old_path">> {
	const fields = output.split("\0");
	const entries: Array<Pick<DiffEntry, "status" | "path" | "old_path">> = [];
	for (let i = 0; i < fields.length; ) {
		const code = fields[i] ?? "";
		if (!code) {
			i += 1;
			continue;
		}
		if (code.startsWith("R") || code.startsWith("C")) {
			entries.push({
				status: code.startsWith("R") ? "renamed" : "copied",
				old_path: fields[i + 1] ?? "",
				path: fields[i + 2] ?? "",
			});
			i += 3;
		} else {
			entries.push({
				status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
				old_path: null,
				path: fields[i + 1] ?? "",
			});
			i += 2;
		}
	}
	return entries;
}

/** `git diff --numstat -z` records: added and deleted line counts (null for binary files), in diff order. */
export function parseNumstat(
	output: string,
): Array<{ additions: number | null; deletions: number | null }> {
	const fields = output.split("\0");
	const counts: Array<{ additions: number | null; deletions: number | null }> =
		[];
	for (let i = 0; i < fields.length; ) {
		const record = fields[i] ?? "";
		if (!record) {
			i += 1;
			continue;
		}
		const [added = "", deleted = "", file = ""] = record.split("\t");
		counts.push({
			additions: added === "-" ? null : Number(added),
			deletions: deleted === "-" ? null : Number(deleted),
		});
		// A rename's two paths follow as separate fields when the path field is empty.
		i += file === "" ? 3 : 1;
	}
	return counts;
}

// ---- Graph indexes ----------------------------------------------------------------------------

type Index = {
	nodes: Map<string, GraphNode>;
	symbols: Map<string, GraphNode[]>;
	incoming: Map<string, GraphEdge[]>;
	outgoing: Map<string, GraphEdge[]>;
	complete: boolean;
};

const SYMBOLS: ReadonlySet<string> = new Set(SYMBOL_KINDS);

function indexGraph(graph: GraphView): Index {
	const nodes = new Map(graph.nodes.map((node) => [node.key, node]));
	const symbols = new Map<string, GraphNode[]>();
	for (const node of graph.nodes)
		if (
			node.path &&
			SYMBOLS.has(node.kind) &&
			node.start_line !== null &&
			node.end_line !== null
		) {
			const list = symbols.get(node.path) ?? [];
			list.push(node);
			symbols.set(node.path, list);
		}
	const incoming = new Map<string, GraphEdge[]>();
	const outgoing = new Map<string, GraphEdge[]>();
	for (const edge of graph.edges) {
		const out = outgoing.get(edge.from) ?? [];
		out.push(edge);
		outgoing.set(edge.from, out);
		if (!edge.to) continue;
		const list = incoming.get(edge.to) ?? [];
		list.push(edge);
		incoming.set(edge.to, list);
	}
	return { nodes, symbols, incoming, outgoing, complete: graph.complete };
}

function parseStatus(index: Index, file: string | null): FileParseStatus {
	if (file === null) return "absent";
	const node = index.nodes.get(`file:${file}`);
	if (!node) return "not_indexed";
	if (node.attributes.parsed === true) return "parsed";
	return PARSED_LANGUAGES.has(languageOf(file))
		? "parse_failed"
		: "unsupported_language";
}

const LOCKFILE =
	/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const GENERATED =
	/(^|\/)(dist|build|out|coverage|\.next|__generated__|generated)\/|\.min\.(js|css)$|\.map$|\.generated\.[a-z]+$/i;
const CONFIG =
	/(^|\/)(\.env\.example|[^/]*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|biome\.json|[^/]*\.ya?ml|Dockerfile[^/]*)$/;

export function categoryOf(file: string): FileCategory {
	if (LOCKFILE.test(file)) return "lockfile";
	if (GENERATED.test(file)) return "generated";
	if (path.posix.basename(file) === "package.json") return "manifest";
	if (TEST_FILE.test(file)) return "test";
	if (/\.sql$/i.test(file)) return "migration";
	if (/\.(md|mdx|txt|rst)$/i.test(file)) return "docs";
	if (CONFIG.test(file)) return "config";
	if (CODE_LANGUAGES.has(languageOf(file))) return "source";
	return "other";
}

const overlaps = (node: GraphNode, range: LineRange) =>
	(node.start_line ?? 0) <= range.end && (node.end_line ?? 0) >= range.start;
const strictlyInside = (inner: GraphNode, outer: GraphNode) =>
	(inner.start_line ?? 0) >= (outer.start_line ?? 0) &&
	(inner.end_line ?? 0) <= (outer.end_line ?? 0) &&
	((inner.start_line ?? 0) > (outer.start_line ?? 0) ||
		(inner.end_line ?? 0) < (outer.end_line ?? 0));
const span = (node: GraphNode | undefined): LineRange | null =>
	node && node.start_line !== null && node.end_line !== null
		? { start: node.start_line, end: node.end_line }
		: null;
const lastSegment = (name: string) => name.split(/[.#]/).pop() ?? name;

const TYPE_KINDS = new Set(["interface", "type_alias", "enum"]);
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A symbol's declaration text up to where its body starts (parameters, return type, `extends`), or
 * the whole declaration for types. Approximate: it reads text, not the AST, and returns null when
 * there is nothing that looks like a declaration header.
 */
export function declarationHeader(
	text: string | undefined,
	node: GraphNode,
): string | null {
	if (text === undefined || node.start_line === null) return null;
	const body = text
		.split("\n")
		.slice(node.start_line - 1, node.end_line ?? node.start_line)
		.join("\n")
		.slice(0, 8000);
	if (TYPE_KINDS.has(node.kind)) return normalize(body).slice(0, 2000);
	let depth = 0;
	let sawParen = false;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === "(") {
			depth += 1;
			sawParen = true;
		} else if (c === ")") depth -= 1;
		else if (
			depth === 0 &&
			(c === "{" || (c === "=" && body[i + 1] === ">")) &&
			(sawParen || node.kind === "class")
		)
			return normalize(body.slice(0, i)).slice(0, 600);
	}
	// Variables that are not functions have no separable signature.
	return node.kind === "variable" ? null : normalize(body.split("\n")[0] ?? "");
}

// ---- Analysis ---------------------------------------------------------------------------------

export type PatchInput = {
	base: GraphView;
	head: GraphView;
	baseRef: { ref: string | null; sha: string };
	headRef: { ref: string | null; sha: string; kind: "commit" | "tree" };
	mergeBase: boolean;
	entries: readonly DiffEntry[];
	sections: readonly DiffSection[];
	/** Text of a changed file at the base or head revision (used for declaration headers). */
	baseText: (file: string) => string | undefined;
	headText: (file: string) => string | undefined;
	options: { depth: number; limit: number };
};

type Side = "base" | "head";
type Origin = {
	key: string;
	name: string;
	change: string;
	side: Side;
	path: string | null;
	/** A file-level origin (its symbols are unknown): findings from it are weaker. */
	fileLevel: boolean;
};
type Reached = {
	key: string;
	depth: number;
	/** The links of the hop that reached this key, in order from `prev` (empty at the origin). */
	links: ImpactLink[];
	prev: string | null;
	certainty: number;
	/** Reached through shared data (a table the origin writes): weaker than a code link. */
	dataBridge: boolean;
	/** For a barrel file reached from a changed symbol: the name it publishes the symbol under. */
	exportedAs: string | null;
};
type Step = {
	next: string;
	links: ImpactLink[];
	dataBridge: boolean;
	exportedAs: string | null;
};

/** Edges whose source depends on their target: walking them backwards finds who a change reaches. */
const DEPENDENT_EDGES = new Set([
	"CALLS",
	"REFERENCES",
	"RENDERS",
	"IMPLEMENTS",
	"EXTENDS",
	"ROUTES_TO",
	"SENDS_REQUEST_TO",
	"HANDLES_EVENT",
	"READS_FROM",
	"WRITES_TO",
	"CONFIGURED_BY",
	"SUBSCRIBES_TO",
	"IMPORTS",
	"RE_EXPORTS",
	"TESTS",
]);
/** Outgoing edges compared between the two revisions of a changed symbol. */
const DEPENDENCY_EDGES = new Set([
	"CALLS",
	"REFERENCES",
	"RENDERS",
	"EXTENDS",
	"IMPLEMENTS",
	"SENDS_REQUEST_TO",
	"HANDLES_EVENT",
	"READS_FROM",
	"WRITES_TO",
	"CONFIGURED_BY",
	"PUBLISHES",
	"SUBSCRIBES_TO",
]);
const CERTAINTY_RANK: Record<string, number> = {
	exact: 3,
	resolved: 2,
	heuristic: 1,
	unresolved: 0,
};
const RANK_CERTAINTY = [
	"unresolved",
	"heuristic",
	"resolved",
	"exact",
] as const;
const CONTRACT_CHANGES = new Set([
	"removed",
	"signature_changed",
	"export_changed",
	"schema_changed",
	"route_removed",
]);
const MAX_EDGE_VISITS = 100_000;
const MAX_REACHED_PER_ORIGIN = 2000;
const MAX_ORIGINS = 200;
const TEST_DEPTH = 3;

const CATEGORY: Record<string, string> = {
	function: "code",
	method: "code",
	class: "code",
	variable: "code",
	interface: "code",
	type_alias: "code",
	enum: "code",
	ui_component: "ui",
	hook: "ui",
	page: "ui",
	route: "api",
	db_table: "data",
	config_key: "configuration",
	event: "messaging",
	queue: "messaging",
	file: "files",
	external_service: "external",
};
const VERB: Record<string, string> = {
	CALLS: "calls",
	REFERENCES: "references",
	RENDERS: "renders",
	IMPLEMENTS: "implements",
	EXTENDS: "extends",
	ROUTES_TO: "routes requests to",
	SENDS_REQUEST_TO: "sends requests to",
	HANDLES_EVENT: "binds as an event handler",
	READS_FROM: "reads",
	WRITES_TO: "writes",
	CONFIGURED_BY: "reads configuration",
	SUBSCRIBES_TO: "subscribes to",
	IMPORTS: "imports",
	RE_EXPORTS: "re-exports",
	TESTS: "tests",
	PUBLISHES: "is published by",
};

const linkOf = (edge: GraphEdge): ImpactLink => ({
	from: edge.from,
	kind: edge.kind as ImpactLink["kind"],
	to: edge.to ?? "",
	certainty: edge.certainty,
	path: typeof edge.provenance.path === "string" ? edge.provenance.path : null,
	line:
		typeof edge.provenance.start_line === "number"
			? edge.provenance.start_line
			: null,
	method:
		typeof edge.provenance.method === "string" ? edge.provenance.method : null,
});

const isTestNode = (node: GraphNode | undefined) =>
	node?.kind === "test_case" || node?.kind === "test_file";
const packageOf = (index: Index, node: GraphNode | undefined) => {
	if (!node) return null;
	if (node.kind === "package") return node.key;
	const file = node.path ? index.nodes.get(`file:${node.path}`) : undefined;
	return typeof file?.attributes.package === "string"
		? file.attributes.package
		: null;
};

/**
 * The name a re-export edge (`x`, `x as y`, or `*`) publishes `name` under, or null when it does not
 * re-export it.
 */
const reexportedAs = (edge: GraphEdge, name: string): string | null => {
	if (edge.kind !== "RE_EXPORTS" || !Array.isArray(edge.provenance.names))
		return null;
	for (const entry of edge.provenance.names) {
		if (entry === "*" || entry === name) return name;
		if (typeof entry === "string" && entry.startsWith(`${name} as `))
			return entry.slice(name.length + 4);
	}
	return null;
};

/**
 * Who depends on `key`, one hop: sources of incoming dependency edges, barrels that re-export the
 * changed symbol, plus the subscribers of a channel the key publishes to and readers of a table it
 * writes (data coupling, weaker).
 */
function dependents(
	index: Index,
	key: string,
	origin: string,
	exportedAs: string | null,
): Step[] {
	const out: Step[] = [];
	const node = index.nodes.get(key);
	// From a changed symbol, a file is reached as a barrel that re-exports it or as module-level code
	// that uses it. Its importers are not followed: code that uses the symbol through a barrel has its
	// own symbol-level edge, and the other importers use other names.
	if (node?.kind === "file" && !origin.startsWith("file:")) {
		if (exportedAs !== null)
			for (const edge of index.incoming.get(key) ?? []) {
				const name = reexportedAs(edge, exportedAs);
				if (name !== null)
					out.push({
						next: edge.from,
						links: [linkOf(edge)],
						dataBridge: false,
						exportedAs: name,
					});
			}
		return out;
	}
	for (const edge of index.incoming.get(key) ?? [])
		if (
			DEPENDENT_EDGES.has(edge.kind) &&
			(edge.certainty === "exact" ||
				edge.certainty === "resolved" ||
				edge.certainty === "heuristic")
		)
			out.push({
				next: edge.from,
				links: [linkOf(edge)],
				dataBridge: false,
				exportedAs: null,
			});
	// Re-exports point at files: a barrel re-exporting the changed symbol passes it on. The chain goes
	// through the file that defines the symbol, so every link is a real edge.
	if (
		key === origin &&
		node?.path &&
		SYMBOLS.has(node.kind) &&
		node.attributes.exported === true &&
		!node.name.includes(".")
	) {
		const file = `file:${node.path}`;
		const defines = (index.incoming.get(key) ?? []).find(
			(edge) => edge.kind === "DEFINES" && edge.from === file,
		);
		if (defines)
			for (const edge of index.incoming.get(file) ?? []) {
				const name = reexportedAs(edge, node.name);
				if (name !== null)
					out.push({
						next: edge.from,
						links: [linkOf(defines), linkOf(edge)],
						dataBridge: false,
						exportedAs: name,
					});
			}
	}
	for (const edge of index.outgoing.get(key) ?? []) {
		if (!edge.to) continue;
		if (edge.kind === "PUBLISHES")
			out.push({
				next: edge.to,
				links: [linkOf(edge)],
				dataBridge: false,
				exportedAs: null,
			});
		else if (
			edge.kind === "WRITES_TO" &&
			edge.provenance.schema_change !== true
		)
			for (const reader of index.incoming.get(edge.to) ?? [])
				if (reader.kind === "READS_FROM" && reader.from !== key)
					out.push({
						next: reader.from,
						links: [linkOf(reader)],
						dataBridge: true,
						exportedAs: null,
					});
	}
	return out;
}

/** Breadth-first from one origin; each reached key keeps its shortest, then strongest, path. */
function walk(
	index: Index,
	origin: string,
	maxDepth: number,
	budget: { visits: number; truncated: boolean },
): Map<string, Reached> {
	const reached = new Map<string, Reached>([
		[
			origin,
			{
				key: origin,
				depth: 0,
				links: [],
				prev: null,
				certainty: 3,
				dataBridge: false,
				exportedAs: null,
			},
		],
	]);
	let frontier = [origin];
	for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const key of frontier) {
			const from = reached.get(key);
			if (!from) continue;
			// Tests end a path: what references a test is not a user of the change.
			if (depth > 1 && isTestNode(index.nodes.get(key))) continue;
			for (const step of dependents(index, key, origin, from.exportedAs)) {
				budget.visits += 1;
				if (budget.visits > MAX_EDGE_VISITS) {
					budget.truncated = true;
					return reached;
				}
				const certainty = Math.min(
					from.certainty,
					...step.links.map((link) => CERTAINTY_RANK[link.certainty] ?? 0),
				);
				const known = reached.get(step.next);
				if (known) {
					// Same depth through a stronger link replaces the weaker path (no cycles: depth only grows).
					if (known.depth === depth && known.certainty < certainty)
						reached.set(step.next, {
							key: step.next,
							depth,
							links: step.links,
							prev: key,
							certainty,
							dataBridge: from.dataBridge || step.dataBridge,
							exportedAs: step.exportedAs ?? known.exportedAs,
						});
					continue;
				}
				if (reached.size >= MAX_REACHED_PER_ORIGIN) {
					budget.truncated = true;
					continue;
				}
				reached.set(step.next, {
					key: step.next,
					depth,
					links: step.links,
					prev: key,
					certainty,
					dataBridge: from.dataBridge || step.dataBridge,
					exportedAs: step.exportedAs,
				});
				next.push(step.next);
			}
		}
		frontier = next;
	}
	return reached;
}

/** The links from the origin to `key`, in order. */
const chainOf = (reached: Map<string, Reached>, key: string): ImpactLink[] => {
	const hops: ImpactLink[][] = [];
	let current = reached.get(key);
	for (
		let guard = 0;
		current && current.links.length > 0 && guard < 20;
		guard++
	) {
		hops.push(current.links);
		current = current.prev ? reached.get(current.prev) : undefined;
	}
	return hops.reverse().flat();
};

type Finding = PatchImpactResult["findings"][number];

/**
 * Severity (how much a finding would matter if real), by documented rules: high for direct users of
 * a contract change (removed code, a changed signature, type, export, route, or table) and for
 * observed broken references; medium for indirect users of a contract change and for users of a
 * changed implementation across a package boundary or on a critical path (routes, pages, data,
 * messaging); low otherwise.
 */
export function severityOf(input: {
	originChange: string;
	depth: number;
	crossesPackage: boolean;
	criticalPath: boolean;
	observed: boolean;
}): Severity {
	if (input.observed) return "high";
	if (CONTRACT_CHANGES.has(input.originChange))
		return input.depth <= 1 ? "high" : "medium";
	if (input.crossesPackage || input.criticalPath) return "medium";
	return "low";
}

/**
 * Confidence (how strong the evidence is), independent of severity: high when every link is exact or
 * resolved and the origin's file was parsed; medium for file-level origins (symbols unknown); low when
 * any link is heuristic or the path goes through shared data.
 */
export function confidenceOf(input: {
	observed: boolean;
	certainty: string;
	fileLevel: boolean;
	dataBridge: boolean;
}): EvidenceConfidence {
	if (input.observed) return "high";
	if (input.certainty === "heuristic" || input.dataBridge) return "low";
	if (input.fileLevel) return "medium";
	return "high";
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const CONFIDENCE_RANK: Record<EvidenceConfidence, number> = {
	high: 3,
	medium: 2,
	low: 1,
};

export function analyzePatch(input: PatchInput): PatchImpactResult {
	const base = indexGraph(input.base);
	const head = indexGraph(input.head);
	const indexOf = (side: Side) => (side === "base" ? base : head);
	const limitations: string[] = [];
	let complete = true;
	if (input.sections.length !== input.entries.length) {
		complete = false;
		limitations.push(
			"The diff's file sections did not line up with git's file list; changed lines are unknown, so whole files were treated as changed.",
		);
	}
	const files: PatchImpactResult["files"] = [];
	const symbols: PatchImpactResult["symbols"] = [];
	const testChanges: PatchImpactResult["test_changes"] = [];
	const dependencyChanges: PatchImpactResult["dependency_changes"] = [];
	const routeChanges: PatchImpactResult["route_changes"] = [];
	const schemaChanges: PatchImpactResult["schema_changes"] = [];
	const manifestChanges: PatchImpactResult["manifest_changes"] = [];
	const origins: Origin[] = [];
	const unknownFiles: Array<{ path: string; reason: string }> = [];

	input.entries.forEach((entry, i) => {
		const basePath =
			entry.status === "added" || entry.status === "copied"
				? null
				: (entry.old_path ?? entry.path);
		const headPath = entry.status === "deleted" ? null : entry.path;
		const section =
			input.sections.length === input.entries.length
				? input.sections[i]
				: undefined;
		const binary =
			entry.additions === null ||
			entry.deletions === null ||
			section?.binary === true;
		const whole = (index: Index, file: string | null): LineRange[] =>
			file === null
				? []
				: [{ start: 1, end: Number.MAX_SAFE_INTEGER }].filter(() =>
						index.nodes.has(`file:${file}`),
					);
		const ranges = {
			base: section?.base ?? whole(base, basePath),
			head: section?.head ?? whole(head, headPath),
		};
		const category = categoryOf(entry.path);
		const parse = {
			base:
				binary && basePath !== null ? "binary" : parseStatus(base, basePath),
			head:
				binary && headPath !== null ? "binary" : parseStatus(head, headPath),
		} satisfies Record<Side, FileParseStatus>;
		const file: PatchImpactResult["files"][number] = {
			path: entry.path,
			old_path: entry.old_path,
			status: entry.status,
			category,
			language: languageOf(entry.path) || null,
			additions: entry.additions,
			deletions: entry.deletions,
			parse,
			changed_lines: ranges,
			unattributed: [],
			import_changes: [],
			notes: [],
		};
		files.push(file);
		if (category === "generated")
			file.notes.push(
				"Generated file: its impact is not traced; review the source it is generated from.",
			);
		if (category === "lockfile")
			file.notes.push(
				"Lockfile: resolved dependency versions changed; the declared ranges are compared in manifest changes.",
			);
		if (binary) file.notes.push("Binary file: its contents are not analysed.");
		const sideParsed = (side: Side) =>
			(side === "base" ? basePath : headPath) === null ||
			parse[side] === "parsed";
		const code =
			!binary &&
			category !== "generated" &&
			CODE_LANGUAGES.has(languageOf(entry.path));
		if (code && (!sideParsed("base") || !sideParsed("head"))) {
			const reason = `${entry.path} could not be analysed at the symbol level (base: ${parse.base}, head: ${parse.head})`;
			file.notes.push(
				`${reason}; impact falls back to who imports the file, and its tests are unknown.`,
			);
			unknownFiles.push({ path: entry.path, reason });
			complete = false;
			const fallback = headPath ?? basePath;
			const side: Side = headPath ? "head" : "base";
			if (fallback && indexOf(side).nodes.has(`file:${fallback}`))
				origins.push({
					key: `file:${fallback}`,
					name: fallback,
					change: entry.status === "deleted" ? "removed" : "modified",
					side,
					path: fallback,
					fileLevel: true,
				});
			return;
		}

		// Symbols on each side, matched by name within the file (a rename keeps its names).
		const baseSyms = basePath ? (base.symbols.get(basePath) ?? []) : [];
		const headSyms = headPath ? (head.symbols.get(headPath) ?? []) : [];
		const baseByName = new Map(baseSyms.map((s) => [s.name, s]));
		const headByName = new Map(headSyms.map((s) => [s.name, s]));
		const removed = baseSyms.filter((s) => !headByName.has(s.name));
		const added = headSyms.filter((s) => !baseByName.has(s.name));
		const candidates = headSyms.filter((s) => {
			const before = baseByName.get(s.name);
			return (
				before !== undefined &&
				(ranges.head.some((r) => overlaps(s, r)) ||
					ranges.base.some((r) => overlaps(before, r)))
			);
		});
		// The innermost changed symbols: a class whose changed lines all fall in changed methods is
		// not itself reported as changed.
		const changedHead = [...candidates, ...added];
		const changedBase = [
			...removed,
			...candidates.flatMap((s) => baseByName.get(s.name) ?? []),
		];
		const kept = candidates.filter((s) => {
			const before = baseByName.get(s.name);
			const innerHead = changedHead.filter(
				(t) => t !== s && strictlyInside(t, s),
			);
			const innerBase = before
				? changedBase.filter((t) => t !== before && strictlyInside(t, before))
				: [];
			if (innerHead.length + innerBase.length === 0) return true;
			const coveredHead = ranges.head
				.filter((r) => overlaps(s, r))
				.every((r) => innerHead.some((t) => overlaps(t, r)));
			const coveredBase = before
				? ranges.base
						.filter((r) => overlaps(before, r))
						.every((r) => innerBase.some((t) => overlaps(t, r)))
				: true;
			return !(coveredHead && coveredBase);
		});
		const record = (
			node: GraphNode,
			change: SymbolChange,
			before: GraphNode | undefined,
			after: GraphNode | undefined,
			signature: { before: string | null; after: string | null } | null,
		) => {
			symbols.push({
				key: (after ?? before ?? node).key,
				base_key: before?.key ?? null,
				head_key: after?.key ?? null,
				name: node.name,
				kind: node.kind,
				path: entry.path,
				change,
				exported: (after ?? before)?.attributes.exported === true,
				lines: { base: span(before), head: span(after) },
				signature,
				dependents: 0,
				tests: "none_identified",
			});
			origins.push({
				key: (after ?? before ?? node).key,
				name: node.name,
				change,
				side: after ? "head" : "base",
				path: entry.path,
				fileLevel: false,
			});
		};
		for (const node of removed) record(node, "removed", node, undefined, null);
		for (const node of added) record(node, "added", undefined, node, null);
		for (const after of kept) {
			const before = baseByName.get(after.name);
			if (!before) continue;
			const was = declarationHeader(
				basePath ? input.baseText(basePath) : undefined,
				before,
			);
			const now = declarationHeader(input.headText(entry.path), after);
			const change: SymbolChange =
				(before.attributes.exported === true) !==
				(after.attributes.exported === true)
					? "export_changed"
					: TYPE_KINDS.has(after.kind) ||
							(was !== null && now !== null && was !== now)
						? "signature_changed"
						: "modified";
			record(
				after,
				change,
				before,
				after,
				change === "modified" ? null : { before: was, after: now },
			);
		}

		// Changed lines of code outside every symbol (module-level code), on each side. Manifests,
		// migrations, and documents have their own comparisons below.
		for (const side of code && category !== "test"
			? (["base", "head"] as const)
			: []) {
			const syms = side === "base" ? baseSyms : headSyms;
			for (const range of ranges[side])
				if (range.end >= range.start && !syms.some((s) => overlaps(s, range)))
					file.unattributed.push({ ...range, side });
		}
		if (file.unattributed.length > 0) {
			const fileKey = `file:${headPath ?? basePath}`;
			const side: Side = headPath ? "head" : "base";
			if (indexOf(side).nodes.has(fileKey))
				origins.push({
					key: fileKey,
					name: headPath ?? basePath ?? entry.path,
					change: "module_code_changed",
					side,
					path: headPath ?? basePath,
					fileLevel: true,
				});
		}

		// Imports and re-exports added or removed by the patch.
		const importSet = (index: Index, file: string | null) =>
			new Set(
				(file ? (index.outgoing.get(`file:${file}`) ?? []) : [])
					.filter((e) => e.kind === "IMPORTS" || e.kind === "RE_EXPORTS")
					.map(
						(e) => `${e.kind}\0${e.to ?? `unresolved:${e.target_text ?? ""}`}`,
					),
			);
		const beforeImports = importSet(base, basePath);
		const afterImports = importSet(head, headPath);
		if (basePath && headPath) {
			for (const item of afterImports)
				if (!beforeImports.has(item)) {
					const [kind = "IMPORTS", target = ""] = item.split("\0");
					file.import_changes.push({
						change: "added",
						kind: kind as "IMPORTS" | "RE_EXPORTS",
						target,
					});
				}
			for (const item of beforeImports)
				if (!afterImports.has(item)) {
					const [kind = "IMPORTS", target = ""] = item.split("\0");
					file.import_changes.push({
						change: "removed",
						kind: kind as "IMPORTS" | "RE_EXPORTS",
						target,
					});
				}
		}

		// Test cases added, removed, or changed.
		if (category === "test") {
			const cases = (index: Index, file: string | null) =>
				new Map(
					(file ? (index.outgoing.get(`file:${file}`) ?? []) : [])
						.flatMap((e) => (e.to ? (index.nodes.get(e.to) ?? []) : []))
						.filter((n) => n.kind === "test_case")
						.map((n) => [n.name, n]),
				);
			const beforeCases = cases(base, basePath);
			const afterCases = cases(head, headPath);
			for (const [name, node] of afterCases)
				if (!beforeCases.has(name))
					testChanges.push({ name, path: entry.path, change: "added" });
				else if (ranges.head.some((r) => overlaps(node, r)))
					testChanges.push({ name, path: entry.path, change: "modified" });
			for (const name of beforeCases.keys())
				if (!afterCases.has(name))
					testChanges.push({ name, path: entry.path, change: "removed" });
		}

		// Declared dependencies changed in a package manifest.
		if (category === "manifest") {
			const pkg = `pkg:${path.posix.dirname(entry.path)}`;
			const declared = (index: Index) =>
				new Map(
					(index.outgoing.get(pkg) ?? [])
						.filter((e) => e.kind === "DEPENDS_ON" && e.to)
						.map((e) => [
							(e.to ?? "").replace(/^dep:/, ""),
							{
								range:
									typeof e.provenance.range === "string"
										? e.provenance.range
										: null,
								scope:
									typeof e.provenance.scope === "string"
										? e.provenance.scope
										: null,
							},
						]),
				);
			const before = basePath ? declared(base) : new Map();
			const after = headPath ? declared(head) : new Map();
			for (const [name, now] of after) {
				const was = before.get(name);
				if (!was)
					manifestChanges.push({
						path: entry.path,
						dependency: name,
						change: "added",
						scope: now.scope,
						before: null,
						after: now.range,
					});
				else if (was.range !== now.range || was.scope !== now.scope)
					manifestChanges.push({
						path: entry.path,
						dependency: name,
						change: "changed",
						scope: now.scope,
						before: was.range,
						after: now.range,
					});
			}
			for (const [name, was] of before)
				if (!after.has(name))
					manifestChanges.push({
						path: entry.path,
						dependency: name,
						change: "removed",
						scope: was.scope,
						before: was.range,
						after: null,
					});
		}

		// Routes registered in this file that appear or disappear.
		const routes = (index: Index, file: string | null) =>
			new Map(
				file
					? [...index.nodes.values()]
							.filter((n) => n.kind === "route" && n.path === file)
							.map((n) => [n.key, n])
					: [],
			);
		const beforeRoutes = routes(base, basePath);
		const afterRoutes = routes(head, headPath);
		const clients = (index: Index, key: string) =>
			(index.incoming.get(key) ?? []).filter(
				(e) => e.kind === "SENDS_REQUEST_TO",
			).length;
		for (const [key, node] of afterRoutes)
			if (!beforeRoutes.has(key))
				routeChanges.push({
					key,
					name: node.name,
					path: node.path,
					change: "added",
					clients: clients(head, key),
				});
		for (const [key, node] of beforeRoutes)
			if (!afterRoutes.has(key)) {
				routeChanges.push({
					key,
					name: node.name,
					path: node.path,
					change: "removed",
					clients: clients(base, key),
				});
				origins.push({
					key,
					name: node.name,
					change: "route_removed",
					side: "base",
					path: node.path,
					fileLevel: false,
				});
			}

		// Tables whose definition or DDL sits on changed lines (or in a changed definition).
		const changedKeys = new Set(
			symbols
				.filter((s) => s.path === entry.path)
				.flatMap((s) => [s.base_key, s.head_key]),
		);
		for (const side of ["head", "base"] as const) {
			const index = indexOf(side);
			const file = side === "head" ? headPath : basePath;
			if (!file) continue;
			const sources = [
				`file:${file}`,
				...(side === "head" ? headSyms : baseSyms).map((s) => s.key),
			];
			for (const source of sources)
				for (const edge of index.outgoing.get(source) ?? []) {
					if (!edge.to?.startsWith("table:")) continue;
					const ddl =
						edge.kind === "DEFINES" ||
						(edge.kind === "WRITES_TO" &&
							edge.provenance.schema_change === true);
					if (!ddl) continue;
					const line =
						typeof edge.provenance.start_line === "number"
							? edge.provenance.start_line
							: null;
					const onChangedLine =
						line !== null &&
						ranges[side].some((r) => r.start <= line && r.end >= line);
					if (!onChangedLine && !changedKeys.has(source)) continue;
					if (schemaChanges.some((c) => c.table === edge.to)) continue;
					schemaChanges.push({
						table: edge.to,
						path: entry.path,
						line,
						statement:
							typeof edge.provenance.statement === "string"
								? edge.provenance.statement
								: edge.kind === "DEFINES"
									? "definition"
									: "alter",
					});
					origins.push({
						key: edge.to,
						name: edge.to.replace(/^table:/, ""),
						change: "schema_changed",
						side,
						path: entry.path,
						fileLevel: false,
					});
				}
		}
	});

	// What changed symbols now depend on (or no longer do), from their outgoing edges.
	const edgeSet = (index: Index, key: string | null) =>
		new Map(
			(key ? (index.outgoing.get(key) ?? []) : [])
				.filter((e) => DEPENDENCY_EDGES.has(e.kind))
				.map((e) => [
					`${e.kind}\0${e.to ?? `unresolved:${e.target_text ?? ""}`}`,
					e,
				]),
		);
	for (const symbol of symbols) {
		const before = edgeSet(base, symbol.base_key);
		const after = edgeSet(head, symbol.head_key);
		const relabel = (key: string) => {
			const [kind = "CALLS", target = ""] = key.split("\0");
			return { kind: kind as ImpactLink["kind"], target };
		};
		for (const key of after.keys())
			if (!before.has(key))
				dependencyChanges.push({
					symbol: symbol.key,
					change: "added",
					...relabel(key),
				});
		for (const key of before.keys())
			if (!after.has(key))
				dependencyChanges.push({
					symbol: symbol.key,
					change: "removed",
					...relabel(key),
				});
	}

	// ---- Propagation: who the changes reach, with the chain that shows it ----------------------
	const budget = { visits: 0, truncated: false };
	if (origins.length > MAX_ORIGINS) {
		budget.truncated = true;
		limitations.push(
			`The patch has ${origins.length} changed items; impact was traced from the first ${MAX_ORIGINS}.`,
		);
	}
	const best = new Map<string, Finding & { rank: number[] }>();
	const testsBySymbol = new Map<
		string,
		Array<{ node: GraphNode; depth: number; certainty: number; via: string }>
	>();
	const dependentCount = new Map<string, number>();
	for (const origin of origins.slice(0, MAX_ORIGINS)) {
		const index = indexOf(origin.side);
		const reached = walk(
			index,
			origin.key,
			Math.max(input.options.depth, TEST_DEPTH),
			budget,
		);
		const originNode = index.nodes.get(origin.key);
		const originPackage = packageOf(index, originNode);
		let count = 0;
		for (const hop of reached.values()) {
			if (hop.depth === 0) continue;
			const node = index.nodes.get(hop.key);
			if (!node) continue;
			if (isTestNode(node)) {
				const list = testsBySymbol.get(origin.key) ?? [];
				list.push({
					node,
					depth: hop.depth,
					certainty: hop.certainty,
					via: chainOf(reached, hop.key)
						.map((l) => l.kind)
						.join(" → "),
				});
				testsBySymbol.set(origin.key, list);
				continue;
			}
			if (hop.depth > input.options.depth) continue;
			// A symbol's own file and its containing class are not separate impacts.
			if (node.kind === "file" && node.path === origin.path) continue;
			count += 1;
			const chain = chainOf(reached, hop.key);
			const certainty = RANK_CERTAINTY[hop.certainty] ?? "heuristic";
			const targetPackage = packageOf(index, node);
			const category = CATEGORY[node.kind] ?? "other";
			const crossesPackage =
				originPackage !== null &&
				targetPackage !== null &&
				originPackage !== targetPackage;
			const criticalPath =
				["api", "ui", "data", "messaging"].includes(category) ||
				chain.some((l) =>
					["ROUTES_TO", "SENDS_REQUEST_TO", "WRITES_TO", "PUBLISHES"].includes(
						l.kind,
					),
				);
			const previous = hop.prev ? index.nodes.get(hop.prev) : undefined;
			const via = hop.links.at(-1)?.kind ?? "REFERENCES";
			const reason = hop.dataBridge
				? `reads ${previous?.name ?? hop.prev ?? "a table"}, which the changed ${origin.name} writes (data coupling, not a code link)`
				: via === "PUBLISHES"
					? `receives what ${previous?.name ?? "the changed code"} publishes`
					: `${VERB[via] ?? "depends on"} ${previous?.name ?? hop.prev ?? origin.name}${
							hop.depth > 1
								? `, which leads to the changed ${origin.name} (${hop.depth} hops)`
								: ""
						}`;
			const severity = severityOf({
				originChange: origin.change,
				depth: hop.depth,
				crossesPackage,
				criticalPath,
				observed: false,
			});
			const confidence = confidenceOf({
				observed: false,
				certainty,
				fileLevel: origin.fileLevel,
				dataBridge: hop.dataBridge,
			});
			const finding: Finding & { rank: number[] } = {
				id: "",
				origin: { key: origin.key, name: origin.name, change: origin.change },
				target: {
					key: node.key,
					name: node.name,
					kind: node.kind,
					path: node.path,
					line: node.start_line,
					package: targetPackage,
				},
				graph: origin.side,
				depth: hop.depth,
				chain,
				certainty,
				category,
				reason,
				crosses_package: crossesPackage,
				critical_path: criticalPath,
				observed: false,
				severity,
				confidence,
				also_from: [],
				rank: [
					SEVERITY_RANK[severity],
					CONFIDENCE_RANK[confidence],
					-hop.depth,
				],
			};
			const known = best.get(node.key);
			if (!known) best.set(node.key, finding);
			else {
				const better =
					finding.rank[0] !== known.rank[0]
						? (finding.rank[0] ?? 0) > (known.rank[0] ?? 0)
						: finding.rank[1] !== known.rank[1]
							? (finding.rank[1] ?? 0) > (known.rank[1] ?? 0)
							: (finding.rank[2] ?? 0) > (known.rank[2] ?? 0);
				const merged = better ? finding : known;
				const other = better ? known : finding;
				merged.also_from = [
					...new Set([
						...known.also_from,
						...finding.also_from,
						other.origin.key,
					]),
				]
					.filter((key) => key !== merged.origin.key)
					.slice(0, 5);
				best.set(node.key, merged);
			}
		}
		dependentCount.set(origin.key, count);
	}

	// Removed code that head code still names: an unresolved reference is observed, not inferred.
	for (const symbol of symbols.filter((s) => s.change === "removed")) {
		if (!symbol.base_key) continue;
		const last = lastSegment(symbol.name);
		for (const edge of base.incoming.get(symbol.base_key) ?? []) {
			if (!DEPENDENT_EDGES.has(edge.kind) || edge.kind === "TESTS") continue;
			const user = head.nodes.get(edge.from);
			if (!user) continue;
			const dangling = (head.outgoing.get(edge.from) ?? []).find(
				(e) =>
					e.to === null &&
					typeof e.target_text === "string" &&
					(e.target_text === last ||
						e.target_text === symbol.name ||
						e.target_text.endsWith(`.${last}`)),
			);
			if (!dangling) continue;
			const finding: Finding & { rank: number[] } = {
				id: "",
				origin: { key: symbol.key, name: symbol.name, change: "removed" },
				target: {
					key: user.key,
					name: user.name,
					kind: user.kind,
					path: user.path,
					line: user.start_line,
					package: packageOf(head, user),
				},
				graph: "head",
				depth: 1,
				chain: [
					{ ...linkOf(dangling), to: `unresolved:${dangling.target_text}` },
				],
				certainty: "exact",
				category: CATEGORY[user.kind] ?? "other",
				reason: `still refers to ${dangling.target_text}, which this patch removes (the reference no longer resolves)`,
				crosses_package: false,
				critical_path: false,
				observed: true,
				severity: "high",
				confidence: "high",
				also_from: [],
				rank: [4, 3, -1],
			};
			// Keep what else reached this code: the broken reference outranks it, but it stays visible.
			const known = best.get(user.key);
			if (known)
				finding.also_from = [...new Set([...known.also_from, known.origin.key])]
					.filter((key) => key !== finding.origin.key)
					.slice(0, 5);
			best.set(user.key, finding);
		}
	}

	// Rank deterministically: severity, confidence, distance, then key. Number after ranking.
	const ranked = [...best.values()].sort(
		(a, b) =>
			(b.rank[0] ?? 0) - (a.rank[0] ?? 0) ||
			(b.rank[1] ?? 0) - (a.rank[1] ?? 0) ||
			(b.rank[2] ?? 0) - (a.rank[2] ?? 0) ||
			a.target.key.localeCompare(b.target.key),
	);
	// File-level findings for files that already have symbol-level findings add nothing.
	const symbolFiles = new Set(
		ranked.filter((f) => f.target.kind !== "file").map((f) => f.target.path),
	);
	const deduped = ranked.filter(
		(f) => f.target.kind !== "file" || !symbolFiles.has(f.target.path),
	);
	if (deduped.length > input.options.limit) budget.truncated = true;
	const findings: Finding[] = deduped
		.slice(0, input.options.limit)
		.map(({ rank: _rank, ...finding }, i) => ({ ...finding, id: `F${i + 1}` }));

	// ---- Tests: which tests are linked to each changed symbol, and how strongly ----------------
	const unparsedTests = (index: Index) => {
		const packages = new Set<string | null>();
		for (const node of index.nodes.values())
			if (
				(node.kind === "test_file" ||
					(node.kind === "file" && node.path && TEST_FILE.test(node.path))) &&
				node.attributes.parsed !== true
			)
				packages.add(
					typeof node.attributes.package === "string"
						? node.attributes.package
						: null,
				);
		return packages;
	};
	const failedTestPackages = {
		base: unparsedTests(base),
		head: unparsedTests(head),
	};
	const byFile = (index: Index, file: string) =>
		(index.incoming.get(`file:${file}`) ?? [])
			.filter((e) => e.kind === "TESTS")
			.flatMap((e) => index.nodes.get(e.from) ?? []);
	const testCasesIn = (index: Index, file: string) =>
		(index.outgoing.get(`file:${file}`) ?? [])
			.flatMap((e) => (e.to ? (index.nodes.get(e.to) ?? []) : []))
			.filter((n) => n.kind === "test_case");
	const byTestSymbol: PatchImpactResult["tests"]["by_symbol"] = [];
	for (const symbol of symbols) {
		const side: Side = symbol.head_key ? "head" : "base";
		const index = indexOf(side);
		const key = symbol.head_key ?? symbol.base_key ?? symbol.key;
		const linked = new Map<
			string,
			PatchImpactResult["tests"]["by_symbol"][number]["tests"][number]
		>();
		for (const test of testsBySymbol.get(key) ?? []) {
			if (test.node.kind !== "test_case") continue;
			const relevant = test.certainty >= 2 && test.depth <= TEST_DEPTH;
			linked.set(test.node.key, {
				key: test.node.key,
				name: test.node.name,
				path: test.node.path,
				state: relevant ? "relevant" : "possible",
				distance: test.depth,
				via: relevant
					? test.depth === 1
						? "tests it directly"
						: `reaches it through ${test.depth} links (${test.via})`
					: test.certainty < 2
						? `reaches it only through a guessed link (${test.via})`
						: `reaches it only through ${test.depth} links (${test.via})`,
			});
		}
		// Weak links: a test file that imports the module but whose cases cannot be followed, and
		// test names that mention the symbol.
		for (const testFile of byFile(index, symbol.path)) {
			if (!testFile.path) continue;
			const cases = testCasesIn(index, testFile.path);
			const opaque =
				cases.length === 0 ||
				Number(testFile.attributes.unresolved_calls ?? 0) > 0;
			if (opaque && !linked.has(testFile.key))
				linked.set(testFile.key, {
					key: testFile.key,
					name: testFile.path,
					path: testFile.path,
					state: "possible",
					distance: 1,
					via:
						cases.length === 0
							? "imports the changed module; it has no test cases Tracera could read"
							: "imports the changed module; some of its calls could not be resolved",
				});
		}
		const word = lastSegment(symbol.name);
		if (word.length >= 4) {
			const pattern = new RegExp(
				`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
				"i",
			);
			const pkg = packageOf(index, index.nodes.get(key));
			for (const node of index.nodes.values())
				if (
					node.kind === "test_case" &&
					!linked.has(node.key) &&
					pattern.test(node.name) &&
					packageOf(index, node) === pkg
				)
					linked.set(node.key, {
						key: node.key,
						name: node.name,
						path: node.path,
						state: "possible",
						distance: 0,
						via: `its name mentions ${word} (name only, no code link)`,
					});
		}
		const tests = [...linked.values()]
			.sort(
				(a, b) =>
					(a.state === "relevant" ? 0 : 1) - (b.state === "relevant" ? 0 : 1) ||
					a.distance - b.distance ||
					a.key.localeCompare(b.key),
			)
			.slice(0, 20);
		const pkg = packageOf(index, index.nodes.get(key));
		const state: TestState = tests.some((t) => t.state === "relevant")
			? "relevant"
			: tests.length > 0
				? "possible"
				: failedTestPackages[side].has(pkg)
					? "unknown"
					: "none_identified";
		symbol.tests = state;
		symbol.dependents = dependentCount.get(key) ?? 0;
		byTestSymbol.push({
			symbol: symbol.key,
			state,
			reason:
				state === "relevant"
					? "A test case reaches it through exact or resolved links."
					: state === "possible"
						? "Only weak links connect tests to it (a guessed link, a long path, an opaque test file, or a name)."
						: state === "unknown"
							? "Test files in its package could not be parsed, so a relevant test may exist."
							: "No test case reaches it through the static graph; this is not proof that no test runs it.",
			tests,
		});
	}
	for (const file of unknownFiles)
		byTestSymbol.push({
			symbol: `file:${file.path}`,
			state: "unknown",
			reason: `${file.reason}, so tests cannot be linked to its symbols.`,
			tests: [],
		});
	const recommended = new Map<
		string,
		PatchImpactResult["tests"]["recommended"][number] & { order: number[] }
	>();
	for (const entry of byTestSymbol)
		for (const test of entry.tests) {
			const reason = `${test.via} (${entry.symbol.replace(/^(sym|file):/, "")})`;
			const order = [test.state === "relevant" ? 0 : 1, test.distance];
			const known = recommended.get(test.key);
			if (
				!known ||
				(order[0] ?? 0) < (known.order[0] ?? 0) ||
				((order[0] ?? 0) === (known.order[0] ?? 0) &&
					(order[1] ?? 0) < (known.order[1] ?? 0))
			)
				recommended.set(test.key, {
					name: test.name,
					path: test.path,
					state: test.state,
					reason,
					order,
				});
		}

	// ---- Risk: highest severity among strong findings, and among all ---------------------------
	const highest = (list: Finding[]) =>
		list.reduce<Severity | null>(
			(top, f) =>
				top === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[top]
					? f.severity
					: top,
			null,
		);
	const strong = findings.filter((f) => f.confidence === "high");
	const evidencedSeverity = highest(strong);
	const plausibleSeverity = highest(findings);
	const factors: string[] = [];
	const contract = symbols.filter((s) =>
		["removed", "signature_changed", "export_changed"].includes(s.change),
	);
	if (contract.length > 0)
		factors.push(
			`${contract.length} symbol(s) changed their contract (removed, signature, type, or export): ${contract
				.slice(0, 5)
				.map((s) => s.name)
				.join(", ")}`,
		);
	const broken = findings.filter((f) => f.observed);
	if (broken.length > 0)
		factors.push(
			`${broken.length} reference(s) to removed code no longer resolve in the head revision`,
		);
	const crossing = findings.filter((f) => f.crosses_package);
	if (crossing.length > 0)
		factors.push(`${crossing.length} finding(s) cross a package boundary`);
	if (schemaChanges.length > 0)
		factors.push(
			`Database schema changes: ${schemaChanges.map((c) => c.table.replace(/^table:/, "")).join(", ")}`,
		);
	if (routeChanges.some((r) => r.change === "removed"))
		factors.push(
			`Removed routes: ${routeChanges
				.filter((r) => r.change === "removed")
				.map((r) => r.name)
				.join(", ")}`,
		);
	if (manifestChanges.length > 0)
		factors.push(
			`${manifestChanges.length} declared dependency change(s) in package manifests`,
		);
	const untested = symbols.filter((s) => s.tests === "none_identified");
	if (untested.length > 0)
		factors.push(
			`${untested.length} changed symbol(s) with no relevant test identified`,
		);
	const unknownTests = byTestSymbol.filter((t) => t.state === "unknown");
	if (unknownTests.length > 0)
		factors.push(
			`Test coverage unknown for ${unknownTests.length} changed item(s)`,
		);
	const weak = findings.filter((f) => f.confidence !== "high");
	if (weak.length > 0)
		factors.push(
			`${weak.length} finding(s) rest on weaker evidence (a guessed link, data coupling, or a file-level fallback)`,
		);

	// ---- Review actions: each tied to evidence, or labelled a precaution ------------------------
	const actions: PatchImpactResult["review_actions"] = [];
	for (const finding of broken.slice(0, 10))
		actions.push({
			action: `Fix ${finding.target.name}${finding.target.path ? ` (${finding.target.path})` : ""}: it ${finding.reason}.`,
			basis: "evidence",
			refs: [finding.id],
		});
	for (const finding of findings
		.filter((f) => !f.observed && f.severity === "high")
		.slice(0, 10))
		actions.push({
			action: `Review ${finding.target.name}${finding.target.path ? ` (${finding.target.path}${finding.target.line ? `:${finding.target.line}` : ""})` : ""}: it ${finding.reason}, and ${finding.origin.name} changed (${finding.origin.change.replace(/_/g, " ")}).`,
			basis: "evidence",
			refs: [finding.id],
		});
	for (const symbol of untested
		.sort((a, b) => b.dependents - a.dependents || a.key.localeCompare(b.key))
		.slice(0, 10))
		actions.push({
			action: `Add or point to a test for ${symbol.name} (${symbol.path}): no relevant test was identified.`,
			basis: "evidence",
			refs: [symbol.key],
		});
	for (const entry of unknownTests.slice(0, 10))
		actions.push({
			action: `Check the tests for ${entry.symbol.replace(/^(sym|file):/, "")} by hand: ${entry.reason}`,
			basis: "evidence",
			refs: [entry.symbol],
		});
	const toRun = [...recommended.values()].filter((t) => t.state === "relevant");
	if (toRun.length > 0)
		actions.push({
			action: `Run the ${toRun.length} test(s) linked to the changed code: ${toRun
				.slice(0, 5)
				.map((t) => t.name)
				.join("; ")}${toRun.length > 5 ? "; …" : ""}.`,
			basis: "evidence",
			refs: [...recommended.keys()].filter(
				(key) => recommended.get(key)?.state === "relevant",
			),
		});
	if (contract.some((s) => s.exported))
		actions.push({
			action:
				"Exported symbols changed their contract: callers outside this repository (for example consumers of a published package) are not visible here; check them.",
			basis: "precaution",
			refs: contract.filter((s) => s.exported).map((s) => s.key),
		});
	actions.push({
		action:
			"Static analysis does not follow dynamic dispatch, reflection, runtime configuration, or requests with computed URLs; review such paths by hand.",
		basis: "precaution",
		refs: [],
	});

	// ---- Limitations -----------------------------------------------------------------------------
	if (!base.complete || !head.complete) {
		complete = false;
		limitations.push(
			"The graph of the base or head revision is partial (some files could not be parsed): dependents and tests in those files are not seen.",
		);
	}
	if (budget.truncated) {
		complete = false;
		limitations.push(
			"Tracing stopped at its limits (depth, findings, or work); more impact may exist.",
		);
	}
	if (unknownFiles.length > 0)
		limitations.push(
			`${unknownFiles.length} changed file(s) could not be analysed at the symbol level; their impact is approximated by who imports them.`,
		);
	limitations.push(
		"Static links only: impact and test links follow parsed calls, renders, routes, requests, data access, configuration, and events. Missing links do not prove there is no impact, and linked tests do not prove the change is covered. Nothing was run.",
	);
	if (findings.some((f) => f.certainty === "heuristic"))
		limitations.push(
			"Some findings rest on heuristic links (for example a route whose mount prefix is unknown, or an event name); they are marked with low confidence.",
		);

	const countSymbols = (change: SymbolChange) =>
		symbols.filter((s) => s.change === change).length;
	const countTests = (state: TestState) =>
		byTestSymbol.filter((t) => t.state === state).length;
	return {
		version: PATCH_IMPACT_VERSION,
		complete,
		base: input.baseRef,
		head: input.headRef,
		merge_base: input.mergeBase,
		summary: {
			files: files.length,
			added: files.filter((f) => f.status === "added" || f.status === "copied")
				.length,
			modified: files.filter((f) => f.status === "modified").length,
			deleted: files.filter((f) => f.status === "deleted").length,
			renamed: files.filter((f) => f.status === "renamed").length,
			binary: files.filter(
				(f) => f.parse.base === "binary" || f.parse.head === "binary",
			).length,
			generated: files.filter((f) => f.category === "generated").length,
			symbols: {
				added: countSymbols("added"),
				removed: countSymbols("removed"),
				modified: countSymbols("modified"),
				signature_changed: countSymbols("signature_changed"),
				export_changed: countSymbols("export_changed"),
			},
			findings: findings.length,
			tests: {
				relevant: countTests("relevant"),
				possible: countTests("possible"),
				none_identified: countTests("none_identified"),
				unknown: countTests("unknown"),
			},
		},
		files,
		symbols,
		test_changes: testChanges,
		dependency_changes: dependencyChanges.slice(0, 300),
		route_changes: routeChanges,
		schema_changes: schemaChanges,
		manifest_changes: manifestChanges,
		findings,
		tests: {
			by_symbol: byTestSymbol,
			recommended: [...recommended.values()]
				.sort(
					(a, b) =>
						(a.order[0] ?? 0) - (b.order[0] ?? 0) ||
						(a.order[1] ?? 0) - (b.order[1] ?? 0) ||
						a.name.localeCompare(b.name),
				)
				.slice(0, 50)
				.map(({ order: _order, ...test }) => test),
		},
		risk: {
			evidenced: {
				severity: evidencedSeverity,
				findings: strong
					.filter((f) => f.severity === evidencedSeverity)
					.map((f) => f.id)
					.slice(0, 20),
			},
			plausible: {
				severity: plausibleSeverity,
				findings: findings
					.filter((f) => f.severity === plausibleSeverity)
					.map((f) => f.id)
					.slice(0, 20),
			},
			factors,
		},
		review_actions: actions,
		limitations,
		stats: { edges_visited: budget.visits, truncated: budget.truncated },
	};
}

// ---- Markdown report ----------------------------------------------------------------------------

/** A code-review report: every statement comes from the structured result. */
export function renderPatchImpactMarkdown(result: PatchImpactResult): string {
	const list = (items: string[]) =>
		items.length > 0 ? items.map((item) => `- ${item}`) : ["- None"];
	const short = (key: string) =>
		key.replace(/^(sym|file|test|route|table|page|env|ext|event|queue):/, "");
	const s = result.summary;
	return [
		`# Patch impact: ${result.base.sha.slice(0, 12)} → ${result.head.sha.slice(0, 12)}${result.head.kind === "tree" ? " (supplied diff)" : ""}`,
		"",
		result.complete
			? "Analysis complete for what the static graph can see."
			: "**Partial analysis**: see the limitations; missing findings are not evidence of no impact.",
		"",
		`**Risk:** evidenced ${result.risk.evidenced.severity ?? "none"} · plausible ${result.risk.plausible.severity ?? "none"} (severity is how much a finding would matter; confidence is how strong its evidence is).`,
		"",
		"## Patch summary",
		"",
		`${s.files} file(s): ${s.added} added, ${s.modified} modified, ${s.deleted} deleted, ${s.renamed} renamed, ${s.binary} binary, ${s.generated} generated. Symbols: ${s.symbols.added} added, ${s.symbols.removed} removed, ${s.symbols.modified} modified, ${s.symbols.signature_changed} with a changed signature or type, ${s.symbols.export_changed} with a changed export.`,
		"",
		...list(result.risk.factors),
		"",
		"## Changed files and symbols",
		"",
		...list(
			result.files.map(
				(f) =>
					`\`${f.old_path ? `${f.old_path} → ` : ""}${f.path}\` (${f.status}, ${f.category}${f.additions !== null ? `, +${f.additions}/-${f.deletions}` : ""}; parsed: base ${f.parse.base}, head ${f.parse.head})${f.notes.length > 0 ? `: ${f.notes.join(" ")}` : ""}`,
			),
		),
		"",
		...list(
			result.symbols.map(
				(sym) =>
					`${sym.name} (${sym.kind}, \`${sym.path}\`): ${sym.change.replace(/_/g, " ")}${sym.exported ? ", exported" : ""}; ${sym.dependents} dependent(s); tests: ${sym.tests.replace(/_/g, " ")}${sym.signature?.before || sym.signature?.after ? `. Before: \`${sym.signature?.before ?? "—"}\` After: \`${sym.signature?.after ?? "—"}\`` : ""}`,
			),
		),
		"",
		"## Highest-priority potential impacts",
		"",
		...list(
			result.findings
				.slice(0, 25)
				.map(
					(f) =>
						`**${f.id}** ${f.severity} severity, ${f.confidence} confidence${f.observed ? ", observed" : ""}: ${f.target.name}${f.target.path ? ` (\`${f.target.path}${f.target.line ? `:${f.target.line}` : ""}\`)` : ""} ${f.reason}. Chain: ${f.chain.map((l) => `${short(l.from)} ${l.kind} ${short(l.to)} [${l.certainty}${l.path ? `, ${l.path}${l.line ? `:${l.line}` : ""}` : ""}]`).join("; ")}`,
				),
		),
		...(result.findings.length > 25
			? [`- …and ${result.findings.length - 25} more in the structured result`]
			: []),
		"",
		"## Tests for the changed behaviour",
		"",
		...list(
			result.tests.by_symbol.map(
				(t) =>
					`${short(t.symbol)}: **${t.state.replace(/_/g, " ")}** — ${t.reason}${
						t.tests.length > 0
							? ` (${t.tests
									.slice(0, 5)
									.map((x) => `${x.name}: ${x.via}`)
									.join("; ")})`
							: ""
					}`,
			),
		),
		"",
		"### Recommended tests (selected, not run)",
		"",
		...list(
			result.tests.recommended
				.slice(0, 20)
				.map(
					(t) =>
						`${t.name}${t.path ? ` (\`${t.path}\`)` : ""}: ${t.state}, ${t.reason}`,
				),
		),
		"",
		"## Other changes",
		"",
		...list([
			...result.route_changes.map(
				(r) =>
					`Route ${r.change}: ${r.name} (${r.clients} client request(s) in the graph)`,
			),
			...result.schema_changes.map(
				(c) =>
					`Schema: ${short(c.table)} (${c.statement}, \`${c.path}${c.line ? `:${c.line}` : ""}\`)`,
			),
			...result.manifest_changes.map(
				(m) =>
					`Dependency ${m.change}: ${m.dependency} (${m.scope ?? "?"}) ${m.before ?? ""}${m.before && m.after ? " → " : ""}${m.after ?? ""} in \`${m.path}\``,
			),
			...result.test_changes.map(
				(t) => `Test ${t.change}: ${t.name} (\`${t.path}\`)`,
			),
		]),
		"",
		"## Recommended review actions",
		"",
		...list(
			result.review_actions.map(
				(a) =>
					`${a.basis === "precaution" ? "(General precaution) " : ""}${a.action}${a.refs.length > 0 ? ` [${a.refs.slice(0, 5).map(short).join(", ")}]` : ""}`,
			),
		),
		"",
		"## Limitations",
		"",
		...list(result.limitations),
		"",
	].join("\n");
}
