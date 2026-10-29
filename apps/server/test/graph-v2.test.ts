import { describe, expect, it } from "vitest";
import {
	buildGraph,
	canonicalRoutePath,
	type GraphInput,
	type Manifest,
} from "../src/modules/graph-build.ts";
import {
	extractFile,
	type FileExtraction,
	sqlTableUses,
} from "../src/modules/graph-extract.ts";
import { DEPS, SHOP } from "./fullstack-fixture.ts";

// Graph extraction of framework relationships [static analysis, no execution], over a small
// full-stack repository, each checked for the edges it must produce and the ones it must not.

const manifest = (dependencies: Record<string, string>): Manifest => ({
	path: "package.json",
	name: "shop",
	scripts: { test: "node --test", build: "vite build" },
	dependencies,
	devDependencies: {},
	main: null,
	bin: [],
	type: "module",
});

function graphOf(
	files: Record<string, string>,
	dependencies: Record<string, string> = {},
) {
	const extractions = new Map<string, FileExtraction>();
	for (const [file, source] of Object.entries(files))
		if (/\.([cm]?[jt]sx?|sql)$/.test(file))
			extractions.set(file, extractFile(file, source));
	const input: GraphInput = {
		repositoryName: "shop",
		commitSha: "c".repeat(40),
		files: Object.entries(files).map(([file, source]) => ({
			path: file,
			size: source.length,
			object: `obj-${file}`,
		})),
		skipped: {},
		extractions,
		manifests: [manifest(dependencies)],
		commits: [],
		codeowners: [],
		docs: [],
		limits: { truncatedFiles: [] },
	};
	const graph = buildGraph(input);
	const edges = (kind: string) =>
		graph.edges
			.filter((edge) => edge.kind === kind)
			.map((edge) => `${edge.from} -> ${edge.to ?? `?${edge.target_text}`}`);
	const edge = (kind: string, from: string, to: string) =>
		graph.edges.find((e) => e.kind === kind && e.from === from && e.to === to);
	return { graph, edges, edge, extractions };
}

describe("graph v2: a full-stack repository, end to end", () => {
	const { graph, edges, edge } = graphOf(SHOP, DEPS);
	const sym = (file: string, name: string) => `sym:${file}#${name}`;

	it("resolves mount prefixes and links routes to middleware and handlers through a barrel", () => {
		expect(edges("RE_EXPORTS")).toEqual([
			"file:server/controllers/index.js -> file:server/controllers/orders.js",
		]);
		const getOrder = graph.edges.filter(
			(e) =>
				e.kind === "ROUTES_TO" && e.from === "route:GET /api/orders/:param",
		);
		expect(getOrder.map((e) => [e.to, e.provenance.role, e.certainty])).toEqual(
			[
				[
					sym("server/middleware/auth.js", "requireAuth"),
					"middleware",
					"resolved",
				],
				[
					sym("server/controllers/orders.js", "getOrder"),
					"handler",
					"resolved",
				],
			],
		);
		expect(
			graph.nodes.find((n) => n.key === "route:GET /api/orders/:param"),
		).toMatchObject({
			kind: "route",
			name: "GET /api/orders/:id",
			path: "server/routes/orders.js",
			start_line: 5,
			attributes: { method: "GET", prefix_known: true, framework: "express" },
		});
		// An inline handler becomes its own symbol, so its calls are attributed to the route.
		expect(
			edge(
				"ROUTES_TO",
				"route:GET /health",
				sym("server/app.js", "GET /health handler"),
			),
		).toBeTruthy();
		expect(graph.coverage.unresolved.routes_with_unknown_prefix).toBe(0);
	});

	it("matches client requests to routes by method and path shape, through an axios client", () => {
		expect(
			edge(
				"SENDS_REQUEST_TO",
				sym("web/src/api.ts", "ordersApi.create"),
				"route:POST /api/orders",
			),
		).toMatchObject({
			certainty: "resolved",
			provenance: { http_method: "POST", client: "fetch" },
		});
		expect(
			edge(
				"SENDS_REQUEST_TO",
				sym("web/src/api.ts", "ordersApi.get"),
				"route:GET /api/orders/:param",
			),
		).toMatchObject({
			certainty: "resolved",
			provenance: { url: "/api/orders/:param", client: "instance" },
		});
		expect(
			edge(
				"SENDS_REQUEST_TO",
				sym("web/src/api.ts", "track"),
				"ext:analytics.example.com",
			),
		).toBeTruthy();
		// A request that matches nothing stays an explicit unresolved edge, never a guess.
		expect(
			graph.edges.find(
				(e) =>
					e.kind === "SENDS_REQUEST_TO" &&
					e.from === sym("web/src/api.ts", "lost"),
			),
		).toMatchObject({
			to: null,
			target_text: "GET /api/nowhere",
			certainty: "unresolved",
		});
		expect(graph.coverage.unresolved.requests).toBe(1);
	});

	it("traces UI events and pages to the code they run", () => {
		expect(edges("HANDLES_EVENT")).toEqual([
			`${sym("web/src/OrderPage.tsx", "OrderPage")} -> ${sym("web/src/OrderPage.tsx", "OrderPage.save")}`,
			`${sym("web/src/OrderPage.tsx", "OrderPage")} -> ${sym("web/src/OrderPage.tsx", "OrderPage onMouseEnter (button)")}`,
		]);
		expect(
			edge(
				"CALLS",
				sym("web/src/OrderPage.tsx", "OrderPage.save"),
				sym("web/src/api.ts", "ordersApi.create"),
			),
		).toBeTruthy();
		expect(
			edge(
				"CALLS",
				sym("web/src/OrderPage.tsx", "OrderPage onMouseEnter (button)"),
				sym("web/src/api.ts", "ordersApi.get"),
			),
		).toBeTruthy();
		expect(
			edge(
				"ROUTES_TO",
				"page:/orders/:param",
				sym("web/src/OrderPage.tsx", "OrderPage"),
			),
		).toMatchObject({ certainty: "resolved" });
	});

	it("links method calls through instances, `this`, and inheritance", () => {
		expect(
			edge(
				"CALLS",
				sym("server/controllers/orders.js", "getOrder"),
				sym("server/services/orders.ts", "OrderService.find"),
			),
		).toMatchObject({ provenance: { receiver: "type" } });
		expect(
			edge(
				"CALLS",
				sym("server/services/orders.ts", "OrderService.create"),
				sym("server/services/orders.ts", "BaseService.log"),
			),
		).toMatchObject({ provenance: { receiver: "this" } });
		expect(
			edge(
				"EXTENDS",
				sym("server/services/orders.ts", "OrderService"),
				sym("server/services/orders.ts", "BaseService"),
			),
		).toBeTruthy();
	});

	it("records table definitions, reads, writes, and schema changes", () => {
		expect(
			edge("DEFINES", sym("server/db/schema.ts", "orders"), "table:orders"),
		).toBeTruthy();
		expect(
			edge(
				"READS_FROM",
				sym("server/services/orders.ts", "OrderService.find"),
				"table:orders",
			),
		).toMatchObject({ provenance: { method: "drizzle", statement: "from" } });
		expect(
			edge(
				"WRITES_TO",
				sym("server/services/orders.ts", "OrderService.create"),
				"table:orders",
			),
		).toBeTruthy();
		expect(
			edge("DEFINES", "file:server/migrations/0001_orders.sql", "table:orders"),
		).toBeTruthy();
		expect(
			edge(
				"WRITES_TO",
				"file:server/migrations/0001_orders.sql",
				"table:orders",
			),
		).toMatchObject({
			provenance: { schema_change: true, statement: "alter" },
		});
		// Map.delete and Array.from are not database access.
		expect(
			graph.edges.filter(
				(e) =>
					e.from.startsWith("sym:server/unrelated.js") &&
					["READS_FROM", "WRITES_TO"].includes(e.kind),
			),
		).toEqual([]);
	});

	it("records configuration keys and event channels, ignoring generic events", () => {
		expect(
			edge(
				"CONFIGURED_BY",
				sym("server/middleware/auth.js", "requireAuth"),
				"env:API_TOKEN",
			),
		).toMatchObject({ certainty: "exact" });
		expect(
			edge(
				"CONFIGURED_BY",
				sym("server/db/client.ts", "db"),
				"env:DATABASE_URL",
			),
		).toBeTruthy();
		expect(
			edge(
				"PUBLISHES",
				sym("server/services/orders.ts", "OrderService.create"),
				"event:order:created",
			),
		).toMatchObject({ certainty: "heuristic" });
		expect(
			edge(
				"SUBSCRIBES_TO",
				sym("server/events.ts", "sendReceipt"),
				"event:order:created",
			),
		).toBeTruthy();
		expect(graph.nodes.some((n) => n.key === "event:error")).toBe(false);
	});

	it("does not mistake a map lookup for a route or a request", () => {
		const lookup = sym("server/unrelated.js", "lookup");
		expect(graph.edges.filter((e) => e.from === lookup)).toEqual([]);
		expect(
			graph.nodes
				.filter((n) => n.kind === "route")
				.map((n) => n.key)
				.sort(),
		).toEqual([
			"route:GET /api/orders/:param",
			"route:GET /health",
			"route:POST /api/orders",
		]);
	});

	it("reports a consistent graph, its surface, and what each relationship kind covers", () => {
		expect(graph.coverage.consistency).toEqual({
			dangling_edges: 0,
			dropped: [],
		});
		expect(graph.coverage.extractor_version).toBe("graph-extract.v4");
		expect(graph.coverage.edge_support.ROUTES_TO).toMatch(
			/Express, Fastify, Hono/,
		);
		expect(graph.profile.surface).toEqual({
			routes: 3,
			pages: 1,
			db_tables: 1,
			external_services: 1,
			config_keys: 2,
			events: 1,
			queues: 0,
		});
		expect(graph.profile.languages).toEqual({
			parsed: ["javascript", "sql", "typescript"],
			unparsed: [],
		});
		expect(graph.profile.build_systems).toContainEqual({
			name: "Vite",
			evidence: expect.stringContaining("vite build"),
		});
		expect(graph.profile.test_frameworks).toContainEqual({
			name: "node:test",
			evidence: expect.any(String),
		});
		// map.get on an untyped parameter cannot be linked, and is counted.
		expect(graph.coverage.unresolved.member_calls).toBeGreaterThan(0);
	});
});

describe("graph v2: framework variants and honest gaps", () => {
	it("prefixes Fastify plugin routes from register() and reads typed parameters and queue constants", () => {
		const { graph, edge } = graphOf(
			{
				"src/server.ts": [
					'import Fastify from "fastify";',
					'import { orderRoutes } from "./routes.ts";',
					"const app = Fastify();",
					'app.register(orderRoutes, { prefix: "/v1" });',
				].join("\n"),
				"src/routes.ts": [
					'import type { FastifyInstance } from "fastify";',
					'import { PgBoss } from "pg-boss";',
					'import { QUEUES } from "./queues.ts";',
					"export async function orderRoutes(app: FastifyInstance, boss: PgBoss) {",
					'\tapp.get("/orders", async () => boss.send(QUEUES.export, {}));',
					'\tapp.route({ method: ["PUT", "PATCH"], url: "/orders/:id", handler: update });',
					"}",
					"export function update() { return 1; }",
				].join("\n"),
				"src/queues.ts":
					'export const QUEUES = { export: "orders.export" } as const;',
				"src/worker.ts": [
					'import type { PgBoss } from "pg-boss";',
					'import { QUEUES } from "./queues.ts";',
					"export function startWorker(boss: PgBoss) { return boss.work(QUEUES.export, exportOrders); }",
					"export function exportOrders() { return 1; }",
				].join("\n"),
			},
			{ fastify: "5.0.0", "pg-boss": "12.0.0" },
		);
		expect(
			graph.nodes
				.filter((n) => n.kind === "route")
				.map((n) => n.key)
				.sort(),
		).toEqual([
			"route:GET /v1/orders",
			"route:PATCH /v1/orders/:param",
			"route:PUT /v1/orders/:param",
		]);
		expect(
			edge(
				"ROUTES_TO",
				"route:PUT /v1/orders/:param",
				"sym:src/routes.ts#update",
			),
		).toBeTruthy();
		// The queue name comes from a constant object in another file.
		expect(
			edge(
				"PUBLISHES",
				"sym:src/routes.ts#GET /orders handler",
				"queue:orders.export",
			),
		).toMatchObject({ certainty: "resolved" });
		expect(
			edge(
				"SUBSCRIBES_TO",
				"sym:src/worker.ts#exportOrders",
				"queue:orders.export",
			),
		).toBeTruthy();
	});

	it("keeps routes of a router that is never mounted file-qualified and matches requests to them only heuristically", () => {
		const { graph, edge } = graphOf(
			{
				"src/router.js": [
					'import express from "express";',
					"const router = express.Router();",
					'router.get("/items", list);',
					"function list() { return []; }",
					"export default router;",
				].join("\n"),
				"src/client.js": 'export function load() { return fetch("/items"); }',
			},
			{ express: "5.0.0" },
		);
		expect(graph.nodes.find((n) => n.kind === "route")).toMatchObject({
			key: "route:GET /items@src/router.js",
			attributes: { prefix_known: false, prefix: "not_mounted" },
		});
		expect(
			edge(
				"SENDS_REQUEST_TO",
				"sym:src/client.js#load",
				"route:GET /items@src/router.js",
			),
		).toMatchObject({ certainty: "heuristic" });
		expect(graph.coverage.unresolved.routes_with_unknown_prefix).toBe(1);
		expect(graph.coverage.notes.join(" ")).toMatch(
			/no resolvable mount prefix/,
		);
	});

	it("matches a request with an unknown base URL by path suffix, heuristically", () => {
		const { edge } = graphOf(
			{
				"src/server.js": [
					'import express from "express";',
					"const app = express();",
					'app.get("/api/orders", list);',
					"function list() { return []; }",
				].join("\n"),
				"src/config.js":
					"export const API_URL = window.location.origin + '/api';",
				"src/client.js": [
					'import { API_URL } from "./config.js";',
					// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source code containing a template literal
					"export function load() { return fetch(`${API_URL}/orders`); }",
				].join("\n"),
			},
			{ express: "5.0.0" },
		);
		expect(
			edge(
				"SENDS_REQUEST_TO",
				"sym:src/client.js#load",
				"route:GET /api/orders",
			),
		).toMatchObject({
			certainty: "heuristic",
			provenance: { url: ":base/orders" },
		});
	});

	it("adds heuristic dispatch edges from an interface call to implementing classes", () => {
		const { edge } = graphOf({
			"src/store.ts": [
				"export interface Store { save(id: string): void }",
				"export class SqlStore implements Store { save(id: string) { return id; } }",
				"export function persist(store: Store) { store.save('1'); }",
			].join("\n"),
		});
		expect(
			edge("CALLS", "sym:src/store.ts#persist", "sym:src/store.ts#Store.save"),
		).toMatchObject({ certainty: "resolved" });
		expect(
			edge(
				"CALLS",
				"sym:src/store.ts#persist",
				"sym:src/store.ts#SqlStore.save",
			),
		).toMatchObject({
			certainty: "heuristic",
			provenance: { dispatch: "interface_implementation" },
		});
	});

	it("derives Next.js routes and pages from file conventions only when next is declared", () => {
		const files = {
			"app/api/orders/[id]/route.ts":
				"export async function GET() { return 1; }\nexport async function DELETE() { return 1; }",
			"pages/orders/[id].tsx":
				"export default function OrderPage() { return <div />; }",
		};
		const withNext = graphOf(files, { next: "15.0.0" });
		expect(
			withNext.graph.nodes
				.filter((n) => n.kind === "route" || n.kind === "page")
				.map((n) => n.key)
				.sort(),
		).toEqual([
			"page:/orders/:param",
			"route:DELETE /api/orders/:param",
			"route:GET /api/orders/:param",
		]);
		expect(
			withNext.edge(
				"ROUTES_TO",
				"route:GET /api/orders/:param",
				"sym:app/api/orders/[id]/route.ts#GET",
			),
		).toMatchObject({ certainty: "exact" });
		expect(
			graphOf(files).graph.nodes.some(
				(n) => n.kind === "route" || n.kind === "page",
			),
		).toBe(false);
	});

	it("resolves CommonJS exports and requires", () => {
		const { edge } = graphOf({
			"lib/math.js":
				"function add(a, b) { return a + b; }\nmodule.exports = { add };",
			"lib/use.js":
				'const math = require("./math.js");\nexports.total = function (x) { return math.add(x, 1); };',
		});
		expect(
			edge("CALLS", "sym:lib/use.js#total", "sym:lib/math.js#add"),
		).toBeTruthy();
	});

	it("records a use of a name its repository module does not export as a broken reference, and only then", () => {
		const { graph, edge } = graphOf({
			"src/money.ts": "export function toCents(x) { return x * 100; }",
			"src/index.ts": [
				'export { toCents, formatCents } from "./money.ts";',
				'export * from "left-pad";',
			].join("\n"),
			"src/legacy.js": "module.exports.helper = make();",
			"src/connected.ts": "export default connect(a)(B);",
			"src/broken.ts": "export function (",
			"src/use.ts": [
				'import { toCents, formatCents, padStart } from "./index.ts";',
				'import * as money from "./money.ts";',
				'import { helper } from "./legacy.js";',
				'import Connected from "./connected.ts";',
				'import { parsed } from "./broken.ts";',
				"export function total(x) {",
				"\ttoCents(x); formatCents(x); padStart(x);",
				"\tmoney.toCents(x); money.gone(x);",
				"\thelper(); Connected(); parsed();",
				"}",
			].join("\n"),
		});
		const broken = graph.edges.filter(
			(e) => e.provenance.reason === "import_not_exported",
		);
		// Missing from a fully known module: broken. CommonJS, `export * from` a package, an unparsed
		// module, and an expression default export only leave the name unknown.
		expect(
			broken.map((e) => `${e.kind} ${e.from} -> ?${e.target_text}`).sort(),
		).toEqual([
			"CALLS sym:src/use.ts#total -> ?formatCents",
			"CALLS sym:src/use.ts#total -> ?money.gone",
		]);
		expect(
			broken.every((e) => e.to === null && e.certainty === "unresolved"),
		).toBe(true);
		expect(
			edge("CALLS", "sym:src/use.ts#total", "sym:src/money.ts#toCents"),
		).toBeTruthy();
	});

	it("links Prisma model reads when the client type is known", () => {
		const { edge } = graphOf({
			"src/repo.ts": [
				'import { PrismaClient } from "@prisma/client";',
				"const db = new PrismaClient();",
				"export function users() { return db.user.findMany(); }",
			].join("\n"),
		});
		expect(
			edge("READS_FROM", "sym:src/repo.ts#users", "table:user"),
		).toMatchObject({
			certainty: "resolved",
		});
	});
});

describe("sqlTableUses", () => {
	it.each([
		[
			"SELECT * FROM orders o JOIN users u ON u.id = o.user_id",
			["read orders", "read users"],
		],
		[
			"INSERT INTO audit (a) SELECT a FROM events",
			["write audit", "read events"],
		],
		["DELETE FROM sessions WHERE id = $1", ["write sessions"]],
		[
			'UPDATE "public"."repository_snapshots" s SET status = 1',
			["write repository_snapshots"],
		],
		[
			"INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 2",
			["write t"],
		],
		["SELECT id FROM jobs FOR UPDATE SKIP LOCKED", ["read jobs"]],
		[
			"INSERT INTO graph_nodes (id) SELECT r.id FROM jsonb_to_recordset($1) AS r(id text)",
			["write graph_nodes"],
		],
		["-- FROM comments\nSELECT 1 FROM real_table", ["read real_table"]],
	])("%s", (sql, expected) => {
		expect(
			sqlTableUses(sql).map((use) =>
				"table" in use.target
					? `${use.op} ${use.target.table}`
					: `${use.op} $${use.target.placeholder}`,
			),
		).toEqual(expected);
	});

	it("keeps interpolated table objects as placeholders", () => {
		expect(sqlTableUses("UPDATE __tracera_expr_0__ s SET x = 1")).toEqual([
			{ op: "write", statement: "UPDATE", target: { placeholder: 0 } },
		]);
	});
});

describe("canonicalRoutePath", () => {
	it.each([
		["/api/orders/:id", "/api/orders/:param"],
		["/api/orders/{id}/", "/api/orders/:param"],
		["/files/[...slug]", "/files/:param"],
		["/a?b=1", "/a"],
		["/", "/"],
	])("%s → %s", (input, expected) => {
		expect(canonicalRoutePath(input)).toBe(expected);
	});
});
