import type { Db } from "../db/client.ts";
import { auditEvents } from "../db/schema.ts";
import { newId } from "../lib/ids.ts";

export type Actor = {
	type: "user" | "api_token" | "mcp" | "worker" | "system";
	id: string | null;
};

export const WORKER_ACTOR: Actor = { type: "worker", id: "worker" };

/** Appends an audit event. Metadata must never contain evidence content or secrets. */
export async function audit(
	db: Db,
	event: {
		workspaceId: string;
		actor: Actor;
		action: string;
		targetType: string;
		targetId: string;
		metadata?: Record<string, unknown>;
		requestId?: string | null;
	},
): Promise<void> {
	await db.insert(auditEvents).values({
		id: newId("aud"),
		workspaceId: event.workspaceId,
		actorType: event.actor.type,
		actorId: event.actor.id,
		action: event.action,
		targetType: event.targetType,
		targetId: event.targetId,
		metadata: event.metadata ?? {},
		requestId: event.requestId ?? null,
	});
}
