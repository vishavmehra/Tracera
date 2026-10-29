import { z } from "zod";
import { idSchema, RefNameSchema } from "./common.ts";

// ---- Dependency preparation -------------------------------------------------------------------

export const DependencySnapshotStatusSchema = z.enum([
	"queued",
	"preparing",
	"ready",
	"failed",
	"cancelled",
	"expired",
]);

/** Prepare (or reuse) the dependencies locked at a revision; the default branch when no ref is given. */
export const PrepareDependenciesRequestSchema = z.strictObject({
	ref: RefNameSchema.optional(),
});

export const DependencySnapshotListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const DependencySnapshotIdSchema = idSchema("dep");

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const CountSchema = z.number().int().nonnegative();
const TimestampSchema = z.iso.datetime();

/** A snapshot as the API returns it. `artifact` is set once the installed tree has been sealed. */
export const DependencySnapshotSchema = z.object({
	id: DependencySnapshotIdSchema,
	repository_id: idSchema("repo"),
	/** The revision it was first prepared for; identical inputs at other revisions reuse it. */
	commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
	status: DependencySnapshotStatusSchema,
	/** `npm`: the only package manager supported. */
	manager: z.string(),
	lockfile: z.object({
		path: z.string(),
		version: z.number().int(),
		sha256: Sha256Schema,
		packages: CountSchema,
	}),
	manifests: z.array(z.string()),
	registry: z.url(),
	image: z.string(),
	artifact: z
		.object({
			digest: Sha256Schema,
			files: CountSchema,
			bytes: CountSchema,
			mounts: z.array(z.string()),
		})
		.nullable(),
	/** What the egress proxy allowed and refused during the install (hosts only). */
	egress: z
		.object({
			allowed: CountSchema,
			denied: CountSchema,
			targets: z.array(z.string()),
			denied_targets: z.array(z.string()),
		})
		.nullable(),
	attempts: CountSchema,
	duration_ms: CountSchema.nullable(),
	error: z
		.object({
			code: z.string(),
			message: z.string(),
			retryable: z.boolean().optional(),
		})
		.nullable(),
	cancel_requested_at: TimestampSchema.nullable(),
	created_at: TimestampSchema,
	started_at: TimestampSchema.nullable(),
	finished_at: TimestampSchema.nullable(),
	last_used_at: TimestampSchema.nullable(),
});

export type DependencySnapshotStatus = z.infer<
	typeof DependencySnapshotStatusSchema
>;
export type DependencySnapshot = z.infer<typeof DependencySnapshotSchema>;
export type PrepareDependenciesRequest = z.infer<
	typeof PrepareDependenciesRequestSchema
>;
