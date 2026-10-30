import { createHash } from "node:crypto";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	FIX,
	REGRESSION,
	setupShopUi,
} from "../../../scripts/shop-ui-setup.ts";
import { DEFAULT_BROWSER_IMAGE, DEFAULT_SANDBOX_IMAGE } from "../src/config.ts";
import { parseTap } from "../src/modules/verification.ts";
import { createDockerExecutor } from "../src/sandbox/docker.ts";
import { SUITE_ENV } from "../src/sandbox/executor.ts";
import { SHOP_UI_STEPS } from "./e2e/shop-ui-provider.ts";
import { quiet } from "./npm-registry.ts";

// The Shop UI demo fixture in the real sandbox [real Docker, real Chromium, nothing mocked]: the app
// starts with no network, the browser reproduces the planted bug and photographs it, and the one-line
// fix changes both the assertions and the screenshot. Requires Docker and `npm run sandbox:pull`; these
// tests fail, never skip, without Docker.

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "tracera-shop-ui-")));
const TAG = `shop-ui-test-${process.pid}`;
const executor = createDockerExecutor({
	image: DEFAULT_SANDBOX_IMAGE,
	browserImage: DEFAULT_BROWSER_IMAGE,
	workspacesRoot: root,
	workerId: TAG,
	instance: TAG,
});
const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** The repository's working tree without `.git`, as the pipeline's run copy has it. */
function runCopy(source: string, name: string) {
	const dir = path.join(root, name);
	cpSync(source, dir, {
		recursive: true,
		filter: (file) => path.basename(file) !== ".git",
	});
	return dir;
}
const request = (runId: string, workspace: string) => ({
	runId,
	investigationId: "inv_shopui",
	workspace,
	start: ["npm", "run", "start"],
	app: { port: 4173, readyPath: "/health", basePath: "/cart" },
	steps: SHOP_UI_STEPS,
	timeoutMs: 90_000,
});
const png = (report: { screenshot: string | null } | null | undefined) =>
	Buffer.from(report?.screenshot ?? "", "base64");
const sha256 = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

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
	const repository = setupShopUi(path.join(root, "repository", "shop-ui"));
	buggy = runCopy(repository.path, "buggy");
	fixed = runCopy(repository.path, "fixed");
	const file = path.join(fixed, FIX.path);
	const source = readFileSync(file, "utf8");
	expect(source.split(FIX.search)).toHaveLength(2);
	writeFileSync(
		file,
		source.replace(FIX.search, () => FIX.replace),
	);
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

describe("Shop UI demo fixture [real Docker, real Chromium]", () => {
	it("plants one regression commit and keeps its visible unit tests green", async () => {
		expect(REGRESSION.edit.replace.split("\n")).toHaveLength(1);
		const result = await executor.run({
			runId: "shopui-unit-1",
			investigationId: "inv_shopui",
			workspace: buggy,
			argv: ["npm", "test"],
			env: SUITE_ENV,
			timeoutMs: 60_000,
		});
		expect(result.status).toBe("exited");
		expect(result.exitCode).toBe(0);
		const tap = parseTap(result.stdout);
		expect(tap.fail).toBe(0);
		expect(tap.pass).toBeGreaterThanOrEqual(9);
	});

	it("shows the bug in the before run and the fix in the after run, with a PNG of each", async () => {
		const before = await executor.runBrowser(request("shopui-before-1", buggy));
		expect(before.status).toBe("exited");
		const shown = before.report;
		expect(shown?.ready).toBe(true);
		expect(shown?.startup).toMatchObject({
			health_ok: true,
			health_status: 200,
			page_loaded: true,
		});
		// The promise holds and the contradiction is on the page: the subtotal is exactly $50.00, the
		// banner promises free shipping, and the shipping line still charges.
		const outcome = Object.fromEntries(
			(shown?.steps ?? []).map((s) => [`${s.index}:${s.action}`, s.status]),
		);
		expect(outcome).toMatchObject({
			"2:expect_url": "passed",
			"3:expect_text": "passed",
			"4:expect_text": "passed",
			"5:expect_text": "failed",
			"6:expect_no_console_errors": "skipped",
		});
		expect(shown?.steps[5]).toMatchObject({
			assertion: true,
			expected: "Shipping: Free",
			actual: "Shipping: $4.99",
		});
		expect(shown?.final_path).toBe("/cart?qty=2");
		const beforePng = png(shown);
		expect(beforePng.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
		expect([beforePng.readUInt32BE(16), beforePng.readUInt32BE(20)]).toEqual([
			1280, 800,
		]);

		const after = await executor.runBrowser(request("shopui-after-1", fixed));
		expect(after.status).toBe("exited");
		expect(after.report?.steps.map((s) => s.status)).toEqual(
			SHOP_UI_STEPS.map(() => "passed"),
		);
		const afterPng = png(after.report);
		expect(afterPng.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
		// The page changed, so the picture did.
		expect(sha256(afterPng)).not.toBe(sha256(beforePng));
		expect(quiet("ps", "-a", "-q", "--filter", "name=tracera-app-shopui")).toBe(
			"",
		);
	});
});
