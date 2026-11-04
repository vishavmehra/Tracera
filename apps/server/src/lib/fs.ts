import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "./crypto.ts";

/** True when `child` is `parent` or inside it (case-insensitive on Windows via path.relative). */
export function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

/**
 * Content-addressed blob store: <dir>/sha256/<aa>/<bb>/<hash>. Writes are atomic and
 * idempotent; an existing file whose bytes no longer match its name is replaced, never trusted. Two writers
 * of identical content at the same moment both succeed.
 */
export async function putBlob(
	dir: string,
	content: Buffer,
): Promise<{ sha256: string; path: string; size: number }> {
	const sha256 = sha256Hex(content);
	const target = path.join(
		dir,
		"sha256",
		sha256.slice(0, 2),
		sha256.slice(2, 4),
		sha256,
	);
	const intact = await readFile(target).then(
		(existing) => sha256Hex(existing) === sha256,
		() => false,
	);
	if (!intact) {
		await mkdir(path.dirname(target), { recursive: true });
		const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
		await writeFile(temp, content, { flag: "wx" });
		try {
			await rename(temp, target);
		} catch (error) {
			// Windows refuses to replace a file that another writer has just put there or still has open. The
			// name is the hash, so intact content under it means the blob is stored.
			const stored = await readFile(target).then(
				(existing) => sha256Hex(existing) === sha256,
				() => false,
			);
			await rm(temp, { force: true });
			if (!stored) throw error;
		}
	}
	return { sha256, path: target, size: content.length };
}

/** A blob written by putBlob, as bytes; null when the hash is malformed, the blob is missing, or its bytes no longer match its name. */
export async function readBlobBytes(
	dir: string,
	sha256: string | null | undefined,
): Promise<Buffer | null> {
	if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
	const bytes = await readFile(
		path.join(dir, "sha256", sha256.slice(0, 2), sha256.slice(2, 4), sha256),
	).catch(() => null);
	return bytes && sha256Hex(bytes) === sha256 ? bytes : null;
}

/** A blob written by putBlob, as UTF-8; null when the hash is malformed or the blob is missing. */
export async function readBlobUtf8(
	dir: string,
	sha256: string | null | undefined,
): Promise<string | null> {
	if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
	return readFile(
		path.join(dir, "sha256", sha256.slice(0, 2), sha256.slice(2, 4), sha256),
		"utf8",
	).catch(() => null);
}
