// Bench Shop pricing rules. All amounts are integer cents.

export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;
export const STANDARD_SHIPPING_CENTS = 499;
export const TAX_RATE = 0.08;

export function subtotalCents(lines) {
	return lines.reduce(
		(sum, line) => sum + line.unitPriceCents * line.quantity,
		0,
	);
}

export function shippingCents(subtotal) {
	if (subtotal >= FREE_SHIPPING_THRESHOLD_CENTS) return 0;
	return STANDARD_SHIPPING_CENTS;
}

// Tax is charged on merchandise only.
export function taxCents(subtotal) {
	return Math.round(subtotal * TAX_RATE);
}

export function orderTotal(lines) {
	const subtotal = subtotalCents(lines);
	const shipping = shippingCents(subtotal);
	const tax = taxCents(subtotal);
	return { subtotal, shipping, tax, total: subtotal + shipping + tax };
}

export function formatCents(cents) {
	return `$${(cents / 100).toFixed(2)}`;
}
