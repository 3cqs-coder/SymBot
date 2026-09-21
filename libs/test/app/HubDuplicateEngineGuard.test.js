'use strict';

// Pins the money-adjacent duplicate-engine guard of the Hub supervisor (libs/app/Hub/Main.js -> isServerIdInUse).
// This one predicate is what keeps two DCA engines off a single exchange account. It must see a match whether the
// server_id is claimed by an ONLINE worker (workerMap) or by a PRE-ONLINE reservation (a worker between spawn and
// its 'online' event — the window that was previously invisible to the guard, so two rapid starts, or a
// crash-restart timer racing an explicit start, could each spawn an engine for the same account). It must also
// compare on the EFFECTIVE id (override, else root server_id) on the running-worker side, and treat a null
// effective id as never-in-use (an unconfigured/just-reset instance has no account to collide on). Pure function,
// no shareData and no real Worker — safe to call directly. Requiring Main.js has no side effects until init().

const assert = require('assert');
const Main = require('../../app/Hub/Main.js');

let passed = 0;
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ')'); passed++; }

const inUse = (id, online, pending) => Main.isServerIdInUse(id, online || [], pending || []);

// ── Online workers ───────────────────────────────────────────────────────────────
eq(inUse('acct-1', [{ instance: { server_id: 'acct-1' } }], []), true,  'matches an online worker by root server_id');
eq(inUse('acct-9', [{ instance: { server_id: 'acct-1' } }], []), false, 'no match when no online worker uses that id');

// Effective id on the running-worker side: a worker whose id comes from an OVERRIDE must be recognized (the
// bug this guards against compared only the root server_id and missed the override).
eq(inUse('ovr-1', [{ instance: { server_id: 'root-1', overrides: { server_id: 'ovr-1' } } }], []), true,
	'matches an online worker whose effective id comes from an override');
eq(inUse('root-1', [{ instance: { server_id: 'root-1', overrides: { server_id: 'ovr-1' } } }], []), false,
	'the overridden root id is NOT the effective id, so it does not match');

// ── Pre-online reservations ──────────────────────────────────────────────────────
eq(inUse('acct-2', [], [{ effectiveServerId: 'acct-2' }]), true,
	'matches a pre-online reservation (spawn->online window is not invisible)');
eq(inUse('acct-2', [], [{ effectiveServerId: 'other' }]), false,
	'no match when the reservation is for a different id');
eq(inUse('acct-3', [{ instance: { server_id: 'x' } }], [{ effectiveServerId: 'acct-3' }]), true,
	'matches across the reservation even when an unrelated worker is online');

// ── Null / absent effective id is never "in use" ──────────────────────────────────
eq(inUse(null, [{ instance: { server_id: null } }], [{ effectiveServerId: null }]), false,
	'a null effective id never collides, even against null-id workers/reservations');
eq(inUse(undefined, [], []), false, 'undefined effective id is never in use');

// ── Empty inputs ──────────────────────────────────────────────────────────────────
eq(inUse('acct-1', [], []), false, 'nothing running and nothing reserved → not in use');

console.log('HubDuplicateEngineGuard: ' + passed + ' assertions passed');
process.exit(0);
