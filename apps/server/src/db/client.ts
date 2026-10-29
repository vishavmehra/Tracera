import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

/** pg-boss accepts this to run its statements on our connection (transactional enqueue). */
export type QueueDb = {
	executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

export function createPool(
	databaseUrl: string,
	applicationName = "tracera",
): pg.Pool {
	return new pg.Pool({
		connectionString: databaseUrl,
		max: 10,
		application_name: applicationName,
		// A hosted database costs a TLS handshake (~0.8 s) per new connection: keep idle ones longer.
		idleTimeoutMillis: 60_000,
		keepAlive: true,
	});
}

export function createDb(client: pg.Pool | pg.PoolClient): Db {
	return drizzle({ client, schema, casing: "snake_case" });
}

/** Runs `fn` in one transaction. Jobs sent with `queueDb` commit or roll back together with the rows. */
export async function withTransaction<T>(
	pool: pg.Pool,
	fn: (tx: { db: Db; queueDb: QueueDb }) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const queueDb: QueueDb = {
			executeSql: (text, values) => client.query(text, values as unknown[]),
		};
		const result = await fn({ db: createDb(client), queueDb });
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

/**
 * Tests and the evaluator drop and recreate whole databases, so they run only against a database on
 * this machine unless TRACERA_ALLOW_REMOTE_TEST_DB=1 says otherwise.
 */
export function assertDisposableDatabase(url: string, purpose: string): void {
	const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
	if (["127.0.0.1", "localhost", "::1"].includes(host)) return;
	if (process.env.TRACERA_ALLOW_REMOTE_TEST_DB === "1") return;
	throw new Error(
		`${purpose} drops and recreates its database and refuses the non-local host ${host}. Point TEST_DATABASE_URL (or EVAL_DATABASE_URL) at the local Postgres (npm run db:up), or set TRACERA_ALLOW_REMOTE_TEST_DB=1 for a disposable remote server.`,
	);
}

/** Postgres error code helper (e.g. 23505 unique_violation). */
export function pgErrorCode(error: unknown): string | undefined {
	const candidate =
		(error as { code?: unknown; cause?: { code?: unknown } }) ?? {};
	const code = candidate.code ?? candidate.cause?.code;
	return typeof code === "string" ? code : undefined;
}
