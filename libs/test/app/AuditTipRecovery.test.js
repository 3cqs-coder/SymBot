'use strict';

// Pins the audit chain-tip recovery in libs/app/Audit.js (ensureTip). The audit hash chain is the exact
// invariant the audit_chain_integrity watchdog protects, so a self-inflicted false tamper alarm is a real cost.
// If the DB is briefly unavailable at the FIRST audit for a server_id, ensureTip must NOT permanently memoize a
// genesis tip — otherwise, once the DB recovers, writeChained would resume at seq 1 over already-sealed rows
// (duplicate seqs the verifier flags as tampering). This drives writeChained directly with a fake model whose
// tip load fails once and then succeeds, and asserts the second write reloads the REAL tip instead of resuming
// from genesis. We patch the schema module's export in the require cache before requiring Audit (model() reads
// it per call, so the fake is picked up).

const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');

let passed = 0;
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ')'); passed++; }

// ── Fake model: a chainable findOne().sort().select() whose resolution we control, plus a create() that records.
let tipBehavior;   // () => Promise resolving to the "last sealed row" (or rejecting)
const created = [];

function makeQuery(resultFn) {
	const q = {};
	q.sort = () => q;
	q.select = () => resultFn();   // the awaited value (or rejection)
	return q;
}

function FakeModel() {}
FakeModel.findOne = () => makeQuery(tipBehavior);
FakeModel.create = async (doc) => { created.push(doc); return doc; };

const schemaMod = require(root + '/libs/mongodb/AuditLogSchema.js');
schemaMod.AuditLogSchema = FakeModel;

const Audit = require(root + '/libs/app/Audit.js');
Audit.init({ appData: { server_id: 'srv-1' } });

(async () => {

	// writeChained mutates the doc in place (seq/prev_hash/hash), so we inspect the object we passed in.

	// 1) First audit for this server_id while the tip load FAILS (transient DB error at that instant).
	tipBehavior = () => Promise.reject(new Error('db down'));
	const d1 = { server_id: 'srv-1', ts: new Date(), actor: 'sys', action: 'a1', target: '', detail: '', ip: '' };
	await Audit.writeChained(d1);
	eq(d1.seq, 1, 'during the outage the tip falls back to genesis, so this write seals at seq 1');

	// 2) DB has recovered and there are already sealed rows up to seq 5. Because the failed load was NOT
	//    memoized, the next write must RELOAD the real tip and resume at seq 6 — not seq 2.
	tipBehavior = () => Promise.resolve({ seq: 5, hash: 'H5'.padEnd(64, '5') });
	const d2 = { server_id: 'srv-1', ts: new Date(), actor: 'sys', action: 'a2', target: '', detail: '', ip: '' };
	await Audit.writeChained(d2);
	eq(d2.seq, 6, 'after recovery the real tip is reloaded (seq 6), not resumed from a memoized genesis (would be seq 2)');
	eq(d2.prev_hash, 'H5'.padEnd(64, '5'), 'the reloaded tip hash is used as prev_hash, keeping the chain linked');

	// 3) A subsequent write now uses the in-memory tip (no reload needed) and advances by one.
	const d3 = { server_id: 'srv-1', ts: new Date(), actor: 'sys', action: 'a3', target: '', detail: '', ip: '' };
	await Audit.writeChained(d3);
	eq(d3.seq, 7, 'the next write advances from the recovered tip (seq 7)');

	console.log('AuditTipRecovery: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('AuditTipRecovery test error:', e && e.stack || e); process.exit(1); });
