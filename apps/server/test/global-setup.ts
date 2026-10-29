import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { assertDisposableDatabase, createPool } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";

declare module "vitest" {
	export interface ProvidedContext {
		databaseUrl: string;
	}
}

/**
 * Recreates the test database (`tracera_test`, or `TRACERA_TEST_DATABASE` so parallel worktrees do not
 * drop each other's) on the configured Postgres and applies all migrations.
 */
export default async function setup(project: TestProject) {
	const fileEnv = existsSync(".env")
		? parseEnv(readFileSync(".env", "utf8"))
		: {};
	const name =
		process.env.TRACERA_TEST_DATABASE ??
		fileEnv.TRACERA_TEST_DATABASE ??
		"tracera_test";
	// Interpolated into DROP/CREATE DATABASE, and only ever a disposable test database.
	if (!/^tracera_test(_[a-z0-9]+)?$/.test(name))
		throw new Error("TRACERA_TEST_DATABASE must match tracera_test[_suffix]");
	const base =
		process.env.TEST_DATABASE_URL ??
		fileEnv.TEST_DATABASE_URL ??
		fileEnv.DATABASE_URL;
	if (!base) {
		throw new Error(
			"Integration tests need Postgres: run `npm run db:up` and set TEST_DATABASE_URL (or DATABASE_URL) in .env.",
		);
	}
	assertDisposableDatabase(base, "The integration test setup");
	const testUrl = new URL(base);
	testUrl.pathname = `/${name}`;
	const admin = new pg.Client({ connectionString: base });
	try {
		await admin.connect();
	} catch (error) {
		throw new Error(
			`Integration tests cannot reach Postgres at ${testUrl.host}: ${(error as Error).message}. Run \`npm run db:up\`.`,
		);
	}
	await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
	await admin.query(`CREATE DATABASE ${name}`);
	await admin.end();
	const pool = createPool(testUrl.toString(), "tracera-test-setup");
	await runMigrations(pool);
	await pool.end();
	project.provide("databaseUrl", testUrl.toString());
}
