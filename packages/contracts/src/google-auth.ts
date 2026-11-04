import { z } from "zod";

/**
 * What a provider access token may contain. The server puts the value into an Authorization header,
 * so anything that could end a header line or carry a second one is refused before any request is made.
 */
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/=-]+$/;

/** POST /api/v1/auth/google. Only the access token is accepted: a refresh token must never reach the server. */
export const GoogleSignInRequestSchema = z.strictObject({
	access_token: z.string().min(16).max(4096).regex(ACCESS_TOKEN),
});
export type GoogleSignInRequest = z.infer<typeof GoogleSignInRequestSchema>;

/** GET /api/v1/auth/providers: which ways of signing in the server offers besides the password. */
export const AuthProvidersResponseSchema = z.object({
	google: z.object({
		enabled: z.boolean(),
		/** The address the sign-in button navigates to; null when Google sign-in is off. */
		authorize_url: z.url({ protocol: /^https?$/ }).nullable(),
	}),
});
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponseSchema>;
