// Shop UI pricing rules. All amounts are integer cents.

export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;
export const STANDARD_SHIPPING_CENTS = 499;

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

export function orderTotals(lines) {
	const subtotal = subtotalCents(lines);
	const shipping = shippingCents(subtotal);
	return { subtotal, shipping, total: subtotal + shipping };
}

export function formatCents(cents) {
	return `$${(cents / 100).toFixed(2)}`;
}

/** The shipping line as shoppers read it: "Free" when nothing is charged. */
export function formatShipping(cents) {
	return cents === 0 ? "Free" : formatCents(cents);
}
