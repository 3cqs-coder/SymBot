'use strict';

// Tests the tamper-evidence primitives of the audit trail: the per-entry hash seal (chainHash) and the
// pure chain verifier (verifyChainRows). These need no database — they exercise a hand-built chain and
// then corrupt it every way a tamperer could (edit a field, delete a row, reorder, roll the clock back,
// break a link) and assert each corruption is detected. Pruning is modelled with a checkpoint so a
// legitimately trimmed chain is proven NOT to false-alarm.

const assert = require('assert');
const Audit = require('../../app/Audit.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const GENESIS = Audit.GENESIS_HASH;

// Build a valid sealed chain of N entries starting from `checkpoint` (or genesis). Returns the rows as
// plain objects, exactly as they would come back from the DB.
function buildChain(n, checkpoint) {
	const rows = [];
	let prev = (checkpoint && checkpoint.prunedThroughHash) ? checkpoint.prunedThroughHash : GENESIS;
	let seq = (checkpoint && checkpoint.prunedThroughSeq != null) ? checkpoint.prunedThroughSeq + 1 : 1;
	let t = Date.parse('2026-01-01T00:00:00.000Z');
	for (let i = 0; i < n; i++) {
		const row = {
			server_id: 'srv1',
			ts: new Date(t + i * 1000),
			actor: 'user:owner',
			action: 'deal.close',
			target: 'bot-' + i,
			detail: 'closed deal ' + i,
			ip: '127.0.0.1',
			seq: seq,
			prev_hash: prev
		};
		row.hash = Audit.chainHash(row, prev);
		rows.push(row);
		prev = row.hash;
		seq++;
	}
	return rows;
}

// ── chainHash is deterministic and field-sensitive ──
const a = { server_id: 's', ts: new Date('2026-01-01T00:00:00Z'), actor: 'u', action: 'x', target: 't', detail: 'd', ip: 'i', seq: 1 };
ok(Audit.chainHash(a, GENESIS) === Audit.chainHash(a, GENESIS), 'chainHash is deterministic');
ok(/^[0-9a-f]{64}$/.test(Audit.chainHash(a, GENESIS)), 'chainHash returns a 64-hex SHA-256');
ok(Audit.chainHash(a, GENESIS) !== Audit.chainHash(Object.assign({}, a, { detail: 'D' }), GENESIS), 'changing a field changes the hash');
ok(Audit.chainHash(a, GENESIS) !== Audit.chainHash(a, 'ff'), 'changing prev_hash changes the hash');

// ── A clean chain verifies ──
const clean = buildChain(6);
let r = Audit.verifyChainRows(clean, null);
ok(r.ok && r.anomalies.length === 0, 'a well-formed chain verifies clean');
ok(Audit.verifyChainRows([], null).ok, 'an empty chain is trivially clean');

// ── EDIT: mutate a field without re-sealing → hash mismatch ──
let edited = buildChain(6);
edited[3].detail = 'tampered amount';
r = Audit.verifyChainRows(edited, null);
ok(!r.ok && r.anomalies.some(x => /hash mismatch at seq 4/.test(x)), 'editing an entry is detected as a hash mismatch');

// ── EDIT + RESEAL: attacker recomputes the row hash but cannot fix the NEXT row's prev_hash link ──
let resealed = buildChain(6);
resealed[3].detail = 'tampered but resealed';
resealed[3].hash = Audit.chainHash(resealed[3], resealed[3].prev_hash);   // row 4 now self-consistent
r = Audit.verifyChainRows(resealed, null);
ok(!r.ok && r.anomalies.some(x => /broken chain link at seq 5/.test(x)), 'resealing one row breaks the following link');

// ── DELETE a middle row → seq gap + broken link ──
let deleted = buildChain(6);
deleted.splice(2, 1);   // remove seq 3
r = Audit.verifyChainRows(deleted, null);
ok(!r.ok && r.anomalies.some(x => /sequence gap/.test(x)), 'deleting a row is detected as a sequence gap');

// ── REORDER two rows → broken links ──
let reordered = buildChain(6);
const tmp = reordered[2]; reordered[2] = reordered[3]; reordered[3] = tmp;
r = Audit.verifyChainRows(reordered, null);
ok(!r.ok && r.anomalies.length > 0, 'reordering rows is detected');

// ── CLOCK ROLLBACK: a backdated entry whose ts regresses against seq order ──
let rolled = buildChain(6);
rolled[4].ts = new Date(Date.parse('2020-01-01T00:00:00Z'));   // far in the past
rolled[4].hash = Audit.chainHash(rolled[4], rolled[4].prev_hash);   // reseal so only the ts anomaly shows
rolled[5].prev_hash = rolled[4].hash;                               // keep the link intact past it
rolled[5].hash = Audit.chainHash(rolled[5], rolled[5].prev_hash);
r = Audit.verifyChainRows(rolled, null);
ok(r.anomalies.some(x => /timestamp regression at seq 5/.test(x)), 'a backdated entry is detected as a timestamp regression');

// ── PRUNING: a checkpoint lets the surviving suffix verify without false alarm ──
const full = buildChain(10);
// Simulate pruning the first 4 rows: the checkpoint is the newest DELETED row (seq 4).
const boundary = full[3];
const checkpoint = { prunedThroughSeq: boundary.seq, prunedThroughHash: boundary.hash };
const survivors = full.slice(4);   // seq 5..10, each still sealed to its real predecessor
r = Audit.verifyChainRows(survivors, checkpoint);
ok(r.ok && r.anomalies.length === 0, 'a pruned chain verifies clean against its checkpoint');

// ── PRUNE LAG: checkpoint recorded but the delete crashed part-way, so rows at/below the checkpoint
// still exist alongside the live suffix. This is benign (they self-clear on the next prune) and must
// NOT be misread as a sequence gap / broken link / tamper alert. Pass the FULL chain (seq 1..10) with a
// checkpoint at seq 4 — the leftovers 1..4 are skipped and 5..10 verify clean. ──
r = Audit.verifyChainRows(full, checkpoint);
ok(r.ok && r.anomalies.length === 0, 'a prune-lag chain (checkpoint set, rows not yet deleted) verifies clean, no false tamper alert');

// ── PRUNING with a WRONG checkpoint hash → the first survivor fails to link ──
r = Audit.verifyChainRows(survivors, { prunedThroughSeq: boundary.seq, prunedThroughHash: 'deadbeef' });
ok(!r.ok && r.anomalies.some(x => /broken chain link at seq 5/.test(x)), 'a survivor that does not link to the checkpoint is detected');

// ── TRUNCATION at the tail (delete the newest rows) is silent WITHOUT an external anchor — documents the
// known limitation: the remaining prefix is internally consistent. We assert it verifies clean so the
// behavior is intentional and tested, not accidental. ──
const truncated = buildChain(6).slice(0, 4);
ok(Audit.verifyChainRows(truncated, null).ok, 'tail truncation leaves a self-consistent prefix (known limitation)');

console.log('AuditChain: ' + passed + ' assertions passed');