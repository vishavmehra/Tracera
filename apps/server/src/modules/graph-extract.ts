import { type ParserPlugin, parse } from "@babel/parser";

// Static extraction for the Repository Knowledge Graph. Source is parsed and
// never executed. Each language adapter turns one file into a FileExtraction of syntactic facts; linking
// (graph-build.ts) turns them into nodes and edges only through bindings it can resolve, and counts
// everything else as unresolved or unsupported instead of guessing.

// Also names the linker's output: bump it whenever linking changes (for example, resolving workspace
// package names), so snapshots and patch analyses from an older version are not reused.
export const EXTRACTOR_VERSION = "graph-extract.v4";

const LANGUAGES: Array<[RegExp, string]> = [
	[/\.(ts|tsx|mts|cts)$/i, "typescript"],
	[/\.(js|jsx|mjs|cjs)$/i, "javascript"],
	[/\.json$/i, "json"],
	[/\.(md|markdown|mdx)$/i, "markdown"],
	[/\.(css|scss|sass|less)$/i, "css"],
	[/\.html?$/i, "html"],
	[/\.py$/i, "python"],
	[/\.go$/i, "go"],
	[/\.rs$/i, "rust"],
	[/\.(java|kt|kts|scala)$/i, "jvm"],
	[/\.rb$/i, "ruby"],
	[/\.php$/i, "php"],
	[/\.(c|h|cc|cpp|hpp|cxx)$/i, "c_cpp"],
	[/\.cs$/i, "csharp"],
	[/\.swift$/i, "swift"],
	[/\.(sh|bash|zsh|ps1)$/i, "shell"],
	[/\.ya?ml$/i, "yaml"],
	[/\.sql$/i, "sql"],
	[/\.(toml|ini|cfg|conf)$/i, "config"],
];
export const languageOf = (file: string) =>
	LANGUAGES.find(([pattern]) => pattern.test(file))?.[1] ?? "other";
/** Languages that hold program logic: present but unparsed means incomplete coverage. */
export const CODE_LANGUAGES = new Set([
	"javascript",
	"typescript",
	"python",
	"go",
	"rust",
	"jvm",
	"ruby",
	"php",
	"c_cpp",
	"csharp",
	"swift",
]);
export const TEST_FILE =
	/(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_RUNNERS = new Set([
	"node:test",
	"vitest",
	"jest",
	"@jest/globals",
	"mocha",
]);
const KNOWN_GLOBALS = new Set(
	"require Number String Boolean Array Object Promise Symbol Error TypeError RangeError Date Map Set WeakMap WeakSet JSON Math parseInt parseFloat isNaN isFinite setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone fetch URL URLSearchParams BigInt Proxy Reflect RegExp encodeURIComponent decodeURIComponent console expect describe test it suite beforeEach afterEach beforeAll afterAll before after".split(
		" ",
	),
);
/** Receivers whose methods are platform APIs, not repository code (never counted as unresolved). */
const GLOBAL_RECEIVERS = new Set([
	...KNOWN_GLOBALS,
	..."process document window navigator location history localStorage sessionStorage crypto Buffer globalThis performance Intl Atomics WebAssembly self".split(
		" ",
	),
]);

export type SymbolKind =
	| "function"
	| "class"
	| "method"
	| "variable"
	| "interface"
	| "type_alias"
	| "enum"
	| "ui_component"
	| "hook";

/** How a member call's receiver is known: `this`, a type (annotation or `new`), a typed field, or a binding. */
export type Receiver =
	| { kind: "this"; className: string }
	| { kind: "type"; typeName: string }
	| { kind: "field"; className: string; field: string }
	| { kind: "binding"; name: string };

/** A channel name: a literal, or a property of a constant object (resolved across files when linking). */
export type ChannelRef =
	| { literal: string }
	| { constant: string; property: string };

export type RouteReceiverKind = "app" | "router" | "plugin_param" | "unknown";
export type MountTarget = { name: string } | { specifier: string };

export type FileExtraction = {
	symbols: Array<{
		name: string;
		kind: SymbolKind;
		start_line: number;
		end_line: number;
		exported: boolean;
		parent: string | null;
		/** Set for handlers Tracera names itself (inline route and event handlers). */
		synthetic?: "route_handler" | "event_handler";
	}>;
	/** Exported name → local symbol name (`default` for default exports). */
	exports: Record<string, string>;
	/**
	 * The file may export names `exports` does not list (CommonJS, `export =`, exported namespaces,
	 * destructured or expression default exports), so a name missing from it is unknown, not absent.
	 */
	opaque_exports: boolean;
	imports: Array<{
		specifier: string;
		names: Array<{ imported: string; local: string }>;
		line: number;
		kind: "static" | "dynamic" | "require" | "reexport" | "type";
	}>;
	calls: Array<{ caller: string | null; callee: string; line: number }>;
	member_calls: Array<{
		caller: string | null;
		receiver: Receiver;
		property: string;
		line: number;
	}>;
	references: Array<{ from: string | null; name: string; line: number }>;
	renders: Array<{ from: string | null; component: string; line: number }>;
	implements: Array<{
		className: string;
		interfaceName: string;
		line: number;
	}>;
	extends: Array<{ name: string; superName: string; line: number }>;
	tests: Array<{
		name: string;
		start_line: number;
		end_line: number;
		calls: string[];
	}>;
	/** Module-level `const x = new T()` (and other typed module bindings): x → T. */
	instances: Record<string, string>;
	/** Class → field → type, from typed properties, constructor parameter properties, and `this.f = new T()`. */
	field_types: Record<string, Record<string, string>>;
	/** Module-level HTTP apps and routers: variable → framework and role. */
	routers: Record<string, { framework: string; kind: "app" | "router" }>;
	/** Module-level HTTP clients (`axios.create`): variable → base URL. */
	http_clients: Record<string, { base_url: string | null }>;
	routes: Array<{
		method: string;
		path: string;
		receiver: string;
		receiver_kind: RouteReceiverKind;
		scope: string | null;
		framework: string | null;
		certainty: "resolved" | "heuristic";
		line: number;
		handlers: Array<{
			name: string | null;
			symbol: string | null;
			role: "handler" | "middleware";
		}>;
	}>;
	mounts: Array<{
		receiver: string;
		receiver_kind: RouteReceiverKind;
		scope: string | null;
		prefix: string | null;
		target: MountTarget;
		kind: "router" | "plugin";
		line: number;
	}>;
	pages: Array<{ path: string; component: string; line: number }>;
	requests: Array<{
		caller: string | null;
		method: string;
		url: string;
		client:
			| { kind: "fetch" | "axios" | "xhr" }
			| { kind: "instance"; name: string };
		line: number;
	}>;
	events: Array<{
		owner: string | null;
		event: string;
		handler: string | null;
		symbol: string | null;
		line: number;
	}>;
	channels: Array<{
		owner: string | null;
		direction: "publish" | "subscribe";
		transport: "emitter" | "queue";
		channel: ChannelRef;
		handler: string | null;
		line: number;
		certainty: "resolved" | "heuristic";
	}>;
	data_access: Array<{
		owner: string | null;
		op: "read" | "write";
		target: { table: string } | { binding: string } | { model: string };
		via: "drizzle" | "sql" | "prisma";
		statement: string | null;
		line: number;
		certainty: "resolved" | "heuristic";
	}>;
	/** Tables this file defines or changes: Drizzle table objects or SQL DDL. */
	tables: Array<{
		symbol: string | null;
		table: string;
		statement: "definition" | "create" | "alter" | "drop";
		line: number;
	}>;
	config_reads: Array<{
		owner: string | null;
		key: string;
		source: "process.env" | "import.meta.env";
		line: number;
	}>;
	/** Top-level string constants and objects of string constants (queue and event names, URL bases). */
	constants: Record<string, string | Record<string, string>>;
	is_test_file: boolean;
	unresolved_calls: number;
	unresolved_member_calls: number;
	/** Owner symbol → calls from it that could not be resolved (shown as gaps in traces). */
	unresolved_by_owner: Record<string, number>;
	/** Syntax Tracera saw but does not model (dynamic keys, computed calls, non-literal routes...). */
	unsupported: Record<string, number>;
	parse_error: { message: string; line: number | null } | null;
};

export function emptyExtraction(file: string): FileExtraction {
	return {
		symbols: [],
		exports: {},
		opaque_exports: false,
		imports: [],
		calls: [],
		member_calls: [],
		references: [],
		renders: [],
		implements: [],
		extends: [],
		tests: [],
		instances: {},
		field_types: {},
		routers: {},
		http_clients: {},
		routes: [],
		mounts: [],
		pages: [],
		requests: [],
		events: [],
		channels: [],
		data_access: [],
		tables: [],
		config_reads: [],
		constants: {},
		is_test_file: TEST_FILE.test(file),
		unresolved_calls: 0,
		unresolved_member_calls: 0,
		unresolved_by_owner: {},
		unsupported: {},
		parse_error: null,
	};
}

// ---- Language adapters ------------------------------------------------------------------------

type LanguageAdapter = {
	id: string;
	languages: readonly string[];
	extract(file: string, source: string): FileExtraction;
};

/** One adapter per language family. Adding a language means adding an adapter, never guessing. */
export const LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [
	{
		id: "babel-js-ts",
		languages: ["javascript", "typescript"],
		extract: extractScript,
	},
	{ id: "sql-text", languages: ["sql"], extract: extractSqlFile },
];
/** Languages whose source is parsed. Everything else is listed, counted, and reported. */
export const PARSED_LANGUAGES = new Set(
	LANGUAGE_ADAPTERS.flatMap((adapter) => adapter.languages),
);
const ADAPTER_BY_LANGUAGE = new Map(
	LANGUAGE_ADAPTERS.flatMap((adapter) =>
		adapter.languages.map((language) => [language, adapter] as const),
	),
);

export function extractFile(file: string, source: string): FileExtraction {
	const adapter = ADAPTER_BY_LANGUAGE.get(languageOf(file));
	if (adapter) return adapter.extract(file, source);
	const result = emptyExtraction(file);
	result.parse_error = { message: "no parser for this language", line: null };
	return result;
}

// ---- SQL text: DDL (migrations) and DML in strings ---------------------------------------------

const SQL_IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|\x60[^\x60]+\x60|[A-Za-z_][\w$]*))?`;
const SQL_PLACEHOLDER = String.raw`__tracera_expr_(\d+)__`;
const SQL_TARGET = `(${SQL_PLACEHOLDER}|${SQL_IDENT})`;
const SQL_NOT_TABLE = new Set(
	"set select where values only lateral unnest table if not exists as on using with recursive default".split(
		" ",
	),
);
const sqlName = (raw: string) =>
	(raw.split(".").pop() ?? raw)
		.trim()
		.replace(/^["`]|["`]$/g, "")
		.toLowerCase();

export type SqlTableUse = {
	op: "read" | "write";
	statement: string;
	target: { table: string } | { placeholder: number };
};

/**
 * Tables read and written by SQL text (comments stripped). Interpolations are passed in as
 * `__tracera_expr_N__` placeholders so a table object interpolated into a query stays resolvable.
 */
export function sqlTableUses(text: string): SqlTableUse[] {
	const sql = text
		.replace(/--[^\n]*/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.slice(0, 50_000);
	const uses: SqlTableUse[] = [];
	const deleteFroms = new Set<number>();
	const add = (
		op: "read" | "write",
		statement: string,
		raw: string,
		placeholder: string | undefined,
	) => {
		if (placeholder !== undefined)
			uses.push({
				op,
				statement,
				target: { placeholder: Number(placeholder) },
			});
		else {
			const table = sqlName(raw);
			if (table && !SQL_NOT_TABLE.has(table))
				uses.push({ op, statement, target: { table } });
		}
	};
	// The lookaheads stop backtracking from truncating a name (`jsonb_to_recordset(` → `jsonb_to_records`).
	const write = new RegExp(
		String.raw`\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?)\s+(?:only\s+)?${SQL_TARGET}(?![\w$"\x60.])`,
		"gi",
	);
	for (const match of sql.matchAll(write)) {
		const keyword = (match[1] ?? "").toLowerCase().replace(/\s+/g, " ");
		// `DO UPDATE SET` (upsert) and `FOR UPDATE` (row locks) are not table writes.
		const before = sql.slice(Math.max(0, (match.index ?? 0) - 4), match.index);
		if (keyword === "update" && /(do|for)\s*$/i.test(before)) continue;
		add("write", keyword.toUpperCase(), match[2] ?? "", match[3]);
		if (keyword === "delete from")
			deleteFroms.add(
				(match.index ?? 0) + (match[0].toLowerCase().indexOf("from") ?? 0),
			);
	}
	const read = new RegExp(
		String.raw`\b(from|join)\s+${SQL_TARGET}(?![\w$"\x60.(])`,
		"gi",
	);
	for (const match of sql.matchAll(read)) {
		if (deleteFroms.has(match.index ?? -1)) continue; // the FROM of DELETE FROM
		add("read", (match[1] ?? "").toUpperCase(), match[2] ?? "", match[3]);
	}
	return uses;
}

/** DDL statements: tables created, altered, or dropped. */
function sqlDefinitions(sql: string): Array<{
	table: string;
	statement: "create" | "alter" | "drop";
	offset: number;
}> {
	const out: Array<{
		table: string;
		statement: "create" | "alter" | "drop";
		offset: number;
	}> = [];
	const ddl = new RegExp(
		String.raw`\b(create|alter|drop)\s+(?:(?:global|local)\s+)?(?:(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?(${SQL_IDENT})`,
		"gi",
	);
	for (const match of sql.matchAll(ddl)) {
		const table = sqlName(match[2] ?? "");
		if (table)
			out.push({
				table,
				statement: (match[1] ?? "create").toLowerCase() as
					| "create"
					| "alter"
					| "drop",
				offset: match.index ?? 0,
			});
	}
	return out;
}

function extractSqlFile(file: string, source: string): FileExtraction {
	const result = emptyExtraction(file);
	const text = source.slice(0, 2_000_000);
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++)
		if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
	const lineAt = (offset: number) => {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if ((lineStarts[mid] ?? 0) <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};
	for (const definition of sqlDefinitions(text))
		result.tables.push({
			symbol: null,
			table: definition.table,
			statement: definition.statement,
			line: lineAt(definition.offset),
		});
	// Row reads and writes in migrations and seed files.
	for (const use of sqlTableUses(text))
		if ("table" in use.target)
			result.data_access.push({
				owner: null,
				op: use.op,
				target: { table: use.target.table },
				via: "sql",
				statement: use.statement,
				line: 1,
				certainty: "resolved",
			});
	return result;
}

// ---- JavaScript and TypeScript (Babel) ----------------------------------------------------------

type AstNode = {
	type: string;
	loc?: { start: { line: number }; end: { line: number } } | null;
	[key: string]: unknown;
};

const SKIP_KEYS = new Set([
	"loc",
	"start",
	"end",
	"extra",
	"range",
	"leadingComments",
	"trailingComments",
	"innerComments",
	"comments",
	"tokens",
]);
const isNode = (value: unknown): value is AstNode =>
	!!value &&
	typeof value === "object" &&
	typeof (value as AstNode).type === "string";
const node = (value: unknown): AstNode | null => (isNode(value) ? value : null);
const nodes = (value: unknown): AstNode[] =>
	Array.isArray(value) ? value.filter(isNode) : [];
const lineOf = (n: AstNode) => n.loc?.start.line ?? 0;
const endOf = (n: AstNode) => n.loc?.end.line ?? lineOf(n);
const nameOf = (n: unknown): string | null => {
	const value = node(n);
	if (!value) return null;
	if (value.type === "Identifier" || value.type === "JSXIdentifier")
		return typeof value.name === "string" ? value.name : null;
	if (value.type === "StringLiteral")
		return typeof value.value === "string" ? value.value : null;
	return null;
};
/** Strips TypeScript-only wrappers (`x as T`, `x!`, `x satisfies T`), parentheses, and `await`. */
const unwrap = (n: unknown): AstNode | null => {
	let value = node(n);
	while (
		value &&
		(value.type === "TSAsExpression" ||
			value.type === "TSSatisfiesExpression" ||
			value.type === "TSNonNullExpression" ||
			value.type === "ParenthesizedExpression" ||
			value.type === "AwaitExpression")
	)
		value = node(value.expression ?? value.argument);
	return value;
};
const stringValue = (n: unknown): string | null => {
	const value = unwrap(n);
	if (!value) return null;
	if (value.type === "StringLiteral" && typeof value.value === "string")
		return value.value;
	if (value.type === "TemplateLiteral" && nodes(value.expressions).length === 0)
		return nodes(value.quasis)
			.map((q) => (q.value as { cooked?: string } | undefined)?.cooked ?? "")
			.join("");
	return null;
};
/** `a.b.c` for identifier and member chains (non-computed), `this` for this; else null. */
const dottedName = (n: unknown): string | null => {
	const value = unwrap(n);
	if (!value) return null;
	if (value.type === "Identifier") return nameOf(value);
	if (value.type === "ThisExpression") return "this";
	if (
		(value.type === "MemberExpression" ||
			value.type === "OptionalMemberExpression") &&
		!value.computed
	) {
		const object = dottedName(value.object);
		const property = nameOf(value.property);
		return object && property ? `${object}.${property}` : null;
	}
	return null;
};
const FUNCTION_TYPES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"ClassMethod",
	"ClassPrivateMethod",
	"ObjectMethod",
]);
/** Branded so a failed check leaves the value an AstNode (a plain `n is AstNode` would narrow to never). */
declare const functionBrand: unique symbol;
type FunctionNode = AstNode & { readonly [functionBrand]: true };
const isFunction = (n: AstNode | null | undefined): n is FunctionNode =>
	!!n && FUNCTION_TYPES.has(n.type);
/** Type name of a `TSTypeReference` (`Foo`, `a.Foo`). */
const typeNameOf = (annotation: unknown): string | null => {
	let value = node(annotation);
	if (value?.type === "TSTypeAnnotation") value = node(value.typeAnnotation);
	if (value?.type !== "TSTypeReference") return null;
	const name = node(value.typeName);
	if (name?.type === "Identifier") return nameOf(name);
	if (name?.type === "TSQualifiedName") {
		const left = nameOf(name.left);
		const right = nameOf(name.right);
		return left && right ? `${left}.${right}` : null;
	}
	return null;
};

/** Identifiers bound by a pattern (params and destructuring). */
function boundNames(pattern: unknown, out: Set<string>) {
	const value = node(pattern);
	if (!value) return;
	switch (value.type) {
		case "Identifier":
			if (typeof value.name === "string") out.add(value.name);
			return;
		case "AssignmentPattern":
			boundNames(value.left, out);
			return;
		case "RestElement":
			boundNames(value.argument, out);
			return;
		case "ArrayPattern":
			for (const element of nodes(value.elements)) boundNames(element, out);
			return;
		case "ObjectPattern":
			for (const property of nodes(value.properties))
				boundNames(
					property.type === "RestElement" ? property.argument : property.value,
					out,
				);
			return;
		case "TSParameterProperty":
			boundNames(value.parameter, out);
	}
}

/**
 * Function-local names as a chain of scopes (innermost first; null is module scope). `types` holds what
 * is known about a local's type: a TS annotation, `new T()`, or a framework marker (`@express:app`).
 */
type Scope = {
	names: ReadonlySet<string>;
	types: ReadonlyMap<string, string>;
	parent: Scope;
} | null;
function isShadowed(scope: Scope, name: string): boolean {
	for (let current = scope; current; current = current.parent)
		if (current.names.has(name)) return true;
	return false;
}
/** A local's known type; null when a local shadows the name without a type; undefined when not local. */
function scopedType(scope: Scope, name: string): string | null | undefined {
	for (let current = scope; current; current = current.parent) {
		const type = current.types.get(name);
		if (type) return type;
		if (current.names.has(name)) return null;
	}
	return undefined;
}

const containsJsx = (root: AstNode | null): boolean => {
	if (!root) return false;
	const stack = [root];
	let visited = 0;
	while (stack.length > 0 && visited < 5000) {
		const current = stack.pop() as AstNode;
		visited += 1;
		if (current.type === "JSXElement" || current.type === "JSXFragment")
			return true;
		for (const [key, value] of Object.entries(current)) {
			if (SKIP_KEYS.has(key)) continue;
			if (isNode(value)) stack.push(value);
			else if (Array.isArray(value)) stack.push(...value.filter(isNode));
		}
	}
	return false;
};

function plugins(file: string): ParserPlugin[] {
	const typescript = /\.(ts|tsx|mts|cts)$/i.test(file);
	const jsx = /\.(tsx|jsx|js|mjs|cjs)$/i.test(file);
	const list: ParserPlugin[] = [];
	if (typescript) list.push("typescript");
	if (jsx) list.push("jsx");
	return list;
}

/** Hooks by React's naming rule; components are capitalised functions that return JSX. */
const functionKind = (name: string, body: AstNode | null): SymbolKind =>
	/^use[A-Z0-9]/.test(name)
		? "hook"
		: /^[A-Z]/.test(name) && containsJsx(body)
			? "ui_component"
			: "function";

const HTTP_METHODS = new Set([
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"del",
	"options",
	"head",
	"all",
]);
/** Server frameworks: module → framework and the type names that denote an app or a router. */
const SERVER_MODULES: Record<
	string,
	{ framework: string; app: readonly string[]; router: readonly string[] }
> = {
	express: {
		framework: "express",
		app: ["Express", "Application"],
		router: ["Router", "IRouter"],
	},
	fastify: { framework: "fastify", app: ["FastifyInstance"], router: [] },
	hono: { framework: "hono", app: ["Hono"], router: [] },
	"@koa/router": { framework: "koa-router", app: [], router: ["Router"] },
	"koa-router": { framework: "koa-router", app: [], router: ["Router"] },
};
/** Generic DOM, stream, and process events: an `.on("data")` says nothing about application channels. */
const NOISY_EVENTS = new Set(
	"data end error close finish open message connect connection exit drain readable ready listening request response timeout abort change input click load unload resize scroll keydown keyup submit beforeExit uncaughtException unhandledRejection SIGINT SIGTERM warning".split(
		" ",
	),
);
const DRIZZLE_READS = new Set([
	"from",
	"innerJoin",
	"leftJoin",
	"rightJoin",
	"fullJoin",
	"crossJoin",
]);
const DRIZZLE_WRITES = new Set(["insert", "update", "delete"]);
const DRIZZLE_TABLE_FACTORIES = new Set([
	"pgTable",
	"mysqlTable",
	"sqliteTable",
]);
const PRISMA_READ = /^(find|count|aggregate|groupBy)/;
const PRISMA_WRITE = /^(create|update|upsert|delete)/;
const SQL_CALLS = new Set([
	"query",
	"execute",
	"exec",
	"raw",
	"prepare",
	"unsafe",
	"queryRaw",
	"executeRaw",
	"$queryRaw",
	"$executeRaw",
	"$queryRawUnsafe",
	"$executeRawUnsafe",
]);
const SQL_START = /^\s*(select|insert|update|delete|with|merge|truncate)\b/i;
const ROUTER_FACTORIES = new Set([
	"createBrowserRouter",
	"createHashRouter",
	"createMemoryRouter",
	"useRoutes",
]);
/** Wrappers whose last argument is the real handler: asyncHandler(fn), catchAsync(fn), wrap(fn). */
const HANDLER_WRAPPER = /async|handler|wrap|catch|try/i;
/** CommonJS exports anywhere in a file (also nested or computed ones the declaration pass skips). */
const COMMONJS_EXPORTS = /\bmodule\.exports\b|\bexports\s*[.[,)]/;

/** Joins route path segments: prefix "/api" + "/orders/" → "/api/orders"; "/" alone stays "/". */
export function joinRoutePath(prefix: string, routePath: string): string {
	const joined = `/${prefix}/${routePath}`.replace(/\/+/g, "/");
	return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

function extractScript(file: string, source: string): FileExtraction {
	const result = emptyExtraction(file);
	let program: AstNode;
	try {
		const ast = parse(source, {
			sourceType: "unambiguous",
			plugins: plugins(file),
		}) as unknown as { program: AstNode };
		program = ast.program;
	} catch (error) {
		const failure = error as { message?: string; loc?: { line?: number } };
		result.parse_error = {
			message: String(failure.message ?? "parse error").slice(0, 200),
			line: failure.loc?.line ?? null,
		};
		return result;
	}
	if (COMMONJS_EXPORTS.test(source)) result.opaque_exports = true;

	const topLevel = new Set<string>();
	const symbolNames = new Set<string>();
	/** Function node → the symbol that owns calls inside it (methods, nested functions, synthetic handlers). */
	const nodeOwners = new Map<AstNode, string>();
	/** Method or nested symbol name → its class (for `this`). */
	const methodClass = new Map<string, string>();
	/** Components and hooks → names of the functions declared directly in their bodies. */
	const nested = new Map<string, Set<string>>();
	const imported = new Map<string, { specifier: string; imported: string }>();
	/** Module-level knowledge about a variable: an instance type or a framework/client marker. */
	const moduleTypes = new Map<string, string>();
	const unsupported = (pattern: string) => {
		result.unsupported[pattern] = (result.unsupported[pattern] ?? 0) + 1;
	};
	const unresolvedFrom = (owner: string | null) => {
		const key = owner ?? "(module)";
		result.unresolved_by_owner[key] =
			(result.unresolved_by_owner[key] ?? 0) + 1;
	};
	const addSymbol = (
		name: string,
		kind: SymbolKind,
		n: AstNode,
		exported: boolean,
		parent: string | null = null,
		synthetic?: "route_handler" | "event_handler",
	) => {
		if (symbolNames.has(name)) return false;
		symbolNames.add(name);
		result.symbols.push({
			name,
			kind,
			start_line: lineOf(n),
			end_line: endOf(n),
			exported,
			parent,
			...(synthetic ? { synthetic } : {}),
		});
		if (!parent) topLevel.add(name);
		if (exported && !parent) result.exports[name] = name;
		return true;
	};
	const addImport = (
		specifier: string,
		names: Array<{ imported: string; local: string }>,
		line: number,
		kind: FileExtraction["imports"][number]["kind"],
	) => {
		result.imports.push({ specifier, names, line, kind });
		if (kind !== "reexport")
			for (const name of names)
				if (name.local !== "*")
					imported.set(name.local, { specifier, imported: name.imported });
	};
	const importedFrom = (local: string) => imported.get(local)?.specifier;
	/** The framework module a local name was imported from (express, fastify, hono, koa router). */
	const frameworkOf = (local: string | null) => {
		if (!local) return null;
		const specifier = importedFrom(local);
		return specifier && SERVER_MODULES[specifier] ? specifier : null;
	};

	/** What `init` makes a variable: a router or app, an HTTP client, a class instance, or nothing known. */
	const markerOf = (init: AstNode | null): string | null => {
		const value = unwrap(init);
		if (!value) return null;
		if (value.type === "NewExpression") {
			const callee = nameOf(value.callee);
			const module = frameworkOf(callee);
			const framework = module ? SERVER_MODULES[module]?.framework : undefined;
			if (framework === "hono") return "@hono:app";
			if (framework === "koa-router") return "@koa-router:router";
			return dottedName(value.callee);
		}
		if (value.type !== "CallExpression") return null;
		const callee = node(value.callee);
		const calleeName = nameOf(callee);
		const module = frameworkOf(calleeName);
		if (module === "express")
			return imported.get(calleeName ?? "")?.imported === "Router"
				? "@express:router"
				: "@express:app";
		if (module === "fastify") return "@fastify:app";
		const dotted = dottedName(callee);
		if (!dotted) return null;
		const [head = "", member] = dotted.split(".");
		if (frameworkOf(head) === "express" && member === "Router")
			return "@express:router";
		if (importedFrom(head) === "axios" && member === "create") {
			const config = unwrap(nodes(value.arguments)[0]);
			const base =
				config?.type === "ObjectExpression"
					? nodes(config.properties).find((p) => nameOf(p.key) === "baseURL")
					: undefined;
			return `@http_client:${base ? (stringValue(base.value) ?? "?") : ""}`;
		}
		return null;
	};

	const declareClass = (
		declaration: AstNode,
		name: string,
		exported: boolean,
	) => {
		addSymbol(name, "class", declaration, exported);
		for (const implemented of nodes(declaration.implements)) {
			const interfaceName =
				dottedName(implemented.expression) ?? nameOf(implemented.id);
			if (interfaceName)
				result.implements.push({
					className: name,
					interfaceName,
					line: lineOf(implemented),
				});
		}
		const superName = dottedName(declaration.superClass);
		if (superName)
			result.extends.push({
				name,
				superName,
				line: lineOf(node(declaration.superClass) ?? declaration),
			});
		const fields: Record<string, string> = {};
		for (const member of nodes(node(declaration.body)?.body)) {
			if (
				(member.type === "ClassProperty" ||
					member.type === "ClassAccessorProperty") &&
				!member.computed
			) {
				const field = nameOf(member.key);
				const value = unwrap(member.value);
				const type =
					typeNameOf(member.typeAnnotation) ??
					(value?.type === "NewExpression" ? dottedName(value.callee) : null);
				if (field && type) fields[field] = type;
				continue;
			}
			if (member.type !== "ClassMethod" && member.type !== "ClassPrivateMethod")
				continue;
			const methodName = nameOf(member.key) ?? nameOf(node(member.key)?.id);
			if (!methodName) continue;
			const symbol = `${name}.${methodName}`;
			addSymbol(symbol, "method", member, false, name);
			nodeOwners.set(member, symbol);
			methodClass.set(symbol, name);
			if (methodName !== "constructor") continue;
			for (const param of nodes(member.params)) {
				if (param.type !== "TSParameterProperty") continue;
				const inner = node(param.parameter);
				const id =
					inner?.type === "AssignmentPattern" ? node(inner.left) : inner;
				const field = nameOf(id);
				const type = typeNameOf(id?.typeAnnotation);
				if (field && type) fields[field] = type;
			}
			for (const statement of nodes(node(member.body)?.body)) {
				const expression = node(statement.expression);
				if (expression?.type !== "AssignmentExpression") continue;
				const left = node(expression.left);
				const right = unwrap(expression.right);
				if (
					left?.type === "MemberExpression" &&
					node(left.object)?.type === "ThisExpression" &&
					right?.type === "NewExpression"
				) {
					const field = nameOf(left.property);
					const type = dottedName(right.callee);
					if (field && type) fields[field] = type;
				}
			}
		}
		if (Object.keys(fields).length > 0) result.field_types[name] = fields;
	};

	/** Functions declared directly in a component's or hook's body become `Owner.name` symbols. */
	const declareNested = (owner: string, fn: AstNode | null) => {
		const body = node(fn?.body);
		if (body?.type !== "BlockStatement") return;
		const names = new Set<string>();
		const add = (name: string | null, inner: AstNode | null, at: AstNode) => {
			if (!name || !isFunction(inner)) return;
			const symbol = `${owner}.${name}`;
			if (addSymbol(symbol, "function", at, false, owner)) {
				nodeOwners.set(inner, symbol);
				names.add(name);
			}
		};
		for (const statement of nodes(body.body)) {
			if (statement.type === "FunctionDeclaration")
				add(nameOf(statement.id), statement, statement);
			if (statement.type !== "VariableDeclaration") continue;
			for (const declarator of nodes(statement.declarations)) {
				const init = unwrap(declarator.init);
				// useCallback(fn, deps) wraps the handler itself.
				const wrapped =
					init?.type === "CallExpression" &&
					dottedName(init.callee)?.split(".").pop() === "useCallback"
						? unwrap(nodes(init.arguments)[0])
						: init;
				add(nameOf(declarator.id), wrapped, declarator);
			}
		}
		if (names.size > 0) nested.set(owner, names);
	};

	/** Functions in a top-level object literal (`export const api = { list() {} }`) become `api.list`. */
	const declareObjectMembers = (owner: string, object: AstNode | null) => {
		if (object?.type !== "ObjectExpression") return;
		for (const property of nodes(object.properties)) {
			if (property.computed) continue;
			const key = nameOf(property.key);
			if (!key) continue;
			const value =
				property.type === "ObjectMethod" ? property : unwrap(property.value);
			if (!isFunction(value)) continue;
			const symbol = `${owner}.${key}`;
			if (addSymbol(symbol, "method", property, false, owner))
				nodeOwners.set(value, symbol);
		}
	};

	const declareVariable = (
		declarator: AstNode,
		statement: AstNode,
		exported: boolean,
	) => {
		const init = unwrap(declarator.init);
		const id = node(declarator.id);
		const required =
			init?.type === "CallExpression" && nameOf(init.callee) === "require";
		// `export const { a } = x` and `export const a = require(...)` export names not recorded below.
		if (exported && (required || id?.type !== "Identifier"))
			result.opaque_exports = true;
		if (required) return; // recorded in the import pass
		// `const { A, B } = process.env` reads configuration keys.
		if (id?.type === "ObjectPattern" && dottedName(init) === "process.env") {
			for (const property of nodes(id.properties)) {
				const key = nameOf(property.key);
				if (key)
					result.config_reads.push({
						owner: null,
						key,
						source: "process.env",
						line: lineOf(property),
					});
			}
			return;
		}
		const name = nameOf(id);
		if (!name) return;
		const kind = isFunction(init) ? functionKind(name, init) : "variable";
		addSymbol(name, kind, statement, exported);
		if (isFunction(init)) {
			nodeOwners.set(init, name);
			if (kind === "ui_component" || kind === "hook") declareNested(name, init);
		}
		const marker = markerOf(init);
		if (marker) {
			moduleTypes.set(name, marker);
			if (marker.startsWith("@http_client:"))
				result.http_clients[name] = {
					base_url: marker.slice("@http_client:".length) || null,
				};
			else if (marker.startsWith("@")) {
				const [framework = "", role = ""] = marker.slice(1).split(":");
				if (role === "app" || role === "router")
					result.routers[name] = { framework, kind: role };
			} else result.instances[name] = marker;
		}
		// Drizzle table definitions: const users = pgTable("users", { ... }).
		if (init?.type === "CallExpression") {
			const callee = dottedName(init.callee) ?? "";
			const factory = callee.split(".").pop() ?? "";
			const table = stringValue(nodes(init.arguments)[0]);
			if (
				table &&
				(DRIZZLE_TABLE_FACTORIES.has(factory) ||
					(factory === "table" && callee.includes(".")))
			)
				result.tables.push({
					symbol: name,
					table: table.toLowerCase(),
					statement: "definition",
					line: lineOf(statement),
				});
		}
		// String constants and objects of string constants (queue names, URL bases).
		const literal = stringValue(init);
		if (literal !== null) result.constants[name] = literal;
		else if (init?.type === "ObjectExpression") {
			const map: Record<string, string> = {};
			for (const property of nodes(init.properties)) {
				const key = property.computed ? null : nameOf(property.key);
				const value = stringValue(property.value);
				if (key && value !== null) map[key] = value;
			}
			if (Object.keys(map).length > 0) result.constants[name] = map;
			declareObjectMembers(name, init);
		}
	};

	/** CommonJS: `module.exports = x | {...} | function`, `exports.name = ...`. */
	const declareCommonJs = (expression: AstNode) => {
		if (expression.type !== "AssignmentExpression") return;
		const target = dottedName(expression.left);
		const right = unwrap(expression.right);
		if (!target || !right) return;
		if (target === "module.exports") {
			if (right.type === "Identifier") {
				const name = nameOf(right);
				if (name) result.exports.default = name;
			} else if (right.type === "ObjectExpression") {
				for (const property of nodes(right.properties)) {
					const key = property.computed ? null : nameOf(property.key);
					if (!key) continue;
					const value =
						property.type === "ObjectMethod"
							? property
							: unwrap(property.value);
					if (value?.type === "Identifier") {
						const local = nameOf(value);
						if (local) result.exports[key] = local;
					} else if (isFunction(value)) {
						addSymbol(key, functionKind(key, value), property, true);
						nodeOwners.set(value, key);
					}
				}
			} else if (isFunction(right)) {
				addSymbol("default", "function", right, true);
				nodeOwners.set(right, "default");
				result.exports.default = "default";
			}
			return;
		}
		const member = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(
			target,
		)?.[1];
		if (!member) return;
		if (right.type === "Identifier") {
			const local = nameOf(right);
			if (local) result.exports[member] = local;
		} else if (isFunction(right)) {
			addSymbol(member, functionKind(member, right), right, true);
			nodeOwners.set(right, member);
		}
	};

	const declare = (statement: AstNode, exported: boolean) => {
		switch (statement.type) {
			case "ExportNamedDeclaration": {
				const declaration = node(statement.declaration);
				if (declaration) declare(declaration, true);
				const source = stringValue(statement.source);
				const specifiers = nodes(statement.specifiers).map((specifier) => ({
					original: nameOf(specifier.local) ?? "*",
					exported:
						nameOf(specifier.exported) ?? nameOf(specifier.local) ?? "*",
				}));
				if (source)
					addImport(
						source,
						specifiers.map((s) => ({
							imported: s.original,
							local: s.exported,
						})),
						lineOf(statement),
						"reexport",
					);
				else
					for (const specifier of specifiers)
						result.exports[specifier.exported] = specifier.original;
				return;
			}
			case "ExportDefaultDeclaration": {
				const declaration = node(statement.declaration);
				if (!declaration) return;
				const id = nameOf(declaration.id);
				if (declaration.type === "Identifier") {
					const name = nameOf(declaration);
					if (name) result.exports.default = name;
					return;
				}
				if (declaration.type === "ClassDeclaration") {
					declareClass(declaration, id ?? "default", true);
					result.exports.default = id ?? "default";
					return;
				}
				if (isFunction(declaration)) {
					const name = id ?? "default";
					const kind = functionKind(name, declaration);
					addSymbol(name, kind, declaration, true);
					nodeOwners.set(declaration, name);
					if (kind === "ui_component" || kind === "hook")
						declareNested(name, declaration);
					result.exports.default = name;
					return;
				}
				const object = unwrap(declaration);
				if (object?.type === "ObjectExpression") {
					addSymbol("default", "variable", declaration, true);
					declareObjectMembers("default", object);
					result.exports.default = "default";
				} else result.opaque_exports = true; // `export default connect(...)(X)`
				return;
			}
			case "ExportAllDeclaration": {
				const source = stringValue(statement.source);
				if (source)
					addImport(
						source,
						[{ imported: "*", local: nameOf(statement.exported) ?? "*" }],
						lineOf(statement),
						"reexport",
					);
				return;
			}
			case "FunctionDeclaration":
			case "TSDeclareFunction": {
				const name = nameOf(statement.id);
				if (!name) return;
				const kind = functionKind(name, statement);
				addSymbol(name, kind, statement, exported);
				nodeOwners.set(statement, name);
				if (kind === "ui_component" || kind === "hook")
					declareNested(name, statement);
				return;
			}
			case "ClassDeclaration": {
				const name = nameOf(statement.id);
				if (name) declareClass(statement, name, exported);
				return;
			}
			case "VariableDeclaration":
				for (const declarator of nodes(statement.declarations))
					declareVariable(declarator, statement, exported);
				return;
			case "TSInterfaceDeclaration": {
				const name = nameOf(statement.id);
				if (!name) return;
				addSymbol(name, "interface", statement, exported);
				for (const heritage of nodes(statement.extends)) {
					const superName = dottedName(heritage.expression);
					if (superName)
						result.extends.push({ name, superName, line: lineOf(heritage) });
				}
				for (const member of nodes(node(statement.body)?.body))
					if (member.type === "TSMethodSignature" && !member.computed) {
						const method = nameOf(member.key);
						if (method)
							addSymbol(`${name}.${method}`, "method", member, false, name);
					}
				return;
			}
			case "TSTypeAliasDeclaration":
			case "TSEnumDeclaration": {
				const name = nameOf(statement.id);
				if (name)
					addSymbol(
						name,
						statement.type === "TSEnumDeclaration" ? "enum" : "type_alias",
						statement,
						exported,
					);
				return;
			}
			case "ExpressionStatement": {
				const expression = node(statement.expression);
				if (expression) declareCommonJs(expression);
				return;
			}
			// `export = x`, exported namespaces, and `export import a = b.c` export unlisted names.
			case "TSExportAssignment":
			case "TSModuleDeclaration":
			case "TSImportEqualsDeclaration":
				if (
					exported ||
					statement.isExport === true ||
					statement.type === "TSExportAssignment"
				)
					result.opaque_exports = true;
		}
	};

	// Pass 1: imports (so declarations can recognise framework constructors wherever imports appear).
	for (const statement of nodes(program.body)) {
		if (statement.type === "ImportDeclaration") {
			const source = stringValue(statement.source);
			if (!source) continue;
			addImport(
				source,
				nodes(statement.specifiers).map((specifier) => ({
					imported:
						specifier.type === "ImportDefaultSpecifier"
							? "default"
							: specifier.type === "ImportNamespaceSpecifier"
								? "*"
								: (nameOf(specifier.imported) ?? "*"),
					local: nameOf(specifier.local) ?? "*",
				})),
				lineOf(statement),
				statement.importKind === "type" ? "type" : "static",
			);
			continue;
		}
		if (statement.type !== "VariableDeclaration") continue;
		for (const declarator of nodes(statement.declarations)) {
			const init = unwrap(declarator.init);
			const requireSource =
				init?.type === "CallExpression" && nameOf(init.callee) === "require"
					? stringValue(nodes(init.arguments)[0])
					: null;
			if (!requireSource) continue;
			const id = node(declarator.id);
			const names =
				id?.type === "ObjectPattern"
					? nodes(id.properties).map((property) => ({
							imported: nameOf(property.key) ?? "*",
							local: nameOf(property.value) ?? nameOf(property.key) ?? "*",
						}))
					: [{ imported: "*", local: nameOf(id) ?? "*" }];
			addImport(requireSource, names, lineOf(statement), "require");
		}
	}
	// Pass 2: declarations.
	for (const statement of nodes(program.body))
		if (statement.type !== "ImportDeclaration") declare(statement, false);
	if (result.imports.some((entry) => TEST_RUNNERS.has(entry.specifier)))
		result.is_test_file = true;
	// BullMQ queues and workers at module level: new Queue("emails"), new Worker("emails", fn).
	for (const statement of nodes(program.body)) {
		const declaration =
			statement.type === "ExportNamedDeclaration"
				? node(statement.declaration)
				: statement;
		if (declaration?.type !== "VariableDeclaration") continue;
		for (const declarator of nodes(declaration.declarations)) {
			const init = unwrap(declarator.init);
			const name = nameOf(declarator.id);
			const callee =
				init?.type === "NewExpression" ? nameOf(init.callee) : null;
			if (!init || !name || !callee || importedFrom(callee) !== "bullmq")
				continue;
			const queue = stringValue(nodes(init.arguments)[0]);
			if (!queue) continue;
			const kind = imported.get(callee)?.imported;
			if (kind === "Queue") moduleTypes.set(name, `@queue:${queue}`);
			if (kind === "Worker") {
				const processor = unwrap(nodes(init.arguments)[1]);
				result.channels.push({
					owner: name,
					direction: "subscribe",
					transport: "queue",
					channel: { literal: queue },
					handler:
						processor && !isFunction(processor) ? dottedName(processor) : null,
					line: lineOf(declarator),
					certainty: "resolved",
				});
			}
		}
	}

	// Pass 3: one bounded walk for calls, references, renders, tests, and framework patterns.
	const callKeys = new Set<string>();
	const referenceKeys = new Set<string>();
	const memberKeys = new Set<string>();
	const knownBinding = (name: string, shadow: Scope) =>
		!isShadowed(shadow, name) && (imported.has(name) || topLevel.has(name));
	const addCall = (
		owner: string | null,
		callee: string,
		line: number,
		test: { calls: Set<string> } | null,
	) => {
		test?.calls.add(callee);
		const key = `${owner ?? ""}|${callee}`;
		if (callKeys.has(key)) return;
		callKeys.add(key);
		result.calls.push({ caller: owner, callee, line });
	};
	const addMemberCall = (
		owner: string | null,
		receiver: Receiver,
		property: string,
		line: number,
	) => {
		const key = `${owner ?? ""}|${JSON.stringify(receiver)}|${property}`;
		if (memberKeys.has(key)) return;
		memberKeys.add(key);
		result.member_calls.push({ caller: owner, receiver, property, line });
	};
	/** What is known about an identifier's type here: locals first, then module level. */
	const typeAt = (name: string, shadow: Scope): string | null => {
		const local = scopedType(shadow, name);
		if (local !== undefined) return local;
		return moduleTypes.get(name) ?? null;
	};
	/** A framework marker, or a TS type imported from a server framework, as an app/router/plugin role. */
	const serverRole = (type: string | null) => {
		if (!type) return null;
		if (type.startsWith("@")) {
			const [framework = "", role = ""] = type.slice(1).split(":");
			return role === "app" || role === "router"
				? { framework, role: role as "app" | "router" }
				: null;
		}
		const [head = "", member] = type.split(".");
		const module = importedFrom(head);
		const spec = module ? SERVER_MODULES[module] : undefined;
		if (!spec) return null;
		const name = member ?? imported.get(head)?.imported ?? head;
		if (spec.app.includes(name))
			return {
				framework: spec.framework,
				role:
					spec.framework === "fastify" ? ("plugin" as const) : ("app" as const),
			};
		if (spec.router.includes(name))
			return { framework: spec.framework, role: "router" as const };
		return null;
	};
	const importsServer = result.imports.some((entry) =>
		Boolean(SERVER_MODULES[entry.specifier]),
	);
	/** A route or mount receiver: an app, router, Fastify plugin parameter, or (heuristic) a conventional name. */
	const routeReceiver = (
		object: AstNode,
		owner: string | null,
		shadow: Scope,
	): {
		id: string;
		kind: RouteReceiverKind;
		framework: string | null;
		certainty: "resolved" | "heuristic";
	} | null => {
		const name = object.type === "Identifier" ? nameOf(object) : null;
		if (!name) return null;
		const local = scopedType(shadow, name);
		const scope = owner?.split(".")[0] ?? null;
		const type = local !== undefined ? local : (moduleTypes.get(name) ?? null);
		const server = serverRole(type);
		const id = local !== undefined && scope ? `${scope}:${name}` : name;
		if (server)
			return server.role === "plugin"
				? {
						id: `fn:${scope ?? name}`,
						kind: "plugin_param",
						framework: server.framework,
						certainty: "resolved",
					}
				: {
						id,
						kind: server.role,
						framework: server.framework,
						certainty: "resolved",
					};
		if (name === "fastify" && local !== undefined && scope)
			return {
				id: `fn:${scope}`,
				kind: "plugin_param",
				framework: "fastify",
				certainty: "heuristic",
			};
		if (importsServer && ["app", "router", "server", "routes"].includes(name))
			return { id, kind: "unknown", framework: null, certainty: "heuristic" };
		return null;
	};
	/** Same-file string constants are substituted into templates; other interpolations become `:param`. */
	const urlOf = (n: unknown): string | null => {
		const value = unwrap(n);
		if (!value) return null;
		const literal = stringValue(value);
		if (literal !== null) return literal;
		if (value.type === "TemplateLiteral") {
			const expressions = nodes(value.expressions);
			let out = "";
			nodes(value.quasis).forEach((quasi, i) => {
				out += (quasi.value as { cooked?: string } | undefined)?.cooked ?? "";
				const expression = expressions[i];
				if (!expression) return;
				const name =
					expression.type === "Identifier" ? nameOf(expression) : null;
				const constant = name ? result.constants[name] : undefined;
				out +=
					typeof constant === "string"
						? constant
						: out === ""
							? ":base"
							: ":param";
			});
			return out;
		}
		if (value.type === "BinaryExpression" && value.operator === "+") {
			const left = urlOf(value.left);
			return left === null ? null : `${left}${urlOf(value.right) ?? ":param"}`;
		}
		const name = nameOf(value);
		const constant = name ? result.constants[name] : undefined;
		return typeof constant === "string" ? constant : null;
	};
	const looksLikeUrl = (url: string | null): url is string =>
		url !== null &&
		(url.startsWith("/") ||
			/^https?:\/\//i.test(url) ||
			url.startsWith(":base"));
	const channelOf = (n: unknown): ChannelRef | null => {
		const literal = stringValue(n);
		if (literal !== null) return { literal };
		const dotted = dottedName(n);
		const [constant = "", property, extra] = dotted?.split(".") ?? [];
		if (!constant || !property || extra !== undefined) return null;
		const local = result.constants[constant];
		if (
			local &&
			typeof local === "object" &&
			typeof local[property] === "string"
		)
			return { literal: local[property] as string };
		return { constant, property };
	};
	const syntheticHandler = (
		fn: AstNode,
		name: string,
		owner: string | null,
		role: "route_handler" | "event_handler",
	): string => {
		let unique = name;
		for (let i = 2; symbolNames.has(unique); i++) unique = `${name} #${i}`;
		addSymbol(
			unique,
			"function",
			fn,
			false,
			owner && symbolNames.has(owner) ? owner : null,
			role,
		);
		nodeOwners.set(fn, unique);
		return unique;
	};

	/** Express/Hono/Koa `x.METHOD(path, ...handlers)`, Express `x.route(path).METHOD(h)`, Fastify `x.route({...})`. */
	const recordRoute = (
		call: AstNode,
		object: AstNode,
		property: string,
		args: AstNode[],
		owner: string | null,
		shadow: Scope,
	): boolean => {
		const lower = property.toLowerCase();
		let receiverNode = object;
		let pathNode: unknown = args[0];
		let handlerNodes: unknown[] = args.slice(1);
		let methods = [lower === "del" ? "DELETE" : lower.toUpperCase()];
		const options = unwrap(args[0]);
		if (
			lower === "route" &&
			args.length === 1 &&
			options?.type === "ObjectExpression"
		) {
			// Fastify: route({ method, url, preHandler, handler })
			const field = (key: string) =>
				nodes(options.properties).find(
					(p) => !p.computed && nameOf(p.key) === key,
				);
			const method = unwrap(field("method")?.value);
			methods = (
				method?.type === "ArrayExpression"
					? nodes(method.elements).flatMap((e) => stringValue(e) ?? [])
					: [stringValue(method) ?? ""]
			)
				.filter(Boolean)
				.map((m) => m.toUpperCase());
			pathNode = (field("url") ?? field("path"))?.value;
			handlerNodes = [
				...["preHandler", "onRequest"].flatMap((key) => {
					const value = unwrap(field(key)?.value);
					return value?.type === "ArrayExpression"
						? nodes(value.elements)
						: value
							? [value]
							: [];
				}),
				field("handler")?.value,
			];
			if (methods.length === 0) return false;
		} else if (!HTTP_METHODS.has(lower)) return false;
		// Express chain: app.route("/x").get(handler)
		if (object.type === "CallExpression") {
			const inner = node(object.callee);
			if (
				inner?.type !== "MemberExpression" ||
				inner.computed ||
				nameOf(inner.property) !== "route"
			)
				return false;
			receiverNode = node(inner.object) ?? object;
			pathNode = nodes(object.arguments)[0];
			handlerNodes = args;
		}
		const receiver = routeReceiver(receiverNode, owner, shadow);
		if (!receiver) return false;
		const handlers = handlerNodes
			.map((h) => unwrap(h))
			.filter(
				(h): h is AstNode =>
					!!h &&
					(isFunction(h) ||
						h.type === "Identifier" ||
						h.type === "MemberExpression" ||
						h.type === "CallExpression"),
			);
		if (handlers.length === 0) return false;
		const routePath = urlOf(pathNode);
		if (
			routePath === null ||
			!(routePath.startsWith("/") || routePath === "*")
		) {
			unsupported("non_literal_route_paths");
			return true;
		}
		const scope = owner?.split(".")[0] ?? null;
		for (const method of methods)
			result.routes.push({
				method,
				path: routePath,
				receiver: receiver.id,
				receiver_kind: receiver.kind,
				scope,
				framework: receiver.framework,
				certainty: receiver.certainty,
				line: lineOf(call),
				handlers: handlers.map((handler, i) => {
					const role = i === handlers.length - 1 ? "handler" : "middleware";
					const label = `${method} ${routePath} ${role}`;
					if (isFunction(handler))
						return {
							name: null,
							symbol: syntheticHandler(handler, label, owner, "route_handler"),
							role,
						};
					if (handler.type !== "CallExpression")
						return { name: dottedName(handler), symbol: null, role };
					// asyncHandler(fn) wraps the real handler; validate(schema) is a middleware factory.
					const callee = dottedName(handler.callee);
					const last = unwrap(nodes(handler.arguments).at(-1));
					if (callee && HANDLER_WRAPPER.test(callee) && last) {
						if (isFunction(last))
							return {
								name: null,
								symbol: syntheticHandler(last, label, owner, "route_handler"),
								role,
							};
						return { name: dottedName(last), symbol: null, role };
					}
					return { name: callee, symbol: null, role };
				}),
			});
		return true;
	};

	const mountTarget = (value: AstNode | null): MountTarget | null => {
		if (!value) return null;
		if (value.type === "Identifier") {
			const name = nameOf(value);
			return name ? { name } : null;
		}
		if (value.type === "ImportExpression") {
			const specifier = stringValue(value.source);
			return specifier ? { specifier } : null;
		}
		if (value.type !== "CallExpression") return null;
		const callee = node(value.callee);
		const specifier = stringValue(nodes(value.arguments)[0]);
		if (
			specifier &&
			(nameOf(callee) === "require" || callee?.type === "Import")
		)
			return { specifier };
		// router.routes() (Koa) mounts the router itself.
		if (
			callee?.type === "MemberExpression" &&
			nameOf(callee.property) === "routes"
		) {
			const name = nameOf(callee.object);
			return name ? { name } : null;
		}
		return null;
	};

	/** Express/Koa `x.use(prefix?, router)`, Hono `x.route(prefix, sub)`, Fastify `x.register(plugin, { prefix })`. */
	const recordMount = (
		object: AstNode,
		property: string,
		args: AstNode[],
		owner: string | null,
		shadow: Scope,
	): boolean => {
		if (property !== "use" && property !== "route" && property !== "register")
			return false;
		const receiver = routeReceiver(object, owner, shadow);
		if (!receiver) return false;
		const scope = owner?.split(".")[0] ?? null;
		const line = lineOf(object);
		if (property === "register") {
			const target = mountTarget(unwrap(args[0]));
			if (!target) return false;
			const options = unwrap(args[1]);
			const prefixProperty =
				options?.type === "ObjectExpression"
					? nodes(options.properties).find(
							(p) => !p.computed && nameOf(p.key) === "prefix",
						)
					: undefined;
			const prefix = prefixProperty ? urlOf(prefixProperty.value) : "";
			if (prefix === null) unsupported("non_literal_mount_prefixes");
			result.mounts.push({
				receiver: receiver.id,
				receiver_kind: receiver.kind,
				scope,
				prefix,
				target,
				kind: "plugin",
				line,
			});
			return true;
		}
		const first = urlOf(args[0]);
		const hasPrefix = first?.startsWith("/") === true;
		if (property === "route" && !hasPrefix) return false;
		for (const arg of hasPrefix ? args.slice(1) : args) {
			const target = mountTarget(unwrap(arg));
			if (target)
				result.mounts.push({
					receiver: receiver.id,
					receiver_kind: receiver.kind,
					scope,
					prefix: hasPrefix ? first : "",
					target,
					kind: "router",
					line,
				});
		}
		return true;
	};

	const methodFromInit = (init: unknown): string | null => {
		const value = unwrap(init);
		if (value?.type !== "ObjectExpression") return null;
		const method = nodes(value.properties).find(
			(p) => !p.computed && nameOf(p.key) === "method",
		);
		return method ? (stringValue(method.value)?.toUpperCase() ?? "?") : null;
	};
	const pushRequest = (
		call: AstNode,
		owner: string | null,
		method: string,
		urlNode: unknown,
		client: FileExtraction["requests"][number]["client"],
	) => {
		const url = urlOf(urlNode);
		if (!looksLikeUrl(url)) {
			unsupported("non_literal_request_urls");
			return;
		}
		result.requests.push({
			caller: owner,
			method,
			url,
			client,
			line: lineOf(call),
		});
	};
	/** fetch(url, init) and axios(url | config). */
	const recordDirectRequest = (
		call: AstNode,
		name: string,
		args: AstNode[],
		owner: string | null,
		shadow: Scope,
	): boolean => {
		if (name === "fetch" && !isShadowed(shadow, "fetch")) {
			pushRequest(call, owner, methodFromInit(args[1]) ?? "GET", args[0], {
				kind: "fetch",
			});
			return true;
		}
		if (importedFrom(name) !== "axios" || isShadowed(shadow, name))
			return false;
		const config = unwrap(args[0]);
		if (config?.type === "ObjectExpression") {
			const url = nodes(config.properties).find(
				(p) => !p.computed && nameOf(p.key) === "url",
			);
			pushRequest(call, owner, methodFromInit(config) ?? "GET", url?.value, {
				kind: "axios",
			});
		} else
			pushRequest(call, owner, methodFromInit(args[1]) ?? "GET", args[0], {
				kind: "axios",
			});
		return true;
	};
	/** axios.METHOD(url), instance.METHOD(url) (an axios.create client, here or imported), xhr.open(method, url). */
	const recordMemberRequest = (
		call: AstNode,
		object: AstNode,
		property: string,
		args: AstNode[],
		owner: string | null,
		shadow: Scope,
	): boolean => {
		const objectName = object.type === "Identifier" ? nameOf(object) : null;
		if (!objectName) return false;
		if (property === "open" && args.length >= 2) {
			const method = stringValue(args[0]);
			if (
				method &&
				/^(get|post|put|patch|delete|head|options)$/i.test(method) &&
				looksLikeUrl(urlOf(args[1]))
			) {
				pushRequest(call, owner, method.toUpperCase(), args[1], {
					kind: "xhr",
				});
				return true;
			}
			return false;
		}
		const lower = property.toLowerCase();
		if (!HTTP_METHODS.has(lower) && lower !== "request") return false;
		if (args.some((a) => isFunction(unwrap(a)))) return false;
		const config = unwrap(args[0]);
		const method =
			lower === "request"
				? (methodFromInit(config) ?? "GET")
				: lower === "del"
					? "DELETE"
					: lower.toUpperCase();
		const urlNode =
			lower === "request" && config?.type === "ObjectExpression"
				? nodes(config.properties).find((p) => nameOf(p.key) === "url")?.value
				: args[0];
		if (
			importedFrom(objectName) === "axios" &&
			!isShadowed(shadow, objectName)
		) {
			pushRequest(call, owner, method, urlNode, { kind: "axios" });
			return true;
		}
		const type = typeAt(objectName, shadow);
		if (type?.startsWith("@http_client:")) {
			pushRequest(call, owner, method, urlNode, {
				kind: "instance",
				name: objectName,
			});
			return true;
		}
		// An imported binding may be an HTTP client from another file; linking confirms or drops it.
		if (
			imported.has(objectName) &&
			!isShadowed(shadow, objectName) &&
			looksLikeUrl(urlOf(urlNode))
		) {
			pushRequest(call, owner, method, urlNode, {
				kind: "instance",
				name: objectName,
			});
			return true;
		}
		return false;
	};

	/** Event emitters (`emit`/`on`), pg-boss (`send`/`work`), and BullMQ queues (`queue.add`). */
	const recordChannel = (
		object: AstNode,
		property: string,
		args: AstNode[],
		owner: string | null,
		shadow: Scope,
		line: number,
	): boolean => {
		const objectName = object.type === "Identifier" ? nameOf(object) : null;
		if (!objectName || objectName === "process") return false;
		const type = typeAt(objectName, shadow) ?? "";
		const handlerOf = (value: AstNode | null) =>
			value && !isFunction(value) ? dottedName(value) : null;
		if (
			(type === "PgBoss" || type.endsWith(".PgBoss")) &&
			["send", "publish", "sendAfter", "insert", "work", "subscribe"].includes(
				property,
			)
		) {
			const channel = channelOf(args[0]);
			if (!channel) {
				unsupported("non_literal_channel_names");
				return true;
			}
			const subscribe = property === "work" || property === "subscribe";
			result.channels.push({
				owner,
				direction: subscribe ? "subscribe" : "publish",
				transport: "queue",
				channel,
				handler: subscribe ? handlerOf(unwrap(args.at(-1))) : null,
				line,
				certainty: "resolved",
			});
			return true;
		}
		if (type.startsWith("@queue:") && property === "add") {
			result.channels.push({
				owner,
				direction: "publish",
				transport: "queue",
				channel: { literal: type.slice("@queue:".length) },
				handler: null,
				line,
				certainty: "resolved",
			});
			return true;
		}
		if (
			!["emit", "on", "once", "addListener", "prependListener"].includes(
				property,
			)
		)
			return false;
		const channel = channelOf(args[0]);
		if (!channel || ("literal" in channel && NOISY_EVENTS.has(channel.literal)))
			return false;
		const subscribe = property !== "emit";
		result.channels.push({
			owner,
			direction: subscribe ? "subscribe" : "publish",
			transport: "emitter",
			channel,
			handler: subscribe ? handlerOf(unwrap(args[1])) : null,
			line,
			certainty: "heuristic",
		});
		return true;
	};

	const templateText = (template: AstNode) => {
		const count = nodes(template.expressions).length;
		return nodes(template.quasis)
			.map(
				(q, i) =>
					`${(q.value as { cooked?: string } | undefined)?.cooked ?? ""}${i < count ? `__tracera_expr_${i}__` : ""}`,
			)
			.join("");
	};
	const recordSql = (
		text: string,
		expressions: AstNode[],
		owner: string | null,
		line: number,
	) => {
		for (const use of sqlTableUses(text)) {
			if ("table" in use.target) {
				result.data_access.push({
					owner,
					op: use.op,
					target: { table: use.target.table },
					via: "sql",
					statement: use.statement,
					line,
					certainty: "resolved",
				});
				continue;
			}
			const expression = unwrap(expressions[use.target.placeholder]);
			const binding =
				expression?.type === "Identifier" ? nameOf(expression) : null;
			if (binding)
				result.data_access.push({
					owner,
					op: use.op,
					target: { binding },
					via: "sql",
					statement: use.statement,
					line,
					certainty: "resolved",
				});
		}
	};
	/** Drizzle builders (kept by linking only when the argument is a table object), Prisma, SQL text. */
	const recordDataAccess = (
		object: AstNode,
		property: string,
		args: AstNode[],
		owner: string | null,
		shadow: Scope,
		line: number,
	) => {
		const first = unwrap(args[0]);
		const objectName = object.type === "Identifier" ? nameOf(object) : null;
		if (
			(DRIZZLE_READS.has(property) || DRIZZLE_WRITES.has(property)) &&
			first?.type === "Identifier" &&
			args.length <= 2 &&
			!(objectName && GLOBAL_RECEIVERS.has(objectName))
		) {
			const binding = nameOf(first);
			if (binding)
				result.data_access.push({
					owner,
					op: DRIZZLE_WRITES.has(property) ? "write" : "read",
					target: { binding },
					via: "drizzle",
					statement: property,
					line,
					certainty: "resolved",
				});
		}
		if (
			(PRISMA_READ.test(property) || PRISMA_WRITE.test(property)) &&
			(object.type === "MemberExpression" ||
				object.type === "OptionalMemberExpression") &&
			!object.computed &&
			unwrap(object.object)?.type === "Identifier"
		) {
			const client = nameOf(unwrap(object.object));
			const model = nameOf(object.property);
			const typed = client ? typeAt(client, shadow) === "PrismaClient" : false;
			if (client && model && (typed || client === "prisma"))
				result.data_access.push({
					owner,
					op: PRISMA_WRITE.test(property) ? "write" : "read",
					target: { model: model.toLowerCase() },
					via: "prisma",
					statement: property,
					line,
					certainty: typed ? "resolved" : "heuristic",
				});
		}
		if (SQL_CALLS.has(property) && first) {
			const text =
				first.type === "TemplateLiteral"
					? templateText(first)
					: (stringValue(first) ?? "");
			if (SQL_START.test(text))
				recordSql(
					text,
					first.type === "TemplateLiteral" ? nodes(first.expressions) : [],
					owner,
					line,
				);
		}
	};

	/** createBrowserRouter([{ path, element | Component, children }]) and useRoutes([...]). */
	const recordRouteObjects = (array: AstNode | null, prefix: string) => {
		if (array?.type !== "ArrayExpression") return;
		for (const element of nodes(array.elements)) {
			const object = unwrap(element);
			if (object?.type !== "ObjectExpression") continue;
			const field = (key: string) =>
				nodes(object.properties).find(
					(p) => !p.computed && nameOf(p.key) === key,
				);
			const written = stringValue(field("path")?.value);
			const full =
				written === null
					? field("index")
						? prefix || "/"
						: null
					: written.startsWith("/")
						? written
						: joinRoutePath(prefix, written);
			const view = unwrap(field("element")?.value);
			const component =
				view?.type === "JSXElement"
					? nameOf(node(view.openingElement)?.name)
					: (nameOf(field("Component")?.value) ??
						nameOf(field("component")?.value));
			if (full !== null && component)
				result.pages.push({ path: full, component, line: lineOf(object) });
			recordRouteObjects(unwrap(field("children")?.value), full ?? prefix);
		}
	};

	type TestContext = { calls: Set<string> };
	type Frame = {
		n: AstNode;
		parent: AstNode | null;
		key: string;
		owner: string | null;
		shadow: Scope;
		test: TestContext | null;
		prefix: string[];
		pagePrefix: string;
		finish?: () => void;
	};
	const ownerOf = (statement: AstNode): string | null => {
		const inner =
			statement.type === "ExportNamedDeclaration" ||
			statement.type === "ExportDefaultDeclaration"
				? node(statement.declaration)
				: statement;
		if (!inner) return null;
		if (inner.type === "VariableDeclaration") {
			const declarators = nodes(inner.declarations);
			return declarators.length === 1 ? nameOf(declarators[0]?.id) : null;
		}
		return (
			nameOf(inner.id) ??
			(statement.type === "ExportDefaultDeclaration" &&
			symbolNames.has("default")
				? "default"
				: null)
		);
	};
	/** Names and known types declared directly in a function: params plus top-of-body declarations. */
	const scopeOf = (fn: AstNode, parent: Scope): Scope => {
		const names = new Set<string>();
		const types = new Map<string, string>();
		for (const param of nodes(fn.params)) {
			boundNames(param, names);
			const target =
				param.type === "TSParameterProperty" ? node(param.parameter) : param;
			const id =
				target?.type === "AssignmentPattern" ? node(target.left) : target;
			const name = id?.type === "Identifier" ? nameOf(id) : null;
			const type = typeNameOf(id?.typeAnnotation);
			if (name && type) types.set(name, type);
		}
		const body = node(fn.body);
		for (const statement of body?.type === "BlockStatement"
			? nodes(body.body)
			: []) {
			if (statement.type === "VariableDeclaration")
				for (const declarator of nodes(statement.declarations)) {
					boundNames(declarator.id, names);
					const id = node(declarator.id);
					const name = id?.type === "Identifier" ? nameOf(id) : null;
					const type =
						typeNameOf(id?.typeAnnotation) ?? markerOf(unwrap(declarator.init));
					if (name && type) types.set(name, type);
				}
			if (
				statement.type === "FunctionDeclaration" ||
				statement.type === "ClassDeclaration"
			) {
				const name = nameOf(statement.id);
				if (name) names.add(name);
			}
		}
		return names.size > 0 || types.size > 0 ? { names, types, parent } : parent;
	};
	/** A member call on a known receiver, for method-level CALLS edges resolved when linking. */
	const recordMemberCall = (
		object: AstNode,
		property: string,
		owner: string | null,
		shadow: Scope,
		line: number,
		test: TestContext | null,
	) => {
		const unresolved = () => {
			result.unresolved_member_calls += 1;
			unresolvedFrom(owner);
		};
		if (object.type === "ThisExpression") {
			const className = owner ? methodClass.get(owner) : undefined;
			if (className)
				addMemberCall(owner, { kind: "this", className }, property, line);
			else unresolved();
			return;
		}
		if (object.type === "Super") {
			const className = owner ? methodClass.get(owner) : undefined;
			const superName = result.extends.find(
				(e) => e.name === className,
			)?.superName;
			if (superName)
				addMemberCall(
					owner,
					{ kind: "type", typeName: superName },
					property,
					line,
				);
			else unresolved();
			return;
		}
		if (
			(object.type === "MemberExpression" ||
				object.type === "OptionalMemberExpression") &&
			!object.computed &&
			unwrap(object.object)?.type === "ThisExpression"
		) {
			const className = owner ? methodClass.get(owner) : undefined;
			const field = nameOf(object.property);
			if (className && field && result.field_types[className]?.[field])
				addMemberCall(
					owner,
					{ kind: "field", className, field },
					property,
					line,
				);
			else unresolved();
			return;
		}
		const objectName = object.type === "Identifier" ? nameOf(object) : null;
		if (!objectName) {
			unsupported("calls_on_expressions");
			return;
		}
		const type = typeAt(objectName, shadow);
		if (type && !type.startsWith("@")) {
			addMemberCall(owner, { kind: "type", typeName: type }, property, line);
			return;
		}
		if (type) return; // a framework app, router, client, or queue: a library call
		const binding = imported.get(objectName);
		if (knownBinding(objectName, shadow)) {
			if (binding?.imported === "*")
				addCall(owner, `${objectName}.${property}`, line, test);
			// Calls into packages are library calls, not unresolved repository code.
			else if (!binding || binding.specifier.startsWith("."))
				addMemberCall(
					owner,
					{ kind: "binding", name: objectName },
					property,
					line,
				);
			return;
		}
		if (!GLOBAL_RECEIVERS.has(objectName)) unresolved();
	};

	const stack: Frame[] = nodes(program.body)
		.reverse()
		.map((statement) => ({
			n: statement,
			parent: program,
			key: "body",
			owner: ownerOf(statement),
			shadow: null,
			test: null,
			prefix: [],
			pagePrefix: "",
		}));
	let steps = 0;
	while (stack.length > 0) {
		steps += 1;
		if (steps > 400_000) {
			unsupported("walk_step_limit");
			break; // adversarially large files stay bounded
		}
		const frame = stack.pop() as Frame;
		if (frame.finish) {
			frame.finish();
			continue;
		}
		const { n, parent, key } = frame;
		let { owner, shadow, test, prefix, pagePrefix } = frame;
		if (isFunction(n)) shadow = scopeOf(n, shadow);
		owner = nodeOwners.get(n) ?? owner;
		const line = lineOf(n);
		if (
			n.type === "CallExpression" ||
			n.type === "NewExpression" ||
			n.type === "OptionalCallExpression"
		) {
			const callee = unwrap(n.callee);
			const calleeName = callee?.type === "Identifier" ? nameOf(callee) : null;
			const args = nodes(n.arguments);
			const member =
				callee &&
				(callee.type === "MemberExpression" ||
					callee.type === "OptionalMemberExpression")
					? callee
					: null;
			const property =
				member && !member.computed ? nameOf(member.property) : null;
			const object = member ? unwrap(member.object) : null;
			const runner =
				calleeName ??
				(object?.type === "Identifier" &&
				["skip", "only", "todo"].includes(property ?? "")
					? nameOf(object)
					: null);
			const title = stringValue(args[0]);
			if (
				result.is_test_file &&
				runner &&
				["test", "it", "describe", "suite"].includes(runner) &&
				title !== null
			) {
				const callback = args.find((arg) => isFunction(arg));
				if (runner === "describe" || runner === "suite")
					prefix = [...prefix, title];
				else {
					const entry = {
						name: [...prefix, title].join(" > "),
						start_line: lineOf(n),
						end_line: endOf(n),
						calls: [] as string[],
					};
					result.tests.push(entry);
					const context: TestContext = { calls: new Set() };
					test = context;
					stack.push({
						...frame,
						finish: () => {
							entry.calls = [...context.calls];
						},
					});
				}
				if (callback) {
					stack.push({
						n: callback,
						parent: n,
						key: "arguments",
						owner,
						shadow,
						test,
						prefix,
						pagePrefix,
					});
					continue;
				}
			} else if (calleeName) {
				if (ROUTER_FACTORIES.has(calleeName))
					recordRouteObjects(unwrap(args[0]), "");
				if (!recordDirectRequest(n, calleeName, args, owner, shadow)) {
					const top = owner?.split(".")[0] ?? "";
					if (knownBinding(calleeName, shadow))
						addCall(owner, calleeName, line, test);
					else if (
						isShadowed(shadow, calleeName) &&
						nested.get(top)?.has(calleeName)
					)
						addCall(owner, `${top}.${calleeName}`, line, test);
					else if (
						!isShadowed(shadow, calleeName) &&
						!KNOWN_GLOBALS.has(calleeName)
					) {
						result.unresolved_calls += 1;
						unresolvedFrom(owner);
					}
					if (calleeName === "eval") unsupported("dynamic_code");
				}
			} else if (member) {
				if (member.computed) unsupported("computed_member_calls");
				else if (property && object) {
					recordDataAccess(object, property, args, owner, shadow, line);
					if (property === "addEventListener") {
						const event = stringValue(args[0]);
						const handler = unwrap(args[1]);
						if (event && handler)
							result.events.push(
								isFunction(handler)
									? {
											owner,
											event,
											handler: null,
											symbol: syntheticHandler(
												handler,
												`${owner ?? "module"} ${event} listener`,
												owner,
												"event_handler",
											),
											line,
										}
									: {
											owner,
											event,
											handler: dottedName(handler),
											symbol: null,
											line,
										},
							);
					}
					const recognised =
						recordRoute(n, object, property, args, owner, shadow) ||
						recordMount(object, property, args, owner, shadow) ||
						recordMemberRequest(n, object, property, args, owner, shadow) ||
						recordChannel(object, property, args, owner, shadow, line);
					if (!recognised)
						recordMemberCall(object, property, owner, shadow, line, test);
				}
			}
			if (callee?.type === "Import") {
				const source = stringValue(args[0]);
				if (source)
					addImport(source, [{ imported: "*", local: "*" }], line, "dynamic");
				else unsupported("non_literal_dynamic_imports");
			}
		}
		if (n.type === "ImportExpression") {
			const source = stringValue(n.source);
			if (source)
				addImport(source, [{ imported: "*", local: "*" }], line, "dynamic");
			else unsupported("non_literal_dynamic_imports");
		}
		if (n.type === "TaggedTemplateExpression") {
			const tag = dottedName(n.tag);
			const quasi = node(n.quasi);
			if (
				tag &&
				quasi &&
				/(^|\.)(sql|SQL|\$queryRaw|\$executeRaw)$/.test(tag)
			) {
				const text = templateText(quasi);
				if (SQL_START.test(text) || /\b(from|into|update|join)\b/i.test(text))
					recordSql(text, nodes(quasi.expressions), owner, line);
			}
		}
		// Configuration reads: process.env.X, process.env["X"], import.meta.env.X
		if (
			n.type === "MemberExpression" ||
			n.type === "OptionalMemberExpression"
		) {
			const object = unwrap(n.object);
			const metaEnv =
				object?.type === "MemberExpression" &&
				node(object.object)?.type === "MetaProperty" &&
				nameOf(object.property) === "env";
			if (metaEnv || dottedName(object) === "process.env") {
				const property = n.computed
					? stringValue(n.property)
					: nameOf(n.property);
				if (property)
					result.config_reads.push({
						owner,
						key: property,
						source: metaEnv ? "import.meta.env" : "process.env",
						line,
					});
				else unsupported("dynamic_env_keys");
			}
		}
		if (n.type === "JSXOpeningElement") {
			const name = node(n.name);
			const component =
				name?.type === "JSXIdentifier"
					? nameOf(name)
					: name?.type === "JSXMemberExpression"
						? `${nameOf(name.object)}.${nameOf(name.property)}`
						: null;
			const base = component?.split(".")[0] ?? "";
			if (component && /^[A-Z]/.test(base) && knownBinding(base, shadow))
				result.renders.push({ from: owner, component, line });
			for (const attribute of nodes(n.attributes)) {
				if (attribute.type !== "JSXAttribute") continue;
				const attr = nameOf(attribute.name);
				const value = node(attribute.value);
				if (
					!attr ||
					!/^on[A-Z]/.test(attr) ||
					value?.type !== "JSXExpressionContainer"
				)
					continue;
				const expression = unwrap(value.expression);
				if (isFunction(expression))
					result.events.push({
						owner,
						event: attr,
						handler: null,
						symbol: syntheticHandler(
							expression,
							`${owner ?? "module"} ${attr} (${component ?? "element"})`,
							owner,
							"event_handler",
						),
						line,
					});
				else {
					const handler = dottedName(expression);
					if (handler)
						result.events.push({
							owner,
							event: attr,
							handler,
							symbol: null,
							line,
						});
				}
			}
		}
		// React Router: <Route path="/x" element={<X />} />; nested routes inherit the parent's path.
		if (n.type === "JSXElement") {
			const opening = node(n.openingElement);
			if (nameOf(opening?.name) === "Route") {
				const attributes = new Map(
					nodes(opening?.attributes)
						.filter((a) => a.type === "JSXAttribute")
						.map((a) => [nameOf(a.name) ?? "", node(a.value)] as const),
				);
				const pathValue = attributes.get("path");
				const written =
					pathValue?.type === "JSXExpressionContainer"
						? stringValue(pathValue.expression)
						: stringValue(pathValue);
				const full =
					written === null
						? attributes.has("index")
							? pagePrefix || "/"
							: null
						: written.startsWith("/")
							? written
							: joinRoutePath(pagePrefix, written);
				const element = attributes.get("element");
				const view =
					element?.type === "JSXExpressionContainer"
						? unwrap(element.expression)
						: null;
				const viaProp = (prop: string) => {
					const container = attributes.get(prop);
					return container?.type === "JSXExpressionContainer"
						? nameOf(container.expression)
						: null;
				};
				const component =
					view?.type === "JSXElement"
						? nameOf(node(view.openingElement)?.name)
						: (viaProp("Component") ?? viaProp("component"));
				if (full !== null && component)
					result.pages.push({ path: full, component, line });
				if (full !== null) pagePrefix = full;
			}
		}
		if (n.type === "Identifier" && typeof n.name === "string" && parent) {
			const name = n.name;
			const declarationKey = [
				"id",
				"key",
				"local",
				"imported",
				"exported",
				"label",
				"params",
				"callee",
			].includes(key);
			const property =
				key === "property" &&
				(parent.type === "MemberExpression" ||
					parent.type === "OptionalMemberExpression") &&
				!parent.computed;
			if (
				!declarationKey &&
				!property &&
				name !== owner &&
				knownBinding(name, shadow)
			) {
				const referenceKey = `${owner ?? ""}|${name}`;
				if (!referenceKeys.has(referenceKey)) {
					referenceKeys.add(referenceKey);
					result.references.push({ from: owner, name, line });
				}
			}
		}
		const kids: Frame[] = [];
		for (const [childKey, value] of Object.entries(n)) {
			if (SKIP_KEYS.has(childKey)) continue;
			for (const child of isNode(value) ? [value] : nodes(value))
				kids.push({
					n: child,
					parent: n,
					key: childKey,
					owner,
					shadow,
					test,
					prefix,
					pagePrefix,
				});
		}
		for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as Frame);
	}
	return result;
}
