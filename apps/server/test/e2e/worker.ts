import os from "node:os";
import { loadConfig } from "../../src/config.ts";
import {
	assertDisposableDatabase,
	createDb,
	createPool,
} from "../../src/db/client.ts";
import { pendingMigrationCount } from "../../src/db/migrate.ts";
import { startQueue } from "../../src/queue.ts";
import { createExecutor, startWorker } from "../../src/worker/handlers.ts";
import { createFixtureProvider } from "./fixture-provider.ts";

// The worker for browser E2E journeys [mock]: the production worker loop, executor, and sandbox, with
// the deterministic fixture provider instead of a model. It refuses anything but mock inference and a
// local, disposable database, so it can never run against the hosted database or a paid provider.

const config = loadConfig();
if (config.inference.provider !== "mock")
	throw new Error(
		"The E2E worker runs only with TRACERA_INFERENCE_PROVIDER=mock",
	);
assertDisposableDatabase(config.databaseUrl, "The E2E worker");

const pool = createPool(config.databaseUrl, "tracera-e2e-worker");
const pending = await pendingMigrationCount(pool);
if (pending > 0)
	throw new Error(`${pending} migration(s) pending: run the E2E stack setup`);
const boss = await startQueue(config.databaseUrl, {
	role: "worker",
	onError: (error) => console.error(`queue error: ${error.message}`),
});
const workerId = `e2e-${os.hostname()}-${process.pid}`.replace(
	/[^A-Za-z0-9_.-]/g,
	"-",
);
const stop = await startWorker({
	config,
	db: createDb(pool),
	pool,
	boss,
	provider: createFixtureProvider(),
	executor: createExecutor(config, workerId),
	workerId,
	log: (message, fields) => console.log(message, JSON.stringify(fields)),
});
console.log("Tracera E2E worker started [mock fixture provider]");

const shutdown = async () => {
	await stop();
	await boss.stop({ graceful: true });
	await pool.end();
	process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
