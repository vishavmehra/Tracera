import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import type { ImportMeetingRequest, Integration } from "@tracera/contracts";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { integrationConnections, meetingSessions } from "../db/schema.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { audit } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import {
	authorizationUrl,
	defaultFetch,
	exchangeCode,
	type FetchLike,
	fetchMeetTranscript,
	type GoogleClient,
	type GoogleTokens,
	listConferences,
	MEET_SCOPE,
	meetTranscriptToSegments,
	refreshAccessToken,
	revokeToken,
} from "./meeting-google.ts";
import { ingestTranscript, requireConsent } from "./meetings.ts";

// Meeting-provider connections. Google OAuth tokens are sealed with AES-256-GCM under
// TRACERA_ENCRYPTION_KEY, bound to their row and purpose; they never leave the server.

type Deps = { pool: pg.Pool; db: Db; boss: PgBoss; config: Config };
type SessionContext = Extract<AuthContext, { kind: "session" }>;
type ConnectionRow = typeof integrationConnections.$inferSelect;

export function sealSecret(
	key: Buffer,
	plaintext: string,
	context: string,
): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(context, "utf8"));
	const data = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	return ["v1", iv, cipher.getAuthTag(), data]
		.map((part) =>
			typeof part === "string" ? part : part.toString("base64url"),
		)
		.join(".");
}

/** Throws unless the value was sealed with this key for this context (row and purpose). */
export function openSecret(
	key: Buffer,
	sealed: string,
	context: string,
): string {
	const [version, iv, tag, data] = sealed.split(".");
	if (version !== "v1" || !iv || !tag || !data)
		throw new Error("Unknown sealed format");
	const decipher = createDecipheriv(
		"aes-256-gcm",
		key,
		Buffer.from(iv, "base64url"),
		{
			authTagLength: 16,
		},
	);
	decipher.setAAD(Buffer.from(context, "utf8"));
	decipher.setAuthTag(Buffer.from(tag, "base64url"));
	return Buffer.concat([
		decipher.update(Buffer.from(data, "base64url")),
		decipher.final(),
	]).toString("utf8");
}

function googleSetup(config: Config): { client: GoogleClient; key: Buffer } {
	const { google, encryptionKey, googleMissing } = config.meetings;
	if (!google || !encryptionKey)
		throw new AppError(
			409,
			"integration_not_configured",
			`Google Meet import is not configured on this server (missing: ${googleMissing.join(", ")})`,
		);
	return { client: google, key: encryptionKey };
}

// ---- OAuth state ------------------------------------------------------------------------------

/** ponytail: per-process memory; use a table when the API runs as several instances. */
const pendingStates = new Map<
	string,
	{ userId: string; workspaceId: string; verifier: string; expiresAt: number }
>();
const STATE_TTL_MS = 10 * 60_000;

/** GET /integrations/google/connect: the URL to send the browser to (state + PKCE, 10 minutes). */
export function startGoogleConnect(
	config: Config,
	ctx: SessionContext,
): string {
	const { client } = googleSetup(config);
	const now = Date.now();
	for (const [state, entry] of pendingStates)
		if (entry.expiresAt < now) pendingStates.delete(state);
	if (pendingStates.size >= 1000)
		throw new AppError(
			429,
			"rate_limited",
			"Too many pending connections; try again shortly",
		);
	const state = randomBytes(32).toString("base64url");
	const verifier = randomBytes(32).toString("base64url");
	pendingStates.set(state, {
		userId: ctx.userId,
		workspaceId: ctx.workspaceId,
		verifier,
		expiresAt: now + STATE_TTL_MS,
	});
	return authorizationUrl(client, {
		state,
		codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
	});
}

async function saveTokens(
	db: Db,
	key: Buffer,
	row: Pick<ConnectionRow, "id" | "refreshTokenSealed">,
	tokens: GoogleTokens,
): Promise<ConnectionRow> {
	const [updated] = await db
		.update(integrationConnections)
		.set({
			status: "active",
			accessTokenSealed: sealSecret(
				key,
				tokens.accessToken,
				`${row.id}:access`,
			),
			// Google omits the refresh token on a refresh; the stored one stays valid.
			refreshTokenSealed: tokens.refreshToken
				? sealSecret(key, tokens.refreshToken, `${row.id}:refresh`)
				: row.refreshTokenSealed,
			accessTokenExpiresAt: tokens.expiresAt,
			...(tokens.scopes.length > 0 ? { scopes: tokens.scopes } : {}),
			lastError: null,
			updatedAt: new Date(),
		})
		.where(eq(integrationConnections.id, row.id))
		.returning();
	if (!updated)
		throw new AppError(404, "not_found", "The connection was removed");
	return updated;
}

/**
 * GET /integrations/google/callback: validates the state for this user, exchanges the code, and
 * stores sealed tokens. Returns where to send the browser; tokens never appear in that URL.
 */
export async function completeGoogleConnect(
	deps: Deps,
	ctx: SessionContext,
	query: {
		code?: string | undefined;
		state?: string | undefined;
		error?: string | undefined;
	},
	requestId: string,
	fetchImpl: FetchLike = defaultFetch,
): Promise<string> {
	const back = (result: string) =>
		`${deps.config.api.publicUrl.replace(/\/+$/, "")}/meetings?integration=google&result=${encodeURIComponent(result)}`;
	const { client, key } = googleSetup(deps.config);
	const pending = query.state ? pendingStates.get(query.state) : undefined;
	if (
		!query.state ||
		!pending ||
		pending.expiresAt < Date.now() ||
		pending.userId !== ctx.userId ||
		pending.workspaceId !== ctx.workspaceId
	)
		return back("invalid_state");
	pendingStates.delete(query.state);
	if (query.error || !query.code)
		return back(query.error === "access_denied" ? "denied" : "failed");
	let tokens: GoogleTokens;
	try {
		tokens = await exchangeCode(
			client,
			query.code,
			pending.verifier,
			fetchImpl,
		);
	} catch (error) {
		if (error instanceof AppError) return back(error.code);
		throw error;
	}
	if (!tokens.scopes.includes(MEET_SCOPE)) return back("scope_not_granted");
	const [existing] = await deps.db
		.select()
		.from(integrationConnections)
		.where(
			and(
				eq(integrationConnections.workspaceId, ctx.workspaceId),
				eq(integrationConnections.userId, ctx.userId),
				eq(integrationConnections.provider, "google"),
			),
		)
		.limit(1);
	const row =
		existing ??
		(
			await deps.db
				.insert(integrationConnections)
				.values({
					id: newId("int"),
					workspaceId: ctx.workspaceId,
					userId: ctx.userId,
					provider: "google",
					status: "active",
					scopes: tokens.scopes,
					accessTokenSealed: "pending",
				})
				.returning()
		)[0];
	if (!row)
		throw new AppError(500, "internal_error", "Connection was not stored");
	await saveTokens(deps.db, key, row, tokens);
	await audit(deps.db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: "integration.connected",
		targetType: "integration_connection",
		targetId: row.id,
		metadata: {
			provider: "google",
			scopes: tokens.scopes,
			refresh_token: tokens.refreshToken !== null,
		},
		requestId,
	});
	return back("connected");
}

// ---- Connections ------------------------------------------------------------------------------

/** A connection belongs to one user; other members see a 404, like any foreign ID. */
async function requireConnection(
	db: Db,
	ctx: SessionContext,
	id: string,
): Promise<ConnectionRow> {
	const [row] = await db
		.select()
		.from(integrationConnections)
		.where(
			and(
				eq(integrationConnections.id, id),
				eq(integrationConnections.workspaceId, ctx.workspaceId),
				eq(integrationConnections.userId, ctx.userId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(404, "not_found", `Integration ${id} was not found`);
	return row;
}

async function markExpired(db: Db, id: string, error: AppError): Promise<void> {
	await db
		.update(integrationConnections)
		.set({
			status: "expired",
			lastError: { code: error.code, message: error.message },
			updatedAt: new Date(),
		})
		.where(eq(integrationConnections.id, id));
}

/**
 * Runs a provider call with a valid access token: refreshes ahead of expiry, and once more after a
 * 401. A refused refresh marks the connection expired (the user must reconnect).
 */
async function withAccessToken<T>(
	deps: Deps,
	connection: ConnectionRow,
	run: (accessToken: string) => Promise<T>,
	fetchImpl: FetchLike,
): Promise<T> {
	const { client, key } = googleSetup(deps.config);
	const expired = new AppError(
		409,
		"provider_token_expired",
		"Reconnect your Google account to continue",
	);
	if (connection.status !== "active") throw expired;
	let row = connection;
	const unseal = (sealed: string, purpose: string) => {
		try {
			return openSecret(key, sealed, `${row.id}:${purpose}`);
		} catch {
			// A rotated TRACERA_ENCRYPTION_KEY cannot open older tokens.
			throw expired;
		}
	};
	const refresh = async () => {
		if (!row.refreshTokenSealed) {
			await markExpired(deps.db, row.id, expired);
			throw expired;
		}
		try {
			const tokens = await refreshAccessToken(
				client,
				unseal(row.refreshTokenSealed, "refresh"),
				fetchImpl,
			);
			row = await saveTokens(deps.db, key, row, tokens);
		} catch (error) {
			if (error instanceof AppError && error.code === "provider_token_expired")
				await markExpired(deps.db, row.id, error);
			throw error;
		}
	};
	if (
		!row.accessTokenExpiresAt ||
		row.accessTokenExpiresAt.getTime() < Date.now() + 60_000
	)
		await refresh();
	try {
		return await run(unseal(row.accessTokenSealed, "access"));
	} catch (error) {
		if (!(error instanceof AppError) || error.code !== "provider_token_expired")
			throw error;
		await refresh();
		try {
			return await run(unseal(row.accessTokenSealed, "access"));
		} catch (retryError) {
			if (
				retryError instanceof AppError &&
				retryError.code === "provider_token_expired"
			)
				await markExpired(deps.db, row.id, retryError);
			throw retryError;
		}
	}
}

/** GET /api/v1/integrations: availability on this server and this user's connections. */
export async function listIntegrations(
	db: Db,
	config: Config,
	ctx: SessionContext,
): Promise<{ items: Integration[] }> {
	const [google] = await db
		.select()
		.from(integrationConnections)
		.where(
			and(
				eq(integrationConnections.workspaceId, ctx.workspaceId),
				eq(integrationConnections.userId, ctx.userId),
				eq(integrationConnections.provider, "google"),
			),
		)
		.limit(1);
	return {
		items: [
			{
				provider: "google",
				meeting_provider: "google_meet",
				availability: config.meetings.google ? "available" : "not_configured",
				missing: config.meetings.googleMissing,
				scopes: [MEET_SCOPE],
				connection: google
					? {
							id: google.id,
							status: google.status,
							scopes: google.scopes,
							connected_at: google.createdAt.toISOString(),
							last_error: google.lastError ?? null,
						}
					: null,
			},
			{
				// Microsoft Graph import needs an Azure app registration and a test tenant.
				provider: "microsoft",
				meeting_provider: "teams",
				availability: "not_implemented",
				missing: [],
				scopes: [],
				connection: null,
			},
		],
	};
}

export async function listProviderMeetings(
	deps: Deps,
	ctx: SessionContext,
	connectionId: string,
	fetchImpl: FetchLike = defaultFetch,
) {
	const connection = await requireConnection(deps.db, ctx, connectionId);
	return {
		items: await withAccessToken(
			deps,
			connection,
			(token) => listConferences(token, fetchImpl),
			fetchImpl,
		),
	};
}

/** POST /integrations/{id}/import: fetches one Meet transcript and hands it to the shared engine. */
export async function importProviderMeeting(
	deps: Deps,
	ctx: SessionContext,
	connectionId: string,
	input: ImportMeetingRequest,
	meta: { requestId: string; idempotencyKey: string | undefined },
	fetchImpl: FetchLike = defaultFetch,
) {
	requireConsent(input.consent_attested);
	const connection = await requireConnection(deps.db, ctx, connectionId);
	const [existing] = await deps.db
		.select({ id: meetingSessions.id })
		.from(meetingSessions)
		.where(
			and(
				eq(meetingSessions.workspaceId, ctx.workspaceId),
				eq(meetingSessions.providerRef, input.provider_meeting_ref),
			),
		)
		.limit(1);
	if (existing)
		throw new AppError(
			409,
			"conflict",
			"This transcript was already imported",
			{
				extra: { meeting_id: existing.id },
			},
		);
	const artifact = await withAccessToken(
		deps,
		connection,
		(token) =>
			fetchMeetTranscript(token, input.provider_meeting_ref, fetchImpl),
		fetchImpl,
	);
	const startedAt = artifact.transcript.startTime
		? new Date(artifact.transcript.startTime.replace(/(\.\d{3})\d+/, "$1"))
		: null;
	return ingestTranscript(
		deps,
		ctx,
		{
			provider: "google_meet",
			source: "provider_api",
			title: input.title ?? null,
			occurredAt:
				startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null,
			repositoryId: input.repository_id ?? null,
			providerRef: input.provider_meeting_ref,
			integrationConnectionId: connection.id,
			original: {
				bytes: Buffer.from(
					JSON.stringify({ source: "google_meet_rest_v2", ...artifact }),
					"utf8",
				),
				filename: null,
				contentType: "application/json",
				encoding: null,
			},
			parsed: meetTranscriptToSegments(artifact),
		},
		{
			...meta,
			methodPath: `POST /api/v1/integrations/${connectionId}/import`,
			body: input,
		},
	);
}

/** DELETE /integrations/{id}: revokes at Google (best effort) and deletes the stored tokens. */
export async function disconnectIntegration(
	deps: Deps,
	ctx: SessionContext,
	connectionId: string,
	requestId: string,
	fetchImpl: FetchLike = defaultFetch,
): Promise<void> {
	const connection = await requireConnection(deps.db, ctx, connectionId);
	let revoked = false;
	const key = deps.config.meetings.encryptionKey;
	if (key) {
		const [sealed, purpose] = connection.refreshTokenSealed
			? [connection.refreshTokenSealed, "refresh"]
			: [connection.accessTokenSealed, "access"];
		try {
			revoked = await revokeToken(
				openSecret(key, sealed, `${connection.id}:${purpose}`),
				fetchImpl,
			);
		} catch {
			revoked = false;
		}
	}
	await deps.db
		.delete(integrationConnections)
		.where(eq(integrationConnections.id, connection.id));
	await audit(deps.db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: "integration.disconnected",
		targetType: "integration_connection",
		targetId: connection.id,
		metadata: { provider: connection.provider, revoked_at_provider: revoked },
		requestId,
	});
}
