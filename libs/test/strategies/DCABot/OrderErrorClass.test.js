'use strict';

// Tests for orderErrorClass.isPersistentOrderError (#129) — the single source of truth the resume path
// uses to decide whether to KEEP a buy_error / sell_error pause across a restart (persistent condition)
// or clear it and resume as before (transient / unknown). Pure: text in, boolean out.
//
// The decisive property is the conservative default: ONLY recognized persistent conditions return true;
// everything else — including unknown messages, empty, and null — returns false, so the caller fails
// safe to the existing clear-and-resume behavior and can never strand a deal on a false positive.

const assert = require('assert');
const { isPersistentOrderError, PERSISTENT_PATTERNS } = require('../../../strategies/DCABot/orderErrorClass.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── Persistent conditions → true (the whole point: don't re-attempt a doomed order every restart) ──
const PERSISTENT = [
	'Orderbook is in limit only mode',
	'This pair is LIMIT_ONLY right now',
	'Order rejected: post only',
	'Market orders are not supported for this product',
	'INVALID_ARGUMENT: order configuration not allowed',
	'Symbol is not trading',
	'Trading is suspended for this market',
	'ZORV/USDT has been delisted',
	'Pair not currently tradable'
];
for (const msg of PERSISTENT) {
	ok(isPersistentOrderError(msg) === true, 'persistent → true: ' + msg);
}

// ── Transient / unknown → false (clear and resume, exactly as before #129) ──
const TRANSIENT = [
	'Insufficient funds',
	'Insufficient balance to place order',
	'Request timeout',
	'Rate limit exceeded, please retry',
	'Service temporarily unavailable',
	'ECONNRESET',
	'Internal error',
	'Something completely unrecognized happened',
	''
];
for (const msg of TRANSIENT) {
	ok(isPersistentOrderError(msg) === false, 'transient/unknown → false: ' + JSON.stringify(msg));
}

// ── Null / undefined / non-string → false, never throws (crash-proof) ──
ok(isPersistentOrderError(null) === false, 'null → false');
ok(isPersistentOrderError(undefined) === false, 'undefined → false');
ok(isPersistentOrderError() === false, 'no arg → false');
ok(isPersistentOrderError(12345) === false, 'number → false');
ok(isPersistentOrderError({}) === false, 'object → false (no throw)');

// ── Case-insensitive, substring-anywhere (matches real exchange messages regardless of surrounding text) ──
ok(isPersistentOrderError('ERROR: ORDERBOOK IS IN LIMIT ONLY MODE') === true, 'uppercase match');
ok(isPersistentOrderError('   the market order is disabled for now   ') === true, 'embedded + padded match');

// ── Every declared pattern actually matches itself (keeps the table honest) ──
for (const p of PERSISTENT_PATTERNS) {
	ok(isPersistentOrderError('prefix ' + p + ' suffix') === true, 'declared pattern matches: ' + p);
}

console.log('OrderErrorClass: ' + passed + ' assertions passed');
process.exit(0);
