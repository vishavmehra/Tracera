import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatCents,
	orderTotal,
	shippingCents,
	subtotalCents,
	taxCents,
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

test("tax is rounded to the nearest cent", () => {
	assert.equal(taxCents(1999), 160);
});

test("order total adds subtotal, shipping and tax", () => {
	assert.deepEqual(orderTotal([line(1000, 2)]), {
		subtotal: 2000,
		shipping: 499,
		tax: 160,
		total: 2659,
	});
});

test("formats cents as dollars", () => {
	assert.equal(formatCents(2480), "$24.80");
});
