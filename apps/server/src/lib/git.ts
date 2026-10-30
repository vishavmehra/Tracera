import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * Git on the host only ever runs against owner-registered repositories (clone, plus read-only
 * plumbing at registration) and against Tracera's own clones. Configuration that could execute
 * commands is switched off, and repository code itself never runs on the host.
 */
const HARDENING = [
	"-c",
	"core.fsmonitor=false",
	"-c",
	`core.hooksPath=${path.join(os.tmpdir(), "tracera-no-hooks")}`,
	"-c",
	"protocol.ext.allow=never",
	"-c",
	"diff.external=",
	"-c",
	"core.symlinks=false",
	"-c",
	"core.autocrlf=false",
	"-c",
	"submodule.recurse=false",
];

function gitEnv(userConfig = false): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env))
		if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
	return {
		...env,
		GIT_TERMINAL_PROMPT: "0",
		...(userConfig ? {} : { GIT_CONFIG_NOSYSTEM: "1" }),
		GIT_OPTIONAL_LOCKS: "0",
		GIT_LFS_SKIP_SMUDGE: "1",
	};
}

export type GitResult = {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

/**
 * Hardened git (argument array, never a shell). Untrusted values go after `-e`, `--`, or `--end-of-options`.
 * `userConfig` keeps the machine's system git configuration (for example a credential helper), which
 * a push needs to authenticate with the user's own credentials.
 */
export function git(
	cwd: string,
	args: readonly string[],
	options: { timeoutMs?: number; maxBytes?: number; userConfig?: boolean } = {},
): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			[...HARDENING, ...args],
			{
				cwd,
				env: gitEnv(options.userConfig),
				timeout: options.timeoutMs ?? 15_000,
				windowsHide: true,
				maxBuffer: options.maxBytes ?? 8 * 1024 * 1024,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				const failure = error as
					| (Error & { code?: unknown; killed?: boolean })
					| null;
				resolve({
					ok: !error,
					code: !failure
						? 0
						: typeof failure.code === "number"
							? failure.code
							: null,
					stdout: String(stdout),
					stderr: String(stderr),
					timedOut:
						failure?.killed === true &&
						failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
				});
			},
		);
	});
}

/** Reads many blobs with one `git cat-file --batch`. Null when git fails, times out, or exceeds maxBytes. */
export function readBlobs(
	cwd: string,
	objectIds: readonly string[],
	options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<Map<string, Buffer> | null> {
	if (objectIds.some((id) => !/^[0-9a-f]{40,64}$/.test(id)))
		return Promise.resolve(null);
	return new Promise((resolve) => {
		const child = execFile(
			"git",
			[...HARDENING, "cat-file", "--batch"],
			{
				cwd,
				env: gitEnv(),
				timeout: options.timeoutMs ?? 30_000,
				windowsHide: true,
				maxBuffer: options.maxBytes ?? 64 * 1024 * 1024,
				encoding: "buffer",
			},
			(error, stdout) => {
				if (error) return resolve(null);
				// Each record: "<oid> <type> <size>\n<content>\n" (or "<oid> missing\n").
				const blobs = new Map<string, Buffer>();
				let offset = 0;
				while (offset < stdout.length) {
					const newline = stdout.indexOf(0x0a, offset);
					if (newline === -1) break;
					const [oid, type, size] = stdout
						.subarray(offset, newline)
						.toString("utf8")
						.split(" ");
					offset = newline + 1;
					if (!oid || type === "missing" || size === undefined) continue;
					const length = Number(size);
					if (type === "blob")
						blobs.set(oid, stdout.subarray(offset, offset + length));
					offset += length + 1;
				}
				resolve(blobs);
			},
		);
		child.stdin?.end(`${objectIds.join("\n")}\n`);
	});
}

export async function isGitWorkTree(dir: string): Promise<boolean> {
	const result = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
	return result.ok && result.stdout.trim() === "true";
}

export async function gitTopLevel(dir: string): Promise<string | null> {
	const result = await git(dir, ["rev-parse", "--show-toplevel"]);
	const top = result.stdout.trim();
	return result.ok && top ? path.resolve(top) : null;
}

/** Resolves a branch or SHA to a full commit SHA, or null. `ref` must already be validated (no options). */
export async function resolveCommit(
	dir: string,
	ref: string,
): Promise<string | null> {
	const result = await git(dir, [
		"rev-parse",
		"--verify",
		"--quiet",
		"--end-of-options",
		`${ref}^{commit}`,
	]);
	const sha = result.stdout.trim();
	return result.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export async function currentBranch(dir: string): Promise<string | null> {
	const result = await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = result.stdout.trim();
	return result.ok && branch ? branch : null;
}
