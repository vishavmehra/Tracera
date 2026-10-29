import assert from "node:assert/strict";
import { test } from "node:test";
import {
	averageOrderValueCents,
	dashboardSummary,
	lineItemCount,
	revenueCents,
} from "../src/metrics.js";

const order = (...prices) => ({
	lines: prices.map((unitPriceCents) => ({ unitPriceCents, quantity: 1 })),
});

test("revenue sums every line of every order", () => {
	assert.equal(revenueCents([order(1500, 980), order(2480)]), 4960);
});

test("counts line items across orders", () => {
	assert.equal(lineItemCount([order(100, 200), order(300)]), 3);
});

test("average order value of single-item orders", () => {
	assert.equal(averageOrderValueCents([order(1000), order(3000)]), 2000);
});

test("empty dashboards show zero", () => {
	assert.deepEqual(dashboardSummary([]), {
		orders: 0,
		lineItems: 0,
		revenueCents: 0,
		averageOrderValueCents: 0,
	});
});
