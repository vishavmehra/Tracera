import { z } from "zod";

export const ScopeSchema = z.enum([
	"reports:read",
	"reports:write",
	"investigations:read",
	"investigations:write",
	"verifications:write",
	"repositories:read",
]);
export type Scope = z.infer<typeof ScopeSchema>;

export const ClientKindSchema = z.enum(["extension", "mcp", "script"]);
export type ClientKind = z.infer<typeof ClientKindSchema>;

/** Default scopes per client kind. Script tokens must list scopes explicitly. */
export const SCOPE_PRESETS: Record<ClientKind, readonly Scope[]> = {
	extension: ["reports:write"],
	mcp: ScopeSchema.options,
	script: [],
};

export const LoginRequestSchema = z.strictObject({
	email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
	password: z.string().min(8).max(256),
});

export const CreateTokenRequestSchema = z
	.strictObject({
		name: z.string().trim().min(1).max(100),
		client_kind: ClientKindSchema,
		scopes: z
			.array(ScopeSchema)
			.min(1)
			.max(ScopeSchema.options.length)
			.optional(),
		expires_in_days: z.number().int().min(1).max(90).optional(),
	})
	.refine(
		(value) =>
			value.client_kind !== "script" || (value.scopes?.length ?? 0) > 0,
		{
			message: "Script tokens require explicit scopes",
			path: ["scopes"],
		},
	);

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;
