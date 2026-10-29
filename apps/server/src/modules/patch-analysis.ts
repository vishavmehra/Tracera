import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PatchImpactRequest, PatchImpactResult } from "@tracera/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, withTransaction } from "../db/client.ts";
import { patchAnalyses, repositories } from "../db/schema.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { putBlob, readBlobUtf8 } from "../lib/fs.ts";
import { git, readBlobs, resolveCommit } from "../lib/git.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { enqueuePatchImpact } from "../queue.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import { ContextError, verifySourcePath } from "./context.ts";
import { analyzeCommit, type CommitAnalysis } from "./graph.ts";
import {
	CODE_LANGUAGES,
	EXTRACTOR_VERSION,
	languageOf,
} from "./graph-extract.ts";
import {
	analyzePatch,
	type DiffEntry,
	diffSections,
	PATCH_IMPACT_VERSION,
	parseNameStatus,
	parseNumstat,
	renderPatchImpactMarkdown,
} from "./patch-impact.ts";
import { getRepositoryRow } from "./repositories.ts";
import { cloneAtCommit, workspacePath } from "./workspace.ts";

// Patch impact analyses: a background job clones the registered
// repository into a Tracera workspace, materializes the head revision (a commit, or a supplied diff
// applied to the base's index), analyses both revisions' graphs (cached per file), and compares them.
// Nothing from the repository runs; only git and the parsers read it.

type AnalysisRow = typeof patchAnalyses.$inferSelect;

/** Stored on a generated patch: its impact, or why it could not be computed. */
export type PatchImpactRecord =
	| ({ available: true } & PatchImpactResult)
	| { available: false; reason: string };

const MAX_PATCH_FILES = 500;
const MAX_TEXT_FILES = 200;
const JOB_BUDGET_MS = 10 * 60_000;
const blobsDir = (config: Pick<Config, "dataDir">) =>
	path.join(config.dataDir, "blobs");

/**
 * Static checks of a supplied diff before anything applies it: every path relative and inside the
 * tree (no `..`, no `.git`, no absolute or Windows paths), no symbolic links or submodules, no binary
 * patches, and a bounded number of files.
 */
export function checkSuppliedDiff(
	diff: string,
): { ok: true; files: number } | { ok: false; errors: string[] } {
	const errors = new Set<string>();
	const unsafe = (file: string) =>
		file === "" ||
		file.startsWith("/") ||
		/^[A-Za-z]:/.test(file) ||
		file.includes("\\") ||
		file.includes("\0") ||
		file.split("/").some((part) => part === ".." || part === ".git");
	let files = 0;
	let inHunk = false;
	for (const raw of diff.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.startsWith("diff --git ")) {
			files += 1;
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@ ")) {
			inHunk = true;
			continue;
		}
		if (inHunk) continue;
		if (line === "GIT binary patch")
			errors.add(
				"Binary patches are not supported; compare two commits instead.",
			);
		const mode =
			/^(?:new file mode|deleted file mode|new mode|old mode) (\d{6})$|^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/.exec(
				line,
			);
		const bits = mode?.[1] ?? mode?.[2];
		if (bits === "120000" || bits === "160000")
			errors.add("A supplied diff cannot add symbolic links or submodules.");
		const header =
			/^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )(.*)$/.exec(
				line,
			);
		if (!header) continue;
		const target = (header[1] ?? "").trim();
		if (target === "/dev/null") continue;
		const file = target.replace(/^"(.*)"$/, "$1").replace(/^[ab]\//, "");
		if (unsafe(file))
			errors.add(`Unsafe path in the diff: ${file.slice(0, 200)}`);
	}
	if (files === 0)
		errors.add(
			"No file changes found: expected `diff --git` sections as git prints them.",
		);
	if (files > MAX_PATCH_FILES)
		errors.add(
			`The diff changes ${files} files; at most ${MAX_PATCH_FILES} are analysed.`,
		);
	return errors.size > 0
		? { ok: false, errors: [...errors] }
		: { ok: true, files };
}

/** Applies a checked diff to the base's index (the working tree is untouched) and returns the tree. */
async function applySuppliedDiff(dir: string, diff: string): Promise<string> {
	const patchFile = `${dir}.patch`;
	await writeFile(patchFile, diff);
	try {
		const flags = ["apply", "--cached", "--whitespace=nowarn"];
		const check = await git(dir, [...flags, "--check", patchFile], {
			timeoutMs: 60_000,
		});
		if (!check.ok)
			throw new ContextError(
				"diff_does_not_apply",
				"The supplied diff does not apply to the base revision",
			);
		if (!(await git(dir, [...flags, patchFile], { timeoutMs: 60_000 })).ok)
			throw new ContextError(
				"diff_does_not_apply",
				"git apply failed on the base revision",
			);
		const tree = await git(dir, ["write-tree"]);
		const sha = tree.stdout.trim();
		if (!tree.ok || !/^[0-9a-f]{40}$/.test(sha))
			throw new ContextError(
				"repository_unreadable",
				"git could not record the patched tree",
			);
		return sha;
	} finally {
		await rm(patchFile, { force: true });
	}
}

/** Texts of changed code files at one revision, read by blob ID from that revision's graph. */
async function changedTexts(
	dir: string,
	analysis: CommitAnalysis,
	paths: readonly string[],
): Promise<Map<string, string>> {
	const files = new Map(
		analysis.nodes
			.filter((node) => node.kind === "file" || node.kind === "test_file")
			.map((node) => [node.path, node]),
	);
	const objects = new Map<string, string>();
	for (const file of paths) {
		const object = files.get(file)?.attributes.object;
		if (typeof object === "string") objects.set(file, object);
	}
	const texts = new Map<string, string>();
	if (objects.size === 0) return texts;
	const blobs = await readBlobs(dir, [...new Set(objects.values())], {
		timeoutMs: 30_000,
		maxBytes: 64 * 1024 * 1024,
	});
	for (const [file, object] of objects) {
		const blob = blobs?.get(object);
		if (blob) texts.set(file, blob.toString("utf8"));
	}
	return texts;
}

/**
 * Compares two revisions in a Tracera-owned clone: `git diff` with rename detection, both graphs
 * (extractions cached per file when a database is given), and the static impact of the difference.
 */
export async function computePatchImpact(
	deps: { db?: Db },
	input: {
		repositoryId: string;
		repositoryName: string;
		dir: string;
		base: { ref: string | null; sha: string };
		head: { ref: string | null; sha: string; kind: "commit" | "tree" };
		mergeBase: boolean;
		depth: number;
		limit: number;
		deadline: number;
		signal?: AbortSignal;
		onPhase?: (phase: string) => void;
	},
): Promise<PatchImpactResult> {
	const phase = input.onPhase ?? (() => undefined);
	const timeoutMs = Math.max(
		5000,
		Math.min(120_000, input.deadline - Date.now()),
	);
	phase("comparing");
	const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];
	const range = [input.base.sha, input.head.sha, "--"];
	const [patch, names, counts] = await Promise.all([
		git(input.dir, ["diff", ...flags, "--full-index", ...range], {
			timeoutMs,
			maxBytes: 64 * 1024 * 1024,
		}),
		git(input.dir, ["diff", ...flags, "--name-status", "-z", ...range], {
			timeoutMs,
			maxBytes: 8 * 1024 * 1024,
		}),
		git(input.dir, ["diff", ...flags, "--numstat", "-z", ...range], {
			timeoutMs,
			maxBytes: 8 * 1024 * 1024,
		}),
	]);
	if (!patch.ok || !names.ok || !counts.ok)
		throw new ContextError(
			patch.timedOut || names.timedOut || counts.timedOut
				? "context_timeout"
				: "repository_unreadable",
			"git could not compare the two revisions",
			true,
		);
	const listed = parseNameStatus(names.stdout);
	const stats = parseNumstat(counts.stdout);
	if (listed.length > MAX_PATCH_FILES)
		throw new ContextError(
			"patch_too_large",
			`The patch changes ${listed.length} files; at most ${MAX_PATCH_FILES} are analysed`,
		);
	if (stats.length !== listed.length)
		throw new ContextError(
			"repository_unreadable",
			"git reported different file lists for the same comparison",
		);
	const entries: DiffEntry[] = listed.map((entry, i) => ({
		...entry,
		additions: stats[i]?.additions ?? null,
		deletions: stats[i]?.deletions ?? null,
	}));
	const options = { depth: input.depth, limit: input.limit };
	if (entries.length === 0) {
		const empty = { nodes: [], edges: [], complete: true };
		const result = analyzePatch({
			base: empty,
			head: empty,
			baseRef: input.base,
			headRef: input.head,
			mergeBase: input.mergeBase,
			entries: [],
			sections: [],
			baseText: () => undefined,
			headText: () => undefined,
			options,
		});
		result.limitations.unshift(
			"The two revisions have identical trees: nothing changed.",
		);
		return result;
	}
	const analyse = (sha: string) =>
		analyzeCommit(deps, {
			repositoryId: input.repositoryId,
			repositoryName: input.repositoryName,
			dir: input.dir,
			commitSha: sha,
			deadline: input.deadline,
			signal: input.signal,
			skipHistory: true,
		});
	phase("analysing");
	// The revisions are independent and mostly wait on git, so they are indexed concurrently.
	const [base, head] = await Promise.all([
		analyse(input.base.sha),
		analyse(input.head.sha),
	]);
	const code = entries
		.filter((entry) => CODE_LANGUAGES.has(languageOf(entry.path)))
		.slice(0, MAX_TEXT_FILES);
	const [baseTexts, headTexts] = await Promise.all([
		changedTexts(
			input.dir,
			base,
			code.flatMap((entry) =>
				entry.status === "added" || entry.status === "copied"
					? []
					: [entry.old_path ?? entry.path],
			),
		),
		changedTexts(
			input.dir,
			head,
			code.flatMap((entry) => (entry.status === "deleted" ? [] : [entry.path])),
		),
	]);
	phase("tracing");
	return analyzePatch({
		base: {
			nodes: base.nodes,
			edges: base.edges,
			complete: base.coverage.complete,
		},
		head: {
			nodes: head.nodes,
			edges: head.edges,
			complete: head.coverage.complete,
		},
		baseRef: input.base,
		headRef: input.head,
		mergeBase: input.mergeBase,
		entries,
		sections: diffSections(patch.stdout),
		baseText: (file) => baseTexts.get(file),
		headText: (file) => headTexts.get(file),
		options,
	});
}

// ---- API --------------------------------------------------------------------------------------

function toAnalysisView(row: AnalysisRow) {
	return {
		id: row.id,
		repository_id: row.repositoryId,
		base: { ref: row.baseRef, sha: row.baseSha },
		head: row.diffSha256
			? { ref: null, sha: null, diff_sha256: row.diffSha256 }
			: { ref: row.headRef, sha: row.headSha, diff_sha256: null },
		merge_base: row.mergeBase,
		options: row.options,
		status: row.status,
		progress: row.progress ?? null,
		result: row.result ?? null,
		error: row.error ?? null,
		cancel_requested_at: row.cancelRequestedAt?.toISOString() ?? null,
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
 * Queues an impact analysis of two revisions (or a supplied diff on a base revision). Requests are
 * keyed by the exact commits or diff hash, options, and analysis versions: an equal request returns
 * the existing analysis (unless it failed or was cancelled, which re-queues it).
 */
export async function createPatchAnalysis(
	deps: { db: Db; pool: pg.Pool; boss: PgBoss; config: Config },
	ctx: AuthContext,
	repositoryId: string,
	input: PatchImpactRequest,
	requestId: string,
): Promise<{
	status: 200 | 202;
	analysis: ReturnType<typeof toAnalysisView>;
}> {
	const repo = await getRepositoryRow(deps.db, ctx.workspaceId, repositoryId);
	if (input.diff !== undefined) {
		const check = checkSuppliedDiff(input.diff);
		if (!check.ok)
			throw new AppError(422, "diff_invalid", check.errors.join(" "));
	}
	const source = await verifySourcePath(deps.config, repo).catch((error) => {
		throw toAppError(error);
	});
	const baseSha = await resolveCommit(source, input.base);
	if (!baseSha)
		throw new AppError(
			422,
			"commit_not_found",
			`${input.base} does not resolve to a commit`,
		);
	let headSha: string | null = null;
	if (input.head !== undefined) {
		headSha = await resolveCommit(source, input.head);
		if (!headSha)
			throw new AppError(
				422,
				"commit_not_found",
				`${input.head} does not resolve to a commit`,
			);
	}
	const diffSha =
		input.diff !== undefined
			? (await putBlob(blobsDir(deps.config), Buffer.from(input.diff, "utf8")))
					.sha256
			: null;
	const options = { depth: input.depth, limit: input.limit };
	const cacheKey = sha256Hex(
		JSON.stringify([
			PATCH_IMPACT_VERSION,
			EXTRACTOR_VERSION,
			baseSha,
			headSha,
			diffSha,
			input.merge_base,
			options,
		]),
	);
	return withTransaction(deps.pool, async ({ db, queueDb }) => {
		const [existing] = await db
			.select()
			.from(patchAnalyses)
			.where(
				and(
					eq(patchAnalyses.repositoryId, repo.id),
					eq(patchAnalyses.cacheKey, cacheKey),
				),
			)
			.for("update")
			.limit(1);
		if (
			existing &&
			existing.status !== "failed" &&
			existing.status !== "cancelled"
		)
			return { status: 200 as const, analysis: toAnalysisView(existing) };
		const id = existing?.id ?? newId("pia");
		if (existing)
			await db
				.update(patchAnalyses)
				.set({
					status: "queued",
					progress: null,
					result: null,
					error: null,
					cancelRequestedAt: null,
					startedAt: null,
					finishedAt: null,
					updatedAt: new Date(),
				})
				.where(eq(patchAnalyses.id, id));
		else
			await db.insert(patchAnalyses).values({
				id,
				workspaceId: ctx.workspaceId,
				repositoryId: repo.id,
				baseRef: input.base,
				baseSha,
				headRef: input.head ?? null,
				headSha,
				diffSha256: diffSha,
				mergeBase: input.merge_base,
				options,
				cacheKey,
				status: "queued",
				createdBy: ctx.userId,
			});
		await enqueuePatchImpact(deps.boss, queueDb, { analysisId: id });
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "patch_impact.requested",
			targetType: "patch_analysis",
			targetId: id,
			metadata: {
				repository_id: repo.id,
				base_sha: baseSha,
				head_sha: headSha,
				diff_sha256: diffSha,
				merge_base: input.merge_base,
			},
			requestId,
		});
		const [row] = await db
			.select()
			.from(patchAnalyses)
			.where(eq(patchAnalyses.id, id))
			.limit(1);
		if (!row) throw new Error("patch analysis vanished during creation");
		return { status: 202 as const, analysis: toAnalysisView(row) };
	});
}

async function analysisRow(db: Db, workspaceId: string, id: string) {
	const [row] = await db
		.select()
		.from(patchAnalyses)
		.where(
			and(eq(patchAnalyses.id, id), eq(patchAnalyses.workspaceId, workspaceId)),
		)
		.limit(1);
	if (!row)
		throw new AppError(404, "not_found", `Patch analysis ${id} was not found`);
	return row;
}

export async function getPatchAnalysis(
	db: Db,
	workspaceId: string,
	id: string,
) {
	return toAnalysisView(await analysisRow(db, workspaceId, id));
}

/** The Markdown review report of a finished analysis. */
export async function getPatchAnalysisReport(
	db: Db,
	workspaceId: string,
	id: string,
): Promise<string> {
	const row = await analysisRow(db, workspaceId, id);
	if (!row.result)
		throw new AppError(
			409,
			"invalid_state",
			`Patch analysis ${id} is ${row.status}; a report exists once it has finished`,
		);
	return renderPatchImpactMarkdown(row.result);
}

export async function listPatchAnalyses(
	db: Db,
	workspaceId: string,
	repositoryId: string,
	limit: number,
) {
	await getRepositoryRow(db, workspaceId, repositoryId);
	const rows = await db
		.select()
		.from(patchAnalyses)
		.where(
			and(
				eq(patchAnalyses.workspaceId, workspaceId),
				eq(patchAnalyses.repositoryId, repositoryId),
			),
		)
		.orderBy(desc(patchAnalyses.createdAt))
		.limit(limit);
	// Lists stay small: results are fetched one analysis at a time.
	return rows.map((row) => ({ ...toAnalysisView(row), result: null }));
}

/** Stops a queued analysis at once and a running one at its next check (about 2 s). */
export async function cancelPatchAnalysis(
	deps: { db: Db },
	ctx: AuthContext,
	id: string,
	requestId: string,
) {
	await analysisRow(deps.db, ctx.workspaceId, id);
	const now = new Date();
	const queued = sql`${patchAnalyses.status} = 'queued'`;
	const [updated] = await deps.db
		.update(patchAnalyses)
		.set({
			status: sql`case when ${queued} then 'cancelled'::patch_analysis_status else ${patchAnalyses.status} end`,
			cancelRequestedAt: now,
			error: sql`case when ${queued} then ${JSON.stringify({ code: "cancelled", message: "Cancelled before it started", retryable: true })}::jsonb else ${patchAnalyses.error} end`,
			finishedAt: sql`case when ${queued} then now() else ${patchAnalyses.finishedAt} end`,
			updatedAt: now,
		})
		.where(
			and(
				eq(patchAnalyses.id, id),
				eq(patchAnalyses.workspaceId, ctx.workspaceId),
				inArray(patchAnalyses.status, ["queued", "running"]),
			),
		)
		.returning();
	if (!updated)
		throw new AppError(
			409,
			"invalid_state",
			`Patch analysis ${id} has already finished`,
		);
	await audit(deps.db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: "patch_impact.cancel_requested",
		targetType: "patch_analysis",
		targetId: id,
		metadata: {},
		requestId,
	});
	return toAnalysisView(updated);
}

/** Worker-loss recovery: queued or running analyses whose queue job is gone become retryable failures. */
export async function recoverLostPatchAnalyses(db: Db): Promise<number> {
	const result = await db.execute<{ id: string; workspace_id: string }>(sql`
		UPDATE ${patchAnalyses} a
		   SET status = 'failed',
		       error = jsonb_build_object('code', 'job_lost', 'retryable', true,
		         'message', 'The analysis job was lost (worker crash or queue expiry); request it again'),
		       progress = null, finished_at = now(), updated_at = now()
		 WHERE a.status IN ('queued', 'running')
		   AND a.updated_at < now() - interval '2 minutes'
		   AND NOT EXISTS (
		     SELECT 1 FROM pgboss.job j
		      WHERE j.name = 'repository.patch_impact' AND j.data->>'analysisId' = a.id
		        AND j.state IN ('created', 'retry', 'active'))
		RETURNING a.id, a.workspace_id`);
	for (const row of result.rows)
		await audit(db, {
			workspaceId: row.workspace_id,
			actor: WORKER_ACTOR,
			action: "patch_impact.recovered",
			targetType: "patch_analysis",
			targetId: row.id,
			metadata: { code: "job_lost" },
		});
	return result.rows.length;
}

// ---- Job --------------------------------------------------------------------------------------

/** The `repository.patch_impact` job. Finished analyses are ignored (idempotent redelivery). */
export async function runPatchImpactJob(
	deps: {
		db: Db;
		config: Config;
		log?: (message: string, fields: Record<string, unknown>) => void;
	},
	analysisId: string,
): Promise<void> {
	const [row] = await deps.db
		.select()
		.from(patchAnalyses)
		.where(eq(patchAnalyses.id, analysisId))
		.limit(1);
	if (!row || (row.status !== "queued" && row.status !== "running")) return;
	const progress = (phase: string) =>
		deps.db
			.update(patchAnalyses)
			.set({
				progress: { phase, updated_at: new Date().toISOString() },
				updatedAt: new Date(),
			})
			.where(eq(patchAnalyses.id, analysisId));
	await deps.db
		.update(patchAnalyses)
		.set({
			status: "running",
			startedAt: new Date(),
			progress: { phase: "cloning", updated_at: new Date().toISOString() },
			updatedAt: new Date(),
		})
		.where(eq(patchAnalyses.id, analysisId));
	const controller = new AbortController();
	const poll = setInterval(() => {
		deps.db
			.select({ cancel: patchAnalyses.cancelRequestedAt })
			.from(patchAnalyses)
			.where(eq(patchAnalyses.id, analysisId))
			.limit(1)
			.then(([state]) => {
				if (state?.cancel) controller.abort();
			})
			.catch(() => undefined);
	}, 2000);
	const scope = workspacePath(deps.config, analysisId);
	try {
		if (row.cancelRequestedAt) controller.abort();
		const [repo] = await deps.db
			.select()
			.from(repositories)
			.where(eq(repositories.id, row.repositoryId))
			.limit(1);
		if (!repo) return;
		const source = await verifySourcePath(deps.config, repo);
		const dir = workspacePath(deps.config, analysisId, "repo");
		const clone = await cloneAtCommit(deps.config, source, dir, row.baseSha);
		if (!clone.ok)
			throw new ContextError(
				clone.code,
				clone.message,
				clone.code === "context_timeout",
			);
		if (controller.signal.aborted)
			throw new ContextError("cancelled", "The analysis was cancelled");
		let base: { ref: string | null; sha: string } = {
			ref: row.baseRef,
			sha: row.baseSha,
		};
		let head: { ref: string | null; sha: string; kind: "commit" | "tree" };
		if (row.diffSha256) {
			const diff = await readBlobUtf8(blobsDir(deps.config), row.diffSha256);
			if (diff === null)
				throw new ContextError(
					"diff_missing",
					"The supplied diff is no longer stored",
				);
			head = {
				ref: null,
				sha: await applySuppliedDiff(dir, diff),
				kind: "tree",
			};
		} else {
			if (
				!row.headSha ||
				!(await git(dir, ["cat-file", "-e", `${row.headSha}^{commit}`])).ok
			)
				throw new ContextError(
					"commit_not_found",
					"The head commit is not in the repository",
				);
			head = { ref: row.headRef, sha: row.headSha, kind: "commit" };
			if (row.mergeBase) {
				const found = await git(dir, ["merge-base", row.baseSha, row.headSha]);
				const sha = found.stdout.trim();
				if (!found.ok || !/^[0-9a-f]{40}$/.test(sha))
					throw new ContextError(
						"no_merge_base",
						"The two revisions have no common ancestor",
					);
				base = { ref: `merge-base of ${row.baseRef} and ${row.headRef}`, sha };
			}
		}
		const result = await computePatchImpact(deps, {
			repositoryId: repo.id,
			repositoryName: repo.name,
			dir,
			base,
			head,
			mergeBase: row.mergeBase,
			depth: row.options.depth,
			limit: row.options.limit,
			deadline: Date.now() + JOB_BUDGET_MS,
			signal: controller.signal,
			onPhase: (phase) => {
				void progress(phase).catch(() => undefined);
			},
		});
		await deps.db
			.update(patchAnalyses)
			.set({
				status: result.complete ? "completed" : "partial",
				result,
				error: null,
				progress: null,
				finishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(patchAnalyses.id, analysisId));
		await audit(deps.db, {
			workspaceId: row.workspaceId,
			actor: WORKER_ACTOR,
			action: "patch_impact.completed",
			targetType: "patch_analysis",
			targetId: analysisId,
			metadata: {
				files: result.summary.files,
				findings: result.summary.findings,
				complete: result.complete,
			},
		});
	} catch (error) {
		const cancelled =
			controller.signal.aborted ||
			(error instanceof ContextError && error.code === "cancelled");
		const failure = cancelled
			? {
					code: "cancelled",
					message: "The analysis was cancelled",
					retryable: true,
				}
			: error instanceof ContextError
				? {
						code: error.code,
						message: error.message,
						retryable: error.retryable,
					}
				: error instanceof AppError
					? { code: error.code, message: error.message, retryable: false }
					: {
							code: "patch_impact_failed",
							message: "The analysis failed unexpectedly",
							retryable: true,
						};
		await deps.db
			.update(patchAnalyses)
			.set({
				status: cancelled ? "cancelled" : "failed",
				error: failure,
				progress: null,
				finishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(patchAnalyses.id, analysisId));
		deps.log?.("patch analysis did not finish", {
			analysis_id: analysisId,
			code: failure.code,
			...(failure.code === "patch_impact_failed"
				? { error: (error as Error).message }
				: {}),
		});
	} finally {
		clearInterval(poll);
		await rm(scope, { recursive: true, force: true });
	}
}
