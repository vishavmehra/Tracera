import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// E2E runs against a real local stack (API + worker + Vite) with mock inference configured explicitly:
// `npm run e2e:stack` starts one from scratch (apps/server/test/e2e/stack.ts) and writes the base URL,
// the disposable seed owner, and the fixture repository path to a temporary env file loaded here. It
// uses an installed Chrome (channel "chrome") so no browser is downloaded.
const stackEnv =
	process.env.TRACERA_E2E_ENV_FILE ??
	path.join(os.tmpdir(), "tracera-e2e", "e2e.env");
if (existsSync(stackEnv)) process.loadEnvFile(stackEnv);
export default defineConfig({
	testDir: "e2e",
	outputDir: "test-results",
	timeout: 240_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	reporter: [["list"]],
	use: {
		baseURL: process.env.TRACERA_E2E_BASE_URL ?? "http://127.0.0.1:5174",
		channel: "chrome",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "desktop",
			use: { ...devices["Desktop Chrome"], channel: "chrome" },
		},
	],
});
