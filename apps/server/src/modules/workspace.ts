import {
	lstat,
	mkdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.ts";
import { isPathInside } from "../lib/fs.ts";
import { git } from "../lib/git.ts";

// Tracera-owned workspaces under <dataDir>/workspaces/<scope>/<name>. The registered repository is
// only ever read by `git clone`; everything else (plumbing, edits, diffs) happens in these copies.

const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}$/;

export const workspacesRoot = (config: Pick<Config, "dataDir">) =>
	path.join(config.dataDir, "workspaces");

export function workspacePath(
	config: Pick<Config, "dataDir">,
	scope: string,
	name?: string,
): string {
	if (
		!SAFE_SEGMENT.test(scope) ||
		(name !== undefined && !SAFE_SEGMENT.test(name))
	)
		throw new Error("Invalid workspace name");
	const root = workspacesRoot(config);
	return name === undefined
		? path.join(root, scope)
		: path.join(root, scope, name);
}

/** Bare clones that back graph snapshots (source excerpts, text search). Never mounted into a sandbox. */
export const mirrorsRoot = (config: Pick<Config, "dataDir">) =>
	path.join(config.dataDir, "mirrors");

export function mirrorPath(
	config: Pick<Config, "dataDir">,
	snapshotId: string,
): string {
	if (!SAFE_SEGMENT.test(snapshotId)) throw new Error("Invalid mirror name");
	return path.join(mirrorsRoot(config), `${snapshotId}.git`);
}

export async function removeWorkspace(
	config: Pick<Config, "dataDir">,
	scope: string,
): Promise<void> {
	await rm(workspacePath(config, scope), { recursive: true, force: true });
}

export type CloneResult =
	| { ok: true }
	| {
			ok: false;
			code: "clone_failed" | "commit_not_found" | "context_timeout";
			message: string;
	  };

/**
 * Hardened clone at one commit: no hardlinks, nothing checked out until the commit is verified,
 * symlinks materialized as plain files, no CRLF conversion, no hooks, fsmonitor, or submodules
 * (flags in lib/git.ts), LFS smudging skipped. `.tracera/` is excluded from diffs. `bare` clones (graph
 * mirrors) have no working tree at all and live under the mirrors root instead.
 */
export async function cloneAtCommit(
	config: Pick<Config, "dataDir">,
	source: string,
	dest: string,
	commitSha: string,
	timeoutMs = 60_000,
	options: { bare?: boolean } = {},
): Promise<CloneResult> {
	if (!/^[0-9a-f]{40}$/.test(commitSha))
		return {
			ok: false,
			code: "commit_not_found",
			message: "Invalid commit SHA",
		};
	const root = options.bare ? mirrorsRoot(config) : workspacesRoot(config);
	if (!isPathInside(root, dest) || isPathInside(dest, root))
		throw new Error("Clone destination must be inside its root");
	await rm(dest, { recursive: true, force: true });
	await mkdir(path.dirname(dest), { recursive: true });
	const timeout = {
		ok: false as const,
		code: "context_timeout" as const,
		message: "Cloning the repository timed out",
	};
	const clone = await git(
		path.dirname(dest),
		[
			"clone",
			"--no-hardlinks",
			options.bare ? "--bare" : "--no-checkout",
			"--quiet",
			"--config",
			"core.symlinks=false",
			"--config",
			"core.autocrlf=false",
			"--",
			source,
			dest,
		],
		{ timeoutMs },
	);
	if (clone.timedOut) return timeout;
	if (!clone.ok)
		return {
			ok: false,
			code: "clone_failed",
			message: `git clone failed (exit ${clone.code ?? "unknown"})`,
		};
	if (!(await git(dest, ["cat-file", "-e", `${commitSha}^{commit}`])).ok)
		return {
			ok: false,
			code: "commit_not_found",
			message: `Commit ${commitSha.slice(0, 12)} is not in the repository`,
		};
	if (options.bare) return { ok: true };
	const checkout = await git(
		dest,
		["checkout", "--quiet", "--detach", commitSha],
		{ timeoutMs },
	);
	if (checkout.timedOut) return timeout;
	if (!checkout.ok)
		return {
			ok: false,
			code: "clone_failed",
			message: `git checkout failed (exit ${checkout.code ?? "unknown"})`,
		};
	await mkdir(path.join(dest, ".git", "info"), { recursive: true });
	await writeFile(path.join(dest, ".git", "info", "exclude"), ".tracera/\n");
	return { ok: true };
}

export type TreeEntry = {
	path: string;
	mode: string;
	type: string;
	object: string;
	size: number | null;
};

/** Every tracked entry at `commitSha` (paths exactly as git stores them). Null if git fails. */
export async function listTree(
	dir: string,
	commitSha: string,
	timeoutMs = 20_000,
): Promise<{ entries: TreeEntry[]; timedOut: boolean } | null> {
	const result = await git(
		dir,
		["ls-tree", "-r", "-z", "--long", "--full-tree", commitSha],
		{ timeoutMs, maxBytes: 32 * 1024 * 1024 },
	);
	if (!result.ok)
		return result.timedOut ? { entries: [], timedOut: true } : null;
	const entries: TreeEntry[] = [];
	for (const record of result.stdout.split("\0")) {
		const tab = record.indexOf("\t");
		if (tab === -1) continue;
		const [mode, type, object, size] = record.slice(0, tab).trim().split(/ +/);
		if (!mode || !type || !object) continue;
		entries.push({
			path: record.slice(tab + 1),
			mode,
			type,
			object,
			size: size === undefined || size === "-" ? null : Number(size),
		});
	}
	return { entries, timedOut: false };
}

/** Reads a blob at the commit through git (no worktree access, no filters, no symlink following). */
export async function readBlob(
	dir: string,
	commitSha: string,
	filePath: string,
	timeoutMs = 10_000,
): Promise<string | null> {
	const result = await git(
		dir,
		["cat-file", "blob", `${commitSha}:${filePath}`],
		{
			timeoutMs,
		},
	);
	return result.ok ? result.stdout : null;
}

export type FileChange = { path: string; change_type: "modified" | "added" };

/**
 * Applies validated search/replace edits inside a Tracera workspace copy. Each search must match
 * exactly once, edits in a file must not overlap, and every target must resolve (realpath) inside the
 * copy without passing through a link. Nothing is written unless every edit applies.
 */
export async function applyEdits(
	dir: string,
	edits: ReadonlyArray<{ path: string; search: string; replace: string }>,
): Promise<
	{ ok: true; changes: FileChange[] } | { ok: false; errors: string[] }
> {
	const realDir = await realpath(dir);
	const errors: string[] = [];
	const byFile = new Map<string, Array<(typeof edits)[number]>>();
	for (const edit of edits)
		byFile.set(edit.path, [...(byFile.get(edit.path) ?? []), edit]);
	const writes: Array<{ target: string; content: string; change: FileChange }> =
		[];
	for (const [file, fileEdits] of byFile) {
		const target = path.join(realDir, ...file.split("/"));
		const stat = await lstat(target).catch(() => null);
		if (stat?.isSymbolicLink()) {
			errors.push(`${file}: is a link`);
			continue;
		}
		if (!stat) {
			const [only] = fileEdits;
			if (fileEdits.length !== 1 || !only || only.search !== "") {
				errors.push(`${file}: the file does not exist`);
				continue;
			}
			const parent = path.dirname(target);
			if (!isPathInside(realDir, parent)) {
				errors.push(`${file}: escapes the workspace`);
				continue;
			}
			await mkdir(parent, { recursive: true });
			if (!isPathInside(realDir, await realpath(parent))) {
				errors.push(`${file}: escapes the workspace`);
				continue;
			}
			writes.push({
				target,
				content: only.replace,
				change: { path: file, change_type: "added" },
			});
			continue;
		}
		const real = await realpath(target);
		if (!stat.isFile() || !isPathInside(realDir, real)) {
			errors.push(`${file}: is not a regular file inside the workspace`);
			continue;
		}
		const content = await readFile(real, "utf8");
		const ranges: Array<{ start: number; end: number; replace: string }> = [];
		for (const edit of fileEdits) {
			const first = content.indexOf(edit.search);
			if (first === -1) errors.push(`${file}: search text was not found`);
			else if (content.indexOf(edit.search, first + 1) !== -1)
				errors.push(`${file}: search text matches more than once`);
			else
				ranges.push({
					start: first,
					end: first + edit.search.length,
					replace: edit.replace,
				});
		}
		ranges.sort((a, b) => a.start - b.start);
		if (
			ranges.some(
				(range, i) => i > 0 && range.start < (ranges[i - 1]?.end ?? 0),
			)
		)
			errors.push(`${file}: edits overlap`);
		let next = content;
		for (const range of [...ranges].reverse())
			next = next.slice(0, range.start) + range.replace + next.slice(range.end);
		writes.push({
			target: real,
			content: next,
			change: { path: file, change_type: "modified" },
		});
	}
	if (errors.length > 0) return { ok: false, errors };
	for (const write of writes) await writeFile(write.target, write.content);
	return { ok: true, changes: writes.map((write) => write.change) };
}

export type DiffFile = {
	path: string;
	change_type: "modified" | "added";
	additions: number;
	deletions: number;
};

/** Stages the copy (`.tracera/` is excluded) and returns the unified diff plus per-file stats. */
export async function stageAndDiff(
	dir: string,
): Promise<{ ok: true; diff: string; files: DiffFile[] } | { ok: false }> {
	if (!(await git(dir, ["add", "--all"])).ok) return { ok: false };
	const flags = ["--cached", "--no-ext-diff", "--no-textconv", "--no-renames"];
	const [diff, numstat, names] = await Promise.all([
		git(dir, ["diff", ...flags, "--no-color", "--full-index"]),
		git(dir, ["diff", ...flags, "--numstat"]),
		git(dir, ["diff", ...flags, "--name-status"]),
	]);
	if (!diff.ok || !numstat.ok || !names.ok) return { ok: false };
	const added = new Set(
		names.stdout
			.split("\n")
			.filter((line) => line.startsWith("A\t"))
			.map((line) => line.slice(2)),
	);
	const files = numstat.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [additions, deletions, file = ""] = line.split("\t");
			return {
				path: file,
				change_type: added.has(file)
					? ("added" as const)
					: ("modified" as const),
				additions: Number(additions) || 0,
				deletions: Number(deletions) || 0,
			};
		});
	return { ok: true, diff: diff.stdout, files };
}

/** Applies the stored, reviewed diff to a fresh copy, so verification tests exactly what was shown. */
export async function applyStoredDiff(
	dir: string,
	diff: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const patchFile = `${dir}.patch`;
	await writeFile(patchFile, diff);
	const check = await git(dir, [
		"apply",
		"--check",
		"--whitespace=nowarn",
		patchFile,
	]);
	if (!check.ok)
		return {
			ok: false,
			message: "The stored diff does not apply to a fresh copy",
		};
	const apply = await git(dir, ["apply", "--whitespace=nowarn", patchFile]);
	return apply.ok
		? { ok: true }
		: { ok: false, message: "git apply failed on the fresh copy" };
}
