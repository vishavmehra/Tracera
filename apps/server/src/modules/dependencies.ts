import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
	DependencySnapshot,
	PrepareDependenciesRequest,
} from "@tracera/contracts";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import { type Db, withTransaction } from "../db/client.ts";
import { dependencySnapshots, repositories } from "../db/schema.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { isPathInside, putBlob } from "../lib/fs.ts";
import { git, resolveCommit } from "../lib/git.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { redactSecrets } from "../lib/redact.ts";
import { enqueueDependencyPrepare } from "../queue.ts";
import type { PrepareResult, SandboxExecutor } from "../sandbox/executor.ts";
import { audit, WORKER_ACTOR } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import { ContextError, verifySourcePath } from "./context.ts";
import { getRepositoryRow } from "./repositories.ts";
import { workspacePath } from "./workspace.ts";

// Dependency preparation. The manifests and lockfile at a
// revision are checked against a policy (npm lockfile v2/v3, every package a sha512-pinned tarball from
// the one configured registry, in sync with package.json), then installed once per repository and exact
// input set in a separate sandbox whose only network path is an allowlisting egress proxy, with
// lifecycle scripts off. The result is sealed (a digest over every installed file) and mounted
// read-only into offline verification runs, which check the seal before use.

export const PREPARATION_VERSION = "deps.v1";

type SnapshotRow = typeof dependencySnapshots.$inferSelect;

export type PolicyCode =
	| "manifest_invalid"
	| "lockfile_missing"
	| "lockfile_invalid"
	| "lockfile_version_unsupported"
	| "lockfile_out_of_sync"
	| "lockfile_too_large"
	| "unsupported_package_manager"
	| "dependency_source_not_allowed"
	| "integrity_missing"
	| "workspace_path_invalid";

/** Reads one repository file (a path relative to the root), or null when it does not exist. */
export type FileReader = (file: string) => Promise<string | null>;

const LIMITS = {
	lockfileBytes: 25 * 1024 * 1024,
	lockEntries: 25_000,
	localPackages: 200,
};

/** Reads a file at a commit through git; only "does not exist" is null, any other failure throws. */
export const gitFileReader =
	(dir: string, commitSha: string): FileReader =>
	async (file) => {
		const result = await git(
			dir,
			["cat-file", "blob", `${commitSha}:${file}`],
			{
				timeoutMs: 30_000,
				maxBytes: LIMITS.lockfileBytes + 1024 * 1024,
			},
		);
		if (result.ok) return result.stdout;
		if (
			/does not exist|not a valid object name|exists on disk, but not in/i.test(
				result.stderr,
			)
		)
			return null;
		throw new ContextError(
			"repository_unreadable",
			`git could not read ${file} at ${commitSha.slice(0, 12)}`,
			true,
		);
	};

/** Reads from a working copy: regular files only, never through a link, never outside the copy. */
export const workTreeReader =
	(dir: string): FileReader =>
	async (file) => {
		const target = path.join(dir, ...file.split("/"));
		const stat = await lstat(target).catch(() => null);
		if (!stat?.isFile()) return null;
		const real = await realpath(target);
		return isPathInside(await realpath(dir), real)
			? readFile(real, "utf8")
			: null;
	};

const NPM_LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json"] as const;
const OTHER_LOCKFILES: ReadonlyArray<[string, string]> = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
];
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
] as const;
/** A relative folder inside the repository: no `.`/`..` segments, no hidden or absolute paths. */
const SAFE_FOLDER =
	/^[A-Za-z0-9@_-][A-Za-z0-9@._-]*(?:\/[A-Za-z0-9@_-][A-Za-z0-9@._-]*)*$/;
const SHA512 = /(?:^|\s)sha512-[A-Za-z0-9+/]{86}==(?:\s|$)/;

type Manifest = Record<string, unknown>;
const isObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> =>
	isObject(value) ? value : {};
const clip = (text: string, max = 160) =>
	text.length > max ? `${text.slice(0, max)}…` : text;

export type LockfileCheck =
	| { ok: true; version: number; packages: number; folders: string[] }
	| { ok: false; code: PolicyCode; errors: string[] };

/**
 * The lockfile policy. Every installed package must be a tarball from the configured registry with a
 * sha512 integrity hash (bundled packages are covered by their parent's tarball); links and local
 * packages must stay inside the repository; the root entry must match package.json exactly.
 */
export function validateNpmLockfile(
	text: string,
	manifest: Manifest,
	registry: URL,
): LockfileCheck {
	const fail = (code: PolicyCode, message: string): LockfileCheck => ({
		ok: false,
		code,
		errors: [message],
	});
	let lock: unknown;
	try {
		lock = JSON.parse(text);
	} catch {
		return fail("lockfile_invalid", "The lockfile is not valid JSON");
	}
	if (!isObject(lock))
		return fail("lockfile_invalid", "The lockfile is not a JSON object");
	const version = lock.lockfileVersion;
	if (version !== 2 && version !== 3)
		return fail(
			"lockfile_version_unsupported",
			`lockfileVersion ${String(version)} is not supported; regenerate the lockfile with npm 7 or later (version 2 or 3)`,
		);
	const packages = lock.packages;
	if (!isObject(packages))
		return fail("lockfile_invalid", "The lockfile has no packages section");
	const keys = Object.keys(packages);
	if (keys.length > LIMITS.lockEntries)
		return fail(
			"lockfile_too_large",
			`The lockfile has ${keys.length} entries; at most ${LIMITS.lockEntries} are prepared`,
		);
	const root = packages[""];
	if (!isObject(root))
		return fail("lockfile_invalid", "The lockfile has no root package entry");

	const errors: Array<[PolicyCode, string]> = [];
	for (const field of DEPENDENCY_FIELDS) {
		const wanted = record(manifest[field]);
		const locked = record(root[field]);
		for (const [name, spec] of Object.entries(wanted))
			if (locked[name] !== spec)
				errors.push([
					"lockfile_out_of_sync",
					`${field}.${name} is ${clip(String(spec), 60)} in package.json but ${
						locked[name] === undefined
							? "missing"
							: clip(String(locked[name]), 60)
					} in the lockfile`,
				]);
		for (const name of Object.keys(locked))
			if (!(name in wanted))
				errors.push([
					"lockfile_out_of_sync",
					`${field}.${name} is in the lockfile but not in package.json`,
				]);
	}

	const base = registry.pathname.endsWith("/")
		? registry.pathname
		: `${registry.pathname}/`;
	const folders = new Set<string>();
	for (const key of keys) {
		if (key === "") continue;
		const entry: unknown = packages[key];
		if (!isObject(entry)) {
			errors.push(["lockfile_invalid", `${clip(key)} is not an object`]);
			continue;
		}
		if (!key.includes("node_modules/")) {
			// A local package: a workspace or a `file:` dependency inside the repository.
			if (!SAFE_FOLDER.test(key))
				errors.push([
					"workspace_path_invalid",
					`${clip(key)} is not a folder inside the repository`,
				]);
			else folders.add(key);
			continue;
		}
		if (entry.link === true) {
			const target: unknown = entry.resolved;
			if (
				typeof target !== "string" ||
				!SAFE_FOLDER.test(target) ||
				!(target in packages)
			)
				errors.push([
					"dependency_source_not_allowed",
					`${clip(key)} links to ${clip(String(target), 80)}, which is not a package folder inside the repository`,
				]);
			continue;
		}
		if (entry.inBundle === true) continue;
		const resolved = entry.resolved;
		if (typeof resolved !== "string") {
			errors.push([
				"dependency_source_not_allowed",
				`${clip(key)} has no registry tarball (resolved)`,
			]);
			continue;
		}
		let url: URL | null = null;
		try {
			url = new URL(resolved);
		} catch {
			url = null;
		}
		if (
			!url ||
			url.protocol !== registry.protocol ||
			url.host !== registry.host ||
			!url.pathname.startsWith(base) ||
			!url.pathname.endsWith(".tgz") ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			errors.push([
				"dependency_source_not_allowed",
				`${clip(key)} comes from ${clip(resolved, 100)}; only ${registry.origin}${base} tarballs are allowed`,
			]);
		if (typeof entry.integrity !== "string" || !SHA512.test(entry.integrity))
			errors.push([
				"integrity_missing",
				`${clip(key)} has no sha512 integrity hash`,
			]);
	}
	if (folders.size > LIMITS.localPackages)
		errors.push([
			"lockfile_too_large",
			`The lockfile names ${folders.size} local packages; at most ${LIMITS.localPackages} are prepared`,
		]);
	const first = errors[0];
	if (first)
		return {
			ok: false,
			code: first[0],
			errors: errors.slice(0, 20).map(([, message]) => message),
		};
	return {
		ok: true,
		version,
		packages: keys.length - 1,
		folders: [...folders].sort(),
	};
}

export type DependencyPlan =
	| { required: false; reason: "no_package_json" | "no_dependencies" }
	| {
			required: true;
			ok: false;
			code: PolicyCode;
			errors: string[];
	  }
	| {
			required: true;
			ok: true;
			manager: "npm";
			lockfile: {
				path: string;
				version: number;
				packages: number;
				sha256: string;
				text: string;
			};
			manifests: Array<{ path: string; sha256: string; text: string }>;
	  };

/** What a revision needs prepared, decided from its manifests and lockfile alone (nothing runs). */
export async function planDependencies(
	read: FileReader,
	registry: URL,
): Promise<DependencyPlan> {
	const fail = (code: PolicyCode, error: string): DependencyPlan => ({
		required: true,
		ok: false,
		code,
		errors: [error],
	});
	const rootText = await read("package.json");
	if (rootText === null) return { required: false, reason: "no_package_json" };
	let root: unknown;
	try {
		root = JSON.parse(rootText);
	} catch {
		return fail("manifest_invalid", "package.json is not valid JSON");
	}
	if (!isObject(root))
		return fail("manifest_invalid", "package.json is not a JSON object");
	const declaredManager =
		typeof root.packageManager === "string"
			? root.packageManager.split("@")[0]
			: null;
	if (declaredManager && declaredManager !== "npm")
		return fail(
			"unsupported_package_manager",
			`package.json declares ${clip(declaredManager, 40)}; Tracera prepares npm lockfiles only`,
		);
	let lockfile: { path: string; text: string } | null = null;
	for (const name of NPM_LOCKFILES) {
		const text = await read(name);
		if (text !== null) {
			lockfile = { path: name, text };
			break;
		}
	}
	const declared = DEPENDENCY_FIELDS.reduce(
		(sum, field) => sum + Object.keys(record(root[field])).length,
		0,
	);
	const hasWorkspaces =
		(Array.isArray(root.workspaces) && root.workspaces.length > 0) ||
		(isObject(root.workspaces) && Array.isArray(root.workspaces.packages));
	if (!lockfile) {
		for (const [name, manager] of OTHER_LOCKFILES)
			if ((await read(name)) !== null)
				return fail(
					"unsupported_package_manager",
					`The repository uses ${manager} (${name}); Tracera prepares npm lockfiles only`,
				);
		if (declared === 0 && !hasWorkspaces)
			return { required: false, reason: "no_dependencies" };
		return fail(
			"lockfile_missing",
			`package.json declares ${declared} dependencies but there is no package-lock.json; Tracera installs only what a lockfile pins`,
		);
	}
	if (Buffer.byteLength(lockfile.text) > LIMITS.lockfileBytes)
		return fail(
			"lockfile_too_large",
			`${lockfile.path} is larger than ${LIMITS.lockfileBytes / 1024 / 1024} MB`,
		);
	const checked = validateNpmLockfile(lockfile.text, root, registry);
	if (!checked.ok)
		return {
			required: true,
			ok: false,
			code: checked.code,
			errors: checked.errors,
		};
	if (checked.packages === 0 && declared === 0)
		return { required: false, reason: "no_dependencies" };
	const manifests = [
		{ path: "package.json", sha256: sha256Hex(rootText), text: rootText },
	];
	for (const folder of checked.folders) {
		const file = `${folder}/package.json`;
		const text = await read(file);
		if (text === null)
			return fail(
				"lockfile_invalid",
				`The lockfile names the local package ${clip(folder)}, but ${clip(file)} is missing`,
			);
		manifests.push({ path: file, sha256: sha256Hex(text), text });
	}
	return {
		required: true,
		ok: true,
		manager: "npm",
		lockfile: {
			path: lockfile.path,
			version: checked.version,
			packages: checked.packages,
			sha256: sha256Hex(lockfile.text),
			text: lockfile.text,
		},
		manifests,
	};
}

/** Identity of a preparation: the repository, the exact inputs, the image, and the registry. */
export function dependencyKey(input: {
	repositoryId: string;
	image: string;
	registry: string;
	lockfile: { path: string; sha256: string };
	manifests: ReadonlyArray<{ path: string; sha256: string }>;
}): string {
	return sha256Hex(
		JSON.stringify([
			PREPARATION_VERSION,
			input.repositoryId,
			input.image,
			input.registry,
			input.lockfile.path,
			input.lockfile.sha256,
			[...input.manifests]
				.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
				.map((manifest) => [manifest.path, manifest.sha256]),
		]),
	);
}

const planKey = (
	plan: Extract<DependencyPlan, { ok: true }>,
	repositoryId: string,
	config: Pick<Config, "sandboxImage" | "dependencies">,
) =>
	dependencyKey({
		repositoryId,
		image: config.sandboxImage,
		registry: config.dependencies.registry,
		lockfile: plan.lockfile,
		manifests: plan.manifests,
	});

/** Whether a copy still has exactly the inputs the snapshot was prepared from. */
export async function snapshotMatches(
	snapshot: Pick<SnapshotRow, "repositoryId" | "cacheKey">,
	read: FileReader,
	config: Pick<Config, "sandboxImage" | "dependencies">,
): Promise<boolean> {
	const plan = await planDependencies(
		read,
		new URL(config.dependencies.registry),
	);
	return (
		plan.required &&
		plan.ok &&
		planKey(plan, snapshot.repositoryId, config) === snapshot.cacheKey
	);
}

// ---- Preparation -----------------------------------------------------------------------------

type PrepareDeps = {
	db: Db;
	config: Config;
	executor: SandboxExecutor;
	log?: (message: string, fields: Record<string, unknown>) => void;
};

export type EnsureResult =
	| { status: "not_required"; reason: string }
	| { status: "blocked"; code: string; detail: string }
	| { status: "failed"; snapshotId: string; code: string; detail: string }
	| { status: "ready"; snapshot: SnapshotRow; reused: boolean };

const blobsDir = (config: Pick<Config, "dataDir">) =>
	path.join(config.dataDir, "blobs");
const HEARTBEAT_MS = 30_000;
const STALE_MS = 5 * 60_000;
const WAIT_POLL_MS = 2_000;
const CLAIMABLE = ["queued", "failed", "cancelled", "expired"] as const;

const FAILURE_CODES: Record<
	Exclude<PrepareResult["status"], "succeeded">,
	string
> = {
	failed: "install_failed",
	timed_out: "preparation_timeout",
	cancelled: "cancelled",
	limit_exceeded: "resource_limit_exceeded",
	executor_error: "sandbox_error",
};

/** Writes only the manifests and the lockfile into a fresh input directory for the seed container. */
async function writeInput(
	config: Pick<Config, "dataDir">,
	snapshotId: string,
	plan: Extract<DependencyPlan, { ok: true }>,
): Promise<string> {
	const dir = workspacePath(config, snapshotId, "input");
	await rm(dir, { recursive: true, force: true });
	for (const file of [
		...plan.manifests,
		{ path: plan.lockfile.path, text: plan.lockfile.text },
	]) {
		const target = path.join(dir, ...file.path.split("/"));
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, file.text);
	}
	return dir;
}

/** The first npm error code in the install output (EINTEGRITY, E404, ETIMEDOUT, …), if any. */
export function npmErrorCode(output: string): string | null {
	return /npm (?:ERR!|error) code ([A-Z0-9_]{2,40})/.exec(output)?.[1] ?? null;
}

/** Runs one claimed preparation in the sandbox and records the outcome. The row must be `preparing`. */
async function runClaimed(
	deps: PrepareDeps,
	row: SnapshotRow,
	plan: Extract<DependencyPlan, { ok: true }>,
	signal?: AbortSignal,
): Promise<EnsureResult> {
	const touch = setInterval(() => {
		deps.db
			.update(dependencySnapshots)
			.set({ updatedAt: new Date() })
			.where(eq(dependencySnapshots.id, row.id))
			.catch(() => undefined);
	}, HEARTBEAT_MS);
	let result: PrepareResult;
	try {
		const input = await writeInput(deps.config, row.id, plan);
		result = await deps.executor.prepare(
			{
				prepId: `${row.id}-${row.attempts}`,
				scope: row.repositoryId,
				input,
				registry: row.registry,
				timeoutMs: deps.config.dependencies.timeoutMs,
			},
			signal,
		);
	} finally {
		clearInterval(touch);
		await rm(workspacePath(deps.config, row.id), {
			recursive: true,
			force: true,
		});
	}
	const output = redactSecrets(
		[result.stdout, result.stderr].filter(Boolean).join("\n"),
		{ redactEmails: true },
	).text;
	const log = output
		? (await putBlob(blobsDir(deps.config), Buffer.from(output, "utf8"))).sha256
		: null;
	const finishedAt = new Date();
	if (result.status === "succeeded" && result.volume && result.seal) {
		const [ready] = await deps.db
			.update(dependencySnapshots)
			.set({
				status: "ready",
				volume: result.volume,
				seal: result.seal,
				egress: result.egress,
				logSha256: log,
				durationMs: result.durationMs,
				error: null,
				finishedAt,
				lastUsedAt: finishedAt,
				updatedAt: finishedAt,
			})
			.where(eq(dependencySnapshots.id, row.id))
			.returning();
		await audit(deps.db, {
			workspaceId: row.workspaceId,
			actor: WORKER_ACTOR,
			action: "dependencies.prepared",
			targetType: "dependency_snapshot",
			targetId: row.id,
			metadata: {
				repository_id: row.repositoryId,
				digest: result.seal.digest,
				files: result.seal.files,
				packages: plan.lockfile.packages,
				egress_allowed: result.egress.allowed,
				egress_denied: result.egress.denied,
				duration_ms: result.durationMs,
			},
		});
		if (!ready)
			throw new Error("dependency snapshot vanished during preparation");
		return { status: "ready", snapshot: ready, reused: false };
	}
	const code =
		FAILURE_CODES[
			result.status === "succeeded" ? "executor_error" : result.status
		];
	const npmCode = npmErrorCode(output);
	const message =
		code === "install_failed"
			? `npm ci failed${npmCode ? ` (${npmCode})` : ""}`
			: code === "sandbox_error"
				? `The preparation sandbox failed (${result.detail ?? "unknown"})`
				: code === "preparation_timeout"
					? "Dependency installation timed out"
					: code === "resource_limit_exceeded"
						? "Dependency installation exceeded its memory or process limit"
						: "Dependency preparation was cancelled";
	await deps.db
		.update(dependencySnapshots)
		.set({
			status: code === "cancelled" ? "cancelled" : "failed",
			volume: null,
			seal: null,
			egress: result.egress,
			logSha256: log,
			durationMs: result.durationMs,
			error: {
				code,
				message,
				// A lockfile whose hashes do not match its tarballs fails the same way every time.
				retryable: !(code === "install_failed" && npmCode === "EINTEGRITY"),
			},
			finishedAt,
			updatedAt: finishedAt,
		})
		.where(eq(dependencySnapshots.id, row.id));
	await audit(deps.db, {
		workspaceId: row.workspaceId,
		actor: WORKER_ACTOR,
		action: "dependencies.preparation_failed",
		targetType: "dependency_snapshot",
		targetId: row.id,
		metadata: {
			repository_id: row.repositoryId,
			code,
			npm_code: npmCode,
			egress_denied: result.egress.denied,
			duration_ms: result.durationMs,
		},
	});
	return { status: "failed", snapshotId: row.id, code, detail: message };
}

/** Claims a snapshot for preparation (one preparer at a time); null when someone else holds it. */
async function claim(db: Db, id: string): Promise<SnapshotRow | null> {
	const [claimed] = await db
		.update(dependencySnapshots)
		.set({
			status: "preparing",
			attempts: sql`${dependencySnapshots.attempts} + 1`,
			error: null,
			cancelRequestedAt: null,
			startedAt: new Date(),
			finishedAt: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(dependencySnapshots.id, id),
				inArray(dependencySnapshots.status, [...CLAIMABLE]),
			),
		)
		.returning();
	return claimed ?? null;
}

const snapshotValues = (
	plan: Extract<DependencyPlan, { ok: true }>,
	input: { workspaceId: string; repositoryId: string; commitSha: string },
	config: Pick<Config, "sandboxImage" | "dependencies">,
	cacheKey: string,
) => ({
	id: newId("dep"),
	workspaceId: input.workspaceId,
	repositoryId: input.repositoryId,
	commitSha: input.commitSha,
	cacheKey,
	manager: plan.manager,
	lockfile: {
		path: plan.lockfile.path,
		version: plan.lockfile.version,
		sha256: plan.lockfile.sha256,
		packages: plan.lockfile.packages,
	},
	manifests: plan.manifests.map(({ path, sha256 }) => ({ path, sha256 })),
	registry: config.dependencies.registry,
	image: config.sandboxImage,
	status: "queued" as const,
});

/**
 * The prepared dependencies of a revision for an investigation: reused when an identical, intact
 * snapshot exists (its seal is re-checked), prepared otherwise. A seal that no longer matches is a
 * tampering signal: the snapshot is failed and the caller is blocked, never handed altered files. A
 * failure that repeats deterministically (a lockfile whose hashes do not match) is not re-run here.
 */
export async function ensureDependencySnapshot(
	deps: PrepareDeps,
	input: {
		workspaceId: string;
		repositoryId: string;
		commitSha: string;
		read: FileReader;
		signal?: AbortSignal;
	},
): Promise<EnsureResult> {
	const registry = new URL(deps.config.dependencies.registry);
	const plan = await planDependencies(input.read, registry);
	if (!plan.required) return { status: "not_required", reason: plan.reason };
	if (!plan.ok)
		return {
			status: "blocked",
			code: plan.code,
			detail: plan.errors.join("; "),
		};
	const sandbox = await deps.executor.status();
	if (!sandbox.available)
		return {
			status: "blocked",
			code: "sandbox_unavailable",
			detail: `the preparation sandbox is unavailable (${sandbox.detail ?? sandbox.kind})`,
		};
	const cacheKey = planKey(plan, input.repositoryId, deps.config);
	await deps.db
		.insert(dependencySnapshots)
		.values(snapshotValues(plan, input, deps.config, cacheKey))
		.onConflictDoNothing();
	for (;;) {
		if (input.signal?.aborted)
			return {
				status: "blocked",
				code: "cancelled",
				detail: "the investigation stopped before dependencies were prepared",
			};
		const [row] = await deps.db
			.select()
			.from(dependencySnapshots)
			.where(
				and(
					eq(dependencySnapshots.repositoryId, input.repositoryId),
					eq(dependencySnapshots.cacheKey, cacheKey),
				),
			)
			.limit(1);
		if (!row) throw new Error("dependency snapshot row missing after insert");
		if (row.status === "ready") {
			const checked = await verifySnapshot(deps, row, input.signal);
			if (checked.ok) return { status: "ready", snapshot: row, reused: true };
			if (checked.code === "dependency_snapshot_tampered")
				return {
					status: "failed",
					snapshotId: row.id,
					code: checked.code,
					detail: checked.detail,
				};
			continue; // the artifact was gone, so the row expired: the next round prepares it again
		}
		if (row.status === "failed" && row.error && !row.error.retryable)
			return {
				status: "failed",
				snapshotId: row.id,
				code: row.error.code,
				detail: row.error.message,
			};
		if (row.status === "preparing") {
			if (Date.now() - row.updatedAt.getTime() > STALE_MS)
				await deps.db
					.update(dependencySnapshots)
					.set({
						status: "failed",
						error: {
							code: "job_lost",
							message: "The previous preparation stopped responding",
							retryable: true,
						},
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(dependencySnapshots.id, row.id),
							eq(dependencySnapshots.status, "preparing"),
						),
					);
			else await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
			continue;
		}
		const claimed = await claim(deps.db, row.id);
		if (claimed) return runClaimed(deps, claimed, plan, input.signal);
	}
}

/**
 * Re-checks a ready snapshot's seal read-only. A missing artifact expires the row (it can be prepared
 * again); a different digest fails it as tampered, is audited, and discards the artifact.
 */
export async function verifySnapshot(
	deps: Pick<PrepareDeps, "db" | "executor">,
	row: SnapshotRow,
	signal?: AbortSignal,
): Promise<
	| { ok: true }
	| {
			ok: false;
			code: "dependency_snapshot_missing" | "dependency_snapshot_tampered";
			detail: string;
	  }
> {
	const seal = row.volume
		? await deps.executor.inspectArtifact(row.volume, signal)
		: null;
	if (seal && seal.digest === row.seal?.digest) {
		await deps.db
			.update(dependencySnapshots)
			.set({ lastUsedAt: new Date() })
			.where(eq(dependencySnapshots.id, row.id));
		return { ok: true };
	}
	if (!seal) {
		await deps.db
			.update(dependencySnapshots)
			.set({ status: "expired", volume: null, updatedAt: new Date() })
			.where(
				and(
					eq(dependencySnapshots.id, row.id),
					eq(dependencySnapshots.status, "ready"),
				),
			);
		return {
			ok: false,
			code: "dependency_snapshot_missing",
			detail: "the prepared dependency artifact no longer exists",
		};
	}
	await deps.db
		.update(dependencySnapshots)
		.set({
			status: "failed",
			volume: null,
			error: {
				code: "dependency_snapshot_tampered",
				message: "The prepared dependencies no longer matched their seal",
				retryable: true,
			},
			updatedAt: new Date(),
		})
		.where(eq(dependencySnapshots.id, row.id));
	await audit(deps.db, {
		workspaceId: row.workspaceId,
		actor: WORKER_ACTOR,
		action: "dependencies.seal_mismatch",
		targetType: "dependency_snapshot",
		targetId: row.id,
		metadata: { expected: row.seal?.digest ?? null, found: seal.digest },
	});
	if (row.volume) await deps.executor.removeArtifact(row.volume);
	return {
		ok: false,
		code: "dependency_snapshot_tampered",
		detail:
			"the prepared dependencies no longer matched their seal and were discarded",
	};
}

// ---- API and job -----------------------------------------------------------------------------

function toSnapshotView(row: SnapshotRow): DependencySnapshot {
	return {
		id: row.id,
		repository_id: row.repositoryId,
		commit_sha: row.commitSha,
		status: row.status,
		manager: row.manager,
		lockfile: row.lockfile,
		manifests: row.manifests.map((manifest) => manifest.path),
		registry: row.registry,
		image: row.image,
		artifact: row.seal
			? {
					digest: row.seal.digest,
					files: row.seal.files,
					bytes: row.seal.bytes,
					mounts: row.seal.mounts,
				}
			: null,
		egress: row.egress ?? null,
		attempts: row.attempts,
		duration_ms: row.durationMs ?? null,
		error: row.error ?? null,
		cancel_requested_at: row.cancelRequestedAt?.toISOString() ?? null,
		created_at: row.createdAt.toISOString(),
		started_at: row.startedAt?.toISOString() ?? null,
		finished_at: row.finishedAt?.toISOString() ?? null,
		last_used_at: row.lastUsedAt?.toISOString() ?? null,
	};
}

const toAppError = (error: unknown) =>
	error instanceof ContextError
		? new AppError(422, error.code, error.message)
		: error;

/**
 * Requests preparation of the dependencies locked at a revision. The policy is checked here, against
 * the revision's files read through git, so a refused lockfile is a 422 at once; identical inputs
 * return the existing snapshot (200) unless it failed, was cancelled, or expired (queued again, 202).
 */
export async function createDependencySnapshot(
	deps: { db: Db; pool: pg.Pool; boss: PgBoss; config: Config },
	ctx: AuthContext,
	repositoryId: string,
	input: PrepareDependenciesRequest,
	requestId: string,
) {
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
	const plan = await planDependencies(
		gitFileReader(source, commitSha),
		new URL(deps.config.dependencies.registry),
	).catch((error) => {
		throw toAppError(error);
	});
	if (!plan.required)
		throw new AppError(
			422,
			"dependencies_not_required",
			plan.reason === "no_package_json"
				? "The revision has no package.json"
				: "The revision declares no dependencies",
		);
	if (!plan.ok) throw new AppError(422, plan.code, plan.errors.join(" "));
	const cacheKey = planKey(plan, repo.id, deps.config);
	return withTransaction(deps.pool, async ({ db, queueDb }) => {
		const inserted = await db
			.insert(dependencySnapshots)
			.values({
				...snapshotValues(
					plan,
					{ workspaceId: ctx.workspaceId, repositoryId: repo.id, commitSha },
					deps.config,
					cacheKey,
				),
				createdBy: ctx.userId,
			})
			.onConflictDoNothing()
			.returning({ id: dependencySnapshots.id });
		const [row] = await db
			.select()
			.from(dependencySnapshots)
			.where(
				and(
					eq(dependencySnapshots.repositoryId, repo.id),
					eq(dependencySnapshots.cacheKey, cacheKey),
				),
			)
			.for("update")
			.limit(1);
		if (!row) throw new Error("dependency snapshot row missing after insert");
		const requeue = ["failed", "cancelled", "expired"].includes(row.status);
		if (inserted.length === 0 && !requeue)
			return { status: 200 as const, snapshot: toSnapshotView(row) };
		const [queued] = await db
			.update(dependencySnapshots)
			.set({
				status: "queued",
				error: null,
				cancelRequestedAt: null,
				updatedAt: new Date(),
			})
			.where(eq(dependencySnapshots.id, row.id))
			.returning();
		await enqueueDependencyPrepare(deps.boss, queueDb, { snapshotId: row.id });
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "dependencies.requested",
			targetType: "dependency_snapshot",
			targetId: row.id,
			metadata: {
				repository_id: repo.id,
				commit_sha: commitSha,
				lockfile_sha256: plan.lockfile.sha256,
			},
			requestId,
		});
		return {
			status: 202 as const,
			snapshot: toSnapshotView(queued ?? row),
		};
	});
}

async function snapshotRow(db: Db, workspaceId: string, id: string) {
	const [row] = await db
		.select()
		.from(dependencySnapshots)
		.where(
			and(
				eq(dependencySnapshots.id, id),
				eq(dependencySnapshots.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(
			404,
			"not_found",
			`Dependency snapshot ${id} was not found`,
		);
	return row;
}

export async function getDependencySnapshot(
	db: Db,
	workspaceId: string,
	id: string,
) {
	return toSnapshotView(await snapshotRow(db, workspaceId, id));
}

export async function listDependencySnapshots(
	db: Db,
	workspaceId: string,
	repositoryId: string,
	limit: number,
) {
	await getRepositoryRow(db, workspaceId, repositoryId);
	const rows = await db
		.select()
		.from(dependencySnapshots)
		.where(
			and(
				eq(dependencySnapshots.workspaceId, workspaceId),
				eq(dependencySnapshots.repositoryId, repositoryId),
			),
		)
		.orderBy(desc(dependencySnapshots.createdAt))
		.limit(limit);
	return rows.map(toSnapshotView);
}

/** Stops a queued preparation at once and a running one at its next check (about 2 s). */
export async function cancelDependencySnapshot(
	deps: { db: Db },
	ctx: AuthContext,
	id: string,
	requestId: string,
) {
	await snapshotRow(deps.db, ctx.workspaceId, id);
	const now = new Date();
	const queued = sql`${dependencySnapshots.status} = 'queued'`;
	const [updated] = await deps.db
		.update(dependencySnapshots)
		.set({
			status: sql`case when ${queued} then 'cancelled'::dependency_snapshot_status else ${dependencySnapshots.status} end`,
			cancelRequestedAt: now,
			error: sql`case when ${queued} then ${JSON.stringify({ code: "cancelled", message: "Cancelled before it started", retryable: true })}::jsonb else ${dependencySnapshots.error} end`,
			finishedAt: sql`case when ${queued} then now() else ${dependencySnapshots.finishedAt} end`,
			updatedAt: now,
		})
		.where(
			and(
				eq(dependencySnapshots.id, id),
				eq(dependencySnapshots.workspaceId, ctx.workspaceId),
				inArray(dependencySnapshots.status, ["queued", "preparing"]),
			),
		)
		.returning();
	if (!updated)
		throw new AppError(
			409,
			"invalid_state",
			`Dependency snapshot ${id} is not being prepared`,
		);
	await audit(deps.db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: "dependencies.cancel_requested",
		targetType: "dependency_snapshot",
		targetId: id,
		metadata: {},
		requestId,
	});
	return toSnapshotView(updated);
}

/** The `dependencies.prepare` job. Anything but a queued snapshot is ignored (idempotent redelivery). */
export async function runDependencySnapshotJob(
	deps: PrepareDeps,
	snapshotId: string,
): Promise<void> {
	const [row] = await deps.db
		.select()
		.from(dependencySnapshots)
		.where(eq(dependencySnapshots.id, snapshotId))
		.limit(1);
	if (row?.status !== "queued") return;
	const fail = async (code: string, message: string, retryable: boolean) => {
		await deps.db
			.update(dependencySnapshots)
			.set({
				status: "failed",
				error: { code, message, retryable },
				finishedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(dependencySnapshots.id, snapshotId),
					eq(dependencySnapshots.status, "queued"),
				),
			);
	};
	const sandbox = await deps.executor.status();
	if (!sandbox.available)
		return fail(
			"sandbox_unavailable",
			`The preparation sandbox is unavailable (${sandbox.detail ?? sandbox.kind})`,
			true,
		);
	const [repo] = await deps.db
		.select()
		.from(repositories)
		.where(eq(repositories.id, row.repositoryId))
		.limit(1);
	if (!repo) return;
	let plan: DependencyPlan;
	try {
		const source = await verifySourcePath(deps.config, repo);
		plan = await planDependencies(
			gitFileReader(source, row.commitSha),
			new URL(row.registry),
		);
	} catch {
		return fail(
			"repository_unavailable",
			"The repository is unavailable",
			true,
		);
	}
	// The inputs were checked at request time; a different result now means they changed underneath.
	if (
		!plan.required ||
		!plan.ok ||
		planKey(plan, repo.id, deps.config) !== row.cacheKey
	)
		return fail(
			"dependency_inputs_changed",
			"The revision's manifests or lockfile no longer match the request",
			false,
		);
	const claimed = await claim(deps.db, row.id);
	if (!claimed) return;
	const controller = new AbortController();
	const poll = setInterval(() => {
		deps.db
			.select({ cancel: dependencySnapshots.cancelRequestedAt })
			.from(dependencySnapshots)
			.where(eq(dependencySnapshots.id, snapshotId))
			.limit(1)
			.then(([state]) => {
				if (state?.cancel) controller.abort();
			})
			.catch(() => undefined);
	}, 2000);
	try {
		const outcome = await runClaimed(deps, claimed, plan, controller.signal);
		deps.log?.("dependency preparation finished", {
			snapshot_id: snapshotId,
			status: outcome.status,
		});
	} finally {
		clearInterval(poll);
	}
}

/** Worker-loss recovery: a preparation whose heartbeat stopped is failed as retryable. */
export async function recoverLostDependencySnapshots(db: Db): Promise<number> {
	const lost = await db
		.update(dependencySnapshots)
		.set({
			status: "failed",
			error: {
				code: "job_lost",
				message:
					"The preparation stopped responding (worker crash or timeout); request it again",
				retryable: true,
			},
			finishedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(dependencySnapshots.status, "preparing"),
				lt(dependencySnapshots.updatedAt, new Date(Date.now() - STALE_MS)),
			),
		)
		.returning({ id: dependencySnapshots.id });
	return lost.length;
}

/**
 * Retention: keeps the most recently used ready snapshots per repository (TRACERA_DEPS_KEEP), expires
 * the rest, and removes artifacts no snapshot references once they are an hour old (leftovers of
 * crashed preparations). Returns how many artifacts were removed.
 */
export async function cleanupDependencyArtifacts(deps: {
	db: Db;
	config: Pick<Config, "dependencies">;
	executor: SandboxExecutor;
}): Promise<number> {
	const ready = await deps.db
		.select({
			id: dependencySnapshots.id,
			repositoryId: dependencySnapshots.repositoryId,
			volume: dependencySnapshots.volume,
		})
		.from(dependencySnapshots)
		.where(eq(dependencySnapshots.status, "ready"))
		.orderBy(desc(dependencySnapshots.lastUsedAt));
	const kept = new Map<string, number>();
	let removed = 0;
	for (const row of ready) {
		const count = (kept.get(row.repositoryId) ?? 0) + 1;
		kept.set(row.repositoryId, count);
		if (count <= deps.config.dependencies.keep) continue;
		await deps.db
			.update(dependencySnapshots)
			.set({ status: "expired", volume: null, updatedAt: new Date() })
			.where(
				and(
					eq(dependencySnapshots.id, row.id),
					eq(dependencySnapshots.status, "ready"),
				),
			);
		if (row.volume) {
			await deps.executor.removeArtifact(row.volume);
			removed += 1;
		}
	}
	const live = await deps.db
		.select({
			id: dependencySnapshots.id,
			status: dependencySnapshots.status,
			volume: dependencySnapshots.volume,
		})
		.from(dependencySnapshots)
		.where(inArray(dependencySnapshots.status, ["ready", "preparing"]));
	const referenced = new Set(
		live.flatMap((row) => (row.volume ? [row.volume] : [])),
	);
	const inProgress = live
		.filter((row) => row.status === "preparing")
		.map((row) => `tracera-deps-${row.id}-`);
	for (const artifact of await deps.executor.listArtifacts()) {
		const old =
			artifact.createdAt !== null &&
			Date.now() - artifact.createdAt.getTime() > 60 * 60_000;
		if (
			old &&
			!referenced.has(artifact.volume) &&
			!inProgress.some((prefix) => artifact.volume.startsWith(prefix))
		) {
			await deps.executor.removeArtifact(artifact.volume);
			removed += 1;
		}
	}
	return removed;
}
