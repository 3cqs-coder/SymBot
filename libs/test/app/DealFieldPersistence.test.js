'use strict';

// GUARD against a whole class of silent money-path bug: the deals schema is strict (Mongoose default), so a
// field written to a deal that is NOT declared in DCABotSchema is DROPPED on the write with no error. The flag
// then appears to work in memory but never reaches the database — it vanishes on restart, and a tick that
// re-reads the deal from the DB never sees it. That is exactly how the #148 wind-down flag (and, latently, the
// #130 partialSell hold) failed: the field was persisted but not declared, so the engine's money-path guard
// would not fire after a reload.
//
// This test makes that impossible to ship again. It (1) pins the known persisted deal-state fields as declared
// schema paths, and (2) STATICALLY SCANS the engine source for every literal object written to a deal via
// Deals.updateOne(...) / updateDeal(..., { ... }) and asserts each top-level key is a declared schema path.
// A new literal field added without declaring it fails here, loudly, offline.
//
// (The persistent-vs-transient classification of an order error is NOT a persisted field — it lives in the one
// pauseReason taxonomy as a distinct reason code, e.g. 'buy_error_persistent'. So there is no blob to declare.)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Schema = require('../../mongodb/DCABotSchema.js');
const declared = new Set(Object.keys(Schema.Deals.schema.paths));   // e.g. partialSell, orders, pauseReason, _id, __v …

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── (1) Known persisted deal-state fields MUST be declared (catches a removal, documents the requirement) ──
// These are blob/state fields the engine sets and reads back across restarts. If any is undeclared, strict
// mode silently drops it — a money-path correctness failure.
const MUST_BE_DECLARED = [
	'partialSell',    // #130 slippage-safe graceful-close hold state
	'orders', 'sellData', 'config', 'journal',
	// pausedBuy is the single source of truth for "pause averaging" (stop new safety orders) — the tick guard
	// reads it every tick, so it MUST persist.
	'paused', 'pausedBuy', 'pausedSell', 'pauseReason',
	'stopLoss', 'stopLossBreakevenArmed', 'activeStopLossPrice', 'trailHighPrice',
	'panicSell', 'canceled', 'status', 'isStart'
];
for (const f of MUST_BE_DECLARED) {
	ok(declared.has(f), 'persisted deal field "' + f + '" is a declared schema path (else strict mode drops it on write)');
}

// ── (2) Static scan: every LITERAL field written to a deal must be declared ──
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'strategies', 'DCABot', 'DCABot.js'), 'utf8');

// Return the balanced { … } object literal that begins at or after `fromIdx` (the first '{'), or null.
function readBracedObject(text, fromIdx) {
	const start = text.indexOf('{', fromIdx);
	if (start === -1) { return null; }
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === '{') { depth++; }
		else if (ch === '}') { depth--; if (depth === 0) { return { body: text.slice(start, i + 1), end: i + 1 }; } }
	}
	return null;
}

// Top-level keys of an object-literal string: `'key':` / `"key":` / `key:` at brace-depth 1. Skips Mongoose
// update operators ($set/$unset/…) and computed/nested keys ([x] / a.b / `tpl`) — those are validated by their
// first path segment where relevant, and the operator bodies are themselves object literals we do not expand.
function topLevelKeys(objText) {
	const keys = [];
	let depth = 0;
	for (let i = 0; i < objText.length; i++) {
		const ch = objText[i];
		if (ch === '{') { depth++; continue; }
		if (ch === '}') { depth--; continue; }
		if (depth !== 1) { continue; }
		// At the top level, match a key token immediately followed by a colon.
		const rest = objText.slice(i);
		const m = /^\s*(?:'([A-Za-z_$][\w$]*)'|"([A-Za-z_$][\w$]*)"|([A-Za-z_$][\w$]*))\s*:/.exec(rest);
		if (m) {
			keys.push(m[1] || m[2] || m[3]);
			i += m[0].length - 1;
		}
	}
	return keys;
}

// Collect the update/data object literal from every deal-write call. For Deals.updateOne(QUERY, UPDATE) the
// UPDATE is the SECOND brace group; for updateDeal(botId, dealId, DATA) the DATA is the first brace group
// after the call (a literal — a variable payload is skipped, its keys were hand-verified and are covered by
// list (1)).
const sites = [];
let idx;
const reUpdateOne = /Deals\.updateOne\s*\(/g;
while ((idx = reUpdateOne.exec(src)) !== null) {
	const q = readBracedObject(src, idx.index);               // query object
	if (!q) { continue; }
	const u = readBracedObject(src, q.end);                    // update object
	if (u) { sites.push(u.body); }
}
const reUpdateDeal = /[^a-zA-Z]updateDeal\s*\(/g;
while ((idx = reUpdateDeal.exec(src)) !== null) {
	// Only when a literal object is the argument (the next non-space after the call opens with '{' within the
	// same call's parens). Grab the first braced object after the call token.
	const after = src.slice(idx.index, idx.index + 400);
	if (!/\{/.test(after.split(')')[0] || '')) { continue; }   // no literal before the call closes → variable payload
	const d = readBracedObject(src, idx.index);
	if (d) { sites.push(d.body); }
}

ok(sites.length >= 8, 'static scan found the deal-write literals to validate (got ' + sites.length + ')');

const offenders = [];
for (const body of sites) {
	for (const key of topLevelKeys(body)) {
		if (key.charAt(0) === '$') { continue; }               // Mongoose operator ($set/$unset): its inner keys are paths, checked below
		if (!declared.has(key)) { offenders.push(key); }
	}
	// For a $set body, validate the FIRST path segment of each nested key (e.g. orders.0.orderId → orders).
	const setMatch = /\$set\s*:\s*\{/.exec(body);
	if (setMatch) {
		const setObj = readBracedObject(body, setMatch.index);
		if (setObj) {
			const re = /(?:'([^']+)'|"([^"]+)"|\[\s*`?orders[^]*?`?\s*\]|([A-Za-z_][\w.]*))\s*:/g;
			let mm;
			while ((mm = re.exec(setObj.body)) !== null) {
				const raw = mm[1] || mm[2] || mm[3] || '';
				const seg = String(raw).split('.')[0].replace(/[`$\[\]{}]/g, '');
				if (seg && !/^\d+$/.test(seg) && /^[A-Za-z_]/.test(seg) && !declared.has(seg) && seg !== 'orders') {
					// computed template keys like `orders.${i}.orderId` reduce to 'orders' via other means; ignore pure index/garbage
					offenders.push(seg);
				}
			}
		}
	}
}

ok(offenders.length === 0, 'every LITERAL field written to a deal is a declared schema path — undeclared: [' + Array.from(new Set(offenders)).join(', ') + ']');

console.log('DealFieldPersistence: ' + passed + ' assertions passed');
process.exit(0);
