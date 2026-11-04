import path from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { loadConfig } from "../config.ts";
import { hashPassword } from "../lib/crypto.ts";
import { newId } from "../lib/ids.ts";
import { createDb, createPool, type Db } from "./client.ts";
import { users, workspaceMembers, workspaces } from "./schema.ts";

/** Idempotently creates an owner user and a workspace. Returns the existing ones when already seeded. */
export async function seedOwner(
	db: Db,
	input: {
		email: string;
		password: string;
		displayName?: string;
		workspaceName?: string;
		costLog2?: number;
	},
): Promise<{ userId: string; workspaceId: string; created: boolean }> {
	const email = input.email.trim().toLowerCase();
	const existing = await db
		.select()
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	if (existing[0]) {
		const membership = await db
			.select()
			.from(workspaceMembers)
			.where(eq(workspaceMembers.userId, existing[0].id))
			.limit(1);
		if (membership[0])
			return {
				userId: existing[0].id,
				workspaceId: membership[0].workspaceId,
				created: false,
			};
	}
	const userId = existing[0]?.id ?? newId("usr");
	const workspaceId = newId("wsp");
	await db.transaction(async (tx) => {
		if (!existing[0]) {
			const passwordHash = await hashPassword(input.password, {
				costLog2: input.costLog2,
			});
			await tx.insert(users).values({
				id: userId,
				email,
				displayName: input.displayName ?? email.split("@")[0] ?? email,
				passwordHash,
			});
		}
		await tx.insert(workspaces).values({
			id: workspaceId,
			name: input.workspaceName ?? "Default workspace",
		});
		await tx
			.insert(workspaceMembers)
			.values({ workspaceId, userId, role: "owner" });
	});
	return { userId, workspaceId, created: true };
}

/** The default workspace is the one of the earliest-created owner; null while no owner exists. */
export async function defaultWorkspaceId(db: Db): Promise<string | null> {
	const [owner] = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.role, "owner"))
		.orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId))
		.limit(1);
	return owner?.workspaceId ?? null;
}

/**
 * Idempotently adds a member to the default workspace. An existing account keeps its password, name,
 * and role: at most a missing membership is added, and never as an owner. Returns null while there is
 * no default workspace yet.
 */
export async function seedMember(
	db: Db,
	input: {
		email: string;
		password: string;
		displayName: string;
		costLog2?: number;
	},
): Promise<{ userId: string; workspaceId: string; created: boolean } | null> {
	const workspaceId = await defaultWorkspaceId(db);
	if (!workspaceId) return null;
	const email = input.email.trim().toLowerCase();
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	// Hashing is slow and memory-hungry: do it outside the transaction, and only for a new account.
	const passwordHash = existing
		? null
		: await hashPassword(input.password, { costLog2: input.costLog2 });
	return db.transaction(async (tx) => {
		const inserted = passwordHash
			? await tx
					.insert(users)
					.values({
						id: newId("usr"),
						email,
						displayName: input.displayName,
						passwordHash,
					})
					.onConflictDoNothing()
					.returning({ id: users.id })
			: [];
		// Read the id back: a concurrent seed may have created the account first.
		const [user] = await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email))
			.limit(1);
		if (!user) throw new Error("The account vanished while it was being added");
		await tx
			.insert(workspaceMembers)
			.values({ workspaceId, userId: user.id, role: "member" })
			.onConflictDoNothing();
		return { userId: user.id, workspaceId, created: inserted.length > 0 };
	});
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const email = process.env.TRACERA_SEED_OWNER_EMAIL;
	const password = process.env.TRACERA_SEED_OWNER_PASSWORD;
	if (!email || !password || password.length < 12) {
		console.error(
			"Set TRACERA_SEED_OWNER_EMAIL and TRACERA_SEED_OWNER_PASSWORD (at least 12 characters) in .env.",
		);
		process.exitCode = 1;
	} else {
		const pool = createPool(loadConfig().databaseUrl, "tracera-seed");
		try {
			const result = await seedOwner(createDb(pool), { email, password });
			console.log(
				`${result.created ? "Seeded" : "Already seeded"}: owner ${email}, workspace ${result.workspaceId}`,
			);
		} finally {
			await pool.end();
		}
	}
}
