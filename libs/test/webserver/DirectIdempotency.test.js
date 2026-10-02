'use strict';

// Pins the Tier 2 safe-retry idempotency on the DIRECT deal-start / add-funds REST endpoints
// (directIdempotencyDuplicate in routes.js). The webhook path already dedupes replayed alerts; these direct
// /api/... endpoints did not, so a retried request (after a network timeout) could open or fund a deal twice.
// This locks the contract: a repeated Idempotency-Key on the SAME path is reported as a duplicate (and the
// route returns without dispatching to the money path); the key is keyed per-path so two different deals never
// collide; and a caller that sends no key is unaffected.
//
// process.exit(0) at the end: requiring routes.js pulls in modules that may register timers.

const assert = require('assert');
const routes = require('../../webserver/routes.js');

const directIdempotencyDuplicate = routes.directIdempotencyDuplicate;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

assert.strictEqual(typeof directIdempotencyDuplicate, 'function', 'directIdempotencyDuplicate must be exported');

function mockRes() {
	return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, send(o) { this.body = o; return this; } };
}

// ── First delivery of a key is NOT a duplicate; the route proceeds (no response sent here) ──
{
	const res = mockRes();
	const dup = directIdempotencyDuplicate({ path: '/api/deals/D1/add_funds', body: {}, headers: { 'idempotency-key': 'k-add-1' } }, res);
	ok(dup === false, 'first delivery of a key is not a duplicate');
	ok(res.body === null, 'no response is sent on the first delivery (the route dispatches)');
}

// ── The SAME key on the SAME path IS a duplicate; a 200 duplicate is sent and the route must not dispatch ──
{
	const res = mockRes();
	const dup = directIdempotencyDuplicate({ path: '/api/deals/D1/add_funds', body: {}, headers: { 'idempotency-key': 'k-add-1' } }, res);
	ok(dup === true, 'the same key on the same path is a duplicate');
	ok(res.statusCode === 200 && res.body && res.body.duplicate === true, 'a 200 duplicate response is sent');
}

// ── The SAME key on a DIFFERENT path is NOT cross-deduped (per-path keying) ──
{
	const res = mockRes();
	const dup = directIdempotencyDuplicate({ path: '/api/deals/D2/add_funds', body: {}, headers: { 'idempotency-key': 'k-add-1' } }, res);
	ok(dup === false, 'the same key on a different deal path is not a duplicate');
}

// ── The body idempotency_key form works and dedupes on repeat ──
{
	const first = directIdempotencyDuplicate({ path: '/api/bots/B1/start_deal', body: { idempotency_key: 'start-1' }, headers: {} }, mockRes());
	const second = directIdempotencyDuplicate({ path: '/api/bots/B1/start_deal', body: { idempotency_key: 'start-1' }, headers: {} }, mockRes());
	ok(first === false && second === true, 'an idempotency_key body field dedupes a retried start_deal');
}

// ── A caller that sends NO key is never a duplicate (unaffected) ──
{
	const a = directIdempotencyDuplicate({ path: '/api/deals/D3/add_funds', body: {}, headers: {} }, mockRes());
	const b = directIdempotencyDuplicate({ path: '/api/deals/D3/add_funds', body: {}, headers: {} }, mockRes());
	ok(a === false && b === false, 'no idempotency key → never deduped, existing behavior unchanged');
}

// ── Outcome-aware: a FAILED first attempt releases the key so a genuine retry RE-ATTEMPTS (not masked) ──
{
	const res1 = mockRes();
	const first = directIdempotencyDuplicate({ path: '/api/bots/B9/start_deal', body: { idempotency_key: 'k-fail' }, headers: {} }, res1);
	ok(first === false, 'first attempt is not a duplicate (dispatches)');
	// Simulate the handler failing (e.g. a transient exchange error) — the wrapped send must release the key.
	res1.send({ success: false, data: 'exchange error' });
	const retry = directIdempotencyDuplicate({ path: '/api/bots/B9/start_deal', body: { idempotency_key: 'k-fail' }, headers: {} }, mockRes());
	ok(retry === false, 'after a FAILED first attempt, a retry with the same key re-attempts (not a false duplicate)');
}

// ── Outcome-aware: a SUCCESSFUL first attempt keeps the key, so a real retry is still deduped ──
{
	const res1 = mockRes();
	const first = directIdempotencyDuplicate({ path: '/api/bots/B10/start_deal', body: { idempotency_key: 'k-ok' }, headers: {} }, res1);
	ok(first === false, 'first attempt is not a duplicate');
	res1.send({ success: true, data: 'started' });   // success keeps the key
	const retry = directIdempotencyDuplicate({ path: '/api/bots/B10/start_deal', body: { idempotency_key: 'k-ok' }, headers: {} }, mockRes());
	ok(retry === true, 'after a SUCCESSFUL first attempt, a retry with the same key is deduped');
}

console.log('DirectIdempotency: ' + passed + ' assertions passed');
process.exit(0);
