import {
	type AuthProvidersResponse,
	GoogleSignInRequestSchema,
} from "@tracera/contracts";
import type { FastifyInstance } from "fastify";
import {
	AppError,
	type createRateLimiter,
	serializeCookie,
} from "../lib/http.ts";
import { audit } from "../modules/audit.ts";
import {
	SESSION_COOKIE,
	SESSION_TTL_SECONDS,
	startSession,
} from "../modules/auth.ts";
import {
	defaultWorkspaceId,
	evaluateSupabaseUser,
	fetchSupabaseUser,
	findOrCreateGoogleUser,
	googleAuthorizeUrl,
	revokeSupabaseSession,
} from "../modules/google-signin.ts";
import type { AppDeps } from "./app.ts";

const REFUSALS = {
	invalid_provider_token: [
		401,
		"The sign-in provider did not accept this sign-in",
	],
	email_not_verified: [
		403,
		"The email address of this Google account is not verified",
	],
	signin_not_allowed: [
		403,
		"This account cannot sign in with Google on this server",
	],
} as const;

const refusal = (code: keyof typeof REFUSALS) =>
	new AppError(REFUSALS[code][0], code, REFUSALS[code][1]);

/**
 * "Continue with Google" through a Supabase Auth project. Both routes are open to callers without a
 * session; the POST keeps the CSRF header and origin checks that the password login has. The access
 * token only ever travels from the request body to the provider: it is never logged, stored, or echoed.
 */
export function registerGoogleAuthRoutes(
	app: FastifyInstance,
	deps: AppDeps,
	shared: {
		/** The password login's per-address failure counter: failed Google sign-ins draw on the same budget. */
		failedLogins: ReturnType<typeof createRateLimiter>;
		secureCookie: boolean;
	},
) {
	const { db, config } = deps;

	app.get("/api/v1/auth/providers", async () => {
		const authorizeUrl = googleAuthorizeUrl(config);
		const body: AuthProvidersResponse = {
			google: { enabled: authorizeUrl !== null, authorize_url: authorizeUrl },
		};
		return body;
	});

	app.post("/api/v1/auth/google", async (request, reply) => {
		const project = config.signIn.supabase;
		if (!project)
			throw new AppError(
				404,
				"google_signin_unavailable",
				"Google sign-in is not enabled on this server",
			);
		const input = GoogleSignInRequestSchema.parse(request.body);
		const limit = shared.failedLogins.isLimited(request.ip);
		if (limit.limited) {
			reply.header("retry-after", String(limit.retryAfterSeconds));
			throw new AppError(
				429,
				"rate_limited",
				"Too many failed login attempts; try again later",
			);
		}

		/** A sign-in the provider or the server's rules turned down: counted, logged by code only, and audited. */
		const refuse = async (error: AppError): Promise<never> => {
			shared.failedLogins.take(request.ip);
			request.log.info(
				{ event: "auth.google_login_failed", code: error.code },
				"google sign-in failed",
			);
			const workspaceId = await defaultWorkspaceId(db);
			if (workspaceId)
				await audit(db, {
					workspaceId,
					actor: { type: "system", id: null },
					action: "auth.login_failed",
					targetType: "workspace",
					targetId: workspaceId,
					metadata: { method: "google", reason: error.code, ip: request.ip },
					requestId: request.id,
				});
			throw error;
		};

		let providerUser: Awaited<ReturnType<typeof fetchSupabaseUser>>;
		try {
			providerUser = await fetchSupabaseUser(project, input.access_token);
		} catch (error) {
			if (error instanceof AppError && error.code === "invalid_provider_token")
				return refuse(error);
			// The provider failing is not the caller's doing: no throttle count, no audit row.
			request.log.warn(
				{ event: "auth.google_provider_unreachable" },
				"google sign-in provider unreachable",
			);
			throw error;
		}
		const verdict = evaluateSupabaseUser(providerUser);
		if (!verdict.ok) return refuse(refusal(verdict.code));

		const found = await findOrCreateGoogleUser(
			db,
			verdict.profile,
			config.signIn.newUsers,
		);
		if (!found || found.user.disabledAt)
			return refuse(refusal("signin_not_allowed"));
		const result = await startSession(db, found.user, {
			ip: request.ip,
			userAgent: request.headers["user-agent"],
		});
		if (!result) return refuse(refusal("signin_not_allowed"));

		const actor = { type: "user", id: result.user.id } as const;
		if (found.created)
			await audit(db, {
				workspaceId: result.workspace.id,
				actor,
				action: "auth.user_created",
				targetType: "user",
				targetId: result.user.id,
				metadata: { method: "google", role: result.workspace.role },
				requestId: request.id,
			});
		const revoked = await revokeSupabaseSession(project, input.access_token);
		await audit(db, {
			workspaceId: result.workspace.id,
			actor,
			action: "auth.login_succeeded",
			targetType: "user",
			targetId: result.user.id,
			metadata: {
				method: "google",
				ip: request.ip,
				provider_session_revoked: revoked,
			},
			requestId: request.id,
		});
		reply.header(
			"set-cookie",
			serializeCookie(SESSION_COOKIE, result.secret, {
				maxAgeSeconds: SESSION_TTL_SECONDS,
				secure: shared.secureCookie,
			}),
		);
		return { user: result.user, workspace: result.workspace };
	});
}
