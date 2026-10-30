import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatCents,
	formatShipping,
	orderTotals,
	shippingCents,
	subtotalCents,
} from "../src/pricing.js";

const line = (unitPriceCents, quantity = 1) => ({ unitPriceCents, quantity });

test("subtotal multiplies unit price by quantity", () => {
	assert.equal(subtotalCents([line(1250, 2), line(300)]), 2800);
});

test("small orders pay standard shipping", () => {
	assert.equal(shippingCents(1999), 499);
});

test("large orders ship free", () => {
	assert.equal(shippingCents(12000), 0);
});

test("order totals add subtotal and shipping", () => {
	assert.deepEqual(orderTotals([line(1000, 2)]), {
		subtotal: 2000,
		shipping: 499,
		total: 2499,
	});
});

test("formats cents as dollars", () => {
	assert.equal(formatCents(2480), "$24.80");
});

test("shipping reads Free when nothing is charged", () => {
	assert.equal(formatShipping(0), "Free");
	assert.equal(formatShipping(499), "$4.99");
});
