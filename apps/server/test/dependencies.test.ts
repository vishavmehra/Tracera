import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	dependencyKey,
	type FileReader,
	npmErrorCode,
	planDependencies,
	validateNpmLockfile,
} from "../src/modules/dependencies.ts";

// Dependency preparation policy [pure]: what Tracera agrees to install, decided from the
// manifests and lockfile alone, before any container starts.

const REGISTRY = new URL("https://registry.npmjs.org/");
const sri = (seed: string) =>
	`sha512-${createHash("sha512").update(seed).digest("base64")}`;
const tarball = (name: string, version: string) =>
	`https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;

const MANIFEST = {
	name: "shop",
	version: "1.0.0",
	dependencies: { "left-pad": "^1.3.0" },
	devDependencies: { "is-number": "^7.0.0" },
};
const lockfile = (
	packages: Record<string, unknown> = {},
	root: Record<string, unknown> = {},
	version = 3,
) =>
	JSON.stringify({
		name: "shop",
		lockfileVersion: version,
		packages: {
			"": {
				name: "shop",
				version: "1.0.0",
				dependencies: { "left-pad": "^1.3.0" },
				devDependencies: { "is-number": "^7.0.0" },
				...root,
			},
			"node_modules/left-pad": {
				version: "1.3.0",
				resolved: tarball("left-pad", "1.3.0"),
				integrity: sri("left-pad"),
			},
			"node_modules/is-number": {
				version: "7.0.0",
				resolved: tarball("is-number", "7.0.0"),
				integrity: sri("is-number"),
				dev: true,
			},
			...packages,
		},
	});

describe("validateNpmLockfile", () => {
	it("accepts registry tarballs pinned by sha512 and in sync with package.json", () => {
		expect(validateNpmLockfile(lockfile(), MANIFEST, REGISTRY)).toEqual({
			ok: true,
			version: 3,
			packages: 2,
			folders: [],
		});
	});

	it("accepts bundled packages and workspaces linked inside the repository", () => {
		const check = validateNpmLockfile(
			lockfile({
				"node_modules/left-pad/node_modules/inner": {
					version: "1.0.0",
					inBundle: true,
				},
				"packages/core": { name: "@shop/core", version: "1.0.0" },
				"node_modules/@shop/core": { resolved: "packages/core", link: true },
			}),
			MANIFEST,
			REGISTRY,
		);
		expect(check).toMatchObject({ ok: true, folders: ["packages/core"] });
	});

	it.each([
		["invalid JSON", "{", "lockfile_invalid"],
		["lockfile version 1", lockfile({}, {}, 1), "lockfile_version_unsupported"],
		[
			"a package from another host",
			lockfile({
				"node_modules/evil": {
					version: "1.0.0",
					resolved: "https://evil.example.com/evil/-/evil-1.0.0.tgz",
					integrity: sri("evil"),
				},
			}),
			"dependency_source_not_allowed",
		],
		[
			"a git dependency",
			lockfile({
				"node_modules/from-git": {
					version: "1.0.0",
					resolved: "git+ssh://git@github.com/x/y.git#abc",
					integrity: sri("git"),
				},
			}),
			"dependency_source_not_allowed",
		],
		[
			"a plain-HTTP tarball for an HTTPS registry",
			lockfile({
				"node_modules/plain": {
					version: "1.0.0",
					resolved: "http://registry.npmjs.org/plain/-/plain-1.0.0.tgz",
					integrity: sri("plain"),
				},
			}),
			"dependency_source_not_allowed",
		],
		[
			"a tarball URL with credentials",
			lockfile({
				"node_modules/creds": {
					version: "1.0.0",
					resolved:
						"https://user:token@registry.npmjs.org/creds/-/creds-1.0.0.tgz",
					integrity: sri("creds"),
				},
			}),
			"dependency_source_not_allowed",
		],
		[
			"a package without a resolved tarball",
			lockfile({ "node_modules/loose": { version: "1.0.0" } }),
			"dependency_source_not_allowed",
		],
		[
			"a sha1-only integrity",
			lockfile({
				"node_modules/old": {
					version: "1.0.0",
					resolved: tarball("old", "1.0.0"),
					integrity: "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=",
				},
			}),
			"integrity_missing",
		],
		[
			"a local package outside the repository",
			lockfile({ "../outside": { version: "1.0.0" } }),
			"workspace_path_invalid",
		],
		[
			"a link out of the repository",
			lockfile({
				"node_modules/linked": { resolved: "/etc", link: true },
			}),
			"dependency_source_not_allowed",
		],
		[
			"a dependency missing from the lockfile root",
			lockfile({}, { dependencies: {} }),
			"lockfile_out_of_sync",
		],
		[
			"a different version range in the lockfile root",
			lockfile({}, { dependencies: { "left-pad": "^1.0.0" } }),
			"lockfile_out_of_sync",
		],
	])("rejects %s", (_label, text, code) => {
		const check = validateNpmLockfile(text, MANIFEST, REGISTRY);
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.code).toBe(code);
	});

	it("requires tarballs under a registry's base path", () => {
		const mirror = new URL("https://mirror.example.com/npm/");
		const ok = (resolved: string) =>
			validateNpmLockfile(
				JSON.stringify({
					lockfileVersion: 3,
					packages: {
						"": { dependencies: { a: "1.0.0" } },
						"node_modules/a": { resolved, integrity: sri("a") },
					},
				}),
				{ dependencies: { a: "1.0.0" } },
				mirror,
			).ok;
		expect(ok("https://mirror.example.com/npm/a/-/a-1.0.0.tgz")).toBe(true);
		expect(ok("https://mirror.example.com/other/a/-/a-1.0.0.tgz")).toBe(false);
	});

	it("reports every problem, capped, with the first code", () => {
		const check = validateNpmLockfile(
			lockfile({
				"node_modules/a": { version: "1.0.0" },
				"node_modules/b": { version: "1.0.0" },
			}),
			MANIFEST,
			REGISTRY,
		);
		expect(check).toMatchObject({
			ok: false,
			code: "dependency_source_not_allowed",
		});
		if (!check.ok) expect(check.errors.length).toBeGreaterThanOrEqual(2);
	});
});

const reader =
	(files: Record<string, string>): FileReader =>
	async (file) =>
		files[file] ?? null;

describe("planDependencies", () => {
	it("needs nothing without package.json or without dependencies", async () => {
		expect(await planDependencies(reader({}), REGISTRY)).toEqual({
			required: false,
			reason: "no_package_json",
		});
		expect(
			await planDependencies(
				reader({ "package.json": JSON.stringify({ name: "x" }) }),
				REGISTRY,
			),
		).toEqual({ required: false, reason: "no_dependencies" });
	});

	it("plans an npm install with the hashes that identify its inputs", async () => {
		const plan = await planDependencies(
			reader({
				"package.json": JSON.stringify(MANIFEST),
				"package-lock.json": lockfile(),
			}),
			REGISTRY,
		);
		expect(plan).toMatchObject({
			required: true,
			ok: true,
			manager: "npm",
			lockfile: { path: "package-lock.json", version: 3, packages: 2 },
		});
		if (plan.required && plan.ok)
			expect(plan.manifests.map((m) => m.path)).toEqual(["package.json"]);
	});

	it("prefers npm-shrinkwrap.json and reads workspace manifests", async () => {
		const lock = lockfile({
			"packages/core": { name: "@shop/core", version: "1.0.0" },
			"node_modules/@shop/core": { resolved: "packages/core", link: true },
		});
		const plan = await planDependencies(
			reader({
				"package.json": JSON.stringify({
					...MANIFEST,
					workspaces: ["packages/*"],
				}),
				"npm-shrinkwrap.json": lock,
				"package-lock.json": "{}",
				"packages/core/package.json": JSON.stringify({ name: "@shop/core" }),
			}),
			REGISTRY,
		);
		expect(plan).toMatchObject({
			ok: true,
			lockfile: { path: "npm-shrinkwrap.json" },
		});
		if (plan.required && plan.ok)
			expect(plan.manifests.map((m) => m.path)).toEqual([
				"package.json",
				"packages/core/package.json",
			]);
	});

	it.each([
		[
			"dependencies without a lockfile",
			{ "package.json": JSON.stringify(MANIFEST) },
			"lockfile_missing",
		],
		[
			"a yarn repository",
			{ "package.json": JSON.stringify(MANIFEST), "yarn.lock": "# yarn" },
			"unsupported_package_manager",
		],
		[
			"a declared pnpm package manager",
			{
				"package.json": JSON.stringify({
					...MANIFEST,
					packageManager: "pnpm@9.0.0",
				}),
				"package-lock.json": lockfile(),
			},
			"unsupported_package_manager",
		],
		[
			"an invalid package.json",
			{ "package.json": "{nope" },
			"manifest_invalid",
		],
		[
			"a workspace whose package.json is missing",
			{
				"package.json": JSON.stringify(MANIFEST),
				"package-lock.json": lockfile({
					"packages/core": { version: "1.0.0" },
				}),
			},
			"lockfile_invalid",
		],
	])("refuses %s", async (_label, files, code) => {
		const plan = await planDependencies(reader(files), REGISTRY);
		expect(plan).toMatchObject({ required: true, ok: false, code });
	});
});

describe("dependencyKey", () => {
	const base = {
		repositoryId: "repo_a",
		image: "node@sha256:abc",
		registry: REGISTRY.href,
		lockfile: { path: "package-lock.json", sha256: "1".repeat(64) },
		manifests: [
			{ path: "package.json", sha256: "2".repeat(64) },
			{ path: "packages/core/package.json", sha256: "3".repeat(64) },
		],
	};

	it("does not depend on manifest order", () => {
		expect(
			dependencyKey({ ...base, manifests: [...base.manifests].reverse() }),
		).toBe(dependencyKey(base));
	});

	it.each([
		["the repository", { repositoryId: "repo_b" }],
		["the image", { image: "node@sha256:def" }],
		["the registry", { registry: "https://mirror.example.com/" }],
		[
			"the lockfile",
			{ lockfile: { path: "package-lock.json", sha256: "9".repeat(64) } },
		],
		[
			"a manifest",
			{ manifests: [{ path: "package.json", sha256: "8".repeat(64) }] },
		],
	])("changes with %s", (_label, change) => {
		expect(dependencyKey({ ...base, ...change })).not.toBe(dependencyKey(base));
	});
});

describe("npmErrorCode", () => {
	it.each([
		["npm error code EINTEGRITY\nnpm error sha512-...", "EINTEGRITY"],
		["npm ERR! code E404\nnpm ERR! 404 Not Found", "E404"],
		["all good", null],
	])("reads %j", (output, code) => {
		expect(npmErrorCode(output)).toBe(code);
	});
});
