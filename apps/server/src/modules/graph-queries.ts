import { stat } from "node:fs/promises";
import type {
	EvidenceRef,
	GraphImpactQuery,
	GraphNeighborsQuery,
	GraphNodeSearchQuery,
	RepositorySearchQuery,
} from "@tracera/contracts";
import { and, asc, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { graphEdges, graphNodes, repositorySnapshots } from "../db/schema.ts";
import { git, resolveCommit } from "../lib/git.ts";
import { AppError } from "../lib/http.ts";
import { verifySourcePath } from "./context.ts";
import { type SnapshotRow, toSnapshotView } from "./graph.ts";
import { SYMBOL_KINDS } from "./graph-build.ts";
import { EXTRACTOR_VERSION } from "./graph-extract.ts";
import { getRepositoryRow } from "./repositories.ts";
import { mirrorPath, readBlob } from "./workspace.ts";

// Bounded, workspace-scoped reads over stored snapshots. Every traversal has a depth cap, a visited
// set (cycles), and an output limit; responses say when they were truncated.

type NodeRow = typeof graphNodes.$inferSelect;
type EdgeRow = typeof graphEdges.$inferSelect;

export { SYMBOL_KINDS };

const MAX_FRONTIER = 200;
const MAX_EXCERPT_LINES = 80;
const MAX_EXCERPT_CHARS = 8000;
/**
 * Edges along which a change propagates to dependents (walked in reverse for impact): code that calls,
 * references, imports, renders, implements, or extends; routes using a handler; clients of a route;
 * components binding a handler; code reading or writing a table or a configuration key; code
 * publishing or subscribing to a channel; tests.
 */
export const IMPACT_EDGES = [
	"CALLS",
	"REFERENCES",
	"IMPORTS",
	"RE_EXPORTS",
	"RENDERS",
	"IMPLEMENTS",
	"EXTENDS",
	"ROUTES_TO",
	"SENDS_REQUEST_TO",
	"HANDLES_EVENT",
	"READS_FROM",
	"WRITES_TO",
	"CONFIGURED_BY",
	"PUBLISHES",
	"SUBSCRIBES_TO",
	"TESTS",
];

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function toNodeView(row: NodeRow) {
	return {
		id: row.id,
		key: row.key,
		kind: row.kind,
		name: row.name,
		path: row.path,
		start_line: row.startLine,
		end_line: row.endLine,
		language: row.language,
		attributes: row.attributes,
		provenance: row.provenance,
	};
}

export function toEdgeView(row: EdgeRow, ids: ReadonlyMap<string, string>) {
	return {
		id: row.id,
		snapshot_id: row.snapshotId,
		kind: row.kind,
		from_key: row.fromKey,
		from_node_id: ids.get(row.fromKey) ?? null,
		to_key: row.toKey,
		to_node_id: row.toKey ? (ids.get(row.toKey) ?? null) : null,
		target_text: row.targetText,
		certainty: row.certainty,
		provenance: row.provenance,
	};
}

const usable = inArray(repositorySnapshots.status, ["ready", "partial"]);

/**
 * The requested snapshot, or the newest usable one (preferring one of `preferCommit` when given).
 * Foreign repositories and snapshots are 404s.
 */
export async function snapshotFor(
	db: Db,
	workspaceId: string,
	repositoryId: string,
	snapshotId?: string,
	preferCommit?: string,
): Promise<SnapshotRow> {
	await getRepositoryRow(db, workspaceId, repositoryId);
	const [row] = await db
		.select()
		.from(repositorySnapshots)
		.where(
			and(
				eq(repositorySnapshots.workspaceId, workspaceId),
				eq(repositorySnapshots.repositoryId, repositoryId),
				snapshotId ? eq(repositorySnapshots.id, snapshotId) : usable,
			),
		)
		.orderBy(
			...(preferCommit && !snapshotId
				? [desc(sql`${repositorySnapshots.commitSha} = ${preferCommit}`)]
				: []),
			desc(repositorySnapshots.createdAt),
		)
		.limit(1);
	if (!row && snapshotId)
		throw new AppError(
			404,
			"not_found",
			`Snapshot ${snapshotId} was not found`,
		);
	if (!row)
		throw new AppError(
			409,
			"graph_not_indexed",
			"This repository has no completed graph snapshot yet; request indexing first",
		);
	if (row.status !== "ready" && row.status !== "partial")
		throw new AppError(
			409,
			"snapshot_not_ready",
			`Snapshot ${row.id} is ${row.status}`,
		);
	return row;
}

export async function nodeIdsFor(
	db: Db,
	snapshotId: string,
	keys: Iterable<string>,
): Promise<Map<string, NodeRow>> {
	const unique = [...new Set(keys)];
	const found = new Map<string, NodeRow>();
	for (let i = 0; i < unique.length; i += 1000) {
		const rows = await db
			.select()
			.from(graphNodes)
			.where(
				and(
					eq(graphNodes.snapshotId, snapshotId),
					inArray(graphNodes.key, unique.slice(i, i + 1000)),
				),
			);
		for (const row of rows) found.set(row.key, row);
	}
	return found;
}

export async function loadNode(db: Db, workspaceId: string, nodeId: string) {
	const [node] = await db
		.select()
		.from(graphNodes)
		.where(
			and(eq(graphNodes.id, nodeId), eq(graphNodes.workspaceId, workspaceId)),
		)
		.limit(1);
	if (!node)
		throw new AppError(404, "not_found", `Graph node ${nodeId} was not found`);
	const [snapshot] = await db
		.select()
		.from(repositorySnapshots)
		.where(eq(repositorySnapshots.id, node.snapshotId))
		.limit(1);
	if (!snapshot)
		throw new AppError(404, "not_found", `Graph node ${nodeId} was not found`);
	return { node, snapshot };
}

/** Source lines for evidence, read from the snapshot's own mirror (never the registered repository). */
export async function readSnapshotExcerpt(
	config: Pick<Config, "dataDir">,
	snapshot: SnapshotRow,
	filePath: string,
	startLine: number,
	endLine: number,
): Promise<{
	excerpt: string | null;
	start_line: number;
	end_line: number;
	line_count: number;
	limitation: string | null;
}> {
	const none = (limitation: string) => ({
		excerpt: null,
		start_line: startLine,
		end_line: endLine,
		line_count: 0,
		limitation,
	});
	const dir = mirrorPath(config, snapshot.id);
	if (!(await stat(dir).catch(() => null)))
		return none("The source mirror for this snapshot is no longer available");
	const text = await readBlob(dir, snapshot.commitSha, filePath, 5000);
	if (text === null)
		return none("The file could not be read from the snapshot");
	const lines = text.split("\n");
	const from = Math.max(1, startLine);
	const to = Math.min(lines.length, endLine, from + MAX_EXCERPT_LINES - 1);
	return {
		excerpt: lines
			.slice(from - 1, to)
			.join("\n")
			.slice(0, MAX_EXCERPT_CHARS),
		start_line: from,
		end_line: to,
		line_count: lines.length,
		limitation: to < endLine ? `Excerpt clipped to lines ${from}-${to}` : null,
	};
}

export function nodeEvidence(
	node: NodeRow,
	snapshot: SnapshotRow,
	excerpt: string | null,
	limitations: string[],
): EvidenceRef {
	return {
		type: "graph_node",
		classification: "observed",
		handle: null,
		repository_id: snapshot.repositoryId,
		commit_sha: snapshot.commitSha,
		snapshot_id: snapshot.id,
		path: node.path,
		start_line: node.startLine,
		end_line: node.endLine,
		symbol: (SYMBOL_KINDS as readonly string[]).includes(node.kind)
			? node.name
			: null,
		excerpt,
		method: String(node.provenance.method ?? "graph_index"),
		certainty: "exact",
		collected_at: (snapshot.finishedAt ?? snapshot.createdAt).toISOString(),
		limitations,
	};
}

export async function listSnapshots(
	db: Db,
	workspaceId: string,
	repositoryId: string,
) {
	await getRepositoryRow(db, workspaceId, repositoryId);
	const rows = await db
		.select()
		.from(repositorySnapshots)
		.where(
			and(
				eq(repositorySnapshots.workspaceId, workspaceId),
				eq(repositorySnapshots.repositoryId, repositoryId),
			),
		)
		.orderBy(desc(repositorySnapshots.createdAt))
		.limit(20);
	return { snapshots: rows.map(toSnapshotView) };
}

/** Whether the snapshot still describes the ref it indexed (cheap rev-parse; no tree scan). */
export async function snapshotFreshness(
	config: Pick<Config, "dataDir" | "repoRoots" | "sourceRoot">,
	repo: { sourceType: string; sourceRef: string },
	snapshot: SnapshotRow,
) {
	const reasons: string[] = [];
	if (snapshot.extractorVersion !== EXTRACTOR_VERSION)
		reasons.push("extractor_outdated");
	const source = await verifySourcePath(config, repo).catch(() => null);
	const current = source ? await resolveCommit(source, snapshot.ref) : null;
	if (current === null) reasons.push("source_unavailable");
	else if (current !== snapshot.commitSha) reasons.push("ref_moved");
	return {
		stale:
			reasons.includes("ref_moved") || reasons.includes("extractor_outdated")
				? true
				: current === null
					? null
					: false,
		ref: snapshot.ref,
		indexed_commit: snapshot.commitSha,
		current_commit: current,
		reasons,
		checked_at: new Date().toISOString(),
	};
}

export async function getRepositoryProfile(
	deps: { db: Db; config: Config },
	workspaceId: string,
	repositoryId: string,
) {
	const repo = await getRepositoryRow(deps.db, workspaceId, repositoryId);
	const snapshot = await snapshotFor(deps.db, workspaceId, repositoryId);
	const [latest] = await deps.db
		.select()
		.from(repositorySnapshots)
		.where(eq(repositorySnapshots.repositoryId, repositoryId))
		.orderBy(desc(repositorySnapshots.createdAt))
		.limit(1);
	return {
		snapshot: toSnapshotView(snapshot),
		profile: snapshot.profile,
		coverage: snapshot.coverage,
		freshness: await snapshotFreshness(deps.config, repo, snapshot),
		latest_snapshot:
			latest && latest.id !== snapshot.id ? toSnapshotView(latest) : null,
	};
}

export async function searchGraphNodes(
	db: Db,
	workspaceId: string,
	repositoryId: string,
	query: GraphNodeSearchQuery,
) {
	const snapshot = await snapshotFor(
		db,
		workspaceId,
		repositoryId,
		query.snapshot_id,
	);
	const rows = await db
		.select()
		.from(graphNodes)
		.where(
			and(
				eq(graphNodes.snapshotId, snapshot.id),
				query.kind ? eq(graphNodes.kind, query.kind) : undefined,
				query.path
					? like(graphNodes.path, `${escapeLike(query.path)}%`)
					: undefined,
				query.key ? eq(graphNodes.key, query.key) : undefined,
				query.q
					? ilike(graphNodes.name, `%${escapeLike(query.q)}%`)
					: undefined,
			),
		)
		.orderBy(
			sql`case when lower(${graphNodes.name}) = lower(${query.q ?? ""}) then 0 else 1 end`,
			asc(graphNodes.path),
			asc(graphNodes.startLine),
		)
		.limit(query.limit + 1);
	return {
		snapshot: toSnapshotView(snapshot),
		nodes: rows.slice(0, query.limit).map(toNodeView),
		truncated: rows.length > query.limit,
	};
}

export async function getGraphNode(
	deps: { db: Db; config: Config },
	workspaceId: string,
	nodeId: string,
) {
	const { node, snapshot } = await loadNode(deps.db, workspaceId, nodeId);
	const [outgoing, incoming] = await Promise.all(
		(["fromKey", "toKey"] as const).map((column) =>
			deps.db
				.select()
				.from(graphEdges)
				.where(
					and(
						eq(graphEdges.snapshotId, snapshot.id),
						eq(graphEdges[column], node.key),
					),
				)
				.orderBy(asc(graphEdges.kind), asc(graphEdges.id))
				.limit(101),
		),
	);
	const out = outgoing ?? [];
	const inc = incoming ?? [];
	const others = await nodeIdsFor(deps.db, snapshot.id, [
		...out.flatMap((edge) => (edge.toKey ? [edge.toKey] : [])),
		...inc.map((edge) => edge.fromKey),
	]);
	const ids = new Map([...others].map(([key, row]) => [key, row.id]));
	ids.set(node.key, node.id);
	const limitations: string[] = [];
	let excerpt: string | null = null;
	if (node.path && node.startLine && node.endLine) {
		const read = await readSnapshotExcerpt(
			deps.config,
			snapshot,
			node.path,
			node.startLine,
			node.endLine,
		);
		excerpt = read.excerpt;
		if (read.limitation) limitations.push(read.limitation);
	}
	return {
		snapshot: toSnapshotView(snapshot),
		node: toNodeView(node),
		evidence: nodeEvidence(node, snapshot, excerpt, limitations),
		outgoing: out.slice(0, 100).map((edge) => toEdgeView(edge, ids)),
		incoming: inc.slice(0, 100).map((edge) => toEdgeView(edge, ids)),
		truncated: { outgoing: out.length > 100, incoming: inc.length > 100 },
	};
}

/**
 * One edge with the evidence behind it: both endpoints and the source lines at the location the
 * extractor recorded, read from the snapshot's mirror. Heuristic edges are labelled inferred.
 */
export async function getGraphEdge(
	deps: { db: Db; config: Config },
	workspaceId: string,
	snapshotId: string,
	edgeId: number,
) {
	const [snapshot] = await deps.db
		.select()
		.from(repositorySnapshots)
		.where(
			and(
				eq(repositorySnapshots.id, snapshotId),
				eq(repositorySnapshots.workspaceId, workspaceId),
			),
		)
		.limit(1);
	const [edge] = snapshot
		? await deps.db
				.select()
				.from(graphEdges)
				.where(
					and(
						eq(graphEdges.id, edgeId),
						eq(graphEdges.snapshotId, snapshot.id),
					),
				)
				.limit(1)
		: [];
	if (!snapshot || !edge)
		throw new AppError(404, "not_found", `Graph edge ${edgeId} was not found`);
	const nodes = await nodeIdsFor(deps.db, snapshot.id, [
		edge.fromKey,
		...(edge.toKey ? [edge.toKey] : []),
	]);
	const ids = new Map([...nodes].map(([key, row]) => [key, row.id]));
	const at = edge.provenance as { path?: unknown; start_line?: unknown };
	const file = typeof at.path === "string" ? at.path : null;
	const line =
		typeof at.start_line === "number" && at.start_line > 0
			? at.start_line
			: null;
	const limitations: string[] = [];
	let excerpt: Awaited<ReturnType<typeof readSnapshotExcerpt>> | null = null;
	if (file && line) {
		excerpt = await readSnapshotExcerpt(
			deps.config,
			snapshot,
			file,
			Math.max(1, line - 2),
			line + 2,
		);
		if (excerpt.limitation) limitations.push(excerpt.limitation);
	} else
		limitations.push(
			"This relationship has no single source line (it comes from git metadata, a manifest, or a file convention).",
		);
	if (edge.certainty === "heuristic")
		limitations.push(
			"Heuristic: inferred from naming or text, not from a resolved binding.",
		);
	if (edge.toKey === null)
		limitations.push(
			"Unresolved: the target could not be found in this repository.",
		);
	const fromNode = nodes.get(edge.fromKey);
	const toNode = edge.toKey ? nodes.get(edge.toKey) : undefined;
	return {
		snapshot: toSnapshotView(snapshot),
		edge: toEdgeView(edge, ids),
		from: fromNode ? toNodeView(fromNode) : null,
		to: toNode ? toNodeView(toNode) : null,
		evidence: {
			type: "graph_edge",
			classification:
				edge.certainty === "heuristic" || edge.certainty === "unresolved"
					? "inferred"
					: "observed",
			handle: null,
			repository_id: snapshot.repositoryId,
			commit_sha: snapshot.commitSha,
			snapshot_id: snapshot.id,
			path: file,
			start_line: excerpt?.start_line ?? line,
			end_line: excerpt?.end_line ?? line,
			symbol: null,
			excerpt: excerpt?.excerpt ?? null,
			method: String(edge.provenance.method ?? "graph_index"),
			certainty: edge.certainty,
			collected_at: (snapshot.finishedAt ?? snapshot.createdAt).toISOString(),
			limitations,
		} satisfies EvidenceRef,
	};
}

/** Breadth-first neighbourhood with a visited set; depth ≤ 3 and at most `limit` edges. */
export async function graphNeighbors(
	db: Db,
	workspaceId: string,
	nodeId: string,
	query: GraphNeighborsQuery,
) {
	const { node, snapshot } = await loadNode(db, workspaceId, nodeId);
	const visited = new Set([node.key]);
	const edges: EdgeRow[] = [];
	const seenEdges = new Set<number>();
	let frontier = [node.key];
	let truncated = false;
	for (let depth = 1; depth <= query.depth && frontier.length > 0; depth++) {
		const ends = [];
		if (query.direction !== "in")
			ends.push(inArray(graphEdges.fromKey, frontier));
		if (query.direction !== "out")
			ends.push(inArray(graphEdges.toKey, frontier));
		const room = query.limit - edges.length;
		const rows = await db
			.select()
			.from(graphEdges)
			.where(
				and(
					eq(graphEdges.snapshotId, snapshot.id),
					or(...ends),
					query.edge ? eq(graphEdges.kind, query.edge) : undefined,
				),
			)
			.orderBy(asc(graphEdges.id))
			.limit(room + 1);
		if (rows.length > room) truncated = true;
		const current = new Set(frontier);
		const next: string[] = [];
		for (const edge of rows.slice(0, room)) {
			if (seenEdges.has(edge.id)) continue;
			seenEdges.add(edge.id);
			edges.push(edge);
			const other = current.has(edge.fromKey) ? edge.toKey : edge.fromKey;
			if (other && !visited.has(other)) {
				visited.add(other);
				next.push(other);
			}
		}
		if (next.length > MAX_FRONTIER) truncated = true;
		frontier = next.slice(0, MAX_FRONTIER);
		if (edges.length >= query.limit) break;
	}
	const nodes = await nodeIdsFor(db, snapshot.id, visited);
	const ids = new Map([...nodes].map(([key, row]) => [key, row.id]));
	return {
		snapshot: toSnapshotView(snapshot),
		node: toNodeView(node),
		nodes: [...nodes.values()].map(toNodeView),
		edges: edges.map((edge) => toEdgeView(edge, ids)),
		truncated,
	};
}

/**
 * Graph-supported impact: dependents reached by walking dependency edges backwards from the node
 * (and, for a file, from the symbols it defines). Heuristic edges are not followed.
 */
export async function graphImpact(
	db: Db,
	workspaceId: string,
	nodeId: string,
	query: GraphImpactQuery,
) {
	const { node, snapshot } = await loadNode(db, workspaceId, nodeId);
	const { origins: _origins, ...result } = await impactFrom(
		db,
		snapshot,
		[node.key],
		query,
	);
	return { node: toNodeView(node), ...result };
}

export async function impactFrom(
	db: Db,
	snapshot: SnapshotRow,
	startKeys: string[],
	query: GraphImpactQuery,
) {
	const starts = new Set(startKeys);
	// A file's change reaches the dependents of what it defines (symbols, routes, tables); a class's or
	// component's change reaches the dependents of its methods and nested handlers.
	const containers = startKeys.filter(
		(key) => key.startsWith("file:") || key.startsWith("sym:"),
	);
	const defined =
		containers.length === 0
			? []
			: await db
					.select({ fromKey: graphEdges.fromKey, toKey: graphEdges.toKey })
					.from(graphEdges)
					.where(
						and(
							eq(graphEdges.snapshotId, snapshot.id),
							inArray(graphEdges.kind, ["DEFINES", "CONTAINS"]),
							inArray(graphEdges.fromKey, containers),
						),
					)
					.limit(MAX_FRONTIER);
	/** Expanded start → the requested start it belongs to (a file's symbol → the file). */
	const origins = new Map(startKeys.map((key) => [key, key]));
	for (const row of defined)
		if (
			row.toKey &&
			/^(sym|route|table):/.test(row.toKey) &&
			!starts.has(row.toKey)
		) {
			starts.add(row.toKey);
			origins.set(row.toKey, origins.get(row.fromKey) ?? row.fromKey);
		}
	const reached = new Map<
		string,
		{ distance: number; via: string; from: string; certainty: string }
	>();
	let frontier = [...starts];
	let truncated = false;
	for (let depth = 1; depth <= query.depth && frontier.length > 0; depth++) {
		const rows = await db
			.select()
			.from(graphEdges)
			.where(
				and(
					eq(graphEdges.snapshotId, snapshot.id),
					inArray(graphEdges.toKey, frontier),
					inArray(graphEdges.kind, IMPACT_EDGES),
					inArray(graphEdges.certainty, ["exact", "resolved"]),
				),
			)
			.orderBy(asc(graphEdges.id))
			.limit(query.limit * 2);
		if (rows.length >= query.limit * 2) truncated = true;
		const next: string[] = [];
		for (const edge of rows) {
			if (starts.has(edge.fromKey) || reached.has(edge.fromKey)) continue;
			if (reached.size >= query.limit) {
				truncated = true;
				break;
			}
			reached.set(edge.fromKey, {
				distance: depth,
				via: edge.kind,
				from: edge.toKey ?? "",
				certainty: edge.certainty,
			});
			next.push(edge.fromKey);
		}
		if (next.length > MAX_FRONTIER) truncated = true;
		frontier = next.slice(0, MAX_FRONTIER);
	}
	const nodes = await nodeIdsFor(db, snapshot.id, reached.keys());
	const affected = [...reached.entries()].flatMap(([key, hop]) => {
		const row = nodes.get(key);
		return row ? [{ node: toNodeView(row), ...hop }] : [];
	});
	const coverage = snapshot.coverage ?? {};
	const limitations = [
		"Graph-supported impact only: dependents reached through parsed imports, calls, references, renders, implementations, and test links. Dynamic dispatch, reflection, configuration, and runtime wiring are not modelled.",
	];
	if (coverage.complete !== true)
		limitations.push(
			"The snapshot's coverage is partial (parse failures, unsupported languages, or limits); dependents may be missing.",
		);
	const unresolved = coverage.unresolved as
		| { imports?: number; calls?: number }
		| undefined;
	if ((unresolved?.imports ?? 0) > 0 || (unresolved?.calls ?? 0) > 0)
		limitations.push(
			`${unresolved?.imports ?? 0} unresolved import(s) and ${unresolved?.calls ?? 0} unresolved call(s) in this snapshot are not followed.`,
		);
	if (truncated)
		limitations.push("The walk stopped at its depth or output limit.");
	return {
		snapshot: toSnapshotView(snapshot),
		start_keys: [...starts],
		origins,
		affected,
		files: [
			...new Set(
				affected.flatMap(({ node }) => (node.path ? [node.path] : [])),
			),
		].sort(),
		tests: affected.filter(
			({ node }) => node.kind === "test_case" || node.kind === "test_file",
		),
		truncated,
		limitations,
	};
}

/**
 * Fixed-string, case-insensitive `git grep` at the snapshot commit in its mirror, limited to files
 * the index read (ignored, sensitive, large, linked, and binary files stay out).
 */
export async function grepSnapshot(
	deps: { db: Db; config: Pick<Config, "dataDir"> },
	snapshot: SnapshotRow,
	term: string,
	timeoutMs = 10_000,
): Promise<{
	hits: Array<{ path: string; line: number; text: string }>;
	limitations: string[];
}> {
	const dir = mirrorPath(deps.config, snapshot.id);
	if (!(await stat(dir).catch(() => null)))
		throw new AppError(
			409,
			"snapshot_source_unavailable",
			"The source mirror for this snapshot is gone; re-index the repository",
		);
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
			term,
			snapshot.commitSha,
		],
		{ timeoutMs, maxBytes: 4 * 1024 * 1024 },
	);
	const limitations: string[] = [];
	if (result.timedOut)
		limitations.push("The search timed out; results are partial.");
	else if (!result.ok && result.code !== 1)
		limitations.push(
			"The search output exceeded its size limit; results are partial.",
		);
	const raw: Array<{ path: string; line: number; text: string }> = [];
	for (const record of result.stdout.split("\n")) {
		const [location, line, ...rest] = record.split("\0");
		if (!location?.startsWith(`${snapshot.commitSha}:`) || !line) continue;
		raw.push({
			path: location.slice(snapshot.commitSha.length + 1),
			line: Number(line),
			text: rest.join("\0"),
		});
		if (raw.length > 2000) break;
	}
	const paths = [...new Set(raw.map((entry) => entry.path))].slice(0, 1000);
	const indexed =
		paths.length === 0
			? []
			: await deps.db
					.select({ path: graphNodes.path })
					.from(graphNodes)
					.where(
						and(
							eq(graphNodes.snapshotId, snapshot.id),
							inArray(graphNodes.kind, ["file", "test_file"]),
							inArray(graphNodes.path, paths),
						),
					);
	const allowed = new Set(indexed.map((row) => row.path));
	return { hits: raw.filter((entry) => allowed.has(entry.path)), limitations };
}

/**
 * Bounded search over one snapshot. `symbol` searches graph nodes; `text` uses `grepSnapshot`.
 */
export async function searchRepository(
	deps: { db: Db; config: Config },
	workspaceId: string,
	repositoryId: string,
	query: RepositorySearchQuery,
) {
	const snapshot = await snapshotFor(
		deps.db,
		workspaceId,
		repositoryId,
		query.snapshot_id,
	);
	const collected = (snapshot.finishedAt ?? snapshot.createdAt).toISOString();
	const hit = (
		value: Pick<
			EvidenceRef,
			"path" | "start_line" | "end_line" | "symbol" | "excerpt" | "method"
		>,
	): EvidenceRef => ({
		type: "search_hit",
		classification: "observed",
		handle: null,
		repository_id: repositoryId,
		commit_sha: snapshot.commitSha,
		snapshot_id: snapshot.id,
		certainty: "exact",
		collected_at: collected,
		limitations: [],
		...value,
	});
	if (query.mode === "all") return searchAll(deps, snapshot, query, hit);
	if (query.mode === "symbol") {
		const rows = await deps.db
			.select()
			.from(graphNodes)
			.where(
				and(
					eq(graphNodes.snapshotId, snapshot.id),
					inArray(graphNodes.kind, [...SYMBOL_KINDS, "test_case"]),
					ilike(graphNodes.name, `%${escapeLike(query.q)}%`),
				),
			)
			.orderBy(
				sql`case when lower(${graphNodes.name}) = lower(${query.q}) then 0 else 1 end`,
				asc(graphNodes.path),
			)
			.limit(query.limit + 1);
		return {
			snapshot: toSnapshotView(snapshot),
			mode: query.mode,
			hits: rows.slice(0, query.limit).map((row) =>
				hit({
					path: row.path,
					start_line: row.startLine,
					end_line: row.endLine,
					symbol: row.name,
					excerpt: null,
					method: "graph_symbol_lookup",
				}),
			),
			truncated: rows.length > query.limit,
			limitations: [] as string[],
		};
	}
	const { hits, limitations } = await grepSnapshot(deps, snapshot, query.q);
	return {
		snapshot: toSnapshotView(snapshot),
		mode: query.mode,
		hits: hits.slice(0, query.limit).map((entry) =>
			hit({
				path: entry.path,
				start_line: entry.line,
				end_line: entry.line,
				symbol: null,
				excerpt: entry.text.slice(0, 300),
				method: "git_grep_fixed_string",
			}),
		),
		truncated: hits.length > query.limit || limitations.length > 0,
		limitations,
	};
}

/** Entities the unified search finds by name. */
const NAMED_KINDS = [
	...SYMBOL_KINDS,
	"route",
	"page",
	"db_table",
	"config_key",
	"external_service",
	"event",
	"queue",
	"test_case",
	"doc_section",
];
type SearchReason =
	| "exact_name"
	| "name_prefix"
	| "path"
	| "name_contains"
	| "text";

/**
 * Unified search: named entities and file paths ranked exact name > name prefix > path > substring
 * (one query), then fixed-string text hits from the snapshot. Every result says why it matched and
 * cites a location. Lexical and structural only: semantic search needs an embedding provider.
 */
async function searchAll(
	deps: { db: Db; config: Config },
	snapshot: SnapshotRow,
	query: RepositorySearchQuery,
	hit: (
		value: Pick<
			EvidenceRef,
			"path" | "start_line" | "end_line" | "symbol" | "excerpt" | "method"
		>,
	) => EvidenceRef,
) {
	const lower = query.q.toLowerCase();
	const pattern = `%${escapeLike(query.q)}%`;
	const prefix = `${escapeLike(lower)}%`;
	const rows = await deps.db
		.select()
		.from(graphNodes)
		.where(
			and(
				eq(graphNodes.snapshotId, snapshot.id),
				or(
					and(
						inArray(graphNodes.kind, NAMED_KINDS),
						ilike(graphNodes.name, pattern),
					),
					and(
						inArray(graphNodes.kind, ["file", "test_file"]),
						ilike(graphNodes.path, pattern),
					),
				),
			),
		)
		.orderBy(
			sql`case when lower(${graphNodes.name}) = ${lower} then 0
				when lower(${graphNodes.name}) like ${prefix} then 1
				when ${graphNodes.kind} in ('file', 'test_file') then 2 else 3 end`,
			asc(graphNodes.path),
			asc(graphNodes.startLine),
		)
		.limit(query.limit + 1);
	const reason = (row: NodeRow): SearchReason => {
		const name = row.name.toLowerCase();
		if (name === lower) return "exact_name";
		if (name.startsWith(lower)) return "name_prefix";
		if (row.kind === "file" || row.kind === "test_file") return "path";
		return "name_contains";
	};
	const results: Array<{
		match: { kind: string; reason: SearchReason };
		node: ReturnType<typeof toNodeView> | null;
		evidence: EvidenceRef;
	}> = rows.slice(0, query.limit).map((row) => ({
		match: { kind: row.kind, reason: reason(row) },
		node: toNodeView(row),
		evidence: hit({
			path: row.path,
			start_line: row.startLine,
			end_line: row.endLine,
			symbol: (SYMBOL_KINDS as readonly string[]).includes(row.kind)
				? row.name
				: null,
			excerpt: null,
			method: "graph_name_lookup",
		}),
	}));
	const room = query.limit - results.length;
	const text =
		room > 0 ? await grepSnapshot(deps, snapshot, query.q, 5000) : null;
	for (const entry of (text?.hits ?? []).slice(0, room))
		results.push({
			match: { kind: "text", reason: "text" },
			node: null,
			evidence: hit({
				path: entry.path,
				start_line: entry.line,
				end_line: entry.line,
				symbol: null,
				excerpt: entry.text.slice(0, 300),
				method: "git_grep_fixed_string",
			}),
		});
	const limitations = [...(text?.limitations ?? [])];
	return {
		snapshot: toSnapshotView(snapshot),
		mode: query.mode,
		results,
		hits: results.map((result) => result.evidence),
		truncated:
			rows.length > query.limit ||
			(text?.hits.length ?? 0) > room ||
			limitations.length > 0,
		limitations,
		semantic: {
			available: false,
			reason:
				"No embedding provider is configured, so results are lexical and structural; nothing is ranked by meaning.",
		},
	};
}
