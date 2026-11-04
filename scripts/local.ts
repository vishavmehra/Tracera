// Runs the whole product on this machine: the API, the worker, and the web app, started together with
// one consistent configuration. The browser talks only to the web app, which proxies /api to the API,
// so TRACERA_PUBLIC_URL is the web app's address for every process.
//
//   npm run local [-- --allow-remote-db]
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Readable } from "node:stream";
import { ConfigError, loadConfig } from "../apps/server/src/config.ts";
import {
	canListen,
	dockerState,
	type Env,
	effectiveEnv,
	Failure,
	missingImages,
	printFailure,
	ROOT,
	readEnvFile,
	remoteDatabaseRefusal,
	sandboxImages,
} from "./setup-local.ts";

const processes: Array<{ name: string; child: ChildProcess }> = [];
let stopping = false;
let signalled = false;

const killAll = (signal: NodeJS.Signals) => {
	for (const { child } of processes)
		if (child.exitCode === null && child.signalCode === null)
			child.kill(signal);
};

/**
 * Stops every process. A terminal's Ctrl+C already reaches the children, which then shut down
 * gracefully on their own, so after SIGINT they get time to do that before being asked again.
 */
function stop(signal: NodeJS.Signals) {
	if (stopping) return;
	stopping = true;
	setTimeout(
		() => killAll("SIGTERM"),
		signal === "SIGINT" ? 10_000 : 0,
	).unref();
	setTimeout(() => killAll("SIGKILL"), 20_000).unref();
}

/** Writes a child's output line by line, each marked with the process it came from. */
function prefixLines(stream: Readable, name: string, sink: NodeJS.WriteStream) {
	let pending = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk: string) => {
		const lines = (pending + chunk).split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines)
			sink.write(`[${name.padEnd(6)}] ${line.replace(/\r$/, "")}\n`);
	});
	stream.on("end", () => {
		if (pending) sink.write(`[${name.padEnd(6)}] ${pending}\n`);
	});
}

function start(
	name: string,
	script: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
) {
	// stdin stays an open pipe: the Vite dev server exits when its stdin ends. No windowsHide: on
	// Windows that gives each child a console of its own, and a terminal's Ctrl+C would not reach it.
	const child = spawn(process.execPath, [script], {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	prefixLines(child.stdout, name, process.stdout);
	prefixLines(child.stderr, name, process.stderr);
	child.once("exit", (code, signal) => {
		// A Ctrl+C reaches the children and this process together; give the signal a moment to be seen.
		setTimeout(() => {
			if (stopping) return;
			console.error(
				`[local ] ${name} stopped unexpectedly (${signal ?? `exit code ${code}`}); stopping the rest`,
			);
			process.exitCode = 1;
			stop("SIGTERM");
		}, 500);
	});
	processes.push({ name, child });
}

const stoppedEarly = () =>
	processes.some(
		({ child }) => child.exitCode !== null || child.signalCode !== null,
	);

const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(2_000) });

/** Retries `attempt` until it returns a value, the time is up, or everything is being stopped. */
async function until<T>(
	attempt: () => Promise<T | null>,
	timeoutMs: number,
): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	while (!stopping && Date.now() < deadline) {
		const value = await attempt().catch(() => null);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return null;
}

type Readiness = {
	worker?: string;
	sandbox?: { available?: boolean; detail?: string | null } | null;
};

async function main(argv: string[]) {
	const unknown = argv.filter((arg) => arg !== "--allow-remote-db");
	if (unknown.length > 0)
		throw new Failure(
			`Unknown option: ${unknown.join(" ")}`,
			"Usage: npm run local [-- --allow-remote-db]",
		);
	const envFile = path.join(ROOT, ".env");
	if (!existsSync(envFile))
		throw new Failure("There is no .env file yet", "Run: npm run setup");

	// One consistent configuration for all three processes.
	const merged = effectiveEnv(readEnvFile(envFile));
	const apiPort = Number(merged.TRACERA_API_PORT) || 8787;
	const webPort = Number(merged.TRACERA_WEB_PORT) || 5173;
	const origin = `http://127.0.0.1:${webPort}`;
	const env: Env = {
		...merged,
		TRACERA_API_PORT: String(apiPort),
		TRACERA_WEB_PORT: String(webPort),
		TRACERA_PUBLIC_URL: origin,
	};
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig(env);
	} catch (error) {
		throw new Failure(
			"The configuration is invalid",
			error instanceof ConfigError ? error.message : String(error),
		);
	}
	if (merged.TRACERA_PUBLIC_URL && merged.TRACERA_PUBLIC_URL !== origin)
		console.log(
			`Note: TRACERA_PUBLIC_URL is ${merged.TRACERA_PUBLIC_URL}; this run uses ${origin}, the address of the web app.`,
		);
	const refusal = config.autoMigrate
		? remoteDatabaseRefusal(
				env.DATABASE_URL,
				argv.includes("--allow-remote-db"),
				"TRACERA_AUTO_MIGRATE is true, so the API changes that database's schema when it starts.",
			)
		: null;
	if (refusal)
		throw new Failure("Refusing to start against a remote database", refusal);

	for (const [label, port, setting] of [
		["API", apiPort, "TRACERA_API_PORT"],
		["web app", webPort, "TRACERA_WEB_PORT"],
	] as const)
		if (!(await canListen(port)))
			throw new Failure(
				`Port ${port} (${label}) is already in use`,
				`Stop the program that is using it, or set ${setting} in .env to a free port.`,
			);

	let vite: string;
	try {
		vite = path.join(
			path.dirname(
				createRequire(path.join(ROOT, "apps/web/package.json")).resolve(
					"vite/package.json",
				),
			),
			"bin/vite.js",
		);
	} catch {
		throw new Failure(
			"The web app's dependencies are not installed",
			"Run: npm ci",
		);
	}

	const docker = await dockerState();
	if (docker !== "ready")
		console.log(
			`Docker is ${docker === "missing" ? "not installed" : "not running"}: Tracera cannot run repository code, so verification, reproduction, and screen recordings are unavailable until it is.`,
		);
	else {
		const missing = await missingImages(sandboxImages(config));
		console.log(
			missing.length === 0
				? "Docker is running and the sandbox images are present."
				: `Docker is running, but ${missing.length} sandbox image(s) are not pulled yet. Run: npm run setup -- --pull-images`,
		);
	}

	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => {
			signalled = true;
			stop(signal);
		});
	process.on("exit", () => killAll("SIGKILL"));

	const apiHost = ["0.0.0.0", "::"].includes(config.api.host)
		? "127.0.0.1"
		: config.api.host;
	const apiUrl = `http://${apiHost}:${apiPort}`;

	// The worker refuses to start while migrations are pending, and the API applies them: API first.
	start("api", "apps/server/src/main-api.ts", ROOT, env);
	if (
		!(await until(
			async () => ((await get(`${apiUrl}/healthz`)).ok ? true : null),
			90_000,
		))
	) {
		stop("SIGTERM");
		if (signalled) return;
		throw new Failure(
			"The API did not become healthy",
			stoppedEarly()
				? "It stopped on its own; its output is above."
				: "Waited 90 seconds.",
		);
	}
	start("worker", "apps/server/src/main-worker.ts", ROOT, env);
	start("web", vite, path.join(ROOT, "apps/web"), {
		...process.env,
		TRACERA_WEB_PORT: String(webPort),
		TRACERA_WEB_API_URL: apiUrl,
	});
	const proxied = await until(async () => {
		const status = (await get(`${origin}/readyz`)).status;
		return status === 200 || status === 503 ? status : null;
	}, 60_000);
	if (!proxied) {
		stop("SIGTERM");
		if (signalled) return;
		throw new Failure(
			"The web app did not come up",
			stoppedEarly()
				? "It stopped on its own; its output is above."
				: "Waited 60 seconds.",
		);
	}
	const ready = await until<Readiness>(async () => {
		const body = (await (await get(`${origin}/readyz`)).json()) as Readiness;
		return body.worker === "ok" ? body : null;
	}, 30_000);
	if (signalled) return;

	const sandbox = ready?.sandbox;
	console.log(`
Tracera is running
  Web app  ${origin}
  API      ${apiUrl}
  Models   ${config.inference.provider === "mock" ? "mock (for live models set TRACERA_META_API_KEY and TRACERA_INFERENCE_PROVIDER=meta in .env)" : config.inference.providerName}
  Sandbox  ${ready === null ? "the worker has not reported yet; check /readyz" : sandbox?.available ? "available" : `unavailable${sandbox?.detail ? ` (${sandbox.detail})` : ""}`}${
		env.TRACERA_SEED_OWNER_EMAIL
			? `\n  Sign in  ${env.TRACERA_SEED_OWNER_EMAIL}, password TRACERA_SEED_OWNER_PASSWORD in .env`
			: ""
	}
Press Ctrl+C to stop.
`);
}

await main(process.argv.slice(2)).catch(printFailure);
