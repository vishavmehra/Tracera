import { describe, expect, it } from "vitest";
import {
	correlateLogs,
	innermost,
	mapFrames,
	nameMatches,
	normalizeFramePath,
	originalPosition,
	parseSourceMap,
	parseStackTrace,
	pathResolver,
	type RevisionIndex,
} from "../src/modules/stack-traces.ts";

// Stack-trace mapping [pure, no repository execution]: parsing, path resolution, source maps, and
// symbol placement against an in-memory revision.

const NODE_TRACE = [
	"TypeError: Cannot read properties of undefined (reading 'id')",
	"    at OrderService.create (/app/server/services/orders.ts:9:15)",
	"    at async createOrder (file:///C:/srv/shop/server/controllers/orders.js:4:66)",
	"    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)",
	"    at /app/server/app.js:6:42",
	"    at Object.<anonymous> (C:\\srv\\shop\\server\\db\\client.ts:1:12)",
	"    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
].join("\n");

describe("parseStackTrace", () => {
	it("reads V8 frames, the error line, and classifies runtime and dependency frames", () => {
		const trace = parseStackTrace(NODE_TRACE);
		expect(trace.format).toBe("v8");
		expect(trace.error).toEqual({
			type: "TypeError",
			message: "Cannot read properties of undefined (reading 'id')",
		});
		expect(
			trace.frames.map((f) => [f.function, f.file, f.line, f.classification]),
		).toEqual([
			[
				"OrderService.create",
				"/app/server/services/orders.ts",
				9,
				"application",
			],
			[
				"createOrder",
				"file:///C:/srv/shop/server/controllers/orders.js",
				4,
				"application",
			],
			[
				"Layer.handle [as handle_request]",
				"/app/node_modules/express/lib/router/layer.js",
				95,
				"dependency",
			],
			[null, "/app/server/app.js", 6, "application"],
			[
				"Object.<anonymous>",
				"C:\\srv\\shop\\server\\db\\client.ts",
				1,
				"application",
			],
			[
				"process.processTicksAndRejections",
				"node:internal/process/task_queues",
				95,
				"runtime",
			],
		]);
	});

	it("reads Firefox, Python, and Java traces", () => {
		expect(
			parseStackTrace(
				"handleClick@http://localhost:5173/src/OrderPage.tsx?t=1:12:9\n@http://localhost:5173/assets/index-3f9a2b1c.js:1:5000",
			).frames.map((f) => [f.function, f.line, f.classification]),
		).toEqual([
			["handleClick", 12, "application"],
			[null, 1, "generated"],
		]);
		const python = parseStackTrace(
			"Traceback (most recent call last):\n" +
				'  File "/app/shop/views.py", line 42, in create_order\n' +
				"    total = order.total()\n" +
				"AttributeError: 'NoneType' object has no attribute 'total'",
		);
		expect(python).toMatchObject({
			format: "python",
			error: { type: "AttributeError" },
			frames: [
				{ function: "create_order", file: "/app/shop/views.py", line: 42 },
			],
		});
		expect(
			parseStackTrace(
				"java.lang.IllegalStateException: no order\n\tat com.shop.OrderService.create(OrderService.java:42)",
			).frames[0],
		).toMatchObject({
			function: "com.shop.OrderService.create",
			file: "com/shop/OrderService.java",
			line: 42,
		});
	});

	it("bounds the number of frames it keeps", () => {
		const long = Array.from(
			{ length: 100 },
			(_, i) => `    at f${i} (/app/a.js:${i + 1}:1)`,
		).join("\n");
		const trace = parseStackTrace(long);
		expect(trace.frames).toHaveLength(60);
		expect(trace.truncated).toBe(true);
	});
});

describe("frame paths", () => {
	it.each([
		["webpack:///./src/App.tsx", "src/App.tsx"],
		["webpack-internal:///(app-pages-browser)/./src/page.tsx", "src/page.tsx"],
		["file:///C:/srv/shop/server/app.js", "/srv/shop/server/app.js"],
		["C:\\srv\\shop\\server\\app.js", "/srv/shop/server/app.js"],
		["http://localhost:5173/src/Order%20Page.tsx?t=12", "/src/Order Page.tsx"],
		["node:internal/process/task_queues", null],
		["<anonymous>", null],
	])("%s → %s", (input, expected) => {
		expect(normalizeFramePath(input)).toBe(expected);
	});

	it("resolves by agreeing trailing segments and keeps ties ambiguous", () => {
		const resolve = pathResolver([
			"server/services/orders.ts",
			"web/src/services/orders.ts",
			"src/main/java/com/shop/OrderService.java",
			"a/index.ts",
			"b/index.ts",
		]);
		expect(resolve("/app/server/services/orders.ts")).toEqual({
			status: "resolved",
			file: "server/services/orders.ts",
			method: "path_suffix",
		});
		expect(resolve("com/shop/OrderService.java")).toMatchObject({
			status: "resolved",
			file: "src/main/java/com/shop/OrderService.java",
		});
		expect(resolve("/deploy/index.ts")).toEqual({
			status: "ambiguous",
			candidates: ["a/index.ts", "b/index.ts"],
		});
		expect(resolve("/app/missing.ts")).toEqual({ status: "unresolved" });
	});
});

describe("source maps", () => {
	// One mapping: generated line 1, column 10 → sources[0] line 5, column 3 ("SAIE" in VLQ).
	const MAP = JSON.stringify({
		version: 3,
		sources: ["../src/app.ts"],
		names: [],
		mappings: "SAIE",
	});

	it("decodes VLQ mappings and finds the original position", () => {
		const map = parseSourceMap(MAP);
		expect(map).not.toBeNull();
		expect(map && originalPosition(map, 1, 10)).toEqual({
			source: "../src/app.ts",
			line: 5,
			column: 3,
			name: null,
		});
		expect(map && originalPosition(map, 2, 1)).toBeNull();
		expect(parseSourceMap("{}")).toBeNull();
		expect(
			parseSourceMap(
				JSON.stringify({ version: 3, sources: [], mappings: "!!" }),
			),
		).toBeNull();
	});

	it("maps a minified frame through a committed source map to the original symbol", async () => {
		const files = new Map([
			["dist/app.min.js", "function a(){throw new Error('x')}"],
			["dist/app.min.js.map", MAP],
			[
				"src/app.ts",
				"// app\n\nexport function boot() {\n\tconst x = 1;\n\tthrow new Error('x');\n}\n",
			],
		]);
		const index: RevisionIndex = {
			files: files.keys(),
			parsed: (file) => file.endsWith(".ts"),
			readText: async (file) => files.get(file) ?? null,
			symbolAt: async (file, line) =>
				file === "src/app.ts" && line >= 3 && line <= 6
					? {
							key: "sym:src/app.ts#boot",
							node_id: null,
							name: "boot",
							kind: "function",
							start_line: 3,
							end_line: 6,
						}
					: null,
		};
		const [frame] = await mapFrames(
			parseStackTrace(
				"Error: x\n    at boot (http://localhost/dist/app.min.js:1:10)",
			),
			index,
		);
		expect(frame).toMatchObject({
			resolution: {
				status: "resolved",
				file: "src/app.ts",
				line: 5,
				method: "source_map",
				line_reliable: true,
			},
			symbol: { name: "boot", name_matches: true },
			excerpt: { start_line: 2, end_line: 6 },
		});
		expect(frame?.excerpt?.text).toContain("   5| \tthrow new Error('x');");
	});
});

describe("mapFrames", () => {
	const files = new Map([
		[
			"server/services/orders.ts",
			"import x from 'y';\n\nexport class OrderService {\n\tcreate(body) {\n\t\tconst id = body.id;\n\n\n\n\t\treturn id;\n\t}\n}\n",
		],
		["server/app.js", "const app = 1;\n"],
	]);
	const index: RevisionIndex = {
		files: files.keys(),
		parsed: () => true,
		readText: async (file) => files.get(file) ?? null,
		symbolAt: async (file, line) =>
			file === "server/services/orders.ts" && line >= 4 && line <= 10
				? {
						key: "sym:server/services/orders.ts#OrderService.create",
						node_id: "gnd_1",
						name: "OrderService.create",
						kind: "method",
						start_line: 4,
						end_line: 10,
					}
				: null,
	};

	it("resolves application frames to files and symbols, and says why the rest are not", async () => {
		const mapped = await mapFrames(parseStackTrace(NODE_TRACE), index);
		expect(mapped.map((f) => f.resolution.status)).toEqual([
			"resolved",
			"unresolved",
			"external",
			"resolved",
			"unresolved",
			"external",
		]);
		expect(mapped[0]).toMatchObject({
			resolution: {
				file: "server/services/orders.ts",
				line: 9,
				line_reliable: true,
			},
			symbol: { name: "OrderService.create", name_matches: true },
		});
		expect(mapped[1]?.resolution).toEqual({
			status: "unresolved",
			reason: "no_matching_file",
		});
		expect(mapped[2]?.resolution).toEqual({
			status: "external",
			reason: "dependency_frame",
		});
		// Line 6 does not exist in the one-line server/app.js: the frame is flagged, not trusted.
		expect(mapped[3]?.resolution).toMatchObject({
			file: "server/app.js",
			line_reliable: false,
		});
		expect(mapped[3]?.excerpt).toBeNull();
	});

	it("places a line in the innermost enclosing span", () => {
		const spans: Array<[string, number | null, number | null]> = [
			["OrderService", 3, 11],
			["OrderService.create", 4, 10],
			["unplaced", null, null],
		];
		const at = (line: number) =>
			innermost(spans, line, ([, start, end]) => [start, end])?.[0] ?? null;
		expect([at(5), at(3), at(12)]).toEqual([
			"OrderService.create",
			"OrderService",
			null,
		]);
	});

	it.each([
		["OrderService.create", "OrderService.create", true],
		["async createOrder", "createOrder", true],
		["Object.<anonymous>", "x", null],
		["Layer.handle [as handle_request]", "Layer.handle_request", true],
		["refund", "OrderService.create", false],
	])("frame %s vs symbol %s → %s", (frame, symbol, expected) => {
		expect(nameMatches(frame, symbol)).toBe(expected);
	});
});

describe("correlateLogs", () => {
	it("redacts secrets, keeps error lines, and counts mentions of mapped code", async () => {
		const mapped = await mapFrames(parseStackTrace(NODE_TRACE), {
			files: ["server/services/orders.ts"],
			parsed: () => false,
			readText: async () => "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n",
			symbolAt: async () => null,
		});
		const result = correlateLogs(
			[
				"2026-10-24T10:00:00Z INFO request started",
				"2026-10-24T10:00:01Z ERROR orders.ts failed: token=sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
				"    at OrderService.create (/app/server/services/orders.ts:9:15)",
			].join("\n"),
			mapped,
			{ redactEmails: true },
		);
		expect(result.error_lines).toHaveLength(1);
		expect(result.error_lines[0]?.text).not.toContain(
			"sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
		);
		expect(result.mentions).toEqual([{ term: "orders.ts", count: 2 }]);
		expect(result.embedded_frames).toBe(1);
	});
});
