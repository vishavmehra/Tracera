import type { InvestigationStage } from "@tracera/contracts";
import { PgBoss } from "pg-boss";
import type { QueueDb } from "./db/client.ts";

export const QUEUES = {
	normalize: "intake.normalize",
	stage: "investigation.stage",
	index: "repository.index",
	assess: "repository.assess",
	patchImpact: "repository.patch_impact",
	dependencies: "dependencies.prepare",
} as const;

export type NormalizeJob = { bugReportId: string; workspaceId: string };
export type IndexJob = { snapshotId: string };
export type AssessJob = { assessmentId: string };
export type PatchImpactJob = { analysisId: string };
export type DependencyPrepareJob = { snapshotId: string };
export type StageJob = {
	investigationId: string;
	stage: InvestigationStage;
	attempt: number;
};

/** Starts pg-boss (schema `pgboss` in the same database; no Redis) and ensures the queues exist. */
export async function startQueue(
	databaseUrl: string,
	options: { role: "api" | "worker"; onError?: (error: Error) => void },
): Promise<PgBoss> {
	const boss = new PgBoss({
		connectionString: databaseUrl,
		application_name: `tracera-${options.role}-queue`,
		supervise: options.role === "worker",
		schedule: false,
		max: 4,
	});
	boss.on("error", (error: Error) =>
		(options.onError ?? ((e) => console.error(`queue error: ${e.message}`)))(
			error,
		),
	);
	await boss.start();
	const queues: Array<[string, number]> = [
		[QUEUES.normalize, 300],
		[QUEUES.stage, 1200],
		[QUEUES.index, 900],
		[QUEUES.assess, 600],
		[QUEUES.patchImpact, 900],
		// Preparation timeout (≤ 840 s) plus sealing and container setup.
		[QUEUES.dependencies, 1500],
	];
	for (const [name, expireInSeconds] of queues) {
		if (await boss.getQueue(name)) continue;
		// retryLimit 1 covers worker crashes (expiry); handlers are idempotent and model errors are retried in the gateway.
		await boss
			.createQueue(name, { retryLimit: 1, retryDelay: 5, expireInSeconds })
			.catch(async (error: unknown) => {
				if (!(await boss.getQueue(name))) throw error;
			});
	}
	return boss;
}

/** Enqueue inside the caller's transaction so the job exists only if the rows commit. */
export const enqueueNormalize = (
	boss: PgBoss,
	db: QueueDb,
	job: NormalizeJob,
) => boss.send(QUEUES.normalize, job, { db, singletonKey: job.bugReportId });

export const enqueueStage = (boss: PgBoss, db: QueueDb, job: StageJob) =>
	boss.send(QUEUES.stage, job, {
		db,
		singletonKey: `${job.investigationId}:${job.stage}:${job.attempt}`,
	});

export const enqueueIndex = (boss: PgBoss, db: QueueDb, job: IndexJob) =>
	boss.send(QUEUES.index, job, { db, singletonKey: job.snapshotId });

export const enqueueAssess = (boss: PgBoss, db: QueueDb, job: AssessJob) =>
	boss.send(QUEUES.assess, job, { db, singletonKey: job.assessmentId });

export const enqueuePatchImpact = (
	boss: PgBoss,
	db: QueueDb,
	job: PatchImpactJob,
) => boss.send(QUEUES.patchImpact, job, { db, singletonKey: job.analysisId });

export const enqueueDependencyPrepare = (
	boss: PgBoss,
	db: QueueDb,
	job: DependencyPrepareJob,
) => boss.send(QUEUES.dependencies, job, { db, singletonKey: job.snapshotId });
