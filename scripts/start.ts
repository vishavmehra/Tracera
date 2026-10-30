// Production entrypoint: runs the API and the worker as two child processes of one container. They
// share a data directory, so they cannot live in separate services. When either exits the other is
// stopped and this process exits non-zero, so the platform restarts the service.
//
// The boot order favors the API, because a request is what wakes an idle instance: wait for the
// database, start the API (which applies migrations), and only then start the worker, create the
// owner account if it is missing, and build the demo repository if it is missing. Those three run
// at low priority so a request that arrives meanwhile is not starved on a small CPU share.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import path from "node:path";

// This process stays up for the life of the container, so it imports nothing heavy and leaves the
// work to child processes.
const root = path.resolve(import.meta.dirname, "..");
const enabled = (name: string) =>
	["true", "1"].includes(process.env[name] ?? "");

// A bad owner password is a configuration mistake: say so now, not after a slow boot.
const password = process.env.TRACERA_SEED_OWNER_PASSWORD;
if (process.env.TRACERA_SEED_OWNER_EMAIL && password && password.length < 12) {
	console.error(
		"TRACERA_SEED_OWNER_PASSWORD must be at least 12 characters (it is only used to create the first owner)",
	);
	process.exit(1);
}

const preflight = spawnSync(
	process.execPath,
	[path.join(root, "scripts/preflight.ts")],
	{ stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" },
);
if (preflight.status !== 0) process.exit(1);
const { ownerMissing } = JSON.parse(
	preflight.stdout.trim().split("\n").at(-1) ?? "{}",
) as { ownerMissing?: boolean };

const alive = new Set<ChildProcess>();
let stopping = false;
let failed = false;

const stop = (signal: NodeJS.Signals) => {
	if (stopping) return;
	stopping = true;
	for (const child of alive) child.kill(signal);
	// A child stuck in its graceful shutdown must not keep a half-dead service running.
	setTimeout(() => {
		for (const child of alive) child.kill("SIGKILL");
	}, 20_000).unref();
};

for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.on(signal, () => stop(signal));

const lowPriority = process.platform === "win32" ? [] : ["nice", "-n", "10"];

/**
 * Starts a script of this repository. A `once` child has to succeed; any other has to keep running.
 * A `background` child runs at low priority.
 */
function launch(
	file: string,
	options: { args?: string[]; once?: boolean; background?: boolean } = {},
) {
	const { args = [], once = false, background = false } = options;
	const [command = process.execPath, ...prefix] = background
		? [...lowPriority, process.execPath]
		: [process.execPath];
	const child = spawn(command, [...prefix, path.join(root, file), ...args], {
		stdio: "inherit",
	});
	alive.add(child);
	child.on("exit", (code) => {
		alive.delete(child);
		// A long-running child that exits before a stop was requested has failed, even cleanly: the
		// service is half down.
		if (once ? !stopping && code !== 0 : !stopping || code !== 0) {
			failed = true;
			stop("SIGTERM");
		}
		if (alive.size === 0) process.exit(failed ? 1 : 0);
	});
}

const apiReady = async () => {
	const url = `http://127.0.0.1:${process.env.TRACERA_API_PORT ?? 8787}/healthz`;
	while (!stopping) {
		const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
			(response) => response.ok,
			() => false,
		);
		if (ok) return true;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	return false;
};

launch("apps/server/src/main-api.ts");
if (await apiReady()) {
	launch("apps/server/src/main-worker.ts", { background: true });
	if (ownerMissing)
		launch("apps/server/src/db/seed.ts", { once: true, background: true });
	if (enabled("TRACERA_DEMO_REPOS"))
		launch("scripts/bench-setup.ts", {
			args: ["--if-absent"],
			once: true,
			background: true,
		});
}
