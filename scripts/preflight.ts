// Runs before the API and the worker start. Waits for the database to accept connections, so a
// database that is waking or restarting does not fail a boot, and reports on stdout (as one JSON
// line) whether the owner account still has to be created. It loads only the database driver: the
// heavier schema and migration code is loaded by the processes that need it.
import pg from "pg";

const url = process.env.DATABASE_URL;
// A missing URL is reported by the server's own configuration check, with the rest of the problems.
if (!url) {
	console.log(JSON.stringify({ ownerMissing: false }));
	process.exit(0);
}

const attempts = Number(process.env.TRACERA_DB_WAIT_ATTEMPTS ?? 6);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(): Promise<pg.Client> {
	for (let attempt = 1; ; attempt++) {
		const client = new pg.Client({
			connectionString: url,
			connectionTimeoutMillis: 10_000,
		});
		client.on("error", () => undefined);
		try {
			await client.connect();
			return client;
		} catch (error) {
			await client.end().catch(() => undefined);
			const reason = (error as Error).message;
			if (attempt >= attempts) {
				console.error(
					`The database is unreachable after ${attempt} attempts: ${reason}`,
				);
				process.exit(1);
			}
			const delay = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
			console.error(
				`Database not ready (${reason}); retrying in ${delay / 1000}s`,
			);
			await sleep(delay);
		}
	}
}

const client = await connect();
const email = process.env.TRACERA_SEED_OWNER_EMAIL?.trim().toLowerCase();
let ownerMissing = false;
if (email && process.env.TRACERA_SEED_OWNER_PASSWORD) {
	// Same test as the seed: the user exists and belongs to a workspace. On a fresh database the
	// tables do not exist yet, which also means the owner is missing.
	ownerMissing = await client
		.query(
			"select 1 from users u join workspace_members m on m.user_id = u.id where u.email = $1 limit 1",
			[email],
		)
		.then(
			(result) => result.rowCount === 0,
			() => true,
		);
}
await client.end();
console.log(JSON.stringify({ ownerMissing }));
