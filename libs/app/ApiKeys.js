'use strict';

// ── ApiKeys — multiple scoped API keys ───────────────────────────────────────
//
// Generates, stores, and resolves scoped API keys (see libs/mongodb/ApiKeySchema.js). The pure
// helpers (generate / parseKey / scopeCapabilities / secretMatchesHash / publicView) have no DB
// dependency and are unit-tested directly; the async methods (create / resolve / list / revoke /
// setStatus / provisionInternal) use the api_keys collection.
//
// Key shape:  symb_live_<12 hex prefix>_<64 hex secret>
//   • "symb_live_" (or "symb_test_") is the environment + FORMAT discriminator — parseKey
//     dispatches on it, so adding a new format later never breaks existing keys.
//   • the 12-hex prefix is stored clear + indexed for an O(1) lookup;
//   • only sha256(secret) is stored — the secret is shown once and never persisted.

const crypto = require('crypto');
const Authz = require('./Authz.js');
const IpFilter = require('./IpFilter.js');

let shareData;

// Recognized environment/format heads. To evolve the format, add a new head here and branch
// in parseKey — old keys (old head) keep resolving.
const KEY_HEADS = [ 'symb_live_', 'symb_test_' ];
const DEFAULT_HEAD = 'symb_live_';


let log = function () {};   // assigned in init() via Common.makeLogger

function model() { return require('../mongodb/ApiKeySchema.js').ApiKeySchema; }

function serverId() { return (shareData && shareData.appData && shareData.appData.server_id) || ''; }

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }


// ── Pure helpers (no DB) ─────────────────────────────────────────────────────

// Generate a fresh key. Returns { prefix, secret, clearKey } — clearKey is shown ONCE and
// never stored; only sha256(secret) is persisted. Single exit.
function generate(head) {
	const h = KEY_HEADS.indexOf(head) >= 0 ? head : DEFAULT_HEAD;
	const prefixRand = crypto.randomBytes(6).toString('hex');   // 12 hex — the lookup handle
	const secret = crypto.randomBytes(32).toString('hex');       // 64 hex — high entropy
	const prefix = h + prefixRand;
	return { prefix, secret, clearKey: prefix + '_' + secret };
}

// Parse a presented key into { prefix, secret } by dispatching on its format head. Returns
// null for anything unrecognized. Single exit.
function parseKey(key) {
	let out = null;
	if (typeof key === 'string') {
		const head = KEY_HEADS.find(h => key.startsWith(h));
		if (head) {
			const rest = key.slice(head.length);
			const us = rest.indexOf('_');
			if (us > 0 && us < rest.length - 1) {
				out = { prefix: head + rest.slice(0, us), secret: rest.slice(us + 1) };
			}
		}
	}
	return out;
}

// Restrict a requested capability list to those the owner actually holds — a key can never
// exceed its minting user. ownerCaps of ['*'] (owner) passes everything through. Single exit.
function scopeCapabilities(requested, ownerCaps) {
	const req = Array.isArray(requested) ? requested : [];
	const owner = Array.isArray(ownerCaps) ? ownerCaps : [];
	return req.filter(c => Authz.hasCapability(owner, c));
}

// Constant-time compare of a presented secret against a stored sha256 hash. Single exit.
function secretMatchesHash(secret, keyHash) {
	let ok = false;
	try {
		const a = Buffer.from(sha256(secret), 'hex');
		const b = Buffer.from(String(keyHash || ''), 'hex');
		ok = a.length === b.length && crypto.timingSafeEqual(a, b);
	}
	catch (e) { ok = false; }
	return ok;
}

// The safe projection for API responses/UI — never the hash, never a secret. Single exit.
function publicView(row) {
	if (!row) { return null; }
	return {
		key_id:       row.key_id,
		name:         row.name || '',
		prefix:       row.prefix,                 // display handle, e.g. symb_live_ab12… (not the secret)
		capabilities: Array.isArray(row.capabilities) ? row.capabilities.slice() : [],
		signing:      row.signing || 'bearer',
		status:       row.status || 'active',
		is_internal:  !!row.is_internal,          // a protected, SymBot-managed key (built-in signals client)
		rate_limit:   row.rate_limit != null ? row.rate_limit : null,
		ip_allowlist: Array.isArray(row.ip_allowlist) ? row.ip_allowlist.slice() : [],
		ip_blocklist: Array.isArray(row.ip_blocklist) ? row.ip_blocklist.slice() : [],
		expires_at:   row.expires_at || null,
		created_at:   row.created_at || null,
		last_used_at: row.last_used_at || null,
		last_used_ip: row.last_used_ip || ''
	};
}


// ── DB-backed operations ─────────────────────────────────────────────────────

// Create a key. `ownerCapabilities` bounds the key's scopes (⊆ owner). Returns
// { key: publicView, clearKey } — clearKey must be surfaced to the user once and discarded.
// Single exit.
async function create(opts) {
	opts = opts || {};
	const capabilities = scopeCapabilities(opts.capabilities, opts.ownerCapabilities || [ '*' ]);
	const gen = generate(opts.head);
	let result;
	try {
		const row = await model().create({
			key_id:        crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
			server_id:     serverId(),
			prefix:        gen.prefix,
			key_hash:      sha256(gen.secret),
			name:          (opts.name || '').toString().slice(0, 120),
			// Store a REAL user_id only. A reserved synthetic principal id — notably 'owner', the
			// implicit single-operator that backs a legacy browser login — is not a user record, so
			// persist '' instead of stamping it as an owner (which would otherwise read as a removed
			// user forever in the capability-drift Watchdog).
			owner_user_id: Authz.isReservedPrincipalId(opts.ownerUserId) ? '' : opts.ownerUserId,
			capabilities:  capabilities,
			resource_scopes: opts.resourceScopes || null,
			signing:       opts.signing === 'hmac' ? 'hmac' : 'bearer',
			rate_limit:    (opts.rateLimit != null && !isNaN(opts.rateLimit)) ? Number(opts.rateLimit) : null,
			ip_allowlist:  IpFilter.sanitizeList(opts.ipAllowlist),
			ip_blocklist:  IpFilter.sanitizeList(opts.ipBlocklist),
			status:        'active',
			expires_at:    opts.expiresAt || null,
			created_at:    new Date()
		});
		log('created key ' + gen.prefix + ' [' + capabilities.join(', ') + ']');
		result = { success: true, key: publicView(row), clearKey: gen.clearKey };
	}
	catch (e) { log('create failed: ' + e.message); result = { success: false, error: e.message }; }
	return result;
}

// Rotate a key: mint a like-for-like successor (fresh secret) preserving capabilities, IP lists, rate
// limit, signing and owner, then GRACE-EXPIRE the old key (reusing the normal expiry enforcement) so
// callers can cut over without downtime, and cross-link the pair (rotated_to / rotated_from). The new
// key is bounded to the OLD key's own scope, so a rotation can never escalate privilege. The clear
// secret is returned once, exactly like create(). Never throws. Single exit.
async function rotate(keyId, opts) {
	opts = opts || {};
	let result;
	try {
		const graceHours = Math.min(Math.max(isNaN(parseInt(opts.graceHours, 10)) ? 24 : parseInt(opts.graceHours, 10), 0), 720);

		const old = await model().findOne({ key_id: keyId, server_id: serverId() });

		if (!old) { result = { success: false, error: 'Key not found.' }; }
		else if (old.is_internal) { result = { success: false, error: 'The internal key cannot be rotated.' }; }
		else if (old.status === 'revoked') { result = { success: false, error: 'A revoked key cannot be rotated.' }; }
		else if (old.rotated_to) { result = { success: false, error: 'This key has already been rotated.' }; }
		else {
			const oldCaps = Array.isArray(old.capabilities) ? old.capabilities.slice() : [];

			const created = await create({
				name:              old.name ? (old.name + ' (rotated)') : 'rotated key',
				capabilities:      oldCaps,
				ownerCapabilities: oldCaps,                 // bound to the predecessor's scope — rotation never escalates
				ownerUserId:       old.owner_user_id || '',
				signing:           old.signing,
				rateLimit:         old.rate_limit,
				ipAllowlist:       Array.isArray(old.ip_allowlist) ? old.ip_allowlist.slice() : [],
				ipBlocklist:       Array.isArray(old.ip_blocklist) ? old.ip_blocklist.slice() : []
			});

			if (!created || !created.success) { result = { success: false, error: (created && created.error) || 'Could not create the successor key.' }; }
			else {
				const newKeyId = created.key && created.key.key_id;
				const graceExpiry = graceHours > 0 ? new Date(Date.now() + (graceHours * 3600 * 1000)) : new Date();

				await model().updateOne({ key_id: keyId, server_id: serverId() }, { $set: { rotated_to: newKeyId, expires_at: graceExpiry } });
				if (newKeyId) { await model().updateOne({ key_id: newKeyId, server_id: serverId() }, { $set: { rotated_from: keyId } }); }

				log('rotated key ' + old.prefix + ' → ' + (created.key && created.key.prefix) + ' (old expires in ' + graceHours + 'h)');
				result = { success: true, key: created.key, clearKey: created.clearKey, old_key_id: keyId, grace_expires_at: graceExpiry, grace_hours: graceHours };
			}
		}
	}
	catch (e) { log('rotate failed: ' + e.message); result = { success: false, error: e.message }; }
	return result;
}

// Resolve a presented key string to an Authz principal, or null if invalid/inactive/expired.
// Touches last_used (fire-and-forget). Never throws. Single exit.
async function resolve(presentedKey, ctx) {
	ctx = ctx || {};
	let principal = null;
	const parsed = parseKey(presentedKey);
	if (parsed) {
		try {
			const row = await model().findOne({ prefix: parsed.prefix, server_id: serverId() });
			const expired = row && row.expires_at && new Date(row.expires_at).getTime() < Date.now();
			if (row && row.status === 'active' && !expired && secretMatchesHash(parsed.secret, row.key_hash)) {

				// Per-key IP filter. A scoped key may carry an ip_allowlist and/or ip_blocklist
				// (exact / CIDR / wildcard); deny wins. This is safe against human lockout — a bad
				// list only blocks THIS key, never the UI. Loopback is NOT exempt here: a key scoped
				// to specific IPs is meant to apply everywhere, including localhost.
				const ipCheck = IpFilter.evaluate(ctx.ip, { allow: row.ip_allowlist || [], deny: row.ip_blocklist || [] });

				if (!ipCheck.allowed) {

					log('key ' + row.prefix + ' rejected from IP ' + (ctx.ip || '?') + ' (' + ipCheck.reason + ')');
					return principal;   // stays null → treated as an invalid credential
				}

				model().updateOne({ key_id: row.key_id }, { last_used_at: new Date(), last_used_ip: ctx.ip || '' }).catch(() => {});
				principal = Authz.makePrincipal({
					id: row.key_id, kind: 'apikey', apiKeyId: row.key_id,
					capabilities: row.capabilities, resourceScopes: row.resource_scopes || null,
					rateLimit: row.rate_limit
				});
			}
		}
		catch (e) { log('resolve failed: ' + e.message); principal = null; }
	}
	return principal;
}

// List keys (safe projection). Single exit.
async function list() {
	let out = [];
	try { out = (await model().find({ server_id: serverId() }).sort({ created_at: -1 })).map(publicView); }
	catch (e) { log('list failed: ' + e.message); out = []; }
	return out;
}

// Raw key records for internal server-side audits (e.g. the capability-drift Watchdog check needs
// owner_user_id, which publicView deliberately omits). Never exposed to a client. Single exit.
async function listRaw() {
	try { return await model().find({ server_id: serverId() }); }
	catch (e) { log('listRaw failed: ' + e.message); return []; }
}

// Set a key's status ('active' | 'disabled' | 'revoked'). Revoked is terminal. The protected
// internal signals key is managed by SymBot and cannot be disabled/revoked here (it re-provisions
// on start anyway). Single exit.
// Update a key's IP allow/block lists (edited from the Access Control UI). Both lists are
// sanitized to valid rules only. The internal signals key is protected. Single exit.
async function setIpLists(keyId, ipAllowlist, ipBlocklist) {
	let result = { success: false, error: 'Key not found' };
	try {
		const row = await model().findOne({ key_id: keyId, server_id: serverId() });
		if (row && row.is_internal) {
			result = { success: false, error: 'The internal signals key is managed by SymBot and cannot be changed' };
		}
		else if (row) {
			const allow = IpFilter.sanitizeList(ipAllowlist);
			const deny = IpFilter.sanitizeList(ipBlocklist);
			await model().updateOne({ key_id: keyId, server_id: serverId() }, { ip_allowlist: allow, ip_blocklist: deny });
			log('updated IP lists for key ' + row.prefix + ' (allow ' + allow.length + ', block ' + deny.length + ')');
			result = { success: true, ip_allowlist: allow, ip_blocklist: deny };
		}
	}
	catch (e) { result = { success: false, error: e.message }; }
	return result;
}


// Set (or clear) a key's expiry after creation. `expiresAt` is a date/datetime string, or null/''
// to clear it. An invalid date is rejected. Expiry is enforced at auth (resolve() rejects an
// expired key), so this is a real access control, not just display. Single exit.
async function setExpiry(keyId, expiresAt) {
	let exp = null;
	if (expiresAt !== null && expiresAt !== undefined && String(expiresAt).trim() !== '') {
		const d = new Date(expiresAt);
		if (isNaN(d.getTime())) { return { success: false, error: 'Invalid expiry date' }; }
		exp = d;
	}
	let result = { success: false, error: 'Key not found' };
	try {
		const row = await model().findOne({ key_id: keyId, server_id: serverId() });
		if (row && row.is_internal) {
			result = { success: false, error: 'The internal signals key is managed by SymBot and cannot be changed' };
		}
		else if (row) {
			await model().updateOne({ key_id: keyId, server_id: serverId() }, { expires_at: exp });
			log('set expiry for key ' + row.prefix + ' to ' + (exp ? exp.toISOString() : 'none'));
			result = { success: true, expires_at: exp };
		}
	}
	catch (e) { result = { success: false, error: e.message }; }
	return result;
}


async function setStatus(keyId, status) {
	let result = { success: false, error: 'Invalid status' };
	if ([ 'active', 'disabled', 'revoked' ].indexOf(status) >= 0) {
		try {
			const row = await model().findOne({ key_id: keyId, server_id: serverId() });
			if (row && row.is_internal) {
				result = { success: false, error: 'The internal signals key is managed by SymBot and cannot be changed' };
			}
			else if (row && row.status === 'revoked' && status !== 'revoked') {
				// Revocation is terminal — a revoked credential must stay dead. Reactivating it would
				// resurrect a key the operator deliberately killed. Create a new key instead.
				result = { success: false, error: 'This key was revoked; revocation is permanent — create a new key instead' };
			}
			else {
				const res = await model().updateOne({ key_id: keyId, server_id: serverId() }, { status });
				result = (res && (res.matchedCount || res.n)) ? { success: true } : { success: false, error: 'Key not found' };
			}
		}
		catch (e) { result = { success: false, error: e.message }; }
	}
	return result;
}

function revoke(keyId) { return setStatus(keyId, 'revoked'); }

// Provision (idempotently, rotating only the secret each start) the instance's protected
// INTERNAL signals key — the credential SymBot's own built-in 3CQS signals client uses to drive
// the webhook/deal pipeline natively on the scoped API-key system. The key_id and display prefix
// stay stable across restarts; the secret is regenerated and held in memory only (returned here,
// stored in shareData) and never persisted in clear, mirroring how the legacy webhook token is
// derived fresh each start. Because it re-provisions on every start it self-heals — a stray
// revoke or delete cannot permanently break signals. Single exit.
async function provisionInternal(opts) {
	opts = opts || {};
	const capabilities = (Array.isArray(opts.capabilities) && opts.capabilities.length) ? opts.capabilities : [ 'deal.create' ];
	let result = { success: false };
	try {
		const existing = await model().findOne({ server_id: serverId(), is_internal: true });
		const prefix = existing ? existing.prefix : (DEFAULT_HEAD + crypto.randomBytes(6).toString('hex'));
		const secret = crypto.randomBytes(32).toString('hex');
		const clearKey = prefix + '_' + secret;
		const fields = {
			server_id:     serverId(),
			prefix:        prefix,
			key_hash:      sha256(secret),
			name:          'Internal Signals',
			owner_user_id: 'system',
			capabilities:  capabilities,
			signing:       'bearer',
			status:        'active',
			is_internal:   true
		};
		if (existing) {
			await model().updateOne({ key_id: existing.key_id }, fields);
		}
		else {
			fields.key_id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
			fields.created_at = new Date();
			await model().create(fields);
		}
		log('provisioned internal signals key ' + prefix + ' [' + capabilities.join(', ') + ']');
		result = { success: true, clearKey: clearKey };
	}
	catch (e) { log('provisionInternal failed: ' + e.message); result = { success: false, error: e.message }; }
	return result;
}


module.exports = {
	init: function (obj) { shareData = obj; log = obj.Common.makeLogger('ApiKeys: '); },
	// pure (tested directly)
	generate,
	parseKey,
	scopeCapabilities,
	secretMatchesHash,
	publicView,
	KEY_HEADS,
	// db-backed
	listRaw,
	create,
	rotate,
	resolve,
	setIpLists,
	setExpiry,
	list,
	setStatus,
	revoke,
	provisionInternal
};