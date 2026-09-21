'use strict';

// Pins the money-safety invariant behind the add-funds dry-run fix: a REAL exchange order is placed ONLY
// for a live deal that is NOT a dry-run estimate. DCABot.shouldPlaceRealOrder(config, dryRun) is the exact
// gate addFundsDeal evaluates before calling buyOrder — so a dry-run add (or any sandbox/paper deal) must
// return false and the exchange is never touched. This locks the footgun closure: a dry-run add on a LIVE
// deal can never place an unintended market order. Pure function — no engine/exchange/DB wiring needed.

const assert = require('assert');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const g = DCABot.shouldPlaceRealOrder;

// The ONLY case that places a real exchange order: a live deal with a real (non-dry-run) add.
ok(g({ sandBox: false }, false) === true,  'live deal + real add → places a real order');

// The footgun this guard closes: a DRY-RUN add on a LIVE deal must NOT place a real order.
ok(g({ sandBox: false }, true)  === false, 'live deal + DRY-RUN add → never places a real order');

// Sandbox/paper deals never place a real order, dry-run or not.
ok(g({ sandBox: true },  false) === false, 'sandbox deal → never a real order');
ok(g({ sandBox: true },  true)  === false, 'sandbox deal + dry-run → never a real order');

// Any truthy dryRun value (not just boolean true) still suppresses the order — defense against a
// non-boolean flag leaking through.
ok(g({ sandBox: false }, 1)     === false, 'a truthy numeric dryRun suppresses the real order');
ok(g({ sandBox: false }, 'yes') === false, 'a truthy string dryRun suppresses the real order');

// A config with no sandBox flag is treated as LIVE (the safe assumption — never silently treat an
// unflagged deal as paper), so a real add still places; a dry-run add is still suppressed.
ok(g({}, false) === true,  'a config with no sandBox flag is treated as live for a real add');
ok(g({}, true)  === false, 'a dry-run add is suppressed even when sandBox is unset');

console.log('addFundsGuard: ' + passed + ' assertions passed');

// Requiring DCABot.js may register background timers — exit explicitly like the sibling pure-fn tests.
process.exit(0);