import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../../../scripts/start.ts");

/**
 * Runs the production supervisor with only the given variables, so the host's own settings never
 * leak in. The API port points at nothing, so a server running on the developer's machine is never
 * mistaken for the one the supervisor started.
 */
const start = (env: Record<string, string>) =>
	spawnSync(process.execPath, [script], {
		env: {
			PATH: process.env.PATH ?? "",
			SystemRoot: process.env.SystemRoot ?? "",
			TRACERA_API_PORT: "1",
			...env,
		},
		encoding: "utf8",
		timeout: 30_000,
	});

describe("scripts/start.ts", () => {
	it("exits non-zero when the API cannot start, so the platform restarts the service", () => {
		const result = start({});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Tracera API failed to start");
		// Without both owner variables there is no seeding to trip over.
		expect(result.stderr).not.toContain("TRACERA_SEED_OWNER");
	}, 30_000);

	it("stops before connecting to anything when the owner password is too short", () => {
		const result = start({
			DATABASE_URL: "postgresql://u:p@127.0.0.1:1/x",
			TRACERA_SEED_OWNER_EMAIL: "owner@example.com",
			TRACERA_SEED_OWNER_PASSWORD: "short",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("at least 12 characters");
		expect(result.stderr).not.toContain("Database not ready");
		expect(result.stderr).not.toContain("failed to start");
	}, 30_000);

	it("retries an unreachable database, then gives up without starting either process", () => {
		const result = start({
			DATABASE_URL: "postgresql://u:p@127.0.0.1:1/x",
			TRACERA_DB_WAIT_ATTEMPTS: "2",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Database not ready");
		expect(result.stderr).toContain("unreachable after 2 attempts");
		expect(result.stderr).not.toContain("failed to start");
	}, 30_000);
});
