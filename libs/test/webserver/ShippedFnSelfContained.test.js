'use strict';

// Guard for the three functions shipped to the BROWSER as source and rebuilt there with new Function(). The
// Active Deals view is rendered with computeAddFundsForward / convertBoolean / getCurrencySymbol serialized via
// .toString() (DCABotManager.js), and the view reconstitutes each with new Function('return ' + src)()
// (DCABotDealsActiveView.ejs). That only works because each function is FULLY SELF-CONTAINED — no require(), no
// module-scope constant, no closure variable. If a future edit adds any of those inside one of them, it throws
// a ReferenceError in the browser at use time — a silent client-side regression the server-side tests cannot
// catch, because the server call still has module scope. This rebuilds each in a BARE context (exactly like the
// view) and asserts it neither throws nor diverges from the direct call.

const assert = require('assert');
const Common = require('../../app/Common.js');
const AddFundsMath = require('../../app/AddFundsMath.js');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

// Rebuild a function from its source in a bare global scope — the same mechanism the view uses.
function rebuild(fn) { return new Function('return (' + fn.toString() + ')')(); }

// ── convertBoolean(param, defaultVal) ──
(function () {
	const direct = Common.convertBoolean;
	let rebuilt = null;
	try { rebuilt = rebuild(direct); ok(true, 'convertBoolean rebuilds with no ReferenceError (self-contained)'); }
	catch (e) { ok(false, 'convertBoolean rebuild threw — it is no longer self-contained: ' + e.message); }
	if (rebuilt) {
		[ [ 'true', false ], [ true, false ], [ undefined, true ], [ 'false', true ], [ 0, true ], [ 'yes', false ] ]
			.forEach(([ p, d ]) => ok(rebuilt(p, d) === direct(p, d), 'convertBoolean(' + JSON.stringify(p) + ', ' + d + ') matches the direct call'));
	}
})();

// ── getCurrencySymbol(code) ──
(function () {
	const direct = Common.getCurrencySymbol;
	let rebuilt = null;
	try { rebuilt = rebuild(direct); ok(true, 'getCurrencySymbol rebuilds with no ReferenceError (self-contained)'); }
	catch (e) { ok(false, 'getCurrencySymbol rebuild threw — it is no longer self-contained: ' + e.message); }
	if (rebuilt) {
		[ 'USD', 'EUR', 'GBP', 'BTC', 'XYZ', '' ]
			.forEach(c => ok(rebuilt(c) === direct(c), 'getCurrencySymbol(' + JSON.stringify(c) + ') matches the direct call'));
	}
})();

// ── computeAddFundsForward(params) ──
(function () {
	const direct = AddFundsMath.computeAddFundsForward;
	let rebuilt = null;
	try { rebuilt = rebuild(direct); ok(true, 'computeAddFundsForward rebuilds with no ReferenceError (self-contained)'); }
	catch (e) { ok(false, 'computeAddFundsForward rebuild threw — it is no longer self-contained: ' + e.message); }
	if (rebuilt) {
		const params = {
			sum: 1000, qtySum: 10, addAmount: 500, addPrice: 95, price: 95,
			exchangeFee: 0.1, targetProfitPercent: 1.5, marketPrice: 95,
			currentAverageReal: 100, currentProfitPercent: -5
		};
		ok(JSON.stringify(rebuilt(params)) === JSON.stringify(direct(params)),
			'computeAddFundsForward output matches the direct call for representative inputs');
	}
})();

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
process.exit(failed ? 1 : 0);
