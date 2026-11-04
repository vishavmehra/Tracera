import {
	CAPABILITY_IDS,
	CapabilitiesResponseSchema,
	type CapabilityId,
	type CapabilityStatus,
} from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
	deriveCapabilities,
	type WorkerSandbox,
} from "../src/modules/capabilities.ts";

const BASE = { DATABASE_URL: "postgres://tracera:pw@127.0.0.1:5432/tracera" };
const LIVE = {
	TRACERA_INFERENCE_PROVIDER: "openai_compatible",
	TRACERA_OPENAI_COMPAT_BASE_URL: "https://models.example.com/v1/",
	TRACERA_OPENAI_COMPAT_API_KEY: "compat-key-secret-value",
	TRACERA_OPENAI_COMPAT_PROVIDER_NAME: "nebius",
	TRACERA_MODEL_REASONING: "some-model",
};
const GOOGLE = {
	GOOGLE_CLIENT_ID: "google-client-id-secret-value",
	GOOGLE_CLIENT_SECRET: "google-client-secret-value",
	GOOGLE_REDIRECT_URI:
		"http://127.0.0.1:8787/api/v1/integrations/google/callback",
	TRACERA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

const READY: WorkerSandbox = { available: true, detail: "docker ready" };
const DOWN = (detail: string): WorkerSandbox => ({ available: false, detail });

const derive = (env: Record<string, string>, worker: WorkerSandbox) =>
	deriveCapabilities(loadConfig({ ...BASE, ...env }), worker);
const find = (result: ReturnType<typeof derive>, id: CapabilityId) => {
	const found = result.items.find((item) => item.id === id);
	if (!found) throw new Error(`no capability ${id}`);
	return found;
};

type Row = {
	name: string;
	env: Record<string, string>;
	worker: WorkerSandbox;
	expected: Partial<Record<CapabilityId, [CapabilityStatus, string]>>;
};

const ROWS: Row[] = [
	{
		name: "a local server with a ready sandbox and Google configured",
		env: { ...LIVE, ...GOOGLE, TRACERA_SANDBOX_MODE: "docker" },
		worker: READY,
		expected: {
			sandbox_verification: ["available", "isolated Docker sandbox"],
			authorized_actions: ["available", "each as a separate step"],
			google_meet: ["available", "connected Google account"],
		},
	},
	{
		name: "a local server whose worker has not reported",
		env: { TRACERA_SANDBOX_MODE: "docker" },
		worker: null,
		expected: {
			sandbox_verification: ["needs_configuration", "no worker is reporting"],
		},
	},
	{
		name: "a local server with Docker stopped",
		env: { TRACERA_SANDBOX_MODE: "docker" },
		worker: DOWN("docker_unavailable"),
		expected: {
			sandbox_verification: ["needs_configuration", "Docker is not reachable"],
		},
	},
	{
		name: "a local server missing the sandbox image",
		env: { TRACERA_SANDBOX_MODE: "docker" },
		worker: DOWN("image_missing (run: npm run sandbox:pull)"),
		expected: {
			sandbox_verification: ["needs_configuration", "npm run sandbox:pull"],
		},
	},
	{
		name: "a local server with the sandbox disabled",
		env: { TRACERA_SANDBOX_MODE: "disabled" },
		worker: READY,
		expected: {
			sandbox_verification: [
				"needs_configuration",
				"TRACERA_SANDBOX_MODE=docker",
			],
		},
	},
	{
		name: "a local server with only a test double for a sandbox",
		env: { NODE_ENV: "test", TRACERA_SANDBOX_MODE: "fake" },
		worker: READY,
		expected: { sandbox_verification: ["unavailable", "test double"] },
	},
	{
		name: "a hosted server, even when a worker reports a sandbox",
		env: { ...LIVE, TRACERA_ENVIRONMENT: "hosted" },
		worker: READY,
		expected: {
			sandbox_verification: ["unavailable", "this hosted environment has none"],
			authorized_actions: ["unavailable", "run in the local app"],
			patch_download: ["available", "download"],
			investigation_analysis: ["available", "nebius [live]"],
			screenshot_understanding: ["available", "nebius [live]"],
			mcp_client: ["available", "never apply, commit, or push"],
			browser_extension: ["available", "personal access token"],
		},
	},
	{
		name: "mock inference is labelled as placeholders",
		env: { TRACERA_INFERENCE_PROVIDER: "mock" },
		worker: null,
		expected: {
			investigation_analysis: ["available", "[mock] placeholders"],
			screenshot_understanding: ["available", "[mock] placeholders"],
		},
	},
];

describe("capability derivation", () => {
	it.each(ROWS)("for $name", ({ env, worker, expected }) => {
		const result = derive(env, worker);
		for (const [id, [status, reason]] of Object.entries(expected))
			expect(find(result, id as CapabilityId), id).toMatchObject({
				status,
				reason: expect.stringContaining(reason),
			});
	});

	it("reports the environment and the inference mode", () => {
		expect(
			derive({ ...LIVE, TRACERA_ENVIRONMENT: "hosted" }, null),
		).toMatchObject({
			environment: "hosted",
			inference: { mode: "live", provider: "nebius" },
		});
		expect(derive({}, null)).toMatchObject({
			environment: "local",
			inference: { mode: "mock", provider: "mock" },
		});
	});

	it("lists every capability once, in the contract shape, with one-sentence reasons", () => {
		const result = CapabilitiesResponseSchema.parse(derive({}, null));
		expect(result.items.map((item) => item.id)).toEqual([...CAPABILITY_IDS]);
		for (const { reason } of result.items) {
			expect(reason).toMatch(/\.$/);
			expect(reason).not.toMatch(/\.\s/);
		}
	});

	it("names the Google variables that are missing and none that are set", () => {
		const { reason } = find(
			derive({ GOOGLE_CLIENT_ID: GOOGLE.GOOGLE_CLIENT_ID }, null),
			"google_meet",
		);
		expect(reason).toBe(
			"Google Meet import needs GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, TRACERA_ENCRYPTION_KEY.",
		);
		expect(find(derive({}, null), "google_meet").status).toBe(
			"needs_configuration",
		);
	});

	it("never carries a configured secret", () => {
		const text = JSON.stringify(
			derive({ ...LIVE, ...GOOGLE, TRACERA_SANDBOX_MODE: "docker" }, READY),
		);
		for (const secret of [
			LIVE.TRACERA_OPENAI_COMPAT_API_KEY,
			GOOGLE.GOOGLE_CLIENT_ID,
			GOOGLE.GOOGLE_CLIENT_SECRET,
			GOOGLE.TRACERA_ENCRYPTION_KEY,
		])
			expect(text).not.toContain(secret);
	});
});
