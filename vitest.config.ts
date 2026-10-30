import { defineConfig } from "vitest/config";

// `npm test` runs the unit and integration projects. Integration tests (*.int.test.ts) need Postgres.
// `npm run smoke:provider` (mode "live") runs only *.live.test.ts, which call the configured real provider.
// `npm run test:docker` (mode "docker") runs only *.docker.test.ts against the real Docker sandbox; it
// fails, never skips, when Docker or the pinned image is unavailable.
export default defineConfig(({ mode }) => {
	if (mode === "docker") {
		return {
			test: {
				include: ["apps/*/test/**/*.docker.test.ts"],
				env: { NODE_ENV: "test" },
				globalSetup: ["apps/server/test/global-setup.ts"],
				fileParallelism: false,
				testTimeout: 180_000,
				hookTimeout: 180_000,
			},
		};
	}
	if (mode === "live") {
		return {
			test: {
				include: ["apps/*/test/**/*.live.test.ts"],
				env: { NODE_ENV: "test", TRACERA_LIVE_TESTS: "1" },
				testTimeout: 180_000,
			},
		};
	}
	return {
		test: {
			env: { NODE_ENV: "test" },
			projects: [
				{
					extends: true,
					test: {
						name: "unit",
						include: [
							"packages/*/test/**/*.test.ts",
							"apps/*/test/**/*.test.ts",
						],
						exclude: [
							"**/*.int.test.ts",
							"**/*.live.test.ts",
							"**/*.docker.test.ts",
							"**/node_modules/**",
							// The web app has its own Vitest (jsdom) and Playwright configuration.
							"apps/web/**",
							// So does the Chrome extension (browser globals, build-time defines).
							"apps/extension/**",
						],
					},
				},
				{
					extends: true,
					test: {
						name: "integration",
						include: ["apps/*/test/**/*.int.test.ts"],
						globalSetup: ["apps/server/test/global-setup.ts"],
						fileParallelism: false,
						testTimeout: 30_000,
						hookTimeout: 120_000,
					},
				},
			],
		},
	};
});
