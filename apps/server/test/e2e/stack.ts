import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import pg from "pg";
import {
	assertDisposableDatabase,
	createDb,
	createPool,
} from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { seedOwner } from "../../src/db/seed.ts";
import { createFixtureRepository } from "./fixture.ts";

/**
 * The local stack for browser E2E journeys (`npm run e2e:stack`, then `npm run test:e2e` in another
 * terminal) [mock]. Every run starts clean: a recreated local database (`tracera_e2e`, never a remote
 * host), a fresh data directory and fixture repository outside the Tracera tree, and a seed owner with a
 * random password. The API, the E2E worker (deterministic fixture provider, real Docker sandbox), and
 * Vite get an explicit environment: no provider keys and no hosted database URL are passed on.
 * Credentials go only to a temporary env file that Playwright loads; nothing secret is printed.
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
const BASE = path.join(os.tmpdir(), "tracera-e2e");
const ENV_FILE = path.join(BASE, "e2e.env");
const API_PORT = 4110;
const WEB_PORT = 5184;

function databaseUrl(): string {
	const file = path.join(ROOT, ".env");
	const env = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
	const base = process.env.TEST_DATABASE_URL ?? env.TEST_DATABASE_URL;
	if (!base)
		throw new Error(
			"Set TEST_DATABASE_URL (the local Postgres from `npm run db:up`); the E2E stack never uses DATABASE_URL",
		);
	assertDisposableDatabase(base, "The E2E stack");
	const url = new URL(base);
	url.pathname = "/tracera_e2e";
	return url.toString();
}

async function recreateDatabase(url: string) {
	const admin = new URL(url);
	admin.pathname = "/postgres";
	const client = new pg.Client({ connectionString: admin.toString() });
	await client.connect();
	await client.query("DROP DATABASE IF EXISTS tracera_e2e WITH (FORCE)");
	await client.query("CREATE DATABASE tracera_e2e");
	await client.end();
	const pool = createPool(url, "tracera-e2e-setup");
	try {
		await runMigrations(pool);
	} finally {
		await pool.end();
	}
}

/** Only what the processes need: system variables for Node and the Docker CLI, plus Tracera's own. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const keep = [
		"PATH",
		"PATHEXT",
		"SystemRoot",
		"windir",
		"USERPROFILE",
		"HOME",
		"APPDATA",
		"LOCALAPPDATA",
		"ProgramData",
		"ProgramFiles",
		"TEMP",
		"TMP",
		"DOCKER_HOST",
		"DOCKER_CONTEXT",
	];
	const env: NodeJS.ProcessEnv = {};
	for (const key of keep) if (process.env[key]) env[key] = process.env[key];
	const docker = "C:\\Program Files\\Docker\\Docker\\resources\\bin";
	if (process.platform === "win32" && existsSync(docker))
		env.PATH = `${docker};${env.PATH ?? ""}`;
	return { ...env, ...extra };
}

async function waitFor(url: string, label: string, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
			if (response.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`${label} did not become ready at ${url}`);
}

async function main() {
	const url = databaseUrl();
	rmSync(BASE, { recursive: true, force: true });
	const dataDir = path.join(BASE, "data");
	const repoRoot = path.join(BASE, "repos");
	mkdirSync(dataDir, { recursive: true });
	const repoPath = createFixtureRepository(path.join(repoRoot, "tiny-api"));
	await recreateDatabase(url);
	const owner = {
		email: "owner@tracera-e2e.test",
		password: randomBytes(18).toString("base64url"),
	};
	const pool = createPool(url, "tracera-e2e-seed");
	try {
		await seedOwner(createDb(pool), owner);
	} finally {
		await pool.end();
	}

	const tracera = {
		NODE_ENV: "development",
		LOG_LEVEL: "warn",
		DATABASE_URL: url,
		TRACERA_API_HOST: "127.0.0.1",
		TRACERA_API_PORT: String(API_PORT),
		TRACERA_PUBLIC_URL: `http://127.0.0.1:${WEB_PORT}`,
		TRACERA_DATA_DIR: dataDir,
		TRACERA_REPO_ROOTS: repoRoot,
		TRACERA_INFERENCE_PROVIDER: "mock",
		TRACERA_SANDBOX_MODE: "docker",
		TRACERA_WEB_API_URL: `http://127.0.0.1:${API_PORT}`,
		TRACERA_WEB_PORT: String(WEB_PORT),
	};
	const children: ChildProcess[] = [];
	let stopping = false;
	const start = (label: string, args: string[], cwd = ROOT) => {
		const child = spawn(process.execPath, args, {
			cwd,
			env: childEnv(tracera),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const log = path.join(BASE, `${label}.log`);
		child.stdout?.on("data", (chunk) =>
			writeFileSync(log, chunk, { flag: "a" }),
		);
		child.stderr?.on("data", (chunk) =>
			writeFileSync(log, chunk, { flag: "a" }),
		);
		child.once("exit", (code) => {
			if (!stopping) console.error(`${label} exited (${code}); see ${log}`);
		});
		children.push(child);
	};
	const stop = () => {
		stopping = true;
		for (const child of children) child.kill();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	try {
		start("api", ["apps/server/src/main-api.ts"]);
		start("worker", ["apps/server/test/e2e/worker.ts"]);
		// Vite does not export its bin; it sits next to the package.json it does export.
		const vite = path.join(
			path.dirname(
				createRequire(path.join(ROOT, "apps/web/package.json")).resolve(
					"vite/package.json",
				),
			),
			"bin",
			"vite.js",
		);
		start("web", [vite], path.join(ROOT, "apps/web"));
		await waitFor(`http://127.0.0.1:${API_PORT}/healthz`, "The API");
		await waitFor(`http://127.0.0.1:${WEB_PORT}/`, "Vite");
	} catch (error) {
		stop();
		throw error;
	}
	writeFileSync(
		ENV_FILE,
		[
			`TRACERA_E2E_BASE_URL=http://127.0.0.1:${WEB_PORT}`,
			`TRACERA_SEED_OWNER_EMAIL=${owner.email}`,
			`TRACERA_SEED_OWNER_PASSWORD=${owner.password}`,
			`TRACERA_E2E_REPO_PATH=${repoPath}`,
			"",
		].join("\n"),
	);
	console.log(
		`E2E stack ready [mock fixture provider]: web http://127.0.0.1:${WEB_PORT}, logs in ${BASE}. Run npm run test:e2e; stop the stack when done.`,
	);
}

await main();
