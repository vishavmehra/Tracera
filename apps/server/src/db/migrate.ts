import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";
import { ConfigError, loadConfig } from "../config.ts";
import { createDb, createPool } from "./client.ts";

export const MIGRATIONS_DIR = path.resolve(
	import.meta.dirname,
	"../../drizzle",
);

/**
 * Roles through which a hosted Postgres (Supabase) serves tables over HTTP: its Data API (PostgREST)
 * and GraphQL run as these roles, and Supabase's default privileges grant them full access to every
 * new table in `public`. Tracera's tables must never be reachable that way.
 */
export const DATA_API_ROLES = ["anon", "authenticated"] as const;

export async function runMigrations(pool: pg.Pool): Promise<void> {
	await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_DIR });
	await lockDownDataApi(pool);
}

/**
 * Idempotent: enables row-level security on every table in `public` (no policies, so non-owner roles
 * see nothing; Tracera's own role owns or bypasses RLS) and, where Data API roles exist, revokes their
 * privileges and their default privileges for objects Tracera's role creates later.
 */
export async function lockDownDataApi(
	pool: pg.Pool,
	roles: readonly string[] = DATA_API_ROLES,
): Promise<void> {
	const { rows } = await pool.query<{ tablename: string }>(
		"select tablename from pg_tables where schemaname = 'public'",
	);
	for (const { tablename } of rows)
		await pool.query(
			`ALTER TABLE public.${quoteIdent(tablename)} ENABLE ROW LEVEL SECURITY`,
		);
	const present = await pool.query<{ rolname: string }>(
		"select rolname from pg_roles where rolname = any($1::text[])",
		[[...roles]],
	);
	for (const { rolname } of present.rows) {
		const role = quoteIdent(rolname);
		for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
			await pool.query(
				`REVOKE ALL ON ALL ${kind} IN SCHEMA public FROM ${role}`,
			);
			await pool.query(
				`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ${kind} FROM ${role}`,
			);
		}
	}
}

/**
 * Tables in `public` that a Data API role could read or change, or that lack row-level security.
 * Empty means locked down. The API and worker refuse to start otherwise.
 */
export async function dataApiExposure(
	pool: pg.Pool,
	roles: readonly string[] = DATA_API_ROLES,
): Promise<string[]> {
	const { rows } = await pool.query<{ tablename: string }>(
		`select t.tablename
		   from pg_tables t
		  where t.schemaname = 'public'
		    and (not t.rowsecurity
		         or exists (
		              select 1 from pg_roles r
		               where r.rolname = any($1::text[])
		                 and has_table_privilege(r.oid, format('public.%I', t.tablename),
		                       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')))
		  order by 1`,
		[[...roles]],
	);
	return rows.map((row) => row.tablename);
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Number of committed migrations not yet applied to the database. */
export async function pendingMigrationCount(pool: pg.Pool): Promise<number> {
	const journal = JSON.parse(
		await readFile(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
	) as {
		entries: unknown[];
	};
	const applied = await pool
		.query<{ count: string }>(
			"select count(*)::text as count from drizzle.__drizzle_migrations",
		)
		.then((result) => Number(result.rows[0]?.count ?? 0))
		.catch(() => 0);
	return Math.max(0, journal.entries.length - applied);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	try {
		const config = loadConfig();
		const pool = createPool(config.databaseUrl, "tracera-migrate");
		try {
			const pending = await pendingMigrationCount(pool);
			await runMigrations(pool);
			console.log(
				`Migrations applied (${pending} pending before run). Database: ${new URL(config.databaseUrl).host}`,
			);
		} finally {
			await pool.end();
		}
	} catch (error) {
		console.error(
			error instanceof ConfigError
				? error.message
				: `Migration failed: ${(error as Error).message}`,
		);
		process.exitCode = 1;
	}
}
