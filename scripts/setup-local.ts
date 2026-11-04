// Sets up a local, full-capability Tracera: checks the prerequisites, creates .env when there is
// none, starts the Postgres container, applies the migrations, creates the owner account, and
// builds the demo repositories. Running it again is safe: an existing .env and existing demo
// repositories are never changed.
//
//   npm run setup [-- --pull-images] [-- --allow-remote-db]
//
// The pure helpers are exported for scripts/local.ts and for the tests.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";
import {
	type Config,
	ConfigError,
	GOOGLE_CALLBACK_PATH,
	loadConfig,
	resolveDataDir,
} from "../apps/server/src/config.ts";
import { isPathInside } from "../apps/server/src/lib/fs.ts";

export const ROOT = path.resolve(import.meta.dirname, "..");
export type Env = Record<string, string>;

/** A problem the person running the script can fix: printed without a stack trace. */
export class Failure extends Error {
	detail: string;
	constructor(message: string, detail = "") {
		super(message);
		this.detail = detail;
	}
}

export function printFailure(error: unknown): void {
	if (error instanceof Failure) {
		console.error(`\n  FAIL  ${error.message}`);
		for (const line of error.detail.split("\n").filter(Boolean))
			console.error(`        ${line}`);
	} else console.error(error);
	process.exitCode = 1;
}

// ---- Environment files ------------------------------------------------------------------------

const definedOnly = (source: Record<string, string | undefined>): Env =>
	Object.fromEntries(
		Object.entries(source).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);

export function readEnvFile(file: string): Env {
	return existsSync(file)
		? definedOnly(parseEnv(readFileSync(file, "utf8")))
		: {};
}

/** What a child started with --env-file sees: the process environment wins over the file. */
export const effectiveEnv = (fileEnv: Env): Env => ({
	...fileEnv,
	...definedOnly(process.env),
});

/** A value that cannot be written to an unquoted .env line without changing its meaning. */
const UNSAFE_VALUE = /[\r\n#"'`$]/;

/**
 * Fills the template's `KEY=` lines with `values`, keeping comments and order; a key the template
 * does not have is appended, so no value is dropped.
 */
export function renderEnv(template: string, values: Env): string {
	for (const [key, value] of Object.entries(values))
		if (UNSAFE_VALUE.test(value))
			throw new Error(
				`${key} contains a character that .env cannot hold safely (a quote, #, $, a backtick, or a line break); choose another value`,
			);
	const unused = new Map(Object.entries(values));
	const lines = template.split(/\r?\n/).map((line) => {
		const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
		const value = key === undefined ? undefined : unused.get(key);
		if (key === undefined || value === undefined) return line;
		unused.delete(key);
		return `${key}=${value}`;
	});
	const extra = [...unused].map(([key, value]) => `${key}=${value}`);
	return extra.length === 0
		? lines.join("\n")
		: `${lines.join("\n").replace(/\n*$/, "\n")}${extra.join("\n")}\n`;
}

/** Creates `file` with owner-only permissions unless it exists; never overwrites. */
export function writeEnvOnce(file: string, content: string): boolean {
	try {
		writeFileSync(file, content, { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

export type LocalChoices = {
	apiPort: number;
	webPort: number;
	postgresPort: number;
	dataDir: string;
	repoRoot: string;
	ownerEmail?: string | undefined;
	ownerPassword?: string | undefined;
};

/** The values setup writes into a new .env: fresh secrets and a local, internally consistent setup. */
export function localEnvValues(choices: LocalChoices): Env {
	const postgresPassword = randomBytes(24).toString("hex");
	const webOrigin = `http://127.0.0.1:${choices.webPort}`;
	return {
		TRACERA_API_PORT: String(choices.apiPort),
		TRACERA_WEB_PORT: String(choices.webPort),
		TRACERA_PUBLIC_URL: webOrigin,
		POSTGRES_PASSWORD: postgresPassword,
		POSTGRES_PORT: String(choices.postgresPort),
		DATABASE_URL: `postgres://tracera:${postgresPassword}@127.0.0.1:${choices.postgresPort}/tracera`,
		TRACERA_AUTO_MIGRATE: "true",
		TRACERA_DATA_DIR: choices.dataDir,
		TRACERA_REPO_ROOTS: choices.repoRoot,
		TRACERA_INFERENCE_PROVIDER: "mock",
		TRACERA_SEED_OWNER_PASSWORD:
			choices.ownerPassword ?? randomBytes(16).toString("hex"),
		...(choices.ownerEmail
			? { TRACERA_SEED_OWNER_EMAIL: choices.ownerEmail }
			: {}),
		TRACERA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
		GOOGLE_REDIRECT_URI: `${webOrigin}${GOOGLE_CALLBACK_PATH}`,
	};
}

/** Settings a local install cannot start without. */
export function envProblems(env: Env): string[] {
	const problems = [
		"DATABASE_URL",
		"TRACERA_SEED_OWNER_EMAIL",
		"TRACERA_SEED_OWNER_PASSWORD",
	]
		.filter((key) => !env[key]?.trim())
		.map((key) => `${key} is missing or empty`);
	if (isLocalDatabase(env.DATABASE_URL) && !env.POSTGRES_PASSWORD?.trim())
		problems.push(
			"POSTGRES_PASSWORD is missing or empty (the Postgres container needs it)",
		);
	const password = env.TRACERA_SEED_OWNER_PASSWORD?.trim();
	if (password && password.length < 12)
		problems.push("TRACERA_SEED_OWNER_PASSWORD needs at least 12 characters");
	return problems;
}

/** Paths the server would refuse to register repositories from. */
export function placementWarnings(
	config: Pick<Config, "dataDir" | "repoRoots" | "sourceRoot">,
): string[] {
	const warnings: string[] = [];
	if (isPathInside(config.sourceRoot, config.dataDir))
		warnings.push(
			"TRACERA_DATA_DIR is inside the Tracera source tree, so the demo repositories cannot be registered; choose a folder outside it",
		);
	for (const root of config.repoRoots) {
		if (isPathInside(config.sourceRoot, root))
			warnings.push(
				`TRACERA_REPO_ROOTS entry ${root} is inside the Tracera source tree; repositories there cannot be registered`,
			);
		else if (isPathInside(config.dataDir, root))
			warnings.push(
				`TRACERA_REPO_ROOTS entry ${root} is inside TRACERA_DATA_DIR; repositories there cannot be registered`,
			);
	}
	return warnings;
}

export const webOrigin = (env: Env) =>
	`http://127.0.0.1:${Number(env.TRACERA_WEB_PORT) || 5173}`;

// ---- Local database guard ---------------------------------------------------------------------

/** The host of a connection string (a `host` query parameter counts when the authority has none). */
export function databaseHost(databaseUrl: string | undefined): string | null {
	try {
		const url = new URL(databaseUrl ?? "");
		return (
			url.hostname ||
			url.searchParams.get("host") ||
			"localhost"
		).toLowerCase();
	} catch {
		return null;
	}
}

const LOOPBACK = /^(localhost|\[::1\]|127(\.\d{1,3}){3})$/;

export function isLocalDatabase(databaseUrl: string | undefined): boolean {
	const host = databaseHost(databaseUrl);
	return host !== null && (LOOPBACK.test(host) || host.startsWith("/"));
}

/** Why a script must not touch the configured database, or null when it may. Names the host only. */
export function remoteDatabaseRefusal(
	databaseUrl: string | undefined,
	allowRemote: boolean,
	consequence: string,
): string | null {
	if (allowRemote || isLocalDatabase(databaseUrl)) return null;
	const host = databaseHost(databaseUrl);
	return host === null
		? "DATABASE_URL is missing or not a valid connection string."
		: `DATABASE_URL points to ${host}, which is not this machine. ${consequence}\nRun this again with --allow-remote-db only if that database is the one you mean to change.`;
}

// ---- Processes, ports, Docker -----------------------------------------------------------------

export type RunResult = { code: number; output: string };

/** Runs a program (never through a shell) and collects its output; code 127 means it did not start. */
export function run(
	command: string,
	args: string[],
	options: { timeoutMs?: number; inherit?: boolean } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: ROOT,
			stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
			timeout: options.timeoutMs,
		});
		let output = "";
		child.stdout?.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			output += chunk;
		});
		child.once("error", (error) =>
			resolve({ code: 127, output: error.message }),
		);
		child.once("close", (code) => resolve({ code: code ?? 1, output }));
	});
}

export const canListen = (port: number) =>
	new Promise<boolean>((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
	});

export async function findFreePort(
	start: number,
	attempts = 20,
): Promise<number> {
	for (let port = start; port < start + attempts; port++)
		if (await canListen(port)) return port;
	throw new Failure(
		`No free port from ${start} to ${start + attempts - 1}`,
		"Set POSTGRES_PORT to a free port and run this again.",
	);
}

/** Why the database cannot be used (the driver's message, which names the cause), or null when it answers. */
export async function databaseProblem(
	databaseUrl: string,
): Promise<string | null> {
	const client = new pg.Client({
		connectionString: databaseUrl,
		connectionTimeoutMillis: 5_000,
	});
	try {
		await client.connect();
		await client.query("select 1");
		return null;
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { errors?: Error[] };
		return (
			failure.message ||
			failure.errors?.[0]?.message ||
			String(failure.code ?? failure)
		);
	} finally {
		await client.end().catch(() => undefined);
	}
}

export async function dockerState(): Promise<"ready" | "stopped" | "missing"> {
	const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
		timeoutMs: 30_000,
	});
	if (info.code === 0) return "ready";
	return info.output.includes("ENOENT") ? "missing" : "stopped";
}

export async function missingImages(
	images: readonly string[],
): Promise<string[]> {
	const missing: string[] = [];
	for (const image of images)
		if (
			(await run("docker", ["image", "inspect", "--format", "{{.Id}}", image]))
				.code !== 0
		)
			missing.push(image);
	return missing;
}

/** Every image the server runs containers from, as configured (pinned by digest). */
export const sandboxImages = (config: Config): string[] =>
	Object.entries(config).flatMap(([key, value]) =>
		key.endsWith("Image") && typeof value === "string" ? [value] : [],
	);

// ---- Explaining failures ----------------------------------------------------------------------

const HINTS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/password authentication failed/i,
		"Postgres rejected the password in DATABASE_URL. If the database volume was created by an earlier .env, restore that .env, or erase the local database with `docker compose down -v` and run npm run setup again.",
	],
	[
		/ECONNREFUSED|ETIMEDOUT|connection terminated|connection refused/i,
		"Nothing is answering at the DATABASE_URL address. Start Docker Desktop and run npm run setup again, or point DATABASE_URL at a Postgres you run yourself.",
	],
	[
		/port is already allocated|address already in use|ports are not available|only one usage of each socket/i,
		"The Postgres port is already in use. Set POSTGRES_PORT in .env to a free port, use the same port in DATABASE_URL, and run npm run setup again.",
	],
	[
		/cannot connect to the docker daemon|error during connect|docker daemon is not running|failed to connect to the docker api|dockerDesktopLinuxEngine/i,
		"Docker is not running. Start Docker Desktop, wait until it reports that it is running, and run npm run setup again.",
	],
	[
		/'compose' is not a docker command|unknown shorthand flag|docker: unknown command/i,
		"Docker Compose is missing. Docker Desktop includes it; on Linux install the Docker Compose plugin, then run npm run setup again.",
	],
];

/** Credentials and secret values removed from text that is about to be shown. */
export function redact(text: string, env: Env): string {
	let result = text.replace(/(\w+:\/\/[^:\s/@]+:)[^@\s/]+@/g, "$1***@");
	for (const [key, value] of Object.entries(env))
		if (/PASSWORD|SECRET|KEY|TOKEN/.test(key) && value.length >= 8)
			result = result.replaceAll(value, "***");
	return result;
}

/** The end of a failed command's output, plus the likely fix when the failure is a known one. */
export function explain(output: string, env: Env): string {
	const text = redact(output, env).trim();
	const hint = HINTS.find(([pattern]) => pattern.test(text))?.[1];
	const tail = text.split("\n").slice(-8).join("\n");
	return hint ? `${tail}\n\n${hint}` : tail;
}

// ---- The script -------------------------------------------------------------------------------

const USAGE = `Usage: npm run setup [-- options]
  --pull-images      also pull the sandbox images (large; needed to run repository code)
  --allow-remote-db  allow DATABASE_URL to point at a database that is not on this machine`;

const out = {
	step: (title: string) => console.log(`\n${title}`),
	ok: (message: string) => console.log(`  ok    ${message}`),
	warn: (message: string) => console.log(`  warn  ${message}`),
	note: (message: string) => console.log(`        ${message}`),
};

function portFromEnv(name: string): number | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65_535)
		throw new Failure(`${name} must be a port number`);
	return port;
}

const firstLine = (output: string) =>
	output.split("\n").find((line) => line.trim()) ?? "";

async function main(argv: string[]) {
	const known = ["--pull-images", "--allow-remote-db", "--help"];
	const unknown = argv.filter((arg) => !known.includes(arg));
	if (unknown.length > 0)
		throw new Failure(`Unknown option: ${unknown.join(" ")}`, USAGE);
	if (argv.includes("--help")) return console.log(USAGE);
	const pullImages = argv.includes("--pull-images");
	const allowRemote = argv.includes("--allow-remote-db");

	console.log("Tracera local setup");

	out.step("Prerequisites");
	if (process.versions.node.split(".")[0] !== "24")
		throw new Failure(
			`Node.js 24 is required (this is ${process.versions.node})`,
			"Install Node.js 24 from https://nodejs.org/ (or switch with nvm or fnm),\nrun npm ci, and run npm run setup again.",
		);
	out.ok(`Node.js ${process.versions.node}`);
	const git = await run("git", ["--version"]);
	if (git.code !== 0)
		throw new Failure(
			"git is not installed",
			"Install git from https://git-scm.com/ and run npm run setup again.\nTracera needs it to build the demo repositories and to apply patches.",
		);
	out.ok(git.output.trim());
	const docker = await dockerState();
	if (docker === "ready") out.ok("Docker is running");
	else {
		out.warn(
			docker === "missing"
				? "Docker is not installed"
				: "Docker is not running",
		);
		out.note(
			"Without Docker, Tracera cannot run repository code: verification, reproduction,",
		);
		out.note(
			"and screen recordings are unavailable. Everything else works. Install or start",
		);
		out.note("Docker Desktop and run npm run setup again to enable them.");
	}

	out.step("Configuration");
	const envFile = path.join(ROOT, ".env");
	if (existsSync(envFile)) {
		out.ok(".env exists; it is left unchanged");
	} else {
		const dataDir = resolveDataDir(process.env);
		const repoRoot = (
			process.env.TRACERA_REPO_ROOTS?.trim() ||
			path.join(os.homedir(), "tracera-repos")
		)
			.split(";")
			.filter(Boolean)
			.map((root) => path.resolve(root))
			.join(";");
		const choices: LocalChoices = {
			apiPort: portFromEnv("TRACERA_API_PORT") ?? 8787,
			webPort: portFromEnv("TRACERA_WEB_PORT") ?? 5173,
			postgresPort: portFromEnv("POSTGRES_PORT") ?? (await findFreePort(5432)),
			dataDir,
			repoRoot,
			ownerEmail: process.env.TRACERA_SEED_OWNER_EMAIL?.trim(),
			ownerPassword: process.env.TRACERA_SEED_OWNER_PASSWORD?.trim(),
		};
		const content = renderEnv(
			readFileSync(path.join(ROOT, ".env.example"), "utf8"),
			localEnvValues(choices),
		);
		mkdirSync(dataDir, { recursive: true });
		for (const root of repoRoot.split(";").filter(Boolean))
			mkdirSync(root, { recursive: true });
		if (writeEnvOnce(envFile, content)) {
			out.ok("Created .env with generated passwords and an encryption key");
			out.note("They are stored only in .env, which git ignores.");
			out.note(`data directory    ${dataDir}`);
			out.note(`repository folder ${repoRoot}`);
			out.note(
				`ports             web ${choices.webPort}, API ${choices.apiPort}, Postgres ${choices.postgresPort}`,
			);
		}
	}
	const env = effectiveEnv(readEnvFile(envFile));
	const problems = envProblems(env);
	if (problems.length > 0)
		throw new Failure(
			"Required settings are missing in .env",
			`${problems.join("\n")}\nAdd them (.env.example shows the format), or delete .env and run npm run setup\nagain to have it created.`,
		);
	let config: Config;
	try {
		config = loadConfig(env);
	} catch (error) {
		throw new Failure(
			"The configuration is invalid",
			error instanceof ConfigError ? error.message : String(error),
		);
	}
	for (const warning of placementWarnings(config)) out.warn(warning);
	const refusal = remoteDatabaseRefusal(
		env.DATABASE_URL,
		allowRemote,
		"Setup applies migrations and creates an owner account in that database.",
	);
	if (refusal)
		throw new Failure("Refusing to set up a remote database", refusal);

	out.step("Database");
	const database = new URL(config.databaseUrl);
	const where = `${database.hostname}:${database.port || "5432"}`;
	if (!isLocalDatabase(config.databaseUrl))
		out.warn(`Using the remote database at ${where} (--allow-remote-db)`);
	else if (docker !== "ready")
		out.warn(
			`The Postgres container was not started; expecting a Postgres at ${where}`,
		);
	else {
		out.note("Starting Postgres (the first run downloads its image)...");
		const up = await run("docker", [
			"compose",
			"up",
			"-d",
			"--wait",
			"postgres",
		]);
		if (up.code !== 0)
			throw new Failure("Could not start Postgres", explain(up.output, env));
		out.ok(`Postgres is running at ${where}`);
	}
	const unreachable = await databaseProblem(config.databaseUrl);
	if (unreachable !== null)
		throw new Failure(
			`Cannot use the database at ${where}`,
			explain(unreachable, env),
		);
	const nodeArgs = (script: string) => ["--env-file=.env", script];
	const migrate = await run(
		process.execPath,
		nodeArgs("apps/server/src/db/migrate.ts"),
	);
	if (migrate.code !== 0)
		throw new Failure("Migrations failed", explain(migrate.output, env));
	out.ok(firstLine(migrate.output));
	const seed = await run(
		process.execPath,
		nodeArgs("apps/server/src/db/seed.ts"),
	);
	if (seed.code !== 0)
		throw new Failure(
			"Creating the owner account failed",
			explain(seed.output, env),
		);
	out.ok(firstLine(seed.output));

	out.step("Demo repositories");
	// --if-absent keeps a repository that is already there, with whatever was applied or committed in it.
	for (const script of ["scripts/bench-setup.ts", "scripts/shop-ui-setup.ts"]) {
		const result = await run(process.execPath, [
			...nodeArgs(script),
			"--if-absent",
		]);
		if (result.code !== 0)
			throw new Failure(`${script} failed`, explain(result.output, env));
		out.ok(firstLine(result.output));
	}

	out.step("Sandbox");
	if (docker !== "ready") out.warn("Skipped: Docker is not available");
	else {
		const images = sandboxImages(config);
		if (pullImages)
			for (const image of images) {
				out.note(`Pulling ${image}`);
				const pull = await run("docker", ["pull", image], { inherit: true });
				if (pull.code !== 0)
					throw new Failure(
						`Could not pull ${image}`,
						"Check the network connection, then run npm run setup -- --pull-images again.",
					);
			}
		const missing = await missingImages(images);
		if (missing.length === 0) out.ok("Sandbox images are present");
		else
			out.warn(
				`${missing.length} sandbox image(s) not pulled yet; run: npm run setup -- --pull-images`,
			);
	}

	const origin = webOrigin(env);
	console.log(`
Setup finished. Next steps:
  1. Live models (optional): in .env set TRACERA_META_API_KEY and TRACERA_INFERENCE_PROVIDER=meta.
     Until then Tracera uses mock inference, which makes no network calls and is labeled as a mock.
  2. Google Meet (optional): add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env, and register
     this redirect URI in the Google Cloud console: ${env.GOOGLE_REDIRECT_URI || `${origin}${GOOGLE_CALLBACK_PATH}`}
  3. Start everything: npm run local
  4. Open ${origin} and sign in as ${env.TRACERA_SEED_OWNER_EMAIL}.
     The password is TRACERA_SEED_OWNER_PASSWORD in .env.`);
}

if (import.meta.main) await main(process.argv.slice(2)).catch(printFailure);
