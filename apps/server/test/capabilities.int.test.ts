import { CapabilitiesResponseSchema } from "@tracera/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { workerHeartbeats } from "../src/db/schema.ts";
import {
	asSession,
	asToken,
	createOwner,
	createTestContext,
	createToken,
	login,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

// Two servers share one database: a local one with Docker mode on, and a hosted one. A session made
// through either is valid on both, because sessions live in the database.

const SECRETS = {
	GOOGLE_CLIENT_ID: "google-client-id-secret-value",
	GOOGLE_CLIENT_SECRET: "google-client-secret-value",
	GOOGLE_REDIRECT_URI:
		"http://127.0.0.1:8787/api/v1/integrations/google/callback",
	TRACERA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
	TRACERA_INFERENCE_PROVIDER: "openai_compatible",
	TRACERA_OPENAI_COMPAT_BASE_URL: "https://models.example.com/v1/",
	TRACERA_OPENAI_COMPAT_API_KEY: "compat-api-key-secret-value",
	TRACERA_MODEL_REASONING: "some-model",
};

let local: TestContext;
let hosted: TestContext;
let cookie: string;

beforeAll(async () => {
	local = await createTestContext({
		TRACERA_SANDBOX_MODE: "docker",
		...SECRETS,
	});
	hosted = await createTestContext({
		TRACERA_ENVIRONMENT: "hosted",
		...SECRETS,
	});
});
afterAll(async () => {
	await local.close();
	await hosted.close();
});
beforeEach(async () => {
	await resetDatabase(local.pool);
	await createOwner(local.db);
	cookie = await login(local);
});

const listing = async (ctx: TestContext, credentials = cookie) => {
	const response = await asSession(ctx, credentials)(
		"GET",
		"/api/v1/capabilities",
	);
	expect(response.statusCode).toBe(200);
	return CapabilitiesResponseSchema.parse(response.json());
};
const item = (result: Awaited<ReturnType<typeof listing>>, id: string) =>
	result.items.find((entry) => entry.id === id);

const heartbeat = (available: boolean, updatedAt = new Date()) => {
	const sandbox = {
		available,
		kind: "docker",
		image: null,
		detail: available ? "docker ready" : "docker_unavailable",
	};
	return local.db
		.insert(workerHeartbeats)
		.values({ workerId: "worker-1", sandbox, startedAt: updatedAt, updatedAt })
		.onConflictDoUpdate({
			target: workerHeartbeats.workerId,
			set: { sandbox, updatedAt },
		});
};

describe("GET /api/v1/capabilities", () => {
	it("answers 401 without credentials", async () => {
		const response = await local.app.inject({
			method: "GET",
			url: "/api/v1/capabilities",
		});
		expect(response.statusCode).toBe(401);
		expect(response.json().code).toBe("unauthenticated");
	});

	it("answers a signed-in session in the contract shape", async () => {
		const result = await listing(local);
		expect(result.environment).toBe("local");
		expect(result.inference).toEqual({
			mode: "live",
			provider: "openai_compatible",
		});
		expect(item(result, "authorized_actions")?.status).toBe("available");
		expect(item(result, "google_meet")?.status).toBe("available");
	});

	it("answers a token with any scope, and every workspace gets the same answer", async () => {
		const token = await createToken(local, cookie, {
			name: "narrow",
			client_kind: "script",
			scopes: ["reports:read"],
		});
		const response = await asToken(local, token)("GET", "/api/v1/capabilities");
		expect(response.statusCode).toBe(200);
		await createOwner(local.db, "second@example.com");
		const theirs = await listing(
			local,
			await login(local, "second@example.com"),
		);
		expect(theirs).toEqual(await listing(local));
		expect(CapabilitiesResponseSchema.parse(response.json())).toEqual(theirs);
	});

	it("carries no configured secret, path, or database address", async () => {
		for (const ctx of [local, hosted]) {
			const { body } = await asSession(ctx, cookie)(
				"GET",
				"/api/v1/capabilities",
			);
			for (const secret of [
				SECRETS.GOOGLE_CLIENT_ID,
				SECRETS.GOOGLE_CLIENT_SECRET,
				SECRETS.TRACERA_ENCRYPTION_KEY,
				SECRETS.TRACERA_OPENAI_COMPAT_API_KEY,
				ctx.config.databaseUrl,
				ctx.config.dataDir,
				ctx.repoRoot,
			])
				expect(body).not.toContain(secret);
		}
	});

	it("reads the sandbox from the worker's latest heartbeat", async () => {
		const sandbox = async () =>
			item(await listing(local), "sandbox_verification");
		expect(await sandbox()).toMatchObject({
			status: "needs_configuration",
			reason: expect.stringContaining("no worker is reporting"),
		});
		await heartbeat(true);
		expect(await sandbox()).toMatchObject({ status: "available" });
		await heartbeat(false);
		expect(await sandbox()).toMatchObject({
			status: "needs_configuration",
			reason: expect.stringContaining("Docker is not reachable"),
		});
		await heartbeat(true, new Date(Date.now() - 5 * 60_000));
		expect(await sandbox()).toMatchObject({
			status: "needs_configuration",
			reason: expect.stringContaining("no worker is reporting"),
		});
	});

	it("says what a hosted server cannot do, even when a worker reports a sandbox", async () => {
		await heartbeat(true);
		const result = await listing(hosted);
		expect(result.environment).toBe("hosted");
		for (const id of ["authorized_actions", "sandbox_verification"])
			expect(item(result, id)?.status, id).toBe("unavailable");
		for (const id of ["patch_download", "investigation_analysis"])
			expect(item(result, id)?.status, id).toBe("available");
	});
});
