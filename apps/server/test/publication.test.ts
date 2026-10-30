import { describe, expect, it } from "vitest";
import { pushArgs, pushFailure } from "../src/modules/publication.ts";

describe("pushArgs", () => {
	const FORBIDDEN = [
		"--force",
		"-f",
		"--force-with-lease",
		"--mirror",
		"--delete",
		"-d",
		"--prune",
		"--all",
		"--tags",
	];

	it.each([
		["tracera/pat_1", "origin", "fix/total"],
		["fix/a", "upstream", "tracera/pat_1"],
		["a", "o", "b"],
	])(
		"pushes one named branch with no force or delete form (%s to %s %s)",
		(local, remote, remoteBranch) => {
			const args = pushArgs(local, remote, remoteBranch);
			expect(args.filter((arg) => FORBIDDEN.includes(arg))).toEqual([]);
			const refspec = args.at(-1) ?? "";
			expect(refspec).toBe(`refs/heads/${local}:refs/heads/${remoteBranch}`);
			expect(refspec.startsWith("+")).toBe(false);
			expect(refspec.startsWith(":")).toBe(false);
			expect(args.slice(0, 5)).toEqual([
				"push",
				"--porcelain",
				"--no-verify",
				"--no-recurse-submodules",
				"--",
			]);
			// Everything after "--" is data: the remote and exactly one refspec.
			expect(args.slice(5)).toEqual([remote, refspec]);
		},
	);
});

describe("pushFailure", () => {
	it.each([
		[
			"! [rejected] x -> y (non-fast-forward)\nerror: failed to push some refs",
			"non_fast_forward",
		],
		["! [rejected] x -> y (fetch first)", "non_fast_forward"],
		[
			"hint: Updates were rejected because the tip of your current branch is behind",
			"non_fast_forward",
		],
		[
			"fatal: Authentication failed for 'https://github.com/o/r.git/'",
			"remote_auth_failed",
		],
		[
			"git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
			"remote_auth_failed",
		],
		[
			"fatal: could not read Username for 'https://github.com': terminal prompts disabled",
			"remote_auth_failed",
		],
		[
			"remote: error: GH006: Protected branch update failed for refs/heads/x.",
			"remote_rejected",
		],
		[
			"! [remote rejected] x -> y (pre-receive hook declined)",
			"remote_rejected",
		],
		[
			"fatal: unable to access 'https://h/x.git/': Could not resolve host: h",
			"push_failed",
		],
	])("maps %j to %s", (output, code) => {
		expect(pushFailure(output, false).code).toBe(code);
	});

	it("reports a timeout as a failed push", () => {
		expect(pushFailure("", true).code).toBe("push_failed");
	});

	it("keeps credentials out of the line it reports", () => {
		// Assembled at run time, so the source holds no token-shaped literal.
		const token = ["gh", "p_0123456789abcdefghijklmnopqrstuvwxyzAB"].join("");
		const error = pushFailure(
			`fatal: unable to access 'https://dev:${token}@host/x.git/': Failed to connect`,
			false,
		);
		expect(error.code).toBe("push_failed");
		expect(error.message).toContain("Failed to connect");
		expect(error.message).not.toContain("ghp_0123");
		expect(error.message).not.toContain("dev:");
	});
});
