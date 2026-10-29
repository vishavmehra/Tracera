import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupBenchShop } from "../../../scripts/bench-setup.ts";
import {
	auditEvents,
	dependencySnapshots,
	sandboxRuns,
	verificationRuns,
} from "../src/db/schema.ts";
import { workspacesRoot } from "../src/modules/workspace.ts";
import { createDockerExecutor } from "../src/sandbox/docker.ts";
import type { WorkerDeps } from "../src/worker/handlers.ts";
import { B3, hypothesesCiting, patchOutput, plan } from "./bench-scenarios.ts";
import {
	asSession,
	createOwner,
	createTestContext,
	driveInvestigation,
	login,
	normalizationOutput,
	resetDatabase,
	scriptedProvider,
	type TestContext,
} from "./helpers.ts";
import { pkg, quiet, serveRegistry, sri } from "./npm-registry.ts";

// The bug-repair pipeline with every repository execution in the real Docker sandbox. The model is
// scripted (deterministic, no network); the live-model run is `npm run bench:eval`.

let ctx: TestContext;
let session: ReturnType<typeof asSession>;
let benchPath = "";

// A local registry on a test egress network: the dependency case installs a real tarball through the
// production preparation path (internal network, egress proxy, `npm ci --ignore-scripts`, seal).
const TAG = `pipeline-deps-${process.pid}`;
const EGRESS = `tracera-test-egress-${TAG}`;
const REGISTRY_HOST = `tracera-test-registry-${TAG}`;
const REGISTRY = `http://${REGISTRY_HOST}:4873/`;
const LEFT_PAD = pkg(
	"left-pad",
	"1.3.0",
	'module.exports = (s, n, c = " ") => String(s).padStart(n, c);\n',
);

beforeAll(async () => {
	ctx = await createTestContext({ TRACERA_SANDBOX_MODE: "docker" });
	benchPath = setupBenchShop(ctx.config.dataDir).path;
});
afterAll(async () => {
	quiet("rm", "-f", REGISTRY_HOST);
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
	await ctx.close();
});
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	await createOwner(ctx.db);
	session = asSession(ctx, await login(ctx));
});

const get = async (url: string) => (await session("GET", url)).json();

describe("bug repair pipeline [scripted model, real Docker sandbox]", () => {
	it("reproduces, patches, and verifies Bench Shop B3 with every run inside Docker", async () => {
		const executor = createDockerExecutor({
			image: ctx.config.sandboxImage,
			workspacesRoot: workspacesRoot(ctx.config),
			workerId: "docker-pipeline-test",
			instance: "docker-pipeline-test",
		});
		expect(
			await executor.status(),
			"Docker and the pinned image are required",
		).toMatchObject({ available: true });
		const deps: WorkerDeps = {
			config: ctx.config,
			db: ctx.db,
			pool: ctx.pool,
			boss: ctx.boss,
			provider: scriptedProvider({
				normalize_bug_report: normalizationOutput,
				plan_reproduction: plan(),
				generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
				generate_patch: patchOutput(),
			}),
			executor,
			workerId: "docker-pipeline-test",
		};
		const repository = (
			await session("POST", "/api/v1/repositories", {
				name: "bench-shop",
				source: { type: "fixture", fixture: "bench-shop" },
				commands: { install: "npm ci --ignore-scripts", test: "npm test" },
			})
		).json().repository;
		const bug = (
			await session("POST", "/api/v1/bug-reports", {
				...B3.report,
				repository_id: repository.id,
			})
		).json().bug_report;
		const investigation = (
			await session("POST", "/api/v1/investigations", {
				bug_report_id: bug.id,
				commit: B3.branch,
			})
		).json().investigation;
		await driveInvestigation(ctx, deps, investigation.id);

		const done = (await get(`/api/v1/investigations/${investigation.id}`))
			.investigation;
		expect(done).toMatchObject({
			status: "awaiting_approval",
			baseline_reproduction: { status: "reproduced" },
			latest_verification: { outcome: "verified", outcome_reasons: [] },
		});
		const verification = (
			await get(`/api/v1/verifications/${done.latest_verification.id}`)
		).verification;
		expect(
			verification.checks.map(
				(c: { kind: string; status: string }) => `${c.kind}:${c.status}`,
			),
		).toEqual(["reproduction:passed", "unit_tests:passed"]);
		// The real Bench Shop suite ran in the container: 13 tests, all passing after the patch.
		const suite = verification.checks.find(
			(c: { kind: string }) => c.kind === "unit_tests",
		);
		expect(suite.summary).toMatchObject({ tests: 13, passed: 13, failed: 0 });
		expect(suite.summary.graph_linked_tests).toMatchObject({
			failed: [],
			not_reported: [],
		});

		// Every execution is recorded with the exact argv, the pinned image, exit code, and duration.
		const runs = await ctx.db
			.select()
			.from(sandboxRuns)
			.where(eq(sandboxRuns.investigationId, investigation.id));
		expect(runs.length).toBeGreaterThanOrEqual(6);
		for (const run of runs) {
			expect(run.image).toBe(ctx.config.sandboxImage);
			expect(run.status).toBe("exited");
			expect(["node", "npm"]).toContain(run.argv[0]);
		}
		const audits = await ctx.db
			.select()
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.action, "sandbox.run"),
					sql`${auditEvents.metadata}->>'investigation_id' = ${investigation.id}`,
				),
			);
		expect(audits.length).toBe(runs.length);
		for (const event of audits)
			expect(event.metadata).toMatchObject({
				argv: expect.any(Array),
				image: ctx.config.sandboxImage,
				exit_code: expect.any(Number),
				duration_ms: expect.any(Number),
				status: "exited",
			});
	});

	it("prepares a locked dependency through the egress proxy and verifies B3 against it offline", async () => {
		quiet("network", "create", "--label", `tracera.test=${TAG}`, EGRESS);
		await serveRegistry({
			name: REGISTRY_HOST,
			network: EGRESS,
			label: `tracera.test=${TAG}`,
			image: ctx.config.sandboxImage,
			files: { "/left-pad/-/left-pad-1.3.0.tgz": LEFT_PAD },
		});
		const branch = dependencyBranch("deps/dashboard-aov");
		const executor = createDockerExecutor({
			image: ctx.config.sandboxImage,
			workspacesRoot: workspacesRoot(ctx.config),
			workerId: TAG,
			instance: TAG,
			egressNetwork: EGRESS,
		});
		const deps: WorkerDeps = {
			config: {
				...ctx.config,
				dependencies: {
					...ctx.config.dependencies,
					registry: REGISTRY,
					egressNetwork: EGRESS,
				},
			},
			db: ctx.db,
			pool: ctx.pool,
			boss: ctx.boss,
			provider: scriptedProvider({
				normalize_bug_report: normalizationOutput,
				plan_reproduction: plan(),
				generate_hypotheses: hypothesesCiting(B3.file, B3.marker),
				generate_patch: patchOutput(),
			}),
			executor,
			workerId: TAG,
		};
		const repository = (
			await session("POST", "/api/v1/repositories", {
				name: "bench-shop",
				source: { type: "fixture", fixture: "bench-shop" },
				// `install` is stored but never run: preparation always uses `npm ci --ignore-scripts`.
				commands: { install: "npm ci", test: "npm test" },
			})
		).json().repository;
		const bug = (
			await session("POST", "/api/v1/bug-reports", {
				...B3.report,
				repository_id: repository.id,
			})
		).json().bug_report;
		const investigation = (
			await session("POST", "/api/v1/investigations", {
				bug_report_id: bug.id,
				commit: branch,
			})
		).json().investigation;
		await driveInvestigation(ctx, deps, investigation.id);

		const done = (await get(`/api/v1/investigations/${investigation.id}`))
			.investigation;
		expect(done).toMatchObject({
			status: "awaiting_approval",
			baseline_reproduction: { status: "reproduced" },
			latest_verification: { outcome: "verified", outcome_reasons: [] },
		});
		const prepared = done.steps.find(
			(s: { stage: string }) => s.stage === "prepare_dependencies",
		);
		expect(prepared).toMatchObject({
			status: "succeeded",
			summary: {
				reused: false,
				manager: "npm",
				mounts: ["node_modules"],
			},
		});
		const snapshotId = prepared.summary.snapshot_id as string;

		// The suite includes a test that imports the prepared package: 13 Bench Shop tests plus it.
		const verification = (
			await get(`/api/v1/verifications/${done.latest_verification.id}`)
		).verification;
		const suite = verification.checks.find(
			(c: { kind: string }) => c.kind === "unit_tests",
		);
		expect(suite.summary).toMatchObject({ tests: 14, passed: 14, failed: 0 });

		// Every run mounted the same sealed snapshot; the verification records its digest.
		const [snapshot] = await ctx.db
			.select()
			.from(dependencySnapshots)
			.where(eq(dependencySnapshots.id, snapshotId));
		expect(snapshot).toMatchObject({ status: "ready" });
		expect(snapshot?.egress).toMatchObject({ denied: 0 });
		expect(snapshot?.egress?.allowed).toBeGreaterThanOrEqual(1);
		const runs = await ctx.db
			.select()
			.from(sandboxRuns)
			.where(eq(sandboxRuns.investigationId, investigation.id));
		expect(runs.length).toBeGreaterThanOrEqual(4);
		for (const run of runs) {
			expect(run.status).toBe("exited");
			expect(run.dependencySnapshotId).toBe(snapshotId);
		}
		const [stored] = await ctx.db
			.select({ environment: verificationRuns.environment })
			.from(verificationRuns)
			.where(eq(verificationRuns.investigationId, investigation.id));
		expect(stored?.environment).toMatchObject({
			network: "none",
			dependencies: {
				snapshot_id: snapshotId,
				digest: snapshot?.seal?.digest,
				registry: REGISTRY,
			},
			dependencies_blocked: null,
		});
	});
});

const git = (dir: string, ...args: string[]) =>
	execFileSync(
		"git",
		["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
		{ cwd: dir, encoding: "utf8", stdio: "pipe" },
	).trim();

/** A Bench Shop branch (from B3) that locks left-pad from the local registry and tests with it. */
function dependencyBranch(name: string) {
	const scratch = mkdtempSync(path.join(tmpdir(), "tracera-bench-deps-"));
	try {
		git(scratch, "clone", "-q", benchPath, ".");
		git(scratch, "checkout", "-q", B3.branch);
		const manifest = JSON.parse(
			readFileSync(path.join(scratch, "package.json"), "utf8"),
		);
		const dependencies = { "left-pad": "1.3.0" };
		writeFileSync(
			path.join(scratch, "package.json"),
			`${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`,
		);
		writeFileSync(
			path.join(scratch, "package-lock.json"),
			`${JSON.stringify(
				{
					name: manifest.name,
					version: manifest.version,
					lockfileVersion: 3,
					requires: true,
					packages: {
						"": {
							name: manifest.name,
							version: manifest.version,
							dependencies,
						},
						"node_modules/left-pad": {
							version: "1.3.0",
							resolved: `${REGISTRY}left-pad/-/left-pad-1.3.0.tgz`,
							integrity: sri(LEFT_PAD),
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			path.join(scratch, "test", "format.test.js"),
			[
				'import assert from "node:assert/strict";',
				'import { test } from "node:test";',
				'import leftPad from "left-pad";',
				"",
				'test("order numbers are zero-padded", () => {',
				'\tassert.equal(leftPad(42, 6, "0"), "000042");',
				"});",
				"",
			].join("\n"),
		);
		git(scratch, "add", "-A");
		git(scratch, "commit", "-q", "-m", "Pad order numbers with left-pad");
		git(scratch, "push", "-q", "origin", `HEAD:refs/heads/${name}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return name;
}
