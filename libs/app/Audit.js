'use strict';

// ── Audit — never-throwing, TAMPER-EVIDENT audit trail ───────────────────────
//
// audit(actor, action, target, detail, ip) records a sensitive action. It is deliberately
// fire-and-forget and swallows every error: an audit-write failure must NEVER break the request it is
// auditing (which may be on the trading path). `actor` may be an Express request (the acting principal
// + client IP are derived from it), an Authz principal, or a plain string. Actions are dot-namespaced
// ("apikey.create", "deal.close", "user.login").
//
// TAMPER-EVIDENCE: each entry is a link in a per-server_id hash chain — `hash = SHA-256(fields ||
// prev_hash)` with a monotonic `seq`. Editing a field, deleting a row, or reordering breaks the chain,
// which the `audit_chain_integrity` watchdog detects at boot (warn-only). This is detection, not
// prevention (a hash chain makes tampering evident, not impossible). Writes are serialized through one
// in-process queue so seq/prev_hash are assigned in order without a race, but the caller never awaits —
// chaining lives entirely off the money path and degrades to an unchained row on any failure.

const crypto = require('crypto');

let shareData;

function model() { return require('../mongodb/AuditLogSchema.js').AuditLogSchema; }
function checkpointModel() { return require('../mongodb/AuditLogSchema.js').AuditCheckpointSchema; }
function serverId() { return (shareData && shareData.appData && shareData.appData.server_id) || ''; }

const GENESIS_HASH = '0'.repeat(64);
const CHAIN_SEP = '\x1f';   // unit separator — will not appear in the free-text fields


// ── Pure chain primitives (no DB — exported for testing) ─────────────────────

// Deterministic hash of one entry sealed to the previous hash. Field order is fixed and the timestamp
// is normalized to ISO so the same logical entry always hashes identically. Single exit.
function chainHash(entry, prevHash) {
	entry = entry || {};
	const parts = [
		String(entry.server_id == null ? '' : entry.server_id),
		String(entry.seq == null ? '' : entry.seq),
		(function () { try { return new Date(entry.ts).toISOString(); } catch (e) { return ''; } })(),
		String(entry.actor == null ? '' : entry.actor),
		String(entry.action == null ? '' : entry.action),
		String(entry.target == null ? '' : entry.target),
		String(entry.detail == null ? '' : entry.detail),
		String(entry.ip == null ? '' : entry.ip),
		String(prevHash == null ? '' : prevHash)
	];
	return crypto.createHash('sha256').update(parts.join(CHAIN_SEP)).digest('hex');
}

// Verify a run of sealed rows (sorted by seq ascending; each a plain object with the chain fields),
// starting from `checkpoint` ({ prunedThroughSeq, prunedThroughHash } or null/undefined). Returns
// { ok, anomalies }. Detects: EDIT (recomputed hash ≠ stored), DELETION/REORDER (prev_hash break or
// seq gap), and CLOCK ROLLBACK (ts regresses vs seq order). Pure — exported for testing. Single exit.
function verifyChainRows(rows, checkpoint) {
	const anomalies = [];
	rows = Array.isArray(rows) ? rows : [];

	if (rows.length) {
		const prunedSeq = (checkpoint && checkpoint.prunedThroughSeq != null) ? Number(checkpoint.prunedThroughSeq) : null;
		let expectedPrev = (checkpoint && checkpoint.prunedThroughHash) ? String(checkpoint.prunedThroughHash) : GENESIS_HASH;
		let expectedSeq = (prunedSeq != null)
			? prunedSeq + 1
			: Number(rows[0].seq);   // no checkpoint ⇒ the chain simply begins at the first sealed row
		let lastTs = 0;

		for (const r of rows) {
			const seq = Number(r.seq);

			// Prune records the checkpoint BEFORE it deletes the rows it covers, so a crash (or a
			// partial deleteMany) between the two can leave rows at or below prunedThroughSeq still
			// present at the next boot. That is a benign prune LAG, not tampering: the live chain
			// legitimately resumes at prunedThroughSeq + 1, and these leftovers self-clear on the next
			// successful prune. Skip them so they are not misread as a sequence gap / broken link.
			if (prunedSeq != null && seq <= prunedSeq) { continue; }

			if (seq !== expectedSeq) {
				anomalies.push('sequence gap before seq ' + seq + ' (expected ' + expectedSeq + ') — row(s) may have been deleted');
				expectedSeq = seq;   // resync so a single deletion reports once, not a cascade
			}
			if (String(r.prev_hash) !== expectedPrev) {
				anomalies.push('broken chain link at seq ' + seq + ' — prev_hash does not match the preceding entry (deletion or reorder)');
			}
			if (String(r.hash) !== chainHash(r, r.prev_hash)) {
				anomalies.push('hash mismatch at seq ' + seq + ' — the entry was altered after it was written');
			}
			const ts = new Date(r.ts).getTime();
			if (isFinite(ts) && ts + 1000 < lastTs) {   // 1s grace for same-second ordering
				anomalies.push('timestamp regression at seq ' + seq + ' — clock rollback or a backdated entry');
			}
			if (isFinite(ts)) { lastTs = ts; }

			expectedPrev = String(r.hash);
			expectedSeq = seq + 1;
		}
	}

	return { ok: anomalies.length === 0, anomalies: anomalies };
}


// ── Actor / IP resolution (unchanged) ────────────────────────────────────────

function resolveActor(actor) {
	let out = 'system';
	if (typeof actor === 'string') {
		out = actor || 'system';
	}
	else if (actor && typeof actor === 'object') {
		const p = actor.principal || (actor.kind ? actor : null);   // a req, or a principal itself
		if (p) {
			if (p.kind === 'apikey') { out = 'apikey:' + (p.apiKeyId || p.id || '?'); }
			else { out = 'user:' + (p.id || 'owner'); }
		}
		else if (actor.session && actor.session.loggedIn) { out = 'user:owner'; }   // legacy implicit owner
		else { out = 'anonymous'; }
	}
	return out;
}

function resolveIp(actor, ipArg) {
	let ip = ipArg || '';
	if (!ip && actor && typeof actor === 'object') {
		const common = shareData && shareData.Common;
		if (common && typeof common.getClientIp === 'function') {
			ip = common.getClientIp(actor) || '';
		}
		else if (actor.headers) {
			ip = actor.headers['cf-connecting-ip']
				|| (actor.headers['x-forwarded-for'] || '').split(',')[0].trim()
				|| actor.ip || (actor.connection && actor.connection.remoteAddress) || '';
		}
	}
	if (typeof ip === 'string' && ip.startsWith('::ffff:')) { ip = ip.substring(7); }
	if (ip === '::1') { ip = '127.0.0.1'; }   // IPv6 loopback → IPv4 loopback, consistent with getClientIp
	return ip;
}


// ── Chained write (serialized, fire-and-forget) ──────────────────────────────

let chainTip = {};   // sid -> { seq, hash } — the in-memory head of each server_id's chain
let tipReady = {};   // sid -> Promise (loads the tip from the DB exactly once)
let writeQueue = Promise.resolve();   // the single serializer: assigns seq/prev_hash in order

// Load the current chain tip for a server_id once (highest sealed seq). Never throws.
async function ensureTip(sid) {
	if (!tipReady[sid]) {
		tipReady[sid] = (async () => {
			try {
				const last = await model().findOne({ server_id: sid, seq: { $ne: null } }).sort({ seq: -1 }).select({ seq: 1, hash: 1 });
				chainTip[sid] = (last && last.seq != null) ? { seq: Number(last.seq), hash: String(last.hash || GENESIS_HASH) } : { seq: 0, hash: GENESIS_HASH };
			}
			catch (e) { chainTip[sid] = { seq: 0, hash: GENESIS_HASH }; }
		})();
	}
	await tipReady[sid];
}

// Seal and persist one entry, advancing the chain. Never throws — on any failure the action is still
// recorded UNCHAINED (no seq/hash), which the verifier treats as a benign coverage gap, not tampering.
async function writeChained(doc) {
	const sid = doc.server_id;
	try {
		await ensureTip(sid);
		const tip = chainTip[sid] || { seq: 0, hash: GENESIS_HASH };
		doc.seq = tip.seq + 1;
		doc.prev_hash = tip.hash;
		doc.hash = chainHash(doc, tip.hash);
		await model().create(doc);
		chainTip[sid] = { seq: doc.seq, hash: doc.hash };
	}
	catch (e) {
		try {
			const bare = { server_id: doc.server_id, ts: doc.ts, actor: doc.actor, action: doc.action, target: doc.target, detail: doc.detail, ip: doc.ip };
			const p = model().create(bare); if (p && p.catch) { p.catch(() => {}); }
		}
		catch (_) {}
	}
}


// ── Retention with a prune checkpoint ────────────────────────────────────────

const MAX_AUDIT_ROWS = 10000;
const PRUNE_EVERY = 250;
let auditWriteCount = 0;

// Keep the newest MAX_AUDIT_ROWS per server_id; before deleting the oldest rows, record the newest
// SEALED row being pruned as a checkpoint so chain verification resumes from the surviving suffix
// instead of flagging every legitimate prune. Fire-and-forget; never throws.
async function pruneAudit() {
	try {
		const sid = serverId();
		const anchor = await model().find({ server_id: sid }).sort({ ts: -1 }).skip(MAX_AUDIT_ROWS).limit(1).select({ ts: 1 });
		if (anchor && anchor.length && anchor[0] && anchor[0].ts) {
			const cutoff = anchor[0].ts;
			// The newest sealed row that will be deleted becomes the checkpoint (its successor must link to it).
			const boundary = await model().findOne({ server_id: sid, ts: { $lt: cutoff }, seq: { $ne: null } }).sort({ seq: -1 }).select({ seq: 1, hash: 1 });
			if (boundary && boundary.seq != null && boundary.hash) {
				try { await checkpointModel().findOneAndUpdate({ server_id: sid }, { $set: { prunedThroughSeq: Number(boundary.seq), prunedThroughHash: String(boundary.hash), prunedAt: new Date() } }, { upsert: true }); }
				catch (e) { /* checkpoint best-effort */ }
			}
			await model().deleteMany({ server_id: sid, ts: { $lt: cutoff } });
		}
	}
	catch (e) { /* pruning must never break anything */ }
}


// ── Public record + read ─────────────────────────────────────────────────────

// Record an action. Never throws, never blocks the caller — the seal + write run in the background
// serializer. Single exit.
function audit(actor, action, target, detail, ip) {
	try {
		const doc = {
			server_id: serverId(),
			ts: new Date(),
			actor: resolveActor(actor),
			action: String(action || ''),
			target: String(target || ''),
			detail: String(detail || '').slice(0, 500),
			ip: resolveIp(actor, ip)
		};
		// Enqueue on the single serializer so seq/prev_hash are assigned in order (no race). The caller
		// never awaits this: auditing stays fire-and-forget and off the money path.
		writeQueue = writeQueue.then(() => writeChained(doc)).catch(() => {});

		if ((++auditWriteCount % PRUNE_EVERY) === 0) { const pr = pruneAudit(); if (pr && typeof pr.catch === 'function') { pr.catch(() => {}); } }
	}
	catch (e) { /* auditing must never break a request */ }
	return true;
}

// DB-backed chain verification for a server_id (defaults to this instance). Reads the checkpoint and all
// sealed rows, then delegates to the pure verifier. Never throws — if it cannot read, it reports OK
// (absence of a readable chain is not proof of tampering). Single exit.
async function verifyChain(sid) {
	sid = (sid == null) ? serverId() : sid;
	let out = { ok: true, anomalies: [], checked: 0 };
	try {
		const checkpoint = await checkpointModel().findOne({ server_id: sid }).select({ prunedThroughSeq: 1, prunedThroughHash: 1 });
		const rows = await model().find({ server_id: sid, seq: { $ne: null } }).sort({ seq: 1 })
			.select({ server_id: 1, ts: 1, actor: 1, action: 1, target: 1, detail: 1, ip: 1, seq: 1, prev_hash: 1, hash: 1 });
		const plain = (rows || []).map(r => ({ server_id: r.server_id, ts: r.ts, actor: r.actor, action: r.action, target: r.target, detail: r.detail, ip: r.ip, seq: r.seq, prev_hash: r.prev_hash, hash: r.hash }));
		out = Object.assign({ checked: plain.length }, verifyChainRows(plain, checkpoint));
	}
	catch (e) { out = { ok: true, anomalies: [], checked: 0, error: e.message }; }
	return out;
}

// Filterable read for the audit UI. Options: { action, actor, since (Date|ms), limit }. Never throws.
async function list(opts) {
	opts = opts || {};
	let rows = [];
	try {
		const q = { server_id: serverId() };
		if (opts.action) { q.action = new RegExp('^' + String(opts.action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
		if (opts.actor)  { q.actor = new RegExp(String(opts.actor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
		if (opts.since)  { q.ts = { $gte: new Date(opts.since) }; }
		const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 1000);
		rows = await model().find(q).sort({ ts: -1 }).limit(limit);
	}
	catch (e) { rows = []; }
	return rows.map(r => ({ ts: r.ts, actor: r.actor, action: r.action, target: r.target, detail: r.detail, ip: r.ip }));
}


module.exports = {
	init: function (obj) {
		shareData = obj;
		// Register the tamper-evidence watchdog: verify the audit hash chain at boot and warn (never
		// block) on any anomaly. Recorded to the audit log itself like the other checks — that write goes
		// through the normal chained path, so it extends the chain rather than looking like an anomaly.
		if (obj && obj.Watchdog && typeof obj.Watchdog.register === 'function') {
			obj.Watchdog.register('audit_chain_integrity', async function () {
				const r = await verifyChain(serverId());
				if (r && Array.isArray(r.anomalies) && r.anomalies.length) {
					const shown = r.anomalies.slice(0, 5).join('; ') + (r.anomalies.length > 5 ? '; …' : '');
					return { action: 'watchdog.audit_tampering', target: String(r.anomalies.length), detail: 'audit-log integrity check FAILED over ' + r.checked + ' sealed entries: ' + shown };
				}
				return null;
			});
		}
	},
	resolveActor,
	resolveIp,
	audit,
	list,
	// Tamper-evidence (exported for the watchdog + tests)
	chainHash,
	verifyChainRows,
	verifyChain,
	GENESIS_HASH
};