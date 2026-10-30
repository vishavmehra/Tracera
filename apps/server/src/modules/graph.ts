import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { IndexRepositoryRequest } from "@tracera/contracts";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, withTransaction } from "../db/client.ts";
import {
	graphEdges,
	graphFileCache,
	graphNodes,
	type IndexProgress,
	repositories,
	repositorySnapshots,
} from "../db/schema.ts";
import { git, readBlobs, resolveCommit } from "../lib/git.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { enqueueIndex } from "../queue.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import {
	ContextError,
	parseLog,
	skipReason,
	verifySourcePath,
} from "./context.ts";
import {
	buildGraph,
	type DocSection,
	docSections,
	type Manifest,
	packageExports,
} from "./graph-build.ts";
import {
	EXTRACTOR_VERSION,
	extractFile,
	type FileExtraction,
	languageOf,
	PARSED_LANGUAGES,
} from "./graph-extract.ts";
import { getRepositoryRow } from "./repositories.ts";
import {
	cloneAtCommit,
	listTree,
	mirrorPath,
	type TreeEntry,
} from "./workspace.ts";

// Repository Knowledge Graph indexing. Runs in the worker against a
// Tracera-owned bare clone; the registered repository is only read by `git clone`.

const MAX_PARSE_FILES = 5000;
const MAX_PARSE_BYTES = 48 * 1024 * 1024;
const MAX_MANIFESTS = 50;
const MAX_DOC_FILES = 200;
const MAX_DOC_SECTIONS = 2000;
const MAX_COMMITS = 200;
const KEEP_SNAPSHOTS = 3;
const INDEX_TIMEOUT_MS = 10 * 60_000;
const BLOB_BATCH = 400;
const CODEOWNERS_PATHS = [
	".github/CODEOWNERS",
	"CODEOWNERS",
	"docs/CODEOWNERS",
];

const chunks = <T>(items: readonly T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size));
	return out;
};

export type CommitAnalysis = ReturnType<typeof buildGraph> & {
	stats: { files_parsed: number; files_reused: number; duration_ms: number };
};

function parseManifest(
	file: string,
	text: string | undefined,
): Manifest | null {
	try {
		const json = JSON.parse(text ?? "") as Record<string, unknown>;
		const strings = (value: unknown): Record<string, string> =>
			value && typeof value === "object" && !Array.isArray(value)
				? Object.fromEntries(
						Object.entries(value)
							.filter(
								(entry): entry is [string, string] =>
									typeof entry[1] === "string",
							)
							.slice(0, 500),
					)
				: {};
		return {
			path: file,
			name: typeof json.name === "string" ? json.name.slice(0, 214) : null,
			scripts: strings(json.scripts),
			dependencies: strings(json.dependencies),
			devDependencies: strings(json.devDependencies),
			main: typeof json.main === "string" ? json.main : null,
			exports: packageExports(json.exports),
			bin:
				typeof json.bin === "string"
					? [json.bin]
					: Object.values(strings(json.bin)),
			type: typeof json.type === "string" ? json.type : null,
			// npm/yarn `workspaces`: an array of globs, or { packages: [...] }.
			workspaces: (Array.isArray(json.workspaces)
				? json.workspaces
				: Array.isArray((json.workspaces as { packages?: unknown })?.packages)
					? (json.workspaces as { packages: unknown[] }).packages
					: []
			)
				.filter((entry): entry is string => typeof entry === "string")
				.slice(0, 50),
		};
	} catch {
		return null;
	}
}

/**
 * Static analysis of one commit in a Tracera-owned clone: git plumbing plus @babel/parser; nothing
 * from the repository runs. Extractions are cached per (path, blob), so a new commit re-parses only
 * changed files. Linking is recomputed for the whole commit, so edges into removed or changed
 * definitions cannot survive into the new snapshot.
 */
export async function analyzeCommit(
	/** Without a database there is no extraction cache: every parseable file is parsed. */
	deps: { db?: Db },
	input: {
		repositoryId: string;
		repositoryName: string;
		dir: string;
		/** A commit, or a tree (a patch applied to a commit's index); trees have no history. */
		commitSha: string;
		deadline: number;
		signal?: AbortSignal;
		/** Skip `git log` (history edges): for revisions analysed only to compare code. */
		skipHistory?: boolean;
		onProgress?: (
			phase: IndexProgress["phase"],
			done: number,
			total: number,
		) => void;
	},
): Promise<CommitAnalysis> {
	const started = Date.now();
	const progress = input.onProgress ?? (() => undefined);
	const check = () => {
		if (input.signal?.aborted)
			throw new ContextError("cancelled", "Indexing was cancelled");
		if (Date.now() > input.deadline)
			throw new ContextError(
				"index_timeout",
				"Indexing exceeded its time budget",
				true,
			);
	};
	const budget = (cap: number) =>
		Math.max(1000, Math.min(cap, input.deadline - Date.now()));
	const notes: string[] = [];

	progress("listing", 0, 0);
	const tree = await listTree(input.dir, input.commitSha, budget(30_000));
	if (!tree)
		throw new ContextError(
			"repository_unreadable",
			"git could not list the repository tree",
		);
	if (tree.timedOut)
		throw new ContextError(
			"index_timeout",
			"Listing the repository tree timed out",
			true,
		);
	check();
	const skipped: Record<string, string[]> = {};
	const readable: TreeEntry[] = [];
	for (const entry of tree.entries) {
		const reason = skipReason(entry);
		if (reason) {
			const list = skipped[reason] ?? [];
			list.push(entry.path);
			skipped[reason] = list;
		} else if (entry.type === "blob") readable.push(entry);
	}

	const truncatedFiles: string[] = [];
	const toParse: TreeEntry[] = [];
	let parseBytes = 0;
	for (const entry of readable) {
		if (!PARSED_LANGUAGES.has(languageOf(entry.path))) continue;
		if (
			toParse.length >= MAX_PARSE_FILES ||
			parseBytes + (entry.size ?? 0) > MAX_PARSE_BYTES
		) {
			truncatedFiles.push(entry.path);
			continue;
		}
		toParse.push(entry);
		parseBytes += entry.size ?? 0;
	}

	const extractions = new Map<string, FileExtraction>();
	const cache = deps.db;
	for (const chunk of chunks(toParse, 1000)) {
		if (!cache) break;
		const wanted = new Set(
			chunk.map((entry) => `${entry.path}\0${entry.object}`),
		);
		const rows = await cache
			.select({
				path: graphFileCache.path,
				objectId: graphFileCache.objectId,
				extraction: graphFileCache.extraction,
			})
			.from(graphFileCache)
			.where(
				and(
					eq(graphFileCache.repositoryId, input.repositoryId),
					eq(graphFileCache.extractorVersion, EXTRACTOR_VERSION),
					inArray(
						graphFileCache.objectId,
						chunk.map((entry) => entry.object),
					),
				),
			);
		for (const row of rows)
			if (wanted.has(`${row.path}\0${row.objectId}`))
				// Written by extractFile under the same EXTRACTOR_VERSION, so the shape is ours.
				extractions.set(row.path, row.extraction as unknown as FileExtraction);
	}
	const reused = extractions.size;
	progress("parsing", reused, toParse.length);

	const binary = new Set<string>();
	for (const chunk of chunks(
		toParse.filter((entry) => !extractions.has(entry.path)),
		BLOB_BATCH,
	)) {
		check();
		const blobs = await readBlobs(
			input.dir,
			[...new Set(chunk.map((entry) => entry.object))],
			{
				timeoutMs: budget(60_000),
				maxBytes:
					chunk.reduce((sum, entry) => sum + (entry.size ?? 0), 0) +
					1024 * 1024,
			},
		);
		if (!blobs)
			throw new ContextError(
				"repository_unreadable",
				"git could not read source files",
				true,
			);
		const fresh: Array<typeof graphFileCache.$inferInsert> = [];
		for (const entry of chunk) {
			const blob = blobs.get(entry.object);
			if (!blob) continue;
			if (blob.subarray(0, 8000).includes(0)) {
				binary.add(entry.path);
				continue;
			}
			const extraction = extractFile(entry.path, blob.toString("utf8"));
			extractions.set(entry.path, extraction);
			fresh.push({
				repositoryId: input.repositoryId,
				extractorVersion: EXTRACTOR_VERSION,
				path: entry.path,
				objectId: entry.object,
				extraction,
			});
		}
		if (fresh.length > 0 && cache)
			await cache.insert(graphFileCache).values(fresh).onConflictDoNothing();
		progress("parsing", extractions.size, toParse.length);
	}
	if (binary.size > 0) skipped.binary = [...binary];
	const files = readable.filter((entry) => !binary.has(entry.path));

	// Manifests, docs, and ownership rules are small text files read in one batch.
	const manifestEntries = files
		.filter((entry) => path.posix.basename(entry.path) === "package.json")
		.slice(0, MAX_MANIFESTS);
	const docEntries = files.filter(
		(entry) => languageOf(entry.path) === "markdown",
	);
	if (docEntries.length > MAX_DOC_FILES)
		notes.push(
			`Only the first ${MAX_DOC_FILES} of ${docEntries.length} Markdown files were indexed for DOCUMENTED_BY edges.`,
		);
	const ownersEntry = CODEOWNERS_PATHS.map((candidate) =>
		files.find((entry) => entry.path === candidate),
	).find((entry) => entry !== undefined);
	const textEntries = [
		...manifestEntries,
		...docEntries.slice(0, MAX_DOC_FILES),
		...(ownersEntry ? [ownersEntry] : []),
	];
	const texts = new Map<string, string>();
	progress("reading", 0, textEntries.length);
	if (textEntries.length > 0) {
		check();
		const blobs = await readBlobs(
			input.dir,
			[...new Set(textEntries.map((entry) => entry.object))],
			{
				timeoutMs: budget(30_000),
				maxBytes:
					textEntries.reduce((sum, entry) => sum + (entry.size ?? 0), 0) +
					1024 * 1024,
			},
		);
		if (!blobs) notes.push("Manifests and documentation could not be read.");
		for (const entry of textEntries) {
			const blob = blobs?.get(entry.object);
			if (blob) texts.set(entry.path, blob.toString("utf8"));
		}
	}
	const manifests: Manifest[] = [];
	for (const entry of manifestEntries) {
		const manifest = parseManifest(entry.path, texts.get(entry.path));
		if (manifest) manifests.push(manifest);
		else notes.push(`${entry.path} could not be parsed as JSON.`);
	}
	const indexedPaths = new Set(files.map((entry) => entry.path));
	const docs: DocSection[] = docEntries
		.slice(0, MAX_DOC_FILES)
		.flatMap((entry) =>
			docSections(entry.path, texts.get(entry.path) ?? "", indexedPaths),
		)
		.slice(0, MAX_DOC_SECTIONS);
	const codeowners = (ownersEntry ? (texts.get(ownersEntry.path) ?? "") : "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const [pattern = "", ...owners] = line.split(/\s+/);
			return { pattern, owners };
		})
		.filter((rule) => rule.pattern && rule.owners.length > 0)
		.slice(0, 500);

	check();
	progress("history", 0, MAX_COMMITS);
	const log = input.skipHistory
		? null
		: await git(
				input.dir,
				[
					"log",
					`--max-count=${MAX_COMMITS}`,
					"--format=%x1e%H%x1f%aI%x1f%s",
					"--name-only",
					"--no-renames",
					input.commitSha,
				],
				{ timeoutMs: budget(30_000), maxBytes: 16 * 1024 * 1024 },
			);
	const commits = log?.ok ? parseLog(log.stdout) : [];
	if (log && !log.ok)
		notes.push(
			"Commit history could not be read; INTRODUCED_OR_CHANGED_BY edges are missing.",
		);

	check();
	progress("linking", 0, files.length);
	const graph = buildGraph({
		repositoryName: input.repositoryName,
		commitSha: input.commitSha,
		files: files.map((entry) => ({
			path: entry.path,
			size: entry.size,
			object: entry.object,
		})),
		skipped,
		extractions,
		manifests,
		commits,
		codeowners,
		docs,
		limits: { truncatedFiles },
	});
	graph.coverage.notes.push(...notes);
	return {
		...graph,
		stats: {
			files_parsed: extractions.size - reused,
			files_reused: reused,
			duration_ms: Date.now() - started,
		},
	};
}

export type GraphFileFacts = {
	path: string;
	defines: Array<{
		name: string;
		kind: string;
		start_line: number | null;
		end_line: number | null;
	}>;
	imported_by: string[];
	used_by: Array<{ from: string; kind: string; target: string }>;
	tests: Array<{ name: string; file: string; target: string }>;
};

const USE_EDGES = new Set([
	"CALLS",
	"REFERENCES",
	"RENDERS",
	"IMPLEMENTS",
	"EXTENDS",
	"ROUTES_TO",
	"HANDLES_EVENT",
]);

/**
 * What the static graph says about each file: its definitions, who imports or uses them, and which
 * tests are linked to them. Only resolved edges are used; these are leads, not proof of behavior.
 */
export function graphFactsFor(
	graph: Pick<CommitAnalysis, "nodes" | "edges">,
	files: readonly string[],
): GraphFileFacts[] {
	// Two linear passes: the files' own symbols, then only the edges that point at them.
	const nodes = new Map(graph.nodes.map((node) => [node.key, node]));
	const fileKeys = new Set(files.map((file) => `file:${file}`));
	const defined = new Map<string, string[]>();
	for (const edge of graph.edges)
		if (edge.kind === "DEFINES" && edge.to && fileKeys.has(edge.from)) {
			const list = defined.get(edge.from) ?? [];
			list.push(edge.to);
			defined.set(edge.from, list);
		}
	const targets = new Set([...fileKeys, ...[...defined.values()].flat()]);
	const incoming = new Map<string, CommitAnalysis["edges"]>();
	for (const edge of graph.edges) {
		if (!edge.to || edge.certainty === "heuristic" || !targets.has(edge.to))
			continue;
		const list = incoming.get(edge.to) ?? [];
		list.push(edge);
		incoming.set(edge.to, list);
	}
	const isTestSource = (key: string) => {
		const node = nodes.get(key);
		return node?.kind === "test_case" || node?.kind === "test_file";
	};
	const shortKey = (key: string) => key.replace(/^(sym|file|test):/, "");
	return files.map((file) => {
		const fileKey = `file:${file}`;
		const own = (key: string) =>
			key === fileKey || key.startsWith(`sym:${file}#`);
		const symbols = (defined.get(fileKey) ?? []).flatMap((key) => {
			const node = nodes.get(key);
			return node ? [node] : [];
		});
		const facts: GraphFileFacts = {
			path: file,
			defines: symbols.map((node) => ({
				name: node.name,
				kind: node.kind,
				start_line: node.start_line,
				end_line: node.end_line,
			})),
			imported_by: [],
			used_by: [],
			tests: [],
		};
		const seenTests = new Set<string>();
		for (const target of [fileKey, ...symbols.map((node) => node.key)])
			for (const edge of incoming.get(target) ?? []) {
				if (own(edge.from)) continue;
				const source = nodes.get(edge.from);
				const testSource = isTestSource(edge.from);
				if (edge.kind === "TESTS" || (testSource && USE_EDGES.has(edge.kind))) {
					const name =
						source?.kind === "test_case" ? source.name : "(whole file)";
					const key = `${source?.path ?? ""}#${name}`;
					if (!seenTests.has(key)) {
						seenTests.add(key);
						facts.tests.push({
							name,
							file: source?.path ?? shortKey(edge.from),
							target: shortKey(target),
						});
					}
				} else if (edge.kind === "IMPORTS")
					facts.imported_by.push(shortKey(edge.from));
				else if (USE_EDGES.has(edge.kind))
					facts.used_by.push({
						from: shortKey(edge.from),
						kind: edge.kind,
						target: shortKey(target),
					});
			}
		facts.imported_by = [...new Set(facts.imported_by)].sort();
		return facts;
	});
}

/** One evidence paragraph per file, as quoted to models and shown in findings. */
export function renderGraphFacts(
	facts: GraphFileFacts,
	commitSha: string,
	coverageComplete: boolean,
): string {
	const list = (items: string[], max: number) =>
		items.length === 0
			? "none found"
			: `${items.slice(0, max).join("; ")}${items.length > max ? `; and ${items.length - max} more` : ""}`;
	return [
		`Static code graph of ${facts.path} at ${commitSha.slice(0, 12)} (parsed with @babel/parser; links follow resolved imports and bindings only and are leads, not proof of behavior).`,
		`Defines: ${list(
			facts.defines.map(
				(d) => `${d.name} (${d.kind}, lines ${d.start_line}-${d.end_line})`,
			),
			15,
		)}.`,
		`Imported by: ${list(facts.imported_by, 10)}.`,
		`Used by: ${list(
			facts.used_by.map((u) => `${u.from} ${u.kind} ${u.target}`),
			10,
		)}.`,
		`Linked tests: ${list(
			facts.tests.map((t) => `${t.file} > "${t.name}" (${t.target})`),
			15,
		)}.`,
		coverageComplete
			? "Graph coverage for this commit is complete for parsed languages."
			: "Graph coverage for this commit is partial; some links may be missing.",
	].join("\n");
}

export type SnapshotRow = typeof repositorySnapshots.$inferSelect;

export function toSnapshotView(row: SnapshotRow) {
	return {
		id: row.id,
		repository_id: row.repositoryId,
		ref: row.ref,
		commit_sha: row.commitSha,
		status: row.status,
		extractor_version: row.extractorVersion,
		previous_snapshot_id: row.previousSnapshotId,
		coverage_complete:
			row.coverage === null ? null : row.coverage.complete === true,
		stats: row.stats ?? null,
		progress: row.progress ?? null,
		cancel_requested_at: row.cancelRequestedAt?.toISOString() ?? null,
		error: row.error ?? null,
		created_at: row.createdAt.toISOString(),
		started_at: row.startedAt?.toISOString() ?? null,
		finished_at: row.finishedAt?.toISOString() ?? null,
	};
}

const toAppError = (error: unknown) =>
	error instanceof ContextError
		? new AppError(422, error.code, error.message)
		: error;

/**
 * Queues indexing of one commit (default: the repository's default branch). Idempotent per commit
 * and extractor version: an existing snapshot is returned; a failed one is re-queued.
 */
export async function requestIndex(
	deps: { db: Db; pool: pg.Pool; boss: PgBoss; config: Config },
	ctx: AuthContext,
	repositoryId: string,
	input: IndexRepositoryRequest,
	requestId: string,
): Promise<{ status: 200 | 202; snapshot: ReturnType<typeof toSnapshotView> }> {
	const repo = await getRepositoryRow(deps.db, ctx.workspaceId, repositoryId);
	const source = await verifySourcePath(deps.config, repo).catch((error) => {
		throw toAppError(error);
	});
	const ref = input.ref ?? repo.defaultBranch;
	const commitSha = await resolveCommit(source, ref);
	if (!commitSha)
		throw new AppError(
			422,
			"commit_not_found",
			`${ref} does not resolve to a commit`,
		);
	const bySha = and(
		eq(repositorySnapshots.repositoryId, repo.id),
		eq(repositorySnapshots.commitSha, commitSha),
		eq(repositorySnapshots.extractorVersion, EXTRACTOR_VERSION),
	);
	return withTransaction(deps.pool, async ({ db, queueDb }) => {
		const [existing] = await db
			.select()
			.from(repositorySnapshots)
			.where(bySha)
			.for("update")
			.limit(1);
		// A ready snapshot is only fully usable with its mirror (search and source excerpts read it). Where
		// the data directory is temporary the mirror disappears, and indexing again is what restores it.
		const mirrorGone =
			existing?.status === "ready" &&
			!(await stat(mirrorPath(deps.config, existing.id)).catch(() => null));
		if (
			existing &&
			existing.status !== "failed" &&
			existing.status !== "cancelled" &&
			!mirrorGone
		)
			return { status: 200 as const, snapshot: toSnapshotView(existing) };
		let id = existing?.id;
		if (existing)
			await db
				.update(repositorySnapshots)
				.set({
					status: "queued",
					error: null,
					progress: null,
					cancelRequestedAt: null,
					startedAt: null,
					finishedAt: null,
					requestedBy: ctx.userId,
					updatedAt: new Date(),
				})
				.where(eq(repositorySnapshots.id, existing.id));
		else {
			const [inserted] = await db
				.insert(repositorySnapshots)
				.values({
					id: newId("snap"),
					workspaceId: ctx.workspaceId,
					repositoryId: repo.id,
					ref,
					commitSha,
					status: "queued",
					extractorVersion: EXTRACTOR_VERSION,
					requestedBy: ctx.userId,
				})
				.onConflictDoNothing()
				.returning({ id: repositorySnapshots.id });
			id = inserted?.id;
		}
		if (!id) {
			// A concurrent request created it first.
			const [row] = await db
				.select()
				.from(repositorySnapshots)
				.where(bySha)
				.limit(1);
			if (!row) throw new Error("snapshot vanished during index request");
			return { status: 200 as const, snapshot: toSnapshotView(row) };
		}
		await enqueueIndex(deps.boss, queueDb, { snapshotId: id });
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "repository.index_requested",
			targetType: "repository_snapshot",
			targetId: id,
			metadata: { repository_id: repo.id, commit_sha: commitSha, ref },
			requestId,
		});
		const [row] = await db
			.select()
			.from(repositorySnapshots)
			.where(eq(repositorySnapshots.id, id))
			.limit(1);
		if (!row) throw new Error("snapshot vanished during index request");
		return { status: 202 as const, snapshot: toSnapshotView(row) };
	});
}

/**
 * Worker-loss recovery for indexing: a queued or indexing snapshot whose queue job no longer exists
 * in a live state (created, retry, active) will never finish. It is marked failed (`job_lost`,
 * retryable) so the repository can be indexed again; a new request re-queues it.
 */
export async function recoverLostIndexJobs(db: Db): Promise<number> {
	const result = await db.execute<{ id: string; workspace_id: string }>(sql`
		UPDATE ${repositorySnapshots} s
		   SET status = 'failed',
		       error = jsonb_build_object('code', 'job_lost', 'retryable', true,
		         'message', 'The indexing job was lost (worker crash or queue expiry); request indexing again'),
		       finished_at = now(), updated_at = now()
		 WHERE s.status IN ('queued', 'indexing')
		   AND s.updated_at < now() - interval '2 minutes'
		   AND NOT EXISTS (
		     SELECT 1 FROM pgboss.job j
		      WHERE j.name = 'repository.index' AND j.data->>'snapshotId' = s.id
		        AND j.state IN ('created', 'retry', 'active'))
		RETURNING s.id, s.workspace_id`);
	for (const row of result.rows)
		await audit(db, {
			workspaceId: row.workspace_id,
			actor: WORKER_ACTOR,
			action: "repository.index_recovered",
			targetType: "repository_snapshot",
			targetId: row.id,
			metadata: { code: "job_lost" },
		});
	return result.rows.length;
}

/** Keeps the newest usable snapshots (and failures newer than them); older ones and their mirrors go. */
async function pruneSnapshots(
	deps: { db: Db; config: Config },
	repositoryId: string,
): Promise<void> {
	const rows = await deps.db
		.select({
			id: repositorySnapshots.id,
			status: repositorySnapshots.status,
			createdAt: repositorySnapshots.createdAt,
		})
		.from(repositorySnapshots)
		.where(eq(repositorySnapshots.repositoryId, repositoryId))
		.orderBy(desc(repositorySnapshots.createdAt));
	const usable = rows.filter(
		(row) => row.status === "ready" || row.status === "partial",
	);
	const kept = new Set(usable.slice(0, KEEP_SNAPSHOTS).map((row) => row.id));
	const oldestKept =
		usable[Math.min(usable.length, KEEP_SNAPSHOTS) - 1]?.createdAt;
	const removable = rows.filter(
		(row) =>
			!kept.has(row.id) &&
			row.status !== "queued" &&
			row.status !== "indexing" &&
			((row.status !== "failed" && row.status !== "cancelled") ||
				(oldestKept !== undefined && row.createdAt < oldestKept)),
	);
	if (removable.length === 0) return;
	await deps.db.delete(repositorySnapshots).where(
		inArray(
			repositorySnapshots.id,
			removable.map((row) => row.id),
		),
	);
	await Promise.all(
		removable.map((row) =>
			rm(mirrorPath(deps.config, row.id), { recursive: true, force: true }),
		),
	);
}

/** The `repository.index` job. Redelivered or finished snapshots are ignored (idempotent). */
export async function runIndexJob(
	deps: {
		db: Db;
		config: Config;
		log?: (message: string, fields: Record<string, unknown>) => void;
	},
	snapshotId: string,
): Promise<void> {
	const [snapshot] = await deps.db
		.select()
		.from(repositorySnapshots)
		.where(eq(repositorySnapshots.id, snapshotId))
		.limit(1);
	if (!snapshot || !["queued", "indexing"].includes(snapshot.status)) return;
	const [repo] = await deps.db
		.select()
		.from(repositories)
		.where(eq(repositories.id, snapshot.repositoryId))
		.limit(1);
	if (!repo) return;
	const started = new Date();
	await deps.db
		.update(repositorySnapshots)
		.set({
			status: "indexing",
			startedAt: started,
			progress: {
				phase: "cloning",
				done: 0,
				total: 0,
				updated_at: started.toISOString(),
			},
			updatedAt: started,
		})
		.where(eq(repositorySnapshots.id, snapshot.id));
	// Cancellation is a database flag (the API never signals the worker directly), polled every 2 s.
	const controller = new AbortController();
	if (snapshot.cancelRequestedAt) controller.abort("cancelled");
	const poll = setInterval(() => {
		deps.db
			.select({ at: repositorySnapshots.cancelRequestedAt })
			.from(repositorySnapshots)
			.where(eq(repositorySnapshots.id, snapshot.id))
			.limit(1)
			.then(
				([row]) => {
					if (row?.at) controller.abort("cancelled");
				},
				() => undefined,
			);
	}, 2000);
	// Progress writes are throttled: at most one round trip per 1.5 s, plus each phase change.
	let lastPhase = "";
	let lastWrite = 0;
	let writes: Promise<unknown> = Promise.resolve();
	const report = (
		phase: IndexProgress["phase"],
		done: number,
		total: number,
	) => {
		const now = Date.now();
		if (phase === lastPhase && now - lastWrite < 1500) return;
		lastPhase = phase;
		lastWrite = now;
		const progress = {
			phase,
			done,
			total,
			updated_at: new Date(now).toISOString(),
		};
		writes = writes
			.then(() =>
				deps.db
					.update(repositorySnapshots)
					.set({ progress })
					.where(
						and(
							eq(repositorySnapshots.id, snapshot.id),
							eq(repositorySnapshots.status, "indexing"),
						),
					),
			)
			.catch(() => undefined);
	};
	const mirror = mirrorPath(deps.config, snapshot.id);
	try {
		if (controller.signal.aborted)
			throw new ContextError("cancelled", "Indexing was cancelled");
		const source = await verifySourcePath(deps.config, repo);
		const cloneStarted = Date.now();
		const clone = await cloneAtCommit(
			deps.config,
			source,
			mirror,
			snapshot.commitSha,
			120_000,
			{ bare: true },
		);
		const cloneMs = Date.now() - cloneStarted;
		if (!clone.ok)
			throw new ContextError(
				clone.code,
				clone.message,
				clone.code === "context_timeout",
			);
		const analysis = await analyzeCommit(deps, {
			repositoryId: repo.id,
			repositoryName: repo.name,
			dir: mirror,
			commitSha: snapshot.commitSha,
			deadline: Date.now() + INDEX_TIMEOUT_MS,
			signal: controller.signal,
			onProgress: report,
		});
		if (controller.signal.aborted)
			throw new ContextError("cancelled", "Indexing was cancelled");
		report("saving", 0, analysis.nodes.length + analysis.edges.length);
		await writes;
		const [previous] = await deps.db
			.select({ id: repositorySnapshots.id })
			.from(repositorySnapshots)
			.where(
				and(
					eq(repositorySnapshots.repositoryId, repo.id),
					inArray(repositorySnapshots.status, ["ready", "partial"]),
					ne(repositorySnapshots.id, snapshot.id),
				),
			)
			.orderBy(desc(repositorySnapshots.createdAt))
			.limit(1);
		const status = analysis.coverage.complete ? "ready" : "partial";
		const stats: Record<string, number> = {
			...analysis.stats,
			clone_ms: cloneMs,
			nodes: analysis.nodes.length,
			edges: analysis.edges.length,
		};
		await deps.db.transaction(async (tx) => {
			const persistStarted = Date.now();
			// A crashed earlier attempt may have written part of this snapshot.
			await tx.delete(graphEdges).where(eq(graphEdges.snapshotId, snapshot.id));
			await tx.delete(graphNodes).where(eq(graphNodes.snapshotId, snapshot.id));
			// Set-based inserts: each batch travels as one JSON parameter that PostgreSQL expands with
			// jsonb_to_recordset, instead of one bind parameter per value (several times faster).
			for (const chunk of chunks(analysis.nodes, 10_000))
				await tx.execute(sql`
					INSERT INTO graph_nodes (id, snapshot_id, workspace_id, key, kind, name, path,
						start_line, end_line, language, attributes, provenance)
					SELECT r.id, ${snapshot.id}, ${snapshot.workspaceId}, r.key, r.kind, r.name, r.path,
						r.start_line, r.end_line, r.language, r.attributes, r.provenance
					FROM jsonb_to_recordset(${JSON.stringify(
						chunk.map((node) => ({ ...node, id: newId("gnd") })),
					)}::jsonb) AS r(id text, key text, kind text, name text, path text,
						start_line integer, end_line integer, language text, attributes jsonb, provenance jsonb)`);
			for (const chunk of chunks(analysis.edges, 20_000))
				await tx.execute(sql`
					INSERT INTO graph_edges (snapshot_id, kind, from_key, to_key, target_text, certainty, provenance)
					SELECT ${snapshot.id}, r.kind, r."from", r."to", r.target_text, r.certainty, r.provenance
					FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS r(kind text, "from" text,
						"to" text, target_text text, certainty text, provenance jsonb)`);
			await tx
				.update(repositorySnapshots)
				.set({
					status,
					previousSnapshotId: previous?.id ?? null,
					profile: analysis.profile,
					coverage: analysis.coverage,
					stats: { ...stats, persist_ms: Date.now() - persistStarted },
					progress: null,
					error: null,
					finishedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(repositorySnapshots.id, snapshot.id));
		});
		await audit(deps.db, {
			workspaceId: snapshot.workspaceId,
			actor: WORKER_ACTOR,
			action: "repository.indexed",
			targetType: "repository_snapshot",
			targetId: snapshot.id,
			metadata: {
				repository_id: repo.id,
				commit_sha: snapshot.commitSha,
				status,
				...stats,
			},
		});
		await pruneSnapshots(deps, repo.id);
	} catch (error) {
		await writes;
		await rm(mirror, { recursive: true, force: true });
		const cancelled =
			controller.signal.aborted ||
			(error instanceof ContextError && error.code === "cancelled");
		const failure = cancelled
			? {
					code: "cancelled",
					message: "Indexing was cancelled",
					retryable: true,
				}
			: error instanceof ContextError
				? {
						code: error.code,
						message: error.message,
						retryable: error.retryable,
					}
				: { code: "index_failed", message: "Indexing failed unexpectedly" };
		await deps.db
			.update(repositorySnapshots)
			.set({
				status: cancelled ? "cancelled" : "failed",
				error: failure,
				progress: null,
				finishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(repositorySnapshots.id, snapshot.id));
		if (cancelled)
			await audit(deps.db, {
				workspaceId: snapshot.workspaceId,
				actor: WORKER_ACTOR,
				action: "repository.index_cancelled",
				targetType: "repository_snapshot",
				targetId: snapshot.id,
				metadata: { repository_id: repo.id },
			});
		else
			deps.log?.("repository index failed", {
				snapshot_id: snapshot.id,
				code: failure.code,
				...(error instanceof ContextError
					? {}
					: { error: (error as Error).message }),
			});
	} finally {
		clearInterval(poll);
	}
}

/**
 * Cancels indexing of one snapshot: a queued snapshot is cancelled at once; a running one gets a flag
 * the worker polls, and stops before saving anything. Finished snapshots cannot be cancelled.
 */
export async function cancelIndex(
	db: Db,
	ctx: AuthContext,
	snapshotId: string,
	requestId: string,
) {
	const [row] = await db
		.select()
		.from(repositorySnapshots)
		.where(
			and(
				eq(repositorySnapshots.id, snapshotId),
				eq(repositorySnapshots.workspaceId, ctx.workspaceId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(
			404,
			"not_found",
			`Snapshot ${snapshotId} was not found`,
		);
	const now = new Date();
	// Conditional updates settle the race with a worker picking the job up at the same moment.
	const queued = await db
		.update(repositorySnapshots)
		.set({
			status: "cancelled",
			cancelRequestedAt: now,
			error: {
				code: "cancelled",
				message: "Indexing was cancelled",
				retryable: true,
			},
			finishedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(repositorySnapshots.id, row.id),
				eq(repositorySnapshots.status, "queued"),
			),
		)
		.returning({ id: repositorySnapshots.id });
	const running =
		queued.length > 0
			? []
			: await db
					.update(repositorySnapshots)
					.set({ cancelRequestedAt: now, updatedAt: now })
					.where(
						and(
							eq(repositorySnapshots.id, row.id),
							eq(repositorySnapshots.status, "indexing"),
						),
					)
					.returning({ id: repositorySnapshots.id });
	if (queued.length === 0 && running.length === 0)
		throw new AppError(
			409,
			"invalid_state",
			`Snapshot ${row.id} is ${row.status}; only queued or indexing snapshots can be cancelled`,
		);
	await audit(db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: "repository.index_cancel_requested",
		targetType: "repository_snapshot",
		targetId: row.id,
		metadata: { was: queued.length > 0 ? "queued" : "indexing" },
		requestId,
	});
	const [fresh] = await db
		.select()
		.from(repositorySnapshots)
		.where(eq(repositorySnapshots.id, row.id))
		.limit(1);
	return { snapshot: toSnapshotView(fresh ?? row) };
}
