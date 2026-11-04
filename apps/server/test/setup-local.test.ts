import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
	databaseProblem,
	envProblems,
	explain,
	findFreePort,
	isLocalDatabase,
	localEnvValues,
	placementWarnings,
	ROOT,
	redact,
	remoteDatabaseRefusal,
	renderEnv,
	writeEnvOnce,
} from "../../../scripts/setup-local.ts";
import { loadConfig } from "../src/config.ts";

const template = readFileSync(path.join(ROOT, ".env.example"), "utf8");
const choices = {
	apiPort: 8787,
	webPort: 5173,
	postgresPort: 5432,
	dataDir: path.join(os.tmpdir(), "tracera-test-data"),
	repoRoot: path.join(os.tmpdir(), "tracera-test-repos"),
};

describe("isLocalDatabase", () => {
	it.each([
		{
			name: "an IPv4 loopback address",
			url: "postgres://u:p@127.0.0.1:5432/db",
			local: true,
		},
		{
			name: "another loopback address",
			url: "postgres://u:p@127.5.6.7/db",
			local: true,
		},
		{
			name: "localhost",
			url: "postgresql://u:p@LOCALHOST:5433/db",
			local: true,
		},
		{
			name: "an IPv6 loopback address",
			url: "postgres://u:p@[::1]:5432/db",
			local: true,
		},
		{
			name: "a unix socket directory",
			url: "postgres:///db?host=/var/run/postgresql",
			local: true,
		},
		{
			name: "a hosted database",
			url: "postgres://u:p@db.example.com:5432/postgres",
			local: false,
		},
		{
			name: "a private network address",
			url: "postgres://u:p@10.0.0.5:5432/db",
			local: false,
		},
		{
			name: "a host that only starts like a loopback address",
			url: "postgres://u:p@127.0.0.1.example.com/db",
			local: false,
		},
		{
			name: "a remote host in the query string",
			url: "postgres:///db?host=db.example.com",
			local: false,
		},
		{ name: "text that is not a URL", url: "not a url", local: false },
		{ name: "an empty value", url: "", local: false },
		{ name: "no value", url: undefined, local: false },
	])("$name -> $local", ({ url, local }) => {
		expect(isLocalDatabase(url)).toBe(local);
	});
});

describe("remoteDatabaseRefusal", () => {
	const remote = "postgres://tracera:s3cretvalue@db.example.com:5432/postgres";

	it("allows a local database without any flag", () => {
		expect(
			remoteDatabaseRefusal("postgres://u:p@127.0.0.1:5432/db", false, "x"),
		).toBeNull();
	});

	it("refuses a remote database, naming the host and the flag but never the credentials", () => {
		const message = remoteDatabaseRefusal(remote, false, "It writes there.");
		expect(message).toContain("db.example.com");
		expect(message).toContain("It writes there.");
		expect(message).toContain("--allow-remote-db");
		expect(message).not.toContain("s3cretvalue");
	});

	it("allows a remote database when the flag is given", () => {
		expect(remoteDatabaseRefusal(remote, true, "x")).toBeNull();
	});

	it("refuses a value that is not a connection string", () => {
		expect(remoteDatabaseRefusal("nonsense", false, "x")).toContain(
			"not a valid connection string",
		);
	});
});

describe("renderEnv", () => {
	it("fills the named keys and keeps comments, order, and every other line", () => {
		const text = renderEnv("# note\nA=1\n\nB=2\n# C=3\n", {
			B: "two",
			C: "three",
		});
		expect(text).toBe("# note\nA=1\n\nB=two\n# C=3\nC=three\n");
	});

	it("writes line feeds even when the template has carriage returns", () => {
		expect(renderEnv("A=1\r\nB=2\r\n", { A: "x" })).toBe("A=x\nB=2\n");
	});

	it.each(["a#b", "a$b", 'a"b', "a'b", "a`b", "a\nb"])(
		"refuses a value that .env cannot hold safely: %j",
		(value) => {
			expect(() => renderEnv("A=\n", { A: value })).toThrow(
				/cannot hold safely/,
			);
		},
	);

	it("accepts a Windows path", () => {
		expect(renderEnv("A=\n", { A: "C:\\Users\\someone\\My Data" })).toBe(
			"A=C:\\Users\\someone\\My Data\n",
		);
	});
});

describe("a generated .env", () => {
	const values = localEnvValues({
		...choices,
		webPort: 15_173,
		postgresPort: 55_432,
	});
	const env = parseEnv(renderEnv(template, values));

	it("is accepted by the server configuration and points everything at the web app", () => {
		const config = loadConfig(env);
		expect(config.inference.provider).toBe("mock");
		expect(config.autoMigrate).toBe(true);
		expect(config.api.publicOrigin).toBe("http://127.0.0.1:15173");
		expect(config.dataDir).toBe(choices.dataDir);
		expect(config.repoRoots).toEqual([choices.repoRoot]);
		expect(config.meetings.encryptionKey?.length).toBe(32);
		expect(config.meetings.googleMissing).toEqual([
			"GOOGLE_CLIENT_ID",
			"GOOGLE_CLIENT_SECRET",
		]);
		expect(env.GOOGLE_REDIRECT_URI).toBe(
			"http://127.0.0.1:15173/api/v1/integrations/google/callback",
		);
	});

	it("keeps the database password and port in step with the container settings", () => {
		const url = new URL(env.DATABASE_URL ?? "");
		expect(url.password).toBe(env.POSTGRES_PASSWORD);
		expect(url.port).toBe(env.POSTGRES_PORT);
		expect(env.POSTGRES_PORT).toBe("55432");
	});

	it("leaves no placeholder behind and nothing missing", () => {
		expect(Object.values(env).join("\n")).not.toContain("change-me");
		expect(envProblems(env as Record<string, string>)).toEqual([]);
	});

	it("uses long secrets that differ on every run", () => {
		const other = localEnvValues(choices);
		for (const key of [
			"POSTGRES_PASSWORD",
			"TRACERA_SEED_OWNER_PASSWORD",
			"TRACERA_ENCRYPTION_KEY",
		] as const) {
			expect(values[key]?.length ?? 0).toBeGreaterThanOrEqual(24);
			expect(values[key]).not.toBe(other[key]);
		}
		expect(
			values.TRACERA_SEED_OWNER_PASSWORD?.length ?? 0,
		).toBeGreaterThanOrEqual(12);
	});

	it("takes the owner email and password from the caller when given", () => {
		const given = localEnvValues({
			...choices,
			ownerEmail: "me@example.org",
			ownerPassword: "a-password-of-my-own",
		});
		expect(given.TRACERA_SEED_OWNER_EMAIL).toBe("me@example.org");
		expect(given.TRACERA_SEED_OWNER_PASSWORD).toBe("a-password-of-my-own");
	});
});

describe(".env.example", () => {
	it("lists every variable the server configuration reads", () => {
		const source = readFileSync(
			path.join(ROOT, "apps/server/src/config.ts"),
			"utf8",
		);
		const read = [
			...source.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*(?:opt|bool|int)\(/gm),
		].flatMap((match) => (match[1] ? [match[1]] : []));
		expect(read.length).toBeGreaterThan(30);
		const listed = new Set(
			[...template.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].flatMap((match) =>
				match[1] ? [match[1]] : [],
			),
		);
		expect(read.filter((name) => !listed.has(name))).toEqual([]);
	});
});

describe("writeEnvOnce", () => {
	it("creates a missing file and never overwrites an existing one", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "tracera-env-"));
		try {
			const file = path.join(dir, ".env");
			expect(writeEnvOnce(file, "A=first\n")).toBe(true);
			expect(writeEnvOnce(file, "A=second\n")).toBe(false);
			expect(readFileSync(file, "utf8")).toBe("A=first\n");
			const mine = path.join(dir, ".env.mine");
			writeFileSync(mine, "KEEP=me\n");
			expect(writeEnvOnce(mine, "A=new\n")).toBe(false);
			expect(readFileSync(mine, "utf8")).toBe("KEEP=me\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("envProblems", () => {
	const complete = {
		DATABASE_URL: "postgres://tracera:pw@127.0.0.1:5432/tracera",
		POSTGRES_PASSWORD: "pw",
		TRACERA_SEED_OWNER_EMAIL: "owner@example.com",
		TRACERA_SEED_OWNER_PASSWORD: "twelve-chars!",
	};

	it.each([
		{ name: "a complete local setup", env: complete, expected: [] },
		{
			name: "nothing set",
			env: {},
			expected: [
				"DATABASE_URL is missing or empty",
				"TRACERA_SEED_OWNER_EMAIL is missing or empty",
				"TRACERA_SEED_OWNER_PASSWORD is missing or empty",
			],
		},
		{
			name: "empty values",
			env: { ...complete, TRACERA_SEED_OWNER_EMAIL: "  ", DATABASE_URL: "" },
			expected: [
				"DATABASE_URL is missing or empty",
				"TRACERA_SEED_OWNER_EMAIL is missing or empty",
			],
		},
		{
			name: "a local database without the container password",
			env: { ...complete, POSTGRES_PASSWORD: "" },
			expected: [
				"POSTGRES_PASSWORD is missing or empty (the Postgres container needs it)",
			],
		},
		{
			name: "a remote database without a container password",
			env: {
				...complete,
				DATABASE_URL: "postgres://u:p@db.example.com/postgres",
				POSTGRES_PASSWORD: "",
			},
			expected: [],
		},
		{
			name: "a short owner password",
			env: { ...complete, TRACERA_SEED_OWNER_PASSWORD: "short" },
			expected: ["TRACERA_SEED_OWNER_PASSWORD needs at least 12 characters"],
		},
	])("$name", ({ env, expected }) => {
		expect(envProblems(env)).toEqual(expected);
	});
});

describe("placementWarnings", () => {
	const sourceRoot = path.resolve(os.tmpdir(), "clone");
	const dataDir = path.resolve(os.tmpdir(), "data");

	it.each([
		{
			name: "folders outside the clone",
			dir: dataDir,
			roots: [path.resolve(os.tmpdir(), "repos")],
			count: 0,
		},
		{
			name: "a data directory inside the clone",
			dir: path.join(sourceRoot, ".data"),
			roots: [],
			count: 1,
		},
		{
			name: "a repository folder inside the clone",
			dir: dataDir,
			roots: [path.join(sourceRoot, "repos")],
			count: 1,
		},
		{
			name: "a repository folder inside the data directory",
			dir: dataDir,
			roots: [path.join(dataDir, "repos")],
			count: 1,
		},
		{
			name: "one good and one bad repository folder",
			dir: dataDir,
			roots: [path.resolve(os.tmpdir(), "repos"), sourceRoot],
			count: 1,
		},
	])("$name -> $count", ({ dir, roots, count }) => {
		expect(
			placementWarnings({ sourceRoot, dataDir: dir, repoRoots: roots }),
		).toHaveLength(count);
	});
});

describe("redact", () => {
	it("removes connection string credentials and secret values", () => {
		const text = redact(
			"connect postgres://tracera:hunter2hunter2@127.0.0.1:5432/db failed; key=abcdefghij1234",
			{ TRACERA_ENCRYPTION_KEY: "abcdefghij1234", TRACERA_DATA_DIR: "/data" },
		);
		expect(text).not.toContain("hunter2hunter2");
		expect(text).not.toContain("abcdefghij1234");
		expect(text).toContain("postgres://tracera:***@127.0.0.1:5432/db");
	});
});

describe("explain", () => {
	it.each([
		{
			name: "a rejected password",
			output: 'password authentication failed for user "tracera"',
			hint: "restore that .env",
		},
		{
			name: "a closed port",
			output: "connect ECONNREFUSED 127.0.0.1:5432",
			hint: "Nothing is answering",
		},
		{
			name: "a taken port",
			output: "Bind for 127.0.0.1:5432 failed: port is already allocated",
			hint: "POSTGRES_PORT",
		},
		{
			name: "a stopped Docker",
			output:
				"failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine",
			hint: "Docker is not running",
		},
		{
			name: "a missing Compose plugin",
			output: "docker: 'compose' is not a docker command.",
			hint: "Docker Compose is missing",
		},
	])("adds the fix for $name", ({ output, hint }) => {
		expect(explain(output, {})).toContain(hint);
	});

	it("shows only the end of an unknown failure, without a fix", () => {
		const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
			"\n",
		);
		expect(explain(output, {})).toBe(
			Array.from({ length: 8 }, (_, i) => `line ${i + 13}`).join("\n"),
		);
	});

	it("never shows a configured secret", () => {
		const text = explain("failed with sekret-value-123 in the message", {
			TRACERA_ENCRYPTION_KEY: "sekret-value-123",
		});
		expect(text).not.toContain("sekret-value-123");
	});
});

describe("databaseProblem", () => {
	it("names the cause when nothing answers", { timeout: 20_000 }, async () => {
		const port = await findFreePort(49_152);
		const problem = await databaseProblem(
			`postgres://u:p@127.0.0.1:${port}/db`,
		);
		expect(problem).toMatch(/ECONNREFUSED/);
	});
});

describe("findFreePort", () => {
	it("skips a port that is in use", async () => {
		const server = net.createServer();
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const busy = (server.address() as net.AddressInfo).port;
		try {
			expect(await findFreePort(busy)).toBeGreaterThan(busy);
		} finally {
			server.close();
		}
	});
});
