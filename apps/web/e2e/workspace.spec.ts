import { expect, test } from "@playwright/test";
import {
	expectNoHorizontalScroll,
	localRepoPath,
	screenshot,
	signIn,
	watchConsole,
} from "./support.ts";

// One serial journey over the real API: register → index → explore → question → impact.
test.describe.configure({ mode: "serial" });

const repoName = `tiny-api-${Date.now().toString(36)}`;
let repoUrl = "";

test("signs in, registers a local repository, and indexes it", async ({
	page,
}) => {
	const errors = watchConsole(page);
	await signIn(page);
	await page.getByRole("link", { name: "Register repository" }).click();
	await page.getByLabel("Name").fill(repoName);
	await page.getByLabel("Local path").check();
	await page.getByLabel("Repository path").fill(localRepoPath);
	await page.getByRole("button", { name: "Register and index" }).click();
	await expect(
		page.getByRole("heading", { level: 1, name: repoName }),
	).toBeVisible();
	repoUrl = new URL(page.url()).pathname;
	// Indexing runs in the worker; the page polls until the snapshot is ready (or partial).
	await expect(
		page
			.getByRole("region", { name: "Recent snapshots" })
			.getByText(/^(Ready|Partial)$/)
			.first(),
	).toBeVisible({ timeout: 120_000 });
	await expect(page.getByRole("heading", { name: "Coverage" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Freshness" })).toBeVisible();
	await screenshot(page, "repository-overview-desktop");
	await page.goto("/");
	await expect(page.getByRole("link", { name: repoName })).toBeVisible();
	expect(errors).toEqual([]);
});

test("searches the graph and opens a node with trace, history, and impact", async ({
	page,
}) => {
	const errors = watchConsole(page);
	await signIn(page);
	await page.goto(`${repoUrl}/explore`);
	await page.getByLabel("Symbol, file, route, table, or text").fill("total");
	await page.getByRole("button", { name: "Search" }).click();
	await page.getByRole("link", { name: "total", exact: true }).first().click();
	await expect(
		page.getByRole("heading", { level: 2, name: "total" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Trace downstream" }).click();
	await expect(page.getByText(/nodes, \d+ edges downstream/)).toBeVisible();
	await page
		.getByRole("button", { name: "Load history and ownership" })
		.click();
	await expect(page.getByText("Initial tiny api").first()).toBeVisible();
	await page.getByRole("button", { name: "Analyze change impact" }).click();
	await expect(page.getByText(/dependents? reached in snapshot/)).toBeVisible();
	await screenshot(page, "node-desktop");
	expect(errors).toEqual([]);
});

test("asks an engineering question and shows a labelled answer", async ({
	page,
}) => {
	const errors = watchConsole(page);
	await signIn(page);
	await page.goto(`${repoUrl}/questions`);
	await page
		.getByLabel("Question about this repository")
		.fill("Where is the order total computed?");
	await page.getByRole("button", { name: "Ask", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Where is the order total computed?" }),
	).toBeVisible();
	// Completed or failed, the result is shown as stored; mock inference is labelled [mock].
	await expect(page.getByText(/^(Completed|Failed)$/).first()).toBeVisible({
		timeout: 90_000,
	});
	if (await page.getByText("Completed", { exact: true }).isVisible()) {
		await expect(page.getByText("[mock]").first()).toBeVisible();
		await expect(page.getByRole("heading", { name: /^Claims/ })).toBeVisible();
	}
	await screenshot(page, "question-desktop");
	expect(errors).toEqual([]);
});

test("analyzes symbol impact and patch impact", async ({ page }) => {
	const errors = watchConsole(page);
	await signIn(page);
	await page.goto(`${repoUrl}/impact`);
	await page.getByLabel("Name").fill("add");
	await page.getByRole("button", { name: "Analyze impact" }).click();
	await expect(page.getByText(/dependents? reached in snapshot/)).toBeVisible();
	await page.getByLabel("A unified diff on a base revision").check();
	await page
		.getByLabel(/^Diff/)
		.fill(
			[
				"diff --git a/src/math.js b/src/math.js",
				"--- a/src/math.js",
				"+++ b/src/math.js",
				"@@ -1,3 +1,3 @@",
				" export function add(a, b) {",
				"-\treturn a + b;",
				"+\treturn Number(a) + Number(b);",
				" }",
				"",
			].join("\n"),
		);
	await page.getByRole("button", { name: "Analyze patch impact" }).click();
	await expect(
		page.getByRole("heading", { name: "Patch impact", level: 2 }),
	).toBeVisible();
	await expect(
		page.getByText(/^(Completed|Partial|Failed)$/).first(),
	).toBeVisible({
		timeout: 90_000,
	});
	await screenshot(page, "patch-impact-desktop");
	expect(errors).toEqual([]);
});

let investigationUrl = "";

test("starts an investigation and follows its stages to a stored outcome", async ({
	page,
}) => {
	const errors = watchConsole(page);
	await signIn(page);
	await page.getByRole("link", { name: "Investigations" }).click();
	await page.getByRole("link", { name: "New investigation" }).click();
	await page.getByLabel("Repository").selectOption({ label: repoName });
	await page.getByLabel("Title").fill("Order total ignores string prices");
	await page
		.getByLabel("What happened")
		.fill("total() concatenates when a price is a string.");
	await page
		.getByLabel("Expected behavior (optional)")
		.fill("total([{price: '2'}, {price: 3}]) is 5");
	await page.getByRole("button", { name: "Start investigation" }).click();
	await expect(
		page.getByRole("heading", {
			level: 1,
			name: "Order total ignores string prices",
		}),
	).toBeVisible();
	investigationUrl = new URL(page.url()).pathname;
	await expect(page.getByText("[mock]").first()).toBeVisible();
	await expect(page.getByRole("region", { name: "Workflow" })).toBeVisible();
	// The worker drives it to a stored state; the page polls and never invents progress.
	await expect(
		page
			.locator("main")
			.getByText(/^(Completed|Failed|Awaiting approval|Needs input|Cancelled)$/)
			.first(),
	).toBeVisible({ timeout: 200_000 });
	await screenshot(page, "investigation-desktop");
	await page.getByRole("link", { name: "Resolution report" }).click();
	const reportTitle = /Order total ignores string prices|Resolution report/;
	const heading = page.getByRole("heading", { level: 1 });
	await expect(heading.filter({ hasText: reportTitle })).toBeVisible();
	await screenshot(page, "report-desktop");
	expect(errors.filter((e) => !e.includes("404 (Not Found)"))).toEqual([]);
});

test("stays usable at 375 px without horizontal scroll", async ({ page }) => {
	const errors = watchConsole(page);
	await page.setViewportSize({ width: 375, height: 812 });
	await signIn(page);
	await expectNoHorizontalScroll(page);
	for (const [path, name] of [
		[repoUrl, "repository"],
		[`${repoUrl}/explore?q=total`, "explore"],
		[`${repoUrl}/impact`, "impact"],
		["/investigations", "investigations"],
		[investigationUrl, "investigation"],
	] as const) {
		await page.goto(path);
		await page.waitForLoadState("networkidle");
		await expectNoHorizontalScroll(page);
		await screenshot(page, `${name}-375`);
	}
	expect(errors).toEqual([]);
});
