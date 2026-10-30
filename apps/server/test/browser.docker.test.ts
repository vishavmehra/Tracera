import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserStep } from "@tracera/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_IMAGE, DEFAULT_SANDBOX_IMAGE } from "../src/config.ts";
import { createDockerExecutor } from "../src/sandbox/docker.ts";
import type { BrowserRunRequest } from "../src/sandbox/executor.ts";
import { docker, quiet } from "./npm-registry.ts";

// Security acceptance tests for browser reproduction [real Docker, real Chromium, nothing
// mocked]. The app runs with no network; the browser shares its loopback-only namespace and runs the
// fixed runner. Requires Docker and `npm run sandbox:pull`. These tests fail, never skip, without Docker.

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tracera-browser-")));
const TAG = `browser-test-${process.pid}`;
const executor = createDockerExecutor({
	image: DEFAULT_SANDBOX_IMAGE,
	browserImage: DEFAULT_BROWSER_IMAGE,
	workspacesRoot: root,
	workerId: TAG,
	instance: TAG,
});

const SERVER = `const http = require("node:http");
const fs = require("node:fs");
const page = fs.readFileSync(__dirname + "/page.html", "utf8");
fetch("https://example.com").then(
  () => console.log("egress: reached"),
  (e) => console.log("egress: " + (e.cause?.code ?? e.message)),
);
console.log("env: " + Object.keys(process.env).sort().join(","));
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
}).listen(Number(process.env.PORT), "localhost", () => console.log("listening"));
`;
// Answers its health check, then drops every other connection: the first page cannot load.
const UNLOADABLE_SERVER = `const http = require("node:http");
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  req.socket.destroy();
}).listen(Number(process.env.PORT), "localhost");
`;
const PAGE = (factor: number) => `<!doctype html><html><body>
<h1>Cart</h1><p data-testid="total">Total: $0</p>
<button onclick="add()">Add item</button>
<script>
let count = 0;
function add() { count += 1; document.querySelector("[data-testid=total]").textContent = "Total: $" + count * 4 * ${factor}; }
fetch("https://tracker.example.com/beacon").catch(() => {});
</script></body></html>`;

function app(
	name: string,
	factor: number,
	scripts: Record<string, string> = {},
	server = SERVER,
) {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: "shop",
			version: "1.0.0",
			scripts: { start: "node server.js", ...scripts },
		}),
	);
	writeFileSync(path.join(dir, "server.js"), server);
	writeFileSync(path.join(dir, "page.html"), PAGE(factor));
	return dir;
}

const step = (partial: Partial<BrowserStep>): BrowserStep => ({
	action: "goto",
	target: null,
	value: null,
	path: null,
	key: null,
	width: null,
	height: null,
	match: null,
	timeout_ms: null,
	...partial,
});
const ADD_ITEM: BrowserStep[] = [
	step({
		action: "click",
		target: { by: "role", value: "button", name: "Add item", exact: null },
	}),
	step({
		action: "expect_text",
		target: { by: "test_id", value: "total", name: null, exact: null },
		value: "Total: $4",
		timeout_ms: 2000,
	}),
];
const WAIT_FOREVER: BrowserStep[] = [
	step({
		action: "wait_for",
		target: { by: "test_id", value: "never", name: null, exact: null },
		timeout_ms: 10_000,
	}),
	step({ action: "expect_no_console_errors" }),
];
const request = (
	runId: string,
	workspace: string,
	overrides: Partial<BrowserRunRequest> = {},
): BrowserRunRequest => ({
	runId,
	investigationId: "inv_browser",
	workspace,
	start: ["npm", "run", "start"],
	app: { port: 4173, readyPath: "/health", basePath: "/" },
	steps: ADD_ITEM,
	timeoutMs: 90_000,
	...overrides,
});
const leftovers = (runId: string) =>
	`${quiet("ps", "-a", "-q", "--filter", `name=tracera-app-${runId}`)}${quiet(
		"ps",
		"-a",
		"-q",
		"--filter",
		`name=tracera-browser-${runId}`,
	)}`;
const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let buggy = "";
let fixed = "";
beforeAll(async () => {
	const status = await executor.status();
	if (!status.available)
		throw new Error(
			`The Docker sandbox is unavailable (${status.detail}); these acceptance tests must not be skipped`,
		);
	if (!quiet("image", "inspect", DEFAULT_BROWSER_IMAGE))
		throw new Error("The browser image is missing: run `npm run sandbox:pull`");
	buggy = app("buggy", 0);
	fixed = app("fixed", 1);
});
afterAll(() => {
	for (const id of quiet(
		"ps",
		"-a",
		"-q",
		"--filter",
		`label=tracera.instance=${TAG}`,
	)
		.split(/\s+/)
		.filter(Boolean))
		quiet("rm", "-f", id);
});

describe("browser reproduction [real Docker, real Chromium]", () => {
	it("reproduces a UI bug: the expected text is absent, with evidence, and nothing escapes", async () => {
		process.env.TRACERA_TEST_SECRET = "browser-secret-9c1e";
		try {
			const result = await executor.runBrowser(request("br-buggy-1", buggy));
			expect(result.status).toBe("exited");
			const report = result.report;
			expect(report?.ready).toBe(true);
			expect(report?.steps.map((s) => `${s.action}:${s.status}`)).toEqual([
				"click:passed",
				"expect_text:failed",
			]);
			expect(report?.steps[1]).toMatchObject({
				assertion: true,
				expected: "Total: $4",
				actual: "Total: $0",
			});
			// The page's request to another host was aborted by the runner.
			expect(report?.blocked_requests).toContain(
				"https://tracker.example.com/beacon",
			);
			// A PNG screenshot of the final state, taken although a step failed.
			const png = Buffer.from(report?.screenshot ?? "", "base64");
			expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
			expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 800]);
			// How the app came up: the health check answered, then the first page loaded.
			expect(report?.startup).toMatchObject({
				health_path: "/health",
				health_ok: true,
				health_status: 200,
				health_error: null,
				page_loaded: true,
				page_error: null,
			});
			expect(report?.startup?.health_attempts).toBeGreaterThanOrEqual(1);
			// The app itself has no network and no host secrets.
			expect(result.appLog).toMatch(
				/egress: (EAI_AGAIN|ENETUNREACH|ENOTFOUND)/,
			);
			expect(result.appLog).not.toContain("egress: reached");
			expect(result.appLog).not.toContain("TRACERA_TEST_SECRET");
			expect(leftovers("br-buggy-1")).toBe("");
		} finally {
			delete process.env.TRACERA_TEST_SECRET;
		}
	});

	it("does not reproduce once the bug is fixed", async () => {
		const result = await executor.runBrowser(request("br-fixed-1", fixed));
		expect(result.status).toBe("exited");
		expect(result.report?.ready).toBe(true);
		expect(result.report?.steps.every((s) => s.status === "passed")).toBe(true);
	});

	it("runs both containers hardened: no network for the app, the app's namespace for the browser", async () => {
		const running = executor.runBrowser(
			request("br-inspect-1", buggy, { steps: WAIT_FOREVER }),
		);
		let app = "";
		let browser = "";
		for (let i = 0; i < 160 && !(app && browser); i++) {
			app ||= quiet("inspect", "tracera-app-br-inspect-1");
			browser ||= quiet("inspect", "tracera-browser-br-inspect-1");
			if (!(app && browser)) await sleep(250);
		}
		expect(app, "app container seen").not.toBe("");
		expect(browser, "browser container seen").not.toBe("");
		type Inspect = Array<{
			Id: string;
			Config: { User: string };
			HostConfig: {
				NetworkMode: string;
				ReadonlyRootfs: boolean;
				CapDrop: string[];
				SecurityOpt: string[];
				Privileged: boolean;
			};
			Mounts: Array<{ Destination: string; RW: boolean }>;
		}>;
		const [appInfo] = JSON.parse(app) as Inspect;
		const [browserInfo] = JSON.parse(browser) as Inspect;
		for (const info of [appInfo, browserInfo]) {
			expect(info?.Config.User).toBe("1000:1000");
			expect(info?.HostConfig).toMatchObject({
				ReadonlyRootfs: true,
				CapDrop: ["ALL"],
				Privileged: false,
			});
			expect(info?.HostConfig.SecurityOpt).toContain("no-new-privileges");
			// Bind and volume mounts are all read-only (tmpfs are not listed here).
			expect(info?.Mounts.every((m) => !m.RW)).toBe(true);
		}
		expect(appInfo?.HostConfig.NetworkMode).toBe("none");
		expect(browserInfo?.HostConfig.NetworkMode).toBe(
			`container:${appInfo?.Id}`,
		);
		const result = await running;
		expect(result.report?.steps[0]).toMatchObject({
			action: "wait_for",
			status: "failed",
			assertion: false,
		});
		expect(leftovers("br-inspect-1")).toBe("");
	});

	it("reports an app that never answers as not ready", async () => {
		const broken = app("broken", 0, { start: "node missing.js" });
		const result = await executor.runBrowser(
			request("br-broken-1", broken, { timeoutMs: 20_000 }),
		);
		expect(
			result.status,
			`${result.detail ?? ""} ${result.stderr.slice(-400)}`,
		).toBe("exited");
		expect(result.report).toMatchObject({ ready: false, steps: [] });
		// No page ever existed, so there is nothing to photograph; the report says why.
		expect(result.report?.screenshot).toBeNull();
		expect(result.report?.startup).toMatchObject({
			health_ok: false,
			health_status: null,
			page_loaded: false,
		});
		expect(result.report?.startup?.health_error).toMatch(
			/^(app_exited|ECONNREFUSED|TimeoutError)/,
		);
		expect(leftovers("br-broken-1")).toBe("");
	});

	it("photographs a first page that fails to load, and runs no step", async () => {
		const unloadable = app("unloadable", 0, {}, UNLOADABLE_SERVER);
		const result = await executor.runBrowser(
			request("br-unloadable-1", unloadable),
		);
		expect(result.status).toBe("exited");
		const report = result.report;
		expect(report?.ready).toBe(true);
		expect(report?.startup).toMatchObject({
			health_ok: true,
			page_loaded: false,
		});
		expect(report?.startup?.page_error).toMatch(/ERR_|Timeout/);
		expect(report?.steps.map((s) => s.status)).toEqual(["skipped", "skipped"]);
		expect(report?.final_path).toBeNull();
		// The browser's own error page still shows what the user would have seen.
		expect(
			Buffer.from(report?.screenshot ?? "", "base64")
				.subarray(0, 8)
				.equals(PNG_SIGNATURE),
		).toBe(true);
		expect(leftovers("br-unloadable-1")).toBe("");
	});

	it("clips page text longer than the report allows instead of failing the run", async () => {
		const wordy = app("wordy", 0);
		writeFileSync(
			path.join(wordy, "page.html"),
			`<!doctype html><p data-testid="total">${"words ".repeat(800)}</p>`,
		);
		const result = await executor.runBrowser(
			request("br-wordy-1", wordy, {
				steps: [
					step({
						action: "expect_text",
						target: { by: "test_id", value: "total", name: null, exact: null },
						value: "Total: $4",
						timeout_ms: 1000,
					}),
				],
			}),
		);
		expect(result.status, result.detail).toBe("exited");
		const failed = result.report?.steps[0];
		expect(failed).toMatchObject({ status: "failed", assertion: true });
		expect(failed?.actual?.length).toBeLessThanOrEqual(1000);
		expect(failed?.actual?.endsWith("…")).toBe(true);
	});

	it("refuses unsafe requests before Docker is called", async () => {
		await expect(
			executor.runBrowser(
				request("br-bad-1", buggy, { start: ["npm", "run", "x;rm"] }),
			),
		).rejects.toMatchObject({ code: "invalid_argv" });
		await expect(
			executor.runBrowser(
				request("br-bad-2", buggy, {
					steps: [
						step({ action: "goto", path: "https://evil.example/" }),
						step({ action: "expect_no_console_errors" }),
					],
				}),
			),
		).rejects.toMatchObject({ code: "invalid_steps" });
		await expect(
			executor.runBrowser(
				request("br-bad-3", buggy, {
					app: { port: 80, readyPath: "/health", basePath: "/" },
				}),
			),
		).rejects.toMatchObject({ code: "invalid_app" });
		expect(
			docker("ps", "-a", "-q", "--filter", "name=tracera-app-br-bad"),
		).toBe("");
	});

	it("stops and removes both containers on cancellation", async () => {
		const controller = new AbortController();
		const running = executor.runBrowser(
			request("br-cancel-1", buggy, { steps: WAIT_FOREVER }),
			controller.signal,
		);
		for (
			let i = 0;
			i < 160 && !quiet("inspect", "tracera-browser-br-cancel-1");
			i++
		)
			await sleep(250);
		controller.abort();
		const result = await running;
		expect(result.status).toBe("cancelled");
		expect(leftovers("br-cancel-1")).toBe("");
	});
});
