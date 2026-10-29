import { describe, expect, it } from "vitest";
import {
	buildGraph,
	type Manifest,
	packageExports,
} from "../src/modules/graph-build.ts";
import {
	extractFile,
	type FileExtraction,
} from "../src/modules/graph-extract.ts";

// Workspace packages imported by name [static analysis, no execution]: `import { x } from "@shop/core"`
// must link to the module Node would load from the package's manifest, exactly as a relative import
// does, or every cross-package call in a monorepo silently disappears from the graph.

const manifest = (
	file: string,
	name: string,
	extra: Partial<Manifest> = {},
): Manifest => ({
	path: file,
	name,
	scripts: {},
	dependencies: {},
	devDependencies: {},
	main: null,
	bin: [],
	type: "module",
	...extra,
});

function graphOf(files: Record<string, string>, manifests: Manifest[]) {
	const extractions = new Map<string, FileExtraction>();
	for (const [file, source] of Object.entries(files))
		extractions.set(file, extractFile(file, source));
	const graph = buildGraph({
		repositoryName: "shop",
		commitSha: "c".repeat(40),
		files: [...Object.keys(files), ...manifests.map((m) => m.path)].map(
			(file) => ({ path: file, size: 1, object: `obj-${file}` }),
		),
		skipped: {},
		extractions,
		manifests,
		commits: [],
		codeowners: [],
		docs: [],
		limits: { truncatedFiles: [] },
	});
	const edges = (kind: string) =>
		graph.edges
			.filter((edge) => edge.kind === kind)
			.map(
				(edge) =>
					`${edge.from} -> ${edge.to ?? `?${edge.target_text}`} ${edge.certainty}`,
			);
	return { graph, edges };
}

const CORE = {
	"packages/core/src/money.ts":
		"export function formatCents(n: number) { return String(n); }\n",
	"packages/core/src/index.ts": 'export { formatCents } from "./money.ts";\n',
};
const API = {
	"packages/api/src/checkout.ts":
		'import { formatCents } from "@shop/core";\nexport function totalLine() { return formatCents(1); }\n',
};

describe("workspace package imports", () => {
	it("normalizes `exports` to candidate targets per subpath, in condition order", () => {
		expect(packageExports("./src/index.ts")).toEqual({
			".": ["./src/index.ts"],
		});
		expect(
			packageExports({ types: "./dist/index.d.ts", import: "./src/index.ts" }),
		).toEqual({ ".": ["./dist/index.d.ts", "./src/index.ts"] });
		expect(
			packageExports({
				".": { node: { import: "./src/index.ts" }, default: "./dist/i.js" },
				"./money": ["./src/money.ts"],
				"./internal": null,
			}),
		).toEqual({
			".": ["./src/index.ts", "./dist/i.js"],
			"./money": ["./src/money.ts"],
			"./internal": [],
		});
		expect(packageExports(undefined)).toBeUndefined();
		expect(packageExports(7)).toBeUndefined();
	});

	it("links a call through a package name to its definition via the `exports` entry", () => {
		const { edges } = graphOf({ ...CORE, ...API }, [
			manifest("packages/core/package.json", "@shop/core", {
				exports: { ".": ["./src/index.ts"] },
			}),
			manifest("packages/api/package.json", "@shop/api"),
		]);
		expect(edges("IMPORTS")).toEqual([
			"file:packages/api/src/checkout.ts -> file:packages/core/src/index.ts resolved",
		]);
		expect(edges("CALLS")).toEqual([
			"sym:packages/api/src/checkout.ts#totalLine -> sym:packages/core/src/money.ts#formatCents resolved",
		]);
	});

	it("falls back to `main`, then `index`, and resolves subpaths inside a package without `exports`", () => {
		const files = {
			...CORE,
			"packages/api/src/a.ts":
				'import { formatCents } from "@shop/core";\nimport { formatCents as f } from "@shop/core/src/money";\nexport function a() { return formatCents(1) + f(2); }\n',
		};
		for (const main of ["src/index.ts", "./src/index.js", null]) {
			const index: Record<string, string> =
				main === null
					? { "packages/core/index.ts": 'export * from "./src/index.ts";\n' }
					: {};
			const { edges } = graphOf({ ...files, ...index }, [
				manifest("packages/core/package.json", "@shop/core", { main }),
			]);
			expect(edges("IMPORTS")).toContain(
				`file:packages/api/src/a.ts -> file:packages/core/${main === null ? "index.ts" : "src/index.ts"} resolved`,
			);
			expect(edges("IMPORTS")).toContain(
				"file:packages/api/src/a.ts -> file:packages/core/src/money.ts resolved",
			);
			expect(edges("CALLS")).toEqual([
				"sym:packages/api/src/a.ts#a -> sym:packages/core/src/money.ts#formatCents resolved",
			]);
		}
	});

	it("keeps the package-level import when the entry is not in the repository, and never guesses", () => {
		const { edges } = graphOf({ ...CORE, ...API }, [
			manifest("packages/core/package.json", "@shop/core", {
				main: "dist/index.js",
				exports: { ".": ["./dist/index.js"] },
			}),
		]);
		expect(edges("IMPORTS")).toEqual([
			"file:packages/api/src/checkout.ts -> pkg:packages/core resolved",
		]);
		expect(edges("CALLS")).toEqual([]);
	});

	it("does not resolve a subpath the `exports` map does not list", () => {
		const { edges } = graphOf(
			{
				...CORE,
				"packages/api/src/a.ts":
					'import { formatCents } from "@shop/core/src/money";\nexport function a() { return formatCents(1); }\n',
			},
			[
				manifest("packages/core/package.json", "@shop/core", {
					exports: { ".": ["./src/index.ts"] },
				}),
			],
		);
		expect(edges("IMPORTS")).toEqual([
			"file:packages/api/src/a.ts -> pkg:packages/core resolved",
		]);
		expect(edges("CALLS")).toEqual([]);
	});

	it("reports a name the package definitely does not export as a broken reference", () => {
		const { edges } = graphOf(
			{
				...CORE,
				"packages/api/src/a.ts":
					'import { toCents } from "@shop/core";\nexport function a() { return toCents(1); }\n',
			},
			[
				manifest("packages/core/package.json", "@shop/core", {
					exports: { ".": ["./src/index.ts"] },
				}),
			],
		);
		expect(edges("CALLS")).toEqual([
			"sym:packages/api/src/a.ts#a -> ?toCents unresolved",
		]);
	});
});
