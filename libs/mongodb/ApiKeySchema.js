'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// A scoped API key. Replaces the single per-instance key with a collection of independent,
// individually-scoped, individually-revocable keys.
//
// Security model:
//   • The secret is NEVER stored — only `key_hash` = sha256(secret). The full key is shown
//     to the user exactly once at creation.
//   • `prefix` (e.g. "symb_live_ab12cd34ef56") is stored in the clear and indexed, so a
//     presented key is resolved with one indexed lookup, then verified with a constant-time
//     hash compare. The prefix's `symb_live_` / `symb_test_` head is also the FORMAT/version
//     discriminator: a future key format adds a new head and the resolver dispatches on it,
//     so old keys keep working — a format change is never a flag day.
//   • `capabilities` are a subset of the minting user's capabilities (a key can't exceed its
//     owner). `status` (active/disabled/revoked) lets a key be turned off without deletion.
//
// Rows are scoped by `server_id` so, under the Hub, an instance sees only its own keys.
const ApiKeySchema = new Schema({
	key_id:          { type: String, required: true, unique: true },      // uuid, stable id for revoke/audit
	server_id:       { type: String, default: '', index: true },
	prefix:          { type: String, required: true, unique: true, index: true },  // clear, indexed; e.g. symb_live_<12hex>
	key_hash:        { type: String, required: true },                    // sha256(secret) hex — secret never stored
	name:            { type: String, default: '' },                       // human label, e.g. "reporting-service"
	owner_user_id:   { type: String, default: '' },                       // who minted it (capabilities ⊆ owner's)
	capabilities:    { type: [ String ], default: [] },                   // ['bot.read','stats.read'] or ['*']
	resource_scopes: { type: Schema.Types.Mixed, default: null },         // optional per-resource limit (Phase 3)
	signing:         { type: String, enum: [ 'bearer', 'hmac' ], default: 'bearer' },  // per-key auth method
	rate_limit:      { type: Number, default: null },                     // requests/min, optional
	ip_allowlist:    { type: [ String ], default: [] },                   // optional source-IP allowlist (exact / CIDR / wildcard)
	ip_blocklist:    { type: [ String ], default: [] },                   // optional source-IP blocklist (deny wins over allow)
	status:          { type: String, enum: [ 'active', 'disabled', 'revoked' ], default: 'active' },
	is_internal:     { type: Boolean, default: false },                   // protected key SymBot provisions for its own built-in signals client
	expires_at:      { type: Date, default: null },                       // optional expiry
	rotated_to:      { type: String, default: null },                     // successor key_id when this key was rotated (this key is grace-expiring)
	rotated_from:    { type: String, default: null },                     // predecessor key_id this key succeeded
	created_at:      { type: Date, default: Date.now },
	last_used_at:    { type: Date, default: null },
	last_used_ip:    { type: String, default: '' }
},
{
	collection: 'api_keys'
});

module.exports = {
	'ApiKeySchema': mongoose.model('ApiKeySchema', ApiKeySchema)
};
