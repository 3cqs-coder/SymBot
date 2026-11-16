'use strict';

// Unit tests for the pure close-on-untrusted-price decisions (closeHold.js) + a static wiring guard that
// handleSell in DCABot.js actually uses them. Pins the fix: a CANCEL is NEVER held by the untrusted-price
// guard (so a deal on a dead / delisted pair can always be closed out), while a panic sell / stop-loss IS
// held (it places a real order and must have a trustworthy price); and a priceless cancel records cleanly
// abandoned figures (zero realized P&L, nothing sold), never a phantom -100% from a price of 0.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CH = require('../../../strategies/DCABot/closeHold.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m); passed++; }

// ── holdCloseForUntrustedPrice: full truth table ─────────────────────────────────────────────────────────
// Untrusted price (cancelOnly=true):
eq(CH.holdCloseForUntrustedPrice({ cancelOnly: true,  isDealCancel: true  }), false, 'cancel on untrusted price is NOT held (the fix)');
eq(CH.holdCloseForUntrustedPrice({ cancelOnly: true,  isDealCancel: false }), true,  'panic/stop-loss on untrusted price IS held (no cancel flag)');
// Trusted price (cancelOnly=false) — nothing is held by this guard regardless of action:
eq(CH.holdCloseForUntrustedPrice({ cancelOnly: false, isDealCancel: true  }), false, 'trusted price: cancel not held');
eq(CH.holdCloseForUntrustedPrice({ cancelOnly: false, isDealCancel: false }), false, 'trusted price: panic/stop-loss not held (normal close path)');

// Fail-safe on malformed / missing state — must never trap a cancel (default: do not hold).
eq(CH.holdCloseForUntrustedPrice(null), false, 'null state → not held');
eq(CH.holdCloseForUntrustedPrice(undefined), false, 'undefined state → not held');
eq(CH.holdCloseForUntrustedPrice({}), false, 'empty state → not held');
eq(CH.holdCloseForUntrustedPrice('x'), false, 'non-object state → not held');
// Only strict booleans count as true (no coercion surprises from truthy strings/numbers).
eq(CH.holdCloseForUntrustedPrice({ cancelOnly: 1, isDealCancel: 0 }), false, 'non-boolean cancelOnly is not treated as true');
eq(CH.holdCloseForUntrustedPrice({ cancelOnly: true, isDealCancel: 'yes' }), true, "isDealCancel must be boolean true to exempt — a truthy string does NOT exempt (stays held)");

// ── canceledNoPriceFigures: clean abandoned record ───────────────────────────────────────────────────────
const f = CH.canceledNoPriceFigures(123.45);
eq(f.sellPriceFinal, 123.45, 'mark = the deal average when positive (break-even)');
eq(f.profitFinal, 0, 'realized profit % is zero');
eq(f.profitBaseFinal, 0, 'realized profit base is zero');
eq(f.profitQuoteFinal, 0, 'realized profit quote is zero');
eq(f.qtySoldFinal, 0, 'nothing sold');
eq(f.profitSource, 'canceled_no_price', 'profitSource tags the no-price cancel');

// Non-positive / non-finite averages fall back to a 0 mark (never NaN / negative into the record).
eq(CH.canceledNoPriceFigures(0).sellPriceFinal, 0, 'zero average → 0 mark');
eq(CH.canceledNoPriceFigures(-5).sellPriceFinal, 0, 'negative average → 0 mark');
eq(CH.canceledNoPriceFigures(NaN).sellPriceFinal, 0, 'NaN average → 0 mark');
eq(CH.canceledNoPriceFigures(undefined).sellPriceFinal, 0, 'undefined average → 0 mark');
eq(CH.canceledNoPriceFigures('oops').sellPriceFinal, 0, 'non-numeric average → 0 mark');
// Always zero realized P&L regardless of the mark.
const g = CH.canceledNoPriceFigures(0);
ok(g.profitFinal === 0 && g.profitBaseFinal === 0 && g.profitQuoteFinal === 0 && g.qtySoldFinal === 0, 'zero-mark cancel still records zero realized P&L and nothing sold');
// Fresh object each call (no shared mutable state).
ok(CH.canceledNoPriceFigures(1) !== CH.canceledNoPriceFigures(1), 'returns a fresh object each call');

// ── Static wiring: handleSell in DCABot.js uses these single-source helpers ───────────────────────────────
const dcabot = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'strategies', 'DCABot', 'DCABot.js'), 'utf8');
ok(/require\(__dirname \+ '\/closeHold\.js'\)/.test(dcabot), 'DCABot.js requires closeHold.js');
ok(/CloseHold\.holdCloseForUntrustedPrice\(\s*\{\s*cancelOnly,\s*isDealCancel\s*\}\s*\)/.test(dcabot),
	'handleSell gates the untrusted-price hold on CloseHold.holdCloseForUntrustedPrice (not a raw `if (cancelOnly)`)');
ok(/CloseHold\.canceledNoPriceFigures\(\s*currentOrder\.average\s*\)/.test(dcabot),
	'handleSell records a priceless cancel via CloseHold.canceledNoPriceFigures');
// The old blanket hold must be gone (it trapped cancels forever on a dead feed).
ok(!/\n\t\tif \(cancelOnly\) \{/.test(dcabot), 'the old blanket `if (cancelOnly)` hold is gone');

console.log('CloseHold: ' + passed + ' assertions passed');
