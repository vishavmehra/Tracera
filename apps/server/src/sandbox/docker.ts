import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { BrowserRunReportSchema } from "@tracera/contracts";
import {
	APP_LIMITS,
	ARTIFACT_VOLUME,
	type ArtifactSeal,
	BROWSER_LIMITS,
	type BrowserRunRequest,
	type BrowserRunResult,
	type DependencyMounts,
	type EgressSummary,
	PREPARE_LIMITS,
	type PrepareRequest,
	type PrepareResult,
	type PrepareStatus,
	SANDBOX_LIMITS,
	type SandboxExecutor,
	type SandboxRunResult,
	type SandboxRunStatus,
	type SandboxStatus,
	validateBrowserRequest,
	validatePrepareRequest,
	validateRunRequest,
} from "./executor.ts";
import { CACHE_DIRS } from "./seal-tree.ts";

/** Variables the Docker CLI itself needs. Host secrets never reach the CLI, let alone a container. */
const DOCKER_CLI_ENV = [
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"windir",
	"USERPROFILE",
	"HOME",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ProgramFiles",
	"TEMP",
	"TMP",
	"DOCKER_HOST",
	"DOCKER_CONTEXT",
	"DOCKER_CONFIG",
	"DOCKER_CERT_PATH",
	"DOCKER_TLS_VERIFY",
];
const cliEnv = () =>
	Object.fromEntries(
		DOCKER_CLI_ENV.flatMap((key) =>
			process.env[key] === undefined ? [] : [[key, process.env[key]]],
		),
	);

/** Fixed container environment. Requests may add only allowlisted keys (validateRunRequest). */
const FIXED_ENV = [
	"HOME=/tmp",
	"npm_config_cache=/tmp/.npm",
	"npm_config_update_notifier=false",
	"npm_config_fund=false",
	"npm_config_audit=false",
];
/** In-container deadline: the container outlives a dead worker by at most this long. */
const BACKSTOP_GRACE_SECONDS = 15;

type Limits = { cpus: string; memoryMb: number; pids: number; tmpfsMb: number };
const SEED_LIMITS: Limits = { cpus: "1", memoryMb: 256, pids: 64, tmpfsMb: 16 };
const PROXY_LIMITS: Limits = {
	cpus: "1",
	memoryMb: 256,
	pids: 64,
	tmpfsMb: 16,
};
const SEAL_LIMITS: Limits = {
	cpus: "1",
	memoryMb: 1024,
	pids: 64,
	tmpfsMb: 16,
};
const SEAL_TIMEOUT_MS = 300_000;
const PROXY_PORT = 3128;

/**
 * The install environment, and nothing else: npm reads no user, global, or repository configuration,
 * runs no lifecycle scripts, and reaches the registry only through the proxy (the network has no route).
 */
export const installEnv = (registry: string, proxy: string): string[] => [
	"HOME=/tmp",
	"NO_UPDATE_NOTIFIER=1",
	"npm_config_cache=/home/node/.npm-cache",
	"npm_config_userconfig=/tmp/.npmrc-none",
	"npm_config_globalconfig=/tmp/.npmrc-global-none",
	`npm_config_registry=${registry}`,
	`npm_config_proxy=${proxy}`,
	`npm_config_https_proxy=${proxy}`,
	"npm_config_noproxy=",
	"npm_config_ignore_scripts=true",
	"npm_config_update_notifier=false",
	"npm_config_fund=false",
	"npm_config_audit=false",
	"npm_config_loglevel=warn",
	// npm's default backoff (10 s, then 60 s, repeated for a "corrupted" tarball) turns a deterministic
	// integrity failure into minutes; transient errors still get two quick retries.
	"npm_config_fetch_retries=2",
	"npm_config_fetch_retry_mintimeout=1000",
	"npm_config_fetch_retry_maxtimeout=5000",
	"npm_config_fetch_timeout=120000",
];

/** Read-only artifact mounts, each with tmpfs overlays for the caches some test runners write. */
export const dependencyMountArgs = ({
	volume,
	mounts,
}: DependencyMounts): string[] =>
	mounts.flatMap((mount) => [
		"--mount",
		`type=volume,source=${volume},target=/work/${mount},readonly,volume-subpath=app/${mount}`,
		...CACHE_DIRS.flatMap((dir) => [
			"--tmpfs",
			`/work/${mount}/${dir}:rw,noexec,nosuid,nodev,size=32m,mode=1777`,
		]),
	]);

/** What the proxy allowed and refused, from its JSON log (hosts only; paths are not kept). */
export function summarizeEgress(log: string): EgressSummary {
	const summary: EgressSummary = {
		allowed: 0,
		denied: 0,
		targets: [],
		denied_targets: [],
	};
	const hostOf = (target: string) => {
		let host = target;
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target))
			try {
				host = new URL(target).host;
			} catch {
				// keep the raw target; it is sanitized below
			}
		return host.replace(/[^A-Za-z0-9.:[\]-]/g, "").slice(0, 120);
	};
	const allowed = new Set<string>();
	const denied = new Set<string>();
	for (const line of log.split(/\r?\n/)) {
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (!event || typeof event !== "object") continue;
		const { event: kind, target } = event as {
			event?: unknown;
			target?: unknown;
		};
		const host = typeof target === "string" ? hostOf(target) : "";
		if (kind === "allowed") {
			summary.allowed += 1;
			allowed.add(host);
		} else if (kind === "denied") {
			summary.denied += 1;
			denied.add(host);
		}
	}
	summary.targets = [...allowed].slice(0, 20);
	summary.denied_targets = [...denied].slice(0, 20);
	return summary;
}

const sealShape = (value: unknown): ArtifactSeal | null => {
	if (!value || typeof value !== "object") return null;
	const seal = value as Record<string, unknown>;
	const counts = ["files", "dirs", "links", "bytes"] as const;
	return typeof seal.digest === "string" &&
		/^[0-9a-f]{64}$/.test(seal.digest) &&
		counts.every((key) => Number.isInteger(seal[key])) &&
		Array.isArray(seal.mounts) &&
		seal.mounts.every((mount) => typeof mount === "string")
		? (seal as ArtifactSeal)
		: null;
};

export type DockerExecutorOptions = {
	/** Pinned image reference (`repo@sha256:…`). Never pulled or built at run time. */
	image: string;
	workspacesRoot: string;
	workerId: string;
	/**
	 * Installation identity (database and data directory). Containers carry it, and the reaper only
	 * touches containers of its own installation, so two installations can share one Docker daemon.
	 */
	instance: string;
	docker?: string;
	/** The network the egress proxy uses to reach registries (default: Docker's `bridge`). */
	egressNetwork?: string;
	/** Pinned Playwright image for browser reproduction; browser runs are refused without it. */
	browserImage?: string;
	/** Host directory of Tracera's own `playwright-core` (default: the installed package). */
	playwrightCore?: string;
};

/** Tracera's own playwright-core, mounted read-only into the browser container (same version as the image). */
const installedPlaywrightCore = () =>
	path.dirname(
		createRequire(import.meta.url).resolve("playwright-core/package.json"),
	);

type Attached = {
	stopped: "timed_out" | "cancelled" | null;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
};

/**
 * Docker implementation of SandboxExecutor. Every run gets: no network,
 * read-only root filesystem, a size-capped noexec /tmp, non-root user 1000, all capabilities dropped,
 * no-new-privileges, the default seccomp profile, CPU/memory/swap/pids limits, one read-only bind
 * mount of a per-run workspace copy (plus, when given, read-only mounts of a sealed dependency
 * artifact), a worker-enforced timeout with an in-container backstop, output caps, deterministic names
 * and labels for cleanup, and at most two concurrent runs. Dependency preparation (`prepare`) runs in
 * its own containers under the same hardening, on an internal network whose only exit is the egress
 * proxy (egress-proxy.ts), and is sealed by seal-tree.ts.
 */
export function createDockerExecutor(
	options: DockerExecutorOptions,
): SandboxExecutor {
	const docker = options.docker ?? "docker";
	const egressNetwork = options.egressNetwork ?? "bridge";
	let cached: { at: number; value: SandboxStatus } | null = null;

	const cli = (args: string[], timeoutMs = 15_000) =>
		new Promise<{ ok: boolean; stdout: string }>((resolve) =>
			execFile(
				docker,
				args,
				{
					timeout: timeoutMs,
					windowsHide: true,
					env: cliEnv(),
					maxBuffer: 8 * 1024 * 1024,
				},
				(error, stdout) => resolve({ ok: !error, stdout: String(stdout) }),
			),
		);

	const limiter = (max: number) => {
		let active = 0;
		const waiting: Array<() => void> = [];
		return async <T>(task: () => Promise<T>): Promise<T> => {
			if (active >= max)
				await new Promise<void>((resolve) => waiting.push(resolve));
			active += 1;
			try {
				return await task();
			} finally {
				active -= 1;
				waiting.shift()?.();
			}
		};
	};
	const runSlot = limiter(SANDBOX_LIMITS.maxConcurrency);
	const prepareSlot = limiter(PREPARE_LIMITS.maxConcurrency);

	const scripts = new Map<string, Promise<string>>();
	/** A sandbox-side script (types stripped), run with `node -e` so nothing is mounted from the host. */
	const script = (name: "egress-proxy" | "seal-tree" | "browser-runner") => {
		let source = scripts.get(name);
		if (!source) {
			source = readFile(new URL(`./${name}.ts`, import.meta.url), "utf8").then(
				(text) => stripTypeScriptTypes(text),
			);
			scripts.set(name, source);
		}
		return source;
	};

	const labels = (scope: string, deadline: number, extra: string[] = []) => [
		"--label",
		"tracera.sandbox=1",
		"--label",
		`tracera.instance=${options.instance}`,
		"--label",
		`tracera.investigation=${scope}`,
		"--label",
		`tracera.worker=${options.workerId}`,
		"--label",
		`tracera.deadline=${deadline}`,
		...extra,
	];
	const hardened = (limits: Limits) => [
		"--read-only",
		"--tmpfs",
		`/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfsMb}m`,
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--user",
		"1000:1000",
		"--cpus",
		limits.cpus,
		"--memory",
		`${limits.memoryMb}m`,
		"--memory-swap",
		`${limits.memoryMb}m`,
		"--pids-limit",
		String(limits.pids),
	];

	async function status(): Promise<SandboxStatus> {
		if (cached && Date.now() - cached.at < 30_000) return cached.value;
		const version = await cli(
			["version", "--format", "{{.Server.Version}}"],
			10_000,
		);
		let value: SandboxStatus;
		if (!version.ok || !version.stdout.trim())
			value = {
				available: false,
				kind: "docker",
				image: options.image,
				detail: "docker_unavailable",
			};
		else
			value = (
				await cli(["image", "inspect", "--format", "{{.Id}}", options.image])
			).ok
				? {
						available: true,
						kind: "docker",
						image: options.image,
						detail: `docker ${version.stdout.trim()}`,
					}
				: {
						available: false,
						kind: "docker",
						image: options.image,
						detail: "image_missing (run: npm run sandbox:pull)",
					};
		cached = { at: Date.now(), value };
		return value;
	}

	/**
	 * Runs one container attached: output capped, a worker-side timeout, and cancellation that keeps
	 * killing the container until its CLI exits (a kill sent before the container exists is retried).
	 */
	async function attached(
		name: string,
		args: readonly string[],
		timeoutMs: number,
		outputBytes: number,
		signal?: AbortSignal,
	): Promise<Attached> {
		const started = Date.now();
		if (signal?.aborted)
			return {
				stopped: "cancelled",
				exitCode: null,
				stdout: "",
				stderr: "",
				truncated: false,
				durationMs: 0,
			};
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		let truncated = false;
		let stopped: Attached["stopped"] = null;
		let closed = false;
		const child = spawn(docker, [...args], {
			windowsHide: true,
			env: cliEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const capture =
			(chunks: Buffer[], size: () => number, add: (n: number) => void) =>
			(chunk: Buffer) => {
				const room = outputBytes - size();
				if (room <= 0) {
					truncated = true;
					return;
				}
				if (chunk.length > room) truncated = true;
				const kept = chunk.subarray(0, room);
				chunks.push(kept);
				add(kept.length);
			};
		child.stdout.on(
			"data",
			capture(
				out,
				() => outBytes,
				(n) => {
					outBytes += n;
				},
			),
		);
		child.stderr.on(
			"data",
			capture(
				err,
				() => errBytes,
				(n) => {
					errBytes += n;
				},
			),
		);
		const stop = (why: "timed_out" | "cancelled") => {
			if (stopped) return;
			stopped = why;
			void (async () => {
				for (let attempt = 0; attempt < 30 && !closed; attempt++) {
					await cli(["kill", name]);
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			})();
		};
		const timer = setTimeout(() => stop("timed_out"), timeoutMs);
		const onAbort = () => stop("cancelled");
		signal?.addEventListener("abort", onAbort, { once: true });
		const exitCode = await new Promise<number | null>((resolve) => {
			child.once("error", () => resolve(null));
			child.once("close", (code) => resolve(code));
		});
		closed = true;
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		await cli(["rm", "--force", name]); // removed by --rm normally; this covers a killed CLI
		return {
			stopped,
			exitCode,
			stdout: Buffer.concat(out).toString("utf8"),
			stderr: Buffer.concat(err).toString("utf8"),
			truncated,
			durationMs: Date.now() - started,
		};
	}

	const runResult = (
		status: SandboxRunStatus,
		fields: Partial<SandboxRunResult> = {},
	): SandboxRunResult => ({
		status,
		exitCode: null,
		stdout: "",
		stderr: "",
		truncated: false,
		durationMs: 0,
		executor: { kind: "docker", image: options.image },
		...fields,
	});

	async function run(
		request: Parameters<SandboxExecutor["run"]>[0],
		signal?: AbortSignal,
	): Promise<SandboxRunResult> {
		await validateRunRequest(request, options.workspacesRoot);
		// `--mount` is comma-separated; refuse paths that would change its meaning.
		if (/[,"\r\n]/.test(request.workspace))
			return runResult("executor_error", {
				stderr: "Workspace path cannot be expressed as a Docker mount",
			});
		return runSlot(() => execute(request, signal));
	}

	async function execute(
		request: Parameters<SandboxExecutor["run"]>[0],
		signal?: AbortSignal,
	): Promise<SandboxRunResult> {
		const name = `tracera-${request.runId}`;
		await cli(["rm", "--force", name]); // a retried job replaces its own stale run
		if (signal?.aborted) return runResult("cancelled");
		const backstop =
			Math.ceil(request.timeoutMs / 1000) + BACKSTOP_GRACE_SECONDS;
		const args = [
			"run",
			"--rm",
			"--name",
			name,
			...labels(request.investigationId, Date.now() + backstop * 1000),
			"--network",
			"none",
			...hardened(SANDBOX_LIMITS),
			"--mount",
			`type=bind,source=${request.workspace},target=/work,readonly`,
			...(request.dependencies
				? dependencyMountArgs(request.dependencies)
				: []),
			"--workdir",
			"/work",
			...FIXED_ENV.flatMap((pair) => ["--env", pair]),
			...Object.entries(request.env).flatMap(([key, value]) => [
				"--env",
				`${key}=${value}`,
			]),
			options.image,
			"timeout",
			"--signal=KILL",
			`${backstop}s`,
			...request.argv,
		];
		const done = await attached(
			name,
			args,
			request.timeoutMs,
			SANDBOX_LIMITS.outputBytes,
			signal,
		);
		const fields = {
			exitCode: done.exitCode,
			stdout: done.stdout,
			stderr: done.stderr,
			truncated: done.truncated,
			durationMs: done.durationMs,
		};
		if (done.stopped) return runResult(done.stopped, fields);
		if (done.exitCode === null || done.exitCode === 125)
			return runResult("executor_error", fields);
		// 137 without our kill: the kernel OOM killer (memory limit) or the in-container backstop.
		if (done.exitCode === 137) return runResult("limit_exceeded", fields);
		return runResult("exited", fields);
	}

	const browserResult = (
		status: SandboxRunStatus,
		fields: Partial<BrowserRunResult> = {},
	): BrowserRunResult => ({
		status,
		report: null,
		appLog: "",
		stderr: "",
		truncated: false,
		durationMs: 0,
		executor: {
			kind: "docker",
			image: options.image,
			browserImage: options.browserImage ?? "",
		},
		...fields,
	});

	/** Both streams of a container's log, capped (the app's output is untrusted). */
	const containerLog = (name: string) =>
		new Promise<string>((resolve) =>
			execFile(
				docker,
				["logs", "--tail", "400", name],
				{
					timeout: 15_000,
					windowsHide: true,
					env: cliEnv(),
					maxBuffer: 1024 * 1024,
				},
				(_error, stdout, stderr) =>
					resolve(`${String(stdout)}${String(stderr)}`.slice(-64_000)),
			),
		);

	async function runBrowser(
		request: BrowserRunRequest,
		signal?: AbortSignal,
	): Promise<BrowserRunResult> {
		await validateBrowserRequest(request, options.workspacesRoot);
		if (!options.browserImage)
			return browserResult("executor_error", {
				detail: "browser_image_not_configured",
			});
		const playwrightCore = options.playwrightCore ?? installedPlaywrightCore();
		// `--mount` is comma-separated; refuse paths that would change its meaning.
		if (/[,"\r\n]/.test(request.workspace) || /[,"\r\n]/.test(playwrightCore))
			return browserResult("executor_error", { detail: "path_not_mountable" });
		return runSlot(() =>
			browserInner(request, options.browserImage ?? "", playwrightCore, signal),
		);
	}

	async function browserInner(
		request: BrowserRunRequest,
		browserImage: string,
		playwrightCore: string,
		signal?: AbortSignal,
	): Promise<BrowserRunResult> {
		const app = `tracera-app-${request.runId}`;
		const browser = `tracera-browser-${request.runId}`;
		await cli(["rm", "--force", app, browser]); // a retried job replaces its own stale run
		if (signal?.aborted) return browserResult("cancelled");
		const backstop =
			Math.ceil(request.timeoutMs / 1000) + BACKSTOP_GRACE_SECONDS;
		const deadline = Date.now() + backstop * 1000;
		// The app: the repository's start command, no network at all, the run copy read-only.
		const started = await cli(
			[
				"run",
				"--detach",
				"--name",
				app,
				...labels(request.investigationId, deadline),
				"--network",
				"none",
				...hardened(APP_LIMITS),
				"--mount",
				`type=bind,source=${request.workspace},target=/work,readonly`,
				...(request.dependencies
					? dependencyMountArgs(request.dependencies)
					: []),
				"--workdir",
				"/work",
				...FIXED_ENV.flatMap((pair) => ["--env", pair]),
				"--env",
				`PORT=${request.app.port}`,
				"--env",
				"CI=1",
				"--env",
				"BROWSER=none",
				options.image,
				"timeout",
				"--signal=KILL",
				`${backstop}s`,
				...request.start,
			],
			60_000,
		);
		try {
			if (!started.ok)
				return browserResult("executor_error", {
					detail: "app_container_failed",
				});
			const input = Buffer.from(
				JSON.stringify({
					port: request.app.port,
					ready_path: request.app.readyPath,
					base_path: request.app.basePath,
					steps: request.steps,
					startup_timeout_ms: Math.min(
						90_000,
						Math.floor(request.timeoutMs / 2),
					),
				}),
			).toString("base64");
			// The browser: joins the app's namespace (loopback only); Tracera's runner and playwright-core.
			const done = await attached(
				browser,
				[
					"run",
					"--rm",
					"--name",
					browser,
					...labels(request.investigationId, deadline),
					"--network",
					`container:${app}`,
					...hardened(BROWSER_LIMITS),
					"--mount",
					`type=bind,source=${playwrightCore},target=/opt/tracera/node_modules/playwright-core,readonly`,
					"--env",
					"HOME=/tmp",
					"--env",
					"PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
					"--env",
					"TRACERA_ROLE=browser-runner",
					"--env",
					`TRACERA_BROWSER_INPUT=${input}`,
					browserImage,
					"timeout",
					"--signal=KILL",
					`${backstop}s`,
					"node",
					"--input-type=module",
					"-e",
					await script("browser-runner"),
				],
				request.timeoutMs,
				BROWSER_LIMITS.outputBytes,
				signal,
			);
			const fields = {
				appLog: await containerLog(app),
				stderr: done.stderr.slice(-64_000),
				truncated: done.truncated,
				durationMs: done.durationMs,
			};
			if (done.stopped) return browserResult(done.stopped, fields);
			if (done.exitCode === 137) return browserResult("limit_exceeded", fields);
			if (done.exitCode === null || done.exitCode === 125) {
				// An app that exited before the browser joined its namespace (Docker refuses to join a
				// stopped container) never became ready: the app's failure, not the sandbox's.
				const state = await cli([
					"inspect",
					"--format",
					"{{.State.Running}}",
					app,
				]);
				if (state.ok && state.stdout.trim() === "false")
					return browserResult("exited", {
						...fields,
						report: {
							ready: false,
							steps: [],
							console_errors: [],
							page_errors: [],
							blocked_requests: [],
							failed_requests: [],
							final_path: null,
							screenshot: null,
							duration_ms: done.durationMs,
						},
					});
				return browserResult("executor_error", {
					...fields,
					detail: "browser_container_failed",
				});
			}
			const line = done.stdout.trim().split(/\r?\n/).at(-1) ?? "";
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(line);
			} catch {
				// handled below
			}
			const report = BrowserRunReportSchema.safeParse(
				(parsed as { browser?: unknown } | null)?.browser,
			);
			return report.success
				? browserResult("exited", { ...fields, report: report.data })
				: browserResult("executor_error", {
						...fields,
						detail: "runner_failed",
					});
		} finally {
			await cli(["rm", "--force", app]);
		}
	}

	/** Runs seal-tree.ts over an artifact: read-write to finalize a fresh one, read-only to check one. */
	async function runSeal(
		name: string,
		volume: string,
		finalize: boolean,
		scope: string,
		signal?: AbortSignal,
	): Promise<ArtifactSeal | null> {
		const done = await attached(
			name,
			[
				"run",
				"--rm",
				"--name",
				name,
				...labels(scope, Date.now() + SEAL_TIMEOUT_MS + 30_000),
				"--network",
				"none",
				...hardened(SEAL_LIMITS),
				"--mount",
				`type=volume,source=${volume},target=/home/node${finalize ? "" : ",readonly"}`,
				"--env",
				"TRACERA_ROLE=seal-tree",
				"--env",
				"TRACERA_SEAL_ROOT=/home/node/app",
				"--env",
				`TRACERA_SEAL_FINALIZE=${finalize ? "1" : "0"}`,
				"--env",
				"TRACERA_SEAL_CACHE=/home/node/.npm-cache",
				options.image,
				"timeout",
				"--signal=KILL",
				`${SEAL_TIMEOUT_MS / 1000}s`,
				"node",
				"--input-type=module",
				"-e",
				await script("seal-tree"),
			],
			SEAL_TIMEOUT_MS,
			256_000,
			signal,
		);
		if (done.stopped || done.exitCode !== 0) return null;
		const line = done.stdout.trim().split(/\r?\n/).at(-1) ?? "";
		try {
			return sealShape((JSON.parse(line) as { seal?: unknown }).seal);
		} catch {
			return null;
		}
	}

	async function proxyReady(name: string, signal?: AbortSignal) {
		for (let attempt = 0; attempt < 60 && !signal?.aborted; attempt++) {
			const logs = await cli(["logs", name]);
			if (logs.stdout.includes('"event":"ready"')) return true;
			if (logs.stdout.includes('"event":"error"')) return false;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		return false;
	}

	async function prepare(
		request: PrepareRequest,
		signal?: AbortSignal,
	): Promise<PrepareResult> {
		await validatePrepareRequest(request, options.workspacesRoot);
		const started = Date.now();
		const egress: EgressSummary = {
			allowed: 0,
			denied: 0,
			targets: [],
			denied_targets: [],
		};
		const finish = (
			status: PrepareStatus,
			fields: Partial<PrepareResult> = {},
		): PrepareResult => ({
			status,
			volume: null,
			seal: null,
			exitCode: null,
			stdout: "",
			stderr: "",
			truncated: false,
			durationMs: Date.now() - started,
			egress,
			executor: { kind: "docker", image: options.image },
			...fields,
		});
		if (/[,"\r\n]/.test(request.input))
			return finish("executor_error", { detail: "input_path_not_mountable" });
		return prepareSlot(() => prepareInner(request, finish, egress, signal));
	}

	async function prepareInner(
		request: PrepareRequest,
		finish: (
			status: PrepareStatus,
			fields?: Partial<PrepareResult>,
		) => PrepareResult,
		egress: EgressSummary,
		signal?: AbortSignal,
	): Promise<PrepareResult> {
		const id = request.prepId;
		const volume = `tracera-deps-${id}`;
		const network = `tracera-net-${id}`;
		const proxy = `tracera-proxy-${id}`;
		const seed = `tracera-seed-${id}`;
		const install = `tracera-install-${id}`;
		const seal = `tracera-seal-${id}`;
		const registry = new URL(request.registry);
		const deadline = Date.now() + request.timeoutMs + SEAL_TIMEOUT_MS + 120_000;
		const labelled = labels(request.scope, deadline, [
			"--label",
			`tracera.deps=${id}`,
		]);
		const removeRuntime = async () => {
			await cli(["rm", "--force", proxy, seed, install, seal]);
			await cli(["network", "rm", network]);
		};
		let keep = false;
		// A retried attempt replaces whatever its previous attempt left behind.
		await removeRuntime();
		await cli(["volume", "rm", "--force", volume]);
		try {
			if (signal?.aborted) return finish("cancelled");
			if (!(await cli(["volume", "create", ...labelled, volume])).ok)
				return finish("executor_error", { detail: "volume_create_failed" });

			// 1. Seed: only the manifests and the lockfile enter the artifact (no network, no source code).
			const seeded = await attached(
				seed,
				[
					"run",
					"--rm",
					"--name",
					seed,
					...labelled,
					"--network",
					"none",
					...hardened(SEED_LIMITS),
					"--mount",
					`type=bind,source=${request.input},target=/in,readonly`,
					"--mount",
					`type=volume,source=${volume},target=/home/node`,
					options.image,
					"timeout",
					"--signal=KILL",
					"60s",
					"cp",
					"-R",
					"/in",
					"/home/node/app",
				],
				75_000,
				64_000,
				signal,
			);
			if (seeded.stopped === "cancelled") return finish("cancelled");
			if (seeded.stopped || seeded.exitCode !== 0)
				return finish("executor_error", { detail: "seed_failed" });

			// 2. Network: internal (no route, no DNS); the proxy is its only other member and only exit.
			if (
				!(await cli(["network", "create", "--internal", ...labelled, network]))
					.ok
			)
				return finish("executor_error", { detail: "network_create_failed" });
			const proxyStarted = await cli(
				[
					"run",
					"--detach",
					"--rm",
					"--name",
					proxy,
					...labelled,
					"--network",
					egressNetwork,
					...hardened(PROXY_LIMITS),
					"--env",
					"TRACERA_ROLE=egress-proxy",
					"--env",
					`TRACERA_PROXY_ORIGINS=${JSON.stringify([registry.origin])}`,
					"--env",
					`TRACERA_PROXY_PORT=${PROXY_PORT}`,
					// A plain-HTTP registry is a private one (tests, internal mirrors): its address may be private.
					"--env",
					`TRACERA_PROXY_ALLOW_PRIVATE=${registry.protocol === "http:" ? "1" : "0"}`,
					options.image,
					"timeout",
					"--signal=KILL",
					`${Math.ceil((deadline - Date.now()) / 1000)}s`,
					"node",
					"--input-type=module",
					"-e",
					await script("egress-proxy"),
				],
				60_000,
			);
			if (!proxyStarted.ok)
				return finish("executor_error", { detail: "proxy_start_failed" });
			if (!(await cli(["network", "connect", network, proxy])).ok)
				return finish("executor_error", { detail: "proxy_connect_failed" });
			if (!(await proxyReady(proxy, signal)))
				return finish(signal?.aborted ? "cancelled" : "executor_error", {
					detail: "proxy_not_ready",
				});

			// 3. Install: the lockfile exactly, lifecycle scripts off, through the proxy only.
			const installed = await attached(
				install,
				[
					"run",
					"--rm",
					"--name",
					install,
					...labelled,
					"--network",
					network,
					...hardened(PREPARE_LIMITS),
					"--mount",
					`type=volume,source=${volume},target=/home/node`,
					"--workdir",
					"/home/node/app",
					...installEnv(registry.href, `http://${proxy}:${PROXY_PORT}`).flatMap(
						(pair) => ["--env", pair],
					),
					options.image,
					"timeout",
					"--signal=KILL",
					`${Math.ceil(request.timeoutMs / 1000) + BACKSTOP_GRACE_SECONDS}s`,
					"npm",
					"ci",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
				],
				request.timeoutMs,
				PREPARE_LIMITS.outputBytes,
				signal,
			);
			Object.assign(
				egress,
				summarizeEgress((await cli(["logs", proxy])).stdout),
			);
			// Network access ends before the artifact is sealed.
			await removeRuntime();
			const fields = {
				exitCode: installed.exitCode,
				stdout: installed.stdout,
				stderr: installed.stderr,
				truncated: installed.truncated,
			};
			if (installed.stopped) return finish(installed.stopped, fields);
			if (installed.exitCode === 137) return finish("limit_exceeded", fields);
			if (installed.exitCode === null || installed.exitCode === 125)
				return finish("executor_error", {
					...fields,
					detail: "install_container_failed",
				});
			if (installed.exitCode !== 0) return finish("failed", fields);

			// 4. Seal: finalize and hash the tree, without network.
			const sealed = await runSeal(seal, volume, true, request.scope, signal);
			if (!sealed)
				return finish(signal?.aborted ? "cancelled" : "executor_error", {
					...fields,
					detail: "seal_failed",
				});
			keep = true;
			return finish("succeeded", { ...fields, volume, seal: sealed });
		} finally {
			await removeRuntime();
			if (!keep) await cli(["volume", "rm", "--force", volume]);
		}
	}

	async function inspectArtifact(
		volume: string,
		signal?: AbortSignal,
	): Promise<ArtifactSeal | null> {
		if (!ARTIFACT_VOLUME.test(volume)) return null;
		if (!(await cli(["volume", "inspect", volume])).ok) return null;
		return runSeal(
			`tracera-inspect-${randomUUID().slice(0, 12)}`,
			volume,
			false,
			"artifact",
			signal,
		);
	}

	async function removeArtifact(volume: string): Promise<void> {
		if (ARTIFACT_VOLUME.test(volume))
			await cli(["volume", "rm", "--force", volume]);
	}

	async function listArtifacts(): Promise<
		Array<{ volume: string; createdAt: Date | null }>
	> {
		const list = await cli([
			"volume",
			"ls",
			"--filter",
			"label=tracera.sandbox=1",
			"--filter",
			`label=tracera.instance=${options.instance}`,
			"--format",
			"{{.Name}}",
		]);
		const names = list.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((name) => ARTIFACT_VOLUME.test(name));
		if (names.length === 0) return [];
		const details = await cli([
			"volume",
			"inspect",
			"--format",
			"{{.Name}}\t{{.CreatedAt}}",
			...names,
		]);
		const created = new Map(
			details.stdout
				.split(/\r?\n/)
				.map((line) => line.trim().split("\t"))
				.map(([name = "", at = ""]) => [name, at] as const),
		);
		return names.map((volume) => {
			const at = new Date(created.get(volume) ?? "");
			return {
				volume,
				createdAt: Number.isNaN(at.getTime()) ? null : at,
			};
		});
	}

	async function reap(
		reapOptions: { liveWorkerIds?: readonly string[] } = {},
	): Promise<number> {
		const list = await cli([
			"ps",
			"--all",
			"--filter",
			"label=tracera.sandbox=1",
			"--filter",
			`label=tracera.instance=${options.instance}`,
			"--format",
			'{{.Names}}\t{{.Label "tracera.worker"}}\t{{.Label "tracera.deadline"}}',
		]);
		if (!list.ok) return 0;
		const live = reapOptions.liveWorkerIds
			? new Set([...reapOptions.liveWorkerIds, options.workerId])
			: null;
		let removed = 0;
		for (const line of list.stdout.split(/\r?\n/)) {
			const [name, worker, deadline] = line.trim().split("\t");
			if (!name?.startsWith("tracera-")) continue;
			const expired = Number(deadline) > 0 && Number(deadline) < Date.now();
			const orphaned = live !== null && !live.has(worker ?? "");
			if ((expired || orphaned) && (await cli(["rm", "--force", name])).ok)
				removed += 1;
		}
		// Preparation networks past their deadline are removed too; artifacts are removed by retention,
		// which knows which ones the database still references.
		const networks = await cli([
			"network",
			"ls",
			"--filter",
			"label=tracera.sandbox=1",
			"--filter",
			`label=tracera.instance=${options.instance}`,
			"--format",
			'{{.Name}}\t{{.Label "tracera.deadline"}}',
		]);
		for (const line of networks.stdout.split(/\r?\n/)) {
			const [name, deadline] = line.trim().split("\t");
			if (!name?.startsWith("tracera-net-")) continue;
			if (
				Number(deadline) > 0 &&
				Number(deadline) < Date.now() &&
				(await cli(["network", "rm", name])).ok
			)
				removed += 1;
		}
		return removed;
	}

	return {
		kind: "docker",
		status,
		run,
		runBrowser,
		prepare,
		inspectArtifact,
		removeArtifact,
		listArtifacts,
		reap,
	};
}
