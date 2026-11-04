import path from "node:path";
import { CreateRepositoryRequestSchema } from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import {
	demoRepositories,
	indexNeeds,
	judgeFromEnv,
	missingRepositories,
	reasonOf,
	shopUiPath,
} from "../../../scripts/bootstrap.ts";

const PASSWORD = "a-long-enough-password";

describe("judgeFromEnv", () => {
	it.each([
		["nothing is set", {}],
		["both are empty", { TRACERA_JUDGE_EMAIL: "", TRACERA_JUDGE_PASSWORD: "" }],
	])("configures no account when %s", (_case, env) => {
		expect(judgeFromEnv(env)).toBeNull();
	});

	it.each([
		[
			"only the email is set",
			{ TRACERA_JUDGE_EMAIL: "judge@example.com" },
			"must both be set",
		],
		[
			"only the password is set",
			{ TRACERA_JUDGE_PASSWORD: PASSWORD },
			"must both be set",
		],
		[
			"the password is too short",
			{
				TRACERA_JUDGE_EMAIL: "judge@example.com",
				TRACERA_JUDGE_PASSWORD: "short",
			},
			"characters",
		],
		[
			"the password is too long to sign in with",
			{
				TRACERA_JUDGE_EMAIL: "judge@example.com",
				TRACERA_JUDGE_PASSWORD: "x".repeat(300),
			},
			"characters",
		],
		[
			"the email is not an address",
			{ TRACERA_JUDGE_EMAIL: "not-an-email", TRACERA_JUDGE_PASSWORD: PASSWORD },
			"valid email",
		],
	])("names the problem when %s", (_case, env, expected) => {
		const result = judgeFromEnv(env);
		expect(result && "problem" in result ? result.problem : null).toContain(
			expected,
		);
	});

	it("accepts the reserved example domain used for the shared judge login", () => {
		expect(
			judgeFromEnv({
				TRACERA_JUDGE_EMAIL: "judge@tracera.example",
				TRACERA_JUDGE_PASSWORD: PASSWORD,
			}),
		).toEqual({
			judge: { email: "judge@tracera.example", password: PASSWORD },
		});
	});

	it("returns the account with a trimmed, lower-case email and the password untouched", () => {
		expect(
			judgeFromEnv({
				TRACERA_JUDGE_EMAIL: "  Judge@Example.COM ",
				TRACERA_JUDGE_PASSWORD: PASSWORD,
			}),
		).toEqual({ judge: { email: "judge@example.com", password: PASSWORD } });
	});
});

describe("demoRepositories", () => {
	it("registers the Bench Shop fixture and the shop app from the given path", () => {
		const repositories = demoRepositories("/tmp/repos/shop-ui");
		expect(repositories.map((repository) => repository.name)).toEqual([
			"bench-shop",
			"shop-ui",
		]);
		expect(repositories[0]?.source).toEqual({
			type: "fixture",
			fixture: "bench-shop",
		});
		expect(repositories[1]?.source).toEqual({
			type: "local_path",
			path: "/tmp/repos/shop-ui",
		});
		expect(repositories[1]?.app).toEqual({
			port: 4173,
			ready_path: "/health",
			base_url_path: "/cart",
		});
	});

	it("builds requests that the registration endpoint accepts", () => {
		for (const repository of demoRepositories("/tmp/repos/shop-ui"))
			expect(CreateRepositoryRequestSchema.safeParse(repository).success).toBe(
				true,
			);
	});

	it("leaves out the shop app when it has nowhere to live", () => {
		expect(demoRepositories(null).map((repository) => repository.name)).toEqual(
			["bench-shop"],
		);
	});
});

describe("shopUiPath", () => {
	it("is inside the first repository root", () => {
		expect(shopUiPath(["/tmp/repos", "/srv/other"])).toBe(
			path.join("/tmp/repos", "shop-ui"),
		);
	});

	it("is nowhere without a repository root", () => {
		expect(shopUiPath([])).toBeNull();
	});
});

describe("missingRepositories", () => {
	const wanted = demoRepositories("/tmp/repos/shop-ui");

	it.each([
		["nothing is registered", [], ["bench-shop", "shop-ui"]],
		["one is registered", ["bench-shop"], ["shop-ui"]],
		["the other is registered", ["shop-ui"], ["bench-shop"]],
		["both are registered", ["shop-ui", "bench-shop"], []],
		["only other repositories exist", ["billing"], ["bench-shop", "shop-ui"]],
	])("registers the right ones when %s", (_case, existing, expected) => {
		expect(
			missingRepositories(existing, wanted).map(
				(repository) => repository.name,
			),
		).toEqual(expected);
	});
});

describe("indexNeeds", () => {
	it.each([
		["ready", "nothing"],
		["partial", "nothing"],
		["queued", "time"],
		["indexing", "time"],
		["failed", "request"],
		["cancelled", "request"],
		[null, "request"],
		[undefined, "request"],
	] as const)("a newest snapshot of %s needs %s", (status, expected) => {
		expect(indexNeeds(status)).toBe(expected);
	});
});

describe("reasonOf", () => {
	it("quotes the cause of a failed query, never the values in its own message", () => {
		const failed = new Error(
			"Failed query: insert into users values ($1)\nparams: FAKE-VALUE-NOT-TO-APPEAR",
			{ cause: new Error("duplicate key value violates unique constraint") },
		);
		expect(reasonOf(failed)).toBe(
			"duplicate key value violates unique constraint",
		);
	});

	it("is one line, cut at a fixed length", () => {
		expect(reasonOf(new Error("first\n   second"))).toBe("first second");
		expect(reasonOf(new Error("x".repeat(500)))).toHaveLength(300);
	});

	it("describes a value that is not an error", () => {
		expect(reasonOf("refused")).toBe("refused");
	});
});
