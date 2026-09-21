'use strict';

// Pins the opt-in webhook idempotency de-dup in routes.js (webhookIdempotency). A caller may supply an
// `Idempotency-Key` header, or an `idempotency_key` / `signal_id` body field, so a repeated signal (e.g.
// TradingView's known duplicate/retry alert fires) is ignored rather than opening or funding a deal twice.
// This test locks the contract so the de-dup can never silently regress:
//   - a first-seen key is processed (duplicate:false) and the SAME key on the SAME path is then a duplicate
//   - the composite key is (path|key), so the same id sent to two different bots is NOT cross-deduped
//   - callers that send no key are entirely unaffected (duplicate:false, key:null)
//   - the built-in client's camelCase `signalId` is deliberately NOT matched (its own dedupe is untouched)
//
// The function is in-memory and shareData-free, so it is exercised directly with no DB/exchange wiring.
// process.exit(0) at the end: requiring routes.js pulls in modules that may register timers.

const assert = require('assert');
const routes = require('../../webserver/routes.js');

const webhookIdempotency = routes.webhookIdempotency;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

assert.strictEqual(typeof webhookIdempotency, 'function', 'webhookIdempotency must be exported');

// ── A supplied Idempotency-Key header dedupes on repeat ──────────────────────
const p1 = '/webhook/tv/abc';
const r1a = webhookIdempotency(p1, {}, { 'idempotency-key': 'sig-100' });
ok(r1a.duplicate === false, 'first delivery of a key is not a duplicate');
ok(r1a.key === p1 + '||sig-100', 'composite key is (path|action|key); no action → empty action segment');

const r1b = webhookIdempotency(p1, {}, { 'idempotency-key': 'sig-100' });
ok(r1b.duplicate === true, 'the same key on the same path is a duplicate');
ok(r1b.key === p1 + '||sig-100', 'duplicate reports the same composite key');

// ── Composite key is path-scoped: same id to a different bot is NOT deduped ───
const p2 = '/webhook/tv/xyz';
const r2 = webhookIdempotency(p2, {}, { 'idempotency-key': 'sig-100' });
ok(r2.duplicate === false, 'same id on a different path is not cross-deduped');
ok(r2.key === p2 + '||sig-100', 'different path yields a different composite key');

// ── Body fields are honored: idempotency_key and signal_id ───────────────────
const r3a = webhookIdempotency('/webhook/body', { idempotency_key: 'body-1' }, {});
ok(r3a.duplicate === false, 'body idempotency_key: first delivery not a duplicate');
const r3b = webhookIdempotency('/webhook/body', { idempotency_key: 'body-1' }, {});
ok(r3b.duplicate === true, 'body idempotency_key: repeat is a duplicate');

const r4a = webhookIdempotency('/webhook/sig', { signal_id: 'sid-9' }, {});
ok(r4a.duplicate === false, 'body signal_id: first delivery not a duplicate');
const r4b = webhookIdempotency('/webhook/sig', { signal_id: 'sid-9' }, {});
ok(r4b.duplicate === true, 'body signal_id: repeat is a duplicate');

// ── The header wins when both header and body keys are present ───────────────
// The composite is path|action|key; with no action in the body the action segment is empty.
const r5 = webhookIdempotency('/webhook/pref', { signal_id: 'from-body' }, { 'idempotency-key': 'from-header' });
ok(r5.key === '/webhook/pref||from-header', 'header key takes precedence over a body key (action segment empty)');

// ── The ACTION is part of the dedupe key: distinct actions with the same key do NOT collide ──
// This is the multiplexed-dispatcher fix: an "entry" then a "close" sharing one signal_id must both process.
const rActEntry = webhookIdempotency('/api/signal/botA', { action: 'entry', signal_id: 'trade-42' }, {});
ok(rActEntry.duplicate === false, 'dispatcher: entry with signal_id trade-42 is not a duplicate');
const rActClose = webhookIdempotency('/api/signal/botA', { action: 'close', signal_id: 'trade-42' }, {});
ok(rActClose.duplicate === false, 'dispatcher: a CLOSE with the same signal_id is NOT dropped as a duplicate (the fix)');
const rActEntry2 = webhookIdempotency('/api/signal/botA', { action: 'entry', signal_id: 'trade-42' }, {});
ok(rActEntry2.duplicate === true, 'dispatcher: a repeat of the SAME action+key still dedupes');
ok(rActEntry.key === '/api/signal/botA|entry|trade-42', 'the action is folded into the composite key');

// ── No key supplied → never deduped, and no state is retained ────────────────
const r6a = webhookIdempotency('/webhook/nokey', {}, {});
ok(r6a.duplicate === false && r6a.key === null, 'no key: not a duplicate, null key');
const r6b = webhookIdempotency('/webhook/nokey', {}, {});
ok(r6b.duplicate === false && r6b.key === null, 'no key: a second keyless call is still not a duplicate');

// An empty/blank key is treated as no key (trimmed to '').
const r7 = webhookIdempotency('/webhook/blank', { idempotency_key: '   ' }, {});
ok(r7.duplicate === false && r7.key === null, 'a blank/whitespace key is treated as no key');

// ── The built-in client's camelCase signalId is deliberately NOT matched ─────
const r8a = webhookIdempotency('/webhook/camel', { signalId: 'camel-1' }, {});
ok(r8a.duplicate === false && r8a.key === null, 'camelCase signalId is not used as an idempotency key');
const r8b = webhookIdempotency('/webhook/camel', { signalId: 'camel-1' }, {});
ok(r8b.duplicate === false && r8b.key === null, 'camelCase signalId: repeat still not deduped (own dedupe untouched)');

// ── A non-string key is coerced safely (no throw), and still dedupes ─────────
const r9a = webhookIdempotency('/webhook/num', { idempotency_key: 12345 }, {});
ok(r9a.duplicate === false && r9a.key === '/webhook/num||12345', 'numeric key coerced to string (empty action segment)');
const r9b = webhookIdempotency('/webhook/num', { idempotency_key: 12345 }, {});
ok(r9b.duplicate === true, 'numeric key dedupes on repeat after coercion');

// ── The seen-map is HARD-bounded: a burst of >5000 distinct live keys evicts the OLDEST, not everything ──
// Without a hard cap the map only swept EXPIRED entries, so >5000 distinct keys inside the TTL grew it past
// the cap. The eviction is oldest-first (constant TTL → insertion order == age), so a recent key stays deduped
// while a very old one is dropped and can be seen fresh again.
const capPath = '/webhook/cap';
webhookIdempotency(capPath, {}, { 'idempotency-key': 'oldest-key' });   // insert first (oldest)
for (let i = 0; i < 5200; i++) { webhookIdempotency(capPath, {}, { 'idempotency-key': 'k-' + i }); }

const oldestAgain = webhookIdempotency(capPath, {}, { 'idempotency-key': 'oldest-key' });
ok(oldestAgain.duplicate === false, 'hard cap: the oldest key was evicted under the burst, so it is seen fresh (not stuck deduped)');

const recent = webhookIdempotency(capPath, {}, { 'idempotency-key': 'k-5199' });
ok(recent.duplicate === true, 'hard cap: a recent key is still retained and deduped (eviction is oldest-first, not wholesale)');

console.log('WebhookIdempotency.test.js: ' + passed + ' assertions passed');
process.exit(0);
