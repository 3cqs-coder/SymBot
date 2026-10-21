'use strict';

// Pure tests for pairStatus.evaluatePairTradable — the delisting / suspended-pair decision behind the
// pre-start gate and the delisting_watch watchdog (backlog #138). No exchange, no network: a plain CCXT-shaped
// market object (or null) goes in, a verdict comes out. Covers both directions and the conservative "unknown
// shape → treat as tradable" rule that keeps it from false-alarming across exchanges.

const assert = require('assert');
const { evaluatePairTradable } = require('../../../strategies/DCABot/pairStatus.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── not tradable ──
let r = evaluatePairTradable(null, 'BLAST/USD');
ok(r.tradable === false && r.status === 'missing', 'null market → not tradable (missing/removed)');

r = evaluatePairTradable({ active: false, info: {} }, 'BLAST/USD');
ok(r.tradable === false && r.status === 'inactive', 'active:false → not tradable (inactive/delisted)');

r = evaluatePairTradable({ active: true, info: { trading_disabled: true } }, 'X/USD');
ok(r.tradable === false && r.status === 'disabled', 'info.trading_disabled → not tradable');

r = evaluatePairTradable({ active: true, info: { status: 'delisted' } }, 'X/USD');
ok(r.tradable === false && r.status === 'disabled', "info.status 'delisted' → not tradable");

r = evaluatePairTradable({ active: true, info: { status: 'halted' } }, 'X/USD');
ok(r.tradable === false && r.status === 'disabled', "info.status 'halted' → not tradable");

// ── limit-only: still 'trading' but SymBot (market orders) can't use it ──
r = evaluatePairTradable({ active: true, info: { limit_only: true } }, 'BLAST/USD');
ok(r.tradable === true && r.limitOnly === true && r.status === 'limit_only', 'info.limit_only → tradable but limitOnly (the BLAST case)');

r = evaluatePairTradable({ active: true, info: { limit_only: 'true' } }, 'BLAST/USD');
ok(r.limitOnly === true, "string 'true' for limit_only is coerced (truthy)");

// ── tradable / no false positives ──
r = evaluatePairTradable({ active: true, info: { status: 'online' } }, 'BTC/USD');
ok(r.tradable === true && r.limitOnly === false && r.status === 'ok', 'active:true + status online → ok');

r = evaluatePairTradable({ info: {} }, 'BTC/USD');
ok(r.tradable === true && r.status === 'ok', 'active UNDEFINED is treated as tradable (not every exchange sets it) → ok, never a false delist');

r = evaluatePairTradable({ active: true, info: { some_unknown_field: 'whatever', status: 'trading' } }, 'BTC/USD');
ok(r.tradable === true && r.status === 'ok', 'an unrecognized info shape → ok (conservative, no false alarm)');

r = evaluatePairTradable({ active: true }, 'BTC/USD');
ok(r.tradable === true && r.status === 'ok', 'no info object at all → ok (never throws)');

console.log('PairStatus: ' + passed + ' assertions passed');
process.exit(0);
