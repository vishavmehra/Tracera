import { and, eq, gt, lte } from "drizzle-orm";
import type pg from "pg";
import {
	type Db,
	pgErrorCode,
	type QueueDb,
	withTransaction,
} from "../db/client.ts";
import { idempotencyKeys } from "../db/schema.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { AppError } from "../lib/http.ts";

type Result<T> = { status: number; body: T };

/**
 * Runs a creating operation in one transaction. With an Idempotency-Key, the same key and body within
 * 24 h replays the stored response; the same key with another body is a 409.
 */
export async function idempotent<T>(
	deps: { pool: pg.Pool; db: Db },
	scope: {
		workspaceId: string;
		actorId: string;
		key: string | undefined;
		methodPath: string;
		body: unknown;
	},
	run: (tx: { db: Db; queueDb: QueueDb }) => Promise<Result<T>>,
): Promise<Result<T>> {
	if (scope.key === undefined) return withTransaction(deps.pool, run);
	const key = scope.key;
	if (!/^[\x21-\x7E]{1,128}$/.test(key)) {
		throw new AppError(
			400,
			"validation_failed",
			"Idempotency-Key must be 1 to 128 printable characters",
		);
	}
	const requestSha256 = sha256Hex(JSON.stringify(scope.body ?? null));
	const match = and(
		eq(idempotencyKeys.workspaceId, scope.workspaceId),
		eq(idempotencyKeys.actorId, scope.actorId),
		eq(idempotencyKeys.key, key),
	);

	const replay = async (): Promise<Result<T> | null> => {
		const [row] = await deps.db
			.select()
			.from(idempotencyKeys)
			.where(and(match, gt(idempotencyKeys.expiresAt, new Date())))
			.limit(1);
		if (!row) return null;
		if (
			row.requestSha256 !== requestSha256 ||
			row.methodPath !== scope.methodPath
		) {
			throw new AppError(
				409,
				"idempotency_key_reused",
				"This Idempotency-Key was already used with a different request",
			);
		}
		return { status: row.responseStatus, body: row.responseBody as T };
	};

	const prior = await replay();
	if (prior) return prior;
	try {
		return await withTransaction(deps.pool, async (tx) => {
			const result = await run(tx);
			await tx.db
				.delete(idempotencyKeys)
				.where(and(match, lte(idempotencyKeys.expiresAt, new Date())));
			await tx.db.insert(idempotencyKeys).values({
				workspaceId: scope.workspaceId,
				actorId: scope.actorId,
				key,
				methodPath: scope.methodPath,
				requestSha256,
				responseStatus: result.status,
				responseBody: result.body as object,
				expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
			});
			return result;
		});
	} catch (error) {
		if (pgErrorCode(error) === "23505") {
			const concurrent = await replay();
			if (concurrent) return concurrent;
		}
		throw error;
	}
}
