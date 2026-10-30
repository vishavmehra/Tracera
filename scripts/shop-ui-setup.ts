// Materializes the Shop UI demo fixture (fixtures/shop-ui) as a git repository that can be registered as
// a local-path repository. History: a correct first version, then a refactor that plants the bug (an
// order of exactly $50.00 is charged shipping although the page promises free shipping from $50).
// Re-running rebuilds identical commits.
//
//   node scripts/shop-ui-setup.ts [directory]    default: <first TRACERA_REPO_ROOTS entry>/shop-ui
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { isPathInside } from "../apps/server/src/lib/fs.ts";
import { applyEdit, deterministicRepo, type Edit } from "./bench-setup.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "fixtures/shop-ui");

/** How a repository for this fixture is registered (POST /api/v1/repositories). */
export const SHOP_UI_REPOSITORY = {
	name: "shop-ui",
	commands: {
		install: "npm ci --ignore-scripts",
		test: "npm test",
		start: "npm run start",
	},
	app: { port: 4173, ready_path: "/health", base_url_path: "/cart" },
} as const;

/** The planted regression: `>=` becomes `>`, so a subtotal of exactly $50.00 is charged shipping. */
export const REGRESSION: { message: string; edit: Edit } = {
	message: "refactor: simplify the free shipping check",
	edit: {
		path: "src/pricing.js",
		search:
			"\tif (subtotal >= FREE_SHIPPING_THRESHOLD_CENTS) return 0;\n\treturn STANDARD_SHIPPING_CENTS;",
		replace:
			"\treturn subtotal > FREE_SHIPPING_THRESHOLD_CENTS ? 0 : STANDARD_SHIPPING_CENTS;",
	},
};

/** The one-line fix, as the search/replace a patch has to make on the regressed file. */
export const FIX: Edit = {
	path: "src/pricing.js",
	search: "subtotal > FREE_SHIPPING_THRESHOLD_CENTS ? 0",
	replace: "subtotal >= FREE_SHIPPING_THRESHOLD_CENTS ? 0",
};

/** Rebuilds the repository at `target`; only a directory this script made before may be replaced. */
export function setupShopUi(target: string): {
	path: string;
	base: string;
	regression: string;
} {
	if (!path.isAbsolute(target) || isPathInside(ROOT, target))
		throw new Error(
			"The Shop UI repository must be an absolute path outside the Tracera source tree",
		);
	const manifest = path.join(target, "package.json");
	if (existsSync(target)) {
		const previous = existsSync(manifest)
			? (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string })
			: null;
		if (previous?.name !== "shop-ui")
			throw new Error(
				`Refusing to replace ${target}: it is not a Shop UI repository`,
			);
		rmSync(target, { recursive: true, force: true });
	}
	cpSync(SOURCE, target, { recursive: true });
	const { git, commit } = deterministicRepo(target, {
		name: "Lumen Goods Dev",
		email: "dev@lumen-goods.example",
	});
	git("init", "--quiet", "--initial-branch=main");
	commit("feat: cart page with free shipping");
	const base = git("rev-parse", "HEAD");
	applyEdit(target, REGRESSION.edit);
	commit(REGRESSION.message);
	return { path: target, base, regression: git("rev-parse", "HEAD") };
}

if (import.meta.main) {
	const root = process.env.TRACERA_REPO_ROOTS?.split(";")[0]?.trim();
	const target = process.argv[2] ?? (root ? path.join(root, "shop-ui") : null);
	if (!target) {
		console.error(
			"Pass a directory, or set TRACERA_REPO_ROOTS so the repository is created inside it",
		);
		process.exit(1);
	}
	const result = setupShopUi(path.resolve(target));
	console.log(`Shop UI demo repository: ${result.path}`);
	console.log(
		`  main  ${result.regression}  (planted bug: free shipping at exactly $50.00)`,
	);
	console.log(
		`  Register it as a local_path repository with ${JSON.stringify(SHOP_UI_REPOSITORY)}`,
	);
}
