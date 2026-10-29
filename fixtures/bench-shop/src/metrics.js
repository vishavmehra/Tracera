// Sales metrics for the Bench Shop dashboard. All amounts are integer cents.

function orderRevenueCents(order) {
	return order.lines.reduce(
		(sum, line) => sum + line.unitPriceCents * line.quantity,
		0,
	);
}

export function revenueCents(orders) {
	return orders.reduce((sum, order) => sum + orderRevenueCents(order), 0);
}

export function lineItemCount(orders) {
	return orders.reduce((count, order) => count + order.lines.length, 0);
}

export function averageOrderValueCents(orders) {
	if (orders.length === 0) return 0;
	return Math.round(revenueCents(orders) / orders.length);
}

export function dashboardSummary(orders) {
	return {
		orders: orders.length,
		lineItems: lineItemCount(orders),
		revenueCents: revenueCents(orders),
		averageOrderValueCents: averageOrderValueCents(orders),
	};
}
