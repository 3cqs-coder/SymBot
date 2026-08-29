'use strict';

// ── Users — accounts, roles, and the login identity ──────────────────────────
//
// SymBot is single-operator by default: this collection is empty on a fresh install, the
// current single-password login keeps working, and that session is treated as the implicit
// `owner` (see the enforcement seam). Users become real records only when a second person is
// added. Password hashing reuses Common.genPasswordHash / verifyPasswordHash so the seeded
// owner's existing hash (today's app.json password) stays valid unchanged.
//
// Roles are least-privilege by default; the self-lockout guards (pure functions below, so
// they're unit-tested) refuse to demote or disable the initial owner or the last active
// owner, so an install can never lock itself out.

const crypto = require('crypto');
const Authz = require('./Authz.js');

let shareData;

let log = function () {};   // assigned in init() via Common.makeLogger
function model() { return require('../mongodb/UserSchema.js').UserSchema; }
function serverId() { return (shareData && shareData.appData && shareData.appData.server_id) || ''; }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }


// ── Pure guards (unit-tested; take a plain user list) ─────────────────────────

function activeOwners(users) { return (users || []).filter(u => u.status === 'active' && u.role === 'owner'); }

// Whether a role change is allowed without orphaning ownership. Single exit.
function guardRoleChange(users, targetId, newRole) {
	let result = { ok: true };
	const target = (users || []).find(u => u.user_id === targetId);
	if (!target) { result = { ok: false, error: 'User not found' }; }
	else if (target.is_initial && newRole !== 'owner') { result = { ok: false, error: 'The initial owner cannot be demoted' }; }
	else if (target.role === 'owner' && newRole !== 'owner' && activeOwners(users).length <= 1) { result = { ok: false, error: 'Cannot demote the last remaining owner' }; }
	return result;
}

// Whether a status change is allowed without disabling the last/only owner. Single exit.
function guardStatusChange(users, targetId, newStatus) {
	let result = { ok: true };
	const target = (users || []).find(u => u.user_id === targetId);
	if (!target) { result = { ok: false, error: 'User not found' }; }
	else if (target.is_initial && newStatus !== 'active') { result = { ok: false, error: 'The initial owner cannot be disabled' }; }
	else if (target.role === 'owner' && newStatus !== 'active' && activeOwners(users).length <= 1) { result = { ok: false, error: 'Cannot disable the last remaining owner' }; }
	return result;
}

// Normalize a requested role to a known one, defaulting to least privilege. Single exit.
function normalizeRole(role) { return Authz.ROLE_NAMES.indexOf(role) >= 0 ? role : Authz.DEFAULT_ROLE; }

// Safe projection — never the password hash. Single exit.
function publicView(u) {
	if (!u) { return null; }
	return {
		user_id: u.user_id, username: u.username, role: u.role,
		grants: Array.isArray(u.grants) ? u.grants.slice() : [],
		status: u.status || 'active', is_initial: !!u.is_initial,
		email: u.email || '', created_at: u.created_at || null, last_login_at: u.last_login_at || null
	};
}

// Turn a user record into an Authz principal (role + additive grants). Single exit.
function toPrincipal(u) {
	if (!u) { return null; }
	return Authz.makePrincipal({ id: u.user_id, kind: 'user', role: u.role, grants: u.grants || [] });
}


// ── DB-backed operations ─────────────────────────────────────────────────────

async function hashPassword(password) {
	// A human password is hashed at the strong PBKDF2 factor (600k). verifyPasswordHash tries that factor
	// first and falls back to the legacy factor, so a hash written before this change still verifies.
	const d = await shareData.Common.genPasswordHash({ data: password, iterations: 600000 });
	return d.salt + ':' + d.hash;
}

// Count real user records for this instance (0 = still single-operator / implicit owner).
async function count() {
	let n = 0;
	try { n = await model().countDocuments({ server_id: serverId() }); } catch (e) { n = 0; }
	return n;
}

// Seed the initial owner. `passwordHash` may be an existing "salt:hash" (migrate today's
// app.json password unchanged) OR a plaintext `password` can be given to hash. Idempotent:
// does nothing if an initial owner already exists. Single exit.
async function seedOwner(opts) {
	opts = opts || {};
	let result = { success: false };
	try {
		const existing = await model().findOne({ server_id: serverId(), is_initial: true });
		if (existing) { result = { success: true, seeded: false, user: publicView(existing) }; }
		else {
			const password_hash = opts.passwordHash || (opts.password ? await hashPassword(opts.password) : '');
			const row = await model().create({
				user_id: uuid(), server_id: serverId(),
				username: (opts.username || 'owner').toString().trim() || 'owner',
				password_hash, role: 'owner', is_initial: true, status: 'active', created_at: new Date()
			});
			log('seeded initial owner "' + row.username + '"');
			result = { success: true, seeded: true, user: publicView(row) };
		}
	}
	catch (e) { log('seedOwner failed: ' + e.message); result = { success: false, error: e.message }; }
	return result;
}

// Create a user (least-privilege default). Rejects a duplicate username. Single exit.
async function create(opts) {
	opts = opts || {};
	let result = { success: false, error: 'Username and password are required' };
	const username = (opts.username || '').toString().trim();
	if (username && opts.password) {
		try {
			const dupe = await model().findOne({ server_id: serverId(), username });
			if (dupe) { result = { success: false, error: 'Username already exists' }; }
			else {
				const row = await model().create({
					user_id: uuid(), server_id: serverId(), username,
					password_hash: await hashPassword(opts.password),
					role: normalizeRole(opts.role), grants: Array.isArray(opts.grants) ? opts.grants : [],
					status: 'active', created_at: new Date()
				});
				log('created user "' + username + '" (' + row.role + ')');
				result = { success: true, user: publicView(row) };
			}
		}
		catch (e) { result = { success: false, error: e.message }; }
	}
	return result;
}

// Authenticate a username + password → the user record, or null. Constant-time verify via
// Common.verifyPasswordHash. Touches last_login on success. Never throws. Single exit.
async function authenticate(username, password) {
	let user = null;
	try {
		const row = await model().findOne({ server_id: serverId(), username: (username || '').toString().trim(), status: 'active' });
		if (row && row.password_hash) {
			const [ salt, hash ] = row.password_hash.split(':');
			const ok = await shareData.Common.verifyPasswordHash({ salt, hash, data: password });
			if (ok) {
				model().updateOne({ user_id: row.user_id }, { last_login_at: new Date() }).catch(() => {});
				user = row;
			}
		}
	}
	catch (e) { log('authenticate failed: ' + e.message); user = null; }
	return user;
}

async function getById(userId) { try { return await model().findOne({ user_id: userId, server_id: serverId() }); } catch (e) { return null; } }
async function listRaw() { try { return await model().find({ server_id: serverId() }); } catch (e) { return []; } }
async function list() { return (await listRaw()).map(publicView); }

async function setRole(userId, role) {
	const guard = guardRoleChange((await listRaw()).map(u => u.toObject ? u.toObject() : u), userId, role);
	if (!guard.ok) { return { success: false, error: guard.error }; }
	try { await model().updateOne({ user_id: userId, server_id: serverId() }, { role: normalizeRole(role) }); return { success: true }; }
	catch (e) { return { success: false, error: e.message }; }
}

async function setStatus(userId, status) {
	const guard = guardStatusChange((await listRaw()).map(u => u.toObject ? u.toObject() : u), userId, status);
	if (!guard.ok) { return { success: false, error: guard.error }; }
	try { await model().updateOne({ user_id: userId, server_id: serverId() }, { status: status === 'disabled' ? 'disabled' : 'active' }); return { success: true }; }
	catch (e) { return { success: false, error: e.message }; }
}


module.exports = {
	init: function (obj) { shareData = obj; log = obj.Common.makeLogger('Users: '); },
	// pure (tested)
	activeOwners, guardRoleChange, guardStatusChange, normalizeRole, publicView, toPrincipal,
	// db-backed
	count, seedOwner, create, authenticate, getById, list, listRaw, setRole, setStatus
};