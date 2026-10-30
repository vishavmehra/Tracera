import { z } from "zod";
import { VerificationOutcomeSchema } from "./analysis.ts";
import { idSchema, RefNameSchema } from "./common.ts";

// Actions a signed-in user explicitly authorizes for an approved patch. Each is its own request: an
// authorization for one never covers another, and tokens or MCP clients can never make one.

export const ACTION_KINDS = ["apply", "commit", "push"] as const;
export const ActionKindSchema = z.enum(ACTION_KINDS);
export const ActionStatusSchema = z.enum([
	"queued",
	"running",
	"succeeded",
	"failed",
	"refused",
]);

/** A branch name git accepts under refs/heads, within the characters Tracera allows. */
export const BranchNameSchema = RefNameSchema.refine(
	(name) => !/^\/|\/$|\/\/|(^|\/)\.|\.lock(\/|$)|\.$/.test(name),
	{ message: "Not a valid branch name" },
);

/** The name of a remote configured in the repository, never a URL or a path. */
export const RemoteNameSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Not a remote name");

const CommitMessageSchema = z
	.string()
	.trim()
	.min(1)
	.max(2000)
	.refine((message) => !message.includes("\0"), {
		message: "Contains a NUL byte",
	});

// Omitting an acknowledgement is not a validation error: the server refuses it with a stable code
// (`acknowledgement_mismatch`), so a client that forgot it learns what to send.
const authorization = {
	/** The verification outcome the user saw; it must equal the recorded one. */
	acknowledged_outcome: VerificationOutcomeSchema.optional(),
	/** Required to be true whenever the recorded outcome is not "verified". */
	acknowledged_risks: z.boolean().optional(),
};

export const ActionRequestSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("apply"), ...authorization }),
	z.strictObject({
		kind: z.literal("commit"),
		/** Defaults to `tracera/<patch id>`; always a new branch. */
		branch: BranchNameSchema.optional(),
		/** Defaults to the patch summary. */
		message: CommitMessageSchema.optional(),
		...authorization,
	}),
	z.strictObject({
		kind: z.literal("push"),
		remote: RemoteNameSchema,
		remote_branch: BranchNameSchema,
		...authorization,
	}),
]);

/** Everything here comes from git's own output, except `detail`, a short redacted line for failures. */
export const ActionResultSchema = z.object({
	changed_files: z
		.array(
			z.object({
				path: z.string(),
				status: z.enum(["added", "modified", "deleted"]),
			}),
		)
		.optional(),
	/** Apply: the commit the user's checkout was on. */
	head_commit: z.string().optional(),
	commit_sha: z.string().optional(),
	branch: z.string().optional(),
	remote: z.string().optional(),
	pushed_ref: z.string().optional(),
	detail: z.string().optional(),
});

export const AuthorizedActionSchema = z.object({
	id: idSchema("act"),
	patch_id: idSchema("pat"),
	repository_id: idSchema("repo"),
	kind: ActionKindSchema,
	status: ActionStatusSchema,
	requested_by: idSchema("usr"),
	acknowledged_outcome: VerificationOutcomeSchema.nullable(),
	acknowledged_risks: z.boolean(),
	params: z.record(z.string(), z.unknown()),
	result: ActionResultSchema.nullable(),
	error_code: z.string().nullable(),
	created_at: z.string(),
	finished_at: z.string().nullable(),
});

/** Where actions will land: shown before the user authorizes anything. */
export const ActionTargetSchema = z.object({
	repository_id: idSchema("repo"),
	repository_name: z.string(),
	local: z.boolean(),
	/** The registered local path; null when the repository is not a local path. */
	path: z.string().nullable(),
	base_commit: z.string(),
	suggested_branch: z.string(),
});

export type ActionKind = z.infer<typeof ActionKindSchema>;
export type ActionStatus = z.infer<typeof ActionStatusSchema>;
export type ActionRequest = z.infer<typeof ActionRequestSchema>;
export type ActionResult = z.infer<typeof ActionResultSchema>;
export type AuthorizedAction = z.infer<typeof AuthorizedActionSchema>;
export type ActionTarget = z.infer<typeof ActionTargetSchema>;
