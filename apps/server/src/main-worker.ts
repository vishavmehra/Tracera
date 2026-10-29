import os from "node:os";
import {
	type Config,
	ConfigError,
	describeConfig,
	loadConfig,
} from "./config.ts";
import { createDb, createPool } from "./db/client.ts";
import { dataApiExposure, pendingMigrationCount } from "./db/migrate.ts";
import { startQueue } from "./queue.ts";
import {
	createExecutor,
	createProvider,
	startWorker,
} from "./worker/handlers.ts";

function fail(message: string): never {
	console.error(`Tracera worker failed to start: ${message}`);
	process.exit(1);
}

let config: Config;
try {
	config = loadConfig();
} catch (error) {
	fail(error instanceof ConfigError ? error.message : (error as Error).message);
}

const pool = createPool(config.databaseUrl, "tracera-worker");
await pool
	.query("select 1")
	.catch((error: Error) =>
		fail(
			`cannot reach the database at ${new URL(config.databaseUrl).host} (${error.message}). Is Postgres running? Try: npm run db:up`,
		),
	);
const pending = await pendingMigrationCount(pool);
if (pending > 0)
	fail(`${pending} database migration(s) pending. Run: npm run db:migrate`);
const exposed = await dataApiExposure(pool);
if (exposed.length > 0)
	fail(
		`${exposed.length} table(s) in schema public lack row-level security or are reachable by Data API roles (${exposed.slice(0, 5).join(", ")}). Run: npm run db:migrate`,
	);

const boss = await startQueue(config.databaseUrl, {
	role: "worker",
	onError: (error) => console.error(`queue error: ${error.message}`),
});
const workerId =
	`${os.hostname()}-${process.pid}-${Date.now().toString(36)}`.replace(
		/[^A-Za-z0-9_.-]/g,
		"-",
	);
const stopWorker = await startWorker({
	config,
	db: createDb(pool),
	pool,
	boss,
	provider: createProvider(config),
	executor: createExecutor(config, workerId),
	workerId,
	log: (message, fields) => console.log(message, JSON.stringify(fields)),
});
console.log(
	"Tracera worker started",
	JSON.stringify({ worker_id: workerId, ...describeConfig(config) }),
);

const shutdown = async () => {
	await stopWorker();
	await boss.stop({ graceful: true });
	await pool.end();
	process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
