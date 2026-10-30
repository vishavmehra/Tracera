import assert from "node:assert/strict";
import { test } from "node:test";
import { cartSummary, parseQuantity, renderCart } from "../src/cart-page.js";

const text = (html) =>
	html
		.replace(/<style>[\s\S]*?<\/style>/, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ");

test("one lamp pays standard shipping", () => {
	assert.deepEqual(cartSummary(1), {
		banner: "Free shipping on orders of $50 or more",
		line: "$25.00",
		subtotal: "$25.00",
		shipping: "$4.99",
		total: "$29.99",
	});
});

test("three lamps ship free", () => {
	const summary = cartSummary(3);
	assert.equal(summary.subtotal, "$75.00");
	assert.equal(summary.shipping, "Free");
	assert.equal(summary.total, "$75.00");
});

test("the page shows the promise and the totals", () => {
	const page = text(renderCart(3));
	assert.match(page, /Free shipping on orders of \$50 or more/);
	assert.match(page, /Subtotal: \$75\.00/);
	assert.match(page, /Shipping: Free/);
});

test("quantity is a whole number from 1 to 10", () => {
	assert.equal(parseQuantity(undefined), 1);
	assert.equal(parseQuantity("abc"), 1);
	assert.equal(parseQuantity("0"), 1);
	assert.equal(parseQuantity("4"), 4);
	assert.equal(parseQuantity("99"), 10);
});
