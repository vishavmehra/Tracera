import path from "node:path";
import {
	CODE_LANGUAGES,
	EXTRACTOR_VERSION,
	type FileExtraction,
	joinRoutePath,
	languageOf,
	PARSED_LANGUAGES,
	TEST_FILE,
} from "./graph-extract.ts";

// Linking for the Repository Knowledge Graph: per-file extractions become
// nodes and edges. An edge exists only when its target resolves through bindings, exports (including
// barrels), class hierarchies, route mounts, or URL matching; anything else is an explicit unresolved
// edge or a counted gap. Every edge carries its certainty and where in the source it came from.

export type Certainty = "exact" | "resolved" | "heuristic" | "unresolved";
export type GraphNode = {
	key: string;
	kind: string;
	name: string;
	path: string | null;
	start_line: number | null;
	end_line: number | null;
	language: string | null;
	attributes: Record<string, unknown>;
	provenance: Record<string, unknown>;
};
export type GraphEdge = {
	kind: string;
	from: string;
	to: string | null;
	target_text: string | null;
	certainty: Certainty;
	provenance: Record<string, unknown>;
};
export type Manifest = {
	path: string;
	name: string | null;
	scripts: Record<string, string>;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	main: string | null;
	bin: string[];
	type: string | null;
	workspaces?: string[];
	/** `exports` as subpath → targets in declared condition order (see `packageExports`). */
	exports?: Record<string, string[]>;
};
export type DocSection = {
	path: string;
	heading: string;
	slug: string;
	start_line: number;
	end_line: number;
	mentions: string[];
};

const RESOLVE_EXTENSIONS = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
];
const NODE_BUILTINS = new Set(
	"assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib test sqlite".split(
		" ",
	),
);
const FRAMEWORKS = new Map([
	["react", "React"],
	["next", "Next.js"],
	["vue", "Vue"],
	["nuxt", "Nuxt"],
	["svelte", "Svelte"],
	["@angular/core", "Angular"],
	["express", "Express"],
	["fastify", "Fastify"],
	["koa", "Koa"],
	["hono", "Hono"],
	["@nestjs/core", "NestJS"],
	["vite", "Vite"],
	["webpack", "webpack"],
	["jest", "Jest"],
	["vitest", "Vitest"],
	["mocha", "Mocha"],
	["drizzle-orm", "Drizzle ORM"],
	["prisma", "Prisma"],
	["@prisma/client", "Prisma"],
	["typeorm", "TypeORM"],
	["sequelize", "Sequelize"],
	["mongoose", "Mongoose"],
	["pg", "node-postgres"],
	["tailwindcss", "Tailwind CSS"],
	["zod", "Zod"],
	["axios", "axios"],
	["react-router", "React Router"],
	["react-router-dom", "React Router"],
	["pg-boss", "pg-boss"],
	["bullmq", "BullMQ"],
]);
const BUILD_TOOLS: Array<[RegExp, string]> = [
	[/\btsc\b/, "TypeScript compiler (tsc)"],
	[/\bvite\b/, "Vite"],
	[/\bwebpack\b/, "webpack"],
	[/\brollup\b/, "Rollup"],
	[/\besbuild\b/, "esbuild"],
	[/\btsup\b/, "tsup"],
	[/\bturbo\b/, "Turborepo"],
	[/\bnx\b/, "Nx"],
	[/\bnext build\b/, "Next.js"],
	[/\bparcel\b/, "Parcel"],
];
const BUILD_FILES: Array<[RegExp, string]> = [
	[/(^|\/)vite\.config\.[cm]?[jt]s$/, "Vite"],
	[/(^|\/)webpack\.config\.[cm]?[jt]s$/, "webpack"],
	[/(^|\/)rollup\.config\.[cm]?[jt]s$/, "Rollup"],
	[/(^|\/)turbo\.json$/, "Turborepo"],
	[/(^|\/)nx\.json$/, "Nx"],
	[/(^|\/)Makefile$/, "Make"],
	[/(^|\/)Dockerfile$/, "Docker"],
	[/(^|\/)(docker-)?compose\.ya?ml$/, "Docker Compose"],
	[/(^|\/)tsconfig\.json$/, "TypeScript compiler (tsc)"],
];
const TEST_TOOLS: Array<[string, string]> = [
	["node:test", "node:test"],
	["vitest", "Vitest"],
	["jest", "Jest"],
	["@jest/globals", "Jest"],
	["mocha", "Mocha"],
	["@playwright/test", "Playwright"],
	["cypress", "Cypress"],
];
const HTTP_VERBS = new Set([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
]);

/** Package name of a bare specifier: "a/b" → "a", "@s/a/b" → "@s/a". */
const packageOf = (specifier: string) => {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? "");
};

export function resolveSpecifier(
	importer: string,
	specifier: string,
	files: ReadonlySet<string>,
): string | null {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
	const base = path.posix.normalize(
		path.posix.join(path.posix.dirname(importer), specifier),
	);
	if (base.startsWith("../")) return null;
	const candidates = [
		base,
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.js$/, ".tsx"),
		base.replace(/\.mjs$/, ".mts"),
		base.replace(/\.cjs$/, ".cts"),
		base.replace(/\.jsx$/, ".tsx"),
		...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
		...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
	];
	return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/**
 * A manifest's `exports` field as subpath → candidate targets, nested conditions and fallback arrays
 * flattened in declared order (`null` excludes a subpath: no targets). An object without "." keys is
 * the root's conditions. Undefined when the field is absent or not an exports value.
 */
export function packageExports(
	value: unknown,
): Record<string, string[]> | undefined {
	const flatten = (entry: unknown, depth: number): string[] =>
		typeof entry === "string"
			? [entry]
			: depth > 4 || !entry || typeof entry !== "object"
				? []
				: (Array.isArray(entry) ? entry : Object.values(entry))
						.flatMap((inner) => flatten(inner, depth + 1))
						.slice(0, 20);
	if (typeof value === "string" || Array.isArray(value))
		return { ".": flatten(value, 0) };
	if (!value || typeof value !== "object") return undefined;
	const entries = Object.entries(value);
	if (!entries.some(([key]) => key.startsWith(".")))
		return { ".": flatten(value, 0) };
	return Object.fromEntries(
		entries
			.filter(([key]) => key.startsWith("."))
			.slice(0, 200)
			.map(([key, target]) => [key, flatten(target, 0)]),
	);
}

/** CODEOWNERS pattern → matcher (gitignore-style subset: anchors, `*`, `**`, trailing `/`). */
export function codeownersMatcher(pattern: string): (file: string) => boolean {
	const anchored = pattern.startsWith("/");
	let body = pattern.replace(/^\//, "");
	const directory = body.endsWith("/");
	body = body.replace(/\/$/, "");
	const regex = body
		.split("**")
		.map((part) =>
			part
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, "[^/]*")
				.replace(/\?/g, "[^/]"),
		)
		.join(".*");
	const prefix = anchored || body.includes("/") ? "^" : "(^|.*/)";
	const compiled = new RegExp(`${prefix}${regex}${directory ? "/" : "(/|$)"}`);
	return (file) => compiled.test(file);
}

/** Route paths compared by shape: `:id`, `{id}`, `[id]`, `[...slug]` all become `:param`. */
export function canonicalRoutePath(routePath: string): string {
	const clean = routePath.split(/[?#]/)[0] ?? routePath;
	return (
		clean
			.split("/")
			.map((segment) =>
				/^(:.+|\{.+\}|\[.+\])$/.test(segment) ? ":param" : segment,
			)
			.join("/")
			.replace(/\/+$/, "") || "/"
	);
}

export type GraphInput = {
	repositoryName: string;
	commitSha: string;
	files: Array<{ path: string; size: number | null; object: string }>;
	skipped: Record<string, string[]>;
	extractions: Map<string, FileExtraction>;
	manifests: Manifest[];
	commits: Array<{
		sha: string;
		date: string;
		subject: string;
		files: string[];
	}>;
	codeowners: Array<{ pattern: string; owners: string[] }>;
	docs: DocSection[];
	limits: { truncatedFiles: string[] };
};

export type RepositoryProfile = {
	commit_sha: string;
	tracked_files: number;
	indexed_files: number;
	size_bytes: number;
	files_by_language: Record<string, number>;
	languages: { parsed: string[]; unparsed: string[] };
	directories: number;
	packages: Array<{
		name: string | null;
		path: string;
		dependencies: number;
		dev_dependencies: number;
		scripts: string[];
	}>;
	workspaces: string[];
	test_files: number;
	test_cases: number;
	symbols: Record<string, number>;
	test_commands: string[];
	build_commands: string[];
	build_systems: Array<{ name: string; evidence: string }>;
	test_frameworks: Array<{ name: string; evidence: string }>;
	entry_points: string[];
	frameworks: Array<{ name: string; evidence: string; imported_by: number }>;
	surface: {
		routes: number;
		pages: number;
		db_tables: number;
		external_services: number;
		config_keys: number;
		events: number;
		queues: number;
	};
	history: {
		commits_indexed: number;
		latest: { sha: string; date: string; subject: string } | null;
	};
	counting_rules: string[];
};

export type GraphCoverage = {
	complete: boolean;
	extractor_version: string;
	parsed_files: number;
	parse_failures: Array<{ path: string; message: string; line: number | null }>;
	unsupported_code_files: Record<string, number>;
	skipped: Record<string, number>;
	unresolved: {
		imports: number;
		calls: number;
		member_calls: number;
		requests: number;
		route_handlers: number;
		routes_with_unknown_prefix: number;
	};
	unsupported_patterns: Record<string, number>;
	extracted_node_kinds: string[];
	extracted_edge_kinds: string[];
	unsupported_edge_kinds: string[];
	edge_counts: Record<string, number>;
	edge_support: Record<string, string>;
	consistency: { dangling_edges: number; dropped: string[] };
	truncated_files: string[];
	notes: string[];
};

/** Node kinds that are code definitions (they have line ranges inside one file). */
export const SYMBOL_KINDS = [
	"function",
	"class",
	"method",
	"variable",
	"interface",
	"type_alias",
	"enum",
	"ui_component",
	"hook",
] as const;

export const EXTRACTED_EDGE_KINDS = [
	"CONTAINS",
	"DEFINES",
	"IMPORTS",
	"RE_EXPORTS",
	"DEPENDS_ON",
	"CALLS",
	"REFERENCES",
	"IMPLEMENTS",
	"EXTENDS",
	"RENDERS",
	"HANDLES_EVENT",
	"SENDS_REQUEST_TO",
	"ROUTES_TO",
	"READS_FROM",
	"WRITES_TO",
	"PUBLISHES",
	"SUBSCRIBES_TO",
	"TESTS",
	"CONFIGURED_BY",
	"INTRODUCED_OR_CHANGED_BY",
	"OWNED_BY",
	"DOCUMENTED_BY",
] as const;
/** Relationship kinds the extractor never produces (none today; kept so the contract stays explicit). */
export const UNSUPPORTED_EDGE_KINDS: readonly string[] = [];

/** What each relationship kind covers, and what it does not (reported with every snapshot). */
export const EDGE_SUPPORT: Record<string, string> = {
	CALLS:
		"Direct calls to imported or file-level functions; method calls through `this`, `super`, typed parameters and fields, `new` instances, class statics, object-literal members, and namespace imports. Calls on untyped values and on call results are counted, not linked; calls through an interface also get heuristic edges to implementing classes.",
	RE_EXPORTS:
		"`export { x } from`, `export * from`, and `export * as ns from`; imports are resolved through barrels (10 levels).",
	EXTENDS:
		"Class and interface `extends` clauses resolved to repository types.",
	ROUTES_TO:
		"Express, Fastify, Hono, and Koa Router registrations with literal paths; mount prefixes from `use`, `route`, and `register`; Next.js file routes and pages; React Router `<Route>` elements and route objects. Routes whose mount prefix cannot be resolved keep a file-qualified key.",
	SENDS_REQUEST_TO:
		"`fetch`, `axios` (including `axios.create` clients, also imported ones), and `XMLHttpRequest.open` with literal or template URLs, matched to routes by method and path shape; absolute URLs to other hosts become external services.",
	HANDLES_EVENT:
		"JSX `on*` attributes and `addEventListener` with a handler Tracera can name; inline handlers get their own symbols.",
	PUBLISHES:
		"pg-boss `send`/`publish` and BullMQ `queue.add` (resolved); EventEmitter `emit` with literal or constant names (heuristic).",
	SUBSCRIBES_TO:
		"pg-boss `work`/`subscribe` and BullMQ `Worker` (resolved); EventEmitter `on`/`once` (heuristic). Generic DOM, stream, and process events are ignored.",
	READS_FROM:
		"Drizzle `from` and joins on table objects, Prisma model reads, and SQL text passed to query APIs or `sql` templates.",
	WRITES_TO:
		"Drizzle `insert`/`update`/`delete`, Prisma model writes, SQL text, and `ALTER`/`DROP TABLE` in SQL files (schema changes).",
	CONFIGURED_BY:
		"`process.env.X`, `process.env['X']`, `import.meta.env.X`, and destructuring from `process.env`. Dynamic keys are counted, not linked.",
};

const toSlug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 80);

/** Path-like tokens ("src/a.js", "./b.ts", "README.md"); trailing sentence dots are trimmed. */
const PATH_TOKEN = /[\w@.-]+(?:\/[\w@.-]+)*/g;

/**
 * Markdown headings as sections, with the tracked paths each section names as a whole token. One pass
 * over the text plus a set lookup per token, so cost grows with document size, not with repo size.
 */
export function docSections(
	file: string,
	text: string,
	trackedPaths: ReadonlySet<string>,
): DocSection[] {
	const lines = text.split("\n");
	const headings: Array<{ heading: string; line: number }> = [];
	let fenced = false;
	lines.forEach((line, i) => {
		if (/^\s*```/.test(line)) fenced = !fenced;
		const match = !fenced ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
		if (match?.[2]) headings.push({ heading: match[2], line: i + 1 });
	});
	return headings.map((heading, i) => {
		const end = (headings[i + 1]?.line ?? lines.length + 1) - 1;
		const mentions = new Set<string>();
		for (let line = heading.line - 1; line < end && mentions.size < 50; line++)
			for (const match of (lines[line] ?? "").matchAll(PATH_TOKEN)) {
				const token = match[0].replace(/^\.\//, "").replace(/\.+$/, "");
				if (token !== file && trackedPaths.has(token)) mentions.add(token);
			}
		return {
			path: file,
			heading: heading.heading.slice(0, 200),
			slug: `${toSlug(heading.heading)}-${heading.line}`,
			start_line: heading.line,
			end_line: end,
			mentions: [...mentions].slice(0, 50),
		};
	});
}

type SymbolRef = { file: string; name: string };
type Binding = { file: string; exported: string } | { namespace: string };
type Resolved = SymbolRef | { namespace: string };
const isNamespace = (
	value: Resolved | Binding,
): value is { namespace: string } => "namespace" in value;

/** Next.js routing from file paths: `[id]` → `:id`, `[...slug]` → `:slug*`, groups and slots dropped. */
function nextSegments(dirs: string[]): string {
	const segments = dirs
		.filter((segment) => !/^\(.+\)$/.test(segment) && !segment.startsWith("@"))
		.map((segment) =>
			segment
				.replace(/^\[\[?\.\.\.(.+?)\]?\]$/, ":$1*")
				.replace(/^\[(.+)\]$/, ":$1"),
		)
		.filter((segment) => segment !== "index");
	return `/${segments.join("/")}`;
}

type RouteEntry = {
	key: string;
	method: string;
	segments: string[];
	known: boolean;
};
/** Routes by path segment, so a request is matched in time proportional to its own length. */
type RouteTrie = {
	literal: Map<string, RouteTrie>;
	param: RouteTrie | null;
	routes: RouteEntry[];
};
const newTrie = (): RouteTrie => ({
	literal: new Map(),
	param: null,
	routes: [],
});
function trieInsert(root: RouteTrie, entry: RouteEntry) {
	let current = root;
	for (const segment of entry.segments) {
		if (segment === ":param" || segment === "*") {
			current.param ??= newTrie();
			current = current.param;
		} else {
			let next = current.literal.get(segment);
			if (!next) {
				next = newTrie();
				current.literal.set(segment, next);
			}
			current = next;
		}
	}
	current.routes.push(entry);
}
/**
 * Routes whose shape fits the request's segments, scored by agreement: an equal literal scores 2, a
 * parameter on both sides 1, a parameter on one side 0. A request parameter must try every branch.
 */
function trieMatch(
	root: RouteTrie,
	segments: readonly string[],
	visit: (route: RouteEntry, score: number) => void,
) {
	const walk = (node: RouteTrie, i: number, score: number) => {
		if (i === segments.length) {
			for (const route of node.routes) visit(route, score);
			return;
		}
		const segment = segments[i] ?? "";
		if (segment === ":param") {
			for (const child of node.literal.values()) walk(child, i + 1, score);
			if (node.param) walk(node.param, i + 1, score + 1);
			return;
		}
		const literal = node.literal.get(segment);
		if (literal) walk(literal, i + 1, score + 2);
		if (node.param) walk(node.param, i + 1, score);
	};
	walk(root, 0, 0);
}

/**
 * Builds nodes and edges from per-file extractions. Cross-file edges exist only when a binding resolves
 * to a tracked file and an exported symbol; unresolvable targets become explicit unresolved edges or
 * counted gaps, never guesses.
 */
export function buildGraph(input: GraphInput): {
	nodes: GraphNode[];
	edges: GraphEdge[];
	profile: RepositoryProfile;
	coverage: GraphCoverage;
} {
	const nodesByKey = new Map<string, GraphNode>();
	const edges: GraphEdge[] = [];
	const edgeKeys = new Set<string>();
	const addNode = (graphNode: GraphNode) => {
		if (!nodesByKey.has(graphNode.key))
			nodesByKey.set(graphNode.key, graphNode);
	};
	const addEdge = (edge: GraphEdge) => {
		const key = `${edge.kind}|${edge.from}|${edge.to ?? `?${edge.target_text}`}`;
		if (edgeKeys.has(key)) return;
		edgeKeys.add(key);
		edges.push(edge);
	};
	const plain = (
		key: string,
		kind: string,
		name: string,
		extra: Partial<GraphNode> = {},
	): GraphNode => ({
		key,
		kind,
		name,
		path: null,
		start_line: null,
		end_line: null,
		language: null,
		attributes: {},
		provenance: {},
		...extra,
	});
	const fileSet = new Set(input.files.map((file) => file.path));
	const symbolKey = (file: string, name: string) => `sym:${file}#${name}`;
	const revision = `rev:${input.commitSha}`;

	addNode(
		plain("repo", "repository", input.repositoryName, {
			provenance: { method: "registration" },
		}),
	);
	addNode(
		plain(revision, "revision", input.commitSha.slice(0, 12), {
			attributes: { sha: input.commitSha },
			provenance: { method: "git_rev_parse" },
		}),
	);
	addEdge({
		kind: "CONTAINS",
		from: "repo",
		to: revision,
		target_text: null,
		certainty: "exact",
		provenance: { method: "git_rev_parse" },
	});

	const directories = new Set<string>(["."]);
	for (const file of input.files) {
		const parts = file.path.split("/");
		for (let i = 1; i < parts.length; i++)
			directories.add(parts.slice(0, i).join("/"));
	}
	const dirKey = (directory: string) =>
		`dir:${directory === "" ? "." : directory}`;
	for (const directory of directories) {
		addNode(
			plain(
				dirKey(directory),
				"directory",
				directory === "."
					? input.repositoryName
					: path.posix.basename(directory),
				{ path: directory, provenance: { method: "git_ls_tree" } },
			),
		);
		addEdge({
			kind: "CONTAINS",
			from:
				directory === "." ? revision : dirKey(path.posix.dirname(directory)),
			to: dirKey(directory),
			target_text: null,
			certainty: "exact",
			provenance: { method: "git_ls_tree" },
		});
	}

	const manifestByDir = new Map(
		input.manifests.map((manifest) => [
			path.posix.dirname(manifest.path),
			manifest,
		]),
	);
	const nearestManifest = (file: string) => {
		let directory = path.posix.dirname(file);
		for (;;) {
			const manifest = manifestByDir.get(directory);
			if (manifest) return manifest;
			if (directory === "." || directory === "") return null;
			directory = path.posix.dirname(directory);
		}
	};
	const workspacePackages = new Map(
		input.manifests
			.filter((manifest) => manifest.name)
			.map((manifest) => [manifest.name as string, manifest]),
	);
	const workspaceEntries = new Map<string, string | null>();
	/**
	 * A bare specifier naming a workspace package (`@x/core`, `@x/core/sub`) → the tracked file it
	 * loads: the first `exports` target present in the repository, else `main`, then `index`; without
	 * an `exports` map a subpath resolves inside the package directory. Build output that is not in
	 * the repository (`dist/`) is never mapped back to source: the import stays at package level.
	 */
	const resolveWorkspace = (specifier: string): string | null => {
		const cached = workspaceEntries.get(specifier);
		if (cached !== undefined) return cached;
		const name = packageOf(specifier);
		const manifest = workspacePackages.get(name);
		let found: string | null = null;
		if (manifest) {
			const subpath = `.${specifier.slice(name.length)}`;
			const targets = manifest.exports
				? (manifest.exports[subpath] ?? [])
				: subpath === "."
					? [manifest.main, "./index"]
					: [subpath];
			for (const target of targets) {
				if (!target) continue;
				found = resolveSpecifier(
					manifest.path,
					target.startsWith("./") || target.startsWith("../")
						? target
						: `./${target}`,
					fileSet,
				);
				if (found) break;
			}
		}
		workspaceEntries.set(specifier, found);
		return found;
	};
	/** Relative specifiers, then workspace package names; anything else is outside the repository. */
	const resolveModule = (importer: string, specifier: string) =>
		specifier.startsWith(".")
			? resolveSpecifier(importer, specifier, fileSet)
			: resolveWorkspace(specifier);

	// Usable extractions only (parsed without errors), and their symbols by name.
	const usable = new Map<string, FileExtraction>();
	const symbolsOf = new Map<
		string,
		Map<string, FileExtraction["symbols"][number]>
	>();
	for (const [file, extraction] of input.extractions)
		if (!extraction.parse_error && fileSet.has(file)) {
			usable.set(file, extraction);
			symbolsOf.set(
				file,
				new Map(extraction.symbols.map((symbol) => [symbol.name, symbol])),
			);
		}
	const hasSymbol = (file: string, name: string) =>
		symbolsOf.get(file)?.has(name) ?? false;

	let parsedFiles = 0;
	const parseFailures: GraphCoverage["parse_failures"] = [];
	const unsupportedCode: Record<string, number> = {};
	const unsupportedPatterns: Record<string, number> = {};
	const filesByLanguage: Record<string, number> = {};
	const unresolved: GraphCoverage["unresolved"] = {
		imports: 0,
		calls: 0,
		member_calls: 0,
		requests: 0,
		route_handlers: 0,
		routes_with_unknown_prefix: 0,
	};
	let testFiles = 0;
	let testCases = 0;
	let sizeBytes = 0;
	const symbolCounts: Record<string, number> = {};

	for (const file of input.files) {
		const language = languageOf(file.path);
		filesByLanguage[language] = (filesByLanguage[language] ?? 0) + 1;
		sizeBytes += file.size ?? 0;
		const extraction = input.extractions.get(file.path);
		const isTest = extraction?.is_test_file ?? TEST_FILE.test(file.path);
		const manifest = nearestManifest(file.path);
		const moduleUnresolved = extraction?.unresolved_by_owner?.["(module)"];
		addNode(
			plain(
				`file:${file.path}`,
				isTest ? "test_file" : "file",
				path.posix.basename(file.path),
				{
					path: file.path,
					language,
					attributes: {
						size: file.size,
						object: file.object,
						package: manifest
							? `pkg:${path.posix.dirname(manifest.path)}`
							: null,
						parsed: Boolean(extraction && !extraction.parse_error),
						...(moduleUnresolved ? { unresolved_calls: moduleUnresolved } : {}),
					},
					provenance: { method: "git_ls_tree", path: file.path },
				},
			),
		);
		addEdge({
			kind: "CONTAINS",
			from: dirKey(path.posix.dirname(file.path)),
			to: `file:${file.path}`,
			target_text: null,
			certainty: "exact",
			provenance: { method: "git_ls_tree" },
		});
		if (isTest) testFiles += 1;
		if (!extraction) {
			if (CODE_LANGUAGES.has(language) && !PARSED_LANGUAGES.has(language))
				unsupportedCode[language] = (unsupportedCode[language] ?? 0) + 1;
			continue;
		}
		if (extraction.parse_error) {
			parseFailures.push({ path: file.path, ...extraction.parse_error });
			continue;
		}
		parsedFiles += 1;
		unresolved.calls += extraction.unresolved_calls;
		unresolved.member_calls += extraction.unresolved_member_calls;
		for (const [pattern, count] of Object.entries(extraction.unsupported))
			unsupportedPatterns[pattern] =
				(unsupportedPatterns[pattern] ?? 0) + count;
		for (const symbol of extraction.symbols) {
			symbolCounts[symbol.kind] = (symbolCounts[symbol.kind] ?? 0) + 1;
			const provenance = {
				method: "babel_parse",
				path: file.path,
				start_line: symbol.start_line,
				end_line: symbol.end_line,
			};
			const unresolvedHere = extraction.unresolved_by_owner[symbol.name];
			addNode(
				plain(symbolKey(file.path, symbol.name), symbol.kind, symbol.name, {
					path: file.path,
					start_line: symbol.start_line,
					end_line: symbol.end_line,
					language,
					attributes: {
						exported: symbol.exported,
						...(symbol.synthetic ? { synthetic: symbol.synthetic } : {}),
						...(unresolvedHere ? { unresolved_calls: unresolvedHere } : {}),
					},
					provenance,
				}),
			);
			addEdge({
				kind: symbol.parent ? "CONTAINS" : "DEFINES",
				from: symbol.parent
					? symbolKey(file.path, symbol.parent)
					: `file:${file.path}`,
				to: symbolKey(file.path, symbol.name),
				target_text: null,
				certainty: "exact",
				provenance,
			});
		}
		for (const testCase of extraction.tests) {
			testCases += 1;
			const key = `test:${file.path}#${testCase.name}`;
			const provenance = {
				method: "babel_parse",
				path: file.path,
				start_line: testCase.start_line,
				end_line: testCase.end_line,
			};
			addNode(
				plain(key, "test_case", testCase.name, {
					path: file.path,
					start_line: testCase.start_line,
					end_line: testCase.end_line,
					language,
					provenance,
				}),
			);
			addEdge({
				kind: "CONTAINS",
				from: `file:${file.path}`,
				to: key,
				target_text: null,
				certainty: "exact",
				provenance,
			});
		}
	}

	// Package manifests and their declared dependencies.
	for (const manifest of input.manifests) {
		const key = `pkg:${path.posix.dirname(manifest.path)}`;
		addNode(
			plain(
				key,
				"package",
				manifest.name ?? path.posix.dirname(manifest.path),
				{
					path: manifest.path,
					language: "json",
					attributes: { scripts: manifest.scripts, type: manifest.type },
					provenance: { method: "package_json", path: manifest.path },
				},
			),
		);
		const declared = [
			...Object.entries(manifest.dependencies).map(([name, range]) => ({
				name,
				range,
				scope: "runtime",
			})),
			...Object.entries(manifest.devDependencies).map(([name, range]) => ({
				name,
				range,
				scope: "development",
			})),
		];
		for (const dependency of declared) {
			addNode(
				plain(`dep:${dependency.name}`, "dependency", dependency.name, {
					attributes: { external: true },
					provenance: { method: "package_json", path: manifest.path },
				}),
			);
			addEdge({
				kind: "DEPENDS_ON",
				from: key,
				to: `dep:${dependency.name}`,
				target_text: null,
				certainty: "exact",
				provenance: {
					method: "package_json",
					path: manifest.path,
					range: dependency.range,
					scope: dependency.scope,
				},
			});
		}
	}

	// ---- Resolution: bindings, exports through barrels, types, methods ----------------------------

	const bindingCache = new Map<string, Map<string, Binding>>();
	const bindingsOf = (file: string): Map<string, Binding> => {
		const cached = bindingCache.get(file);
		if (cached) return cached;
		const bindings = new Map<string, Binding>();
		for (const entry of usable.get(file)?.imports ?? []) {
			if (entry.kind === "reexport") continue;
			const resolved = resolveModule(file, entry.specifier);
			if (!resolved) continue;
			for (const name of entry.names)
				if (name.local !== "*")
					bindings.set(
						name.local,
						name.imported === "*"
							? { namespace: resolved }
							: { file: resolved, exported: name.imported },
					);
		}
		bindingCache.set(file, bindings);
		return bindings;
	};
	const exportCache = new Map<string, Resolved | null>();
	/** The symbol (or namespace) a file exports under `exported`, following re-exports and barrels. */
	const resolveExport = (
		file: string,
		exported: string,
		depth = 0,
	): Resolved | null => {
		const cacheKey = `${file}\0${exported}`;
		if (exportCache.has(cacheKey)) return exportCache.get(cacheKey) ?? null;
		exportCache.set(cacheKey, null); // cycle guard: an in-progress lookup resolves to nothing
		const extraction = usable.get(file);
		let found: Resolved | null = null;
		if (extraction && depth <= 10) {
			const local = extraction.exports[exported];
			if (local !== undefined) {
				if (hasSymbol(file, local)) found = { file, name: local };
				else {
					// `import { a } from "./a"; export { a }` re-exports a binding.
					const bound = bindingsOf(file).get(local);
					if (bound)
						found = isNamespace(bound)
							? bound
							: resolveExport(bound.file, bound.exported, depth + 1);
				}
			} else
				for (const entry of extraction.imports) {
					if (entry.kind !== "reexport" || found) continue;
					const target = resolveModule(file, entry.specifier);
					if (!target) continue;
					for (const name of entry.names) {
						if (name.local === exported && name.imported !== "*")
							found = resolveExport(target, name.imported, depth + 1);
						else if (name.local === exported && name.imported === "*")
							found = { namespace: target };
						else if (
							name.local === "*" &&
							name.imported === "*" &&
							exported !== "default"
						)
							found = resolveExport(target, exported, depth + 1);
						if (found) break;
					}
				}
		}
		exportCache.set(cacheKey, found);
		return found;
	};
	const binding = (file: string, local: string): Resolved | null => {
		const value = bindingsOf(file).get(local);
		if (!value) return null;
		return isNamespace(value)
			? value
			: resolveExport(value.file, value.exported);
	};
	const exportStates = new Map<string, "found" | "missing" | "unknown">();
	/**
	 * Whether `file` exports `exported`. "missing" only when every module on the way is parsed and
	 * lists all its exports; an unparsed module, CommonJS, or an external re-export makes it unknown.
	 */
	const exportState = (
		file: string,
		exported: string,
		depth = 0,
	): "found" | "missing" | "unknown" => {
		const cacheKey = `${file}\0${exported}`;
		const cached = exportStates.get(cacheKey);
		if (cached) return cached;
		exportStates.set(cacheKey, "unknown"); // cycle guard
		const extraction = usable.get(file);
		let state: "found" | "missing" | "unknown" = "missing";
		if (!extraction || extraction.opaque_exports || depth > 10)
			state = "unknown";
		else if (extraction.exports[exported] !== undefined) {
			// `import { a } from "./a"; export { a }` passes on whatever "./a" exports.
			const local = extraction.exports[exported] ?? exported;
			const bound = hasSymbol(file, local)
				? undefined
				: bindingsOf(file).get(local);
			state =
				bound && !isNamespace(bound)
					? exportState(bound.file, bound.exported, depth + 1)
					: "found";
		} else {
			// A named re-export decides; `export *` adds only what its module has (never `default`).
			let named: "found" | "missing" | "unknown" | null = null;
			for (const entry of extraction.imports) {
				if (entry.kind !== "reexport") continue;
				const target = resolveModule(file, entry.specifier);
				for (const name of entry.names)
					if (name.local === exported)
						named =
							name.imported === "*" // export * as ns
								? "found"
								: target
									? exportState(target, name.imported, depth + 1)
									: "unknown";
					else if (
						name.local === "*" &&
						exported !== "default" &&
						state !== "found"
					) {
						const inner = target
							? exportState(target, exported, depth + 1)
							: "unknown";
						if (inner !== "missing") state = inner;
					}
			}
			if (named) state = named;
		}
		exportStates.set(cacheKey, state);
		return state;
	};
	/** A use of an imported name that the imported module definitely does not export. */
	const brokenImport = (file: string, used: string): boolean => {
		const [head = used, member] = used.split(".");
		if (hasSymbol(file, head)) return false;
		const bound = bindingsOf(file).get(head);
		if (!bound) return false;
		if (isNamespace(bound))
			return (
				member !== undefined &&
				exportState(bound.namespace, member) === "missing"
			);
		return (
			member === undefined &&
			exportState(bound.file, bound.exported) === "missing"
		);
	};
	/** A name as used in `file` (`f`, `Comp.save`, `ns.fn`, `obj.method`) → the symbol key it denotes. */
	const resolveName = (file: string, name: string): string | null => {
		if (hasSymbol(file, name)) return symbolKey(file, name);
		const dot = name.indexOf(".");
		const head = dot === -1 ? name : name.slice(0, dot);
		const member = dot === -1 ? null : name.slice(dot + 1);
		if (member !== null && hasSymbol(file, head))
			return hasSymbol(file, `${head}.${member}`)
				? symbolKey(file, `${head}.${member}`)
				: null;
		const target = binding(file, head);
		if (!target) return null;
		if (isNamespace(target)) {
			if (!member) return null;
			const inner = resolveExport(
				target.namespace,
				member.split(".")[0] ?? member,
			);
			return inner && !isNamespace(inner)
				? symbolKey(inner.file, inner.name)
				: null;
		}
		if (!member) return symbolKey(target.file, target.name);
		const qualified = `${target.name}.${member}`;
		return hasSymbol(target.file, qualified)
			? symbolKey(target.file, qualified)
			: null;
	};
	/** A type name used in `file` → the class or interface symbol it denotes. */
	const resolveType = (file: string, typeName: string): SymbolRef | null => {
		const symbol = symbolsOf.get(file)?.get(typeName);
		if (symbol && (symbol.kind === "class" || symbol.kind === "interface"))
			return { file, name: typeName };
		const dot = typeName.indexOf(".");
		const head = dot === -1 ? typeName : typeName.slice(0, dot);
		const target = binding(file, head);
		if (!target) return null;
		const ref = isNamespace(target)
			? dot === -1
				? null
				: resolveExport(target.namespace, typeName.slice(dot + 1))
			: target;
		if (!ref || isNamespace(ref)) return null;
		const kind = symbolsOf.get(ref.file)?.get(ref.name)?.kind;
		return kind === "class" || kind === "interface" ? ref : null;
	};
	const superOf = (ref: SymbolRef): SymbolRef | null => {
		const entry = usable
			.get(ref.file)
			?.extends.find((e) => e.name === ref.name);
		return entry ? resolveType(ref.file, entry.superName) : null;
	};
	/** A method on a class or interface, walking up `extends` (8 levels). */
	const findMethod = (ref: SymbolRef, method: string): string | null => {
		let current: SymbolRef | null = ref;
		for (let depth = 0; current && depth < 8; depth++) {
			if (hasSymbol(current.file, `${current.name}.${method}`))
				return symbolKey(current.file, `${current.name}.${method}`);
			current = superOf(current);
		}
		return null;
	};
	/** A constant object's property across files (queue and event names). */
	const resolveConstant = (
		file: string,
		constant: string,
		property: string,
	): string | null => {
		const read = (inFile: string, name: string) => {
			const value = usable.get(inFile)?.constants[name];
			return value &&
				typeof value === "object" &&
				typeof value[property] === "string"
				? (value[property] as string)
				: null;
		};
		const local = read(file, constant);
		if (local !== null) return local;
		const target = binding(file, constant);
		return target && !isNamespace(target)
			? read(target.file, target.name)
			: null;
	};
	const fromKey = (file: string, owner: string | null) =>
		owner && hasSymbol(file, owner) ? symbolKey(file, owner) : `file:${file}`;
	const link = (
		kind: string,
		from: string,
		to: string | null,
		file: string,
		line: number,
		extra: Record<string, unknown> = {},
		certainty: Certainty = "resolved",
	) => {
		if (to && to !== from)
			addEdge({
				kind,
				from,
				to,
				target_text: null,
				certainty,
				provenance: {
					method: "babel_parse+binding",
					path: file,
					start_line: line,
					...extra,
				},
			});
	};

	// ---- Imports, re-exports, and file-level tests -------------------------------------------------
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		const manifest = nearestManifest(file.path);
		for (const entry of extraction.imports) {
			const resolved = resolveModule(file.path, entry.specifier);
			const bare = !entry.specifier.startsWith(".");
			const packageName = packageOf(entry.specifier);
			const builtin =
				entry.specifier.startsWith("node:") || NODE_BUILTINS.has(packageName);
			let target: string | null = null;
			if (resolved) target = `file:${resolved}`;
			else if (bare && builtin) {
				const name = entry.specifier.startsWith("node:")
					? entry.specifier
					: `node:${packageName}`;
				target = `dep:${name}`;
				addNode(
					plain(target, "dependency", name, {
						attributes: { builtin: true },
						provenance: { method: "builtin_module" },
					}),
				);
			} else if (bare && workspacePackages.has(packageName))
				target = `pkg:${path.posix.dirname(workspacePackages.get(packageName)?.path ?? "")}`;
			else if (
				bare &&
				manifest &&
				(manifest.dependencies[packageName] !== undefined ||
					manifest.devDependencies[packageName] !== undefined)
			)
				target = `dep:${packageName}`;
			if (!target) unresolved.imports += 1;
			const reexport = entry.kind === "reexport";
			addEdge({
				kind: reexport ? "RE_EXPORTS" : "IMPORTS",
				from: `file:${file.path}`,
				to: target,
				target_text: target ? null : entry.specifier,
				certainty: target ? "resolved" : "unresolved",
				provenance: {
					method: resolved
						? bare
							? "workspace_package_resolution"
							: "import_resolution"
						: "babel_parse",
					path: file.path,
					start_line: entry.line,
					specifier: entry.specifier,
					kind: entry.kind,
					...(reexport
						? {
								names: entry.names.map((n) =>
									n.imported === n.local
										? n.local
										: `${n.imported} as ${n.local}`,
								),
							}
						: {}),
				},
			});
			if (
				resolved &&
				extraction.is_test_file &&
				!TEST_FILE.test(resolved) &&
				!input.extractions.get(resolved)?.is_test_file
			)
				addEdge({
					kind: "TESTS",
					from: `file:${file.path}`,
					to: `file:${resolved}`,
					target_text: null,
					certainty: "resolved",
					provenance: {
						method: "test_imports_module",
						path: file.path,
						start_line: entry.line,
					},
				});
		}
	}

	// ---- Types first (implementations feed interface dispatch), then calls and other uses ---------
	const implementers = new Map<string, SymbolRef[]>();
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		for (const implementation of extraction.implements) {
			const target = resolveType(file.path, implementation.interfaceName);
			link(
				"IMPLEMENTS",
				symbolKey(file.path, implementation.className),
				target
					? symbolKey(target.file, target.name)
					: resolveName(file.path, implementation.interfaceName),
				file.path,
				implementation.line,
			);
			if (target) {
				const key = symbolKey(target.file, target.name);
				const list = implementers.get(key) ?? [];
				list.push({ file: file.path, name: implementation.className });
				implementers.set(key, list);
			}
		}
		for (const heritage of extraction.extends) {
			const target = resolveType(file.path, heritage.superName);
			if (target)
				link(
					"EXTENDS",
					symbolKey(file.path, heritage.name),
					symbolKey(target.file, target.name),
					file.path,
					heritage.line,
				);
		}
	}
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		const name = (n: string) => resolveName(file.path, n);
		/**
		 * Links a use of a name. A name imported from a repository module that does not export it is a
		 * broken reference: an explicit unresolved edge rather than a silent omission.
		 */
		const use = (
			kind: string,
			owner: string | null,
			used: string,
			line: number,
		) => {
			const from = fromKey(file.path, owner);
			const to = name(used);
			if (to) link(kind, from, to, file.path, line);
			else if (brokenImport(file.path, used))
				addEdge({
					kind,
					from,
					to: null,
					target_text: used,
					certainty: "unresolved",
					provenance: {
						method: "babel_parse+binding",
						path: file.path,
						start_line: line,
						reason: "import_not_exported",
					},
				});
		};
		for (const call of extraction.calls)
			use("CALLS", call.caller, call.callee, call.line);
		for (const reference of extraction.references)
			use("REFERENCES", reference.from, reference.name, reference.line);
		for (const render of extraction.renders)
			use("RENDERS", render.from, render.component, render.line);
		for (const call of extraction.member_calls) {
			const from = fromKey(file.path, call.caller);
			const viaType = (typeName: string, inFile: string) => {
				const type = resolveType(inFile, typeName);
				if (!type) return null;
				if (symbolsOf.get(type.file)?.get(type.name)?.kind === "interface")
					// Dynamic dispatch: candidate implementations get heuristic edges.
					for (const implementation of implementers.get(
						symbolKey(type.file, type.name),
					) ?? [])
						link(
							"CALLS",
							from,
							findMethod(implementation, call.property),
							file.path,
							call.line,
							{ dispatch: "interface_implementation" },
							"heuristic",
						);
				return findMethod(type, call.property);
			};
			const receiver = call.receiver;
			let target: string | null = null;
			if (receiver.kind === "this")
				target = findMethod(
					{ file: file.path, name: receiver.className },
					call.property,
				);
			else if (receiver.kind === "type")
				target = viaType(receiver.typeName, file.path);
			else if (receiver.kind === "field") {
				const type =
					extraction.field_types[receiver.className]?.[receiver.field];
				target = type ? viaType(type, file.path) : null;
			} else {
				// A module instance, a class (statics), an object literal, or an imported one of those.
				const local = hasSymbol(file.path, receiver.name)
					? { file: file.path, name: receiver.name }
					: binding(file.path, receiver.name);
				if (local && !isNamespace(local)) {
					const instance = usable.get(local.file)?.instances[local.name];
					target = instance
						? viaType(instance, local.file)
						: hasSymbol(local.file, `${local.name}.${call.property}`)
							? symbolKey(local.file, `${local.name}.${call.property}`)
							: null;
				}
			}
			link("CALLS", from, target, file.path, call.line, {
				receiver: receiver.kind,
			});
		}
		for (const testCase of extraction.tests)
			for (const callee of testCase.calls) {
				const target = name(callee);
				if (target && !target.startsWith(`sym:${file.path}#`))
					addEdge({
						kind: "TESTS",
						from: `test:${file.path}#${testCase.name}`,
						to: target,
						target_text: null,
						certainty: "resolved",
						provenance: {
							method: "test_calls_symbol",
							path: file.path,
							start_line: testCase.start_line,
						},
					});
			}
	}

	// ---- HTTP routes: mounts, prefixes, handlers, and file-convention routes -----------------------
	const routerId = (file: string, receiver: string) => `${file}#${receiver}`;
	/** Which router (or Fastify plugin function) a mount target names, wherever it is defined. */
	const mountedRouter = (
		file: string,
		target: { name: string } | { specifier: string },
	): string | null => {
		const fromRef = (ref: Resolved | null): string | null => {
			if (!ref) return null;
			if (isNamespace(ref))
				return fromRef(resolveExport(ref.namespace, "default"));
			if (usable.get(ref.file)?.routers[ref.name])
				return routerId(ref.file, ref.name);
			const kind = symbolsOf.get(ref.file)?.get(ref.name)?.kind;
			return kind === "function" ? routerId(ref.file, `fn:${ref.name}`) : null;
		};
		if ("specifier" in target) {
			const resolved = resolveModule(file, target.specifier);
			return resolved ? fromRef(resolveExport(resolved, "default")) : null;
		}
		if (usable.get(file)?.routers[target.name])
			return routerId(file, target.name);
		if (hasSymbol(file, target.name))
			return fromRef({ file, name: target.name });
		return fromRef(binding(file, target.name));
	};
	const prefixes = new Map<string, Set<string>>();
	const mountEdges: Array<{
		parent: string;
		child: string;
		prefix: string | null;
	}> = [];
	const mountedChildren = new Set<string>();
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		for (const [name, router] of Object.entries(extraction.routers))
			if (router.kind === "app")
				prefixes.set(routerId(file.path, name), new Set([""]));
		for (const route of extraction.routes)
			if (route.receiver_kind === "app")
				prefixes.set(routerId(file.path, route.receiver), new Set([""]));
		for (const mount of extraction.mounts) {
			const parent = routerId(file.path, mount.receiver);
			if (mount.receiver_kind === "app" && !prefixes.has(parent))
				prefixes.set(parent, new Set([""]));
			const child = mountedRouter(file.path, mount.target);
			if (!child) continue;
			mountEdges.push({ parent, child, prefix: mount.prefix });
			mountedChildren.add(child);
		}
	}
	for (let round = 0, changed = true; changed && round < 10; round++) {
		changed = false;
		for (const edge of mountEdges) {
			const parentPrefixes = prefixes.get(edge.parent);
			if (!parentPrefixes || edge.prefix === null) continue;
			const set = prefixes.get(edge.child) ?? new Set<string>();
			for (const parentPrefix of parentPrefixes) {
				const full = joinRoutePath(parentPrefix, edge.prefix);
				if (set.size < 5 && !set.has(full)) {
					set.add(full);
					changed = true;
				}
			}
			prefixes.set(edge.child, set);
		}
	}
	const routesByLength = new Map<number, RouteEntry[]>();
	const routeTries = { known: newTrie(), unknown: newTrie() };
	const indexedRoutes = new Set<string>();
	const addRoute = (
		file: string,
		method: string,
		fullPath: string,
		known: boolean,
		line: number,
		attributes: Record<string, unknown>,
		certainty: Certainty,
	) => {
		const canonical = canonicalRoutePath(fullPath);
		const key = known
			? `route:${method} ${canonical}`
			: `route:${method} ${canonical}@${file}`;
		addNode(
			plain(key, "route", `${method} ${fullPath}`, {
				path: file,
				start_line: line,
				end_line: line,
				language: languageOf(file),
				attributes: {
					method,
					path: fullPath,
					prefix_known: known,
					...attributes,
				},
				provenance: {
					method: attributes.convention
						? "file_convention"
						: "route_registration",
					path: file,
					start_line: line,
				},
			}),
		);
		addEdge({
			kind: "DEFINES",
			from: `file:${file}`,
			to: key,
			target_text: null,
			certainty: certainty === "heuristic" ? "heuristic" : "exact",
			provenance: {
				method: "route_registration",
				path: file,
				start_line: line,
			},
		});
		if (!indexedRoutes.has(key)) {
			indexedRoutes.add(key);
			const entry = { key, method, segments: canonical.split("/"), known };
			const bucket = routesByLength.get(entry.segments.length) ?? [];
			bucket.push(entry);
			routesByLength.set(entry.segments.length, bucket);
			trieInsert(known ? routeTries.known : routeTries.unknown, entry);
		}
		return key;
	};
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		for (const route of extraction.routes) {
			const id = routerId(file.path, route.receiver);
			const known = prefixes.get(id);
			const fullPaths =
				known && known.size > 0
					? [...known].map((p) => joinRoutePath(p, route.path))
					: [route.path];
			if (!known) unresolved.routes_with_unknown_prefix += 1;
			for (const fullPath of fullPaths) {
				const key = addRoute(
					file.path,
					route.method,
					fullPath,
					Boolean(known),
					route.line,
					{
						framework: route.framework,
						receiver: route.receiver,
						...(known
							? {}
							: {
									prefix: mountedChildren.has(id)
										? "unresolved_mount"
										: "not_mounted",
								}),
					},
					route.certainty,
				);
				route.handlers.forEach((handler, order) => {
					const target = handler.symbol
						? symbolKey(file.path, handler.symbol)
						: handler.name
							? resolveName(file.path, handler.name)
							: null;
					if (!target) unresolved.route_handlers += 1;
					addEdge({
						kind: "ROUTES_TO",
						from: key,
						to: target,
						target_text: target ? null : handler.name,
						certainty: target ? route.certainty : "unresolved",
						provenance: {
							method: "route_registration",
							path: file.path,
							start_line: route.line,
							role: handler.role,
							order,
						},
					});
				});
			}
		}
	}
	const addPage = (
		file: string,
		pagePath: string,
		line: number,
		framework: string,
	) => {
		const key = `page:${canonicalRoutePath(pagePath)}`;
		addNode(
			plain(key, "page", pagePath, {
				path: file,
				start_line: line,
				end_line: line,
				attributes: { path: pagePath, framework },
				provenance: {
					method: framework === "next" ? "file_convention" : "route_element",
					path: file,
					start_line: line,
				},
			}),
		);
		return key;
	};
	// Next.js conventions, only when the repository declares `next`.
	const usesNext = input.manifests.some(
		(m) =>
			m.dependencies.next !== undefined || m.devDependencies.next !== undefined,
	);
	if (usesNext)
		for (const file of input.files) {
			if (!usable.has(file.path)) continue;
			const parts = file.path.split("/");
			const base = parts.at(-1)?.replace(/\.(jsx?|tsx?)$/, "") ?? "";
			const pagesAt = parts.lastIndexOf("pages");
			const appAt = parts.lastIndexOf("app");
			const convention = { convention: "nextjs", framework: "next" };
			const linkDefault = (from: string, extra: Record<string, unknown>) => {
				const target = resolveExport(file.path, "default");
				if (target && !isNamespace(target))
					link(
						"ROUTES_TO",
						from,
						symbolKey(target.file, target.name),
						file.path,
						1,
						{ convention: "nextjs", ...extra },
						"exact",
					);
			};
			if (pagesAt !== -1 && parts[pagesAt + 1] === "api") {
				const routePath = nextSegments([...parts.slice(pagesAt + 1, -1), base]);
				linkDefault(
					addRoute(file.path, "ANY", routePath, true, 1, convention, "exact"),
					{ role: "handler" },
				);
			} else if (pagesAt !== -1 && !base.startsWith("_")) {
				const pagePath = nextSegments([...parts.slice(pagesAt + 1, -1), base]);
				linkDefault(addPage(file.path, pagePath, 1, "next"), {});
			} else if (appAt !== -1 && base === "page")
				linkDefault(
					addPage(
						file.path,
						nextSegments(parts.slice(appAt + 1, -1)),
						1,
						"next",
					),
					{},
				);
			else if (appAt !== -1 && base === "route") {
				const routePath = nextSegments(parts.slice(appAt + 1, -1));
				for (const verb of Object.keys(usable.get(file.path)?.exports ?? {})) {
					if (!HTTP_VERBS.has(verb)) continue;
					const key = addRoute(
						file.path,
						verb,
						routePath,
						true,
						1,
						convention,
						"exact",
					);
					const handler = resolveExport(file.path, verb);
					if (handler && !isNamespace(handler))
						link(
							"ROUTES_TO",
							key,
							symbolKey(handler.file, handler.name),
							file.path,
							1,
							{ role: "handler", convention: "nextjs" },
							"exact",
						);
				}
			}
		}
	// Client-side pages (React Router).
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		for (const page of extraction.pages) {
			const key = addPage(file.path, page.path, page.line, "react-router");
			const component = resolveName(file.path, page.component);
			addEdge({
				kind: "ROUTES_TO",
				from: key,
				to: component,
				target_text: component ? null : page.component,
				certainty: component ? "resolved" : "unresolved",
				provenance: {
					method: "route_element",
					path: file.path,
					start_line: page.line,
				},
			});
		}
	}

	// ---- Client requests matched to routes by method and path shape -------------------------------
	const matchRoutes = (method: string, url: string, known: boolean) => {
		const suffix = url.startsWith(":base");
		const segments = canonicalRoutePath(
			suffix ? url.slice(":base".length) || "/" : url,
		).split("/");
		let best: Array<{ key: string; score: number }> = [];
		const consider = (route: RouteEntry, score: number) => {
			if (
				route.method !== "ANY" &&
				route.method !== "ALL" &&
				method !== "?" &&
				route.method !== method
			)
				return;
			if (best.length === 0 || score > (best[0]?.score ?? 0))
				best = [{ key: route.key, score }];
			else if (score === best[0]?.score) best.push({ key: route.key, score });
		};
		if (!suffix) {
			trieMatch(
				known ? routeTries.known : routeTries.unknown,
				segments,
				consider,
			);
			return { matches: best, suffix };
		}
		// An unknown base (`${API}/orders`) can only be matched by suffix, which no prefix tree helps.
		for (const [length, routes] of routesByLength) {
			if (length < segments.length) continue;
			for (const route of routes) {
				if (route.known !== known) continue;
				const offset = route.segments.length - segments.length;
				let score = 0;
				let ok = true;
				for (let i = 1; i < segments.length && ok; i++) {
					const own = segments[i] ?? "";
					const other = route.segments[i + offset] ?? "";
					if (own === other) score += own === ":param" ? 1 : 2;
					else if (own !== ":param" && other !== ":param" && other !== "*")
						ok = false;
				}
				if (ok) consider(route, score);
			}
		}
		return { matches: best, suffix };
	};
	const clientBase = (
		file: string,
		name: string,
	): string | null | undefined => {
		const local = usable.get(file)?.http_clients[name];
		if (local) return local.base_url;
		const target = binding(file, name);
		if (!target || isNamespace(target)) return undefined;
		const remote = usable.get(target.file)?.http_clients[target.name];
		return remote ? remote.base_url : undefined;
	};
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		for (const request of extraction.requests) {
			let url = request.url;
			if (request.client.kind === "instance") {
				const base = clientBase(file.path, request.client.name);
				if (base === undefined) continue; // not an HTTP client after all
				if (base && !/^https?:\/\//i.test(url))
					url = /^https?:\/\//i.test(base)
						? `${base.replace(/\/$/, "")}${url}`
						: joinRoutePath(base, url);
			}
			const from = fromKey(file.path, request.caller);
			const provenance = {
				method: "request_url_match",
				path: file.path,
				start_line: request.line,
				http_method: request.method,
				url,
				client: request.client.kind,
			};
			let pathPart = url;
			if (/^https?:\/\//i.test(url)) {
				let host = "";
				try {
					const parsed = new URL(url.replace(/:base|:param/g, "x"));
					host = parsed.host;
					pathPart = decodeURI(parsed.pathname);
				} catch {
					unresolved.requests += 1;
					continue;
				}
				if (!/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(host)) {
					const key = `ext:${host}`;
					addNode(
						plain(key, "external_service", host, {
							attributes: { host },
							provenance: { method: "literal_url" },
						}),
					);
					addEdge({
						kind: "SENDS_REQUEST_TO",
						from,
						to: key,
						target_text: null,
						certainty: "resolved",
						provenance: { ...provenance, method: "literal_url" },
					});
					continue;
				}
			}
			let result = matchRoutes(request.method, pathPart, true);
			let certainty: Certainty =
				result.matches.length === 1 && !result.suffix
					? "resolved"
					: "heuristic";
			if (result.matches.length === 0) {
				result = matchRoutes(request.method, pathPart, false);
				certainty = "heuristic";
			}
			if (result.matches.length === 0) {
				unresolved.requests += 1;
				addEdge({
					kind: "SENDS_REQUEST_TO",
					from,
					to: null,
					target_text: `${request.method} ${url}`,
					certainty: "unresolved",
					provenance,
				});
				continue;
			}
			for (const match of result.matches.slice(0, 3))
				addEdge({
					kind: "SENDS_REQUEST_TO",
					from,
					to: match.key,
					target_text: null,
					certainty,
					provenance: {
						...provenance,
						...(result.matches.length > 1
							? { ambiguous: result.matches.length }
							: {}),
					},
				});
		}
	}

	// ---- UI events, event emitters, and queues ---------------------------------------------------
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		for (const event of extraction.events) {
			const top = event.owner?.split(".")[0] ?? "";
			const target = event.symbol
				? symbolKey(file.path, event.symbol)
				: event.handler
					? hasSymbol(file.path, `${top}.${event.handler}`)
						? symbolKey(file.path, `${top}.${event.handler}`)
						: resolveName(file.path, event.handler)
					: null;
			addEdge({
				kind: "HANDLES_EVENT",
				from: fromKey(file.path, event.owner),
				to: target,
				target_text: target ? null : event.handler,
				certainty: target ? "resolved" : "unresolved",
				provenance: {
					method: "babel_parse+binding",
					path: file.path,
					start_line: event.line,
					event: event.event,
				},
			});
		}
		for (const channel of extraction.channels) {
			const name =
				"literal" in channel.channel
					? channel.channel.literal
					: resolveConstant(
							file.path,
							channel.channel.constant,
							channel.channel.property,
						);
			if (name === null) {
				unsupportedPatterns.unresolved_channel_names =
					(unsupportedPatterns.unresolved_channel_names ?? 0) + 1;
				continue;
			}
			const kind = channel.transport === "queue" ? "queue" : "event";
			const key = `${kind}:${name}`;
			addNode(
				plain(key, kind, name, {
					attributes: { transport: channel.transport },
					provenance: { method: "channel_name" },
				}),
			);
			const handler = channel.handler
				? resolveName(file.path, channel.handler)
				: null;
			addEdge({
				kind: channel.direction === "publish" ? "PUBLISHES" : "SUBSCRIBES_TO",
				from: handler ?? fromKey(file.path, channel.owner),
				to: key,
				target_text: null,
				certainty: channel.certainty,
				provenance: {
					method: channel.transport === "queue" ? "queue_api" : "event_emitter",
					path: file.path,
					start_line: channel.line,
				},
			});
		}
	}

	// ---- Data: tables (Drizzle, SQL DDL), row reads and writes, configuration --------------------
	const tableNode = (
		table: string,
		file: string,
		line: number,
		method: string,
		defined: boolean,
	) => {
		const key = `table:${table}`;
		const existing = nodesByKey.get(key);
		if (!existing)
			addNode(
				plain(key, "db_table", table, {
					path: defined ? file : null,
					start_line: defined ? line : null,
					end_line: defined ? line : null,
					attributes: { defined },
					provenance: { method, path: file, start_line: line },
				}),
			);
		else if (defined && existing.attributes.defined !== true) {
			existing.attributes.defined = true;
			existing.path = file;
			existing.start_line = line;
			existing.end_line = line;
			existing.provenance = { method, path: file, start_line: line };
		}
		return key;
	};
	const tableSymbols = new Map<string, string>();
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		for (const table of extraction.tables) {
			const method =
				table.statement === "definition" ? "drizzle_table" : "sql_ddl";
			const key = tableNode(
				table.table,
				file.path,
				table.line,
				method,
				table.statement === "definition" || table.statement === "create",
			);
			const provenance = {
				method,
				path: file.path,
				start_line: table.line,
				statement: table.statement,
			};
			if (table.symbol) {
				tableSymbols.set(symbolKey(file.path, table.symbol), key);
				addEdge({
					kind: "DEFINES",
					from: symbolKey(file.path, table.symbol),
					to: key,
					target_text: null,
					certainty: "exact",
					provenance,
				});
			} else
				addEdge({
					kind: table.statement === "create" ? "DEFINES" : "WRITES_TO",
					from: `file:${file.path}`,
					to: key,
					target_text: null,
					certainty: "exact",
					provenance:
						table.statement === "create"
							? provenance
							: { ...provenance, schema_change: true },
				});
		}
	}
	for (const file of input.files) {
		const extraction = usable.get(file.path);
		if (!extraction) continue;
		for (const access of extraction.data_access) {
			let key: string | null = null;
			if ("table" in access.target)
				key = tableNode(
					access.target.table,
					file.path,
					access.line,
					"sql_literal",
					false,
				);
			else if ("model" in access.target)
				key = tableNode(
					access.target.model,
					file.path,
					access.line,
					"prisma_model",
					false,
				);
			else {
				const symbol = resolveName(file.path, access.target.binding);
				key = symbol ? (tableSymbols.get(symbol) ?? null) : null;
			}
			if (!key) continue; // not a table object (Array.from, map.delete, ...)
			addEdge({
				kind: access.op === "read" ? "READS_FROM" : "WRITES_TO",
				from: fromKey(file.path, access.owner),
				to: key,
				target_text: null,
				certainty: access.certainty,
				provenance: {
					method: access.via,
					path: file.path,
					start_line: access.line,
					statement: access.statement,
				},
			});
		}
		for (const read of extraction.config_reads) {
			const key = `env:${read.key}`;
			addNode(
				plain(key, "config_key", read.key, {
					attributes: { source: read.source },
					provenance: { method: read.source },
				}),
			);
			addEdge({
				kind: "CONFIGURED_BY",
				from: fromKey(file.path, read.owner),
				to: key,
				target_text: null,
				certainty: "exact",
				provenance: {
					method: read.source,
					path: file.path,
					start_line: read.line,
				},
			});
		}
	}

	// ---- History, ownership, and documentation ---------------------------------------------------
	for (const commit of input.commits) {
		const key = `commit:${commit.sha}`;
		addNode(
			plain(key, "commit", commit.subject.slice(0, 120), {
				attributes: { sha: commit.sha, date: commit.date },
				provenance: { method: "git_log" },
			}),
		);
		for (const file of commit.files)
			if (fileSet.has(file))
				addEdge({
					kind: "INTRODUCED_OR_CHANGED_BY",
					from: `file:${file}`,
					to: key,
					target_text: null,
					certainty: "exact",
					provenance: { method: "git_log", sha: commit.sha },
				});
	}
	// Last matching rule wins (CODEOWNERS semantics), so rules are tried newest first.
	const owners = input.codeowners
		.map((rule) => ({ ...rule, matches: codeownersMatcher(rule.pattern) }))
		.reverse();
	for (const file of input.files) {
		const rule = owners.find((candidate) => candidate.matches(file.path));
		for (const owner of rule?.owners ?? []) {
			addNode(
				plain(`owner:${owner}`, "owner", owner, {
					provenance: { method: "codeowners" },
				}),
			);
			addEdge({
				kind: "OWNED_BY",
				from: `file:${file.path}`,
				to: `owner:${owner}`,
				target_text: null,
				certainty: "exact",
				provenance: { method: "codeowners", pattern: rule?.pattern },
			});
		}
	}
	for (const section of input.docs) {
		const key = `doc:${section.path}#${section.slug}`;
		addNode(
			plain(key, "doc_section", section.heading, {
				path: section.path,
				start_line: section.start_line,
				end_line: section.end_line,
				language: "markdown",
				provenance: {
					method: "markdown_headings",
					path: section.path,
					start_line: section.start_line,
				},
			}),
		);
		addEdge({
			kind: "CONTAINS",
			from: `file:${section.path}`,
			to: key,
			target_text: null,
			certainty: "exact",
			provenance: { method: "markdown_headings" },
		});
		for (const mentioned of section.mentions)
			addEdge({
				kind: "DOCUMENTED_BY",
				from: `file:${mentioned}`,
				to: key,
				target_text: null,
				certainty: "heuristic",
				provenance: {
					method: "path_mention",
					path: section.path,
					start_line: section.start_line,
				},
			});
	}

	// ---- Consistency: every edge must join existing nodes ------------------------------------------
	const dropped: string[] = [];
	const consistent = edges.filter((edge) => {
		const ok =
			nodesByKey.has(edge.from) &&
			(edge.to === null || nodesByKey.has(edge.to));
		if (!ok && dropped.length < 20)
			dropped.push(`${edge.kind} ${edge.from} -> ${edge.to}`);
		return ok;
	});
	const danglingEdges = edges.length - consistent.length;

	// ---- Profile and coverage ---------------------------------------------------------------------
	const dependencyNames = new Set(
		input.manifests.flatMap((m) => [
			...Object.keys(m.dependencies),
			...Object.keys(m.devDependencies),
		]),
	);
	const importers = new Map<string, number>();
	for (const extraction of usable.values())
		for (const name of new Set(
			extraction.imports.map((entry) =>
				entry.specifier.startsWith("node:")
					? entry.specifier
					: packageOf(entry.specifier),
			),
		))
			importers.set(name, (importers.get(name) ?? 0) + 1);
	const entryPoints = new Set<string>();
	for (const manifest of input.manifests) {
		const directory = path.posix.dirname(manifest.path);
		for (const entry of [manifest.main, ...manifest.bin].filter(
			(value): value is string => Boolean(value),
		)) {
			const normalized = path.posix.normalize(
				path.posix.join(directory, entry),
			);
			if (fileSet.has(normalized)) entryPoints.add(normalized);
		}
		for (const name of ["index", "main", "server", "app", "cli"])
			for (const ext of [".ts", ".js", ".mjs", ".tsx"])
				for (const candidate of [
					path.posix.join(directory, `${name}${ext}`),
					path.posix.join(directory, "src", `${name}${ext}`),
				]) {
					const normalized = path.posix.normalize(candidate);
					if (fileSet.has(normalized)) entryPoints.add(normalized);
				}
	}
	const scripts = input.manifests.flatMap((manifest) =>
		Object.entries(manifest.scripts).map(([name, command]) => ({
			name,
			command,
			manifest: manifest.path,
		})),
	);
	const buildSystems = new Map<string, string>();
	for (const script of scripts)
		for (const [pattern, name] of BUILD_TOOLS)
			if (!buildSystems.has(name) && pattern.test(script.command))
				buildSystems.set(
					name,
					`${script.manifest} script "${script.name}": ${script.command.slice(0, 120)}`,
				);
	for (const file of input.files)
		for (const [pattern, name] of BUILD_FILES)
			if (!buildSystems.has(name) && pattern.test(file.path))
				buildSystems.set(name, `file ${file.path}`);
	const testFrameworks = new Map<string, string>();
	for (const [module, name] of TEST_TOOLS) {
		if (testFrameworks.has(name)) continue;
		const count = importers.get(module) ?? 0;
		if (count > 0) testFrameworks.set(name, `imported by ${count} file(s)`);
		else if (dependencyNames.has(module))
			testFrameworks.set(name, `declared dependency "${module}"`);
	}
	for (const script of scripts)
		if (
			!testFrameworks.has("node:test") &&
			/\bnode\s+--test\b/.test(script.command)
		)
			testFrameworks.set(
				"node:test",
				`${script.manifest} script "${script.name}"`,
			);
	const nodeList = [...nodesByKey.values()];
	const kindCounts = new Map<string, number>();
	for (const graphNode of nodeList)
		kindCounts.set(graphNode.kind, (kindCounts.get(graphNode.kind) ?? 0) + 1);
	const countKind = (kind: string) => kindCounts.get(kind) ?? 0;
	const edgeCounts: Record<string, number> = {};
	for (const edge of consistent)
		edgeCounts[edge.kind] = (edgeCounts[edge.kind] ?? 0) + 1;
	const latest = input.commits[0] ?? null;
	const notes: string[] = [];
	if (parseFailures.length > 0)
		notes.push(
			`${parseFailures.length} file(s) could not be parsed; their symbols and edges are missing.`,
		);
	if (Object.keys(unsupportedCode).length > 0)
		notes.push(
			`Source in ${Object.keys(unsupportedCode).join(", ")} is listed but not parsed (parsed languages: ${[...PARSED_LANGUAGES].join(", ")}).`,
		);
	if (unresolved.imports > 0)
		notes.push(
			`${unresolved.imports} import(s) could not be resolved to a tracked file or a declared dependency (path aliases and undeclared packages are not resolved).`,
		);
	if (unresolved.calls + unresolved.member_calls > 0)
		notes.push(
			`${unresolved.calls} direct call(s) and ${unresolved.member_calls} method call(s) on values of unknown type are not linked; dependents reached only through them are missing.`,
		);
	if (unresolved.requests > 0)
		notes.push(
			`${unresolved.requests} client request(s) match no route in this repository (another service, a dynamic URL, or an unmodelled framework).`,
		);
	if (unresolved.routes_with_unknown_prefix > 0)
		notes.push(
			`${unresolved.routes_with_unknown_prefix} route registration(s) have no resolvable mount prefix; those routes keep file-qualified keys and only heuristic request matches.`,
		);
	if (input.limits.truncatedFiles.length > 0)
		notes.push(
			`${input.limits.truncatedFiles.length} file(s) were not parsed because of size or count limits.`,
		);
	if (danglingEdges > 0)
		notes.push(
			`${danglingEdges} edge(s) pointed at nodes that were not built and were dropped.`,
		);
	return {
		nodes: nodeList,
		edges: consistent,
		profile: {
			commit_sha: input.commitSha,
			tracked_files:
				input.files.length +
				Object.values(input.skipped).reduce(
					(sum, list) => sum + list.length,
					0,
				),
			indexed_files: input.files.length,
			size_bytes: sizeBytes,
			files_by_language: filesByLanguage,
			languages: {
				parsed: Object.keys(filesByLanguage)
					.filter((language) => PARSED_LANGUAGES.has(language))
					.sort(),
				unparsed: Object.keys(unsupportedCode).sort(),
			},
			directories: directories.size,
			packages: input.manifests.map((manifest) => ({
				name: manifest.name,
				path: manifest.path,
				dependencies: Object.keys(manifest.dependencies).length,
				dev_dependencies: Object.keys(manifest.devDependencies).length,
				scripts: Object.keys(manifest.scripts),
			})),
			workspaces: input.manifests
				.flatMap((m) => m.workspaces ?? [])
				.slice(0, 50),
			test_files: testFiles,
			test_cases: testCases,
			symbols: symbolCounts,
			test_commands: scripts
				.filter((script) => /^test(:|$)/.test(script.name))
				.map(
					(script) =>
						`${script.manifest}: npm run ${script.name} (${script.command})`,
				),
			build_commands: scripts
				.filter((script) => /^(build|compile|bundle)(:|$)/.test(script.name))
				.map(
					(script) =>
						`${script.manifest}: npm run ${script.name} (${script.command})`,
				),
			build_systems: [...buildSystems].map(([name, evidence]) => ({
				name,
				evidence,
			})),
			test_frameworks: [...testFrameworks].map(([name, evidence]) => ({
				name,
				evidence,
			})),
			entry_points: [...entryPoints].sort(),
			frameworks: [...dependencyNames]
				.filter((name) => FRAMEWORKS.has(name))
				.map((name) => ({
					name: FRAMEWORKS.get(name) ?? name,
					evidence: `declared dependency "${name}" in package.json`,
					imported_by: importers.get(name) ?? 0,
				})),
			surface: {
				routes: countKind("route"),
				pages: countKind("page"),
				db_tables: countKind("db_table"),
				external_services: countKind("external_service"),
				config_keys: countKind("config_key"),
				events: countKind("event"),
				queues: countKind("queue"),
			},
			history: {
				commits_indexed: input.commits.length,
				latest: latest
					? { sha: latest.sha, date: latest.date, subject: latest.subject }
					: null,
			},
			counting_rules: [
				"tracked_files counts every path git tracks at the commit, including skipped ones; indexed_files excludes ignored directories, sensitive files, symlinks, submodules, and files over the size limit.",
				"Languages are assigned by file extension; size_bytes sums indexed files.",
				"test_files are files under test/, tests/, __tests__/, spec/ or named *.test.* / *.spec.*, plus parsed files that import a test runner.",
				"test_cases are test()/it() calls with literal titles in parsed test files; describe titles become prefixes.",
				"Symbols are top-level declarations, class and interface methods, object-literal members, functions declared in components and hooks, and named inline handlers in parsed JavaScript and TypeScript; hooks follow React's use* naming rule.",
				"frameworks lists declared dependencies with the number of files importing them; declared is not proof of use.",
				"surface counts the routes, pages, tables, external hosts, configuration keys, events, and queues the extractor found; unmodelled frameworks contribute nothing.",
			],
		},
		coverage: {
			complete:
				parseFailures.length === 0 &&
				Object.keys(unsupportedCode).length === 0 &&
				input.limits.truncatedFiles.length === 0,
			extractor_version: EXTRACTOR_VERSION,
			parsed_files: parsedFiles,
			parse_failures: parseFailures.slice(0, 100),
			unsupported_code_files: unsupportedCode,
			skipped: Object.fromEntries(
				Object.entries(input.skipped).map(([reason, list]) => [
					reason,
					list.length,
				]),
			),
			unresolved,
			unsupported_patterns: unsupportedPatterns,
			extracted_node_kinds: [...kindCounts.keys()].sort(),
			extracted_edge_kinds: [...EXTRACTED_EDGE_KINDS],
			unsupported_edge_kinds: [...UNSUPPORTED_EDGE_KINDS],
			edge_counts: edgeCounts,
			edge_support: EDGE_SUPPORT,
			consistency: { dangling_edges: danglingEdges, dropped },
			truncated_files: input.limits.truncatedFiles.slice(0, 100),
			notes,
		},
	};
}
