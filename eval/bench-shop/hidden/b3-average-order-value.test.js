// Hidden acceptance test (evaluator-owned). Never copied into a registered repository.
import assert from "node:assert/strict";
import { test } from "node:test";
import { averageOrderValueCents, dashboardSummary } from "../src/metrics.js";

const order = (...prices) => ({
	lines: prices.map((unitPriceCents) => ({ unitPriceCents, quantity: 1 })),
});

test("two orders totaling $49.60 average $24.80", () => {
	assert.equal(
		averageOrderValueCents([order(1500, 980), order(1200, 1280)]),
		2480,
	);
});

test("the average is per order, not per line item", () => {
	assert.equal(
		averageOrderValueCents([order(100, 100, 100, 100), order(600)]),
		500,
	);
});

test("no orders average zero", () => {
	assert.equal(averageOrderValueCents([]), 0);
});

test("the dashboard summary uses the per-order average", () => {
	assert.equal(
		dashboardSummary([order(1500, 980), order(1200, 1280)])
			.averageOrderValueCents,
		2480,
	);
});
