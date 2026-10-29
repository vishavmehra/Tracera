import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const base = { DATABASE_URL: "postgres://tracera:pw@127.0.0.1:5432/tracera" };

describe("loadConfig", () => {
	it("applies safe defaults when only DATABASE_URL is set", () => {
		const config = loadConfig(base);
		expect(config.inference.provider).toBe("mock");
		expect(config.api.host).toBe("127.0.0.1");
		expect(config.api.port).toBe(8787);
		expect(config.repoRoots).toEqual([]);
		expect(config.dataDir.replaceAll("\\", "/")).toMatch(/\/\.tracera$/);
		expect(config.inference.dailyBudgetUsd).toBe(5);
	});

	it("treats empty strings as unset", () => {
		const config = loadConfig({
			...base,
			TRACERA_API_PORT: "",
			TRACERA_INFERENCE_PROVIDER: "",
		});
		expect(config.api.port).toBe(8787);
		expect(config.inference.provider).toBe("mock");
	});

	it("names every missing variable for the openai_compatible provider", () => {
		const attempt = () =>
			loadConfig({
				...base,
				TRACERA_INFERENCE_PROVIDER: "openai_compatible",
				TRACERA_OPENAI_COMPAT_BASE_URL: "https://x/v1",
			});
		expect(attempt).toThrow(ConfigError);
		expect(attempt).toThrow(/TRACERA_OPENAI_COMPAT_API_KEY/);
		expect(attempt).toThrow(/TRACERA_MODEL_REASONING/);
	});

	it("never echoes secret values in error messages", () => {
		try {
			loadConfig({
				DATABASE_URL: "not-a-url-s3cr3t",
				TRACERA_INFERENCE_PROVIDER: "meta",
				TRACERA_META_API_KEY: "LLM_123_supersecret",
				TRACERA_API_PORT: "not-a-port",
			});
			expect.unreachable("loadConfig should have thrown");
		} catch (error) {
			const message = String((error as Error).message);
			expect(message).toMatch(/DATABASE_URL/);
			expect(message).toMatch(/TRACERA_API_PORT/);
			expect(message).not.toContain("s3cr3t");
			expect(message).not.toContain("supersecret");
		}
	});

	it("defaults the Meta reasoning model to muse-spark-1.3", () => {
		const config = loadConfig({
			...base,
			TRACERA_INFERENCE_PROVIDER: "meta",
			TRACERA_META_API_KEY: "LLM_1_x",
		});
		expect(config.inference.provider).toBe("meta");
		expect(config.inference.reasoningModel).toBe("muse-spark-1.3");
		expect(config.inference.baseUrl).toBe("https://api.meta.ai/v1");
	});

	it("parses semicolon-separated repository roots", () => {
		const config = loadConfig({
			...base,
			TRACERA_REPO_ROOTS: "D:/repos; C:/work/code ;",
		});
		expect(config.repoRoots).toEqual(["D:/repos", "C:/work/code"]);
	});

	it("rejects an unknown provider", () => {
		expect(() =>
			loadConfig({ ...base, TRACERA_INFERENCE_PROVIDER: "llama" }),
		).toThrow(/TRACERA_INFERENCE_PROVIDER/);
	});
});
