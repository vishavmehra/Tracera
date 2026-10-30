import {
	FREE_SHIPPING_THRESHOLD_CENTS,
	formatCents,
	formatShipping,
	orderTotals,
} from "./pricing.js";

export const ITEM = { name: "Desk lamp", unitPriceCents: 2500 };
export const MAX_QUANTITY = 10;

/** A whole number from 1 to MAX_QUANTITY; anything else is 1. */
export function parseQuantity(value) {
	const quantity = Number.parseInt(value ?? "", 10);
	if (!Number.isInteger(quantity)) return 1;
	return Math.min(Math.max(quantity, 1), MAX_QUANTITY);
}

/** The amounts and the promise the cart page shows, all from the pricing module. */
export function cartSummary(quantity) {
	const totals = orderTotals([
		{ unitPriceCents: ITEM.unitPriceCents, quantity },
	]);
	return {
		banner: `Free shipping on orders of $${FREE_SHIPPING_THRESHOLD_CENTS / 100} or more`,
		line: formatCents(totals.subtotal),
		subtotal: formatCents(totals.subtotal),
		shipping: formatShipping(totals.shipping),
		total: formatCents(totals.total),
	};
}

const STYLE = `
:root { --ink: #1d1b16; --muted: #5c584d; --line: #e0dccf; --paper: #fbfaf6; --card: #fff; --green: #14532d; --green-bg: #e3f1e6; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 22px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 18px 32px; border-bottom: 1px solid var(--line); background: var(--card); font-size: 24px; }
.brand { font-weight: 700; letter-spacing: 0.01em; }
.tag { border: 1px solid var(--line); border-radius: 999px; padding: 1px 12px; color: var(--muted); font-size: 16px; }
main { max-width: 1000px; margin: 0 auto; padding: 28px 24px 40px; }
.banner { margin: 0 0 20px; padding: 14px 20px; border-radius: 10px; background: var(--green-bg); color: var(--green); font-size: 30px; font-weight: 700; }
h1 { margin: 0 0 12px; font-size: 40px; line-height: 1.25; }
.card { margin-bottom: 16px; padding: 18px 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
.item { display: grid; grid-template-columns: 1fr auto auto; gap: 8px 32px; align-items: center; }
.name { font-size: 30px; font-weight: 600; }
.unit { color: var(--muted); font-size: 22px; }
.qty { display: flex; align-items: center; gap: 14px; font-size: 30px; font-variant-numeric: tabular-nums; }
.step { display: inline-grid; place-items: center; width: 48px; height: 48px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); color: var(--ink); font-size: 28px; text-decoration: none; }
.step.off { color: #aaa597; }
a.step:hover { border-color: var(--ink); }
a.step:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.line { min-width: 5ch; text-align: right; font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; }
.row { display: flex; justify-content: space-between; gap: 16px; margin: 0; padding: 6px 0; font-size: 32px; font-variant-numeric: tabular-nums; }
.row.total { margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 36px; font-weight: 700; }
.checkout { width: 100%; padding: 14px; border: 0; border-radius: 10px; background: var(--ink); color: #fff; font: inherit; font-weight: 600; opacity: 0.55; }
.note { margin-top: 20px; color: var(--muted); font-size: 18px; text-align: center; }
@media (max-width: 600px) { body { font-size: 16px; } header { padding: 14px 16px; font-size: 18px; } main { padding: 20px 12px 32px; } .banner { font-size: 20px; } h1 { font-size: 28px; } .name, .qty, .line { font-size: 20px; } .unit { font-size: 15px; } .row { font-size: 20px; } .row.total { font-size: 24px; } .step { width: 40px; height: 40px; font-size: 22px; } .item { grid-template-columns: 1fr auto; } .unit { grid-column: 1; } .line { grid-column: 2; grid-row: 1; } }
`;

export function renderCart(quantity) {
	const summary = cartSummary(quantity);
	const step = (label, symbol, to, enabled) =>
		enabled
			? `<a class="step" href="/cart?qty=${to}" aria-label="${label} ${ITEM.name}">${symbol}</a>`
			: `<span class="step off" aria-hidden="true">${symbol}</span>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cart · Lumen Goods</title>
<style>${STYLE}</style>
</head>
<body>
<header><span class="brand">Lumen Goods</span><span class="tag">demo fixture</span></header>
<main>
<p class="banner" data-testid="banner">${summary.banner}</p>
<h1>Your cart</h1>
<section class="card item" aria-label="Cart item">
<div><div class="name">${ITEM.name}</div><div class="unit">${formatCents(ITEM.unitPriceCents)} each</div></div>
<div class="qty">${step("Remove one", "&minus;", quantity - 1, quantity > 1)}<span data-testid="quantity">${quantity}</span>${step("Add one", "+", quantity + 1, quantity < MAX_QUANTITY)}</div>
<div class="line" data-testid="line-total">${summary.line}</div>
</section>
<section class="card" aria-label="Order summary">
<p class="row" data-testid="subtotal"><span>Subtotal:</span> <span>${summary.subtotal}</span></p>
<p class="row" data-testid="shipping"><span>Shipping:</span> <span>${summary.shipping}</span></p>
<p class="row total" data-testid="total"><span>Total:</span> <span>${summary.total}</span></p>
</section>
<button class="checkout" type="button" disabled>Checkout (demo)</button>
<p class="note">Demo fixture for Tracera. Not a real shop.</p>
</main>
</body>
</html>
`;
}
