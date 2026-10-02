'use strict';

// Pins the opt-in webhook staleness guard in routes.js (webhookStaleness). A caller may stamp a signal with a
// `timestamp` (body field or `X-Signal-Timestamp` header); when a positive max-age is configured, a signal
// older than the window (or too far in the future) is rejected, so a delayed relay or a replayed alert cannot
// fire late. This test locks the contract so the guard can never silently regress or start dropping real
// signals:
//   - it is DISABLED when max-age is 0/absent (never stale), and OPT-OUT per request when no timestamp is sent
//   - a fresh timestamp passes; one older than max-age is stale; one too far in the future is stale
//   - a small future skew is tolerated (benign clock drift)
//   - epoch seconds AND milliseconds are both accepted; the header form works
//   - an unparseable timestamp fails OPEN (never drops a real signal)
//
// The function is pure and shareData-free, so it is exercised directly. process.exit(0) at the end: requiring
// routes.js pulls in modules that may register timers.

const assert = require('assert');
const routes = require('../../webserver/routes.js');

const webhookStaleness = routes.webhookStaleness;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

assert.strictEqual(typeof webhookStaleness, 'function', 'webhookStaleness must be exported');

const nowSec = Math.floor(Date.now() / 1000);
const MAX = 300;   // 5-minute window

// ── Disabled: max-age 0/absent means never stale, even for an ancient timestamp ──
ok(webhookStaleness({ timestamp: 1 }, {}, 0).stale === false, 'max-age 0 disables the guard');
ok(webhookStaleness({ timestamp: 1 }, {}, undefined).stale === false, 'absent max-age disables the guard');

// ── Opt-out per request: no timestamp supplied is never stale, even with a window ──
ok(webhookStaleness({}, {}, MAX).stale === false, 'no timestamp → not stale (opt-out)');
ok(webhookStaleness({ timestamp: '' }, {}, MAX).stale === false, 'empty timestamp → not stale');

// ── Fresh timestamp passes ──
ok(webhookStaleness({ timestamp: nowSec }, {}, MAX).stale === false, 'a fresh timestamp passes');
ok(webhookStaleness({ timestamp: nowSec - 10 }, {}, MAX).stale === false, 'within the window passes');

// ── Stale timestamp is rejected ──
const old = webhookStaleness({ timestamp: nowSec - (2 * MAX) }, {}, MAX);
ok(old.stale === true && old.reason === 'too_old', 'older than max-age is stale (too_old)');

// ── Future timestamp beyond skew is rejected; within skew is tolerated ──
const future = webhookStaleness({ timestamp: nowSec + 600 }, {}, MAX);
ok(future.stale === true && future.reason === 'future', 'a far-future timestamp is stale (future)');
ok(webhookStaleness({ timestamp: nowSec + 30 }, {}, MAX).stale === false, 'a small future skew is tolerated');

// ── Milliseconds are accepted and normalized ──
ok(webhookStaleness({ timestamp: Date.now() }, {}, MAX).stale === false, 'a fresh millisecond timestamp passes');
ok(webhookStaleness({ timestamp: Date.now() - (2 * MAX * 1000) }, {}, MAX).stale === true, 'a stale millisecond timestamp is rejected');

// ── The header form works ──
ok(webhookStaleness({}, { 'x-signal-timestamp': String(nowSec - (2 * MAX)) }, MAX).stale === true, 'X-Signal-Timestamp header is read');
ok(webhookStaleness({}, { 'x-signal-timestamp': String(nowSec) }, MAX).stale === false, 'a fresh header timestamp passes');

// ── An unparseable timestamp fails OPEN (never drops a real signal) ──
ok(webhookStaleness({ timestamp: 'not-a-number' }, {}, MAX).stale === false, 'a garbage timestamp fails open');
ok(webhookStaleness({ timestamp: {} }, {}, MAX).stale === false, 'a non-primitive timestamp fails open');

console.log('WebhookStaleness: ' + passed + ' assertions passed');
process.exit(0);
