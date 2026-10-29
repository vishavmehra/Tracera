// Hidden acceptance test (evaluator-owned). Never copied into a registered repository.
import assert from "node:assert/strict";
import { test } from "node:test";
import { addItem, createCart, removeItem } from "../src/cart.js";

const mug = { sku: "MUG-BLU", name: "Blue Mug", priceCents: 1200 };
const lamp = { sku: "LMP-AMB", name: "Amber Lamp", priceCents: 3900 };
const tea = { sku: "TEA-GRN", name: "Green Tea", priceCents: 650 };

const fullCart = () => {
	const cart = createCart();
	for (const product of [mug, lamp, tea]) addItem(cart, product);
	return cart;
};
const names = (cart) => cart.lines.map((line) => line.name);

test("removing the same item twice keeps the other items", () => {
	const cart = fullCart();
	removeItem(cart, lamp.sku);
	removeItem(cart, lamp.sku);
	assert.deepEqual(names(cart), ["Blue Mug", "Green Tea"]);
});

test("removing an unknown SKU changes nothing", () => {
	const cart = fullCart();
	removeItem(cart, "NOT-IN-CART");
	assert.deepEqual(names(cart), ["Blue Mug", "Amber Lamp", "Green Tea"]);
});

test("removing every item empties the cart", () => {
	const cart = fullCart();
	for (const product of [tea, mug, lamp]) removeItem(cart, product.sku);
	assert.deepEqual(names(cart), []);
});
