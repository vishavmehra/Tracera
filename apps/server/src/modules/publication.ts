import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	type ActionRequest,
	type ActionResult,
	ActionResultSchema,
	type ActionTarget,
	type AuthorizedAction,
	BranchNameSchema,
} from "@tracera/contracts";
import { and, desc, eq, lt } from "drizzle-orm";
import type pg from "pg";
import type { Config } from "../config.ts";
import { type Db, withTransaction } from "../db/client.ts";
import {
	authorizedActions,
	investigations,
	patchProposals,
	repositories,
	users,
	verificationRuns,
} from "../db/schema.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { isPathInside, readBlobUtf8 } from "../lib/fs.ts";
import { type GitResult, git, gitTopLevel, resolveCommit } from "../lib/git.ts";
import { AppError } from "../lib/http.ts";
import { newId } from "../lib/ids.ts";
import { redactSecrets } from "../lib/redact.ts";
import { audit } from "./audit.ts";
import { type AuthContext, actorOf } from "./auth.ts";
import { idempotent } from "./idempotency.ts";

// Applying, committing, and pushing an approved patch. Each is a separate action the signed-in owner
// authorizes explicitly; approval itself changes no files. Every result below is read back from git's
// own output, and repository code never runs on the host: hooks, content filters, signing, and the
// file system monitor are switched off for every call (see lib/git.ts for the shared hardening).

/** Stable codes for every way an action can end without succeeding: [HTTP status, message]. */
const ERRORS = {
	invalid_state: [409, "The patch is not approved"],
	acknowledgement_mismatch: [422, "Acknowledge the recorded outcome"],
	risks_not_acknowledged: [422, "Acknowledge the risks of this outcome"],
	repository_not_local: [422, "Only local-path repositories can change"],
	repository_path_not_allowed: [422, "The path is outside the allowed roots"],
	repository_unavailable: [422, "The path is no longer a git work tree"],
	commit_required: [409, "Commit the patch to a branch first"],
	action_in_progress: [409, "Another action is running here"],
	diff_missing: [409, "The stored diff is missing"],
	diff_integrity_failed: [409, "The stored diff fails its hash check"],
	diff_invalid: [422, "The stored diff cannot be applied safely"],
	working_tree_dirty: [409, "A file the patch changes has local edits"],
	patch_does_not_apply: [409, "The patch does not apply to the files"],
	secret_detected: [422, "The change adds what looks like a secret"],
	commit_not_found: [422, "The verified base commit is not here"],
	invalid_branch_name: [422, "That branch name cannot be used"],
	branch_exists: [409, "That branch already exists"],
	remote_not_found: [422, "That remote is not configured"],
	branch_changed: [409, "The branch no longer holds Tracera's commit"],
	default_branch_refused: [422, "Default branches are never pushed to"],
	non_fast_forward: [409, "The remote branch has newer commits"],
	remote_auth_failed: [502, "The remote did not accept the credentials"],
	remote_rejected: [502, "The remote refused the push"],
	push_failed: [502, "git could not push"],
	git_failed: [500, "git failed"],
	interrupted: [500, "The action was interrupted"],
} as const;
type ErrorCode = keyof typeof ERRORS;

/** Codes for an action that was attempted and failed; every other code means nothing was changed. */
const FAILED: ReadonlySet<ErrorCode> = new Set([
	"non_fast_forward",
	"remote_auth_failed",
	"remote_rejected",
	"push_failed",
	"git_failed",
	"interrupted",
]);

export class ActionError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode, detail?: string) {
		super(detail ?? ERRORS[code][1]);
		this.code = code;
	}
}

const appErrorFor = (code: ErrorCode, detail: string, actionId: string) =>
	new AppError(ERRORS[code][0], code, detail, {
		extra: { action_id: actionId },
	});
const isErrorCode = (value: string | null): value is ErrorCode =>
	value !== null && Object.hasOwn(ERRORS, value);

/** An action row stuck in "running" this long belongs to a process that died. */
const STALE_RUNNING_MS = 15 * 60_000;
const SLOW_GIT_MS = 120_000;

type Deps = { pool: pg.Pool; db: Db; config: Config };
type Session = Extract<AuthContext, { kind: "session" }>;
type Row = typeof authorizedActions.$inferSelect;
type Subject = {
	patch: typeof patchProposals.$inferSelect;
	repository: typeof repositories.$inferSelect;
	run: typeof verificationRuns.$inferSelect | null;
};
type Committed = { branch: string; sha: string };
type Run = (
	cwd: string,
	args: readonly string[],
	options?: { timeoutMs?: number; userConfig?: boolean },
) => Promise<GitResult>;
/** What the first, short transaction decided; the git work happens after it commits. */
type Started = {
	action_id: string;
	error?: { code: ErrorCode; detail: string };
};

const defaultBranchName = (patchId: string) => `tracera/${patchId}`;
const isApproved = (subject: Subject) =>
	subject.patch.status === "approved" &&
	subject.patch.approval?.decision === "approved";

async function loadSubject(
	db: Db,
	workspaceId: string,
	patchId: string,
): Promise<Subject> {
	const [row] = await db
		.select({ patch: patchProposals, repository: repositories })
		.from(patchProposals)
		.innerJoin(
			investigations,
			eq(investigations.id, patchProposals.investigationId),
		)
		.innerJoin(repositories, eq(repositories.id, investigations.repositoryId))
		.where(
			and(
				eq(patchProposals.id, patchId),
				eq(investigations.workspaceId, workspaceId),
				eq(repositories.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row)
		throw new AppError(404, "not_found", `Patch ${patchId} was not found`);
	const [run] = await db
		.select()
		.from(verificationRuns)
		.where(eq(verificationRuns.patchId, patchId))
		.limit(1);
	return { ...row, run: run ?? null };
}

function view(row: Row): AuthorizedAction {
	const result = ActionResultSchema.safeParse(row.result);
	return {
		id: row.id,
		patch_id: row.patchId,
		repository_id: row.repositoryId,
		kind: row.kind,
		status: row.status,
		requested_by: row.requestedBy,
		acknowledged_outcome: row.acknowledgedOutcome,
		acknowledged_risks: row.acknowledgedRisks,
		params: row.params,
		result: result.success ? result.data : null,
		error_code: row.errorCode,
		created_at: row.createdAt.toISOString(),
		finished_at: row.finishedAt?.toISOString() ?? null,
	};
}

function targetOf(subject: Subject): ActionTarget {
	const local = subject.repository.sourceType === "local_path";
	return {
		repository_id: subject.repository.id,
		repository_name: subject.repository.name,
		local,
		path: local ? subject.repository.sourceRef : null,
		base_commit: subject.patch.baseCommit,
		suggested_branch: defaultBranchName(subject.patch.id),
	};
}

export async function listActions(
	db: Db,
	workspaceId: string,
	patchId: string,
) {
	const subject = await loadSubject(db, workspaceId, patchId);
	const rows = await db
		.select()
		.from(authorizedActions)
		.where(
			and(
				eq(authorizedActions.patchId, patchId),
				eq(authorizedActions.workspaceId, workspaceId),
			),
		)
		.orderBy(desc(authorizedActions.createdAt), desc(authorizedActions.id));
	return { target: targetOf(subject), items: rows.map(view) };
}

export async function getAction(db: Db, workspaceId: string, id: string) {
	const [row] = await db
		.select()
		.from(authorizedActions)
		.where(
			and(
				eq(authorizedActions.id, id),
				eq(authorizedActions.workspaceId, workspaceId),
			),
		)
		.limit(1);
	if (!row) throw new AppError(404, "not_found", `Action ${id} was not found`);
	return { action: view(row) };
}

/** The reviewed diff as a file, for an approved patch only, after checking it against its hash. */
export async function downloadPatch(
	db: Db,
	config: Config,
	workspaceId: string,
	patchId: string,
) {
	const subject = await loadSubject(db, workspaceId, patchId);
	if (!isApproved(subject))
		throw new AppError(
			409,
			"invalid_state",
			"Only an approved patch can be downloaded",
		);
	try {
		return {
			filename: `tracera-${patchId}.patch`,
			diff: await storedDiff(config, subject.patch),
		};
	} catch (error) {
		if (error instanceof ActionError)
			throw new AppError(ERRORS[error.code][0], error.code, error.message);
		throw error;
	}
}

/** The commit the user last had Tracera create for this patch, which is what a push sends. */
async function latestCommit(
	db: Db,
	patchId: string,
): Promise<Committed | null> {
	const [row] = await db
		.select({ result: authorizedActions.result })
		.from(authorizedActions)
		.where(
			and(
				eq(authorizedActions.patchId, patchId),
				eq(authorizedActions.kind, "commit"),
				eq(authorizedActions.status, "succeeded"),
			),
		)
		.orderBy(desc(authorizedActions.createdAt), desc(authorizedActions.id))
		.limit(1);
	const result = ActionResultSchema.safeParse(row?.result);
	return result.success && result.data.branch && result.data.commit_sha
		? { branch: result.data.branch, sha: result.data.commit_sha }
		: null;
}

/** Checks that need only stored data, in the order a person would hit them. */
function refusalFor(
	subject: Subject,
	input: ActionRequest,
	previous: Committed | null,
): ActionError | null {
	if (!isApproved(subject))
		return new ActionError("invalid_state", "The patch is not approved");
	if (!subject.run)
		return new ActionError(
			"invalid_state",
			"No verification outcome is recorded for this patch",
		);
	if (subject.repository.sourceType !== "local_path")
		return new ActionError("repository_not_local");
	if (input.acknowledged_outcome !== subject.run.outcome)
		return new ActionError(
			"acknowledgement_mismatch",
			`acknowledged_outcome must be ${subject.run.outcome}, the recorded verification outcome`,
		);
	if (subject.run.outcome !== "verified" && input.acknowledged_risks !== true)
		return new ActionError("risks_not_acknowledged");
	if (input.kind === "push" && !previous)
		return new ActionError("commit_required");
	return null;
}

function paramsOf(
	subject: Subject,
	input: ActionRequest,
): Record<string, unknown> {
	if (input.kind === "commit")
		return { branch: input.branch ?? defaultBranchName(subject.patch.id) };
	if (input.kind === "push")
		return { remote: input.remote, remote_branch: input.remote_branch };
	return {};
}

function rowFor(
	ctx: Session,
	subject: Subject,
	input: ActionRequest,
	id: string,
) {
	return {
		id,
		workspaceId: ctx.workspaceId,
		patchId: subject.patch.id,
		repositoryId: subject.repository.id,
		kind: input.kind,
		requestedBy: ctx.userId,
		acknowledgedOutcome: input.acknowledged_outcome ?? null,
		acknowledgedRisks: input.acknowledged_risks === true,
		params: paramsOf(subject, input),
	};
}

/** Audit rows carry identifiers and codes only, never diff or file content. */
function auditAction(
	db: Db,
	ctx: Session,
	subject: Subject,
	input: ActionRequest,
	facts: {
		actionId: string;
		status: Row["status"];
		errorCode: ErrorCode | null;
		result?: ActionResult;
		requestId: string;
	},
) {
	return audit(db, {
		workspaceId: ctx.workspaceId,
		actor: actorOf(ctx),
		action: `publication.${input.kind}`,
		targetType: "patch",
		targetId: subject.patch.id,
		metadata: {
			action_id: facts.actionId,
			repository_id: subject.repository.id,
			status: facts.status,
			error_code: facts.errorCode,
			acknowledged_outcome: input.acknowledged_outcome ?? null,
			acknowledged_risks: input.acknowledged_risks === true,
			...paramsOf(subject, input),
			...(facts.result
				? {
						commit_sha: facts.result.commit_sha ?? null,
						pushed_ref: facts.result.pushed_ref ?? null,
						files_changed: facts.result.changed_files?.length ?? null,
					}
				: {}),
		},
		requestId: facts.requestId,
	});
}

/** Records a refusal (nothing attempted) and its audit row, then answers as a stored result. */
async function refuse(
	db: Db,
	ctx: Session,
	subject: Subject,
	input: ActionRequest,
	error: ActionError,
	actionId: string,
	requestId: string,
) {
	await db.insert(authorizedActions).values({
		...rowFor(ctx, subject, input, actionId),
		status: "refused",
		errorCode: error.code,
		result: { detail: error.message },
		finishedAt: new Date(),
	});
	await auditAction(db, ctx, subject, input, {
		actionId,
		status: "refused",
		errorCode: error.code,
		requestId,
	});
	const body: Started = {
		action_id: actionId,
		error: { code: error.code, detail: error.message },
	};
	return { status: ERRORS[error.code][0], body };
}

/**
 * Authorizes and runs one action for an approved patch. The first transaction validates and records
 * the action as running (a unique index allows one running action per repository); git then runs
 * outside any transaction; a second one records what git reported. A repeated Idempotency-Key returns
 * the first request's action instead of acting again.
 */
export async function requestAction(
	deps: Deps,
	ctx: Session,
	patchId: string,
	input: ActionRequest,
	meta: { requestId: string; idempotencyKey: string | undefined },
): Promise<{ action: AuthorizedAction; replayed: boolean }> {
	const actionId = newId("act");
	const loaded: { subject?: Subject; previous?: Committed | null } = {};
	const started = await idempotent<Started>(
		deps,
		{
			workspaceId: ctx.workspaceId,
			actorId: ctx.userId,
			key: meta.idempotencyKey,
			methodPath: `POST /api/v1/patches/${patchId}/actions`,
			body: input,
		},
		async ({ db }) => {
			const subject = await loadSubject(db, ctx.workspaceId, patchId);
			const previous =
				input.kind === "push" ? await latestCommit(db, patchId) : null;
			loaded.subject = subject;
			loaded.previous = previous;
			const refused = refusalFor(subject, input, previous);
			if (refused)
				return refuse(
					db,
					ctx,
					subject,
					input,
					refused,
					actionId,
					meta.requestId,
				);
			await db
				.update(authorizedActions)
				.set({
					status: "failed",
					errorCode: "interrupted",
					finishedAt: new Date(),
				})
				.where(
					and(
						eq(authorizedActions.repositoryId, subject.repository.id),
						eq(authorizedActions.status, "running"),
						lt(
							authorizedActions.createdAt,
							new Date(Date.now() - STALE_RUNNING_MS),
						),
					),
				);
			const [row] = await db
				.insert(authorizedActions)
				.values({ ...rowFor(ctx, subject, input, actionId), status: "running" })
				.onConflictDoNothing()
				.returning({ id: authorizedActions.id });
			if (!row)
				return refuse(
					db,
					ctx,
					subject,
					input,
					new ActionError("action_in_progress"),
					actionId,
					meta.requestId,
				);
			return { status: 202, body: { action_id: actionId } };
		},
	);

	if (started.body.action_id !== actionId)
		return {
			action: await settled(deps.db, ctx.workspaceId, started.body.action_id),
			replayed: true,
		};
	if (started.body.error)
		throw appErrorFor(
			started.body.error.code,
			started.body.error.detail,
			actionId,
		);
	const { subject } = loaded;
	if (!subject)
		throw new AppError(500, "internal_error", "An unexpected error occurred");

	let result: ActionResult | null = null;
	let failure: ActionError | null = null;
	let unexpected: unknown = null;
	try {
		result = await perform(deps, ctx, subject, input, loaded.previous ?? null);
	} catch (error) {
		if (error instanceof ActionError) failure = error;
		else {
			unexpected = error;
			failure = new ActionError("git_failed", "The action failed unexpectedly");
		}
	}
	const status: Row["status"] = failure
		? FAILED.has(failure.code)
			? "failed"
			: "refused"
		: "succeeded";
	const row = await withTransaction(deps.pool, async ({ db }) => {
		const [updated] = await db
			.update(authorizedActions)
			.set({
				status,
				result: failure ? { detail: failure.message } : result,
				errorCode: failure?.code ?? null,
				finishedAt: new Date(),
			})
			.where(eq(authorizedActions.id, actionId))
			.returning();
		await auditAction(db, ctx, subject, input, {
			actionId,
			status,
			errorCode: failure?.code ?? null,
			...(result ? { result } : {}),
			requestId: meta.requestId,
		});
		return updated;
	});
	if (unexpected) throw unexpected;
	if (failure) throw appErrorFor(failure.code, failure.message, actionId);
	if (!row)
		throw new AppError(500, "internal_error", "An unexpected error occurred");
	return { action: view(row), replayed: false };
}

/** The current state of an action an earlier request created: failures answer as they did then. */
async function settled(db: Db, workspaceId: string, actionId: string) {
	const { action } = await getAction(db, workspaceId, actionId);
	if (action.status === "failed" || action.status === "refused") {
		const code = isErrorCode(action.error_code)
			? action.error_code
			: "git_failed";
		throw appErrorFor(code, action.result?.detail ?? ERRORS[code][1], actionId);
	}
	return action;
}

// ---- Running git ------------------------------------------------------------------------------

async function perform(
	deps: Deps,
	ctx: Session,
	subject: Subject,
	input: ActionRequest,
	previous: Committed | null,
): Promise<ActionResult> {
	const dir = await locateRepository(deps.config, subject.repository);
	const scratch = await mkdtemp(path.join(os.tmpdir(), "tracera-action-"));
	try {
		// An empty hooks directory per action, so no hook in the repository or the temp dir can run.
		const hooks = path.join(scratch, "no-hooks");
		await mkdir(hooks);
		const run: Run = (cwd, args, options) =>
			git(cwd, ["-c", `core.hooksPath=${hooks}`, ...args], options);
		if (input.kind === "apply")
			return await applyToWorkingTree(deps.config, subject, dir, scratch, run);
		if (input.kind === "commit")
			return await commitToNewBranch(
				deps,
				ctx,
				subject,
				input,
				dir,
				scratch,
				run,
			);
		if (!previous) throw new ActionError("commit_required");
		return await pushBranch(subject, input, previous, dir, run);
	} finally {
		// Best effort: a temp directory that cannot be removed must not turn a finished action into a failure.
		await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(
			() => undefined,
		);
	}
}

/** The registered path, re-checked now: it must still be a repository root inside an allowed root. */
async function locateRepository(
	config: Config,
	repository: Subject["repository"],
): Promise<string> {
	const real = await realpath(repository.sourceRef).catch(() => null);
	if (!real) throw new ActionError("repository_unavailable");
	const roots = (
		await Promise.all(
			config.repoRoots.map((root) => realpath(root).catch(() => null)),
		)
	).filter((root): root is string => root !== null);
	if (
		!roots.some((root) => isPathInside(root, real)) ||
		isPathInside(config.sourceRoot, real) ||
		isPathInside(config.dataDir, real)
	)
		throw new ActionError("repository_path_not_allowed");
	const top = await gitTopLevel(real);
	if (!top || !(isPathInside(top, real) && isPathInside(real, top)))
		throw new ActionError("repository_unavailable");
	return real;
}

async function storedDiff(
	config: Config,
	patch: Subject["patch"],
): Promise<string> {
	const diff = await readBlobUtf8(
		path.join(config.dataDir, "blobs"),
		patch.diffSha256,
	);
	if (diff === null) throw new ActionError("diff_missing");
	if (sha256Hex(diff) !== patch.diffSha256)
		throw new ActionError("diff_integrity_failed");
	return diff;
}

/** Symbolic links and submodules are never written by an action. */
const LINK_OR_SUBMODULE_MODE =
	/^(?:(?:new|deleted) file mode|old mode|new mode) 1[26]0000$|^index [0-9a-f]+\.\.[0-9a-f]+ 1[26]0000$/m;

/** The files the diff touches, as git reads them from the diff itself. */
async function patchTargets(
	run: Run,
	scratch: string,
	diff: string,
	patchFile: string,
): Promise<string[]> {
	if (LINK_OR_SUBMODULE_MODE.test(diff))
		throw new ActionError(
			"diff_invalid",
			"The diff changes a symbolic link or a submodule",
		);
	// Outside any repository, so no repository configuration is involved in reading the diff.
	const numstat = await run(scratch, [
		"apply",
		"--numstat",
		"-z",
		"--",
		patchFile,
	]);
	if (!numstat.ok)
		throw new ActionError("diff_invalid", "git cannot read the stored diff");
	const files = [
		...new Set(
			numstat.stdout
				.split("\0")
				.filter(Boolean)
				.map((record) => record.split("\t").slice(2).join("\t")),
		),
	];
	if (
		files.length === 0 ||
		files.some(
			(file) =>
				file === "" ||
				file.split("/").some((segment) => segment.toLowerCase() === ".git"),
		)
	)
		throw new ActionError("diff_invalid");
	return files;
}

async function writeDiff(scratch: string, diff: string): Promise<string> {
	const patchFile = path.join(scratch, "patch.diff");
	await writeFile(patchFile, diff);
	return patchFile;
}

/** Statuses from `status --porcelain -z`: "XY path" records. */
function parseStatus(
	output: string,
): NonNullable<ActionResult["changed_files"]> {
	return output
		.split("\0")
		.filter((record) => record.length > 3)
		.map((record) => {
			const code = record.slice(0, 2);
			return {
				path: record.slice(3),
				status: code.includes("D")
					? ("deleted" as const)
					: code === "??" || code.includes("A")
						? ("added" as const)
						: ("modified" as const),
			};
		});
}

/** Content filters named in the repository's own configuration would run programs; blank them. */
async function filterOverrides(run: Run, dir: string): Promise<string[]> {
	const listed = await run(dir, [
		"config",
		"--local",
		"--get-regexp",
		String.raw`^filter\..+\.(clean|smudge|process)$`,
	]);
	const drivers = new Set(
		listed.stdout
			.split("\n")
			.map((line) => line.split(" ")[0] ?? "")
			.filter((key) => key.startsWith("filter.") && key.lastIndexOf(".") > 7)
			.map((key) => key.slice(7, key.lastIndexOf("."))),
	);
	return [...drivers].flatMap((name) => [
		"-c",
		`filter.${name}.clean=`,
		"-c",
		`filter.${name}.smudge=`,
		"-c",
		`filter.${name}.process=`,
		"-c",
		`filter.${name}.required=false`,
	]);
}

async function applyToWorkingTree(
	config: Config,
	subject: Subject,
	dir: string,
	scratch: string,
	run: Run,
): Promise<ActionResult> {
	const diff = await storedDiff(config, subject.patch);
	const patchFile = await writeDiff(scratch, diff);
	const targets = await patchTargets(run, scratch, diff, patchFile);
	const overrides = await filterOverrides(run, dir);
	const inDir: Run = (cwd, args, options) =>
		run(cwd, [...overrides, ...args], options);
	const status = () =>
		inDir(dir, [
			"--literal-pathspecs",
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--",
			...targets,
		]);

	const before = await status();
	if (!before.ok)
		throw new ActionError(
			"git_failed",
			"git could not read the working tree status",
		);
	if (before.stdout.length > 0)
		throw new ActionError(
			"working_tree_dirty",
			`Uncommitted changes in ${parseStatus(before.stdout)
				.slice(0, 5)
				.map((file) => file.path)
				.join(", ")}`,
		);
	const check = await inDir(dir, [
		"apply",
		"--check",
		"--whitespace=nowarn",
		"--",
		patchFile,
	]);
	if (!check.ok) throw new ActionError("patch_does_not_apply");
	const applied = await inDir(
		dir,
		["apply", "--whitespace=nowarn", "--", patchFile],
		{
			timeoutMs: 30_000,
		},
	);
	if (!applied.ok)
		throw new ActionError(
			"git_failed",
			"git apply failed after its check passed",
		);
	const after = await status();
	if (!after.ok)
		throw new ActionError(
			"git_failed",
			"git could not read the working tree status",
		);
	const head = await resolveCommit(dir, "HEAD");
	return {
		changed_files: parseStatus(after.stdout),
		...(head ? { head_commit: head } : {}),
	};
}

/** Added lines only: removed and context lines are not new secrets. */
function addedText(diff: string): string {
	let inHunk = false;
	const added: string[] = [];
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) inHunk = false;
		else if (line.startsWith("@@")) inHunk = true;
		else if (inHunk && line.startsWith("+")) added.push(line.slice(1));
	}
	return added.join("\n");
}

const SECRET_FILE =
	/(^|\/)(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.pem)$/i;

function assertNoSecrets(
	diff: string,
	targets: readonly string[],
	message: string,
) {
	if (targets.some((file) => SECRET_FILE.test(file)))
		throw new ActionError(
			"secret_detected",
			"The change adds a file that usually holds secrets (.env, a private key, or a certificate)",
		);
	const { text, count } = redactSecrets(`${addedText(diff)}\n${message}`, {
		redactEmails: false,
	});
	if (count === 0) return;
	const kinds = [
		...new Set([...text.matchAll(/\[REDACTED:([a-z_]+)\]/g)].map((m) => m[1])),
	];
	throw new ActionError(
		"secret_detected",
		`The added lines match secret patterns (${kinds.join(", ")}). Remove them, or apply the patch to your working tree and commit it yourself`,
	);
}

/** Names git takes in a config value or author field: no angle brackets, line breaks, or NULs. */
const cleanIdentity = (value: string) =>
	value
		.replace(/[<>\r\n\0]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);

function parseNameStatus(
	output: string,
): NonNullable<ActionResult["changed_files"]> {
	const tokens = output.split("\0").filter(Boolean);
	const files: NonNullable<ActionResult["changed_files"]> = [];
	for (let i = 0; i + 1 < tokens.length; i += 2) {
		const code = tokens[i] ?? "";
		files.push({
			path: tokens[i + 1] ?? "",
			status: code.startsWith("D")
				? "deleted"
				: code.startsWith("A")
					? "added"
					: "modified",
		});
	}
	return files;
}

/**
 * The message when the user wrote none: the patch's summary plus the facts that qualify it, so the
 * commit never reads as more than was observed (the summary is the model's wording).
 */
function defaultMessage(subject: Subject): string {
	const outcome = subject.run?.outcome ?? "not_attempted";
	const mock = subject.patch.model?.provider === "mock" ? " [mock]" : "";
	return `${subject.patch.summary}\n\nTracera patch ${subject.patch.id}; verification outcome: ${outcome}${mock}.`;
}

/**
 * Builds the commit in a temporary worktree created without a checkout: the index is filled from the
 * base commit and the diff is applied to the index alone. The user's checkout, index, HEAD, and
 * working files are never touched, and no content filter or checkout hook is involved.
 */
async function commitToNewBranch(
	deps: Deps,
	ctx: Session,
	subject: Subject,
	input: Extract<ActionRequest, { kind: "commit" }>,
	dir: string,
	scratch: string,
	run: Run,
): Promise<ActionResult> {
	const diff = await storedDiff(deps.config, subject.patch);
	const patchFile = await writeDiff(scratch, diff);
	const targets = await patchTargets(run, scratch, diff, patchFile);
	const message = input.message ?? defaultMessage(subject);
	assertNoSecrets(diff, targets, message);
	const base = await resolveCommit(dir, subject.patch.baseCommit);
	if (!base) throw new ActionError("commit_not_found");
	const branch = input.branch ?? defaultBranchName(subject.patch.id);
	if (!(await run(dir, ["check-ref-format", "--branch", branch])).ok)
		throw new ActionError("invalid_branch_name");
	if (
		(
			await run(dir, [
				"show-ref",
				"--verify",
				"--quiet",
				`refs/heads/${branch}`,
			])
		).ok
	)
		throw new ActionError("branch_exists");
	const [user] = await deps.db
		.select({ name: users.displayName, email: users.email })
		.from(users)
		.where(eq(users.id, ctx.userId))
		.limit(1);
	if (!user)
		throw new ActionError("git_failed", "The signed-in user no longer exists");

	const tree = path.join(scratch, "tree");
	let created = false;
	let committed = false;
	try {
		const added = await run(
			dir,
			["worktree", "add", "--no-checkout", "-b", branch, "--", tree, base],
			{ timeoutMs: SLOW_GIT_MS },
		);
		if (!added.ok) {
			const reason = added.stderr;
			throw new ActionError(
				/already exists/i.test(reason)
					? "branch_exists"
					: /cannot lock ref|not a valid branch/i.test(reason)
						? "invalid_branch_name"
						: "git_failed",
			);
		}
		created = true;
		if (!(await run(tree, ["read-tree", "HEAD"])).ok)
			throw new ActionError("git_failed", "git could not read the base tree");
		const check = await run(tree, [
			"apply",
			"--cached",
			"--check",
			"--whitespace=nowarn",
			"--",
			patchFile,
		]);
		if (!check.ok) throw new ActionError("patch_does_not_apply");
		const applied = await run(tree, [
			"apply",
			"--cached",
			"--whitespace=nowarn",
			"--",
			patchFile,
		]);
		if (!applied.ok)
			throw new ActionError(
				"git_failed",
				"git apply failed after its check passed",
			);
		const commit = await run(
			tree,
			[
				"-c",
				`user.name=${cleanIdentity(user.name) || "Tracera user"}`,
				"-c",
				`user.email=${cleanIdentity(user.email)}`,
				"-c",
				"commit.gpgsign=false",
				"-c",
				"gc.auto=0",
				"commit",
				"--no-verify",
				"--no-gpg-sign",
				"-m",
				message,
			],
			{ timeoutMs: 60_000 },
		);
		if (!commit.ok)
			throw new ActionError("git_failed", "git could not create the commit");
		committed = true;
		const sha = (await run(tree, ["rev-parse", "HEAD"])).stdout.trim();
		if (!/^[0-9a-f]{40,64}$/.test(sha))
			throw new ActionError("git_failed", "git did not report a commit");
		const files = await run(tree, [
			"diff-tree",
			"--no-commit-id",
			"--name-status",
			"-r",
			"-z",
			"HEAD",
		]);
		// The branch as git names it, not as it was requested.
		const named = (
			await run(tree, ["symbolic-ref", "--short", "HEAD"])
		).stdout.trim();
		return {
			commit_sha: sha,
			branch: named || branch,
			changed_files: parseNameStatus(files.stdout),
		};
	} finally {
		if (created) {
			await run(dir, ["worktree", "remove", "--force", "--", tree]);
			// A branch that never got its commit is removed; a committed branch is the product.
			if (!committed) await run(dir, ["branch", "-D", "--", branch]);
			await run(dir, ["worktree", "prune"]);
		}
	}
}

/** The only way Tracera pushes: one branch to one named ref, with no force or deletion form. */
export function pushArgs(
	localBranch: string,
	remote: string,
	remoteBranch: string,
): string[] {
	return [
		"push",
		"--porcelain",
		"--no-verify",
		"--no-recurse-submodules",
		"--",
		remote,
		`refs/heads/${localBranch}:refs/heads/${remoteBranch}`,
	];
}

/** One line of git's own words about a failure, with anything credential-like removed. */
function excerpt(text: string): string {
	const line =
		text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => /^(fatal|error|remote|!)/i.test(l)) ?? "";
	return (
		redactSecrets(line, { redactEmails: false }).text.slice(0, 240) ||
		"git reported an error"
	);
}

async function pushBranch(
	subject: Subject,
	input: Extract<ActionRequest, { kind: "push" }>,
	previous: Committed,
	dir: string,
	run: Run,
): Promise<ActionResult> {
	if (!BranchNameSchema.safeParse(previous.branch).success)
		throw new ActionError("branch_changed");
	const remotes = (await run(dir, ["remote"])).stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!remotes.includes(input.remote))
		throw new ActionError("remote_not_found");
	if (
		(await resolveCommit(dir, `refs/heads/${previous.branch}`)) !== previous.sha
	)
		throw new ActionError("branch_changed");

	const head = await run(dir, [
		"symbolic-ref",
		"--quiet",
		"--short",
		`refs/remotes/${input.remote}/HEAD`,
	]);
	const remoteDefault = head.ok
		? head.stdout.trim().replace(`${input.remote}/`, "")
		: "";
	const protectedBranches = new Set(
		[remoteDefault, subject.repository.defaultBranch, "main", "master"].filter(
			Boolean,
		),
	);
	if (protectedBranches.has(input.remote_branch))
		throw new ActionError("default_branch_refused");

	const pushed = await run(
		dir,
		pushArgs(previous.branch, input.remote, input.remote_branch),
		{
			timeoutMs: SLOW_GIT_MS,
			userConfig: true,
		},
	);
	// Porcelain lines are "<flag>\t<from>:<to>\t<summary>"; a space, "*", or "=" means the remote has it.
	const line = pushed.stdout
		.split("\n")
		.find((l) =>
			l.split("\t")[1]?.endsWith(`:refs/heads/${input.remote_branch}`),
		);
	const pushedRef = line?.split("\t")[1]?.split(":").slice(1).join(":");
	if (pushed.ok && pushedRef && [" ", "*", "="].includes(line?.[0] ?? "!"))
		return {
			commit_sha: previous.sha,
			branch: previous.branch,
			remote: input.remote,
			pushed_ref: pushedRef,
		};

	throw pushFailure(`${pushed.stdout}\n${pushed.stderr}`, pushed.timedOut);
}

/** Maps git's own words about a failed push to a stable code; nothing is retried or forced. */
export function pushFailure(output: string, timedOut: boolean): ActionError {
	if (timedOut)
		return new ActionError("push_failed", "git did not finish pushing in time");
	const lower = output.toLowerCase();
	if (
		/non-fast-forward|fetch first|tip of your current branch is behind/.test(
			lower,
		)
	)
		return new ActionError("non_fast_forward");
	if (
		/authentication failed|permission denied|could not read username|terminal prompts disabled|invalid username or password|returned error: 40[13]|http 40[13]/.test(
			lower,
		)
	)
		return new ActionError("remote_auth_failed");
	if (/remote rejected|hook declined|protected branch/.test(lower))
		return new ActionError("remote_rejected", excerpt(output));
	return new ActionError("push_failed", excerpt(output));
}
