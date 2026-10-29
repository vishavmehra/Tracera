import { expect, type Page } from "@playwright/test";

// Runs against the real local API with mock inference configured explicitly; nothing here fakes a
// response. Credentials come from the seed owner of the disposable development database.

export const owner = {
	email: process.env.TRACERA_SEED_OWNER_EMAIL ?? "",
	password: process.env.TRACERA_SEED_OWNER_PASSWORD ?? "",
};
/** A local git repository under TRACERA_REPO_ROOTS (created for E2E; contains src/math.js). */
export const localRepoPath = process.env.TRACERA_E2E_REPO_PATH ?? "";

/** Collects console errors and failed page loads so each test can assert there were none. */
export function watchConsole(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}

export async function signIn(page: Page) {
	if (!owner.email || !owner.password)
		throw new Error(
			"Set TRACERA_SEED_OWNER_EMAIL and TRACERA_SEED_OWNER_PASSWORD",
		);
	await page.goto("/sign-in");
	await page.getByLabel("Email").fill(owner.email);
	await page.getByLabel("Password").fill(owner.password);
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(
		page.getByRole("heading", { level: 1, name: "Repositories" }),
	).toBeVisible();
}

/** No horizontal scroll: the document is no wider than the viewport. */
export async function expectNoHorizontalScroll(page: Page) {
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

export async function screenshot(page: Page, name: string) {
	await page.screenshot({
		path: `test-results/screens/${name}.png`,
		fullPage: true,
	});
}
