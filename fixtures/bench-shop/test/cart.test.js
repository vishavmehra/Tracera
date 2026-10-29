import assert from "node:assert/strict";
import { test } from "node:test";
import { addItem, createCart, itemCount, removeItem } from "../src/cart.js";

const mug = { sku: "MUG-BLU", name: "Blue Mug", priceCents: 1200 };
const lamp = { sku: "LMP-AMB", name: "Amber Lamp", priceCents: 3900 };
const tea = { sku: "TEA-GRN", name: "Green Tea", priceCents: 650 };

test("adding the same product twice merges the quantity", () => {
	const cart = addItem(addItem(createCart(), mug), mug, 2);
	assert.equal(cart.lines.length, 1);
	assert.equal(itemCount(cart), 3);
});

test("removing an item keeps the other lines in order", () => {
	const cart = createCart();
	for (const product of [mug, lamp, tea]) addItem(cart, product);
	removeItem(cart, lamp.sku);
	assert.deepEqual(
		cart.lines.map((line) => line.name),
		["Blue Mug", "Green Tea"],
	);
});

test("quantity must be a positive integer", () => {
	assert.throws(() => addItem(createCart(), mug, 0), RangeError);
});
