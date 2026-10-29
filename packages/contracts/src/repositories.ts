import { z } from "zod";

/** Commands run only inside the sandbox; single line so they cannot smuggle extra commands via newlines. */
const commandSchema = z
	.string()
	.trim()
	.min(1)
	.max(500)
	.refine((value) => !/[\r\n]/.test(value), "Commands must be a single line");

const refName = z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/);
const repositoryName = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, dash, underscore");
const commandsSchema = z.strictObject({
	install: commandSchema,
	test: commandSchema,
	typecheck: commandSchema.optional(),
	lint: commandSchema.optional(),
	build: commandSchema.optional(),
	start: commandSchema.optional(),
});
const appSchema = z.strictObject({
	port: z.number().int().min(1024).max(65_535),
	ready_path: z.string().startsWith("/").max(200),
	base_url_path: z.string().startsWith("/").max(200).optional(),
});

export const CreateRepositoryRequestSchema = z.strictObject({
	name: repositoryName,
	source: z.discriminatedUnion("type", [
		z.strictObject({
			type: z.literal("local_path"),
			path: z.string().min(1).max(1000),
		}),
		z.strictObject({
			type: z.literal("fixture"),
			fixture: z.literal("bench-shop"),
		}),
		z.strictObject({
			type: z.literal("git_url"),
			url: z.url({ protocol: /^https$/ }).max(500),
		}),
	]),
	default_branch: refName.optional(),
	commands: commandsSchema,
	app: appSchema.optional(),
	allow_install_scripts: z.boolean().optional(),
});

/** PATCH /repositories/{id}: the source location is fixed at registration; register again to move it. */
export const UpdateRepositoryRequestSchema = z
	.strictObject({
		name: repositoryName.optional(),
		default_branch: refName.optional(),
		commands: commandsSchema.optional(),
		app: appSchema.nullable().optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Change at least one field",
	});

/** DELETE /repositories/{id}?confirm=<repository name>: the name is retyped to confirm. */
export const DeleteRepositoryQuerySchema = z.object({
	confirm: z.string().max(100),
});

export type CreateRepositoryRequest = z.infer<
	typeof CreateRepositoryRequestSchema
>;
export type UpdateRepositoryRequest = z.infer<
	typeof UpdateRepositoryRequestSchema
>;
