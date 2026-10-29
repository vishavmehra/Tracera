import { expect, type Page, test } from "@playwright/test";
import {
	expectNoHorizontalScroll,
	localRepoPath,
	screenshot,
	signIn,
	watchConsole,
} from "./support.ts";

// Deterministic journeys over the real stack (`npm run e2e:stack`): the API, the production worker loop
// with the [mock] fixture provider (apps/server/test/e2e/fixture-provider.ts), and the real Docker
// sandbox. The provider only proposes; citations, claim states, patch policy, and verification outcomes
// come from Tracera's own rules and real sandbox runs, so "verified" appears only when the pipeline
// verified the patch. Scenario markers in report titles select the fixture provider's proposals.

test.describe.configure({ mode: "serial" });

const repoName = `fixture-${Date.now().toString(36)}`;
let repoUrl = "";
const INVESTIGATION_TIMEOUT = 300_000;

/** The investigation page may poll the report before it exists; that 404 is expected. */
const unexpected = (errors: string[]) =>
	errors.filter((error) => !error.includes("404 (Not Found)"));

async function startInvestigation(
	page: Page,
	title: string,
	mode: "full" | "analysis_only" = "full",
) {
	await page.goto("/investigations/new");
	await page.getByLabel("Repository").selectOption({ label: repoName });
	await page.getByLabel("Title").fill(title);
	await page
		.getByLabel("What happened")
		.fill('total([{price: "2"}, {price: 3}]) returns "023" instead of 5.');
	await page
		.getByLabel("Expected behavior (optional)")
		.fill("total([{price: '2'}, {price: 3}]) is 5");
	await page.getByLabel("Mode").selectOption(mode);
	await page.getByRole("button", { name: "Start investigation" }).click();
	await expect(
		page.getByRole("heading", { level: 1, name: title }),
	).toBeVisible();
	await expect(
		page
			.locator("main")
			.getByText("Awaiting approval", { exact: true })
			.first(),
	).toBeVisible({ timeout: INVESTIGATION_TIMEOUT });
	return new URL(page.url()).pathname;
}

/** Opens the patch review page of the investigation shown. */
async function openReview(page: Page) {
	await page
		.getByRole("link", { name: /^Review patch/ })
		.first()
		.click();
	await expect(
		page.getByRole("heading", { level: 1, name: /^Patch attempt \d+$/ }),
	).toBeVisible();
}

/** Ticks every acknowledgement the approval form asks for. */
async function acknowledgeAll(page: Page) {
	const boxes = page
		.getByRole("group", { name: "Acknowledge before approving" })
		.getByRole("checkbox");
	for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
}

test("registers the fixture repository and indexes it", async ({ page }) => {
	const errors = watchConsole(page);
	await page.goto("/sign-in");
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	await screenshot(page, "sign-in-desktop");
	await page.setViewportSize({ width: 375, height: 812 });
	await expectNoHorizontalScroll(page);
	await screenshot(page, "sign-in-375");
	await page.setViewportSize({ width: 1280, height: 720 });
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
	await expect(
		page
			.getByRole("region", { name: "Recent snapshots" })
			.getByText(/^(Ready|Partial)$/)
			.first(),
	).toBeVisible({ timeout: 120_000 });
	expect(errors).toEqual([]);
});

test("answers a question with one supported and one unsupported claim, labelled mock", async ({
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
		page.getByText("Completed", { exact: true }).first(),
	).toBeVisible({ timeout: 120_000 });
	await expect(page.getByText("[mock]").first()).toBeVisible();
	await expect(page.getByRole("heading", { name: "Claims (2)" })).toBeVisible();
	await expect(page.getByText("Supported", { exact: true })).toHaveCount(1);
	await expect(page.getByText("Unsupported", { exact: true })).toHaveCount(1);
	await expect(
		page.getByText(/\[mock fixture\] The excerpt CODE-\d+/),
	).toBeVisible();
	await screenshot(page, "answer-desktop");
	await page.setViewportSize({ width: 375, height: 812 });
	await expectNoHorizontalScroll(page);
	await screenshot(page, "answer-375");
	expect(errors).toEqual([]);
});

test("reviews a patch and approves it as unverified only after acknowledging every reason", async ({
	page,
}) => {
	const errors = watchConsole(page);
	await signIn(page);
	await startInvestigation(
		page,
		"[e2e:unverified] String prices are concatenated",
	);
	await openReview(page);
	// Diff, static impact, risks, and the outcome the pipeline recorded.
	await expect(page.getByText(/Number\(item\.price\)/).first()).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Static impact of the diff" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Risks" })).toBeVisible();
	await expect(page.getByText(/^Partially verified/).first()).toBeVisible();
	await expect(page.getByText("baseline_not_attempted").first()).toBeVisible();
	await expect(page.getByText("[mock]").first()).toBeVisible();
	const approve = page.getByRole("button", {
		name: "Approve unverified patch",
	});
	await expect(approve).toBeDisabled();
	await screenshot(page, "review-unverified-desktop");
	await page.setViewportSize({ width: 375, height: 812 });
	await expectNoHorizontalScroll(page);
	await screenshot(page, "review-unverified-375");
	await page.setViewportSize({ width: 1280, height: 720 });
	await acknowledgeAll(page);
	await expect(approve).toBeEnabled();
	await approve.click();
	await expect(
		page.getByText("No files were changed by this decision."),
	).toBeVisible();
	await expect(page.getByText(/^Acknowledged: /)).toContainText(
		"baseline_not_attempted",
	);
	expect(unexpected(errors)).toEqual([]);
});

test("shows verified only when the real pipeline verified the patch", async ({
	page,
}) => {
	const errors = watchConsole(page);
	await signIn(page);
	await startInvestigation(
		page,
		"[e2e:verified] String prices are concatenated",
	);
	await expect(
		page.getByText("Reproduced", { exact: true }).first(),
	).toBeVisible();
	await openReview(page);
	await expect(page.getByText(/^Verified/).first()).toBeVisible();
	await expect(page.getByText("Why not fully verified")).toHaveCount(0);
	// The checks that produced the outcome ran in the sandbox.
	await expect(
		page.getByText("Reproduction", { exact: true }).first(),
	).toBeVisible();
	await expect(page.getByText("docker", { exact: true }).first()).toBeVisible();
	await screenshot(page, "review-verified-desktop");
	if (
		await page
			.getByRole("group", { name: "Acknowledge before approving" })
			.isVisible()
	)
		await acknowledgeAll(page);
	await page.getByRole("button", { name: "Approve verified patch" }).click();
	await expect(
		page.getByText("No files were changed by this decision."),
	).toBeVisible();
	expect(unexpected(errors)).toEqual([]);
});

test("records a blocked verification in analysis-only mode and rejects the patch", async ({
	page,
}) => {
	const errors = watchConsole(page);
	await signIn(page);
	await startInvestigation(
		page,
		"[e2e:unverified] Analysis only: string prices",
		"analysis_only",
	);
	await openReview(page);
	await expect(page.getByText(/^Blocked/).first()).toBeVisible();
	await expect(page.getByText("analysis_only_requested").first()).toBeVisible();
	await page.getByRole("radio", { name: "Reject" }).check();
	await page.getByRole("button", { name: "Reject patch" }).click();
	await expect(
		page.getByText("No files were changed by this decision."),
	).toBeVisible();
	expect(unexpected(errors)).toEqual([]);
});

test("shows errors for malformed and unknown patch links", async ({ page }) => {
	await signIn(page);
	await page.goto("/investigations/not-an-id/patches/also-not");
	await expect(page.getByText("Not a patch ID.")).toBeVisible();
	await page.goto(
		"/investigations/inv_01J00000000000000000000000/patches/pat_01J00000000000000000000000",
	);
	await expect(page.getByText(/not found/i).first()).toBeVisible();
});

test("keyboard users reach a skip link first, and the page has its landmarks", async ({
	page,
}) => {
	await signIn(page);
	await page.goto(repoUrl);
	await page.keyboard.press("Tab");
	await expect(
		page.getByRole("link", { name: "Skip to content" }),
	).toBeFocused();
	await expect(page.getByRole("main")).toHaveCount(1);
	await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
	await expect(page.getByRole("banner")).toBeVisible();
	// The account menu opens from its button and closes with Escape.
	const signOut = page.getByRole("button", { name: "Sign out" });
	await expect(signOut).toBeHidden();
	await page.getByRole("button", { name: /account menu/ }).click();
	await expect(signOut).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(signOut).toBeHidden();
});
