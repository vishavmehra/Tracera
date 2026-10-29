import path from "node:path";
import { eq, gt } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { type Config, ConfigError } from "../config.ts";
import type { Db } from "../db/client.ts";
import { bugReports, workerHeartbeats } from "../db/schema.ts";
import { createMockProvider } from "../inference/mock.ts";
import {
	type ChatProvider,
	createHttpProvider,
} from "../inference/providers.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { recoverLostAssessments, runAssessJob } from "../modules/assessment.ts";
import {
	cleanupDependencyArtifacts,
	recoverLostDependencySnapshots,
	runDependencySnapshotJob,
} from "../modules/dependencies.ts";
import { recoverLostIndexJobs, runIndexJob } from "../modules/graph.ts";
import {
	recoverStaleSteps,
	runInvestigationStage,
} from "../modules/investigations.ts";
import { runNormalization } from "../modules/normalization.ts";
import {
	recoverLostPatchAnalyses,
	runPatchImpactJob,
} from "../modules/patch-analysis.ts";
import { workspacesRoot } from "../modules/workspace.ts";
import {
	type AssessJob,
	type DependencyPrepareJob,
	type IndexJob,
	type NormalizeJob,
	type PatchImpactJob,
	QUEUES,
	type StageJob,
} from "../queue.ts";
import { createDockerExecutor } from "../sandbox/docker.ts";
import {
	createUnavailableExecutor,
	type SandboxExecutor,
} from "../sandbox/executor.ts";

export type WorkerDeps = {
	config: Config;
	db: Db;
	pool: pg.Pool;
	boss: PgBoss;
	provider: ChatProvider;
	executor: SandboxExecutor;
	workerId: string;
	log?: (message: string, fields: Record<string, unknown>) => void;
};

/** The configured provider only; there is no silent fallback to mock or to another provider. */
export function createProvider(config: Config): ChatProvider {
	const inference = config.inference;
	if (inference.provider === "mock") return createMockProvider();
	if (!inference.baseUrl || !inference.apiKey)
		throw new ConfigError(
			`Inference provider ${inference.provider} is missing its base URL or API key`,
		);
	return createHttpProvider({
		kind: inference.provider,
		name: inference.providerName,
		baseUrl: inference.baseUrl,
		apiKey: inference.apiKey,
	});
}

/** Stable per-installation id (database host and name, data directory); credentials are not part of it. */
export function sandboxInstanceId(
	config: Pick<Config, "databaseUrl" | "dataDir">,
) {
	const database = new URL(config.databaseUrl);
	return sha256Hex(
		`${database.host}${database.pathname}|${path.resolve(config.dataDir)}`,
	).slice(0, 16);
}

/**
 * The only place a Docker executor is constructed. Without Docker mode the worker still runs every
 * non-execution stage, and sandbox stages record `blocked: sandbox_unavailable`. There is no host
 * fallback, and the fake executor exists only in the test suite.
 */
export function createExecutor(
	config: Config,
	workerId: string,
): SandboxExecutor {
	if (config.sandboxMode === "docker")
		return createDockerExecutor({
			image: config.sandboxImage,
			workspacesRoot: workspacesRoot(config),
			workerId,
			instance: sandboxInstanceId(config),
			egressNetwork: config.dependencies.egressNetwork,
			browserImage: config.browserImage,
		});
	return createUnavailableExecutor(
		config.sandboxMode === "disabled"
			? "sandbox_disabled"
			: "fake_sandbox_is_test_only",
	);
}

export async function handleNormalizeJob(
	deps: WorkerDeps,
	job: NormalizeJob,
): Promise<void> {
	const [bug] = await deps.db
		.select({ status: bugReports.normalizationStatus })
		.from(bugReports)
		.where(eq(bugReports.id, job.bugReportId))
		.limit(1);
	if (!bug || bug.status === "done") return; // deleted or already normalized: nothing to do (idempotent)
	await runNormalization(deps, job.bugReportId);
}

export async function handleStageJob(
	deps: WorkerDeps,
	job: StageJob,
): Promise<void> {
	await runInvestigationStage(deps, job);
}

export async function publishHeartbeat(
	deps: Pick<WorkerDeps, "db" | "executor" | "workerId">,
	startedAt: Date,
): Promise<void> {
	const sandbox = await deps.executor.status();
	await deps.db
		.insert(workerHeartbeats)
		.values({
			workerId: deps.workerId,
			sandbox,
			startedAt,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: workerHeartbeats.workerId,
			set: { sandbox, updatedAt: new Date() },
		});
}

const RETENTION_INTERVAL_MS = 10 * 60_000;
let lastRetention = 0;

/** Restart recovery and stale-container cleanup; runs at startup and then every minute. */
export async function maintenance(deps: WorkerDeps): Promise<{
	recovered: number;
	reaped: number;
}> {
	const recovered =
		(await recoverStaleSteps(deps)) +
		(await recoverLostIndexJobs(deps.db)) +
		(await recoverLostAssessments(deps.db)) +
		(await recoverLostPatchAnalyses(deps.db)) +
		(await recoverLostDependencySnapshots(deps.db));
	const live = await deps.db
		.select({ id: workerHeartbeats.workerId })
		.from(workerHeartbeats)
		.where(gt(workerHeartbeats.updatedAt, new Date(Date.now() - 90_000)));
	let reaped = await deps.executor.reap({
		liveWorkerIds: live.map((worker) => worker.id),
	});
	// Dependency artifacts are large: retention runs at most every ten minutes.
	if (Date.now() - lastRetention > RETENTION_INTERVAL_MS) {
		lastRetention = Date.now();
		reaped += await cleanupDependencyArtifacts(deps);
	}
	return { recovered, reaped };
}

/** Starts the queue handlers, heartbeat, and maintenance loop. Returns a stop function. */
export async function startWorker(
	deps: WorkerDeps,
): Promise<() => Promise<void>> {
	const report = (error: unknown) =>
		deps.log?.("worker maintenance failed", {
			error: (error as Error).message,
		});
	const startedAt = new Date();
	await publishHeartbeat(deps, startedAt);
	const first = await maintenance(deps);
	if (first.recovered > 0 || first.reaped > 0)
		deps.log?.("startup recovery", first);
	await deps.boss.work<NormalizeJob>(
		QUEUES.normalize,
		{ batchSize: 1 },
		async ([job]) => {
			if (job) await handleNormalizeJob(deps, job.data);
		},
	);
	await deps.boss.work<StageJob>(
		QUEUES.stage,
		{ batchSize: 1 },
		async ([job]) => {
			if (job) await handleStageJob(deps, job.data);
		},
	);
	await deps.boss.work<IndexJob>(
		QUEUES.index,
		{ batchSize: 1 },
		async ([job]) => {
			if (job) await runIndexJob(deps, job.data.snapshotId);
		},
	);
	await deps.boss.work<AssessJob>(
		QUEUES.assess,
		{ batchSize: 1 },
		async ([job]) => {
			if (job) await runAssessJob(deps, job.data.assessmentId);
		},
	);
	await deps.boss.work<PatchImpactJob>(
		QUEUES.patchImpact,
		{ batchSize: 1 },
		async ([job]) => {
			if (job) await runPatchImpactJob(deps, job.data.analysisId);
		},
	);
	await deps.boss.work<DependencyPrepareJob>(
		QUEUES.dependencies,
		{ batchSize: 1 },
		async ([job]) => {
			if (job) await runDependencySnapshotJob(deps, job.data.snapshotId);
		},
	);
	const heartbeat = setInterval(() => {
		publishHeartbeat(deps, startedAt).catch(report);
	}, 15_000);
	const sweep = setInterval(() => {
		maintenance(deps).catch(report);
	}, 60_000);
	return async () => {
		clearInterval(heartbeat);
		clearInterval(sweep);
		await deps.db
			.delete(workerHeartbeats)
			.where(eq(workerHeartbeats.workerId, deps.workerId))
			.catch(() => undefined);
	};
}
