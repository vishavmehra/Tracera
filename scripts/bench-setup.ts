// Materializes the Bench Shop fixture as a git repository under TRACERA_DATA_DIR/fixtures/bench-shop.
// Reset procedure: re-run `npm run bench:setup`; it deletes and rebuilds the repository with identical,
// deterministic commits (fixed author, committer, and dates). The answer key stays in eval/bench-shop.
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "../apps/server/src/config.ts";
import { isPathInside } from "../apps/server/src/lib/fs.ts";

type Edit = { path: string; search: string; replace: string };
export type BenchManifest = {
	fixture: string;
	source_dir: string;
	repository: { name: string; commands: { install: string; test: string } };
	base_commits: Array<{ message: string; paths: string[] }>;
	cases: Array<{
		id: string;
		category: string;
		branch: string;
		commits: Array<{ message: string; edits: Edit[] }>;
		report: {
			title: string;
			description: string;
			expected_behavior: string;
			actual_behavior: string;
			steps: string[];
		};
		gold: { path: string; marker: string } | null;
		expected_baseline: string[];
		hidden_tests: string[];
	}>;
};

const ROOT = path.resolve(import.meta.dirname, "..");

export function loadManifest(): BenchManifest {
	return JSON.parse(
		readFileSync(path.join(ROOT, "eval/bench-shop/manifest.json"), "utf8"),
	) as BenchManifest;
}

/** Applies one search/replace edit; the search text must occur exactly once. */
function applyEdit(repo: string, edit: Edit) {
	const file = path.join(repo, edit.path);
	const content = readFileSync(file, "utf8");
	const first = content.indexOf(edit.search);
	if (first === -1 || content.indexOf(edit.search, first + 1) !== -1)
		throw new Error(`Edit for ${edit.path} must match exactly once`);
	writeFileSync(
		file,
		content.replace(edit.search, () => edit.replace),
	);
}

export function setupBenchShop(dataDir: string): {
	path: string;
	branches: Record<string, string>;
} {
	const manifest = loadManifest();
	const fixturesDir = path.join(dataDir, "fixtures");
	const target = path.join(fixturesDir, manifest.fixture);
	if (!isPathInside(fixturesDir, target) || target === fixturesDir)
		throw new Error("Refusing to write outside the fixtures directory");
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });

	let tick = 0;
	const noHooks = path.join(os.tmpdir(), "tracera-no-hooks");
	const git = (...args: string[]) => {
		const date = new Date(
			Date.UTC(2026, 9, 1, 9, 0, 0) + tick * 86_400_000,
		).toISOString();
		return execFileSync(
			"git",
			[
				"-c",
				`core.hooksPath=${noHooks}`,
				"-c",
				"core.autocrlf=false",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{
				cwd: target,
				stdio: "pipe",
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_AUTHOR_NAME: "Bench Shop Dev",
					GIT_AUTHOR_EMAIL: "dev@bench-shop.example",
					GIT_COMMITTER_NAME: "Bench Shop Dev",
					GIT_COMMITTER_EMAIL: "dev@bench-shop.example",
					GIT_AUTHOR_DATE: date,
					GIT_COMMITTER_DATE: date,
				},
			},
		)
			.toString()
			.trim();
	};
	const commit = (message: string) => {
		git("add", "--all");
		git("commit", "--quiet", "--message", message);
		tick += 1;
	};

	git("init", "--quiet", "--initial-branch=main");
	const source = path.join(ROOT, manifest.source_dir);
	for (const base of manifest.base_commits) {
		for (const file of base.paths) {
			const to = path.join(target, file);
			mkdirSync(path.dirname(to), { recursive: true });
			writeFileSync(to, readFileSync(path.join(source, file)));
		}
		commit(base.message);
	}
	for (const testCase of manifest.cases) {
		if (testCase.branch === "main") continue;
		git("checkout", "--quiet", "-b", testCase.branch, "main");
		for (const change of testCase.commits) {
			for (const edit of change.edits) applyEdit(target, edit);
			commit(change.message);
		}
		git("checkout", "--quiet", "main");
	}
	const branches: Record<string, string> = {};
	for (const testCase of manifest.cases)
		branches[testCase.branch] = git("rev-parse", testCase.branch);
	return { path: target, branches };
}

if (import.meta.main) {
	const dataDir = resolveDataDir(process.env);
	const result = setupBenchShop(dataDir);
	console.log(`Bench Shop repository: ${result.path}`);
	for (const [branch, sha] of Object.entries(result.branches))
		console.log(`  ${branch.padEnd(20)} ${sha}`);
	if (!existsSync(path.join(result.path, ".git")))
		throw new Error("Repository was not created");
}
