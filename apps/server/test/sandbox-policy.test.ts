import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type PrepareRequest,
	parseRepositoryCommand,
	REPRO_ARGV,
	type SandboxRunRequest,
	validatePrepareRequest,
	validateRunRequest,
} from "../src/sandbox/executor.ts";

describe("parseRepositoryCommand (command allowlist)", () => {
	it.each([
		["npm test", ["npm", "test"]],
		["  npm   run   lint ", ["npm", "run", "lint"]],
		["npm run test:unit", ["npm", "run", "test:unit"]],
		["node --test", ["node", "--test"]],
		[
			"node --test test/a.test.js src",
			["node", "--test", "test/a.test.js", "src"],
		],
	])("allows %s", (command, argv) => {
		expect(parseRepositoryCommand(command)).toEqual({ ok: true, argv });
	});

	it.each([
		"npm test; rm -rf /",
		"npm test && curl http://x",
		"npm test | sh",
		"npm run $(whoami)",
		"npm run `id`",
		"npm test > /tmp/out",
		"npm run 'lint'",
		"npm test\nrm -rf /",
		"npm ci",
		"npm install",
		"npm run lint --prefix=/",
		"npx vitest",
		"yarn test",
		"sh -c npm",
		"node -e process.exit(0)",
		"node --test ../outside",
		"node --test /etc/passwd",
		"node --test --require=./hook.js",
		"node script.js",
		"",
	])("rejects %j", (command) => {
		expect(parseRepositoryCommand(command).ok).toBe(false);
	});
});

describe("validateRunRequest", () => {
	const root = mkdtempSync(path.join(tmpdir(), "tracera-ws-"));
	const workspace = path.join(root, "inv_x", "run-1");
	mkdirSync(workspace, { recursive: true });
	const outside = mkdtempSync(path.join(tmpdir(), "tracera-outside-"));
	const junction = path.join(root, "inv_x", "run-link");
	symlinkSync(outside, junction, "junction");

	const request = (
		overrides: Partial<SandboxRunRequest> = {},
	): SandboxRunRequest => ({
		runId: "inv_x-reproduce_baseline-1-repro-1",
		investigationId: "inv_x",
		workspace,
		argv: REPRO_ARGV,
		env: { CI: "1" },
		timeoutMs: 60_000,
		...overrides,
	});
	const codeOf = (promise: Promise<unknown>) =>
		promise.then(
			() => "ok",
			(error: { code?: string }) => error.code ?? "unknown",
		);

	it("accepts a workspace inside the workspaces root with fixed argv", async () => {
		expect(await codeOf(validateRunRequest(request(), root))).toBe("ok");
	});

	it.each([
		["a path outside the root", { workspace: outside }, "invalid_workspace"],
		["the root itself", { workspace: root }, "invalid_workspace"],
		[
			"traversal out of the root",
			{ workspace: path.join(root, "inv_x", "..", "..") },
			"invalid_workspace",
		],
		["a relative path", { workspace: "inv_x/run-1" }, "invalid_workspace"],
		[
			"a missing directory",
			{ workspace: path.join(root, "nope") },
			"invalid_workspace",
		],
		["a symlink or junction", { workspace: junction }, "invalid_workspace"],
		["a shell", { argv: ["sh", "-c", "id"] }, "invalid_argv"],
		[
			"inline code",
			{ argv: ["node", "-e", "require('child_process')"] },
			"invalid_argv",
		],
		[
			"shell metacharacters",
			{ argv: ["npm", "test", ";", "id"] },
			"invalid_argv",
		],
		["parent paths", { argv: ["node", "--test", "../x.mjs"] }, "invalid_argv"],
		["empty argv", { argv: [] }, "invalid_argv"],
		[
			"secret variables",
			{ env: { DATABASE_URL: "postgres://x" } },
			"invalid_env",
		],
		[
			"preload injection",
			{ env: { NODE_OPTIONS: "--require=/tmp/x.js" } },
			"invalid_env",
		],
		["a zero timeout", { timeoutMs: 0 }, "invalid_timeout"],
		["an unbounded timeout", { timeoutMs: 86_400_000 }, "invalid_timeout"],
		["an unsafe run id", { runId: "../Escape Me" }, "invalid_run_id"],
	] as const)("rejects %s", async (_label, overrides, code) => {
		expect(
			await codeOf(
				validateRunRequest(
					request(overrides as Partial<SandboxRunRequest>),
					root,
				),
			),
		).toBe(code);
	});

	describe("dependency mounts", () => {
		const withDeps = path.join(root, "inv_x", "run-deps");
		mkdirSync(path.join(withDeps, "node_modules"), { recursive: true });
		mkdirSync(path.join(withDeps, "packages", "a", "node_modules"), {
			recursive: true,
		});
		symlinkSync(outside, path.join(withDeps, "linked"), "junction");
		const deps = (volume: string, mounts: string[]) =>
			request({ workspace: withDeps, dependencies: { volume, mounts } });

		it("accepts a Tracera artifact mounted at existing node_modules directories", async () => {
			expect(
				await codeOf(
					validateRunRequest(
						deps("tracera-deps-dep_01-1", [
							"node_modules",
							"packages/a/node_modules",
						]),
						root,
					),
				),
			).toBe("ok");
		});

		it.each([
			["another volume", "tracera-other", ["node_modules"]],
			["a host path as the volume", "/var/run/docker.sock", ["node_modules"]],
			["a mount that is not node_modules", "tracera-deps-x", ["src"]],
			["a parent segment", "tracera-deps-x", ["../node_modules"]],
			["an absolute mount", "tracera-deps-x", ["/work/node_modules"]],
			["a hidden segment", "tracera-deps-x", [".git/node_modules"]],
			["a missing mount point", "tracera-deps-x", ["lib/node_modules"]],
			[
				"a mount reached through a link",
				"tracera-deps-x",
				["linked/node_modules"],
			],
			[
				"too many mounts",
				"tracera-deps-x",
				Array.from({ length: 33 }, () => "node_modules"),
			],
		])("rejects %s", async (_label, volume, mounts) => {
			expect(await codeOf(validateRunRequest(deps(volume, mounts), root))).toBe(
				"invalid_dependencies",
			);
		});
	});
});

describe("validatePrepareRequest", () => {
	const root = mkdtempSync(path.join(tmpdir(), "tracera-ws-"));
	const input = path.join(root, "dep_x", "input");
	mkdirSync(input, { recursive: true });
	const outside = mkdtempSync(path.join(tmpdir(), "tracera-outside-"));
	const request = (
		overrides: Partial<PrepareRequest> = {},
	): PrepareRequest => ({
		prepId: "dep_x-1",
		scope: "repo_x",
		input,
		registry: "https://registry.npmjs.org/",
		timeoutMs: 600_000,
		...overrides,
	});
	const codeOf = (promise: Promise<unknown>) =>
		promise.then(
			() => "ok",
			(error: { code?: string }) => error.code ?? "unknown",
		);

	it("accepts an input directory inside the root and an http(s) registry", async () => {
		expect(await codeOf(validatePrepareRequest(request(), root))).toBe("ok");
		expect(
			await codeOf(
				validatePrepareRequest(
					request({ registry: "http://registry.internal:4873/" }),
					root,
				),
			),
		).toBe("ok");
	});

	it.each([
		[
			"credentials in the registry",
			{ registry: "https://u:p@registry.npmjs.org/" },
			"invalid_registry",
		],
		[
			"another scheme",
			{ registry: "ftp://registry.npmjs.org/" },
			"invalid_registry",
		],
		[
			"a query",
			{ registry: "https://registry.npmjs.org/?token=x" },
			"invalid_registry",
		],
		["not a URL", { registry: "registry.npmjs.org" }, "invalid_registry"],
		["a short timeout", { timeoutMs: 1_000 }, "invalid_timeout"],
		["an unbounded timeout", { timeoutMs: 86_400_000 }, "invalid_timeout"],
		["an input outside the root", { input: outside }, "invalid_workspace"],
		["an unsafe id", { prepId: "../x" }, "invalid_run_id"],
	] as const)("rejects %s", async (_label, overrides, code) => {
		expect(
			await codeOf(
				validatePrepareRequest(
					request(overrides as Partial<PrepareRequest>),
					root,
				),
			),
		).toBe(code);
	});
});
