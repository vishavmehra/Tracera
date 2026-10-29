import { randomUUID } from "node:crypto";
import {
	type ClientKind,
	type CreateTokenRequest,
	type LoginRequest,
	SCOPE_PRESETS,
	type Scope,
	type SourceChannel,
} from "@tracera/contracts";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
	apiTokens,
	sessions,
	users,
	workspaceMembers,
	workspaces,
} from "../db/schema.ts";
import {
	generateSessionToken,
	generateToken,
	hashPassword,
	sha256Hex,
	verifyPassword,
} from "../lib/crypto.ts";
import { AppError, parseCookies } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import type { Actor } from "./audit.ts";

export const SESSION_COOKIE = "tracera_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

type Role = "owner" | "member";
export type AuthContext =
	| {
			kind: "session";
			userId: string;
			workspaceId: string;
			role: Role;
			sessionId: string;
	  }
	| {
			kind: "token";
			userId: string;
			workspaceId: string;
			role: Role;
			tokenId: string;
			scopes: Scope[];
			clientKind: ClientKind;
	  };

let dummyHash: Promise<string> | undefined;

/** Resolves a bearer PAT or session cookie to an auth context; null when absent, invalid, revoked, or expired. */
export async function authenticateRequest(
	db: Db,
	headers: { authorization?: string; cookie?: string },
): Promise<AuthContext | null> {
	const now = new Date();
	if (headers.authorization) {
		const match = headers.authorization.match(
			/^Bearer\s+(trc_pat_[0-9a-f]{64})$/,
		);
		if (!match?.[1]) return null;
		const [row] = await db
			.select({ token: apiTokens, role: workspaceMembers.role })
			.from(apiTokens)
			.innerJoin(
				workspaceMembers,
				and(
					eq(workspaceMembers.workspaceId, apiTokens.workspaceId),
					eq(workspaceMembers.userId, apiTokens.userId),
				),
			)
			.where(
				and(
					eq(apiTokens.tokenHash, sha256Hex(match[1])),
					isNull(apiTokens.revokedAt),
					gt(apiTokens.expiresAt, now),
				),
			)
			.limit(1);
		if (!row) return null;
		if (
			!row.token.lastUsedAt ||
			now.getTime() - row.token.lastUsedAt.getTime() > 60_000
		) {
			await db
				.update(apiTokens)
				.set({ lastUsedAt: now })
				.where(eq(apiTokens.id, row.token.id));
		}
		return {
			kind: "token",
			userId: row.token.userId,
			workspaceId: row.token.workspaceId,
			role: row.role,
			tokenId: row.token.id,
			scopes: row.token.scopes as Scope[],
			clientKind: row.token.clientKind,
		};
	}
	const cookieValue = parseCookies(headers.cookie)[SESSION_COOKIE];
	if (!cookieValue) return null;
	const [row] = await db
		.select({ session: sessions, role: workspaceMembers.role })
		.from(sessions)
		.innerJoin(
			workspaceMembers,
			and(
				eq(workspaceMembers.workspaceId, sessions.workspaceId),
				eq(workspaceMembers.userId, sessions.userId),
			),
		)
		.where(
			and(
				eq(sessions.tokenHash, sha256Hex(cookieValue)),
				gt(sessions.expiresAt, now),
			),
		)
		.limit(1);
	if (!row) return null;
	if (now.getTime() - row.session.lastSeenAt.getTime() > 60 * 60 * 1000) {
		await db
			.update(sessions)
			.set({
				lastSeenAt: now,
				expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
			})
			.where(eq(sessions.id, row.session.id));
	}
	return {
		kind: "session",
		userId: row.session.userId,
		workspaceId: row.session.workspaceId,
		role: row.role,
		sessionId: row.session.id,
	};
}

export async function login(
	db: Db,
	input: LoginRequest,
	meta: { ip: string; userAgent: string | undefined },
) {
	const [user] = await db
		.select()
		.from(users)
		.where(eq(users.email, input.email))
		.limit(1);
	if (!user || user.disabledAt) {
		dummyHash ??= hashPassword(randomUUID());
		await verifyPassword(input.password, await dummyHash); // equalize timing for unknown accounts
		return null;
	}
	if (!(await verifyPassword(input.password, user.passwordHash))) return null;
	const [membership] = await db
		.select({ workspace: workspaces, role: workspaceMembers.role })
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
		.where(eq(workspaceMembers.userId, user.id))
		.orderBy(workspaceMembers.createdAt)
		.limit(1);
	if (!membership) return null;
	const secret = generateSessionToken();
	const sessionId = randomUUID();
	await db.insert(sessions).values({
		id: sessionId,
		userId: user.id,
		workspaceId: membership.workspace.id,
		tokenHash: sha256Hex(secret),
		expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
		ip: meta.ip,
		userAgent: meta.userAgent?.slice(0, 300) ?? null,
	});
	return {
		secret,
		sessionId,
		user: { id: user.id, email: user.email, display_name: user.displayName },
		workspace: {
			id: membership.workspace.id,
			name: membership.workspace.name,
			role: membership.role,
		},
	};
}

export async function logout(db: Db, sessionId: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function describeMe(db: Db, ctx: AuthContext) {
	const [user] = await db
		.select()
		.from(users)
		.where(eq(users.id, ctx.userId))
		.limit(1);
	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, ctx.workspaceId))
		.limit(1);
	return {
		user: {
			id: ctx.userId,
			email: user?.email,
			display_name: user?.displayName,
		},
		workspace: { id: ctx.workspaceId, name: workspace?.name, role: ctx.role },
		auth: { type: ctx.kind, scopes: ctx.kind === "token" ? ctx.scopes : null },
	};
}

const tokenView = (row: typeof apiTokens.$inferSelect) => ({
	id: row.id,
	name: row.name,
	client_kind: row.clientKind,
	scopes: row.scopes,
	token_prefix: row.tokenPrefix,
	expires_at: row.expiresAt.toISOString(),
	last_used_at: row.lastUsedAt?.toISOString() ?? null,
	revoked_at: row.revokedAt?.toISOString() ?? null,
	created_at: row.createdAt.toISOString(),
});

export async function createApiToken(
	db: Db,
	ctx: AuthContext,
	input: CreateTokenRequest,
) {
	const secret = generateToken();
	const [row] = await db
		.insert(apiTokens)
		.values({
			id: newId("tok"),
			workspaceId: ctx.workspaceId,
			userId: ctx.userId,
			name: input.name,
			clientKind: input.client_kind,
			tokenPrefix: secret.slice(0, 12),
			tokenHash: sha256Hex(secret),
			scopes: [...(input.scopes ?? SCOPE_PRESETS[input.client_kind])],
			expiresAt: new Date(
				Date.now() + (input.expires_in_days ?? 30) * 24 * 60 * 60 * 1000,
			),
		})
		.returning();
	if (!row) throw new AppError(500, "internal_error", "Token creation failed");
	return { token: tokenView(row), secret };
}

export async function listApiTokens(db: Db, ctx: AuthContext) {
	const rows = await db
		.select()
		.from(apiTokens)
		.where(
			and(
				eq(apiTokens.workspaceId, ctx.workspaceId),
				eq(apiTokens.userId, ctx.userId),
			),
		)
		.orderBy(desc(apiTokens.createdAt));
	return rows.map(tokenView);
}

export async function revokeApiToken(
	db: Db,
	ctx: AuthContext,
	tokenId: string,
): Promise<boolean> {
	const rows = await db
		.update(apiTokens)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(apiTokens.id, tokenId),
				eq(apiTokens.workspaceId, ctx.workspaceId),
				eq(apiTokens.userId, ctx.userId),
				isNull(apiTokens.revokedAt),
			),
		)
		.returning({ id: apiTokens.id });
	return rows.length > 0;
}

export function actorOf(ctx: AuthContext): Actor {
	if (ctx.kind === "session") return { type: "user", id: ctx.userId };
	return {
		type: ctx.clientKind === "mcp" ? "mcp" : "api_token",
		id: ctx.tokenId,
	};
}

export function sourceChannelOf(ctx: AuthContext): SourceChannel {
	if (ctx.kind === "session") return "web";
	return ctx.clientKind === "extension"
		? "extension"
		: ctx.clientKind === "mcp"
			? "mcp"
			: "api";
}

export function requireScope(ctx: AuthContext, scope: Scope): void {
	if (ctx.kind === "token" && !ctx.scopes.includes(scope)) {
		throw new AppError(
			403,
			"insufficient_scope",
			`This token lacks the ${scope} scope`,
		);
	}
}

export function requireSession(
	ctx: AuthContext,
): asserts ctx is Extract<AuthContext, { kind: "session" }> {
	if (ctx.kind !== "session")
		throw new AppError(
			403,
			"session_required",
			"This operation requires a signed-in user session",
		);
}

export function requireOwner(
	ctx: AuthContext,
): asserts ctx is Extract<AuthContext, { kind: "session" }> {
	requireSession(ctx);
	if (ctx.role !== "owner")
		throw new AppError(
			403,
			"owner_required",
			"Only workspace owners can do this",
		);
}
