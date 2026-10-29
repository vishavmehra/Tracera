import type { BrowserAction, BrowserStep } from "@tracera/contracts";

/**
 * Browser reproduction steps: which model-proposed steps the fixed runner may execute.
 * Pure policy, shared by the pipeline (before anything runs) and the executor (defence in depth).
 * Paths stay on the app's own origin; locators are plain Playwright locators, never chained engines.
 */

export const BROWSER_STEP_LIMITS = {
	steps: 40,
	timeoutMs: 10_000,
	viewport: { minWidth: 200, maxWidth: 3840, minHeight: 200, maxHeight: 2160 },
};

const ASSERTIONS: ReadonlySet<BrowserAction> = new Set([
	"expect_text",
	"expect_visible",
	"expect_hidden",
	"expect_url",
	"expect_no_console_errors",
	"expect_no_horizontal_overflow",
]);
const NEEDS_TARGET: ReadonlySet<BrowserAction> = new Set([
	"click",
	"fill",
	"select",
	"wait_for",
	"expect_text",
	"expect_visible",
	"expect_hidden",
]);
const NEEDS_VALUE: ReadonlySet<BrowserAction> = new Set([
	"fill",
	"select",
	"expect_text",
]);

export const isAssertion = (action: BrowserAction) => ASSERTIONS.has(action);

/** A path on the app: starts with one slash, no scheme, host, backslash, or control characters. */
const APP_PATH = /^\/(?!\/)[^\\\s\p{Cc}]*$/u;
const KEY = /^[A-Za-z0-9]{1,20}(\+[A-Za-z0-9]{1,20}){0,3}$/;
const ROLE = /^[a-z]{2,30}$/;
// Playwright selector engines and chaining would let a CSS locator escape plain CSS semantics.
const CSS_FORBIDDEN = />>|^\s*[a-z-]+=|javascript:/i;

export function validateBrowserSteps(steps: readonly BrowserStep[]): {
	ok: boolean;
	errors: string[];
} {
	const errors: string[] = [];
	if (steps.length === 0) errors.push("no steps");
	if (steps.length > BROWSER_STEP_LIMITS.steps)
		errors.push(`more than ${BROWSER_STEP_LIMITS.steps} steps`);
	steps.slice(0, BROWSER_STEP_LIMITS.steps + 1).forEach((step, index) => {
		const problem = (message: string) =>
			errors.push(`step ${index + 1}: ${message}`);
		const { action, target } = step;
		if (NEEDS_TARGET.has(action) && !target)
			problem(`${action} needs a target`);
		if (NEEDS_VALUE.has(action) && (step.value === null || step.value === ""))
			problem(`${action} needs a value`);
		if (action === "goto" || action === "expect_url") {
			if (!step.path || !APP_PATH.test(step.path))
				problem(`${action} needs a path on the app, such as "/cart"`);
		}
		if (action === "press" && (!step.key || !KEY.test(step.key)))
			problem('press needs a key such as "Enter" or "Control+A"');
		if (action === "set_viewport") {
			const { minWidth, maxWidth, minHeight, maxHeight } =
				BROWSER_STEP_LIMITS.viewport;
			if (
				step.width === null ||
				step.height === null ||
				step.width < minWidth ||
				step.width > maxWidth ||
				step.height < minHeight ||
				step.height > maxHeight
			)
				problem(
					`set_viewport needs a width of ${minWidth}–${maxWidth} and a height of ${minHeight}–${maxHeight}`,
				);
		}
		if (
			step.timeout_ms !== null &&
			(step.timeout_ms < 0 || step.timeout_ms > BROWSER_STEP_LIMITS.timeoutMs)
		)
			problem(`timeout_ms must be 0–${BROWSER_STEP_LIMITS.timeoutMs}`);
		if (target) {
			if (target.by === "role" && !ROLE.test(target.value))
				problem("a role locator needs an ARIA role such as button or link");
			if (target.by === "css" && CSS_FORBIDDEN.test(target.value))
				problem(
					"a CSS locator must be plain CSS (no >>, engines, or javascript:)",
				);
		}
	});
	if (steps.length > 0 && !steps.some((step) => isAssertion(step.action)))
		errors.push("no assertion: the steps must check the expected behavior");
	return { ok: errors.length === 0, errors };
}
