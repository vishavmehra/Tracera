import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rm,
} from "node:fs/promises";
import path from "node:path";

// Seals a prepared dependency tree: one SHA-256 over every entry of
// every node_modules directory that verification mounts (path, type, executable bit, size, and content
// hash or link target), never following links. The worker runs it with `node -e` in a container without
// network: once read-write to finalize and seal a fresh preparation, then read-only before each use to
// check the seal. It imports only node: modules for the same reason as egress-proxy.ts.

export type TreeSeal = {
	digest: string;
	files: number;
	dirs: number;
	links: number;
	bytes: number;
	/** node_modules directories not inside another node_modules: where verification mounts them. */
	mounts: string[];
};

export class SealError extends Error {}

export const SEAL_LIMITS = {
	entries: 500_000,
	bytes: 4 * 1024 ** 3,
	mounts: 32,
} as const;
/** Cache directories some test runners write into node_modules; verification overlays them with tmpfs. */
export const CACHE_DIRS = [".cache", ".vite"] as const;
const HASH_CONCURRENCY = 16;

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function findMounts(root: string): Promise<string[]> {
	const mounts: string[] = [];
	const walk = async (relative: string): Promise<void> => {
		const entries = await readdir(path.join(root, relative), {
			withFileTypes: true,
		});
		for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
			if (!entry.isDirectory()) continue; // links are not directories here: they are never followed
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.name === "node_modules") mounts.push(child);
			else await walk(child);
		}
	};
	await walk("");
	if (mounts.length > SEAL_LIMITS.mounts)
		throw new SealError("too_many_mounts");
	return mounts;
}

type Entry =
	| { kind: "d"; path: string }
	| { kind: "l"; path: string; target: string }
	| { kind: "f"; path: string; exec: boolean; size: number };

export async function sealTree(
	root: string,
	options: { finalize?: boolean } = {},
): Promise<TreeSeal> {
	const mounts = await findMounts(root);
	if (options.finalize)
		for (const mount of mounts)
			for (const dir of CACHE_DIRS)
				await mkdir(path.join(root, mount, dir), { recursive: true });
	const entries: Entry[] = [];
	let bytes = 0;
	const visit = async (relative: string): Promise<void> => {
		if (entries.length >= SEAL_LIMITS.entries)
			throw new SealError("artifact_too_large");
		const absolute = path.join(root, relative);
		const stat = await lstat(absolute);
		if (stat.isSymbolicLink()) {
			entries.push({
				kind: "l",
				path: relative,
				target: await readlink(absolute),
			});
			return;
		}
		if (stat.isDirectory()) {
			entries.push({ kind: "d", path: relative });
			for (const name of (await readdir(absolute)).sort(byName))
				await visit(`${relative}/${name}`);
			return;
		}
		if (!stat.isFile()) throw new SealError("special_file");
		bytes += stat.size;
		if (bytes > SEAL_LIMITS.bytes) throw new SealError("artifact_too_large");
		entries.push({
			kind: "f",
			path: relative,
			exec: (stat.mode & 0o111) !== 0,
			size: stat.size,
		});
	};
	for (const mount of mounts) await visit(mount);

	// Content hashes in parallel; the digest still consumes them in walk order, so it is deterministic.
	const files = entries.filter(
		(entry): entry is Extract<Entry, { kind: "f" }> => entry.kind === "f",
	);
	const contents = new Map<string, string>();
	let next = 0;
	await Promise.all(
		Array.from({ length: HASH_CONCURRENCY }, async () => {
			while (next < files.length) {
				const file = files[next++];
				if (!file) break;
				contents.set(
					file.path,
					createHash("sha256")
						.update(await readFile(path.join(root, file.path)))
						.digest("hex"),
				);
			}
		}),
	);
	const hash = createHash("sha256");
	for (const entry of entries)
		hash.update(
			entry.kind === "d"
				? `d\0${entry.path}\n`
				: entry.kind === "l"
					? `l\0${entry.path}\0${entry.target}\n`
					: `f\0${entry.path}\0${entry.exec ? "x" : "-"}\0${entry.size}\0${contents.get(entry.path)}\n`,
		);
	return {
		digest: hash.digest("hex"),
		files: files.length,
		dirs: entries.filter((entry) => entry.kind === "d").length,
		links: entries.filter((entry) => entry.kind === "l").length,
		bytes,
		mounts,
	};
}

if (process.env.TRACERA_ROLE === "seal-tree") {
	const finalize = process.env.TRACERA_SEAL_FINALIZE === "1";
	const cache = process.env.TRACERA_SEAL_CACHE;
	(async () => {
		if (finalize && cache) await rm(cache, { recursive: true, force: true });
		const seal = await sealTree(
			process.env.TRACERA_SEAL_ROOT ?? "/home/node/app",
			{ finalize },
		);
		process.stdout.write(`${JSON.stringify({ seal })}\n`);
	})().catch((error: Error) => {
		process.stdout.write(
			`${JSON.stringify({ error: error instanceof SealError ? error.message : "seal_failed" })}\n`,
		);
		process.exitCode = 2;
	});
}
