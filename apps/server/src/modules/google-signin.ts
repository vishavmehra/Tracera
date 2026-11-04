import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { users, workspaceMembers } from "../db/schema.ts";
import { hashPassword } from "../lib/crypto.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";

// "Continue with Google": the browser signs in at a Supabase Auth project, which sends it back to the web
// app with an access token in the address fragment. Nothing in that token is trusted. The server asks the
// project who the token belongs to, and only a Google identity with an email Google has verified counts.

/** The web app page the provider returns the browser to. */
export const SIGN_IN_CALLBACK_PATH = "/auth/callback";

export type SupabaseProject = NonNullable<Config["signIn"]["supabase"]>;

/** The provider address the sign-in button opens; null while Google sign-in is off. */
export function googleAuthorizeUrl(config: Config): string | null {
	const project = config.signIn.supabase;
	if (!project) return null;
	const returnTo = `${config.api.publicOrigin}${SIGN_IN_CALLBACK_PATH}`;
	return `${project.url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(returnTo)}`;
}

// ---- What the provider says about a token ----

/** The part of Supabase's user object this sign-in reads; everything else is dropped. */
const SupabaseUserSchema = z.object({
	id: z.string().min(1),
	email: z.string().nullish(),
	email_confirmed_at: z.string().nullish(),
	app_metadata: z.object({ provider: z.string().optional() }).nullish(),
	identities: z
		.array(
			z.object({
				provider: z.string(),
				identity_data: z
					.object({
						email: z.string().optional(),
						email_verified: z.unknown().optional(),
						full_name: z.string().optional(),
						name: z.string().optional(),
					})
					.nullish(),
			}),
		)
		.nullish(),
});
export type SupabaseUser = z.infer<typeof SupabaseUserSchema>;

export type GoogleProfile = { email: string; displayName: string };
export type Verdict =
	| { ok: true; profile: GoogleProfile }
	| { ok: false; code: "invalid_provider_token" | "email_not_verified" };

const emailOf = (value: string | null | undefined): string | null => {
	const parsed = z.email().max(254).safeParse(value?.trim().toLowerCase());
	return parsed.success ? parsed.data : null;
};

// Names come from the provider and are shown to other members: no control or direction-changing characters.
const nameOf = (value: string | undefined): string | undefined =>
	value
		?.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 100) || undefined;

/**
 * Decides whether the provider's user may sign in. The account must have been created through Google
 * (an email and password account made first for someone else's address does not qualify), and its
 * Google identity must carry the same email, confirmed by Google. A project that auto-confirms
 * email sign-ups also sets the account's own confirmation, so that alone proves nothing.
 */
export function evaluateSupabaseUser(user: SupabaseUser): Verdict {
	const google = user.identities?.find(
		(identity) => identity.provider === "google",
	);
	if (user.app_metadata?.provider !== "google" || !google)
		return { ok: false, code: "invalid_provider_token" };
	const data = google.identity_data;
	const email = emailOf(user.email);
	if (
		!email ||
		email !== emailOf(data?.email) ||
		!user.email_confirmed_at ||
		data?.email_verified !== true
	)
		return { ok: false, code: "email_not_verified" };
	return {
		ok: true,
		profile: {
			email,
			displayName:
				nameOf(data?.full_name) ??
				nameOf(data?.name) ??
				(email.split("@")[0] || email),
		},
	};
}

// ---- Talking to the provider ----

const PROVIDER_TIMEOUT_MS = 8_000;
/** Answers that mean the token itself was refused (expired, forged, signed out), not that the provider failed. */
const TOKEN_REFUSED = new Set([400, 401, 403, 404]);

const unreachable = () =>
	new AppError(
		502,
		"provider_unreachable",
		"The sign-in provider could not be reached",
	);

const providerHeaders = (project: SupabaseProject, accessToken: string) => ({
	apikey: project.publishableKey,
	authorization: `Bearer ${accessToken}`,
	accept: "application/json",
});

/**
 * Asks the provider which user an access token belongs to. A refused token is `invalid_provider_token`;
 * a timeout, a refused connection, a redirect, a server error, or an unreadable answer is
 * `provider_unreachable`. Neither message carries anything from the request or the response.
 */
export async function fetchSupabaseUser(
	project: SupabaseProject,
	accessToken: string,
	options: { timeoutMs?: number } = {},
): Promise<SupabaseUser> {
	let response: Response;
	try {
		response = await fetch(`${project.url}/auth/v1/user`, {
			headers: providerHeaders(project, accessToken),
			// Never follow a redirect with the token attached.
			redirect: "error",
			signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS),
		});
	} catch {
		throw unreachable();
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		if (TOKEN_REFUSED.has(response.status))
			throw new AppError(
				401,
				"invalid_provider_token",
				"The sign-in provider did not accept this token",
			);
		throw unreachable();
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw unreachable();
	}
	const parsed = SupabaseUserSchema.safeParse(body);
	if (!parsed.success) throw unreachable();
	return parsed.data;
}

/**
 * Ends the provider's session once the token has been exchanged, so the access token and the refresh
 * token that crossed the browser's address bar open nothing if they are found later. A failure
 * changes nothing for the user; the result says whether it worked.
 */
export async function revokeSupabaseSession(
	project: SupabaseProject,
	accessToken: string,
): Promise<boolean> {
	try {
		const response = await fetch(`${project.url}/auth/v1/logout?scope=local`, {
			method: "POST",
			headers: providerHeaders(project, accessToken),
			redirect: "error",
			signal: AbortSignal.timeout(3_000),
		});
		await response.body?.cancel().catch(() => undefined);
		return response.ok;
	} catch {
		return false;
	}
}

// ---- Tracera's side ----

/** The workspace new Google users join: the one of the earliest-created owner. */
export async function defaultWorkspaceId(db: Db): Promise<string | null> {
	const [row] = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.innerJoin(users, eq(users.id, workspaceMembers.userId))
		.where(eq(workspaceMembers.role, "owner"))
		.orderBy(asc(users.createdAt), asc(workspaceMembers.createdAt))
		.limit(1);
	return row?.workspaceId ?? null;
}

/**
 * The Tracera user for a verified Google email: the one with that email, or else a new member of the
 * default workspace when the server allows it. Nobody becomes an owner this way. Null when there is
 * no user and none may be created.
 */
export async function findOrCreateGoogleUser(
	db: Db,
	profile: GoogleProfile,
	newUsers: "member" | "deny",
): Promise<{ user: typeof users.$inferSelect; created: boolean } | null> {
	const find = async () =>
		(
			await db
				.select()
				.from(users)
				.where(eq(users.email, profile.email))
				.limit(1)
		)[0];
	const existing = await find();
	if (existing) return { user: existing, created: false };
	if (newUsers === "deny") return null;
	const workspaceId = await defaultWorkspaceId(db);
	if (!workspaceId) return null;
	// A hash of a secret nobody sees: signing in with a password can never work for this user.
	const passwordHash = await hashPassword(
		randomBytes(32).toString("base64url"),
	);
	const created = await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(users)
			.values({
				id: newId("usr"),
				email: profile.email,
				displayName: profile.displayName,
				passwordHash,
			})
			.onConflictDoNothing({ target: users.email })
			.returning();
		if (!row) return null;
		await tx
			.insert(workspaceMembers)
			.values({ workspaceId, userId: row.id, role: "member" });
		return row;
	});
	if (created) return { user: created, created: true };
	// Another request created the same user first.
	const raced = await find();
	return raced ? { user: raced, created: false } : null;
}
