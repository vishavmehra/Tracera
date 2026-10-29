import type { BrowserStep } from "@tracera/contracts";
import { describe, expect, it } from "vitest";
import {
	BROWSER_STEP_LIMITS,
	validateBrowserSteps,
} from "../src/sandbox/browser-steps.ts";

// Browser reproduction steps [pure]: what Tracera agrees to run in the browser, decided
// from the model's proposal alone, before any container starts.

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
const button = {
	by: "role" as const,
	value: "button",
	name: "Add item",
	exact: null,
};
const total = {
	by: "test_id" as const,
	value: "total",
	name: null,
	exact: null,
};
const assertion = step({ action: "expect_no_console_errors" });
const VALID: BrowserStep[] = [
	step({ action: "goto", path: "/cart" }),
	step({ action: "click", target: button }),
	step({ action: "expect_text", target: total, value: "Total: $4" }),
];

describe("validateBrowserSteps", () => {
	it("accepts a navigation, an interaction, and an assertion", () => {
		expect(validateBrowserSteps(VALID)).toEqual({ ok: true, errors: [] });
	});

	it("accepts every action with the fields it needs", () => {
		const check = validateBrowserSteps([
			step({ action: "set_viewport", width: 375, height: 812 }),
			step({ action: "goto", path: "/" }),
			step({
				action: "fill",
				target: { by: "label", value: "Email", name: null, exact: true },
				value: "a@example.com",
			}),
			step({ action: "press", key: "Enter" }),
			step({ action: "press", key: "Control+A", target: total }),
			step({
				action: "select",
				target: { by: "css", value: "select#size", name: null, exact: null },
				value: "M",
			}),
			step({ action: "wait_for", target: total, timeout_ms: 5000 }),
			step({ action: "expect_visible", target: button }),
			step({ action: "expect_hidden", target: total }),
			step({ action: "expect_url", path: "/done" }),
			step({ action: "expect_no_console_errors" }),
			step({ action: "expect_no_horizontal_overflow" }),
		]);
		expect(check).toEqual({ ok: true, errors: [] });
	});

	it("requires at least one step and one assertion, within the step limit", () => {
		expect(validateBrowserSteps([]).ok).toBe(false);
		expect(
			validateBrowserSteps([
				step({ action: "goto", path: "/" }),
				step({ action: "click", target: button }),
			]).ok,
		).toBe(false);
		expect(
			validateBrowserSteps(
				Array.from({ length: BROWSER_STEP_LIMITS.steps + 1 }, () => assertion),
			).ok,
		).toBe(false);
	});

	it.each([
		["a full URL", step({ action: "goto", path: "https://evil.example/" })],
		[
			"a protocol-relative URL",
			step({ action: "goto", path: "//evil.example/x" }),
		],
		[
			"a javascript: URL",
			step({ action: "goto", path: "javascript:alert(1)" }),
		],
		["a backslash path", step({ action: "goto", path: "/\\evil.example" })],
		["a missing path", step({ action: "goto" })],
		["a click without a target", step({ action: "click" })],
		["a fill without a value", step({ action: "fill", target: total })],
		[
			"expect_text without text",
			step({ action: "expect_text", target: total }),
		],
		["an unknown key", step({ action: "press", key: "Ctrl+$(rm)" })],
		[
			"a tiny viewport",
			step({ action: "set_viewport", width: 10, height: 10 }),
		],
		[
			"a long timeout",
			step({ action: "wait_for", target: total, timeout_ms: 60_000 }),
		],
		[
			"a chained CSS selector",
			step({
				action: "click",
				target: { by: "css", value: "div >> text=x", name: null, exact: null },
			}),
		],
		[
			"an xpath selector",
			step({
				action: "click",
				target: { by: "css", value: "xpath=//button", name: null, exact: null },
			}),
		],
		[
			"an invalid role",
			step({
				action: "click",
				target: { by: "role", value: "button; drop", name: null, exact: null },
			}),
		],
	])("rejects %s", (_label, bad) => {
		const check = validateBrowserSteps([bad, assertion]);
		expect(check.ok).toBe(false);
		expect(check.errors[0]).toMatch(/^step 1: /);
	});
});
