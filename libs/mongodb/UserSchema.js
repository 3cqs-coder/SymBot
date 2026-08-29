'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// A user account. SymBot is single-operator by default (one implicit `owner`), so this
// collection is empty on a fresh install and the current single-password login keeps
// working; users only become real records when a second person is added. Rows are
// `server_id`-scoped so, under the Hub, an instance sees only its own users.
//
// Authorization data on a user is a `role` (a named capability bundle) plus optional
// additive `grants` (extra individual capability strings) — resolved into a principal by
// Authz. `status` (active/disabled) turns a user off without deleting them. `is_initial`
// marks the seeded owner, which the self-lockout guards refuse to demote or disable.
const UserSchema = new Schema({
	user_id:       { type: String, required: true, unique: true },     // uuid
	server_id:     { type: String, default: '', index: true },
	username:      { type: String, required: true, index: true },      // unique per server_id (enforced in code)
	password_hash: { type: String, default: '' },                      // "salt:hash" (Common.genPasswordHash)
	role:          { type: String, default: 'viewer' },                // least privilege by default
	grants:        { type: [ String ], default: [] },                  // additive per-user capability strings
	status:        { type: String, enum: [ 'active', 'disabled' ], default: 'active' },
	is_initial:    { type: Boolean, default: false },                  // the seeded owner — protected from lockout
	email:         { type: String, default: '' },
	created_at:    { type: Date, default: Date.now },
	last_login_at: { type: Date, default: null }
},
{
	collection: 'users'
});

module.exports = {
	'UserSchema': mongoose.model('UserSchema', UserSchema)
};
