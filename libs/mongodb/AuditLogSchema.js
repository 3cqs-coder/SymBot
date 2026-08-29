'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Append-only audit trail of who/what did each sensitive action (backlog #72). Essential for
// a financial tool: every state-changing action (start/close a deal, change settings, mint or
// revoke a key, add/re-role a user, login) is recorded with the acting principal, so an
// incident can be reconstructed. Writing is best-effort and never blocks or breaks a request
// (see Audit.audit). `server_id`-scoped like the rest.
const AuditLogSchema = new Schema({
	server_id: { type: String, default: '', index: true },
	ts:        { type: Date,   default: Date.now, index: true },
	actor:     { type: String, default: '', index: true },   // e.g. "user:owner", "apikey:symb_live_ab12", "system"
	action:    { type: String, default: '', index: true },   // dot-namespaced, e.g. "apikey.create", "deal.close", "user.login"
	target:    { type: String, default: '' },                // what was acted on (a bot id, key prefix, username, …)
	detail:    { type: String, default: '' },                // short human note
	ip:        { type: String, default: '' },
	// Tamper-evidence: each entry is a link in a per-server_id hash chain. `seq` is a monotonic
	// counter; `prev_hash` is the previous entry's hash; `hash` = SHA-256 over this entry's fields plus
	// prev_hash. Editing a field, deleting a row, or reordering breaks the chain, which the
	// audit_chain_integrity watchdog detects. Legacy rows written before this feature have no seq/hash
	// and are simply not verified (the chain starts at the first sealed entry). See Audit.js.
	seq:       { type: Number, default: null, index: true },
	prev_hash: { type: String, default: null },
	hash:      { type: String, default: null }
},
{
	collection: 'audit_log'
});

// Compound indexes matching the hot query shapes: list/prune run find({server_id}).sort({ts:-1}), and
// chain verification runs find({server_id, seq}).sort({seq:1}). Without these, those queries index-scan
// and sort in memory on a large (Hub-shared) audit_log. The single-field indexes above remain useful for
// the actor / action filters.
AuditLogSchema.index({ server_id: 1, ts: -1 });
AuditLogSchema.index({ server_id: 1, seq: 1 });

// Persisted prune checkpoint: when retention deletes the oldest (contiguous) rows, we record the seq
// and hash of the newest DELETED row here, so chain verification can resume from the surviving suffix
// (it asserts the first surviving row links to prunedThroughHash) instead of crying tamper at every
// legitimate prune. One doc per server_id.
const AuditCheckpointSchema = new Schema({
	server_id:         { type: String, default: '', unique: true, index: true },
	prunedThroughSeq:  { type: Number, default: 0 },
	prunedThroughHash: { type: String, default: '' },
	prunedAt:          { type: Date,   default: Date.now }
},
{
	collection: 'audit_checkpoint'
});

module.exports = {
	'AuditLogSchema': mongoose.model('AuditLogSchema', AuditLogSchema),
	'AuditCheckpointSchema': mongoose.model('AuditCheckpointSchema', AuditCheckpointSchema)
};
