import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// The E2E fixture repository: a tiny library with one real bug (string prices are concatenated, not
// added). Created fresh for each E2E stack, outside the Tracera tree, so the investigation pipeline,
// the sandbox, and verification run against real code. Shared by the stack and the fixture provider.

export const FIXTURE_FILES: Record<string, string> = {
	"package.json": `${JSON.stringify({ name: "tiny-api", type: "module", scripts: { test: "node --test" } })}\n`,
	"src/math.js": [
		"export function add(a, b) {",
		"\treturn a + b;",
		"}",
		"",
		"export function total(items) {",
		"\treturn items.reduce((sum, item) => add(sum, item.price), 0);",
		"}",
		"",
	].join("\n"),
	"src/math.test.js": [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { total } from "./math.js";',
		"",
		'test("total sums prices", () => assert.equal(total([{ price: 2 }, { price: 3 }]), 5));',
		"",
	].join("\n"),
};

/** The buggy line, its fix, and a reproduction test that fails before the fix and passes after it. */
export const BUG = {
	file: "src/math.js",
	marker: "add(sum, item.price)",
	fix: {
		path: "src/math.js",
		search: "add(sum, item.price)",
		replace: "add(sum, Number(item.price))",
	},
	reproTest: [
		'import assert from "node:assert/strict";',
		'import { test } from "node:test";',
		'import { total } from "../../src/math.js";',
		"",
		'test("string prices are added as numbers", () => {',
		'\tassert.equal(total([{ price: "2" }, { price: 3 }]), 5);',
		"});",
		"",
	].join("\n"),
};

/**
 * Scenario markers in a bug report's title select what the fixture provider returns, so one fixture
 * repository can drive every journey: a reproducible bug that verification can confirm, and the same
 * patch without a reproduction (never `verified`).
 */
export const SCENARIO = {
	verified: "[e2e:verified]",
	unverified: "[e2e:unverified]",
} as const;

/**
 * Creates the fixture as a git repository in `dir` with a realistic history (deterministic author and
 * dates): a correct first version, then a "simplification" that introduced the bug. Tracera never
 * treats the root commit as a change, so the regression commit is the observed history evidence.
 */
export function createFixtureRepository(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const write = (files: Record<string, string>) => {
		for (const [file, content] of Object.entries(files)) {
			const target = path.join(dir, ...file.split("/"));
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	};
	const commit = (message: string, date: string) => {
		const env = {
			...process.env,
			GIT_AUTHOR_NAME: "Tiny API Dev",
			GIT_AUTHOR_EMAIL: "dev@tiny-api.example",
			GIT_COMMITTER_NAME: "Tiny API Dev",
			GIT_COMMITTER_EMAIL: "dev@tiny-api.example",
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
		};
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
		git("add", "-A");
		git("-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
	};
	execFileSync("git", ["init", "-q", "-b", "main"], {
		cwd: dir,
		stdio: "pipe",
	});
	write({
		...FIXTURE_FILES,
		[BUG.file]: (FIXTURE_FILES[BUG.file] ?? "").replace(
			BUG.fix.search,
			BUG.fix.replace,
		),
	});
	commit("Initial tiny api", "2026-10-01T09:00:00Z");
	write(FIXTURE_FILES);
	commit("Simplify total", "2026-10-08T09:00:00Z");
	return dir;
}
