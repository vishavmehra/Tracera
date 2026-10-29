// Shopping cart operations. A cart keeps one line per SKU, in insertion order.

export function createCart() {
	return { lines: [] };
}

export function addItem(cart, product, quantity = 1) {
	if (!Number.isInteger(quantity) || quantity < 1) {
		throw new RangeError("quantity must be a positive integer");
	}
	const existing = cart.lines.find((line) => line.sku === product.sku);
	if (existing) {
		existing.quantity += quantity;
	} else {
		cart.lines.push({
			sku: product.sku,
			name: product.name,
			unitPriceCents: product.priceCents,
			quantity,
		});
	}
	return cart;
}

export function removeItem(cart, sku) {
	const index = cart.lines.findIndex((line) => line.sku === sku);
	if (index !== -1) cart.lines.splice(index, 1);
	return cart;
}

export function itemCount(cart) {
	return cart.lines.reduce((count, line) => count + line.quantity, 0);
}
