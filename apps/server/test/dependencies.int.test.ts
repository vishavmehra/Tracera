import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DependencySnapshotSchema } from "@tracera/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupBenchShop } from "../../../scripts/bench-setup.ts";
import {
	auditEvents,
	dependencySnapshots,
	sandboxRuns,
	verificationRuns,
} from "../src/db/schema.ts";
import { readBlobUtf8 } from "../src/lib/fs.ts";
import {
	cleanupDependencyArtifacts,
	recoverLostDependencySnapshots,
	runDependencySnapshotJob,
} from "../src/modules/dependencies.ts";
import { workspacesRoot } from "../src/modules/workspace.ts";
import type {
	SandboxExecutor,
	SandboxRunRequest,
} from "../src/sandbox/executor.ts";
import type { WorkerDeps } from "../src/worker/handlers.ts";
import {
	B3,
	hypothesesCiting,
	patchOutput,
	plan,
	SUITE,
} from "./bench-scenarios.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	driveInvestigation,
	type FakeRun,
	fakeExecutor,
	login,
	makeGitRepo,
	normalizationOutput,
	repositoryBody,
	resetDatabase,
	scriptedProvider,
	type TestContext,
	tapOutput,
} from "./helpers.ts";

// Dependency preparation through the API, the job, and investigations [mock inference, fake executor]:
// policy refusals, reuse by input identity, failures, cancellation, recovery, retention, workspace
// isolation, read-only mounts in every run, and the environment recorded with verification. The real
// isolation (network, filesystem, limits) is proven in dependencies.docker.test.ts.

let ctx: TestContext;
let session: ReturnType<typeof asSession>;
let bench: { path: string; branches: Record<string, string> };
let benchRepositoryId: string | null = null;

beforeAll(async () => {
	ctx = await createTestContext();
	bench = setupBenchShop(ctx.config.dataDir);
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
	benchRepositoryId = null;
});

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
function commit(
	dir: string,
	files: Record<string, string | null>,
	message: string,
) {
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(dir, ...file.split("/"));
		if (content === null) rmSync(target, { force: true });
		else {
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	git(dir, "add", "-A");
	git(
		dir,
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"-m",
		message,
	);
	return git(dir, "rev-parse", "HEAD");
}

const sri = (seed: string) =>
	`sha512-${createHash("sha512").update(seed).digest("base64")}`;
/** package.json and a v3 lockfile pinning registry tarballs (the fake executor downloads nothing). */
function npmProject(
	deps: Record<string, string>,
	manifest: Record<string, unknown> = { name: "app", version: "1.0.0" },
) {
	return {
		"package.json": `${JSON.stringify({ ...manifest, dependencies: deps }, null, 2)}\n`,
		"package-lock.json": `${JSON.stringify(
			{
				name: manifest.name,
				version: manifest.version,
				lockfileVersion: 3,
				requires: true,
				packages: {
					"": {
						name: manifest.name,
						version: manifest.version,
						dependencies: deps,
					},
					...Object.fromEntries(
						Object.entries(deps).map(([name, version]) => [
							`node_modules/${name}`,
							{
								version,
								resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
								integrity: sri(`${name}@${version}`),
							},
						]),
					),
				},
			},
			null,
			2,
		)}\n`,
	};
}

const worker = (
	executor: SandboxExecutor,
	provider = scriptedProvider({}),
): WorkerDeps => ({
	config: ctx.config,
	db: ctx.db,
	pool: ctx.pool,
	boss: ctx.boss,
	provider,
	executor,
	workerId: "test-worker",
});
const root = () => workspacesRoot(ctx.config);
const listFiles = (dir: string, prefix = ""): string[] =>
	readdirSync(dir)
		.flatMap((name) =>
			statSync(path.join(dir, name)).isDirectory()
				? listFiles(path.join(dir, name), `${prefix}${name}/`)
				: [`${prefix}${name}`],
		)
		.sort();

async function register(name: string, files: Record<string, string | null>) {
	const dir = makeGitRepo(ctx.repoRoot, name);
	commit(dir, files, "project");
	const repository = (
		await session("POST", "/api/v1/repositories", repositoryBody(dir, name))
	).json().repository;
	return { dir, repository };
}
const prepare = (repositoryId: string, body: Record<string, unknown> = {}) =>
	session(
		"POST",
		`/api/v1/repositories/${repositoryId}/dependency-snapshots`,
		body,
	);
const snapshotRow = async (id: string) =>
	(
		await ctx.db
			.select()
			.from(dependencySnapshots)
			.where(eq(dependencySnapshots.id, id))
			.limit(1)
	)[0];
const actions = async (targetId: string) =>
	(
		await ctx.db
			.select({ action: auditEvents.action })
			.from(auditEvents)
			.where(eq(auditEvents.targetId, targetId))
	).map((row) => row.action);

describe("dependency snapshots through the API and the job", () => {
	it("prepares the locked dependencies once, reuses them for identical inputs, and prepares changed inputs separately", async () => {
		const { dir, repository } = await register("deps-app", {
			...npmProject({ "left-pad": "1.3.0" }),
			"index.js": "module.exports = 1;\n",
		});
		const inputs: string[][] = [];
		const executor = fakeExecutor(root(), () => ({}), {
			prepare: (request) => {
				inputs.push(listFiles(request.input));
				return {};
			},
		});
		const first = await prepare(repository.id);
		expect(first.statusCode).toBe(202);
		const queued = first.json().snapshot;
		expect(DependencySnapshotSchema.safeParse(queued).success).toBe(true);
		expect(queued).toMatchObject({
			status: "queued",
			manager: "npm",
			lockfile: { path: "package-lock.json", version: 3, packages: 1 },
			manifests: ["package.json"],
			registry: "https://registry.npmjs.org/",
			artifact: null,
		});

		await runDependencySnapshotJob(worker(executor), queued.id);
		const ready = (
			await session("GET", `/api/v1/dependency-snapshots/${queued.id}`)
		).json().snapshot;
		expect(DependencySnapshotSchema.safeParse(ready).success).toBe(true);
		expect(ready).toMatchObject({
			status: "ready",
			attempts: 1,
			artifact: { mounts: ["node_modules"] },
			egress: { allowed: 1, denied: 0 },
		});
		expect(ready.artifact.digest).toMatch(/^[0-9a-f]{64}$/);
		// Only the manifests and the lockfile reach the preparation; no source code does.
		expect(inputs).toEqual([["package-lock.json", "package.json"]]);
		expect(executor.preparations[0]).toMatchObject({
			prepId: `${queued.id}-1`,
			scope: repository.id,
			registry: "https://registry.npmjs.org/",
		});
		expect(await actions(queued.id)).toEqual(
			expect.arrayContaining([
				"dependencies.requested",
				"dependencies.prepared",
			]),
		);

		// Identical inputs: the same snapshot, prepared once, also at a commit that changed only code.
		const again = await prepare(repository.id);
		expect(again.statusCode).toBe(200);
		expect(again.json().snapshot.id).toBe(queued.id);
		commit(dir, { "index.js": "module.exports = 2;\n" }, "code only");
		const codeOnly = await prepare(repository.id, { ref: "main" });
		expect(codeOnly.statusCode).toBe(200);
		expect(codeOnly.json().snapshot.id).toBe(queued.id);
		expect(executor.preparations).toHaveLength(1);

		// A revision with different inputs never reuses another revision's dependencies.
		commit(
			dir,
			npmProject({ "left-pad": "1.3.0", "is-number": "7.0.0" }),
			"add a dependency",
		);
		const changed = await prepare(repository.id, { ref: "main" });
		expect(changed.statusCode).toBe(202);
		expect(changed.json().snapshot.id).not.toBe(queued.id);
		const list = (
			await session(
				"GET",
				`/api/v1/repositories/${repository.id}/dependency-snapshots`,
			)
		).json().snapshots;
		expect(list.map((snapshot: { id: string }) => snapshot.id)).toEqual([
			changed.json().snapshot.id,
			queued.id,
		]);
	});

	it("refuses inputs the policy does not allow before anything is queued", async () => {
		const cases: Array<[string, Record<string, string | null>, string]> = [
			[
				"no-lock",
				{
					"package.json": JSON.stringify({
						name: "a",
						dependencies: { x: "1.0.0" },
					}),
				},
				"lockfile_missing",
			],
			[
				"yarn",
				{
					"package.json": JSON.stringify({
						name: "a",
						dependencies: { x: "1.0.0" },
					}),
					"yarn.lock": "# yarn lockfile v1\n",
				},
				"unsupported_package_manager",
			],
			[
				"git-dep",
				{
					"package.json": JSON.stringify({
						name: "a",
						dependencies: { x: "1.0.0" },
					}),
					"package-lock.json": JSON.stringify({
						lockfileVersion: 3,
						packages: {
							"": { dependencies: { x: "1.0.0" } },
							"node_modules/x": {
								version: "1.0.0",
								resolved: "git+https://github.com/x/x.git#abc",
								integrity: sri("x"),
							},
						},
					}),
				},
				"dependency_source_not_allowed",
			],
			[
				"no-deps",
				{ "package.json": JSON.stringify({ name: "a" }) },
				"dependencies_not_required",
			],
		];
		for (const [name, files, code] of cases) {
			const { repository } = await register(`policy-${name}`, files);
			const response = await prepare(repository.id);
			expect(response.statusCode, name).toBe(422);
			expect(response.json().code, name).toBe(code);
		}
		expect(await ctx.db.select().from(dependencySnapshots)).toHaveLength(0);
		const { rows } = await ctx.pool.query(
			"SELECT 1 FROM pgboss.job WHERE name = 'dependencies.prepare'",
		);
		expect(rows).toHaveLength(0);
	});

	it("records a failed install, re-queues on request, cancels, recovers lost work, and stays inside the workspace", async () => {
		const { repository } = await register(
			"fail-app",
			npmProject({ "left-pad": "1.3.0" }),
		);
		const failing = fakeExecutor(root(), () => ({}), {
			prepare: () => ({
				status: "failed",
				exitCode: 1,
				stderr:
					"npm error code EINTEGRITY\nnpm error integrity checksum failed (token=ghp_example_secret_value_12345)\n",
			}),
		});
		const created = (await prepare(repository.id)).json().snapshot;
		await runDependencySnapshotJob(worker(failing), created.id);
		expect(
			(
				await session("GET", `/api/v1/dependency-snapshots/${created.id}`)
			).json().snapshot,
		).toMatchObject({
			status: "failed",
			artifact: null,
			error: {
				code: "install_failed",
				message: "npm ci failed (EINTEGRITY)",
				retryable: false,
			},
		});
		// The install output is kept as evidence, with secrets redacted.
		const row = await snapshotRow(created.id);
		const log = await readBlobUtf8(
			path.join(ctx.config.dataDir, "blobs"),
			row?.logSha256 ?? "",
		);
		expect(log).toContain("EINTEGRITY");
		expect(log).not.toContain("ghp_example_secret_value_12345");
		expect(await actions(created.id)).toContain(
			"dependencies.preparation_failed",
		);

		// An explicit request queues it again; cancelling a queued preparation is immediate.
		const retried = await prepare(repository.id);
		expect(retried.statusCode).toBe(202);
		expect(retried.json().snapshot).toMatchObject({
			id: created.id,
			status: "queued",
		});
		const cancel = () =>
			session("POST", `/api/v1/dependency-snapshots/${created.id}/cancel`);
		expect((await cancel()).json().snapshot.status).toBe("cancelled");
		expect((await cancel()).statusCode).toBe(409);

		// A running preparation stops at its next cancellation check.
		await prepare(repository.id);
		const slow = fakeExecutor(root(), () => ({}), {
			prepare: (_request, signal) =>
				new Promise((resolve) => {
					const timer = setInterval(() => {
						if (signal?.aborted) {
							clearInterval(timer);
							resolve({ status: "cancelled" });
						}
					}, 20);
				}),
		});
		const job = runDependencySnapshotJob(worker(slow), created.id);
		for (
			let i = 0;
			i < 100 && (await snapshotRow(created.id))?.status !== "preparing";
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await cancel()).statusCode).toBe(202);
		await job;
		expect(await snapshotRow(created.id)).toMatchObject({
			status: "cancelled",
			error: { code: "cancelled" },
		});

		// Lost work: a preparation whose heartbeat stopped is failed as retryable.
		await ctx.db
			.update(dependencySnapshots)
			.set({
				status: "preparing",
				updatedAt: new Date(Date.now() - 10 * 60_000),
			})
			.where(eq(dependencySnapshots.id, created.id));
		expect(await recoverLostDependencySnapshots(ctx.db)).toBe(1);
		expect(await snapshotRow(created.id)).toMatchObject({
			status: "failed",
			error: { code: "job_lost", retryable: true },
		});

		// Another workspace sees none of it.
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		for (const [method, url] of [
			["GET", `/api/v1/dependency-snapshots/${created.id}`],
			["POST", `/api/v1/dependency-snapshots/${created.id}/cancel`],
			["POST", `/api/v1/repositories/${repository.id}/dependency-snapshots`],
			["GET", `/api/v1/repositories/${repository.id}/dependency-snapshots`],
		] as const)
			expect(
				(await other(method, url, method === "POST" ? {} : undefined))
					.statusCode,
				url,
			).toBe(404);
	});

	it("keeps the most recently used artifacts and removes the rest and any orphans", async () => {
		const { repository } = await register(
			"retained",
			npmProject({ "left-pad": "1.3.0" }),
		);
		const executor = fakeExecutor(root(), () => ({}));
		const workspaceId =
			(
				await ctx.pool.query<{ workspace_id: string }>(
					"SELECT workspace_id FROM repositories WHERE id = $1",
					[repository.id],
				)
			).rows[0]?.workspace_id ?? "";
		const seal = (digit: string) => ({
			digest: digit.repeat(64),
			files: 1,
			dirs: 1,
			links: 0,
			bytes: 1,
			mounts: ["node_modules"],
		});
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			const volume = `tracera-deps-dep_retain${i}-1`;
			executor.artifacts.set(volume, seal(String(i)));
			const id = `dep_RETAIN${i}`;
			await ctx.db.insert(dependencySnapshots).values({
				id,
				workspaceId,
				repositoryId: repository.id,
				commitSha: "a".repeat(40),
				cacheKey: `key-${i}`,
				manager: "npm",
				lockfile: {
					path: "package-lock.json",
					version: 3,
					sha256: "1".repeat(64),
					packages: 1,
				},
				manifests: [{ path: "package.json", sha256: "2".repeat(64) }],
				registry: "https://registry.npmjs.org/",
				image: ctx.config.sandboxImage,
				status: "ready",
				volume,
				seal: seal(String(i)),
				lastUsedAt: new Date(Date.now() - (4 - i) * 60_000),
			});
			ids.push(id);
		}
		executor.artifacts.set("tracera-deps-orphan-1", seal("f"));
		const removed = await cleanupDependencyArtifacts({
			db: ctx.db,
			config: ctx.config,
			executor,
		});
		// Keep 3 per repository (the default): the least recently used one expires, the orphan goes.
		expect(removed).toBe(2);
		expect([...executor.artifacts.keys()].sort()).toEqual([
			"tracera-deps-dep_retain1-1",
			"tracera-deps-dep_retain2-1",
			"tracera-deps-dep_retain3-1",
		]);
		expect((await snapshotRow(ids[0] ?? ""))?.status).toBe("expired");
	});
});

// ---- Investigations ---------------------------------------------------------------------------

/** Simulates node:test without executing code: the bug marker in the run copy decides the result. */
function benchScript(file: string, marker: string) {
	return (request: SandboxRunRequest): FakeRun => {
		const source = readFileSync(
			path.join(request.workspace, ...file.split("/")),
			"utf8",
		);
		const buggy = source.includes(marker);
		if (request.argv.includes(".tracera/repro/repro.mjs"))
			return {
				exitCode: buggy ? 1 : 0,
				stdout: tapOutput([
					{ name: "two orders totaling $49.60 average $24.80", ok: !buggy },
				]),
			};
		return {
			exitCode: 0,
			stdout: tapOutput(SUITE.map((name) => ({ name, ok: true }))),
		};
	};
}

/** A Bench Shop branch with changed files, pushed from a scratch clone (the fixture's tree is untouched). */
function benchBranch(
	name: string,
	change: (dir: string) => Record<string, string | null>,
) {
	const scratch = mkdtempSync(path.join(tmpdir(), "tracera-bench-branch-"));
	try {
		execFileSync("git", ["clone", "-q", bench.path, scratch], {
			stdio: "pipe",
		});
		git(scratch, "checkout", "-q", B3.branch);
		commit(scratch, change(scratch), name);
		git(scratch, "push", "-q", "origin", `HEAD:refs/heads/${name}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return name;
}
const withDependencies = (lockfile: boolean) => (dir: string) => {
	const manifest = JSON.parse(
		readFileSync(path.join(dir, "package.json"), "utf8"),
	);
	const project = npmProject({ "left-pad": "1.3.0" }, manifest);
	return lockfile
		? project
		: { "package.json": project["package.json"], "package-lock.json": null };
};

async function benchRepository() {
	benchRepositoryId ??= (
		await session("POST", "/api/v1/repositories", {
			name: "bench-shop",
			source: { type: "fixture", fixture: "bench-shop" },
			commands: { install: "npm ci --ignore-scripts", test: "npm test" },
		})
	).json().repository.id as string;
	return benchRepositoryId;
}

async function investigate(branch: string, executor: SandboxExecutor) {
	const provider = scriptedProvider({
		normalize_bug_report: normalizationOutput,
		plan_reproduction: plan(),
		generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
		generate_patch: patchOutput(),
	});
	const bug = (
		await session("POST", "/api/v1/bug-reports", {
			...B3.report,
			repository_id: await benchRepository(),
		})
	).json().bug_report;
	const investigation = (
		await session("POST", "/api/v1/investigations", {
			bug_report_id: bug.id,
			commit: branch,
		})
	).json().investigation;
	await driveInvestigation(ctx, worker(executor, provider), investigation.id);
	const view = (
		await session("GET", `/api/v1/investigations/${investigation.id}`)
	).json().investigation;
	const step = (stage: string) =>
		view.steps.find((s: { stage: string }) => s.stage === stage);
	return { id: investigation.id as string, view, step };
}

describe("investigations with dependencies", () => {
	it("prepares the dependencies, mounts them read-only in every run, and records them with the verification", async () => {
		const branch = benchBranch("deps/dashboard-aov", withDependencies(true));
		const executor = fakeExecutor(root(), benchScript(B3.file, B3.marker));
		const { id, view, step } = await investigate(branch, executor);
		expect(view).toMatchObject({
			status: "awaiting_approval",
			baseline_reproduction: { status: "reproduced" },
			latest_verification: { outcome: "verified" },
		});
		const prepared = step("prepare_dependencies");
		expect(prepared).toMatchObject({
			status: "succeeded",
			summary: {
				reused: false,
				manager: "npm",
				lockfile: { path: "package-lock.json", packages: 1 },
				mounts: ["node_modules"],
			},
		});
		const snapshotId = prepared.summary.snapshot_id as string;
		const volume = `tracera-deps-${snapshotId}-1`;
		expect(executor.runs.length).toBeGreaterThan(0);
		for (const run of executor.runs)
			expect(run.dependencies).toEqual({ volume, mounts: ["node_modules"] });
		const runs = await ctx.db
			.select({ snapshot: sandboxRuns.dependencySnapshotId })
			.from(sandboxRuns)
			.where(eq(sandboxRuns.investigationId, id));
		expect(runs.length).toBe(executor.runs.length);
		expect(new Set(runs.map((run) => run.snapshot))).toEqual(
			new Set([snapshotId]),
		);
		const [verification] = await ctx.db
			.select({ environment: verificationRuns.environment })
			.from(verificationRuns)
			.where(eq(verificationRuns.investigationId, id));
		expect(verification?.environment).toMatchObject({
			network: "none",
			dependencies: {
				snapshot_id: snapshotId,
				digest: executor.artifacts.get(volume)?.digest,
				manager: "npm",
			},
			dependencies_blocked: null,
		});
		// Reviewers see the same environment through the verification API.
		const served = (
			await session(
				"GET",
				`/api/v1/verifications/${view.latest_verification.id}`,
			)
		).json().verification;
		expect(served.environment).toEqual(verification?.environment);
		const markdown = (
			await session(
				"GET",
				`/api/v1/investigations/${id}/report?format=markdown`,
			)
		).body;
		expect(markdown).toContain(`dependencies: npm snapshot ${snapshotId}`);
		expect(markdown).toContain("installed without lifecycle scripts");
	});

	it("reuses an intact snapshot", async () => {
		const branch = benchBranch("deps2/dashboard-aov", withDependencies(true));
		const executor = fakeExecutor(root(), benchScript(B3.file, B3.marker));
		const first = await investigate(branch, executor);
		const snapshotId = first.step("prepare_dependencies").summary
			.snapshot_id as string;
		const second = await investigate(branch, executor);
		expect(second.step("prepare_dependencies")).toMatchObject({
			status: "succeeded",
			summary: { snapshot_id: snapshotId, reused: true },
		});
		expect(executor.preparations).toHaveLength(1);
	});

	it("refuses a snapshot whose artifact no longer matches its seal", async () => {
		const branch = benchBranch("deps3/dashboard-aov", withDependencies(true));
		const executor = fakeExecutor(root(), benchScript(B3.file, B3.marker));
		// Prepared ahead of time through the API, as a client would.
		const created = (
			await prepare(await benchRepository(), { ref: branch })
		).json().snapshot;
		await runDependencySnapshotJob(worker(executor), created.id);
		const snapshotId = created.id as string;

		// Someone altered the prepared files: the seal no longer matches.
		const volume = `tracera-deps-${snapshotId}-1`;
		const seal = executor.artifacts.get(volume);
		if (seal) seal.digest = "f".repeat(64);
		const runsBefore = executor.runs.length;
		const third = await investigate(branch, executor);
		expect(third.step("prepare_dependencies")).toMatchObject({
			status: "failed",
			summary: { reason: "dependency_snapshot_tampered" },
		});
		expect(third.step("reproduce_baseline")).toMatchObject({
			status: "blocked",
			summary: { reason: "dependencies_not_prepared" },
		});
		expect(executor.runs.length).toBe(runsBefore);
		expect(executor.artifacts.has(volume)).toBe(false);
		expect(await actions(snapshotId)).toContain("dependencies.seal_mismatch");
	});

	it("never prepares or runs anything without the sandbox: preparation is blocked, not done on the host", async () => {
		const branch = benchBranch(
			"nosandbox/dashboard-aov",
			withDependencies(true),
		);
		const executor = fakeExecutor(
			root(),
			() => {
				throw new Error("must not run");
			},
			{
				available: false,
				prepare: () => {
					throw new Error("must not prepare");
				},
			},
		);
		const { step } = await investigate(branch, executor);
		expect(step("prepare_dependencies")).toMatchObject({
			status: "blocked",
			summary: { reason: "sandbox_unavailable" },
		});
		expect(step("reproduce_baseline")).toMatchObject({
			status: "blocked",
			summary: { reason: "sandbox_unavailable" },
		});
		expect(executor.preparations).toHaveLength(0);
		expect(executor.runs).toHaveLength(0);
	});

	it("blocks the sandbox stages when the dependencies cannot be prepared, and says why", async () => {
		const branch = benchBranch("nolock/dashboard-aov", withDependencies(false));
		const executor = fakeExecutor(root(), () => {
			throw new Error("must not run");
		});
		const { id, view, step } = await investigate(branch, executor);
		expect(step("prepare_dependencies")).toMatchObject({
			status: "blocked",
			summary: { reason: "lockfile_missing" },
		});
		expect(view.baseline_reproduction).toMatchObject({
			status: "blocked",
			reason: "dependencies_not_prepared",
		});
		expect(executor.runs).toHaveLength(0);
		expect(executor.preparations).toHaveLength(0);
		if (view.latest_verification)
			expect(view.latest_verification.outcome).toBe("blocked");
		const markdown = (
			await session(
				"GET",
				`/api/v1/investigations/${id}/report?format=markdown`,
			)
		).body;
		expect(markdown).toContain(
			"Dependencies were not prepared (lockfile_missing)",
		);
		expect(await ctx.db.select().from(dependencySnapshots)).toHaveLength(0);
	});
});
