import {
	type ConnectGitHubRepositoryRequest,
	CreateRepositoryRequestSchema,
	GITHUB_EVENTS,
	GITHUB_TOKEN_PERMISSIONS,
	type GitHubCallbackQuery,
	InstallationEventSchema,
	InstallationRepositoriesEventSchema,
	PullRequestEventSchema,
	PushEventSchema,
	RefNameSchema,
	RepositoryEventSchema,
} from "@tracera/contracts";
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	sql,
} from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import type { z } from "zod";
import type { Config } from "../config.ts";
import {
	type Db,
	pgErrorCode,
	type QueueDb,
	withTransaction,
} from "../db/client.ts";
import {
	type ErrorInfo,
	githubInstallations,
	githubRepositories,
	repositories,
	webhookDeliveries,
} from "../db/schema.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { redactSecrets } from "../lib/redact.ts";
import { type Actor, audit } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import {
	defaultGitHubClient,
	evaluatePermissions,
	exchangeUserCode,
	GITHUB_WEB,
	type GitHubClient,
	type GitHubConfig,
	GitHubError,
	getApp,
	getInstallation,
	installationToken,
	listAccessibleRepositories,
	repositoryAccess,
	revokeUserToken,
	signInstallState,
	userCanAccessInstallation,
	verifyInstallState,
	verifyWebhookSignature,
} from "./github-app.ts";
import { getRepository } from "./repositories.ts";
import { requestSync } from "./sync.ts";
import { toUpdateView } from "./sync-status.ts";

// GitHub App connection and webhooks. Connecting: Tracera sends the owner to
// GitHub with a signed state; GitHub returns to the callback with an installation ID and an OAuth code;
// Tracera verifies the state belongs to the same signed-in owner, verifies with the code that the
// GitHub user can access that installation, checks its permissions, and binds it to the workspace.
// Repositories are then connected one by one (explicit selection). Webhooks are verified against the
// raw body, deduplicated by delivery GUID, recorded as a content-free summary, and processed
// idempotently; failures keep their retry state.

export const WEBHOOK_PATH = "/api/v1/webhooks/github";
export const CALLBACK_PATH = "/api/v1/github/callback";
/** GitHub caps payloads at 25 MB; bigger ones are rare, refused with 413, and caught up by reconciliation. */
export const WEBHOOK_MAX_BYTES = 5 * 1024 * 1024;
const WEBHOOK_ACTOR: Actor = { type: "system", id: "github_webhook" };
const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_RETRY_MS = [60_000, 5 * 60_000, 25 * 60_000, 2 * 3_600_000];
const DELIVERY_RETENTION_MS = 30 * 24 * 3_600_000;
const EVENT = /^[a-z_]{1,50}$/;
const GUID = /^[A-Za-z0-9-]{1,100}$/;
const PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export type GitHubDeps = {
	db: Db;
	pool: pg.Pool;
	boss: PgBoss;
	config: Config;
	github?: GitHubClient;
	log?: (message: string, fields: Record<string, unknown>) => void;
};

const clientOf = (deps: { github?: GitHubClient }) =>
	deps.github ?? defaultGitHubClient();

/** Every GitHub endpoint needs the App; without it they answer `capability_unavailable`. */
export function requireGitHub(config: Config): GitHubConfig {
	if (!config.github)
		throw new AppError(
			409,
			"capability_unavailable",
			`The GitHub App is not configured (unset: ${config.githubMissing.join(", ")})`,
		);
	return config.github;
}

const UNPROCESSABLE = new Set([
	"github_permission_missing",
	"github_repository_not_accessible",
	"github_installation_not_found",
	"github_not_found",
	"github_authorization_failed",
]);

/** GitHub failures as problems: 503 when GitHub is unreachable or limiting, 502 when it misbehaves. */
function viaGitHub<T>(promise: Promise<T>): Promise<T> {
	return promise.catch((error: unknown) => {
		if (!(error instanceof GitHubError)) throw error;
		throw new AppError(
			error.retryable ? 503 : UNPROCESSABLE.has(error.code) ? 422 : 502,
			error.code,
			error.message,
		);
	});
}

// ---- Installations -------------------------------------------------------------------------------

type InstallationRow = typeof githubInstallations.$inferSelect;

function toInstallationView(row: InstallationRow) {
	const { problems, warnings } = evaluatePermissions(row.permissions);
	return {
		id: row.id,
		installation_id: row.installationId,
		account_login: row.accountLogin,
		account_type: row.accountType,
		repository_selection: row.repositorySelection,
		permissions: row.permissions,
		events: row.events,
		status: row.status,
		permission_problems: problems,
		permission_warnings: warnings,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

async function installationRow(
	db: Db,
	workspaceId: string,
	id: string,
): Promise<InstallationRow> {
	const [row] = await db
		.select()
		.from(githubInstallations)
		.where(
			and(
				eq(githubInstallations.id, id),
				eq(githubInstallations.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(
			404,
			"not_found",
			`GitHub installation ${id} was not found`,
		);
	return row;
}

/** Permission validation before anything is listed, connected, or indexed. */
function assertUsable(row: InstallationRow): void {
	if (row.status !== "active")
		throw new AppError(
			409,
			"github_installation_inactive",
			`The GitHub App installation is ${row.status}`,
		);
	const { problems } = evaluatePermissions(row.permissions);
	if (problems.length > 0)
		throw new AppError(
			422,
			"github_permission_missing",
			`The installation lacks required permissions (${problems.join(", ")}); grant them on GitHub, then connect again`,
		);
}

export async function listInstallations(db: Db, workspaceId: string) {
	const rows = await db
		.select()
		.from(githubInstallations)
		.where(eq(githubInstallations.workspaceId, workspaceId))
		.orderBy(desc(githubInstallations.createdAt));
	return rows.map(toInstallationView);
}

/** Whether the App is configured, how GitHub reports it (least-privilege check), and the installations. */
export async function githubStatus(deps: GitHubDeps, workspaceId: string) {
	const gh = deps.config.github;
	let app = null;
	let appError: ErrorInfo | null = null;
	if (gh) {
		try {
			const registered = await getApp(clientOf(deps), gh);
			const { problems, warnings } = evaluatePermissions(
				registered.permissions,
			);
			const missing = GITHUB_EVENTS.filter(
				(event) => !registered.events.includes(event),
			);
			app = {
				slug: registered.slug,
				name: registered.name,
				permissions: registered.permissions,
				events: registered.events,
				problems: [
					...problems,
					...missing
						.filter((event) => event === "push")
						.map((event) => `event_not_subscribed:${event}`),
				],
				warnings: [
					...warnings,
					...missing
						.filter((event) => event !== "push")
						.map((event) => `event_not_subscribed:${event}`),
				],
			};
		} catch (error) {
			appError =
				error instanceof GitHubError
					? {
							code: error.code,
							message: error.message,
							retryable: error.retryable,
						}
					: {
							code: "github_unavailable",
							message: "GitHub could not be reached",
							retryable: true,
						};
		}
	}
	return {
		configured: gh !== null,
		missing: deps.config.githubMissing,
		webhook_path: WEBHOOK_PATH,
		callback_path: CALLBACK_PATH,
		required_permissions: { ...GITHUB_TOKEN_PERMISSIONS },
		events: [...GITHUB_EVENTS],
		app,
		app_error: appError,
		installations: await listInstallations(deps.db, workspaceId),
	};
}

/** The GitHub URL that installs (or configures) the App, carrying a state bound to this owner. */
export async function installUrl(deps: GitHubDeps, ctx: AuthContext) {
	const gh = requireGitHub(deps.config);
	const client = clientOf(deps);
	const app = await viaGitHub(getApp(client, gh));
	const state = signInstallState(
		gh,
		{ workspaceId: ctx.workspaceId, userId: ctx.userId },
		client.now(),
	);
	return {
		url: `${GITHUB_WEB}/apps/${app.slug}/installations/new?state=${encodeURIComponent(state)}`,
		expires_in_seconds: 600,
	};
}

/**
 * The install callback. GitHub's `installation_id` can be forged by anyone who crafts this URL, so it
 * is trusted only after (1) the state proves this same owner started the flow in this workspace and
 * (2) the OAuth code shows the GitHub user can access that installation. The user token is used for
 * that one check and revoked; nothing but the installation record is stored.
 */
export async function completeInstallation(
	deps: GitHubDeps,
	ctx: AuthContext,
	query: GitHubCallbackQuery,
	requestId: string,
) {
	const gh = requireGitHub(deps.config);
	const client = clientOf(deps);
	const binding = query.state
		? verifyInstallState(gh, query.state, client.now())
		: null;
	if (
		!binding ||
		binding.workspaceId !== ctx.workspaceId ||
		binding.userId !== ctx.userId
	)
		throw new AppError(
			403,
			"github_state_invalid",
			"Start the GitHub connection from Tracera again: the request was missing, expired, or started by someone else",
		);
	if (!query.code)
		throw new AppError(
			422,
			"github_authorization_required",
			"The GitHub App must request user authorization during installation, so Tracera can verify your access",
		);
	const userToken = await viaGitHub(exchangeUserCode(client, gh, query.code));
	let accessible = false;
	try {
		accessible = await viaGitHub(
			userCanAccessInstallation(client, gh, userToken, query.installation_id),
		);
	} finally {
		await revokeUserToken(client, gh, userToken);
	}
	if (!accessible)
		throw new AppError(
			403,
			"github_installation_not_accessible",
			"Your GitHub account cannot access that installation",
		);
	const installation = await viaGitHub(
		getInstallation(client, gh, query.installation_id),
	);
	const now = new Date();
	const values = {
		accountLogin: installation.account?.login ?? "unknown",
		accountType: installation.account?.type ?? "unknown",
		repositorySelection: installation.repository_selection,
		permissions: installation.permissions,
		events: installation.events,
		status: installation.suspended_at
			? ("suspended" as const)
			: ("active" as const),
		suspendedAt: installation.suspended_at
			? new Date(installation.suspended_at)
			: null,
		removedAt: null,
		updatedAt: now,
	};
	const row = await withTransaction(deps.pool, async ({ db }) => {
		const [existing] = await db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.installationId, installation.id))
			.for("update")
			.limit(1);
		if (existing && existing.workspaceId !== ctx.workspaceId)
			throw new AppError(
				409,
				"conflict",
				"This GitHub installation is connected to another Tracera workspace",
			);
		const [saved] = existing
			? await db
					.update(githubInstallations)
					.set(values)
					.where(eq(githubInstallations.id, existing.id))
					.returning()
			: await db
					.insert(githubInstallations)
					.values({
						id: newId("ghi"),
						workspaceId: ctx.workspaceId,
						installationId: installation.id,
						createdBy: ctx.userId,
						...values,
					})
					.returning();
		if (!saved) throw new Error("installation vanished while saving");
		await audit(db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "github.installation_connected",
			targetType: "github_installation",
			targetId: saved.id,
			metadata: {
				installation_id: installation.id,
				account_login: values.accountLogin,
				repository_selection: values.repositorySelection,
				setup_action: query.setup_action ?? null,
				permission_problems: evaluatePermissions(values.permissions).problems,
			},
			requestId,
		});
		return saved;
	}).catch((error: unknown) => {
		if (pgErrorCode(error) === "23505")
			throw new AppError(
				409,
				"conflict",
				"This GitHub installation was connected concurrently; reload and try again",
			);
		throw error;
	});
	return toInstallationView(row);
}

/** The repositories the installation grants access to, and which are connected already. */
export async function listInstallationRepositories(
	deps: GitHubDeps,
	ctx: AuthContext,
	id: string,
) {
	// The workspace check comes first: a foreign or unknown installation is a 404 whatever the configuration.
	const row = await installationRow(deps.db, ctx.workspaceId, id);
	const gh = requireGitHub(deps.config);
	assertUsable(row);
	const client = clientOf(deps);
	const token = await viaGitHub(
		installationToken(client, gh, { installationId: row.installationId }),
	);
	const { repositories: visible, truncated } = await viaGitHub(
		listAccessibleRepositories(client, gh, token),
	);
	const links = await deps.db
		.select({
			githubRepositoryId: githubRepositories.githubRepositoryId,
			repositoryId: githubRepositories.repositoryId,
		})
		.from(githubRepositories)
		.where(eq(githubRepositories.installationId, row.id));
	const connected = new Map(
		links.map((link) => [link.githubRepositoryId, link.repositoryId]),
	);
	return {
		repositories: visible.map((repo) => ({
			github_repository_id: repo.id,
			full_name: repo.full_name,
			private: repo.private,
			default_branch: repo.default_branch ?? null,
			archived: repo.archived ?? false,
			connected_repository_id: connected.get(repo.id) ?? null,
		})),
		truncated,
	};
}

/**
 * Connects one repository the installation grants access to (explicit selection). GitHub itself
 * checks the selection: a token for exactly this repository is minted only if the installation can
 * access it. The repository is registered with `source_type = git_url`, and its first sync (fetch,
 * then indexing) is queued at once.
 */
export async function connectRepository(
	deps: GitHubDeps,
	ctx: AuthContext,
	id: string,
	input: ConnectGitHubRepositoryRequest,
	requestId: string,
) {
	// The workspace check comes first: a foreign or unknown installation is a 404 whatever the configuration.
	const row = await installationRow(deps.db, ctx.workspaceId, id);
	const gh = requireGitHub(deps.config);
	assertUsable(row);
	const { repository: target } = await viaGitHub(
		repositoryAccess(clientOf(deps), gh, {
			installationId: row.installationId,
			repositoryId: input.github_repository_id,
		}),
	);
	const name = CreateRepositoryRequestSchema.shape.name.safeParse(
		input.name ?? target.full_name.split("/")[1] ?? "",
	);
	if (!name.success)
		throw new AppError(422, "validation_failed", "Choose a repository name", {
			errors: [
				{ path: "name", message: "Use letters, digits, dot, dash, underscore" },
			],
		});
	const branch = RefNameSchema.safeParse(
		input.default_branch ?? target.default_branch ?? "",
	);
	if (!branch.success)
		throw new AppError(
			422,
			"validation_failed",
			"The repository's default branch name is not supported; pass default_branch",
			{
				errors: [
					{ path: "default_branch", message: "Not a supported branch name" },
				],
			},
		);
	const repositoryId = newId("repo");
	const update = await withTransaction(deps.pool, async (tx) => {
		await tx.db.insert(repositories).values({
			id: repositoryId,
			workspaceId: ctx.workspaceId,
			name: name.data,
			sourceType: "git_url",
			sourceRef: `${GITHUB_WEB}/${target.full_name}`,
			defaultBranch: branch.data,
			synthetic: false,
			commands: input.commands,
			app: input.app ?? null,
			allowInstallScripts: false,
			createdBy: ctx.userId,
		});
		await tx.db.insert(githubRepositories).values({
			repositoryId,
			workspaceId: ctx.workspaceId,
			installationId: row.id,
			githubRepositoryId: target.id,
			fullName: target.full_name,
			private: target.private,
			createdBy: ctx.userId,
		});
		await audit(tx.db, {
			workspaceId: ctx.workspaceId,
			actor: actorOf(ctx),
			action: "repository.registered",
			targetType: "repository",
			targetId: repositoryId,
			metadata: {
				source_type: "git_url",
				provider: "github",
				installation: row.id,
				github_repository_id: target.id,
				private: target.private,
				allow_install_scripts: false,
			},
			requestId,
		});
		const { update } = await requestSync(
			deps,
			tx,
			{
				workspaceId: ctx.workspaceId,
				repositoryId,
				ref: branch.data,
				trigger: "connect",
				requestedBy: ctx.userId,
				actor: actorOf(ctx),
			},
			requestId,
		);
		return update;
	}).catch((error: unknown) => {
		if (pgErrorCode(error) === "23505")
			throw new AppError(
				409,
				"conflict",
				"A repository with that name, or this GitHub repository, is already connected in this workspace",
			);
		throw error;
	});
	return {
		repository: await getRepository(deps.db, ctx.workspaceId, repositoryId),
		update: toUpdateView(update),
	};
}

// ---- Webhooks ------------------------------------------------------------------------------------

type RepositoryRef = { id: number; full_name: string };

/**
 * What is kept of a delivery: only the fields processing needs. Commit messages, author names and
 * emails, and user profiles are never stored.
 */
export type DeliverySummary =
	| {
			kind: "push";
			installation_id: number | null;
			action: null;
			repository: RepositoryRef;
			ref: string;
			after: string;
			deleted: boolean;
	  }
	| {
			kind: "pull_request";
			installation_id: number | null;
			action: string;
			repository: RepositoryRef;
			number: number;
			head_sha: string;
			base_ref: string;
	  }
	| {
			kind: "repository";
			installation_id: number | null;
			action: string;
			repository: RepositoryRef;
			default_branch: string | null;
			default_branch_from: string | null;
	  }
	| {
			kind: "installation";
			installation_id: number;
			action: string;
			account_login: string;
			account_type: string;
			repository_selection: "all" | "selected";
			permissions: Record<string, string>;
			events: string[];
	  }
	| {
			kind: "installation_repositories";
			installation_id: number;
			action: string;
			repository_selection: "all" | "selected";
			added: number[];
			removed: number[];
	  }
	| { kind: "other"; installation_id: number | null; action: string | null }
	| {
			kind: "invalid";
			installation_id: number | null;
			action: string | null;
			issues: string[];
	  };

/** Parses a verified body into its summary; a payload that does not match becomes `invalid`. */
export function summarizeDelivery(
	event: string,
	body: Buffer,
): DeliverySummary {
	let payload: unknown;
	try {
		payload = JSON.parse(body.toString("utf8"));
	} catch {
		return {
			kind: "invalid",
			installation_id: null,
			action: null,
			issues: ["The body is not JSON"],
		};
	}
	const loose = payload as {
		action?: unknown;
		installation?: { id?: unknown };
	} | null;
	const installationId =
		typeof loose?.installation?.id === "number" &&
		Number.isSafeInteger(loose.installation.id) &&
		loose.installation.id > 0
			? loose.installation.id
			: null;
	const action =
		typeof loose?.action === "string" ? loose.action.slice(0, 50) : null;
	// Paths and issue codes only: values from the payload never enter the record.
	const invalid = (error: z.ZodError): DeliverySummary => ({
		kind: "invalid",
		installation_id: installationId,
		action,
		issues: error.issues
			.slice(0, 10)
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`),
	});
	switch (event) {
		case "push": {
			const parsed = PushEventSchema.safeParse(payload);
			if (!parsed.success) return invalid(parsed.error);
			const push = parsed.data;
			return {
				kind: "push",
				installation_id: push.installation?.id ?? null,
				action: null,
				repository: {
					id: push.repository.id,
					full_name: push.repository.full_name,
				},
				ref: push.ref,
				after: push.after,
				deleted: push.deleted === true || /^0{40}$/.test(push.after),
			};
		}
		case "pull_request": {
			const parsed = PullRequestEventSchema.safeParse(payload);
			if (!parsed.success) return invalid(parsed.error);
			const pr = parsed.data;
			return {
				kind: "pull_request",
				installation_id: pr.installation?.id ?? null,
				action: pr.action,
				repository: {
					id: pr.repository.id,
					full_name: pr.repository.full_name,
				},
				number: pr.number,
				head_sha: pr.pull_request.head.sha,
				base_ref: pr.pull_request.base.ref,
			};
		}
		case "repository": {
			const parsed = RepositoryEventSchema.safeParse(payload);
			if (!parsed.success) return invalid(parsed.error);
			const repo = parsed.data;
			return {
				kind: "repository",
				installation_id: repo.installation?.id ?? null,
				action: repo.action,
				repository: {
					id: repo.repository.id,
					full_name: repo.repository.full_name,
				},
				default_branch: repo.repository.default_branch ?? null,
				default_branch_from: repo.changes?.default_branch?.from ?? null,
			};
		}
		case "installation": {
			const parsed = InstallationEventSchema.safeParse(payload);
			if (!parsed.success) return invalid(parsed.error);
			const { installation } = parsed.data;
			return {
				kind: "installation",
				installation_id: installation.id,
				action: parsed.data.action,
				account_login: installation.account?.login ?? "unknown",
				account_type: installation.account?.type ?? "unknown",
				repository_selection: installation.repository_selection,
				permissions: installation.permissions,
				events: installation.events,
			};
		}
		case "installation_repositories": {
			const parsed = InstallationRepositoriesEventSchema.safeParse(payload);
			if (!parsed.success) return invalid(parsed.error);
			return {
				kind: "installation_repositories",
				installation_id: parsed.data.installation.id,
				action: parsed.data.action,
				repository_selection: parsed.data.repository_selection,
				added: parsed.data.repositories_added.map((repo) => repo.id),
				removed: parsed.data.repositories_removed.map((repo) => repo.id),
			};
		}
		default:
			return { kind: "other", installation_id: installationId, action };
	}
}

/**
 * `POST /api/v1/webhooks/github`. Order: headers, then the HMAC over the exact body bytes (nothing is
 * parsed or stored before it verifies), then deduplication by GUID (a known delivery is processed
 * again only if its processing failed), then processing.
 */
export async function receiveWebhook(
	deps: GitHubDeps,
	input: {
		event: string | undefined;
		guid: string | undefined;
		signature: string | undefined;
		body: Buffer;
	},
): Promise<{
	status: 200 | 202;
	body: { delivery_id: string | null; status: string; reason: string | null };
}> {
	// Without the App there is no secret to verify against; the public endpoint then behaves as if it
	// did not exist and says nothing about the configuration.
	const gh = deps.config.github;
	if (!gh) throw new AppError(404, "not_found", "Not found");
	if (
		!input.event ||
		!EVENT.test(input.event) ||
		!input.guid ||
		!GUID.test(input.guid)
	)
		throw new AppError(
			400,
			"validation_failed",
			"The X-GitHub-Event and X-GitHub-Delivery headers are required",
		);
	if (!verifyWebhookSignature(gh.webhookSecret, input.body, input.signature))
		throw new AppError(
			401,
			"webhook_signature_invalid",
			"The X-Hub-Signature-256 signature does not match this delivery",
		);
	const summary = summarizeDelivery(input.event, input.body);
	const [inserted] = await deps.db
		.insert(webhookDeliveries)
		.values({
			id: newId("whd"),
			deliveryGuid: input.guid,
			event: input.event,
			action: summary.action,
			installationId: summary.installation_id,
			status: "received",
			summary,
		})
		.onConflictDoNothing()
		.returning({ id: webhookDeliveries.id });
	let deliveryId = inserted?.id;
	if (!deliveryId) {
		const [retry] = await deps.db
			.update(webhookDeliveries)
			.set({
				status: "received",
				attempts: sql`${webhookDeliveries.attempts} + 1`,
				nextAttemptAt: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(webhookDeliveries.deliveryGuid, input.guid),
					eq(webhookDeliveries.status, "failed"),
				),
			)
			.returning({ id: webhookDeliveries.id });
		if (!retry) {
			const [known] = await deps.db
				.select({ id: webhookDeliveries.id })
				.from(webhookDeliveries)
				.where(eq(webhookDeliveries.deliveryGuid, input.guid))
				.limit(1);
			return {
				status: 200,
				body: {
					delivery_id: known?.id ?? null,
					status: "duplicate",
					reason: null,
				},
			};
		}
		deliveryId = retry.id;
	}
	const outcome = await processDelivery(deps, deliveryId);
	if (outcome.status === "failed")
		throw new AppError(
			outcome.error?.retryable ? 500 : 400,
			outcome.error?.code ?? "webhook_processing_failed",
			outcome.error?.message ?? "The delivery could not be processed",
			{ extra: { delivery_id: deliveryId } },
		);
	return {
		status: 202,
		body: {
			delivery_id: deliveryId,
			status: outcome.status,
			reason: outcome.reason,
		},
	};
}

type Scope = { workspaceId: string | null; repositoryId: string | null };
type Outcome = Scope & {
	status: "processed" | "ignored";
	reason: string | null;
	details: Record<string, unknown>;
};
type Tx = { db: Db; queueDb: QueueDb };

const ignored = (reason: string, scope: Scope): Outcome => ({
	...scope,
	status: "ignored",
	reason,
	details: {},
});
const processed = (
	scope: Scope,
	details: Record<string, unknown>,
): Outcome => ({
	...scope,
	status: "processed",
	reason: null,
	details,
});

class InvalidDelivery extends Error {}

async function installationByGitHubId(db: Db, installationId: number | null) {
	if (installationId === null) return null;
	const [row] = await db
		.select()
		.from(githubInstallations)
		.where(eq(githubInstallations.installationId, installationId))
		.limit(1);
	return row ?? null;
}

type Target = {
	repository: typeof repositories.$inferSelect;
	link: typeof githubRepositories.$inferSelect;
	installation: InstallationRow;
};

/**
 * The connected repository a repository event concerns, scoped by installation: an event can only
 * reach the workspace that connected the installation it came from.
 */
async function targetOf(
	db: Db,
	summary: { installation_id: number | null; repository: RepositoryRef },
): Promise<
	{ ignore: Outcome } | { ignore: null; target: Target; scope: Scope }
> {
	if (summary.installation_id === null)
		return {
			ignore: ignored("installation_missing", {
				workspaceId: null,
				repositoryId: null,
			}),
		};
	const [target] = await db
		.select({
			repository: repositories,
			link: githubRepositories,
			installation: githubInstallations,
		})
		.from(githubRepositories)
		.innerJoin(
			githubInstallations,
			eq(githubInstallations.id, githubRepositories.installationId),
		)
		.innerJoin(
			repositories,
			eq(repositories.id, githubRepositories.repositoryId),
		)
		.where(
			and(
				eq(githubInstallations.installationId, summary.installation_id),
				eq(githubRepositories.githubRepositoryId, summary.repository.id),
			),
		)
		.limit(1);
	if (!target) {
		const owner = await installationByGitHubId(db, summary.installation_id);
		return {
			ignore: ignored(
				owner ? "repository_not_connected" : "installation_not_connected",
				{ workspaceId: owner?.workspaceId ?? null, repositoryId: null },
			),
		};
	}
	const scope = {
		workspaceId: target.repository.workspaceId,
		repositoryId: target.repository.id,
	};
	// Signed events carry the repository's current name: follow renames, since fetches do not follow
	// redirects.
	if (target.link.fullName !== summary.repository.full_name) {
		const now = new Date();
		await db
			.update(githubRepositories)
			.set({ fullName: summary.repository.full_name, updatedAt: now })
			.where(eq(githubRepositories.repositoryId, target.repository.id));
		await db
			.update(repositories)
			.set({
				sourceRef: `${GITHUB_WEB}/${summary.repository.full_name}`,
				updatedAt: now,
			})
			.where(eq(repositories.id, target.repository.id));
		target.link.fullName = summary.repository.full_name;
	}
	if (target.installation.status !== "active")
		return {
			ignore: ignored(`installation_${target.installation.status}`, scope),
		};
	if (target.link.accessRemovedAt)
		return { ignore: ignored("repository_access_removed", scope) };
	return { ignore: null, target, scope };
}

async function applyDelivery(
	deps: GitHubDeps,
	tx: Tx,
	delivery: { id: string; event: string },
	summary: DeliverySummary,
): Promise<Outcome> {
	switch (summary.kind) {
		case "invalid":
			throw new InvalidDelivery(
				`The ${delivery.event} payload did not have the expected shape (${summary.issues.join("; ")})`,
			);
		case "push": {
			const found = await targetOf(tx.db, summary);
			if (found.ignore) return found.ignore;
			const { repository } = found.target;
			if (summary.deleted) return ignored("ref_deleted", found.scope);
			if (summary.ref !== `refs/heads/${repository.defaultBranch}`)
				return ignored("ref_not_tracked", found.scope);
			const { update, created } = await requestSync(
				deps,
				tx,
				{
					workspaceId: repository.workspaceId,
					repositoryId: repository.id,
					ref: repository.defaultBranch,
					trigger: "push",
					targetSha: summary.after,
					deliveryId: delivery.id,
					actor: WEBHOOK_ACTOR,
				},
				null,
			);
			return processed(found.scope, {
				update_id: update.id,
				coalesced: !created,
			});
		}
		case "pull_request": {
			const found = await targetOf(tx.db, summary);
			if (found.ignore) return found.ignore;
			if (!PULL_REQUEST_ACTIONS.has(summary.action))
				return ignored("action_not_handled", found.scope);
			if (!RefNameSchema.safeParse(summary.base_ref).success)
				return ignored("ref_not_supported", found.scope);
			const { repository } = found.target;
			const { update, created } = await requestSync(
				deps,
				tx,
				{
					workspaceId: repository.workspaceId,
					repositoryId: repository.id,
					ref: `refs/pull/${summary.number}/head`,
					trigger: "pull_request",
					targetSha: summary.head_sha,
					deliveryId: delivery.id,
					pullRequest: { number: summary.number, base_ref: summary.base_ref },
					actor: WEBHOOK_ACTOR,
				},
				null,
			);
			return processed(found.scope, {
				update_id: update.id,
				coalesced: !created,
			});
		}
		case "repository": {
			const found = await targetOf(tx.db, summary);
			if (found.ignore) return found.ignore;
			// targetOf already followed the new name.
			if (summary.action === "renamed")
				return processed(found.scope, {
					full_name: summary.repository.full_name,
				});
			const from = summary.default_branch_from;
			const to = summary.default_branch;
			if (summary.action !== "edited" || !from || !to || from === to)
				return ignored("action_not_handled", found.scope);
			if (!RefNameSchema.safeParse(to).success)
				return ignored("ref_not_supported", found.scope);
			const { repository } = found.target;
			// Follow GitHub's default branch only when Tracera's was the old one (an owner's choice stays).
			if (repository.defaultBranch !== from)
				return ignored("default_branch_customized", found.scope);
			await tx.db
				.update(repositories)
				.set({ defaultBranch: to, updatedAt: new Date() })
				.where(eq(repositories.id, repository.id));
			await audit(tx.db, {
				workspaceId: repository.workspaceId,
				actor: WEBHOOK_ACTOR,
				action: "repository.default_branch_followed",
				targetType: "repository",
				targetId: repository.id,
				metadata: { from, to, delivery_id: delivery.id },
			});
			const { update } = await requestSync(
				deps,
				tx,
				{
					workspaceId: repository.workspaceId,
					repositoryId: repository.id,
					ref: to,
					trigger: "default_branch",
					deliveryId: delivery.id,
					actor: WEBHOOK_ACTOR,
				},
				null,
			);
			return processed(found.scope, {
				update_id: update.id,
				default_branch: to,
			});
		}
		case "installation":
			return applyInstallationEvent(tx, summary);
		case "installation_repositories":
			return applyInstallationRepositories(tx, summary);
		case "other": {
			const owner = await installationByGitHubId(
				tx.db,
				summary.installation_id,
			);
			return ignored(delivery.event === "ping" ? "ping" : "event_not_handled", {
				workspaceId: owner?.workspaceId ?? null,
				repositoryId: null,
			});
		}
	}
}

async function applyInstallationEvent(
	tx: Tx,
	summary: Extract<DeliverySummary, { kind: "installation" }>,
): Promise<Outcome> {
	const [row] = await tx.db
		.select()
		.from(githubInstallations)
		.where(eq(githubInstallations.installationId, summary.installation_id))
		.for("update")
		.limit(1);
	if (!row)
		return ignored("installation_not_connected", {
			workspaceId: null,
			repositoryId: null,
		});
	const scope = { workspaceId: row.workspaceId, repositoryId: null };
	const now = new Date();
	const refreshed = {
		accountLogin: summary.account_login,
		accountType: summary.account_type,
		repositorySelection: summary.repository_selection,
		permissions: summary.permissions,
		events: summary.events,
	};
	const changes =
		summary.action === "deleted"
			? { status: "removed" as const, removedAt: now }
			: summary.action === "suspend" && row.status === "active"
				? { status: "suspended" as const, suspendedAt: now }
				: summary.action === "unsuspend" && row.status === "suspended"
					? { status: "active" as const, suspendedAt: null }
					: summary.action === "new_permissions_accepted" ||
							(summary.action === "created" && row.status !== "removed")
						? refreshed
						: null;
	if (!changes) return ignored("action_not_handled", scope);
	await tx.db
		.update(githubInstallations)
		.set({ ...changes, updatedAt: now })
		.where(eq(githubInstallations.id, row.id));
	await audit(tx.db, {
		workspaceId: row.workspaceId,
		actor: WEBHOOK_ACTOR,
		action: `github.installation_${summary.action}`,
		targetType: "github_installation",
		targetId: row.id,
		metadata: {
			installation_id: row.installationId,
			...("permissions" in changes
				? {
						permission_problems: evaluatePermissions(changes.permissions)
							.problems,
					}
				: {}),
		},
	});
	return processed(scope, { installation: row.id, action: summary.action });
}

async function applyInstallationRepositories(
	tx: Tx,
	summary: Extract<DeliverySummary, { kind: "installation_repositories" }>,
): Promise<Outcome> {
	const row = await installationByGitHubId(tx.db, summary.installation_id);
	if (!row)
		return ignored("installation_not_connected", {
			workspaceId: null,
			repositoryId: null,
		});
	const now = new Date();
	const removed =
		summary.removed.length > 0
			? await tx.db
					.update(githubRepositories)
					.set({ accessRemovedAt: now, updatedAt: now })
					.where(
						and(
							eq(githubRepositories.installationId, row.id),
							inArray(githubRepositories.githubRepositoryId, summary.removed),
							isNull(githubRepositories.accessRemovedAt),
						),
					)
					.returning({ repositoryId: githubRepositories.repositoryId })
			: [];
	const restored =
		summary.added.length > 0
			? await tx.db
					.update(githubRepositories)
					.set({ accessRemovedAt: null, updatedAt: now })
					.where(
						and(
							eq(githubRepositories.installationId, row.id),
							inArray(githubRepositories.githubRepositoryId, summary.added),
							isNotNull(githubRepositories.accessRemovedAt),
						),
					)
					.returning({ repositoryId: githubRepositories.repositoryId })
			: [];
	await tx.db
		.update(githubInstallations)
		.set({ repositorySelection: summary.repository_selection, updatedAt: now })
		.where(eq(githubInstallations.id, row.id));
	const changed = [...removed, ...restored].map((link) => link.repositoryId);
	if (changed.length > 0)
		await audit(tx.db, {
			workspaceId: row.workspaceId,
			actor: WEBHOOK_ACTOR,
			action: "github.repository_access_changed",
			targetType: "github_installation",
			targetId: row.id,
			metadata: {
				access_removed: removed.map((link) => link.repositoryId),
				access_restored: restored.map((link) => link.repositoryId),
			},
		});
	return processed(
		{
			workspaceId: row.workspaceId,
			repositoryId: changed.length === 1 ? (changed[0] ?? null) : null,
		},
		{
			access_removed: removed.map((link) => link.repositoryId),
			access_restored: restored.map((link) => link.repositoryId),
		},
	);
}

/** The workspace and repository a delivery concerns, for recording a failure (best effort). */
async function attribute(db: Db, summary: DeliverySummary): Promise<Scope> {
	const owner = await installationByGitHubId(db, summary.installation_id);
	if (!owner) return { workspaceId: null, repositoryId: null };
	const repository = "repository" in summary ? summary.repository.id : null;
	const [link] =
		repository === null
			? []
			: await db
					.select({ repositoryId: githubRepositories.repositoryId })
					.from(githubRepositories)
					.where(
						and(
							eq(githubRepositories.installationId, owner.id),
							eq(githubRepositories.githubRepositoryId, repository),
						),
					)
					.limit(1);
	return {
		workspaceId: owner.workspaceId,
		repositoryId: link?.repositoryId ?? null,
	};
}

/**
 * Processes one recorded delivery in a transaction that also settles its status, so a crash can never
 * leave effects without a processed record. A failure is recorded with its retry state: automatic
 * retries with backoff (1, 5, and 25 minutes, then 2 hours; five attempts in all) unless the payload
 * itself is invalid.
 */
export async function processDelivery(
	deps: GitHubDeps,
	deliveryId: string,
): Promise<{
	status: "processed" | "ignored" | "failed";
	reason: string | null;
	error: ErrorInfo | null;
}> {
	const [row] = await deps.db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.limit(1);
	if (!row)
		return {
			status: "failed",
			reason: null,
			error: {
				code: "not_found",
				message: "The delivery no longer exists",
				retryable: false,
			},
		};
	// Written by summarizeDelivery above, so the shape is ours.
	const summary = row.summary as DeliverySummary;
	try {
		const outcome = await withTransaction(deps.pool, async (tx) => {
			const result = await applyDelivery(deps, tx, row, summary);
			await tx.db
				.update(webhookDeliveries)
				.set({
					status: result.status,
					reason: result.reason,
					workspaceId: result.workspaceId,
					repositoryId: result.repositoryId,
					outcome: result.details,
					error: null,
					nextAttemptAt: null,
					processedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(webhookDeliveries.id, row.id));
			return result;
		});
		return { status: outcome.status, reason: outcome.reason, error: null };
	} catch (error) {
		const invalid = error instanceof InvalidDelivery;
		const failure: ErrorInfo = invalid
			? {
					code: "webhook_payload_invalid",
					message: error.message,
					retryable: false,
				}
			: {
					code: "webhook_processing_failed",
					message:
						"Processing the delivery failed; it is retried automatically",
					retryable: row.attempts < MAX_DELIVERY_ATTEMPTS,
				};
		const scope = await attribute(deps.db, summary).catch(() => ({
			workspaceId: null,
			repositoryId: null,
		}));
		await deps.db
			.update(webhookDeliveries)
			.set({
				status: "failed",
				error: failure,
				nextAttemptAt: failure.retryable
					? new Date(
							Date.now() +
								(DELIVERY_RETRY_MS[row.attempts - 1] ??
									DELIVERY_RETRY_MS[0] ??
									60_000),
						)
					: null,
				...scope,
				updatedAt: new Date(),
			})
			.where(eq(webhookDeliveries.id, row.id));
		deps.log?.("webhook delivery failed", {
			delivery_id: row.id,
			event: row.event,
			code: failure.code,
			...(invalid
				? {}
				: {
						error: redactSecrets((error as Error).message ?? "", {
							redactEmails: true,
						}).text,
					}),
		});
		return { status: "failed", reason: null, error: failure };
	}
}

/** Worker maintenance: retries failed deliveries that are due, and forgets deliveries after 30 days. */
export async function deliveryMaintenance(deps: GitHubDeps): Promise<number> {
	await deps.db
		.delete(webhookDeliveries)
		.where(
			lt(
				webhookDeliveries.receivedAt,
				new Date(Date.now() - DELIVERY_RETENTION_MS),
			),
		);
	// Due retries, plus deliveries left `received` by a process that died while handling them.
	const due = await deps.db.execute<{ id: string }>(sql`
		UPDATE webhook_deliveries
		   SET status = 'received', attempts = attempts + 1, next_attempt_at = NULL, updated_at = now()
		 WHERE id IN (
		   SELECT id FROM webhook_deliveries
		    WHERE (status = 'failed' AND next_attempt_at <= now())
		       OR (status = 'received' AND updated_at < now() - interval '5 minutes')
		    ORDER BY received_at
		    LIMIT 20
		    FOR UPDATE SKIP LOCKED)
		RETURNING id`);
	for (const row of due.rows) await processDelivery(deps, row.id);
	return due.rows.length;
}
