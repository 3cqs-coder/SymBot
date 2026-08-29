'use strict';

// ── HubStore — the Hub's own control-plane storage ───────────────────────────
//
// The Hub has no MongoDB (instances do); it stores its OWN users, API keys, and audit log in
// a hardened embedded SQLite database via the adapter seam (SqliteDriver). This is the central
// storage core for the Hub — everything Hub-side routes through it.
//
// It deliberately REUSES the storage-agnostic pure logic already built and tested for the
// instance side, so the authorization/behavior is identical and there is no second copy of
// the rules:
//   • Authz         — capability vocabulary, roles, principals, can()
//   • Users pure     — self-lockout guards, role defaulting, safe projection, toPrincipal
//   • ApiKeys pure   — key generation, format-parsing, scope-to-owner, constant-time verify
//   • Audit pure     — actor resolution
// Only the persistence differs (SQLite here vs MongoDB on instances).

const crypto = require('crypto');

const Authz = require('../Authz.js');
const IpFilter = require('../IpFilter.js');       // shared IP allow/deny matcher
const UsersPure = require('../Users.js');       // guardRoleChange/guardStatusChange/normalizeRole/publicView/toPrincipal
const KeysPure = require('../ApiKeys.js');       // generate/parseKey/scopeCapabilities/secretMatchesHash/publicView
const AuditPure = require('../Audit.js');         // resolveActor
const SqliteDriver = require('./SqliteDriver.js');
const SqliteReadWorker = require('./SqliteReadWorker.js');   // off-main-thread one-shot read (heavy queries)

let driver = null;
let dbPath = null;
let logger = function () {};

function log(msg) { logger('HubStore: ' + msg); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }
function nowMs() { return Date.now(); }

// Password hashing in SymBot's "salt:hash" format (pbkdf2), so a Hub owner seeded from the existing
// hub.json password hash stays valid and new users verify the same way. A Hub password is a low-entropy
// human secret verified only at login (rare), so it is hashed at the strong OWASP factor — the same
// PASSWORD_PBKDF2_ITERATIONS the instance side uses (Common.genPasswordHash) — not the fast legacy factor
// meant for high-entropy API keys. These MUST stay in lockstep with Common's factors; HubStore
// re-implements the KDF locally only because it has no shareData.Common. Verify tries the strong factor
// first, then falls back to the legacy factor, so any Hub hash written at the old 1000-iteration factor
// (e.g. an existing hub.json owner) still verifies and is transparently upgraded on the next password set.
const PASSWORD_PBKDF2_ITERATIONS = 600000;
const LEGACY_PBKDF2_ITERATIONS   = 1000;

function hashPassword(password) {
	const salt = crypto.randomBytes(16).toString('hex');
	return salt + ':' + crypto.pbkdf2Sync(String(password), salt, PASSWORD_PBKDF2_ITERATIONS, 64, 'sha256').toString('hex');
}
function verifyPassword(password, stored) {
	const [ salt, hash ] = String(stored || '').split(':');
	if (!salt || !hash) { return false; }
	const b = Buffer.from(hash, 'hex');
	for (const iterations of [ PASSWORD_PBKDF2_ITERATIONS, LEGACY_PBKDF2_ITERATIONS ]) {
		const a = Buffer.from(crypto.pbkdf2Sync(String(password), salt, iterations, 64, 'sha256').toString('hex'), 'hex');
		if (a.length === b.length && crypto.timingSafeEqual(a, b)) { return true; }
	}
	return false;
}


// Open the store and create the schema. `available` is false when node:sqlite isn't usable in
// this runtime (older Node); callers should surface a clear "upgrade Node" message rather than
// crash. Single exit.
function init(opts) {
	opts = opts || {};
	logger = typeof opts.logger === 'function' ? opts.logger : function () {};

	if (!SqliteDriver.available) { log('node:sqlite unavailable in this Node runtime — Hub storage disabled (upgrade to Node 22.13+)'); return { available: false }; }

	driver = SqliteDriver({ path: opts.path, backupDir: opts.backupDir, backupKeep: opts.backupKeep, logger: logger });
	dbPath = opts.path || null;   // remembered for queryOffThread (a file-backed DB only)
	driver.open();

	ensureSchema();

	log('opened (' + (opts.path || ':memory:') + ')');
	return { available: true };
}

// Idempotent schema creation + column back-fills. Run at init AND after a restore: a snapshot taken
// before a newer table/column existed would otherwise leave the reopened DB missing it until the next
// process restart — e.g. listLearningPatterns would throw on a missing ai_learning table, and rotateKey
// would fail on a missing rotated_to column. CREATE TABLE / ensureColumn are all IF-NOT-EXISTS, so
// re-running is safe.
function ensureSchema() {

	if (!driver) { return; }

	driver.exec(`
		CREATE TABLE IF NOT EXISTS users (
			user_id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT DEFAULT '',
			role TEXT DEFAULT 'viewer', grants TEXT DEFAULT '[]', status TEXT DEFAULT 'active',
			is_initial INTEGER DEFAULT 0, email TEXT DEFAULT '', created_at INTEGER, last_login_at INTEGER
		);
		CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users(username);

		CREATE TABLE IF NOT EXISTS api_keys (
			key_id TEXT PRIMARY KEY, prefix TEXT NOT NULL, key_hash TEXT NOT NULL, name TEXT DEFAULT '',
			owner_user_id TEXT DEFAULT '', capabilities TEXT DEFAULT '[]', signing TEXT DEFAULT 'bearer',
			rate_limit INTEGER, ip_allowlist TEXT DEFAULT '[]', ip_blocklist TEXT DEFAULT '[]', status TEXT DEFAULT 'active',
			expires_at INTEGER, rotated_to TEXT, rotated_from TEXT, created_at INTEGER, last_used_at INTEGER, last_used_ip TEXT DEFAULT ''
		);
		CREATE UNIQUE INDEX IF NOT EXISTS ux_keys_prefix ON api_keys(prefix);

		CREATE TABLE IF NOT EXISTS audit_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, actor TEXT DEFAULT '', action TEXT DEFAULT '',
			target TEXT DEFAULT '', detail TEXT DEFAULT '', ip TEXT DEFAULT ''
		);
		CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_log(ts);
		CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_log(action);

		CREATE TABLE IF NOT EXISTS ai_learning (
			pkey TEXT PRIMARY KEY, question TEXT NOT NULL, route TEXT DEFAULT NULL,
			tools TEXT DEFAULT '[]', confidence TEXT DEFAULT 'high', created_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS ix_ai_learning_created ON ai_learning(created_at);
	`);

	// Upgrade-safe column migrations: a Hub DB created before a column existed keeps the old shape
	// (CREATE TABLE IF NOT EXISTS won't add columns), so add any missing ones idempotently.
	ensureColumn('api_keys', 'ip_allowlist', "TEXT DEFAULT '[]'");
	ensureColumn('api_keys', 'ip_blocklist', "TEXT DEFAULT '[]'");
	ensureColumn('api_keys', 'rotated_to', 'TEXT');
	ensureColumn('api_keys', 'rotated_from', 'TEXT');
}

function isAvailable() { return !!driver; }
function backup() { return driver ? driver.backup() : null; }
function listBackups() { return driver ? driver.listBackups() : []; }
function restore(fileName) {
	if (!driver) { return { success: false, error: 'Hub storage unavailable' }; }
	const res = driver.restore(fileName);
	// The driver reopened onto the restored snapshot; re-run the idempotent schema-ensure so a snapshot
	// from an older schema version isn't left missing new tables/columns until the next restart.
	if (res && res.success) { try { ensureSchema(); } catch (e) { log('post-restore schema ensure failed: ' + e.message); } }
	return res;
}
function backupDir() { return driver ? driver.backupDir : null; }
function close() { if (driver) { driver.close(); driver = null; } dbPath = null; }

// Run a heavy READ off the main thread and resolve with its rows. The Hub's everyday queries are tiny,
// indexed point lookups that belong on the main-thread driver (get/all) — using a worker for those would
// be pure overhead. This is for the day a genuinely heavy read (a large audit/report scan over a grown
// table) would otherwise block the Hub's event loop: route THAT query here so the Hub stays responsive.
// Read-only and file-backed only (an in-memory DB can't be shared across threads). Returns a Promise of
// rows; rejects (never throws) when storage is unavailable, the DB is in-memory, or node:sqlite is absent.
// No built-in concurrency cap: each call spawns its own worker + read connection, so a future hot-path
// caller that could fire many at once should bound the concurrency (and keep each query self-bounding).
function queryOffThread(sql, params, opts) {
	if (!driver) { return Promise.reject(new Error('Hub storage unavailable')); }
	if (!dbPath) { return Promise.reject(new Error('Off-thread reads require a file-backed database')); }
	return SqliteReadWorker.queryOnce(dbPath, sql, params, Object.assign({ logger: logger }, opts || {}));
}


// ── Users ────────────────────────────────────────────────────────────────────

function rowToUser(r) {
	if (!r) { return null; }
	return { user_id: r.user_id, username: r.username, password_hash: r.password_hash, role: r.role,
		grants: safeJson(r.grants, []), status: r.status, is_initial: !!r.is_initial, email: r.email,
		created_at: r.created_at, last_login_at: r.last_login_at };
}
function safeJson(s, dflt) { try { return JSON.parse(s); } catch (e) { return dflt; } }

// Add a column to a table only if it isn't already present (idempotent upgrade migration).
function ensureColumn(table, column, decl) {
	try {
		const cols = driver.all('PRAGMA table_info(' + table + ')') || [];
		if (!cols.some(c => c.name === column)) { driver.run('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + decl); }
	}
	catch (e) { log('ensureColumn ' + table + '.' + column + ' failed: ' + e.message); }
}

function listUsersRaw() { return driver ? driver.all('SELECT * FROM users ORDER BY created_at ASC').map(rowToUser) : []; }
function listUsers() { return listUsersRaw().map(UsersPure.publicView); }
function getUserById(userId) { return driver ? rowToUser(driver.get('SELECT * FROM users WHERE user_id = ?', [ userId ])) : null; }
function userToPrincipal(u) { return UsersPure.toPrincipal(u); }

// Seed the initial owner from an existing "salt:hash" (the hub.json password) or a plaintext.
// Idempotent. Single exit.
function seedOwner(opts) {
	opts = opts || {};
	let result = { success: false };
	if (driver) {
		const existing = driver.get('SELECT * FROM users WHERE is_initial = 1');
		if (existing) { result = { success: true, seeded: false, user: UsersPure.publicView(rowToUser(existing)) }; }
		else {
			const password_hash = opts.passwordHash || (opts.password ? hashPassword(opts.password) : '');
			const id = uuid();
			driver.run('INSERT INTO users (user_id, username, password_hash, role, grants, status, is_initial, created_at) VALUES (?,?,?,?,?,?,1,?)',
				[ id, (opts.username || 'owner'), password_hash, 'owner', '[]', 'active', nowMs() ]);
			log('seeded initial owner "' + (opts.username || 'owner') + '"');
			result = { success: true, seeded: true, user: UsersPure.publicView(getUserById(id)) };
		}
	}
	return result;
}

function createUser(opts) {
	opts = opts || {};
	let result = { success: false, error: 'Username and password are required' };
	const username = (opts.username || '').trim();
	if (driver && username && opts.password) {
		if (driver.get('SELECT 1 FROM users WHERE username = ?', [ username ])) { result = { success: false, error: 'Username already exists' }; }
		else {
			const id = uuid();
			driver.run('INSERT INTO users (user_id, username, password_hash, role, grants, status, created_at) VALUES (?,?,?,?,?,?,?)',
				[ id, username, hashPassword(opts.password), UsersPure.normalizeRole(opts.role), JSON.stringify(Array.isArray(opts.grants) ? opts.grants : []), 'active', nowMs() ]);
			result = { success: true, user: UsersPure.publicView(getUserById(id)) };
		}
	}
	return result;
}

function authenticate(username, password) {
	let user = null;
	if (driver) {
		const row = rowToUser(driver.get('SELECT * FROM users WHERE username = ? AND status = ?', [ (username || '').trim(), 'active' ]));
		if (row && verifyPassword(password, row.password_hash)) {
			driver.run('UPDATE users SET last_login_at = ? WHERE user_id = ?', [ nowMs(), row.user_id ]);
			user = row;
		}
	}
	return user;
}

function setUserRole(userId, role) {
	const guard = UsersPure.guardRoleChange(listUsersRaw(), userId, role);
	if (!guard.ok) { return { success: false, error: guard.error }; }
	driver.run('UPDATE users SET role = ? WHERE user_id = ?', [ UsersPure.normalizeRole(role), userId ]);
	return { success: true };
}

function setUserStatus(userId, status) {
	const guard = UsersPure.guardStatusChange(listUsersRaw(), userId, status);
	if (!guard.ok) { return { success: false, error: guard.error }; }
	driver.run('UPDATE users SET status = ? WHERE user_id = ?', [ status === 'disabled' ? 'disabled' : 'active', userId ]);
	return { success: true };
}


// ── API keys ─────────────────────────────────────────────────────────────────

function rowToKey(r) {
	if (!r) { return null; }
	return { key_id: r.key_id, prefix: r.prefix, key_hash: r.key_hash, name: r.name, owner_user_id: r.owner_user_id,
		capabilities: safeJson(r.capabilities, []), signing: r.signing, rate_limit: r.rate_limit, status: r.status,
		ip_allowlist: safeJson(r.ip_allowlist, []), ip_blocklist: safeJson(r.ip_blocklist, []),
		rotated_to: r.rotated_to || null, rotated_from: r.rotated_from || null,
		expires_at: r.expires_at, created_at: r.created_at, last_used_at: r.last_used_at, last_used_ip: r.last_used_ip };
}

function listKeys() { return driver ? driver.all('SELECT * FROM api_keys ORDER BY created_at DESC').map(r => KeysPure.publicView(rowToKey(r))) : []; }

function createKey(opts) {
	opts = opts || {};
	let result = { success: false };
	if (driver) {
		const capabilities = KeysPure.scopeCapabilities(opts.capabilities, opts.ownerCapabilities || [ '*' ]);
		const gen = KeysPure.generate(opts.head);
		const id = uuid();
		driver.run('INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_user_id, capabilities, signing, rate_limit, ip_allowlist, ip_blocklist, status, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
			[ id, gen.prefix, crypto.createHash('sha256').update(gen.secret).digest('hex'), (opts.name || '').slice(0, 120),
			  opts.ownerUserId || '', JSON.stringify(capabilities), opts.signing === 'hmac' ? 'hmac' : 'bearer',
			  (opts.rateLimit != null && !isNaN(opts.rateLimit)) ? Number(opts.rateLimit) : null,
			  JSON.stringify(IpFilter.sanitizeList(opts.ipAllowlist)), JSON.stringify(IpFilter.sanitizeList(opts.ipBlocklist)), 'active',
			  opts.expiresAt ? new Date(opts.expiresAt).getTime() : null, nowMs() ]);
		result = { success: true, key: KeysPure.publicView(rowToKey(driver.get('SELECT * FROM api_keys WHERE key_id = ?', [ id ]))), clearKey: gen.clearKey };
	}
	return result;
}

// Resolve a presented key string → Authz principal, or null. Constant-time; touches last_used.
function resolveKey(presentedKey, ctx) {
	ctx = ctx || {};
	let principal = null;
	const parsed = KeysPure.parseKey(presentedKey);
	if (driver && parsed) {
		const row = rowToKey(driver.get('SELECT * FROM api_keys WHERE prefix = ?', [ parsed.prefix ]));
		const expired = row && row.expires_at && row.expires_at < nowMs();
		if (row && row.status === 'active' && !expired && KeysPure.secretMatchesHash(parsed.secret, row.key_hash)) {

			// Per-key IP filter (deny wins). A bad list only blocks this key, never the Hub UI.
			const ipCheck = IpFilter.evaluate(ctx.ip, { allow: row.ip_allowlist || [], deny: row.ip_blocklist || [] });

			if (ipCheck.allowed) {
				driver.run('UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE key_id = ?', [ nowMs(), ctx.ip || '', row.key_id ]);
				principal = Authz.makePrincipal({ id: row.key_id, kind: 'apikey', apiKeyId: row.key_id, capabilities: row.capabilities, rateLimit: row.rate_limit });
			}
			else {
				log('key ' + row.prefix + ' rejected from IP ' + (ctx.ip || '?') + ' (' + ipCheck.reason + ')');
			}
		}
	}
	return principal;
}

function setKeyStatus(keyId, status) {
	if (!driver || [ 'active', 'disabled', 'revoked' ].indexOf(status) < 0) { return { success: false, error: 'Invalid status' }; }
	const res = driver.run('UPDATE api_keys SET status = ? WHERE key_id = ?', [ status, keyId ]);
	return (res && res.changes) ? { success: true } : { success: false, error: 'Key not found' };
}

// Rotate a key: mint a successor bound to the old key's exact scope (never escalates), then
// grace-expire the old key so in-flight callers keep working during the cutover window. Mirrors
// the Mongo ApiKeys.rotate. Synchronous (SQLite driver). Single exit.
function rotateKey(keyId, opts) {
	opts = opts || {};
	let result;
	if (!driver) { return { success: false, error: 'Store unavailable' }; }
	try {
		const parsed = parseInt(opts.graceHours, 10);
		const graceHours = Math.min(Math.max(isNaN(parsed) ? 24 : parsed, 0), 720);

		const old = rowToKey(driver.get('SELECT * FROM api_keys WHERE key_id = ?', [ keyId ]));

		if (!old) { result = { success: false, error: 'Key not found.' }; }
		else if (old.is_internal) { result = { success: false, error: 'The internal key cannot be rotated.' }; }
		else if (old.status === 'revoked') { result = { success: false, error: 'A revoked key cannot be rotated.' }; }
		else if (old.rotated_to) { result = { success: false, error: 'This key has already been rotated.' }; }
		else {
			const oldCaps = Array.isArray(old.capabilities) ? old.capabilities.slice() : [];

			const created = createKey({
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
				const graceExpiry = graceHours > 0 ? (nowMs() + (graceHours * 3600 * 1000)) : nowMs();

				driver.run('UPDATE api_keys SET rotated_to = ?, expires_at = ? WHERE key_id = ?', [ newKeyId, graceExpiry, keyId ]);
				if (newKeyId) { driver.run('UPDATE api_keys SET rotated_from = ? WHERE key_id = ?', [ keyId, newKeyId ]); }

				log('rotated key ' + old.prefix + ' → ' + (created.key && created.key.prefix) + ' (old expires in ' + graceHours + 'h)');
				result = { success: true, key: created.key, clearKey: created.clearKey, old_key_id: keyId, grace_expires_at: graceExpiry, grace_hours: graceHours };
			}
		}
	}
	catch (e) { log('rotateKey failed: ' + e.message); result = { success: false, error: e.message }; }
	return result;
}


// Retention for the append-only audit log: keep the newest HUB_MAX_AUDIT_ROWS, pruned throttled (every
// HUB_AUDIT_PRUNE_EVERY writes) so the table can't grow without bound. Never breaks a request.
const HUB_MAX_AUDIT_ROWS = 10000;
const HUB_AUDIT_PRUNE_EVERY = 250;
let hubAuditWriteCount = 0;

function audit(actor, action, target, detail, ip) {
	try {
		if (driver) {
			driver.run('INSERT INTO audit_log (ts, actor, action, target, detail, ip) VALUES (?,?,?,?,?,?)',
				[ nowMs(), AuditPure.resolveActor(actor), String(action || ''), String(target || ''), String(detail || '').slice(0, 500), AuditPure.resolveIp(actor, ip) ]);

			if ((++hubAuditWriteCount % HUB_AUDIT_PRUNE_EVERY) === 0) {
				try { driver.run('DELETE FROM audit_log WHERE rowid NOT IN (SELECT rowid FROM audit_log ORDER BY ts DESC LIMIT ?)', [ HUB_MAX_AUDIT_ROWS ]); }
				catch (e) {}
			}
		}
	}
	catch (e) { /* auditing must never break a request */ }
	return true;
}

function listAudit(opts) {
	opts = opts || {};
	let rows = [];
	if (driver) {
		const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 200, 1), 1000);
		const where = [], params = [];
		if (opts.action) { where.push('action LIKE ?'); params.push(String(opts.action) + '%'); }
		if (opts.actor)  { where.push('actor LIKE ?'); params.push('%' + String(opts.actor) + '%'); }
		const sql = 'SELECT * FROM audit_log' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY ts DESC LIMIT ' + limit;
		rows = driver.all(sql, params);
	}
	return rows.map(r => ({ ts: r.ts, actor: r.actor, action: r.action, target: r.target, detail: r.detail, ip: r.ip }));
}


// ── Console recovery ────────────────────────────────────────────────────────────
// Wipe one auth table for the console `reset` commands. The initial owner re-seeds from the
// Hub password on the next start, so `reset users` recovers a role/permission lockout without
// touching the login password. A snapshot is taken first so even this destructive step is
// itself recoverable from data/hub/backups.
function resetTable(name) {
	const allowed = { users: 1, api_keys: 1, audit_log: 1 };
	if (!driver) { return { success: false, error: 'Hub storage unavailable' }; }
	if (!allowed[name]) { return { success: false, error: 'Invalid table: ' + name }; }
	try { driver.backup(); } catch (e) { /* best-effort snapshot */ }
	driver.exec('DELETE FROM ' + name + ';');
	return { success: true };
}


// ── AI learning aggregation ──────────────────────────────────────────────────
// The Hub pools patterns-only learning (question → tools) relayed from its instances,
// so instances that do NOT share a database still learn from each other. Deduped by
// `pkey` — the same normalized question+tools key AIMemory uses — and bounded so the
// table can't grow without limit.

const LEARNING_MAX = 20000;

function addLearningPattern(p, pkey) {
	if (!driver || !p || !p.question || !pkey) { return false; }
	try {
		driver.run(
			'INSERT OR IGNORE INTO ai_learning (pkey, question, route, tools, confidence, created_at) VALUES (?,?,?,?,?,?)',
			[ String(pkey), String(p.question).slice(0, 500), p.route ? String(p.route).slice(0, 120) : null,
			  JSON.stringify(Array.isArray(p.tools) ? p.tools.slice(0, 20) : []), p.confidence || 'high', nowMs() ]
		);
		const row = driver.get('SELECT COUNT(*) AS n FROM ai_learning', []);
		if (row && row.n > LEARNING_MAX) {
			driver.exec('DELETE FROM ai_learning WHERE pkey IN (SELECT pkey FROM ai_learning ORDER BY created_at ASC LIMIT ' + (row.n - LEARNING_MAX) + ')');
		}
		return true;
	}
	catch (e) { log('addLearningPattern failed: ' + e.message); return false; }
}

function listLearningPatterns(limit) {
	if (!driver) { return []; }
	const lim = Math.min(Math.max(parseInt(limit, 10) || LEARNING_MAX, 1), LEARNING_MAX);
	const rows = driver.all('SELECT question, route, tools, confidence FROM ai_learning ORDER BY created_at DESC LIMIT ' + lim, []);
	return rows.map(r => ({ question: r.question, route: r.route, tools: safeJson(r.tools, []), confidence: r.confidence }));
}

function learningCount() {
	if (!driver) { return 0; }
	const row = driver.get('SELECT COUNT(*) AS n FROM ai_learning', []);
	return row ? row.n : 0;
}


module.exports = {
	init, isAvailable, backup, listBackups, restore, backupDir, close, queryOffThread,
	// users
	seedOwner, createUser, authenticate, getUserById, listUsers, listUsersRaw, userToPrincipal, setUserRole, setUserStatus,
	// keys
	createKey, resolveKey, listKeys, setKeyStatus, rotateKey,
	// audit
	audit, listAudit,
	// ai learning aggregation
	addLearningPattern, listLearningPatterns, learningCount,
	// console recovery
	resetTable
};