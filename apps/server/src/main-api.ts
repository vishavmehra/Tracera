import { buildApp } from "./api/app.ts";
import {
	type Config,
	ConfigError,
	describeConfig,
	loadConfig,
} from "./config.ts";
import { createDb, createPool } from "./db/client.ts";
import {
	dataApiExposure,
	pendingMigrationCount,
	runMigrations,
} from "./db/migrate.ts";
import { startQueue } from "./queue.ts";

function fail(message: string): never {
	console.error(`Tracera API failed to start: ${message}`);
	process.exit(1);
}

let config: Config;
try {
	config = loadConfig();
} catch (error) {
	fail(error instanceof ConfigError ? error.message : (error as Error).message);
}

const pool = createPool(config.databaseUrl, "tracera-api");
await pool
	.query("select 1")
	.catch((error: Error) =>
		fail(
			`cannot reach the database at ${new URL(config.databaseUrl).host} (${error.message}). Is Postgres running? Try: npm run db:up`,
		),
	);
if (config.autoMigrate) {
	await runMigrations(pool);
} else {
	const pending = await pendingMigrationCount(pool);
	if (pending > 0)
		fail(`${pending} database migration(s) pending. Run: npm run db:migrate`);
}
const exposed = await dataApiExposure(pool);
if (exposed.length > 0)
	fail(
		`${exposed.length} table(s) in schema public lack row-level security or are reachable by Data API roles (${exposed.slice(0, 5).join(", ")}). Run: npm run db:migrate`,
	);

const boss = await startQueue(config.databaseUrl, { role: "api" });
const app = await buildApp({ config, pool, db: createDb(pool), boss });
await app.listen({ host: config.api.host, port: config.api.port });
console.log(
	`Tracera API listening on http://${config.api.host}:${config.api.port}`,
	JSON.stringify(describeConfig(config)),
);

const shutdown = async () => {
	await app.close();
	await boss.stop({ graceful: true });
	await pool.end();
	process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
