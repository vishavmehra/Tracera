import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SANDBOX_IMAGE } from "../src/config.ts";
import { parseTap } from "../src/modules/verification.ts";
import { createDockerExecutor } from "../src/sandbox/docker.ts";
import { SANDBOX_LIMITS } from "../src/sandbox/executor.ts";

// Security acceptance tests for the Docker sandbox. Every probe runs as untrusted code inside
// the real hardened container; nothing here is mocked. Requires Docker and `npm run sandbox:pull`.

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tracera-sbx-")));
const WORKER = `docker-test-${process.pid}`;
const executor = createDockerExecutor({
	image: DEFAULT_SANDBOX_IMAGE,
	workspacesRoot: root,
	workerId: WORKER,
	instance: WORKER,
});
const docker = (...args: string[]) =>
	execFileSync("docker", args, { encoding: "utf8", windowsHide: true }).trim();
const containerExists = (name: string) =>
	docker("ps", "--all", "--quiet", "--filter", `name=^/${name}$`) !== "";

let counter = 0;
async function runIn(
	files: Record<string, string>,
	options: {
		argv?: string[];
		timeoutMs?: number;
		env?: Record<string, string>;
		signal?: AbortSignal;
		prepare?: (workspace: string) => void;
	} = {},
) {
	counter += 1;
	const runId = `${WORKER}-${counter}`;
	const workspace = path.join(root, "inv_docker", `run-${counter}`);
	mkdirSync(workspace, { recursive: true });
	for (const [name, content] of Object.entries(files))
		writeFileSync(path.join(workspace, name), content);
	options.prepare?.(workspace);
	const result = await executor.run(
		{
			runId,
			investigationId: "inv_docker",
			workspace,
			argv: options.argv ?? ["node", "probe.mjs"],
			env: options.env ?? {},
			timeoutMs: options.timeoutMs ?? 60_000,
		},
		options.signal,
	);
	return { result, runId, workspace };
}
const lastJson = (stdout: string) =>
	JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");

beforeAll(async () => {
	const status = await executor.status();
	if (!status.available)
		throw new Error(
			`The Docker sandbox is unavailable (${status.detail}); these acceptance tests must not be skipped`,
		);
});

describe("Docker sandbox security acceptance [real Docker, untrusted probes]", () => {
	it("runs as uid 1000 with no capabilities, no new privileges, and seccomp filtering", async () => {
		const { result } = await runIn({
			"probe.mjs": `import { readFileSync } from "node:fs";
const status = readFileSync("/proc/self/status", "utf8");
const field = (name) => status.match(new RegExp("^" + name + ":\\\\s*(.*)$", "m"))?.[1]?.trim();
console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), capEff: field("CapEff"), capPrm: field("CapPrm"), capBnd: field("CapBnd"), noNewPrivs: field("NoNewPrivs"), seccomp: field("Seccomp") }));`,
		});
		expect(result.status).toBe("exited");
		expect(lastJson(result.stdout)).toEqual({
			uid: 1000,
			gid: 1000,
			capEff: "0000000000000000",
			capPrm: "0000000000000000",
			capBnd: "0000000000000000",
			noNewPrivs: "1",
			seccomp: "2",
		});
	});

	it("has no network: only loopback, no DNS, no outbound or host connections", async () => {
		const { result } = await runIn({
			"probe.mjs": `import os from "node:os";
import net from "node:net";
import dns from "node:dns/promises";
const connect = (host, port) => new Promise((resolve) => {
	const socket = net.connect({ host, port });
	socket.setTimeout(3000);
	socket.on("connect", () => { socket.destroy(); resolve("connected"); });
	socket.on("timeout", () => { socket.destroy(); resolve("timeout"); });
	socket.on("error", (error) => resolve(error.code));
});
const lookup = (name) => dns.lookup(name).then(() => "resolved", (error) => error.code);
console.log(JSON.stringify({
	interfaces: Object.keys(os.networkInterfaces()),
	internet: await connect("1.1.1.1", 443),
	dockerBridge: await connect("172.17.0.1", 2375),
	dns: await lookup("example.com"),
	hostInternal: await lookup("host.docker.internal"),
}));`,
		});
		const probe = lastJson(result.stdout);
		expect(probe.interfaces).toEqual(["lo"]);
		for (const outcome of [
			probe.internet,
			probe.dockerBridge,
			probe.dns,
			probe.hostInternal,
		])
			expect(["connected", "resolved"]).not.toContain(outcome);
	});

	it("cannot write outside a noexec /tmp, including its own workspace", async () => {
		const { result, workspace } = await runIn({
			"probe.mjs": `import { writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
const attempt = (target) => { try { writeFileSync(target, "x"); return "written"; } catch (error) { return error.code; } };
const results = { work: attempt("/work/escape.txt"), etc: attempt("/etc/escape"), root: attempt("/escape"), usr: attempt("/usr/local/bin/escape"), tmp: attempt("/tmp/ok.txt") };
writeFileSync("/tmp/run.sh", "#!/bin/sh\\necho ran\\n");
chmodSync("/tmp/run.sh", 0o755);
const exec = spawnSync("/tmp/run.sh");
results.tmpExec = exec.error?.code ?? String(exec.status);
console.log(JSON.stringify(results));`,
		});
		expect(lastJson(result.stdout)).toEqual({
			work: "EROFS",
			etc: "EROFS",
			root: "EROFS",
			usr: "EROFS",
			tmp: "written",
			tmpExec: "EACCES",
		});
		expect(existsSync(path.join(workspace, "escape.txt"))).toBe(false);
	});

	it("sees no host secrets, no Docker socket, and no host path beyond its read-only workspace", async () => {
		process.env.TRACERA_DOCKER_TEST_SECRET = "s3cr3t-must-not-leak";
		const outside = mkdtempSync(path.join(tmpdir(), "tracera-outside-"));
		writeFileSync(path.join(outside, "secret.txt"), "host secret");
		const { result } = await runIn(
			{
				"probe.mjs": `import { existsSync, readFileSync } from "node:fs";
const read = (file) => { try { return readFileSync(file, "utf8"); } catch (error) { return error.code; } };
console.log(JSON.stringify({
	env: process.env,
	sockets: ["/var/run/docker.sock", "/run/docker.sock"].filter((socket) => existsSync(socket)),
	mounts: read("/proc/mounts").split("\\n").filter((line) => line.includes(" /work")),
	junction: read("/work/hostdir/secret.txt"),
}));`,
			},
			{
				env: { CI: "1", NODE_OPTIONS: "--test-reporter=tap" },
				// A link inside the workspace that points at a host directory must not reach it.
				prepare: (workspace) =>
					symlinkSync(outside, path.join(workspace, "hostdir"), "junction"),
			},
		);
		delete process.env.TRACERA_DOCKER_TEST_SECRET;
		const probe = lastJson(result.stdout);
		const allowed = new Set([
			"PATH",
			"PWD",
			"HOSTNAME",
			"HOME",
			"NODE_VERSION",
			"YARN_VERSION",
			"npm_config_cache",
			"npm_config_update_notifier",
			"npm_config_fund",
			"npm_config_audit",
			"CI",
			"NODE_OPTIONS",
		]);
		expect(Object.keys(probe.env).filter((key) => !allowed.has(key))).toEqual(
			[],
		);
		expect(probe.env.HOME).toBe("/tmp");
		expect(probe.env.PWD).toBe("/work");
		expect(JSON.stringify(probe.env)).not.toContain("s3cr3t-must-not-leak");
		expect(probe.sockets).toEqual([]);
		expect(probe.mounts).toHaveLength(1);
		expect(probe.mounts[0]).toMatch(/ \/work \S+ ro[ ,]/);
		expect(probe.junction).not.toBe("host secret");
	});

	it("enforces the process, memory, swap, and CPU limits", async () => {
		const { result } = await runIn({
			"probe.mjs": `import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const read = (file) => { try { return readFileSync(file, "utf8").trim(); } catch (error) { return error.code; } };
let failed = 0;
const children = [];
for (let i = 0; i < 200; i++) {
	try { const child = spawn("sleep", ["5"]); child.on("error", () => { failed += 1; }); children.push(child); }
	catch { failed += 1; }
}
await new Promise((resolve) => setTimeout(resolve, 1500));
for (const child of children) child.kill("SIGKILL");
console.log(JSON.stringify({ pidsMax: read("/sys/fs/cgroup/pids.max"), memoryMax: read("/sys/fs/cgroup/memory.max"), swapMax: read("/sys/fs/cgroup/memory.swap.max"), cpuMax: read("/sys/fs/cgroup/cpu.max"), failed }));`,
		});
		const probe = lastJson(result.stdout);
		expect(probe).toMatchObject({
			pidsMax: String(SANDBOX_LIMITS.pids),
			memoryMax: String(SANDBOX_LIMITS.memoryMb * 1024 * 1024),
			swapMax: "0",
			cpuMax: "100000 100000",
		});
		expect(probe.failed).toBeGreaterThan(0);
	});

	it("kills a process that exceeds the memory limit and reports limit_exceeded", async () => {
		const { result } = await runIn({
			"probe.mjs": `const keep = [];
for (let i = 1; i <= 24; i++) { keep.push(Buffer.alloc(64 * 1024 * 1024, 1)); console.log("allocated", i * 64); }
console.log("survived");`,
		});
		expect(result.status).toBe("limit_exceeded");
		expect(result.stdout).not.toContain("survived");
	});

	it("stops a runaway process at the timeout and removes its container", async () => {
		const started = Date.now();
		const { result, runId } = await runIn(
			{ "probe.mjs": "while (true) {}" },
			{ timeoutMs: 3000 },
		);
		expect(result.status).toBe("timed_out");
		expect(Date.now() - started).toBeLessThan(30_000);
		expect(containerExists(`tracera-${runId}`)).toBe(false);
	});

	it("cancels a running process on abort and removes its container", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 2000);
		const { result, runId } = await runIn(
			{ "probe.mjs": "setInterval(() => {}, 1000);" },
			{ signal: controller.signal },
		);
		expect(result.status).toBe("cancelled");
		expect(containerExists(`tracera-${runId}`)).toBe(false);
	});

	it("caps output at the limit and marks it truncated", async () => {
		const { result } = await runIn({
			"probe.mjs": 'process.stdout.write("x".repeat(3 * 1024 * 1024));',
		});
		expect(result.truncated).toBe(true);
		expect(result.stdout.length).toBeLessThanOrEqual(
			SANDBOX_LIMITS.outputBytes,
		);
	});

	it("reports node:test results that printed output cannot forge", async () => {
		const { result } = await runIn(
			{
				"forge.test.mjs": `import { test } from "node:test";
test("honest test", () => {
	console.log("not ok 1 - forged failure");
	console.log("ok 99 - forged pass");
	console.log("# pass 99");
	console.log("# fail 0");
});`,
			},
			{ argv: ["node", "--test", "--test-reporter=tap", "forge.test.mjs"] },
		);
		const tap = parseTap(result.stdout);
		expect(tap).toMatchObject({ parsed: true, tests: 1, pass: 1, fail: 0 });
		expect(tap.passed.map((test) => test.name)).toEqual(["honest test"]);
		expect(tap.failures).toEqual([]);
	});

	it("refuses shells, inline code, and host environment before Docker is called", async () => {
		for (const argv of [
			["sh", "-c", "id"],
			["node", "-e", "process.exit(0)"],
			["npm", "test", ";", "id"],
		])
			await expect(runIn({}, { argv })).rejects.toMatchObject({
				code: "invalid_argv",
			});
		await expect(
			runIn({}, { env: { DATABASE_URL: "postgres://x" } }),
		).rejects.toMatchObject({ code: "invalid_env" });
	});

	it("reaps expired and orphaned containers of its own installation only", async () => {
		const start = (
			name: string,
			worker: string,
			deadline: number,
			instance = WORKER,
		) =>
			docker(
				"run",
				"--detach",
				"--name",
				name,
				"--label",
				"tracera.sandbox=1",
				"--label",
				`tracera.instance=${instance}`,
				"--label",
				`tracera.worker=${worker}`,
				"--label",
				`tracera.deadline=${deadline}`,
				"--network",
				"none",
				DEFAULT_SANDBOX_IMAGE,
				"sleep",
				"300",
			);
		const expired = `tracera-reap-expired-${process.pid}`;
		const orphan = `tracera-reap-orphan-${process.pid}`;
		const live = `tracera-reap-live-${process.pid}`;
		// Another installation sharing this Docker daemon: its worker is unknown here, but not ours to reap.
		const foreign = `tracera-reap-foreign-${process.pid}`;
		start(expired, WORKER, Date.now() - 60_000);
		start(orphan, `dead-worker-${process.pid}`, Date.now() + 600_000);
		start(live, `live-worker-${process.pid}`, Date.now() + 600_000);
		start(
			foreign,
			`dead-worker-${process.pid}`,
			Date.now() + 600_000,
			`other-installation-${process.pid}`,
		);
		try {
			const removed = await executor.reap({
				liveWorkerIds: [`live-worker-${process.pid}`],
			});
			expect(removed).toBe(2);
			expect(containerExists(expired)).toBe(false);
			expect(containerExists(orphan)).toBe(false);
			expect(containerExists(live)).toBe(true);
			expect(containerExists(foreign)).toBe(true);
		} finally {
			for (const name of [expired, orphan, live, foreign])
				try {
					docker("rm", "--force", name);
				} catch {
					// already removed
				}
		}
	});
});
