import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthorizedActionSchema } from "@tracera/contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	auditEvents,
	authorizedActions,
	bugReports,
	hypotheses,
	investigations,
	patchProposals,
	repositories,
	verificationRuns,
} from "../src/db/schema.ts";
import { putBlob } from "../src/lib/fs.ts";
import { newId } from "../src/lib/ids.ts";
import { stageAndDiff } from "../src/modules/workspace.ts";
import {
	addMember,
	asSession,
	asToken,
	createOwner,
	createTestContext,
	createToken,
	csrf,
	login,
	resetDatabase,
	type TestContext,
} from "./helpers.ts";

// Temporary repositories and a local bare remote stand in for the developer's checkout and for a
// git host. Nothing here talks to the network, and everything lives outside the Tracera tree.

// Credential-shaped test values are assembled at run time, so the source holds no secret-like literal.
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const PRIVATE_KEY_BEGIN = ["-----BEGIN RSA PRIVATE", "KEY-----"].join(" ");

let ctx: TestContext;
let owner: { userId: string; workspaceId: string };
let cookie: string;
let session: ReturnType<typeof asSession>;

beforeAll(async () => {
	ctx = await createTestContext();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
	await resetDatabase(ctx.pool);
	owner = await createOwner(ctx.db);
	cookie = await login(ctx);
	session = asSession(ctx, cookie);
});

/** Fixture git, with identity and conversions pinned so the machine's own configuration is irrelevant. */
const git = (cwd: string, ...args: string[]) =>
	execFileSync(
		"git",
		[
			"-c",
			"user.name=dev",
			"-c",
			"user.email=dev@example.com",
			"-c",
			"core.autocrlf=false",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, encoding: "utf8", stdio: "pipe" },
	).trim();
const status = (dir: string) =>
	execFileSync("git", ["status", "--porcelain"], {
		cwd: dir,
		encoding: "utf8",
		stdio: "pipe",
	}).trimEnd();
const read = (dir: string, file: string) =>
	readFileSync(path.join(dir, file), "utf8");

const TOTAL = `export function total(items) {
	return items.reduce((sum, item) => sum + item.price, 0);
}
`;
const FIXED_TOTAL = TOTAL.replace("item.price", "item.price * item.qty");

type Outcome = "verified" | "partially_verified";
type Scenario = Awaited<ReturnType<typeof seedScenario>>;

/**
 * An approved patch against a registered local repository: the repository, its base commit, a diff
 * produced the way the pipeline produces one (and stored as a hashed blob), the verification run, and
 * a bare remote named origin.
 */
async function seedScenario(
	options: {
		approved?: boolean;
		outcome?: Outcome;
		extra?: Record<string, string>;
		/** Stored instead of the diff built from the fixture, for diffs no pipeline would write. */
		rawDiff?: string;
		workspaceId?: string;
		userId?: string;
	} = {},
) {
	const approved = options.approved ?? true;
	const outcome = options.outcome ?? "verified";
	const workspaceId = options.workspaceId ?? owner.workspaceId;
	const userId = options.userId ?? owner.userId;

	const repoDir = mkdtempSync(path.join(ctx.repoRoot, "app-"));
	git(repoDir, "init", "-b", "main");
	mkdirSync(path.join(repoDir, "src"));
	writeFileSync(path.join(repoDir, "src/total.js"), TOTAL);
	writeFileSync(path.join(repoDir, "README.md"), "# demo\n");
	git(repoDir, "add", "--all");
	git(repoDir, "commit", "-m", "base");
	const baseCommit = git(repoDir, "rev-parse", "HEAD");
	const remoteDir = mkdtempSync(path.join(tmpdir(), "tracera-remote-"));
	git(remoteDir, "init", "--bare", "-b", "main");
	git(repoDir, "remote", "add", "origin", remoteDir);

	const scratch = mkdtempSync(path.join(tmpdir(), "tracera-work-"));
	const work = path.join(scratch, "work");
	git(scratch, "clone", "--quiet", repoDir, work);
	writeFileSync(path.join(work, "src/total.js"), FIXED_TOTAL);
	writeFileSync(
		path.join(work, "src/format.js"),
		"export const money = (n) => n.toFixed(2);\n",
	);
	for (const [file, content] of Object.entries(options.extra ?? {}))
		writeFileSync(path.join(work, file), content);
	const staged = await stageAndDiff(work);
	if (!staged.ok) throw new Error("the fixture diff could not be built");
	const blob = await putBlob(
		path.join(ctx.config.dataDir, "blobs"),
		Buffer.from(options.rawDiff ?? staged.diff),
	);

	const repositoryId = newId("repo");
	await ctx.db.insert(repositories).values({
		id: repositoryId,
		workspaceId,
		name: path.basename(repoDir),
		sourceType: "local_path",
		sourceRef: realpathSync(repoDir),
		defaultBranch: "main",
		commands: { install: "npm ci", test: "npm test" },
		createdBy: userId,
	});
	const bugId = newId("bug");
	await ctx.db.insert(bugReports).values({
		id: bugId,
		workspaceId,
		repositoryId,
		sourceChannel: "web",
		title: "Cart total ignores quantity",
		description: "The total adds prices without multiplying by quantity.",
		createdBy: userId,
	});
	const investigationId = newId("inv");
	await ctx.db.insert(investigations).values({
		id: investigationId,
		workspaceId,
		bugReportId: bugId,
		repositoryId,
		commitSha: baseCommit,
		status: "completed",
		mode: "full",
		progress: { stage_index: 10, stage_count: 10, message: "Completed" },
		configSnapshot: {},
		createdBy: userId,
	});
	const hypothesisId = newId("hyp");
	await ctx.db.insert(hypotheses).values({
		id: hypothesisId,
		investigationId,
		handle: "H1",
		rank: 1,
		title: "Quantity is ignored",
		mechanism: "total() sums prices only",
		locations: [],
		supporting: [],
		contradicting: [],
		alternatives: [],
		nextCheck: "Run the cart tests",
		confidence: "medium",
		confidenceRationale: "Seen in the code",
		state: "supported",
	});
	const patchId = newId("pat");
	const verificationId = newId("ver");
	await ctx.db.insert(patchProposals).values({
		id: patchId,
		investigationId,
		hypothesisId,
		attempt: 1,
		status: approved ? "approved" : "proposed",
		baseCommit,
		edits: [],
		files: staged.files,
		diffSha256: blob.sha256,
		diffBytes: blob.size,
		summary: "Multiply price by quantity in the cart total",
		rationale: "The reduce ignored item.qty.",
		expectedEffect: "Totals include quantities.",
		risks: [],
		approval: approved
			? {
					decision: "approved",
					verification_id: verificationId,
					outcome_at_decision: outcome,
					comment: null,
					acknowledged_risks: [],
					decided_by: userId,
					decided_at: new Date().toISOString(),
				}
			: null,
	});
	await ctx.db.insert(verificationRuns).values({
		id: verificationId,
		investigationId,
		patchId,
		status: "completed",
		outcome,
		outcomeReasons: outcome === "verified" ? [] : ["no_baseline_comparison"],
		checks: [],
		startedAt: new Date(),
		finishedAt: new Date(),
	});
	return {
		repoDir,
		remoteDir,
		repositoryId,
		patchId,
		baseCommit,
		outcome,
		diff: options.rawDiff ?? staged.diff,
		diffSha256: blob.sha256,
		branch: `tracera/${patchId}`,
	};
}

const actionsUrl = (s: Scenario) => `/api/v1/patches/${s.patchId}/actions`;
const authorize = (s: Scenario) => ({
	acknowledged_outcome: s.outcome,
	acknowledged_risks: true,
});
const act = (
	s: Scenario,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
) => session("POST", actionsUrl(s), { ...authorize(s), ...body }, headers);
const rows = (s: Scenario) =>
	ctx.db
		.select()
		.from(authorizedActions)
		.where(eq(authorizedActions.patchId, s.patchId));
const audits = (action: string) =>
	ctx.db.select().from(auditEvents).where(eq(auditEvents.action, action));
const pushBody = (remote_branch = "fix/total") => ({
	kind: "push",
	remote: "origin",
	remote_branch,
});

describe("applying an approved patch to the working tree", () => {
	it("writes only the patch's files, reports them from git, and audits it", async () => {
		const s = await seedScenario();
		const response = await act(s, { kind: "apply" });
		expect(response.statusCode).toBe(201);
		const { action } = response.json();
		AuthorizedActionSchema.parse(action);
		expect(action).toMatchObject({
			kind: "apply",
			status: "succeeded",
			requested_by: owner.userId,
			acknowledged_outcome: "verified",
			error_code: null,
		});
		expect(action.id).toMatch(/^act_[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(action.result.head_commit).toBe(s.baseCommit);
		expect(action.result.changed_files).toEqual(
			expect.arrayContaining([
				{ path: "src/total.js", status: "modified" },
				{ path: "src/format.js", status: "added" },
			]),
		);
		expect(read(s.repoDir, "src/total.js")).toBe(FIXED_TOTAL);
		expect(status(s.repoDir).split("\n").sort()).toEqual([
			" M src/total.js",
			"?? src/format.js",
		]);
		const [event] = await audits("publication.apply");
		expect(event).toMatchObject({
			actorType: "user",
			actorId: owner.userId,
			targetType: "patch",
			targetId: s.patchId,
		});
		expect(event?.metadata).toMatchObject({
			action_id: action.id,
			status: "succeeded",
			files_changed: 2,
		});
		expect(JSON.stringify(event?.metadata)).not.toContain("item.qty");

		const list = (await session("GET", actionsUrl(s))).json() as {
			target: { path: string; local: boolean; suggested_branch: string };
			items: Array<{ id: string }>;
		};
		expect(list.items.map((item) => item.id)).toEqual([action.id]);
		expect(list.target).toMatchObject({
			local: true,
			path: realpathSync(s.repoDir),
			suggested_branch: s.branch,
		});
		const one = await session("GET", `/api/v1/actions/${action.id}`);
		expect(one.json().action.id).toBe(action.id);
	});

	it("refuses to write over uncommitted changes to a file it would change", async () => {
		const s = await seedScenario();
		const dirty = `${TOTAL}// my work in progress\n`;
		writeFileSync(path.join(s.repoDir, "src/total.js"), dirty);
		const response = await act(s, { kind: "apply" });
		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({
			code: "working_tree_dirty",
			action_id: expect.stringMatching(/^act_/),
		});
		expect(read(s.repoDir, "src/total.js")).toBe(dirty);
		expect(existsSync(path.join(s.repoDir, "src/format.js"))).toBe(false);
		const [row] = await rows(s);
		expect(row).toMatchObject({
			status: "refused",
			errorCode: "working_tree_dirty",
		});
		const [event] = await audits("publication.apply");
		expect(event?.metadata).toMatchObject({
			status: "refused",
			error_code: "working_tree_dirty",
		});
	});

	it("leaves unrelated uncommitted work alone", async () => {
		const s = await seedScenario();
		writeFileSync(path.join(s.repoDir, "README.md"), "# demo, edited\n");
		const response = await act(s, { kind: "apply" });
		expect(response.statusCode).toBe(201);
		expect(read(s.repoDir, "README.md")).toBe("# demo, edited\n");
		expect(status(s.repoDir).split("\n")).toContain(" M README.md");
	});

	it("writes nothing when the patch no longer applies", async () => {
		const s = await seedScenario();
		writeFileSync(
			path.join(s.repoDir, "src/total.js"),
			"export const total = () => 0;\n",
		);
		git(s.repoDir, "commit", "-am", "rewrite total");
		const response = await act(s, { kind: "apply" });
		expect(response.statusCode).toBe(409);
		expect(response.json().code).toBe("patch_does_not_apply");
		expect(existsSync(path.join(s.repoDir, "src/format.js"))).toBe(false);
		expect(status(s.repoDir)).toBe("");
	});

	it.each([
		[
			"a symbolic link",
			[
				"diff --git a/link b/link",
				"new file mode 120000",
				"index 0000000..e69de29",
				"--- /dev/null",
				"+++ b/link",
				"@@ -0,0 +1 @@",
				"+target",
				"",
			].join("\n"),
		],
		[
			"inside .git",
			[
				"diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit",
				"new file mode 100755",
				"index 0000000..e69de29",
				"--- /dev/null",
				"+++ b/.git/hooks/pre-commit",
				"@@ -0,0 +1 @@",
				"+echo pwned",
				"",
			].join("\n"),
		],
	])("refuses a stored diff that writes %s", async (_name, rawDiff) => {
		const s = await seedScenario({ rawDiff });
		for (const kind of ["apply", "commit"]) {
			const response = await act(s, { kind });
			expect(response.statusCode).toBe(422);
			expect(response.json().code).toBe("diff_invalid");
		}
		expect(status(s.repoDir)).toBe("");
		expect(existsSync(path.join(s.repoDir, "link"))).toBe(false);
		expect(existsSync(path.join(s.repoDir, ".git/hooks/pre-commit"))).toBe(
			false,
		);
		expect(git(s.repoDir, "branch", "--list", "tracera/*")).toBe("");
	});

	it("refuses a stored diff that no longer matches its recorded hash", async () => {
		const s = await seedScenario();
		const blob = path.join(
			ctx.config.dataDir,
			"blobs",
			"sha256",
			s.diffSha256.slice(0, 2),
			s.diffSha256.slice(2, 4),
			s.diffSha256,
		);
		writeFileSync(blob, s.diff.replace("item.qty", "item.quantity"));
		const response = await act(s, { kind: "apply" });
		expect(response.statusCode).toBe(409);
		expect(response.json().code).toBe("diff_integrity_failed");
		expect(status(s.repoDir)).toBe("");
		const download = await session(
			"GET",
			`/api/v1/patches/${s.patchId}/download`,
		);
		expect(download.statusCode).toBe(409);
	});
});

describe("committing to a new branch", () => {
	it("builds the commit from the verified base and never touches the checkout", async () => {
		const s = await seedScenario();
		// The checkout has moved on, has uncommitted work, and an untracked file: none of it may change.
		writeFileSync(path.join(s.repoDir, "NOTES.md"), "later work\n");
		git(s.repoDir, "add", "NOTES.md");
		git(s.repoDir, "commit", "-m", "later work");
		const head = git(s.repoDir, "rev-parse", "HEAD");
		writeFileSync(path.join(s.repoDir, "README.md"), "# demo, edited\n");
		writeFileSync(path.join(s.repoDir, "scratch.txt"), "untracked\n");
		const before = status(s.repoDir);
		const leftovers = () =>
			readdirSync(tmpdir()).filter((name) =>
				name.startsWith("tracera-action-"),
			);
		const tempBefore = leftovers();

		const response = await act(s, {
			kind: "commit",
			message: "Multiply price by quantity",
		});
		expect(response.statusCode).toBe(201);
		const { action } = response.json();
		AuthorizedActionSchema.parse(action);
		expect(action).toMatchObject({ kind: "commit", status: "succeeded" });
		expect(action.result.branch).toBe(s.branch);
		const sha: string = action.result.commit_sha;
		expect(git(s.repoDir, "rev-parse", s.branch)).toBe(sha);
		expect(git(s.repoDir, "rev-parse", `${sha}^`)).toBe(s.baseCommit);
		expect(git(s.repoDir, "show", `${s.branch}:src/total.js`)).toBe(
			FIXED_TOTAL.trim(),
		);
		expect(git(s.repoDir, "show", `${s.branch}:src/format.js`)).toContain(
			"toFixed",
		);
		expect(
			git(s.repoDir, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", sha),
		).toBe(
			"owner <owner@example.com>|owner <owner@example.com>|Multiply price by quantity",
		);
		expect(action.result.changed_files).toEqual(
			expect.arrayContaining([
				{ path: "src/total.js", status: "modified" },
				{ path: "src/format.js", status: "added" },
			]),
		);

		expect(git(s.repoDir, "rev-parse", "HEAD")).toBe(head);
		expect(git(s.repoDir, "branch", "--show-current")).toBe("main");
		expect(status(s.repoDir)).toBe(before);
		expect(read(s.repoDir, "src/total.js")).toBe(TOTAL);
		expect(git(s.repoDir, "worktree", "list").split("\n")).toHaveLength(1);
		expect(leftovers()).toEqual(tempBefore);
		const [event] = await audits("publication.commit");
		expect(event?.metadata).toMatchObject({
			status: "succeeded",
			commit_sha: sha,
			branch: s.branch,
		});
	});

	it("uses the requested branch name and message, and refuses a branch that exists", async () => {
		const s = await seedScenario();
		const first = await act(s, {
			kind: "commit",
			branch: "fix/cart-total",
			message: "Fix the cart total",
		});
		expect(first.statusCode).toBe(201);
		expect(first.json().action.result.branch).toBe("fix/cart-total");
		const again = await act(s, { kind: "commit", branch: "fix/cart-total" });
		expect(again.statusCode).toBe(409);
		expect(again.json().code).toBe("branch_exists");
		const invalid = await act(s, { kind: "commit", branch: "-fix" });
		expect(invalid.statusCode).toBe(400);
		git(s.repoDir, "branch", "tracera");
		const clash = await act(s, { kind: "commit" });
		expect(clash.statusCode).toBe(422);
		expect(clash.json().code).toBe("invalid_branch_name");
		expect(git(s.repoDir, "branch", "--list", "tracera/*")).toBe("");
		expect(git(s.repoDir, "worktree", "list").split("\n")).toHaveLength(1);
	});

	it.each([
		[
			"a credential in an added line",
			{ "src/config.js": `export const key = "${AWS_KEY}";\n` },
		],
		[
			"a private key",
			{
				"src/key.js": [
					"const k = `",
					PRIVATE_KEY_BEGIN,
					"\nabc\n-----END RSA PRIVATE KEY-----`;\n",
				].join(""),
			},
		],
		["an .env file", { ".env": "MODE=development\n" }],
	])("creates no branch when the diff adds %s", async (_name, extra) => {
		const s = await seedScenario({ extra });
		const response = await act(s, { kind: "commit" });
		expect(response.statusCode).toBe(422);
		expect(response.json().code).toBe("secret_detected");
		expect(JSON.stringify(response.json())).not.toContain(AWS_KEY);
		expect(git(s.repoDir, "branch", "--list", "tracera/*")).toBe("");
		const [row] = await rows(s);
		expect(row).toMatchObject({
			status: "refused",
			errorCode: "secret_detected",
		});
	});
});

describe("pushing the committed branch", () => {
	it("pushes the commit Tracera created to a named remote branch, from git's own output", async () => {
		const s = await seedScenario();
		const commit = (await act(s, { kind: "commit" })).json().action;
		// With no message of the user's own, the commit says what was observed, not more.
		expect(git(s.repoDir, "log", "-1", "--format=%B", s.branch)).toBe(
			`Multiply price by quantity in the cart total\n\nTracera patch ${s.patchId}; verification outcome: verified.`,
		);
		const before = status(s.repoDir);
		const response = await act(s, pushBody());
		expect(response.statusCode).toBe(201);
		const { action } = response.json();
		AuthorizedActionSchema.parse(action);
		expect(action).toMatchObject({
			kind: "push",
			status: "succeeded",
			params: { remote: "origin", remote_branch: "fix/total" },
		});
		expect(action.result).toMatchObject({
			commit_sha: commit.result.commit_sha,
			branch: s.branch,
			remote: "origin",
			pushed_ref: "refs/heads/fix/total",
		});
		expect(git(s.remoteDir, "rev-parse", "refs/heads/fix/total")).toBe(
			commit.result.commit_sha,
		);
		expect(git(s.remoteDir, "branch", "--list").replace(/[ *]/g, "")).toBe(
			"fix/total",
		);
		expect(status(s.repoDir)).toBe(before);
		expect((await audits("publication.push"))[0]?.metadata).toMatchObject({
			status: "succeeded",
			pushed_ref: "refs/heads/fix/total",
		});
	});

	it("needs a commit first, and an existing remote", async () => {
		const s = await seedScenario();
		const early = await act(s, pushBody());
		expect(early.statusCode).toBe(409);
		expect(early.json().code).toBe("commit_required");
		await act(s, { kind: "commit" });
		const missing = await act(s, { ...pushBody(), remote: "elsewhere" });
		expect(missing.statusCode).toBe(422);
		expect(missing.json().code).toBe("remote_not_found");
		expect(git(s.remoteDir, "branch", "--list")).toBe("");
	});

	it("refuses to push to a default branch, however it is learned", async () => {
		const s = await seedScenario();
		await act(s, { kind: "commit" });
		for (const branch of ["main", "master"]) {
			const response = await act(s, pushBody(branch));
			expect(response.statusCode).toBe(422);
			expect(response.json().code).toBe("default_branch_refused");
		}
		// The remote's own default, as git recorded it locally, is refused too.
		git(
			s.repoDir,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/trunk",
		);
		const trunk = await act(s, pushBody("trunk"));
		expect(trunk.statusCode).toBe(422);
		expect(trunk.json().code).toBe("default_branch_refused");
		expect(git(s.remoteDir, "branch", "--list")).toBe("");
	});

	it("reports a non-fast-forward rejection by its code and never forces", async () => {
		const s = await seedScenario();
		await act(s, { kind: "commit" });
		// Someone else already put unrelated work on the remote branch.
		const other = mkdtempSync(path.join(tmpdir(), "tracera-other-"));
		git(other, "init", "-b", "main");
		writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
		git(other, "add", "--all");
		git(other, "commit", "-m", "theirs");
		git(other, "push", s.remoteDir, "HEAD:refs/heads/fix/total");
		const theirs = git(s.remoteDir, "rev-parse", "refs/heads/fix/total");

		const response = await act(s, pushBody());
		expect(response.statusCode).toBe(409);
		expect(response.json().code).toBe("non_fast_forward");
		expect(git(s.remoteDir, "rev-parse", "refs/heads/fix/total")).toBe(theirs);
		const pushes = (await rows(s)).filter((row) => row.kind === "push");
		expect(pushes).toHaveLength(1);
		expect(pushes[0]).toMatchObject({
			status: "failed",
			errorCode: "non_fast_forward",
		});
	});

	it("reports an unreachable remote without exposing the credentials in its URL", async () => {
		const s = await seedScenario();
		git(
			s.repoDir,
			"remote",
			"add",
			"dead",
			"http://dev:hunter2-secret-value@127.0.0.1:9/x.git",
		);
		await act(s, { kind: "commit" });
		const response = await act(s, { ...pushBody(), remote: "dead" });
		expect(response.statusCode).toBe(502);
		expect(response.json().code).toBe("push_failed");
		const stored = JSON.stringify([
			await rows(s),
			await audits("publication.push"),
		]);
		for (const text of [response.body, stored])
			expect(text).not.toContain("hunter2-secret-value");
	});

	it("refuses to push a branch that no longer points at the commit Tracera made", async () => {
		const s = await seedScenario();
		const commit = (await act(s, { kind: "commit" })).json().action;
		git(s.repoDir, "update-ref", `refs/heads/${s.branch}`, s.baseCommit);
		const response = await act(s, pushBody());
		expect(response.statusCode).toBe(409);
		expect(response.json().code).toBe("branch_changed");
		expect(git(s.remoteDir, "branch", "--list")).toBe("");
		expect(commit.result.commit_sha).not.toBe(s.baseCommit);
	});
});

describe("repository code never runs on the host", () => {
	const quote = (value: string) => `"${value.replaceAll("\\", "/")}"`;

	/** Hooks, content filters, a file system monitor, and a signing program that each leave a marker. */
	function plant(repoDir: string, tools: string, markers: string) {
		const script = path.join(tools, "mark.mjs");
		writeFileSync(
			script,
			'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], "x");\nif (process.argv[3] === "filter") process.stdin.pipe(process.stdout);\n',
		);
		const command = (name: string, filter = false) =>
			`${quote(process.execPath)} ${quote(script)} ${quote(path.join(markers, name))}${filter ? " filter" : ""}`;
		for (const hook of [
			"pre-commit",
			"commit-msg",
			"post-commit",
			"pre-push",
			"reference-transaction",
		]) {
			const file = path.join(repoDir, ".git", "hooks", hook);
			writeFileSync(file, `#!/bin/sh\n${command(hook)}\nexit 0\n`);
			chmodSync(file, 0o755);
		}
		const signer = path.join(tools, "signer");
		writeFileSync(signer, `#!/bin/sh\n${command("gpg")}\nexit 1\n`);
		chmodSync(signer, 0o755);
		writeFileSync(path.join(repoDir, ".gitattributes"), "*.js filter=mark\n");
		git(repoDir, "config", "filter.mark.clean", command("filter-clean", true));
		git(
			repoDir,
			"config",
			"filter.mark.smudge",
			command("filter-smudge", true),
		);
		git(repoDir, "config", "core.fsmonitor", command("fsmonitor"));
		git(repoDir, "config", "commit.gpgsign", "true");
		git(repoDir, "config", "gpg.program", signer.replaceAll("\\", "/"));
	}

	it("does not run hooks, filters, the file system monitor, or signing for apply, commit, or push", async () => {
		const tools = mkdtempSync(path.join(tmpdir(), "tracera-tools-"));

		// Control: the same mechanisms do fire when git runs unprotected on this machine.
		const controlMarkers = mkdtempSync(path.join(tmpdir(), "tracera-control-"));
		const control = mkdtempSync(path.join(tmpdir(), "tracera-control-repo-"));
		git(control, "init", "-b", "main");
		plant(control, tools, controlMarkers);
		writeFileSync(path.join(control, "a.js"), "x\n");
		git(control, "add", "a.js");
		git(control, "commit", "-m", "control");
		expect(readdirSync(controlMarkers)).toEqual(
			expect.arrayContaining([
				"pre-commit",
				"commit-msg",
				"post-commit",
				"filter-clean",
			]),
		);

		const s = await seedScenario();
		const markers = mkdtempSync(path.join(tmpdir(), "tracera-markers-"));
		plant(s.repoDir, tools, markers);
		const applied = await act(s, { kind: "apply" });
		expect(applied.statusCode, applied.body).toBe(201);
		const committed = await act(s, { kind: "commit" });
		expect(committed.statusCode, committed.body).toBe(201);
		const pushed = await act(s, pushBody());
		expect(pushed.statusCode, pushed.body).toBe(201);
		expect(readdirSync(markers)).toEqual([]);
	});
});

describe("who may authorize, and what they must acknowledge", () => {
	it("refuses personal and MCP tokens before looking at the request, with no effect", async () => {
		const s = await seedScenario();
		const script = await createToken(ctx, cookie, {
			name: "script",
			client_kind: "script",
			scopes: [
				"investigations:read",
				"investigations:write",
				"reports:read",
				"reports:write",
				"verifications:write",
				"repositories:read",
			],
		});
		const mcp = await createToken(ctx, cookie, {
			name: "mcp",
			client_kind: "mcp",
		});
		for (const token of [script, mcp]) {
			const response = await asToken(ctx, token)("POST", actionsUrl(s), {
				kind: "apply",
				...authorize(s),
			});
			expect(response.statusCode).toBe(403);
			expect(response.json().code).toBe("session_required");
		}
		expect(await rows(s)).toEqual([]);
		expect(status(s.repoDir)).toBe("");
	});

	it("requires the CSRF header and a same-origin request for the cookie", async () => {
		const s = await seedScenario();
		const body = { kind: "apply", ...authorize(s) };
		const bare = await ctx.app.inject({
			method: "POST",
			url: actionsUrl(s),
			headers: { cookie },
			payload: body,
		});
		expect(bare.statusCode).toBe(403);
		expect(bare.json().code).toBe("csrf_failed");
		const foreign = await ctx.app.inject({
			method: "POST",
			url: actionsUrl(s),
			headers: { cookie, ...csrf(ctx.config), origin: "https://evil.example" },
			payload: body,
		});
		expect(foreign.statusCode).toBe(403);
		expect(await rows(s)).toEqual([]);
	});

	it("is for workspace owners; a member cannot authorize actions on the host", async () => {
		const s = await seedScenario();
		await addMember(ctx.db, owner.workspaceId);
		const member = asSession(ctx, await login(ctx, "member@example.com"));
		const response = await member("POST", actionsUrl(s), {
			kind: "apply",
			...authorize(s),
		});
		expect(response.statusCode).toBe(403);
		expect(response.json().code).toBe("owner_required");
		expect(status(s.repoDir)).toBe("");
	});

	it("answers 404 on every route for another workspace's patch and action", async () => {
		const s = await seedScenario();
		const made = (await act(s, { kind: "apply" })).json().action;
		await createOwner(ctx.db, "other@example.com");
		const other = asSession(ctx, await login(ctx, "other@example.com"));
		const responses = await Promise.all([
			other("POST", actionsUrl(s), { kind: "apply", ...authorize(s) }),
			other("GET", actionsUrl(s)),
			other("GET", `/api/v1/actions/${made.id}`),
			other("GET", `/api/v1/patches/${s.patchId}/download`),
		]);
		for (const response of responses) {
			expect(response.statusCode).toBe(404);
			expect(response.json().code).toBe("not_found");
		}
		expect(await rows(s)).toHaveLength(1);
	});

	it("refuses a missing or different acknowledgement of the verification outcome", async () => {
		const s = await seedScenario({ outcome: "partially_verified" });
		for (const body of [
			{ kind: "apply" },
			{
				kind: "apply",
				acknowledged_outcome: "verified",
				acknowledged_risks: true,
			},
		]) {
			const response = await session("POST", actionsUrl(s), body);
			expect(response.statusCode).toBe(422);
			expect(response.json().code).toBe("acknowledgement_mismatch");
		}
		const risks = await session("POST", actionsUrl(s), {
			kind: "apply",
			acknowledged_outcome: "partially_verified",
			acknowledged_risks: false,
		});
		expect(risks.statusCode).toBe(422);
		expect(risks.json().code).toBe("risks_not_acknowledged");
		expect(status(s.repoDir)).toBe("");
		expect((await rows(s)).map((row) => row.status)).toEqual([
			"refused",
			"refused",
			"refused",
		]);

		const accepted = await act(s, { kind: "apply" });
		expect(accepted.statusCode).toBe(201);
		expect(accepted.json().action.acknowledged_outcome).toBe(
			"partially_verified",
		);
	});

	it("refuses an unapproved patch, and offers no download of it", async () => {
		const s = await seedScenario({ approved: false });
		const response = await act(s, { kind: "apply" });
		expect(response.statusCode).toBe(409);
		expect(response.json().code).toBe("invalid_state");
		const download = await session(
			"GET",
			`/api/v1/patches/${s.patchId}/download`,
		);
		expect(download.statusCode).toBe(409);
		expect(status(s.repoDir)).toBe("");
	});

	it("refuses a repository that was not registered from a local path", async () => {
		const s = await seedScenario();
		await ctx.db
			.update(repositories)
			.set({ sourceType: "fixture" })
			.where(eq(repositories.id, s.repositoryId));
		const response = await act(s, { kind: "apply" });
		expect(response.statusCode).toBe(422);
		expect(response.json().code).toBe("repository_not_local");
		const list = (await session("GET", actionsUrl(s))).json();
		expect(list.target).toMatchObject({ local: false, path: null });
	});

	it("refuses a registered path that has left the allowed roots", async () => {
		const s = await seedScenario();
		const outside = mkdtempSync(path.join(tmpdir(), "tracera-outside-"));
		git(outside, "init", "-b", "main");
		await ctx.db
			.update(repositories)
			.set({ sourceRef: realpathSync(outside) })
			.where(eq(repositories.id, s.repositoryId));
		const response = await act(s, { kind: "apply" });
		expect(response.statusCode).toBe(422);
		expect(response.json().code).toBe("repository_path_not_allowed");
	});
});

describe("one action at a time, and safe retries", () => {
	it("allows one running action per repository and clears a stale one", async () => {
		const s = await seedScenario();
		const running = {
			id: newId("act"),
			workspaceId: owner.workspaceId,
			patchId: s.patchId,
			repositoryId: s.repositoryId,
			kind: "apply" as const,
			status: "running" as const,
			requestedBy: owner.userId,
			acknowledgedRisks: true,
		};
		await ctx.db.insert(authorizedActions).values(running);
		const busy = await act(s, { kind: "apply" });
		expect(busy.statusCode).toBe(409);
		expect(busy.json().code).toBe("action_in_progress");
		expect(status(s.repoDir)).toBe("");

		await ctx.db
			.update(authorizedActions)
			.set({ createdAt: new Date(Date.now() - 60 * 60_000) })
			.where(eq(authorizedActions.id, running.id));
		const cleared = await act(s, { kind: "apply" });
		expect(cleared.statusCode).toBe(201);
		const [stale] = await ctx.db
			.select()
			.from(authorizedActions)
			.where(and(eq(authorizedActions.id, running.id)));
		expect(stale).toMatchObject({ status: "failed", errorCode: "interrupted" });
	});

	it("lets only one of two simultaneous requests change the repository", async () => {
		const s = await seedScenario();
		const responses = await Promise.all([
			act(s, { kind: "apply" }),
			act(s, { kind: "apply" }),
		]);
		expect(responses.map((response) => response.statusCode).sort()).toEqual([
			201, 409,
		]);
		const refused = responses.find((response) => response.statusCode === 409);
		expect(["action_in_progress", "working_tree_dirty"]).toContain(
			refused?.json().code,
		);
		expect(read(s.repoDir, "src/total.js")).toBe(FIXED_TOTAL);
		expect((await rows(s)).map((row) => row.status).sort()).toEqual([
			"refused",
			"succeeded",
		]);
	});

	it("replays a repeated Idempotency-Key instead of acting twice", async () => {
		const s = await seedScenario();
		const headers = { "idempotency-key": "commit-1" };
		const first = await act(s, { kind: "commit" }, headers);
		const second = await act(s, { kind: "commit" }, headers);
		expect(first.statusCode).toBe(201);
		expect(second.statusCode).toBe(200);
		expect(second.json().action.id).toBe(first.json().action.id);
		expect(await rows(s)).toHaveLength(1);
		const reused = await act(s, { kind: "commit", message: "other" }, headers);
		expect(reused.statusCode).toBe(409);
		expect(reused.json().code).toBe("idempotency_key_reused");
	});

	it("replays a refusal as the same refusal", async () => {
		const s = await seedScenario();
		writeFileSync(path.join(s.repoDir, "src/total.js"), `${TOTAL}// wip\n`);
		const headers = { "idempotency-key": "apply-1" };
		const first = await act(s, { kind: "apply" }, headers);
		const second = await act(s, { kind: "apply" }, headers);
		expect(first.statusCode).toBe(409);
		expect(second.statusCode).toBe(409);
		expect(second.json().code).toBe("working_tree_dirty");
		expect(second.json().action_id).toBe(first.json().action_id);
		expect(await rows(s)).toHaveLength(1);
	});
});

describe("downloading the approved patch", () => {
	it("serves the reviewed diff as a patch attachment", async () => {
		const s = await seedScenario();
		const response = await session(
			"GET",
			`/api/v1/patches/${s.patchId}/download`,
		);
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toBe(
			"text/x-patch; charset=utf-8",
		);
		expect(response.headers["content-disposition"]).toBe(
			`attachment; filename="tracera-${s.patchId}.patch"`,
		);
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.body).toBe(s.diff);
	});
});
