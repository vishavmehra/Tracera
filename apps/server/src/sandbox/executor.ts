import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { BrowserRunReport, BrowserStep } from "@tracera/contracts";
import { isPathInside } from "../lib/fs.ts";
import { validateBrowserSteps } from "./browser-steps.ts";

/**
 * The only way Tracera runs repository-controlled or model-written code.
 * Requests carry data only: argv, a workspace, an allowlisted environment, and a timeout. Every
 * isolation setting (network, mounts, user, capabilities, limits) belongs to the implementation, so
 * no stage can weaken it. Implementations report facts; interpretation lives in modules/verification.
 */
export interface SandboxExecutor {
	readonly kind: string;
	status(): Promise<SandboxStatus>;
	/** Never throws for a failing command: the failure is in the result. */
	run(
		request: SandboxRunRequest,
		signal?: AbortSignal,
	): Promise<SandboxRunResult>;
	/**
	 * Dependency preparation: installs locked dependencies without lifecycle scripts in a
	 * separate disposable environment whose only network path is an egress proxy that admits the
	 * registry, then seals the result as an artifact. Never throws for a failing install.
	 */
	prepare(
		request: PrepareRequest,
		signal?: AbortSignal,
	): Promise<PrepareResult>;
	/**
	 * Browser reproduction: starts the repository's app with no network and drives it with the
	 * fixed runner in a browser container that shares the app's loopback-only namespace. Never throws
	 * for a failing app or step: the failure is in the result.
	 */
	runBrowser(
		request: BrowserRunRequest,
		signal?: AbortSignal,
	): Promise<BrowserRunResult>;
	/** Recomputes a sealed artifact's digest without writing to it; null when it no longer exists. */
	inspectArtifact(
		volume: string,
		signal?: AbortSignal,
	): Promise<ArtifactSeal | null>;
	removeArtifact(volume: string): Promise<void>;
	/** This installation's artifacts, for retention. */
	listArtifacts(): Promise<Array<{ volume: string; createdAt: Date | null }>>;
	/** Removes runs left behind by dead workers or past their deadline. Returns how many were removed. */
	reap(options?: { liveWorkerIds?: readonly string[] }): Promise<number>;
}

export type SandboxStatus = {
	available: boolean;
	kind: string;
	image: string | null;
	detail: string | null;
};

export type SandboxRunRequest = {
	/** Deterministic per (investigation, stage, attempt, purpose): a retried job replaces its own stale run. */
	runId: string;
	/** Label used for reaping and audit: an investigation ID or an evaluator scope. */
	investigationId: string;
	/** Host directory mounted read-only at /work. Must be a real directory inside the workspaces root. */
	workspace: string;
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
	timeoutMs: number;
	/** A sealed dependency artifact mounted read-only at these node_modules paths (they must exist). */
	dependencies?: DependencyMounts;
};

export type DependencyMounts = { volume: string; mounts: readonly string[] };

export type PrepareRequest = {
	/** Deterministic per (snapshot, attempt); the artifact is named after it. */
	prepId: string;
	/** Label used for reaping and audit: the repository. */
	scope: string;
	/** Host directory holding only the manifests and the lockfile; inside the workspaces root. */
	input: string;
	/** The one registry the preparation may reach (its origin is the proxy's only allowed target). */
	registry: string;
	timeoutMs: number;
};

export type ArtifactSeal = {
	digest: string;
	files: number;
	dirs: number;
	links: number;
	bytes: number;
	mounts: string[];
};

export type EgressSummary = {
	allowed: number;
	denied: number;
	targets: string[];
	denied_targets: string[];
};

export type PrepareStatus =
	| "succeeded"
	| "failed"
	| Exclude<SandboxRunStatus, "exited">;

export type PrepareResult = {
	status: PrepareStatus;
	/** Set only when the preparation succeeded and was sealed. */
	volume: string | null;
	seal: ArtifactSeal | null;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	egress: EgressSummary;
	executor: { kind: string; image: string };
	/** Why an executor_error happened, in Tracera's words (never repository output). */
	detail?: string;
};

export type BrowserRunRequest = {
	/** Deterministic per (investigation, stage, attempt, purpose), as for runs. */
	runId: string;
	investigationId: string;
	/** Host directory mounted read-only at /work in the app container. */
	workspace: string;
	dependencies?: DependencyMounts;
	/** The repository's start command, parsed: `npm run <script>`. */
	start: readonly string[];
	app: { port: number; readyPath: string; basePath: string };
	steps: readonly BrowserStep[];
	timeoutMs: number;
};

export type BrowserRunResult = {
	/** `exited` means the runner finished; whether the app became ready is in `report`. */
	status: SandboxRunStatus;
	/** The runner's report, validated; null when the runner produced none (see `detail`). */
	report: BrowserRunReport | null;
	/** Why there is no report, in Tracera's words (never repository output). */
	detail?: string;
	/** The app's output (untrusted, capped). */
	appLog: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	executor: { kind: string; image: string; browserImage: string };
};

export type SandboxRunStatus =
	| "exited"
	| "timed_out"
	| "cancelled"
	| "limit_exceeded"
	| "executor_error";

export type SandboxRunResult = {
	status: SandboxRunStatus;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	executor: { kind: string; image: string };
};

export const SANDBOX_LIMITS = {
	cpus: "1",
	memoryMb: 512,
	pids: 128,
	tmpfsMb: 64,
	outputBytes: 1_000_000,
	minTimeoutMs: 1_000,
	maxTimeoutMs: 600_000,
	maxConcurrency: 2,
} as const;

/** Dependency preparation gets more room than a test run, and only one runs at a time per worker. */
export const PREPARE_LIMITS = {
	cpus: "2",
	memoryMb: 2048,
	pids: 512,
	tmpfsMb: 256,
	outputBytes: 1_000_000,
	minTimeoutMs: 30_000,
	maxTimeoutMs: 1_200_000,
	maxConcurrency: 1,
} as const;

/** The browser container (Chromium) and the app it drives get more room than a test run. */
export const BROWSER_LIMITS = {
	cpus: "2",
	memoryMb: 2048,
	pids: 512,
	tmpfsMb: 512,
	outputBytes: 2_000_000,
	minTimeoutMs: 10_000,
	maxTimeoutMs: 300_000,
} as const;
export const APP_LIMITS = {
	cpus: "1",
	memoryMb: 1024,
	pids: 256,
	tmpfsMb: 128,
} as const;

export const ARTIFACT_VOLUME =
	/^tracera-deps-[A-Za-z0-9][A-Za-z0-9_.-]{0,110}$/;
const MOUNT_PATH = /^(?:[A-Za-z0-9@_-][A-Za-z0-9@._-]*\/)*node_modules$/;
const MAX_MOUNTS = 32;

/** Model-written reproduction tests live here in the run copy; the model chooses only the content. */
export const REPRO_TEST_PATH = ".tracera/repro/repro.mjs";
/** The repro file name matches no node:test discovery pattern, so `npm test` never picks it up. */
export const REPRO_ARGV: readonly string[] = [
	"node",
	"--test",
	"--test-reporter=tap",
	REPRO_TEST_PATH,
];
/** Makes `npm test` → `node --test` print TAP (current Node defaults to the spec reporter even when piped). */
export const SUITE_ENV = {
	CI: "1",
	NODE_OPTIONS: "--test-reporter=tap",
} as const;

const ENV_ALLOWLIST: Record<string, RegExp> = {
	CI: /^(1|true)$/,
	NODE_OPTIONS: /^--test-reporter=tap$/,
	NO_COLOR: /^1$/,
};
const PROGRAMS = new Set(["node", "npm"]);
const SAFE_ARG = /^[A-Za-z0-9._/=:@+-]{1,200}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,110}$/;
const SCOPE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const hasParentSegment = (value: string) => value.split(/[/=]/).includes("..");

export type SandboxRequestErrorCode =
	| "invalid_run_id"
	| "invalid_workspace"
	| "invalid_argv"
	| "invalid_env"
	| "invalid_timeout"
	| "invalid_dependencies"
	| "invalid_registry"
	| "invalid_app"
	| "invalid_steps";

export class SandboxRequestError extends Error {
	readonly code: SandboxRequestErrorCode;

	constructor(code: SandboxRequestErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** Defense in depth: every executor validates requests itself, whatever the caller already checked. */
export async function validateRunRequest(
	request: SandboxRunRequest,
	workspacesRoot: string,
): Promise<void> {
	if (!RUN_ID.test(request.runId) || !SCOPE_ID.test(request.investigationId))
		throw new SandboxRequestError(
			"invalid_run_id",
			"Run and scope IDs use only letters, digits, dot, dash, and underscore",
		);
	if (
		!Number.isInteger(request.timeoutMs) ||
		request.timeoutMs < SANDBOX_LIMITS.minTimeoutMs ||
		request.timeoutMs > SANDBOX_LIMITS.maxTimeoutMs
	)
		throw new SandboxRequestError(
			"invalid_timeout",
			`Timeouts must be between ${SANDBOX_LIMITS.minTimeoutMs} and ${SANDBOX_LIMITS.maxTimeoutMs} ms`,
		);
	const program = request.argv[0];
	if (
		!program ||
		!PROGRAMS.has(program) ||
		request.argv.length > 32 ||
		request.argv.some((arg) => !SAFE_ARG.test(arg) || hasParentSegment(arg))
	)
		throw new SandboxRequestError(
			"invalid_argv",
			"argv must start with node or npm and contain only plain arguments",
		);
	for (const [key, value] of Object.entries(request.env)) {
		if (!ENV_ALLOWLIST[key]?.test(value))
			throw new SandboxRequestError(
				"invalid_env",
				`Environment variable ${key} is not allowed in the sandbox`,
			);
	}
	const real = await assertWorkspaceDir(request.workspace, workspacesRoot);
	if (request.dependencies)
		await assertDependencyMounts(real, request.dependencies);
}

async function assertDependencyMounts(
	real: string,
	{ volume, mounts }: DependencyMounts,
): Promise<void> {
	if (
		!ARTIFACT_VOLUME.test(volume) ||
		mounts.length > MAX_MOUNTS ||
		mounts.some((mount) => !MOUNT_PATH.test(mount))
	)
		throw new SandboxRequestError(
			"invalid_dependencies",
			"Dependency mounts must name a Tracera artifact and node_modules paths",
		);
	// The workspace is mounted read-only, so every mount point must already exist in the copy.
	for (const mount of mounts) {
		const target = path.join(real, ...mount.split("/"));
		const stat = await lstat(target).catch(() => null);
		if (
			!stat?.isDirectory() ||
			stat.isSymbolicLink() ||
			!isPathInside(real, await realpath(target))
		)
			throw new SandboxRequestError(
				"invalid_dependencies",
				`Mount point ${mount} must be a directory inside the workspace`,
			);
	}
}

/** A path on the app (ready path, base path): one leading slash, plain characters, no host. */
const APP_PATH = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,199}$/;

/** Defense in depth for browser runs: the start command, the app, and the steps are re-checked. */
export async function validateBrowserRequest(
	request: BrowserRunRequest,
	workspacesRoot: string,
): Promise<void> {
	if (!RUN_ID.test(request.runId) || !SCOPE_ID.test(request.investigationId))
		throw new SandboxRequestError(
			"invalid_run_id",
			"Run and scope IDs use only letters, digits, dot, dash, and underscore",
		);
	if (
		!Number.isInteger(request.timeoutMs) ||
		request.timeoutMs < BROWSER_LIMITS.minTimeoutMs ||
		request.timeoutMs > BROWSER_LIMITS.maxTimeoutMs
	)
		throw new SandboxRequestError(
			"invalid_timeout",
			`Browser run timeouts must be between ${BROWSER_LIMITS.minTimeoutMs} and ${BROWSER_LIMITS.maxTimeoutMs} ms`,
		);
	const [program, run, script, ...rest] = request.start;
	if (
		program !== "npm" ||
		run !== "run" ||
		!script ||
		!SCRIPT_NAME.test(script) ||
		rest.length > 0
	)
		throw new SandboxRequestError(
			"invalid_argv",
			"The app's start command must be npm run <script>",
		);
	const { port, readyPath, basePath } = request.app;
	if (
		!Number.isInteger(port) ||
		port < 1024 ||
		port > 65_535 ||
		!APP_PATH.test(readyPath) ||
		!APP_PATH.test(basePath)
	)
		throw new SandboxRequestError(
			"invalid_app",
			"The app needs a port of 1024–65535 and paths that start with one slash",
		);
	const steps = validateBrowserSteps(request.steps);
	if (!steps.ok)
		throw new SandboxRequestError(
			"invalid_steps",
			`Browser steps were refused: ${steps.errors.slice(0, 3).join("; ")}`,
		);
	const real = await assertWorkspaceDir(request.workspace, workspacesRoot);
	if (request.dependencies)
		await assertDependencyMounts(real, request.dependencies);
}

/** A real directory strictly inside the workspaces root, reached without links. Returns its real path. */
async function assertWorkspaceDir(
	dir: string,
	workspacesRoot: string,
): Promise<string> {
	if (!path.isAbsolute(dir))
		throw new SandboxRequestError(
			"invalid_workspace",
			"Workspace must be absolute",
		);
	const resolved = path.resolve(dir);
	const stat = await lstat(resolved).catch(() => null);
	if (!stat?.isDirectory() || stat.isSymbolicLink())
		throw new SandboxRequestError(
			"invalid_workspace",
			"Workspace must be an existing directory, not a link",
		);
	const [real, root] = await Promise.all([
		realpath(resolved),
		realpath(workspacesRoot),
	]);
	const sameAsResolved =
		isPathInside(real, resolved) && isPathInside(resolved, real);
	if (!sameAsResolved || !isPathInside(root, real) || isPathInside(real, root))
		throw new SandboxRequestError(
			"invalid_workspace",
			"Workspace must be inside the workspaces root and reached without links",
		);
	return real;
}

/** Defense in depth for preparation requests, as for runs. */
export async function validatePrepareRequest(
	request: PrepareRequest,
	workspacesRoot: string,
): Promise<void> {
	if (!RUN_ID.test(request.prepId) || !SCOPE_ID.test(request.scope))
		throw new SandboxRequestError(
			"invalid_run_id",
			"Preparation and scope IDs use only letters, digits, dot, dash, and underscore",
		);
	if (
		!Number.isInteger(request.timeoutMs) ||
		request.timeoutMs < PREPARE_LIMITS.minTimeoutMs ||
		request.timeoutMs > PREPARE_LIMITS.maxTimeoutMs
	)
		throw new SandboxRequestError(
			"invalid_timeout",
			`Preparation timeouts must be between ${PREPARE_LIMITS.minTimeoutMs} and ${PREPARE_LIMITS.maxTimeoutMs} ms`,
		);
	let registry: URL;
	try {
		registry = new URL(request.registry);
	} catch {
		throw new SandboxRequestError("invalid_registry", "Invalid registry URL");
	}
	if (
		(registry.protocol !== "https:" && registry.protocol !== "http:") ||
		registry.username ||
		registry.password ||
		registry.search ||
		registry.hash
	)
		throw new SandboxRequestError(
			"invalid_registry",
			"The registry must be a plain http(s) URL without credentials",
		);
	await assertWorkspaceDir(request.input, workspacesRoot);
}

const SCRIPT_NAME = /^[A-Za-z0-9:_-]{1,64}$/;
const RELATIVE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;

/**
 * Owner-configured repository commands must match this grammar; anything else is refused before
 * reaching Docker. The parsed argv runs without a host shell (npm itself uses `sh` inside the container).
 */
export function parseRepositoryCommand(
	command: string,
): { ok: true; argv: string[] } | { ok: false; reason: string } {
	const refuse = {
		ok: false as const,
		reason:
			"Allowed commands: npm test, npm run <script>, node --test [relative paths]",
	};
	if (/[^A-Za-z0-9 ._/:=@+-]/.test(command)) return refuse;
	const tokens = command.trim().split(/ +/).filter(Boolean);
	const [program, first, second, ...rest] = tokens;
	if (program === "npm" && first === "test" && second === undefined)
		return { ok: true, argv: ["npm", "test"] };
	if (
		program === "npm" &&
		first === "run" &&
		second !== undefined &&
		SCRIPT_NAME.test(second) &&
		rest.length === 0
	)
		return { ok: true, argv: ["npm", "run", second] };
	if (program === "node" && first === "--test") {
		const paths = tokens.slice(2);
		if (
			paths.length <= 10 &&
			paths.every(
				(value) =>
					RELATIVE_PATH.test(value) && !value.split("/").includes(".."),
			)
		)
			return { ok: true, argv: tokens };
	}
	return refuse;
}

/** Used when TRACERA_SANDBOX_MODE=disabled or Docker is not configured: stages record `blocked`. */
export function createUnavailableExecutor(detail: string): SandboxExecutor {
	return {
		kind: "none",
		status: async () => ({
			available: false,
			kind: "none",
			image: null,
			detail,
		}),
		run: async () => {
			throw new Error(`No sandbox executor is available (${detail})`);
		},
		runBrowser: async () => {
			throw new Error(`No sandbox executor is available (${detail})`);
		},
		prepare: async () => {
			throw new Error(`No sandbox executor is available (${detail})`);
		},
		inspectArtifact: async () => null,
		removeArtifact: async () => undefined,
		listArtifacts: async () => [],
		reap: async () => 0,
	};
}
