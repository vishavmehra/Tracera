// Hidden acceptance test (evaluator-owned). Never copied into a registered repository.
import assert from "node:assert/strict";
import { test } from "node:test";
import { orderTotal, shippingCents } from "../src/pricing.js";

test("an order of exactly $50.00 ships free", () => {
	assert.equal(shippingCents(5000), 0);
});

test("one cent below the threshold pays standard shipping", () => {
	assert.equal(shippingCents(4999), 499);
});

test("two $25.00 items check out without shipping", () => {
	const total = orderTotal([{ unitPriceCents: 2500, quantity: 2 }]);
	assert.equal(total.shipping, 0);
	assert.equal(total.total, 5400);
});
