import { stat } from "node:fs/promises";
import type {
	ChangeImpactRequest,
	EvidenceRef,
	GraphHistoryQuery,
	GraphTraceQuery,
	MapStackTraceRequest,
} from "@tracera/contracts";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { graphEdges, graphNodes } from "../db/schema.ts";
import { git } from "../lib/git.ts";
import { AppError } from "../lib/http.ts";
import { redactSecrets } from "../lib/redact.ts";
import { toSnapshotView } from "./graph.ts";
import { canonicalRoutePath } from "./graph-build.ts";
import {
	impactFrom,
	loadNode,
	nodeIdsFor,
	SYMBOL_KINDS,
	snapshotFor,
	toEdgeView,
	toNodeView,
} from "./graph-queries.ts";
import {
	correlateLogs,
	innermost,
	type MappedFrame,
	mapFrames,
	normalizeFramePath,
	parseStackTrace,
	pathResolver,
	STACK_TRACE_LIMITATIONS,
} from "./stack-traces.ts";
import { mirrorPath, readBlob } from "./workspace.ts";

// Engineering questions answered from a stored snapshot: how behaviour flows (trace), what a change
// reaches (impact), and where code came from (history). Bounded, workspace-scoped, and explicit about
// what the static graph cannot see.

type EdgeRow = typeof graphEdges.$inferSelect;
type NodeRow = typeof graphNodes.$inferSelect;

const MAX_FRONTIER = 200;
/** Relationships that carry behaviour forward: UI → handler → client → route → handler → service → data. */
const FLOW_EDGES = [
	"ROUTES_TO",
	"RENDERS",
	"HANDLES_EVENT",
	"CALLS",
	"SENDS_REQUEST_TO",
	"READS_FROM",
	"WRITES_TO",
	"PUBLISHES",
	"CONFIGURED_BY",
];
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Traces behaviour from a node, downstream (what it leads to) or upstream (what leads to it), breadth
 * first over flow relationships; an event or queue leads on to its subscribers. Unresolved links and
 * functions with unresolved calls are returned as gaps, never bridged by guesses.
 */
export async function traceFlow(
	db: Db,
	workspaceId: string,
	nodeId: string,
	query: GraphTraceQuery,
) {
	const { node, snapshot } = await loadNode(db, workspaceId, nodeId);
	const downstream = query.direction === "downstream";
	const certainties: Array<EdgeRow["certainty"]> = query.include_heuristic
		? ["exact", "resolved", "heuristic", "unresolved"]
		: ["exact", "resolved", "unresolved"];
	const distance = new Map<string, number>([[node.key, 0]]);
	const edges: EdgeRow[] = [];
	const seen = new Set<number>();
	const gaps: Array<{
		from_key: string;
		kind: string;
		target_text: string | null;
		reason: string;
	}> = [];
	let frontier = [node.key];
	let truncated = false;
	for (let depth = 1; depth <= query.depth && frontier.length > 0; depth++) {
		const rows = await db
			.select()
			.from(graphEdges)
			.where(
				and(
					eq(graphEdges.snapshotId, snapshot.id),
					inArray(graphEdges.certainty, certainties),
					downstream
						? or(
								and(
									inArray(graphEdges.fromKey, frontier),
									inArray(graphEdges.kind, FLOW_EDGES),
								),
								and(
									inArray(graphEdges.toKey, frontier),
									eq(graphEdges.kind, "SUBSCRIBES_TO"),
								),
							)
						: or(
								and(
									inArray(graphEdges.toKey, frontier),
									inArray(graphEdges.kind, FLOW_EDGES),
								),
								and(
									inArray(graphEdges.fromKey, frontier),
									eq(graphEdges.kind, "SUBSCRIBES_TO"),
								),
							),
				),
			)
			.orderBy(asc(graphEdges.id))
			.limit(query.limit + 1);
		if (rows.length > query.limit) truncated = true;
		const current = new Set(frontier);
		const next: string[] = [];
		for (const edge of rows) {
			if (seen.has(edge.id)) continue;
			seen.add(edge.id);
			// Subscriptions point from the subscriber to the channel; flow runs the other way.
			const reversed = edge.kind === "SUBSCRIBES_TO";
			const other = downstream
				? reversed
					? current.has(edge.toKey ?? "")
						? edge.fromKey
						: null
					: edge.toKey
				: reversed
					? current.has(edge.fromKey)
						? edge.toKey
						: null
					: edge.fromKey;
			if (!other) {
				if (downstream && edge.toKey === null)
					gaps.push({
						from_key: edge.fromKey,
						kind: edge.kind,
						target_text: edge.targetText,
						reason: "unresolved_target",
					});
				continue;
			}
			if (edges.length >= query.limit) {
				truncated = true;
				break;
			}
			edges.push(edge);
			if (!distance.has(other)) {
				distance.set(other, depth);
				next.push(other);
			}
		}
		if (next.length > MAX_FRONTIER) truncated = true;
		frontier = next.slice(0, MAX_FRONTIER);
	}
	const nodes = await nodeIdsFor(db, snapshot.id, distance.keys());
	const ids = new Map([...nodes].map(([key, row]) => [key, row.id]));
	for (const row of nodes.values()) {
		const unresolved = Number(row.attributes.unresolved_calls ?? 0);
		if (unresolved > 0)
			gaps.push({
				from_key: row.key,
				kind: "CALLS",
				target_text: null,
				reason: `${unresolved} call(s) from here could not be resolved; the flow may continue through them`,
			});
	}
	const limitations = [
		"Static flow only: links come from parsed source (routes, handlers, requests, calls, data access); runtime routing, dependency injection, and reflection are not seen.",
	];
	if (snapshot.coverage?.complete !== true)
		limitations.push(
			"The snapshot's coverage is partial; parts of the flow may be missing.",
		);
	if (truncated)
		limitations.push("The trace stopped at its depth, breadth, or edge limit.");
	return {
		snapshot: toSnapshotView(snapshot),
		start: toNodeView(node),
		direction: query.direction,
		nodes: [...nodes.values()]
			.map((row) => ({
				...toNodeView(row),
				distance: distance.get(row.key) ?? 0,
			}))
			.sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key)),
		edges: edges.map((edge) => toEdgeView(edge, ids)),
		gaps: gaps.slice(0, 100),
		truncated,
		limitations,
	};
}

/** How strongly a dependency carries a change, by relationship (used to rank impact findings). */
const EDGE_WEIGHT: Record<string, number> = {
	CALLS: 1,
	WRITES_TO: 1,
	ROUTES_TO: 1,
	TESTS: 1,
	EXTENDS: 0.9,
	READS_FROM: 0.9,
	RENDERS: 0.9,
	HANDLES_EVENT: 0.9,
	SENDS_REQUEST_TO: 0.9,
	IMPLEMENTS: 0.8,
	CONFIGURED_BY: 0.8,
	REFERENCES: 0.7,
	PUBLISHES: 0.7,
	SUBSCRIBES_TO: 0.7,
	IMPORTS: 0.6,
	RE_EXPORTS: 0.6,
};
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
	test_case: "tests",
	test_file: "tests",
	file: "files",
};

/**
 * Change impact for files, symbols, routes, tables, or configuration keys: dependents reached by walking
 * resolved relationships backwards (bounded), each ranked and explained by the chain that reaches it,
 * with the tests, owners, and recent commits involved. Heuristic links are not followed, so the list
 * is a floor, not a guarantee; the limitations say where it may be incomplete.
 */
export async function analyzeImpact(
	deps: { db: Db; config: Config },
	workspaceId: string,
	repositoryId: string,
	input: ChangeImpactRequest,
) {
	const snapshot = await snapshotFor(
		deps.db,
		workspaceId,
		repositoryId,
		input.snapshot_id,
	);
	const inSnapshot = eq(graphNodes.snapshotId, snapshot.id);
	const resolvedTargets: Array<{
		target: ChangeImpactRequest["targets"][number];
		nodes: ReturnType<typeof toNodeView>[];
		ambiguous: boolean;
	}> = [];
	for (const target of input.targets) {
		let rows: NodeRow[] = [];
		if (target.kind === "node") {
			const found = await loadNode(deps.db, workspaceId, target.id);
			if (found.snapshot.id !== snapshot.id)
				throw new AppError(
					422,
					"snapshot_mismatch",
					`Node ${target.id} belongs to snapshot ${found.snapshot.id}, not ${snapshot.id}`,
				);
			rows = [found.node];
		} else {
			const routeKey =
				target.kind === "route"
					? `route:${target.method} ${canonicalRoutePath(target.path)}`
					: "";
			const where =
				target.kind === "file"
					? and(
							inArray(graphNodes.kind, ["file", "test_file"]),
							eq(graphNodes.path, target.path),
						)
					: target.kind === "symbol"
						? and(
								inArray(graphNodes.kind, [...SYMBOL_KINDS]),
								eq(graphNodes.name, target.name),
								target.path ? eq(graphNodes.path, target.path) : undefined,
							)
						: target.kind === "route"
							? or(
									eq(graphNodes.key, routeKey),
									like(graphNodes.key, `${escapeLike(routeKey)}@%`),
								)
							: target.kind === "table"
								? eq(graphNodes.key, `table:${target.name.toLowerCase()}`)
								: eq(graphNodes.key, `env:${target.name}`);
			rows = await deps.db
				.select()
				.from(graphNodes)
				.where(and(inSnapshot, where))
				.orderBy(asc(graphNodes.path))
				.limit(20);
		}
		resolvedTargets.push({
			target,
			nodes: rows.map(toNodeView),
			ambiguous: rows.length > 1,
		});
	}
	const unresolvedTargets = resolvedTargets
		.filter((t) => t.nodes.length === 0)
		.map((t) => t.target);
	const startKeys = [
		...new Set(resolvedTargets.flatMap((t) => t.nodes.map((n) => n.key))),
	];
	if (startKeys.length === 0)
		return {
			snapshot: toSnapshotView(snapshot),
			targets: resolvedTargets,
			unresolved_targets: unresolvedTargets,
			affected: [],
			groups: {},
			tests: [],
			untested_targets: [],
			owners: [],
			recent_commits: [],
			truncated: false,
			limitations: ["None of the targets exist in this snapshot."],
		};
	const impact = await impactFrom(deps.db, snapshot, startKeys, {
		depth: input.depth,
		limit: input.limit,
	});
	const hops = new Map(impact.affected.map((item) => [item.node.key, item]));
	/** The chain from an affected item back to the change that reaches it. */
	const why = (key: string) => {
		const chain: Array<{ from_key: string; kind: string; to_key: string }> = [];
		let current = key;
		for (let i = 0; i < 10; i++) {
			const hop = hops.get(current);
			if (!hop) break;
			chain.push({ from_key: current, kind: hop.via, to_key: hop.from });
			current = hop.from;
		}
		return { chain, origin: impact.origins.get(current) ?? current };
	};
	const affected = impact.affected
		.map((item) => {
			const explanation = why(item.node.key);
			const weight = explanation.chain.reduce(
				(product, link) => product * (EDGE_WEIGHT[link.kind] ?? 0.5),
				1,
			);
			return {
				node: item.node,
				category: CATEGORY[item.node.kind] ?? "other",
				distance: item.distance,
				via: item.via,
				certainty: item.certainty,
				score: Math.round((weight / item.distance) * 100) / 100,
				reached_from: explanation.origin,
				why: explanation.chain,
			};
		})
		.sort((a, b) => b.score - a.score || a.distance - b.distance);
	const groups: Record<string, number> = {};
	for (const item of affected)
		groups[item.category] = (groups[item.category] ?? 0) + 1;
	const tests = affected.filter((item) => item.category === "tests");
	const testedOrigins = new Set(tests.map((item) => item.reached_from));
	const untested = startKeys.filter(
		(key) =>
			!key.startsWith("table:") &&
			!key.startsWith("env:") &&
			!testedOrigins.has(key),
	);
	// Ownership and history of the changed files, and ownership of the files that depend on them.
	const changedFiles = [
		...new Set(
			resolvedTargets.flatMap((t) =>
				t.nodes.flatMap((n) => (n.path ? [n.path] : [])),
			),
		),
	];
	const affectedFiles = [
		...new Set(
			affected.flatMap((item) => (item.node.path ? [item.node.path] : [])),
		),
	];
	const fileKeys = [...new Set([...changedFiles, ...affectedFiles])]
		.slice(0, 300)
		.map((file) => `file:${file}`);
	const context =
		fileKeys.length > 0
			? await deps.db
					.select()
					.from(graphEdges)
					.where(
						and(
							eq(graphEdges.snapshotId, snapshot.id),
							inArray(graphEdges.fromKey, fileKeys),
							inArray(graphEdges.kind, [
								"OWNED_BY",
								"INTRODUCED_OR_CHANGED_BY",
							]),
						),
					)
					.limit(2000)
			: [];
	const contextNodes = await nodeIdsFor(
		deps.db,
		snapshot.id,
		context.flatMap((edge) => (edge.toKey ? [edge.toKey] : [])),
	);
	const owners = new Map<string, Set<string>>();
	const commits = new Map<
		string,
		{ sha: string; date: string; subject: string; files: string[] }
	>();
	for (const edge of context) {
		if (!edge.toKey) continue;
		const file = edge.fromKey.slice("file:".length);
		const target = contextNodes.get(edge.toKey);
		if (edge.kind === "OWNED_BY") {
			const owner = target?.name ?? edge.toKey;
			const files = owners.get(owner) ?? new Set<string>();
			files.add(file);
			owners.set(owner, files);
		} else if (target && changedFiles.includes(file)) {
			const entry = commits.get(edge.toKey) ?? {
				sha: String(target.attributes.sha ?? ""),
				date: String(target.attributes.date ?? ""),
				subject: target.name,
				files: [],
			};
			entry.files.push(file);
			commits.set(edge.toKey, entry);
		}
	}
	const limitations = [...impact.limitations];
	if (resolvedTargets.some((t) => t.ambiguous))
		limitations.push(
			"Some targets matched several entities (the same name in different files); all were included. Pass a path to narrow a symbol.",
		);
	if (unresolvedTargets.length > 0)
		limitations.push(
			"Some targets were not found in this snapshot and contribute nothing.",
		);
	limitations.push(
		"Ownership comes from CODEOWNERS (declared responsibility, not authorship); history covers the indexed commit window only.",
	);
	return {
		snapshot: toSnapshotView(snapshot),
		targets: resolvedTargets,
		unresolved_targets: unresolvedTargets,
		affected,
		groups,
		tests,
		untested_targets: untested,
		owners: [...owners].map(([owner, files]) => ({
			owner,
			files: [...files].sort(),
			basis: "codeowners",
		})),
		recent_commits: [...commits.values()]
			.sort((a, b) => b.date.localeCompare(a.date))
			.slice(0, 10),
		truncated: impact.truncated,
		limitations,
	};
}

/**
 * Where a node's code came from: the commits that changed its lines (`git log -L`), who last changed
 * each line (`git blame`), and the CODEOWNERS owners of its file, all at the snapshot commit and read
 * from the snapshot's mirror. Author names only; email addresses are not returned.
 */
export async function nodeHistory(
	deps: { db: Db; config: Config },
	workspaceId: string,
	nodeId: string,
	query: GraphHistoryQuery,
) {
	const { node, snapshot } = await loadNode(deps.db, workspaceId, nodeId);
	if (!node.path)
		throw new AppError(
			422,
			"history_unavailable",
			"This node has no file, so it has no line history",
		);
	const limitations: string[] = [];
	const dir = mirrorPath(deps.config, snapshot.id);
	const mirror = await stat(dir).catch(() => null);
	const ranged =
		node.startLine !== null && node.endLine !== null && node.startLine > 0;
	let commits: Array<{
		sha: string;
		date: string;
		author: string;
		subject: string;
	}> = [];
	let blame: ReturnType<typeof parseBlame> = [];
	if (!mirror)
		limitations.push(
			"The source mirror for this snapshot is gone; re-index the repository for history.",
		);
	else {
		const log = await git(
			dir,
			[
				"log",
				...(ranged
					? [`-L${node.startLine},${node.endLine}:${node.path}`, "-s"]
					: []),
				`--max-count=${query.limit}`,
				"--format=%x1e%H%x1f%aI%x1f%an%x1f%s",
				snapshot.commitSha,
				...(ranged ? [] : ["--", node.path]),
			],
			{ timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 },
		);
		if (log.ok)
			commits = log.stdout
				.split("\x1e")
				.map((record) => record.trim().split("\x1f"))
				.filter((parts) => /^[0-9a-f]{40}$/.test(parts[0] ?? ""))
				.map(([sha = "", date = "", author = "", subject = ""]) => ({
					sha,
					date,
					author,
					subject,
				}));
		else
			limitations.push(
				log.timedOut
					? "Line history timed out."
					: "Line history could not be read.",
			);
		if (ranged) {
			const result = await git(
				dir,
				[
					"blame",
					"--porcelain",
					`-L${node.startLine},${node.endLine}`,
					snapshot.commitSha,
					"--",
					node.path,
				],
				{ timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024 },
			);
			if (result.ok) blame = parseBlame(result.stdout);
			else
				limitations.push(
					result.timedOut ? "Blame timed out." : "Blame could not be read.",
				);
		}
	}
	const ownerEdges = await deps.db
		.select()
		.from(graphEdges)
		.where(
			and(
				eq(graphEdges.snapshotId, snapshot.id),
				eq(graphEdges.fromKey, `file:${node.path}`),
				eq(graphEdges.kind, "OWNED_BY"),
			),
		)
		.limit(20);
	limitations.push(
		"Blame names who last changed each line, which is not proof that they wrote or understand the behaviour; CODEOWNERS states declared responsibility.",
	);
	return {
		snapshot: toSnapshotView(snapshot),
		node: toNodeView(node),
		history: {
			method: ranged ? "git log -L" : "git log -- <path>",
			commits,
		},
		blame: {
			method: "git blame --porcelain",
			lines: blame.reduce((sum, entry) => sum + entry.lines, 0),
			commits: blame,
		},
		owners: ownerEdges.flatMap((edge) =>
			edge.toKey
				? [
						{
							owner: edge.toKey.replace(/^owner:/, ""),
							basis: "codeowners",
							pattern:
								(edge.provenance as { pattern?: string }).pattern ?? null,
						},
					]
				: [],
		),
		limitations,
	};
}

/**
 * Maps a stack trace (and optional logs) onto an indexed revision: the snapshot of the trace's own
 * commit when one is indexed, else the requested or newest usable one, saying which. Resolved frames
 * get their file, the innermost symbol at the line, numbered source lines, and that symbol's callers,
 * routes, and tests. Stateless. A mapped frame shows where an error surfaced, not why.
 */
export async function mapStackTrace(
	deps: { db: Db; config: Config },
	workspaceId: string,
	repositoryId: string,
	input: MapStackTraceRequest,
) {
	const snapshot = await snapshotFor(
		deps.db,
		workspaceId,
		repositoryId,
		input.snapshot_id,
		input.commit_sha,
	);
	const redact = { redactEmails: deps.config.inference.redactEmails };
	const trace = parseStackTrace(redactSecrets(input.trace, redact).text);
	const fileRows = await deps.db
		.select({
			path: graphNodes.path,
			parsed: sql<boolean>`coalesce((${graphNodes.attributes}->>'parsed')::boolean, false)`,
		})
		.from(graphNodes)
		.where(
			and(
				eq(graphNodes.snapshotId, snapshot.id),
				inArray(graphNodes.kind, ["file", "test_file"]),
			),
		);
	const files = fileRows.flatMap((row) => (row.path ? [row.path] : []));
	const parsed = new Set(
		fileRows.flatMap((row) => (row.path && row.parsed ? [row.path] : [])),
	);
	const symbols = new Map<string, NodeRow[]>();
	const loadSymbols = async (paths: Iterable<string>) => {
		const wanted = [...new Set(paths)].filter(
			(file) => parsed.has(file) && !symbols.has(file),
		);
		if (wanted.length === 0) return;
		for (const file of wanted) symbols.set(file, []);
		const rows = await deps.db
			.select()
			.from(graphNodes)
			.where(
				and(
					eq(graphNodes.snapshotId, snapshot.id),
					inArray(graphNodes.path, wanted),
					inArray(graphNodes.kind, [...SYMBOL_KINDS]),
				),
			);
		for (const row of rows) if (row.path) symbols.get(row.path)?.push(row);
	};
	// One query for the symbols of every file the frames name; source-mapped targets load on demand.
	const resolve = pathResolver(files);
	await loadSymbols(
		trace.frames.flatMap((frame) => {
			if (
				frame.classification === "runtime" ||
				frame.classification === "dependency"
			)
				return [];
			const candidate = frame.file ? normalizeFramePath(frame.file) : null;
			const found = candidate ? resolve(candidate) : null;
			return found?.status === "resolved" ? [found.file] : [];
		}),
	);
	const dir = mirrorPath(deps.config, snapshot.id);
	const mirror = (await stat(dir).catch(() => null)) !== null;
	const frames = await mapFrames(trace, {
		files,
		parsed: (file) => parsed.has(file),
		readText: async (file) =>
			mirror ? readBlob(dir, snapshot.commitSha, file, 5000) : null,
		symbolAt: async (file, line) => {
			await loadSymbols([file]);
			const best = innermost(symbols.get(file) ?? [], line, (row) => [
				row.startLine,
				row.endLine,
			]);
			return best
				? {
						key: best.key,
						node_id: best.id,
						name: best.name,
						kind: best.kind,
						start_line: best.startLine ?? line,
						end_line: best.endLine ?? line,
					}
				: null;
		},
	});
	// Who calls, routes to, or tests the code the trace passed through (resolved links only).
	const resolvedFile = (frame: MappedFrame) =>
		frame.resolution.status === "resolved" ? frame.resolution.file : null;
	const targets = [
		...new Set(
			frames.flatMap((frame) => {
				const file = resolvedFile(frame);
				if (!file) return [];
				return frame.symbol
					? [frame.symbol.key, `file:${file}`]
					: [`file:${file}`];
			}),
		),
	].slice(0, 60);
	const incoming =
		targets.length === 0
			? []
			: await deps.db
					.select()
					.from(graphEdges)
					.where(
						and(
							eq(graphEdges.snapshotId, snapshot.id),
							inArray(graphEdges.toKey, targets),
							inArray(graphEdges.kind, [
								"CALLS",
								"HANDLES_EVENT",
								"ROUTES_TO",
								"TESTS",
							]),
							inArray(graphEdges.certainty, ["exact", "resolved"]),
						),
					)
					.orderBy(asc(graphEdges.id))
					.limit(1000);
	const sources = await nodeIdsFor(
		deps.db,
		snapshot.id,
		incoming.map((edge) => edge.fromKey),
	);
	const related = (keys: string[], kinds: string[]) => {
		const found = new Map<
			string,
			{
				node_id: string;
				key: string;
				kind: string;
				name: string;
				path: string | null;
				line: number | null;
			}
		>();
		for (const edge of incoming) {
			if (found.size >= 5) break;
			if (
				!edge.toKey ||
				!keys.includes(edge.toKey) ||
				!kinds.includes(edge.kind)
			)
				continue;
			const row = sources.get(edge.fromKey);
			if (row && !found.has(row.key))
				found.set(row.key, {
					node_id: row.id,
					key: row.key,
					kind: row.kind,
					name: row.name,
					path: row.path,
					line: row.startLine,
				});
		}
		return [...found.values()];
	};
	const collectedAt = new Date().toISOString();
	const mapped = frames.map((frame) => {
		const file = resolvedFile(frame);
		const symbolKeys = frame.symbol ? [frame.symbol.key] : [];
		return {
			...frame,
			related: file
				? {
						callers: related(symbolKeys, ["CALLS", "HANDLES_EVENT"]),
						routes: related(symbolKeys, ["ROUTES_TO"]),
						tests: related([...symbolKeys, `file:${file}`], ["TESTS"]),
					}
				: null,
			evidence:
				file && frame.resolution.status === "resolved"
					? ({
							type: "code_excerpt",
							classification: "observed",
							handle: null,
							repository_id: snapshot.repositoryId,
							commit_sha: snapshot.commitSha,
							snapshot_id: snapshot.id,
							path: file,
							start_line: frame.excerpt?.start_line ?? frame.resolution.line,
							end_line: frame.excerpt?.end_line ?? frame.resolution.line,
							symbol: frame.symbol?.name ?? null,
							excerpt: frame.excerpt?.text ?? null,
							method:
								frame.resolution.method === "source_map"
									? "stack frame mapped through a committed source map"
									: `stack frame mapped by ${frame.resolution.method === "exact_path" ? "exact path" : "path suffix"}`,
							certainty:
								frame.resolution.method === "exact_path" ? "exact" : "resolved",
							collected_at: collectedAt,
							limitations: [
								"Shows where the error surfaced, not why.",
								...(frame.resolution.line_reliable
									? []
									: ["The frame's line does not exist at this revision."]),
								...(frame.symbol?.name_matches === false
									? [
											"The symbol at this line does not have the frame's function name; the code may have changed.",
										]
									: []),
							],
						} satisfies EvidenceRef)
					: null,
		};
	});
	const count = (status: MappedFrame["resolution"]["status"]) =>
		frames.filter((frame) => frame.resolution.status === status).length;
	const matches = input.commit_sha
		? snapshot.commitSha === input.commit_sha
		: null;
	const limitations = [...STACK_TRACE_LIMITATIONS];
	if (matches === false)
		limitations.push(
			`Commit ${input.commit_sha?.slice(0, 12)} is not indexed; frames were mapped to ${snapshot.commitSha.slice(0, 12)}, so lines may have moved.`,
		);
	if (!mirror)
		limitations.push(
			"The snapshot's source mirror is gone, so there are no excerpts; re-index the repository for them.",
		);
	if (snapshot.coverage?.complete !== true)
		limitations.push(
			"The snapshot's coverage is partial; some frames may fall in code that was not parsed.",
		);
	if (trace.truncated) limitations.push("Only the first 60 frames were read.");
	if (trace.frames.length === 0)
		limitations.push(
			"No stack frames were recognised (supported: V8 (Node, Chrome), Firefox/Safari, Python, Java).",
		);
	return {
		snapshot: toSnapshotView(snapshot),
		revision: {
			requested: input.commit_sha ?? null,
			used: snapshot.commitSha,
			matches,
		},
		format: trace.format,
		error: trace.error,
		frames: mapped,
		summary: {
			frames: frames.length,
			resolved: count("resolved"),
			ambiguous: count("ambiguous"),
			unresolved: count("unresolved"),
			external: count("external"),
			first_resolved_frame:
				frames.find((frame) => frame.resolution.status === "resolved")?.index ??
				null,
		},
		logs: input.logs ? correlateLogs(input.logs, frames, redact) : null,
		truncated: trace.truncated,
		limitations,
	};
}

/** Lines per commit from `git blame --porcelain` (details appear once per commit, lines repeat). */
export function parseBlame(output: string) {
	const commits = new Map<
		string,
		{
			sha: string;
			author: string;
			date: string;
			summary: string;
			lines: number;
		}
	>();
	let current: string | null = null;
	for (const line of output.split("\n")) {
		const header = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line);
		if (header) {
			current = header[1] ?? null;
			if (current && !commits.has(current))
				commits.set(current, {
					sha: current,
					author: "",
					date: "",
					summary: "",
					lines: 0,
				});
			continue;
		}
		const entry = current ? commits.get(current) : undefined;
		if (!entry) continue;
		if (line.startsWith("\t")) entry.lines += 1;
		else if (line.startsWith("author ")) entry.author = line.slice(7);
		else if (line.startsWith("author-time "))
			entry.date = new Date(Number(line.slice(12)) * 1000).toISOString();
		else if (line.startsWith("summary ")) entry.summary = line.slice(8);
	}
	return [...commits.values()].sort(
		(a, b) => b.lines - a.lines || b.date.localeCompare(a.date),
	);
}
