import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_IMAGE } from "../src/config.ts";
import { parseTap } from "../src/modules/verification.ts";
import { createDockerExecutor } from "../src/sandbox/docker.ts";
import { docker, pkg, quiet, serveRegistry, sri } from "./npm-registry.ts";

// Security acceptance tests for dependency preparation [real Docker, nothing mocked]. A local
// registry and a second host sit on a test egress network; the preparation runs exactly as in
// production (seed, internal network, egress proxy, `npm ci --ignore-scripts`, seal). Requires Docker
// and `npm run sandbox:pull`. These tests fail, never skip, without Docker.

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tracera-deps-")));
const TAG = `deps-test-${process.pid}`;
const EGRESS = `tracera-test-egress-${process.pid}`;
const REGISTRY_HOST = `tracera-test-registry-${process.pid}`;
const OTHER_HOST = `tracera-test-other-${process.pid}`;
const REGISTRY = `http://${REGISTRY_HOST}:4873/`;
const IMAGE = DEFAULT_SANDBOX_IMAGE;
const executor = createDockerExecutor({
	image: IMAGE,
	workspacesRoot: root,
	workerId: TAG,
	instance: TAG,
	egressNetwork: EGRESS,
});
const LEFT_PAD = pkg(
	"left-pad",
	"1.3.0",
	'module.exports = (s, n, c = " ") => String(s).padStart(n, c);\n',
);
const EVIL = pkg("evil", "1.0.0", "module.exports = 'evil';\n");
const SLOW = pkg("slow", "1.0.0", "module.exports = 'slow';\n");

const serve = (name: string, files: Record<string, Buffer>) =>
	serveRegistry({
		name,
		network: EGRESS,
		label: `tracera.test=${TAG}`,
		image: IMAGE,
		files,
	});

type Dep = { name: string; version: string; url: string; bytes: Buffer };
/** package.json and a v3 lockfile for these exact tarballs. */
function project(deps: Dep[], integrityOf = (dep: Dep) => sri(dep.bytes)) {
	const dependencies = Object.fromEntries(deps.map((d) => [d.name, d.version]));
	return {
		"package.json": JSON.stringify({
			name: "app",
			version: "1.0.0",
			dependencies,
		}),
		"package-lock.json": JSON.stringify({
			name: "app",
			version: "1.0.0",
			lockfileVersion: 3,
			requires: true,
			packages: {
				"": { name: "app", version: "1.0.0", dependencies },
				...Object.fromEntries(
					deps.map((dep) => [
						`node_modules/${dep.name}`,
						{
							version: dep.version,
							resolved: dep.url,
							integrity: integrityOf(dep),
						},
					]),
				),
			},
		}),
	};
}
const leftPad: Dep = {
	name: "left-pad",
	version: "1.3.0",
	url: `${REGISTRY}left-pad/-/left-pad-1.3.0.tgz`,
	bytes: LEFT_PAD,
};
const slow: Dep = {
	name: "slow",
	version: "1.0.0",
	url: `${REGISTRY}slow/-/slow-1.0.0.tgz`,
	bytes: SLOW,
};
function input(name: string, files: Record<string, string>) {
	const dir = path.join(root, name, "input");
	mkdirSync(dir, { recursive: true });
	for (const [file, content] of Object.entries(files))
		writeFileSync(path.join(dir, file), content);
	return dir;
}
const prepare = (
	prepId: string,
	files: Record<string, string>,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
) =>
	executor.prepare(
		{
			prepId,
			scope: "repo_docker",
			input: input(prepId, files),
			registry: REGISTRY,
			timeoutMs: options.timeoutMs ?? 120_000,
		},
		options.signal,
	);
/** Nothing of a preparation may outlive it except, on success, its artifact. */
const leftovers = (prepId: string) => ({
	containers: quiet(
		"ps",
		"-a",
		"-q",
		"--filter",
		`label=tracera.deps=${prepId}`,
	),
	network: quiet(
		"network",
		"ls",
		"-q",
		"--filter",
		`name=tracera-net-${prepId}`,
	),
	volume: quiet(
		"volume",
		"ls",
		"-q",
		"--filter",
		`name=tracera-deps-${prepId}`,
	),
});

beforeAll(async () => {
	const status = await executor.status();
	if (!status.available)
		throw new Error(
			`The Docker sandbox is unavailable (${status.detail}); these acceptance tests must not be skipped`,
		);
	quiet("network", "create", "--label", `tracera.test=${TAG}`, EGRESS);
	await serve(REGISTRY_HOST, {
		"/left-pad/-/left-pad-1.3.0.tgz": LEFT_PAD,
		"/slow/-/slow-1.0.0.tgz": SLOW,
	});
	await serve(OTHER_HOST, { "/evil/-/evil-1.0.0.tgz": EVIL });
});

afterAll(() => {
	quiet("rm", "-f", REGISTRY_HOST, OTHER_HOST);
	for (const volume of quiet(
		"volume",
		"ls",
		"-q",
		"--filter",
		`label=tracera.instance=${TAG}`,
	)
		.split(/\s+/)
		.filter(Boolean))
		quiet("volume", "rm", "-f", volume);
	quiet("network", "rm", EGRESS);
});

describe("dependency preparation [real Docker, egress proxy, sealed artifacts]", () => {
	let digest = "";

	it("installs exactly the locked tarballs through the proxy, seals them, and leaves only the artifact", async () => {
		const result = await prepare("dep_ok-1", project([leftPad]));
		expect(result.stderr).not.toMatch(/npm (ERR!|error)/);
		expect(result).toMatchObject({
			status: "succeeded",
			volume: "tracera-deps-dep_ok-1",
			seal: { mounts: ["node_modules"] },
		});
		expect(result.seal?.files).toBeGreaterThanOrEqual(2);
		// Every request went through the proxy to the registry, and nothing else was asked for.
		expect(result.egress.allowed).toBeGreaterThanOrEqual(1);
		expect(result.egress).toMatchObject({
			denied: 0,
			targets: [`${REGISTRY_HOST}:4873`],
		});
		expect(leftovers("dep_ok-1")).toEqual({
			containers: "",
			network: "",
			volume: "tracera-deps-dep_ok-1",
		});
		digest = result.seal?.digest ?? "";
		expect(
			(await executor.inspectArtifact("tracera-deps-dep_ok-1"))?.digest,
		).toBe(digest);
	});

	it("verifies offline against the artifact: imports work, the network does not, node_modules cannot change", async () => {
		const workspace = path.join(root, "inv_deps", "run-1");
		mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
		writeFileSync(
			path.join(workspace, "deps.test.mjs"),
			`import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
test("imports the prepared dependency", () => {
  assert.equal(require("left-pad")("7", 3, "0"), "007");
});
test("cannot reach the registry", async () => {
  await assert.rejects(fetch(${JSON.stringify(leftPad.url)}));
});
test("cannot change node_modules", () => {
  assert.throws(() => writeFileSync("node_modules/left-pad/index.js", "tampered"), { code: "EROFS" });
});
test("can write the cache overlay", () => {
  writeFileSync("node_modules/.cache/ok", "x");
});
`,
		);
		const result = await executor.run({
			runId: `${TAG}-verify`,
			investigationId: "inv_deps",
			workspace,
			argv: ["node", "--test", "deps.test.mjs"],
			env: { CI: "1", NODE_OPTIONS: "--test-reporter=tap" },
			timeoutMs: 60_000,
			dependencies: {
				volume: "tracera-deps-dep_ok-1",
				mounts: ["node_modules"],
			},
		});
		const tap = parseTap(result.stdout);
		expect(result.status).toBe("exited");
		expect({ pass: tap.pass, fail: tap.fail }, result.stdout).toEqual({
			pass: 4,
			fail: 0,
		});
		// Nothing the seal covers changed.
		expect(
			(await executor.inspectArtifact("tracera-deps-dep_ok-1"))?.digest,
		).toBe(digest);
	});

	it("detects an artifact changed after sealing, and removes artifacts on request", async () => {
		docker(
			"run",
			"--rm",
			"--user",
			"1000:1000",
			"--mount",
			"type=volume,source=tracera-deps-dep_ok-1,target=/v",
			IMAGE,
			"node",
			"-e",
			"require('node:fs').appendFileSync('/v/app/node_modules/left-pad/index.js', '//x')",
		);
		const changed = await executor.inspectArtifact("tracera-deps-dep_ok-1");
		expect(changed?.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(changed?.digest).not.toBe(digest);
		await executor.removeArtifact("tracera-deps-dep_ok-1");
		expect(await executor.inspectArtifact("tracera-deps-dep_ok-1")).toBeNull();
	});

	it("refuses every host but the registry, even for a lockfile the policy would have rejected", async () => {
		const evil: Dep = {
			name: "evil",
			version: "1.0.0",
			url: `http://${OTHER_HOST}:4873/evil/-/evil-1.0.0.tgz`,
			bytes: EVIL,
		};
		const result = await prepare("dep_evil-1", project([evil]));
		expect(result.status).toBe("failed");
		expect(result.egress.denied).toBeGreaterThanOrEqual(1);
		expect(result.egress.denied_targets).toContain(`${OTHER_HOST}:4873`);
		expect(result.egress.targets).not.toContain(`${OTHER_HOST}:4873`);
		expect(leftovers("dep_evil-1")).toEqual({
			containers: "",
			network: "",
			volume: "",
		});
	});

	it("gives the preparation network no route and no DNS of its own", () => {
		const network = `tracera-test-internal-${process.pid}`;
		docker(
			"network",
			"create",
			"--internal",
			"--label",
			`tracera.test=${TAG}`,
			network,
		);
		try {
			const registryIp = docker(
				"inspect",
				"--format",
				"{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
				REGISTRY_HOST,
			);
			const probe = docker(
				"run",
				"--rm",
				"--network",
				network,
				"--user",
				"1000:1000",
				IMAGE,
				"node",
				"-e",
				`const dns = require("node:dns"); const net = require("node:net");
const tcp = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 3000 });
  s.on("connect", () => { s.destroy(); resolve("connected"); });
  s.on("timeout", () => { s.destroy(); resolve("timeout"); });
  s.on("error", (e) => resolve(e.code));
});
dns.lookup("example.com", async (error) => {
  console.log(JSON.stringify({
    dns: error ? "failed" : "resolved",
    registry: await tcp(${JSON.stringify(registryIp)}, 4873),
    internet: await tcp("1.1.1.1", 443),
  }));
});`,
			);
			const outcome = JSON.parse(probe.split("\n").at(-1) ?? "{}");
			expect(outcome.dns).toBe("failed");
			expect(outcome.registry).not.toBe("connected");
			expect(outcome.internet).not.toBe("connected");
		} finally {
			quiet("network", "rm", network);
		}
	});

	it("installs in a hardened container with only the artifact mounted and no host secrets, and cancels cleanly", async () => {
		process.env.TRACERA_TEST_SECRET = "do-not-leak-7f3a";
		const controller = new AbortController();
		const running = prepare("dep_slow-1", project([slow]), {
			signal: controller.signal,
		});
		let inspected = "";
		for (let i = 0; i < 240 && !inspected; i++) {
			inspected = quiet("inspect", "tracera-install-dep_slow-1");
			if (!inspected) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		expect(inspected).not.toBe("");
		const [container] = JSON.parse(inspected) as Array<{
			Config: { User: string; Env: string[] };
			HostConfig: {
				ReadonlyRootfs: boolean;
				CapDrop: string[];
				SecurityOpt: string[];
				Memory: number;
				PidsLimit: number;
				NetworkMode: string;
				Binds: string[] | null;
			};
			Mounts: Array<{ Type: string; Name?: string; Destination: string }>;
		}>;
		expect(container?.Config.User).toBe("1000:1000");
		expect(container?.Config.Env.join("\n")).not.toContain("do-not-leak-7f3a");
		expect(container?.Config.Env).toContain("npm_config_ignore_scripts=true");
		expect(container?.HostConfig).toMatchObject({
			ReadonlyRootfs: true,
			CapDrop: ["ALL"],
			Memory: 2048 * 1024 * 1024,
			PidsLimit: 512,
			NetworkMode: "tracera-net-dep_slow-1",
		});
		expect(container?.HostConfig.SecurityOpt).toContain("no-new-privileges");
		expect(container?.HostConfig.Binds ?? []).toEqual([]);
		expect(
			container?.Mounts.map((mount) => [
				mount.Type,
				mount.Name,
				mount.Destination,
			]),
		).toEqual([["volume", "tracera-deps-dep_slow-1", "/home/node"]]);
		controller.abort();
		const result = await running;
		delete process.env.TRACERA_TEST_SECRET;
		expect(result.status).toBe("cancelled");
		expect(leftovers("dep_slow-1")).toEqual({
			containers: "",
			network: "",
			volume: "",
		});
	});

	it("times out a hung install and removes everything", async () => {
		const started = Date.now();
		const result = await prepare("dep_hang-1", project([slow]), {
			timeoutMs: 30_000,
		});
		expect(result.status).toBe("timed_out");
		expect(Date.now() - started).toBeLessThan(120_000);
		expect(leftovers("dep_hang-1")).toEqual({
			containers: "",
			network: "",
			volume: "",
		});
	});

	it("fails a lockfile whose integrity does not match its tarball and keeps nothing", async () => {
		const result = await prepare(
			"dep_bad-1",
			project([leftPad], () => sri(Buffer.from("something else"))),
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe("failed");
		expect(`${result.stdout}\n${result.stderr}`).toContain("EINTEGRITY");
		expect(leftovers("dep_bad-1")).toEqual({
			containers: "",
			network: "",
			volume: "",
		});
	});
});
