'use strict';

// Tests for the declarative route → capability map (libs/app/RoutePermissions.js): the
// money/write routes map to the right capability, read routes stay unmapped (any
// authenticated principal may read), and the end result — a read-only principal is denied a
// mapped write route while an operator is allowed.

const assert = require('assert');
const RP = require('../../app/RoutePermissions.js');
const Authz = require('../../app/Authz.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }


console.log('\nmapping:');

test('config save requires settings.write', () => { assert.strictEqual(RP.required('POST', '/config'), 'settings.write'); });
test('close/cancel/panic map to deal.close', () => {
	assert.strictEqual(RP.required('POST', '/api/deals/BTC_USD-123-1/close'), 'deal.close');
	assert.strictEqual(RP.required('POST', '/api/deals/x/cancel'), 'deal.close');
	assert.strictEqual(RP.required('POST', '/api/bots/b1/panic_sell'), 'deal.close');
});
test('pause maps to deal.pause', () => { assert.strictEqual(RP.required('POST', '/api/deals/x/pause'), 'deal.pause'); });
test('add_funds / start_deal / signal map to deal.create', () => {
	assert.strictEqual(RP.required('POST', '/api/deals/x/add_funds'), 'deal.create');
	assert.strictEqual(RP.required('POST', '/api/bots/b1/start_deal'), 'deal.create');
	assert.strictEqual(RP.required('POST', '/api/signal/mybot'), 'deal.create');
});
test('bot create/update/enable/config map to bot.write; delete to bot.delete', () => {
	assert.strictEqual(RP.required('POST', '/api/bots/create'), 'bot.write');
	assert.strictEqual(RP.required('POST', '/api/bots/b1/enable'), 'bot.write');
	assert.strictEqual(RP.required('POST', '/api/bot-config'), 'bot.write');
	assert.strictEqual(RP.required('POST', '/api/bot-config/sandbox'), 'bot.write');
	assert.strictEqual(RP.required('DELETE', '/api/bots/b1'), 'bot.delete');
});

test('AI learning-corpus WRITES require settings.write, not the generic AI read scope', () => {
	// import / rate / aggregate all mutate the shared corpus (aggregate commits via importPack), so a
	// read-only key must not reach them — they are elevated above the generic POST /api/ai/ read rule.
	assert.strictEqual(RP.required('POST', '/api/ai/learning/import'), 'settings.write');
	assert.strictEqual(RP.required('POST', '/api/ai/learning/rate'), 'settings.write');
	assert.strictEqual(RP.required('POST', '/api/ai/learning/aggregate'), 'settings.write');
	// A non-corpus AI POST (chat) stays read-scoped by design.
	assert.strictEqual(RP.required('POST', '/api/ai/chat/prompt'), 'stats.read');
});

test('AI provider PROBES require settings.write, not the generic AI read scope', () => {
	// These probes accept a caller-supplied endpoint and can fall back to the STORED provider key, so a
	// read scope must not reach them (a low-scope caller could otherwise exfiltrate the key to a foreign
	// endpoint or drive SSRF). They are config-setup helpers, gated to the config-editing scope.
	assert.strictEqual(RP.required('POST', '/api/ai/models'), 'settings.write');
	assert.strictEqual(RP.required('POST', '/api/ai/preflight'), 'settings.write');
	assert.strictEqual(RP.required('POST', '/api/ai/model-tools-support'), 'settings.write');
});

test('data GET routes are scoped to their read capability', () => {
	// Read scoping: a scoped key must hold the matching *.read to read the resource (owner / legacy
	// key / any user role hold all reads, so the UI and existing integrations are unaffected).
	assert.strictEqual(RP.required('GET', '/api/deals'), 'deal.read');
	assert.strictEqual(RP.required('GET', '/api/bots'), 'bot.read');
	assert.strictEqual(RP.required('GET', '/api/markets'), 'stats.read');
	assert.strictEqual(RP.required('GET', '/api/exchanges'), 'account.read');
	// Non-API page routes stay unmapped (guarded by the session), and the health probe is open.
	assert.strictEqual(RP.required('GET', '/dashboard'), null);
	assert.strictEqual(RP.required('GET', '/api/system/health'), null);
});

test('management routes are not in this map (they use inline guards)', () => {
	assert.strictEqual(RP.required('POST', '/api/keys'), null);
	assert.strictEqual(RP.required('GET', '/api/users'), null);
});


console.log('\nend-to-end intent (map + can):');

test('a read-only key is denied a mapped write route; an operator is allowed', () => {
	const readonly = Authz.makePrincipal({ kind: 'apikey', capabilities: ['stats.read', 'bot.read', 'deal.read'] });
	const operator = Authz.makePrincipal({ role: 'operator' });
	const owner = Authz.ownerPrincipal();

	const capClose = RP.required('POST', '/api/deals/x/close');
	assert.ok(!Authz.can(readonly, capClose), 'read-only key blocked from close');
	assert.ok(Authz.can(operator, capClose), 'operator allowed to close');
	assert.ok(Authz.can(owner, capClose), 'owner allowed');

	const capBotWrite = RP.required('POST', '/api/bots/create');
	assert.ok(!Authz.can(readonly, capBotWrite), 'read-only key blocked from bot write');
	assert.ok(Authz.can(operator, capBotWrite), 'operator can edit bots');
});


console.log('\nsystem + AI routes (privileged / cost):');

test('system backup/restore/update/rollback require settings.write', () => {
	for (const path of ['/api/system/backup', '/system/backup', '/system/restore', '/system/update', '/system/rollback']) {
		assert.strictEqual(RP.required('POST', path), 'settings.write', path + ' → settings.write');
	}
	const operator = Authz.makePrincipal({ role: 'operator' });
	const admin = Authz.makePrincipal({ role: 'admin' });
	assert.ok(!Authz.can(operator, 'settings.write'), 'operator cannot restore/update');
	assert.ok(Authz.can(admin, 'settings.write'), 'admin can');
});

test('AI routes require a read scope (never admit a scope-less key)', () => {
	assert.strictEqual(RP.required('POST', '/api/ai/chat/prompt'), 'stats.read');
	assert.strictEqual(RP.required('POST', '/api/ai/analyze_deal'), 'stats.read');
	assert.strictEqual(RP.required('DELETE', '/api/ai/chat/conversations/abc'), 'stats.read');
	const botOnly = Authz.makePrincipal({ kind: 'apikey', capabilities: ['bot.read'] });
	assert.ok(!Authz.can(botOnly, 'stats.read'), 'a bot.read-only key cannot drive paid AI');
});


console.log('\ncoverage audit (catches stray ungated routes):');

test('auditCoverage flags an ungated mutating route and passes gated / public / cap-guarded ones', () => {
	const gatedGuard = () => {}; gatedGuard.__capGuard = 'bot.write';
	const mockRouter = { stack: [
		{ route: { path: '/api/bots/create',      methods: { post: true },   stack: [] } },   // in RULES → covered
		{ route: { path: '/login',                methods: { post: true },   stack: [] } },   // PUBLIC → covered
		{ route: { path: '/api/keys',             methods: { post: true },   stack: [ { handle: gatedGuard } ] } }, // inline cap → covered
		{ route: { path: '/api/deals',            methods: { get: true },    stack: [] } },   // GET → not mutating, ignored
		{ route: { path: '/api/danger/wipe',      methods: { post: true },   stack: [] } }    // UNGATED → must be flagged
	] };
	const uncovered = RP.auditCoverage(mockRouter);
	assert.deepStrictEqual(uncovered, [ 'POST /api/danger/wipe' ], 'only the ungated mutating route is reported');
});

test('the previously-stray account balances routes are now covered', () => {
	assert.strictEqual(RP.required('POST', '/api/accounts/balances'), 'account.read');
	assert.strictEqual(RP.required('POST', '/api/accounts/binance/balances'), 'account.read');
});

test('isPublic recognizes the deliberate allowlist only', () => {
	assert.ok(RP.isPublic('POST', '/login'));
	assert.ok(RP.isPublic('POST', '/webhook/api/signal/x'));
	assert.ok(!RP.isPublic('POST', '/api/bots/create'));
});


console.log('\ngate-strength audit (catches under-gated writes):');

test('the live RULES have no under-gated write routes (a mutating route on a *.read scope)', () => {
	// This would have caught the real bug where POST /api/ai/learning/rate was mapped to stats.read.
	assert.deepStrictEqual(RP.auditGateStrength(), [], 'every mutating rule uses a write scope (or is marked read:true)');
});

test('the Hub action→capability map is the single canonical ACTION_CAPS and agrees with the HTTP RULES', () => {
	// The Hub's multiplexed /bots/action and /deals/action gates derive from RP.ACTION_CAPS (not a
	// hand-copied literal), and every WRITE action's capability must equal what the instance's own HTTP
	// route requires — so a scoped key can never do more across instances than on the instance itself.
	assert.ok(RP.ACTION_CAPS && RP.ACTION_CAPS.bot && RP.ACTION_CAPS.deal, 'ACTION_CAPS is exported with bot + deal groups');
	assert.strictEqual(RP.ACTION_CAPS.bot.delete, 'bot.delete');
	assert.strictEqual(RP.ACTION_CAPS.deal.pause, 'deal.pause');
	assert.deepStrictEqual(RP.auditActionCaps(), [], 'no write action under-gates relative to its HTTP route');
});

test('the read-over-POST balances route is exempt via read:true, not flagged', () => {
	// account.read on a POST is legitimate (creds in body); the marker keeps it out of the audit.
	const weak = RP.auditGateStrength();
	assert.ok(!weak.some(w => /balances/.test(w)), 'the balances read-over-POST is not reported as under-gated');
});


// ── PUBLIC allowlist (isPublic) — the deliberate no-capability exemption ────────────────────────────
// The webhook route is INTENTIONALLY unmapped in RULES: `required()` returns null for it, so the only
// thing that lets a webhook POST past the deny-by-default capability gate is the PUBLIC allowlist. That
// exemption is load-bearing — processWebHook does its OWN token/capability check inside — and it must not
// silently disappear (which would 401 every incoming signal) or silently widen (which would open a real
// mutating route to the unauthenticated). These pin both halves.
console.log('\npublic allowlist:');

test('POST /webhook/* is PUBLIC (unauthenticated passthrough to processWebHook)', () => {
	assert.strictEqual(RP.isPublic('POST', '/webhook/api/signal/deal_start_signal'), true, '/webhook/ POST is exempt');
	assert.strictEqual(RP.isPublic('POST', '/webhook/anything/here'), true, 'any /webhook/ subpath is exempt');
});

test('POST /webhook/* is deliberately UNMAPPED in RULES (required() === null)', () => {
	// If a rule ever mapped it, the exemption would be redundant; if the exemption is dropped, this
	// unmapped route falls to deny-by-default and every webhook 401s. This pins WHY isPublic is required.
	assert.strictEqual(RP.required('POST', '/webhook/api/signal/deal_start_signal'), null, 'webhook is unmapped');
});

test('login and logout are PUBLIC (the credential check / own-session end need no capability)', () => {
	assert.strictEqual(RP.isPublic('POST', '/login'), true, 'POST /login is exempt');
	assert.strictEqual(RP.isPublic('POST', '/logout'), true, 'POST /logout is exempt');
});

test('the PUBLIC allowlist does NOT leak to real routes or wrong methods', () => {
	assert.strictEqual(RP.isPublic('GET', '/api/deals'), false, 'a normal read route is not public');
	assert.strictEqual(RP.isPublic('POST', '/config'), false, 'a gated write route is not public');
	assert.strictEqual(RP.isPublic('GET', '/login'), false, 'the exemption is POST-scoped, not any-method');
	assert.strictEqual(RP.isPublic('POST', '/webhookery/evil'), false, 'the anchor is /webhook/ with a slash, not a prefix match');
});


console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);