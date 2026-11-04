import { z } from "zod";
import { idSchema, RefNameSchema } from "./common.ts";
import { CreateRepositoryRequestSchema } from "./repositories.ts";

// ---- GitHub App connection and repository synchronization ----

/** GitHub's numeric IDs (installations, repositories) as payloads and URLs carry them. */
export const GitHubNumericIdSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER);
const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
/** `owner/name`, as GitHub allows them (also used to build fixed-host URLs, so nothing else passes). */
export const GitHubFullNameSchema = z
	.string()
	.regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/);
const TimestampSchema = z.iso.datetime();
const CountSchema = z.number().int().nonnegative();
const ErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
	retryable: z.boolean().optional(),
});

/** Least privilege: the permissions Tracera needs, and the only ones its installation tokens carry. */
export const GITHUB_TOKEN_PERMISSIONS = {
	contents: "read",
	metadata: "read",
} as const;
/** Read access to pull requests is optional: without it, pull-request events are not delivered. */
export const GITHUB_OPTIONAL_PERMISSIONS = { pull_requests: "read" } as const;
/** Events the GitHub App subscribes to; `installation*` events are always delivered to apps. */
export const GITHUB_EVENTS = ["push", "pull_request", "repository"] as const;

export const GitHubInstallationIdSchema = idSchema("ghi");
export const RepositoryUpdateIdSchema = idSchema("rup");
export const WebhookDeliveryIdSchema = idSchema("whd");

// ---- Webhook payloads: only the fields Tracera reads. Parsing drops everything else (commit
// messages, author names and emails, user profiles), so none of it is ever stored. ----

const InstallationRefSchema = z.object({ id: GitHubNumericIdSchema });
const RepositoryRefSchema = z.object({
	id: GitHubNumericIdSchema,
	full_name: GitHubFullNameSchema,
	default_branch: z.string().max(255).optional(),
});
const PermissionsSchema = z.record(z.string().max(100), z.string().max(20));

export const PushEventSchema = z.object({
	ref: z.string().max(300),
	/** All zeros when the push created (`before`) or deleted (`after`) the ref. */
	before: ShaSchema,
	after: ShaSchema,
	deleted: z.boolean().optional(),
	repository: RepositoryRefSchema,
	installation: InstallationRefSchema.optional(),
});

export const PullRequestEventSchema = z.object({
	action: z.string().max(50),
	number: GitHubNumericIdSchema,
	pull_request: z.object({
		head: z.object({ sha: ShaSchema }),
		base: z.object({ ref: z.string().max(255) }),
	}),
	repository: RepositoryRefSchema,
	installation: InstallationRefSchema.optional(),
});

export const GitHubInstallationObjectSchema = z.object({
	id: GitHubNumericIdSchema,
	account: z
		.object({ login: z.string().max(100), type: z.string().max(40) })
		.nullable(),
	repository_selection: z.enum(["all", "selected"]),
	permissions: PermissionsSchema,
	events: z.array(z.string().max(100)).max(300),
	suspended_at: z.string().nullable().optional(),
});

export const InstallationEventSchema = z.object({
	action: z.string().max(50),
	installation: GitHubInstallationObjectSchema,
});

const RepositoryListEntrySchema = z.object({ id: GitHubNumericIdSchema });
export const InstallationRepositoriesEventSchema = z.object({
	action: z.string().max(50),
	installation: InstallationRefSchema,
	repository_selection: z.enum(["all", "selected"]),
	repositories_added: z.array(RepositoryListEntrySchema).max(10_000),
	repositories_removed: z.array(RepositoryListEntrySchema).max(10_000),
});

export const RepositoryEventSchema = z.object({
	action: z.string().max(50),
	changes: z
		.object({
			default_branch: z.object({ from: z.string().max(255) }).optional(),
		})
		.optional(),
	repository: RepositoryRefSchema,
	installation: InstallationRefSchema.optional(),
});

// ---- Requests ----

/** The callback GitHub redirects the browser to after installing (or configuring) the app. */
export const GitHubCallbackQuerySchema = z.object({
	installation_id: z.coerce
		.number()
		.int()
		.positive()
		.max(Number.MAX_SAFE_INTEGER),
	setup_action: z.enum(["install", "update", "request"]).optional(),
	code: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,200}$/)
		.optional(),
	state: z.string().max(1000).optional(),
});

/** Connects one repository the installation can access (explicit selection). */
export const ConnectGitHubRepositoryRequestSchema = z.strictObject({
	github_repository_id: GitHubNumericIdSchema,
	/** Defaults to the GitHub repository's name. */
	name: CreateRepositoryRequestSchema.shape.name.optional(),
	/** Defaults to the GitHub repository's default branch. */
	default_branch: RefNameSchema.optional(),
	commands: CreateRepositoryRequestSchema.shape.commands,
	app: CreateRepositoryRequestSchema.shape.app,
});

// ---- Responses ----

export const GitHubInstallationStatusSchema = z.enum([
	"active",
	"suspended",
	"removed",
]);

export const GitHubInstallationSchema = z.object({
	id: GitHubInstallationIdSchema,
	installation_id: GitHubNumericIdSchema,
	account_login: z.string(),
	account_type: z.string(),
	repository_selection: z.enum(["all", "selected"]),
	permissions: z.record(z.string(), z.string()),
	events: z.array(z.string()),
	status: GitHubInstallationStatusSchema,
	/** Missing required permissions: repositories cannot be connected or synchronized until fixed. */
	permission_problems: z.array(z.string()),
	/** Permissions beyond Tracera's needs; tokens are still minted read-only. */
	permission_warnings: z.array(z.string()),
	created_at: TimestampSchema,
	updated_at: TimestampSchema,
});

export const GitHubStatusSchema = z.object({
	configured: z.boolean(),
	/** Names of unset variables (never values). */
	missing: z.array(z.string()),
	webhook_path: z.string(),
	callback_path: z.string(),
	required_permissions: z.record(z.string(), z.string()),
	events: z.array(z.string()),
	/** The registered app as GitHub reports it, with configuration problems; null when unavailable. */
	app: z
		.object({
			slug: z.string(),
			name: z.string(),
			permissions: z.record(z.string(), z.string()),
			events: z.array(z.string()),
			problems: z.array(z.string()),
			warnings: z.array(z.string()),
		})
		.nullable(),
	app_error: ErrorSchema.nullable(),
	installations: z.array(GitHubInstallationSchema),
});

export const GitHubRepositoryCandidateSchema = z.object({
	github_repository_id: GitHubNumericIdSchema,
	full_name: GitHubFullNameSchema,
	private: z.boolean(),
	default_branch: z.string().nullable(),
	archived: z.boolean(),
	/** The Tracera repository already connected to it in this workspace, if any. */
	connected_repository_id: idSchema("repo").nullable(),
});

export const RepositoryUpdateStatusSchema = z.enum([
	"pending",
	"syncing",
	"indexing",
	"indexed",
	"failed",
	"superseded",
]);
export const RepositoryUpdateTriggerSchema = z.enum([
	"connect",
	"push",
	"pull_request",
	"reconcile",
	"manual",
	"default_branch",
]);
export const WebhookDeliveryStatusSchema = z.enum([
	"received",
	"processed",
	"ignored",
	"failed",
]);

/** One request to bring a ref up to date: what triggered it, what was indexed, and how it ended. */
export const RepositoryUpdateSchema = z.object({
	id: RepositoryUpdateIdSchema,
	repository_id: idSchema("repo"),
	trigger: RepositoryUpdateTriggerSchema,
	ref: z.string(),
	/** The commit the trigger reported (a webhook's `after`, a reconciliation head); null = the ref's head. */
	target_sha: ShaSchema.nullable(),
	/** The commit actually indexed or analysed: the ref's head when the update ran. */
	indexed_sha: ShaSchema.nullable(),
	status: RepositoryUpdateStatusSchema,
	snapshot_id: idSchema("snap").nullable(),
	patch_analysis_id: idSchema("pia").nullable(),
	pull_request: z
		.object({ number: z.number().int(), base_ref: z.string() })
		.nullable(),
	delivery_id: WebhookDeliveryIdSchema.nullable(),
	attempts: CountSchema,
	/** Later triggers for the same ref merged into this update while it was pending. */
	coalesced: CountSchema,
	error: ErrorSchema.nullable(),
	created_at: TimestampSchema,
	started_at: TimestampSchema.nullable(),
	finished_at: TimestampSchema.nullable(),
});

export const WebhookDeliverySchema = z.object({
	id: WebhookDeliveryIdSchema,
	/** GitHub's `X-GitHub-Delivery` GUID. */
	delivery_guid: z.string(),
	event: z.string(),
	action: z.string().nullable(),
	status: WebhookDeliveryStatusSchema,
	/** Why an authenticated delivery was ignored (for example `ref_not_tracked`). */
	reason: z.string().nullable(),
	error: ErrorSchema.nullable(),
	attempts: CountSchema,
	next_attempt_at: TimestampSchema.nullable(),
	received_at: TimestampSchema,
	processed_at: TimestampSchema.nullable(),
});

/** The compact synchronization state carried by every repository view (`repository.sync`). */
export const RepositorySyncSummarySchema = z.object({
	/** Updates waiting, fetching, or indexing. */
	pending: CountSchema,
	/** Updates that failed and were not yet superseded by a newer indexed commit. */
	failed: CountSchema,
	/** Authenticated webhook deliveries for this repository whose processing failed. */
	failed_deliveries: CountSchema,
	/** The newest commit a webhook or reconciliation reported for the tracked ref (null if none). */
	latest_known_commit: ShaSchema.nullable(),
	last_failure: z
		.object({
			update_id: RepositoryUpdateIdSchema,
			code: z.string(),
			message: z.string(),
			at: TimestampSchema,
		})
		.nullable(),
});

/** GET /repositories/{id}/sync: freshness plus the pending, failed, and recent updates and deliveries. */
export const RepositorySyncStatusSchema = z.object({
	repository_id: idSchema("repo"),
	source: z.enum(["local", "github"]),
	tracked_ref: z.string(),
	freshness: z
		.object({
			stale: z.boolean().nullable(),
			ref: z.string(),
			indexed_commit: ShaSchema,
			current_commit: ShaSchema.nullable(),
			reasons: z.array(z.string()),
			checked_at: TimestampSchema,
		})
		.nullable(),
	latest_indexed: z
		.object({
			snapshot_id: idSchema("snap"),
			commit_sha: ShaSchema,
			status: z.string(),
			finished_at: TimestampSchema.nullable(),
		})
		.nullable(),
	/** When the graph last reached a commit successfully (the newest usable snapshot). */
	last_synced_at: TimestampSchema.nullable(),
	summary: RepositorySyncSummarySchema,
	pending: z.array(RepositoryUpdateSchema),
	failed: z.array(RepositoryUpdateSchema),
	recent: z.array(RepositoryUpdateSchema),
	deliveries: z.object({
		failed: z.array(WebhookDeliverySchema),
		recent: z.array(WebhookDeliverySchema),
	}),
	github: z
		.object({
			installation: GitHubInstallationIdSchema,
			full_name: GitHubFullNameSchema,
			private: z.boolean(),
			access: z.enum([
				"active",
				"repository_removed",
				"installation_suspended",
				"installation_removed",
			]),
		})
		.nullable(),
	reconciliation: z.object({ interval_seconds: z.number().int() }),
});

export type ConnectGitHubRepositoryRequest = z.infer<
	typeof ConnectGitHubRepositoryRequestSchema
>;
export type GitHubCallbackQuery = z.infer<typeof GitHubCallbackQuerySchema>;
export type GitHubInstallationObject = z.infer<
	typeof GitHubInstallationObjectSchema
>;
export type RepositoryUpdateStatus = z.infer<
	typeof RepositoryUpdateStatusSchema
>;
export type RepositoryUpdateTrigger = z.infer<
	typeof RepositoryUpdateTriggerSchema
>;
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;
export type RepositoryUpdate = z.infer<typeof RepositoryUpdateSchema>;
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;
export type RepositorySyncSummary = z.infer<typeof RepositorySyncSummarySchema>;
export type RepositorySyncStatus = z.infer<typeof RepositorySyncStatusSchema>;
