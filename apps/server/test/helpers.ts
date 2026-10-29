import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { inject } from "vitest";
import { buildApp } from "../src/api/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { createDb, createPool, type Db } from "../src/db/client.ts";
import { users, workspaceMembers } from "../src/db/schema.ts";
import { seedOwner } from "../src/db/seed.ts";
import {
	type ChatProvider,
	type ChatRequest,
	ProviderError,
} from "../src/inference/providers.ts";
import { hashPassword } from "../src/lib/crypto.ts";
import { newId } from "../src/lib/ids.ts";
import { QUEUES, type StageJob, startQueue } from "../src/queue.ts";
import {
	type ArtifactSeal,
	type BrowserRunRequest,
	type BrowserRunResult,
	type PrepareRequest,
	type PrepareResult,
	type SandboxExecutor,
	type SandboxRunRequest,
	type SandboxRunResult,
	validateBrowserRequest,
	validatePrepareRequest,
	validateRunRequest,
} from "../src/sandbox/executor.ts";
import { handleStageJob, type WorkerDeps } from "../src/worker/handlers.ts";

export const PASSWORD = "integration-test-password";

export type TestContext = {
	config: Config;
	pool: pg.Pool;
	db: Db;
	boss: PgBoss;
	app: FastifyInstance;
	repoRoot: string;
	close(): Promise<void>;
};

export async function createTestContext(
	env: Record<string, string> = {},
): Promise<TestContext> {
	const databaseUrl = inject("databaseUrl");
	const dataDir = mkdtempSync(path.join(tmpdir(), "tracera-data-"));
	const repoRoot = mkdtempSync(path.join(tmpdir(), "tracera-repos-"));
	const config = loadConfig({
		NODE_ENV: "test",
		LOG_LEVEL: "silent",
		DATABASE_URL: databaseUrl,
		TRACERA_DATA_DIR: dataDir,
		TRACERA_REPO_ROOTS: repoRoot,
		TRACERA_SANDBOX_MODE: "disabled",
		...env,
	});
	const pool = createPool(databaseUrl, "tracera-test");
	const db = createDb(pool);
	const boss = await startQueue(databaseUrl, { role: "api" });
	const app = await buildApp({ config, pool, db, boss });
	return {
		config,
		pool,
		db,
		boss,
		app,
		repoRoot,
		async close() {
			await app.close();
			await boss.stop({ graceful: false });
			await pool.end();
		},
	};
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
	await pool.query(
		`TRUNCATE users, workspaces, workspace_members, sessions, api_tokens, repositories, bug_reports,
       investigations, investigation_steps, evidence_assets, model_executions, audit_events, idempotency_keys,
       investigation_evidence, hypotheses, sandbox_runs, patch_proposals, verification_runs,
       resolution_reports, worker_heartbeats, repository_snapshots, graph_nodes, graph_edges,
       graph_file_cache, assessments, patch_analyses, dependency_snapshots CASCADE`,
	);
	await pool.query(
		"DELETE FROM pgboss.job WHERE name IN ('investigation.stage', 'repository.index', 'repository.assess', 'repository.patch_impact', 'dependencies.prepare')",
	);
}

// ---- Test doubles --------------------------------------------------------------------------

/** node:test TAP in the format the sandbox produces (see verification.test.ts for real samples). */
export function tapOutput(
	tests: Array<{ name: string; ok: boolean; code?: string; message?: string }>,
): string {
	const lines = ["TAP version 13"];
	tests.forEach((test, i) => {
		lines.push(`# Subtest: ${test.name}`);
		lines.push(`${test.ok ? "ok" : "not ok"} ${i + 1} - ${test.name}`);
		lines.push("  ---", "  duration_ms: 1.0", "  type: 'test'");
		if (!test.ok)
			lines.push(
				"  location: '/work/.tracera/repro/repro.mjs:5:1'",
				"  failureType: 'testCodeFailure'",
				`  error: '${(test.message ?? "Expected values to be strictly equal").replace(/'/g, "''")}'`,
				`  code: '${test.code ?? "ERR_ASSERTION"}'`,
				`  name: '${test.code === "ERR_ASSERTION" || !test.code ? "AssertionError" : "TypeError"}'`,
				"  expected: 2480",
				"  actual: 1240",
			);
		lines.push("  ...");
	});
	const failed = tests.filter((test) => !test.ok).length;
	lines.push(
		`1..${tests.length}`,
		`# tests ${tests.length}`,
		"# suites 0",
		`# pass ${tests.length - failed}`,
		`# fail ${failed}`,
		"# cancelled 0",
		"# skipped 0",
		"# todo 0",
	);
	return `${lines.join("\n")}\n`;
}

export type FakeRun = Partial<SandboxRunResult> & { stdout?: string };
export type FakePrepare = Partial<PrepareResult>;
export type FakeBrowserRun = Partial<BrowserRunResult>;

/**
 * Test-only executor: applies the real request validation, records requests, and returns scripted
 * results. It never executes code; scenarios inspect the run workspace to decide what a real run
 * would report. Preparations succeed with a deterministic seal unless scripted otherwise, and sealed
 * artifacts live in `artifacts`, where a test can tamper with them. The evaluator refuses executors
 * whose kind is not "docker".
 */
export function fakeExecutor(
	workspacesRoot: string,
	script: (
		request: SandboxRunRequest,
		signal?: AbortSignal,
	) => FakeRun | Promise<FakeRun>,
	options: {
		available?: boolean;
		prepare?: (
			request: PrepareRequest,
			signal?: AbortSignal,
		) => FakePrepare | Promise<FakePrepare>;
		/** Scripted browser runs; without it a browser run reports an app that never became ready. */
		browser?: (
			request: BrowserRunRequest,
			signal?: AbortSignal,
		) => FakeBrowserRun | Promise<FakeBrowserRun>;
	} = {},
): SandboxExecutor & {
	runs: SandboxRunRequest[];
	browserRuns: BrowserRunRequest[];
	preparations: PrepareRequest[];
	artifacts: Map<string, ArtifactSeal>;
} {
	const runs: SandboxRunRequest[] = [];
	const browserRuns: BrowserRunRequest[] = [];
	const preparations: PrepareRequest[] = [];
	const artifacts = new Map<string, ArtifactSeal>();
	const image = `fake@sha256:${"0".repeat(64)}`;
	return {
		kind: "fake",
		runs,
		browserRuns,
		preparations,
		artifacts,
		runBrowser: async (request, signal) => {
			await validateBrowserRequest(request, workspacesRoot);
			browserRuns.push(request);
			const base: BrowserRunResult = {
				status: signal?.aborted ? "cancelled" : "exited",
				report: null,
				appLog: "",
				stderr: "",
				truncated: false,
				durationMs: 5,
				executor: { kind: "fake", image, browserImage: image },
			};
			if (signal?.aborted) return base;
			return {
				...base,
				report: {
					ready: false,
					steps: [],
					console_errors: [],
					page_errors: [],
					blocked_requests: [],
					failed_requests: [],
					final_path: null,
					screenshot: null,
					duration_ms: 5,
				},
				...(await options.browser?.(request, signal)),
			};
		},
		prepare: async (request, signal) => {
			await validatePrepareRequest(request, workspacesRoot);
			preparations.push(request);
			const volume = `tracera-deps-${request.prepId}`;
			const base: PrepareResult = {
				status: "succeeded",
				volume,
				seal: {
					digest: createHash("sha256").update(request.prepId).digest("hex"),
					files: 3,
					dirs: 2,
					links: 0,
					bytes: 120,
					mounts: ["node_modules"],
				},
				exitCode: 0,
				stdout: "",
				stderr: "",
				truncated: false,
				durationMs: 5,
				egress: {
					allowed: 1,
					denied: 0,
					targets: ["registry.npmjs.org:443"],
					denied_targets: [],
				},
				executor: { kind: "fake", image },
			};
			const result: PrepareResult = signal?.aborted
				? { ...base, status: "cancelled", volume: null, seal: null }
				: { ...base, ...(await options.prepare?.(request, signal)) };
			if (result.status !== "succeeded")
				return { ...result, volume: null, seal: null };
			if (result.volume && result.seal)
				artifacts.set(result.volume, { ...result.seal });
			return result;
		},
		inspectArtifact: async (volume) => {
			const seal = artifacts.get(volume);
			return seal ? { ...seal } : null;
		},
		removeArtifact: async (volume) => {
			artifacts.delete(volume);
		},
		listArtifacts: async () =>
			[...artifacts.keys()].map((volume) => ({
				volume,
				createdAt: new Date(0),
			})),
		status: async () => ({
			available: options.available ?? true,
			kind: "fake",
			image,
			detail: options.available === false ? "fake_unavailable" : "test only",
		}),
		run: async (request, signal) => {
			await validateRunRequest(request, workspacesRoot);
			runs.push(request);
			// Same contract as the Docker executor: an already-cancelled run never starts.
			const scripted: FakeRun = signal?.aborted
				? { status: "cancelled", exitCode: null }
				: await script(request, signal);
			return {
				status: "exited",
				exitCode: 0,
				stdout: "",
				stderr: "",
				truncated: false,
				durationMs: 5,
				executor: { kind: "fake", image },
				...scripted,
			};
		},
		reap: async () => 0,
	};
}

type ScriptEntry = unknown | ((request: ChatRequest) => unknown);

/** A provider that answers per task (by schema name), counting calls. No network. */
export function scriptedProvider(
	outputs: Partial<Record<string, ScriptEntry>>,
): ChatProvider & { calls: Array<{ task: string; user: string }> } {
	const calls: Array<{ task: string; user: string }> = [];
	return {
		kind: "openai_compatible",
		name: "scripted",
		calls,
		async complete(request) {
			const task = request.schema.name;
			const user =
				request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
			calls.push({ task, user });
			const entry = outputs[task];
			if (entry === undefined)
				throw new ProviderError(
					"provider_bad_request",
					`No scripted output for ${task}`,
					false,
				);
			const value = typeof entry === "function" ? entry(request) : entry;
			if (value instanceof ProviderError) throw value;
			return {
				content: JSON.stringify(value),
				finishReason: "stop",
				usage: {
					inputTokens: 2000,
					outputTokens: 400,
					reasoningTokens: 0,
					cachedTokens: 0,
				},
			};
		},
	};
}

/** Runs queued investigation jobs for one investigation until none remain (pg-boss rows, in order). */
export async function driveInvestigation(
	ctx: TestContext,
	deps: WorkerDeps,
	investigationId: string,
	maxJobs = 40,
): Promise<number> {
	for (let handled = 0; handled < maxJobs; handled++) {
		const { rows } = await ctx.pool.query<{ id: string; data: StageJob }>(
			"SELECT id, data FROM pgboss.job WHERE name = $1 AND state = 'created' AND data->>'investigationId' = $2 ORDER BY created_on LIMIT 1",
			[QUEUES.stage, investigationId],
		);
		const job = rows[0];
		if (!job) return handled;
		await ctx.pool.query("DELETE FROM pgboss.job WHERE id = $1", [job.id]);
		await handleStageJob(deps, job.data);
	}
	throw new Error("The investigation did not settle");
}

export async function createOwner(db: Db, email = "owner@example.com") {
	return seedOwner(db, { email, password: PASSWORD, costLog2: 10 });
}

export async function addMember(
	db: Db,
	workspaceId: string,
	email = "member@example.com",
) {
	const userId = newId("usr");
	await db.insert(users).values({
		id: userId,
		email,
		displayName: "member",
		passwordHash: await hashPassword(PASSWORD, { costLog2: 10 }),
	});
	await db
		.insert(workspaceMembers)
		.values({ workspaceId, userId, role: "member" });
	return userId;
}

export const csrf = (config: Config) => ({
	"x-tracera-csrf": "1",
	origin: config.api.publicOrigin,
});

export async function login(
	ctx: TestContext,
	email = "owner@example.com",
): Promise<string> {
	const response = await ctx.app.inject({
		method: "POST",
		url: "/api/v1/auth/login",
		headers: csrf(ctx.config),
		payload: { email, password: PASSWORD },
	});
	if (response.statusCode !== 200)
		throw new Error(`login failed: ${response.statusCode} ${response.body}`);
	const cookie = String(response.headers["set-cookie"]).split(";")[0];
	return cookie ?? "";
}

/** Session-authenticated request with CSRF headers for mutations. */
export function asSession(ctx: TestContext, cookie: string) {
	return (
		method: "GET" | "POST" | "PATCH" | "DELETE",
		url: string,
		payload?: unknown,
		headers: Record<string, string> = {},
	) =>
		ctx.app.inject({
			method,
			url,
			headers: {
				cookie,
				...(method === "GET" ? {} : csrf(ctx.config)),
				...headers,
			},
			...(payload === undefined ? {} : { payload: payload as object }),
		});
}

export function asToken(ctx: TestContext, token: string) {
	return (
		method: "GET" | "POST" | "PATCH" | "DELETE",
		url: string,
		payload?: unknown,
		headers: Record<string, string> = {},
	) =>
		ctx.app.inject({
			method,
			url,
			headers: { authorization: `Bearer ${token}`, ...headers },
			...(payload === undefined ? {} : { payload: payload as object }),
		});
}

export async function createToken(
	ctx: TestContext,
	cookie: string,
	body: object,
): Promise<string> {
	const response = await asSession(ctx, cookie)("POST", "/api/v1/tokens", body);
	if (response.statusCode !== 201)
		throw new Error(`token creation failed: ${response.body}`);
	return response.json().secret as string;
}

export function makeGitRepo(root: string, name = "demo-app"): string {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "-b", "main");
	git(
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"--allow-empty",
		"-m",
		"init",
	);
	return dir;
}

export const repositoryBody = (repoPath: string, name = "demo-app") => ({
	name,
	source: { type: "local_path", path: repoPath },
	commands: { install: "npm ci --ignore-scripts", test: "npm test" },
});

/** A provider that returns fixed JSON (or throws), counting calls. No network. */
export function fixedProvider(
	output: unknown | ProviderError,
): ChatProvider & { calls: number } {
	const provider = {
		kind: "openai_compatible" as const,
		name: "fixed",
		calls: 0,
		async complete() {
			provider.calls += 1;
			if (output instanceof ProviderError) throw output;
			return {
				content: JSON.stringify(output),
				finishReason: "stop",
				usage: {
					inputTokens: 1200,
					outputTokens: 600,
					reasoningTokens: 100,
					cachedTokens: 0,
				},
			};
		},
	};
	return provider;
}

export const normalizationOutput = {
	title: "Dashboard average order value is wrong",
	summary: "Average order value shows $12.40 but should be $24.80.",
	expected_behavior: "AI expectation that must not overwrite the user's",
	actual_behavior: "Average order value shows $12.40",
	steps: ["Open /dashboard", "Read Average order value"],
	environment: {
		browser: "Chrome",
		os: null,
		viewport: null,
		app_version: null,
	},
	affected_page: "/dashboard",
	severity_suggestion: "medium",
	suspected_components: ["dashboard metrics"],
	search_terms: ["Average order value"],
	ui_element_phrases: ["average order value"],
	screenshot_observations: [],
	unresolved_questions: [
		{
			question: "Which build?",
			why_it_matters: "Narrows the regression window",
		},
	],
	field_basis: [
		{ field: "actual_behavior", basis: "stated_by_user" },
		{ field: "steps", basis: "inferred" },
	],
};
