import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import {
	ACTIVE_INVESTIGATION_STATUSES,
	type CreateRepositoryRequest,
	type UpdateRepositoryRequest,
} from "@tracera/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import type pg from "pg";
import type { Config } from "../config.ts";
import { type Db, pgErrorCode, withTransaction } from "../db/client.ts";
import {
	investigations,
	repositories,
	repositorySnapshots,
} from "../db/schema.ts";
import { isPathInside } from "../lib/fs.ts";
import {
	currentBranch,
	gitTopLevel,
	isGitWorkTree,
	resolveCommit,
} from "../lib/git.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { audit } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import { verifySourcePath } from "./context.ts";
import { mirrorPath, removeWorkspace } from "./workspace.ts";

type RepositoryRow = typeof repositories.$inferSelect;
type SnapshotRow = typeof repositorySnapshots.$inferSelect;
type Source = CreateRepositoryRequest["source"];

/**
 * Where a repository's source comes from. A provider resolves the registration input to a local git
 * work tree that Tracera may clone from; everything after that (clone, index, sandbox) is shared.
 * Remote providers (HTTPS clones, hosted Git APIs) would plug in here; none exists yet.
 */
type SourceAdapter = {
	locate(
		config: Config,
		source: Source,
	): Promise<{ path: string; synthetic: boolean }>;
};

const realOrNull = (target: string) => realpath(target).catch(() => null);

const SOURCE_ADAPTERS: Record<Source["type"], SourceAdapter> = {
	local_path: {
		async locate(config, source) {
			const real =
				source.type === "local_path" ? await realOrNull(source.path) : null;
			const roots = (
				await Promise.all(config.repoRoots.map((root) => realOrNull(root)))
			).filter((root): root is string => root !== null);
			if (
				!real ||
				!roots.some((root) => isPathInside(root, real)) ||
				isPathInside(config.sourceRoot, real) ||
				isPathInside(config.dataDir, real)
			)
				throw new AppError(
					422,
					"repository_path_not_allowed",
					"The path must exist inside TRACERA_REPO_ROOTS and must not be inside the Tracera source tree or data directory",
				);
			return { path: real, synthetic: false };
		},
	},
	fixture: {
		async locate(config, source) {
			// Fixtures are materialized by `npm run bench:setup` under <dataDir>/fixtures, never in the source tree.
			const fixturesRoot = path.join(config.dataDir, "fixtures");
			const real =
				source.type === "fixture"
					? await realOrNull(path.join(fixturesRoot, source.fixture))
					: null;
			const realFixtures = await realOrNull(fixturesRoot);
			if (!real || !realFixtures)
				throw new AppError(
					422,
					"fixture_not_prepared",
					"Run `npm run bench:setup` to create the fixture repository first",
				);
			if (
				!isPathInside(realFixtures, real) ||
				isPathInside(config.sourceRoot, real)
			)
				throw new AppError(
					422,
					"repository_path_not_allowed",
					"The fixture must be inside the data directory's fixtures folder",
				);
			return { path: real, synthetic: true };
		},
	},
	git_url: {
		async locate() {
			throw new AppError(
				422,
				"source_type_not_available",
				"Remote Git repositories are not supported yet; clone the repository under TRACERA_REPO_ROOTS and register the local path",
			);
		},
	},
};

/** Registers a repository for indexing and investigations (owner session only; checked by the route). */
export async function registerRepository(
	deps: { db: Db; config: Config },
	ctx: AuthContext,
	input: CreateRepositoryRequest,
	requestId: string,
) {
	const { path: real, synthetic } = await SOURCE_ADAPTERS[
		input.source.type
	].locate(deps.config, input.source);
	const top = (await isGitWorkTree(real)) ? await gitTopLevel(real) : null;
	if (!top || !(isPathInside(top, real) && isPathInside(real, top))) {
		throw new AppError(
			422,
			"not_a_git_repository",
			"The path must be the root of a git work tree",
		);
	}
	const defaultBranch =
		input.default_branch ?? (await currentBranch(real)) ?? "main";
	if (!(await resolveCommit(real, defaultBranch))) {
		throw new AppError(
			422,
			"commit_not_found",
			`Branch ${defaultBranch} does not resolve to a commit`,
		);
	}
	const id = newId("repo");
	try {
		await deps.db.insert(repositories).values({
			id,
			workspaceId: ctx.workspaceId,
			name: input.name,
			sourceType: input.source.type,
			sourceRef: real,
			defaultBranch,
			synthetic,
			commands: input.commands,
			app: input.app ?? null,
			allowInstallScripts: input.allow_install_scripts ?? false,
			createdBy: ctx.userId,
		});
	} catch (error) {
		if (pgErrorCode(error) === "23505")
			throw new AppError(
				409,
				"conflict",
				`A repository named ${input.name} already exists`,
			);
		throw error;
	}
	await audit(deps.db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: "repository.registered",
		targetType: "repository",
		targetId: id,
		metadata: {
			source_type: input.source.type,
			allow_install_scripts: input.allow_install_scripts ?? false,
		},
		requestId,
	});
	return getRepository(deps.db, ctx.workspaceId, id);
}

export async function getRepositoryRow(
	db: Db,
	workspaceId: string,
	id: string,
): Promise<RepositoryRow> {
	const [row] = await db
		.select()
		.from(repositories)
		.where(
			and(eq(repositories.id, id), eq(repositories.workspaceId, workspaceId)),
		)
		.limit(1);
	if (!row)
		throw new AppError(404, "not_found", `Repository ${id} was not found`);
	return row;
}

/** The newest snapshot of each repository, in one query. */
async function latestSnapshots(
	db: Db,
	repositoryIds: string[],
): Promise<Map<string, SnapshotRow>> {
	if (repositoryIds.length === 0) return new Map();
	const rows = await db
		.selectDistinctOn([repositorySnapshots.repositoryId])
		.from(repositorySnapshots)
		.where(inArray(repositorySnapshots.repositoryId, repositoryIds))
		.orderBy(
			repositorySnapshots.repositoryId,
			desc(repositorySnapshots.createdAt),
		);
	return new Map(rows.map((row) => [row.repositoryId, row]));
}

export async function getRepository(db: Db, workspaceId: string, id: string) {
	const row = await getRepositoryRow(db, workspaceId, id);
	return toView(row, (await latestSnapshots(db, [row.id])).get(row.id));
}

export async function listRepositories(db: Db, workspaceId: string) {
	const rows = await db
		.select()
		.from(repositories)
		.where(eq(repositories.workspaceId, workspaceId))
		.orderBy(desc(repositories.createdAt));
	const latest = await latestSnapshots(
		db,
		rows.map((row) => row.id),
	);
	return rows.map((row) => toView(row, latest.get(row.id)));
}

/** Owner-only changes to a registration. A new default branch must resolve in the repository now. */
export async function updateRepository(
	deps: { db: Db; config: Config },
	ctx: AuthContext,
	id: string,
	input: UpdateRepositoryRequest,
	requestId: string,
) {
	const row = await getRepositoryRow(deps.db, ctx.workspaceId, id);
	if (input.default_branch) {
		const source = await verifySourcePath(deps.config, row).catch(() => {
			throw new AppError(
				422,
				"repository_unavailable",
				"The registered repository path is no longer available",
			);
		});
		if (!(await resolveCommit(source, input.default_branch)))
			throw new AppError(
				422,
				"commit_not_found",
				`Branch ${input.default_branch} does not resolve to a commit`,
			);
	}
	try {
		await deps.db
			.update(repositories)
			.set({
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.default_branch !== undefined
					? { defaultBranch: input.default_branch }
					: {}),
				...(input.commands !== undefined ? { commands: input.commands } : {}),
				...(input.app !== undefined ? { app: input.app } : {}),
				updatedAt: new Date(),
			})
			.where(eq(repositories.id, row.id));
	} catch (error) {
		if (pgErrorCode(error) === "23505")
			throw new AppError(
				409,
				"conflict",
				`A repository named ${input.name} already exists`,
			);
		throw error;
	}
	await audit(deps.db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: "repository.updated",
		targetType: "repository",
		targetId: row.id,
		metadata: { fields: Object.keys(input) },
		requestId,
	});
	return getRepository(deps.db, ctx.workspaceId, row.id);
}

/**
 * Deletes a repository and everything derived from it: snapshots, graph data, assessments, and its
 * finished investigations with their evidence. Refused while an investigation is active. The
 * registered working tree is never touched; Tracera's own mirrors and workspaces are removed.
 */
export async function deleteRepository(
	deps: { db: Db; pool: pg.Pool; config: Config },
	ctx: AuthContext,
	id: string,
	confirm: string,
	requestId: string,
) {
	const row = await getRepositoryRow(deps.db, ctx.workspaceId, id);
	if (confirm !== row.name)
		throw new AppError(
			422,
			"confirmation_mismatch",
			"Pass the repository's name as `confirm` to delete it",
		);
	const removed = await withTransaction(deps.pool, async ({ db }) => {
		const owned = await db
			.select({ id: investigations.id, status: investigations.status })
			.from(investigations)
			.where(eq(investigations.repositoryId, row.id))
			.for("update");
		if (
			owned.some((investigation) =>
				(ACTIVE_INVESTIGATION_STATUSES as readonly string[]).includes(
					investigation.status,
				),
			)
		)
			throw new AppError(
				409,
				"repository_in_use",
				"Cancel or finish the repository's active investigations first",
			);
		const snapshots = await db
			.select({ id: repositorySnapshots.id })
			.from(repositorySnapshots)
			.where(eq(repositorySnapshots.repositoryId, row.id));
		if (owned.length > 0)
			await db.delete(investigations).where(
				inArray(
					investigations.id,
					owned.map((investigation) => investigation.id),
				),
			);
		await db.delete(repositories).where(eq(repositories.id, row.id));
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "repository.deleted",
			targetType: "repository",
			targetId: row.id,
			metadata: {
				investigations_deleted: owned.length,
				snapshots_deleted: snapshots.length,
			},
			requestId,
		});
		return {
			investigations: owned.map((investigation) => investigation.id),
			snapshots: snapshots.map((snapshot) => snapshot.id),
		};
	});
	await Promise.all([
		...removed.snapshots.map((snapshot) =>
			rm(mirrorPath(deps.config, snapshot), { recursive: true, force: true }),
		),
		...removed.investigations.map((investigation) =>
			removeWorkspace(deps.config, investigation).catch(() => undefined),
		),
	]);
	return {
		deleted: {
			repository_id: row.id,
			investigations: removed.investigations.length,
			snapshots: removed.snapshots.length,
		},
	};
}

function toView(row: RepositoryRow, latest: SnapshotRow | undefined) {
	return {
		id: row.id,
		name: row.name,
		source_type: row.sourceType,
		source_display: row.sourceRef,
		default_branch: row.defaultBranch,
		synthetic: row.synthetic,
		commands: {
			install: row.commands.install,
			test: row.commands.test,
			typecheck: row.commands.typecheck ?? null,
			lint: row.commands.lint ?? null,
			build: row.commands.build ?? null,
			start: row.commands.start ?? null,
		},
		app: row.app ?? null,
		allow_install_scripts: row.allowInstallScripts,
		/** The newest snapshot's state; graph queries use the newest usable one (see /profile). */
		index: latest
			? {
					snapshot_id: latest.id,
					status: latest.status,
					commit_sha: latest.commitSha,
					coverage_complete:
						latest.coverage === null ? null : latest.coverage.complete === true,
					progress: latest.progress ?? null,
					error: latest.error ?? null,
					created_at: latest.createdAt.toISOString(),
					finished_at: latest.finishedAt?.toISOString() ?? null,
				}
			: null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}
