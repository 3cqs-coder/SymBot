'use strict';

// Tests the two DB-backed Watchdog built-ins added for auth-lockout safety and trading integrity:
//   • auth_admin_present   — user accounts exist but none is an active admin/owner → finding
//   • orphaned_open_deals  — an OPEN deal points at a bot that no longer exists   → finding
// Uses the real Watchdog runner + Authz with mocked DB accessors, so it exercises the real logic.

const assert = require('assert');
const Watchdog = require('../../app/Watchdog.js');
const Authz = require('../../app/Authz.js');
const UsersReal = require('../../app/Users.js');   // toPrincipal is pure (role+grants → capabilities via Authz)

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// Build a shareData whose Users/DCABot accessors return the given fixtures. Common is stubbed so the
// runner's logger/audit calls are no-ops. Users exposes the REAL (pure) toPrincipal so over_privileged_user
// resolves capabilities exactly as production does.
function makeShare(opts) {
	return {
		Authz,
		Common: { logger: function () {}, auditEvent: function () {} },
		Users: opts.users ? { listRaw: async () => opts.users, toPrincipal: UsersReal.toPrincipal } : undefined,
		DCABot: opts.deals || opts.bots
			? { getDeals: async () => (opts.deals || []), getBots: async () => (opts.bots || []) }
			: undefined
	};
}

function findingFor(findings, action) { return findings.find(f => f.action === action); }

(async () => {

	// ── auth_admin_present ──

	// Single-operator mode (no user records): never a finding — the implicit owner has access.
	let f = await Watchdog.run(makeShare({ users: [] }), {});
	ok(!findingFor(f, 'watchdog.no_active_admin'), 'no lockout finding in single-operator mode (zero users)');

	// Users exist and one active admin is present → no finding.
	f = await Watchdog.run(makeShare({ users: [
		{ user_id: 'u1', role: 'admin',    status: 'active' },
		{ user_id: 'u2', role: 'operator', status: 'active' }
	] }), {});
	ok(!findingFor(f, 'watchdog.no_active_admin'), 'no finding when an active admin exists');

	// Users exist but the only admin is DISABLED → lockout finding.
	f = await Watchdog.run(makeShare({ users: [
		{ user_id: 'u1', role: 'admin',    status: 'disabled' },
		{ user_id: 'u2', role: 'operator', status: 'active' }
	] }), {});
	ok(findingFor(f, 'watchdog.no_active_admin'), 'lockout finding when all admins are disabled');

	// An active owner also satisfies the check (owner outranks admin).
	f = await Watchdog.run(makeShare({ users: [ { user_id: 'u1', role: 'owner', status: 'active' } ] }), {});
	ok(!findingFor(f, 'watchdog.no_active_admin'), 'an active owner satisfies the admin-present check');

	// ── over_privileged_user ──
	// A non-owner account that holds owner-level ('*') access — the shape a privilege-escalation or a direct
	// DB edit leaves behind — must be flagged.
	f = await Watchdog.run(makeShare({ users: [ { user_id: 'u1', username: 'esc', role: 'operator', status: 'active', grants: [ '*' ] } ] }), {});
	const over = findingFor(f, 'watchdog.over_privileged_user');
	ok(over && /esc/.test(over.detail), 'flags a non-owner account holding owner-level (*) access');
	ok(over && over.target === '1', 'reports exactly one over-privileged account');

	// A normal operator (role caps only) and a legitimate owner holding '*' are NOT flagged.
	f = await Watchdog.run(makeShare({ users: [
		{ user_id: 'u1', username: 'op',   role: 'operator', status: 'active' },
		{ user_id: 'u2', username: 'boss', role: 'owner',    status: 'active', grants: [ '*' ] }
	] }), {});
	ok(!findingFor(f, 'watchdog.over_privileged_user'), 'a normal operator and a legitimate owner are not flagged');

	// ── orphaned_open_deals ──

	// Every open deal maps to an existing bot → no finding.
	f = await Watchdog.run(makeShare({
		bots:  [ { botId: 'botA' }, { botId: 'botB' } ],
		deals: [ { dealId: 'd1', botId: 'botA' }, { dealId: 'd2', botId: 'botB' } ]
	}), {});
	ok(!findingFor(f, 'watchdog.orphaned_open_deals'), 'no orphan finding when every deal has its bot');

	// One deal references a deleted bot → finding naming that deal.
	f = await Watchdog.run(makeShare({
		bots:  [ { botId: 'botA' } ],
		deals: [ { dealId: 'd1', botId: 'botA' }, { dealId: 'd2', botId: 'ghostBot' } ]
	}), {});
	const orphan = findingFor(f, 'watchdog.orphaned_open_deals');
	ok(orphan && /d2/.test(orphan.detail), 'flags the open deal whose bot was deleted');
	ok(orphan && orphan.target === '1', 'reports exactly one orphaned deal');

	// No open deals → no finding (and no crash on empty input).
	f = await Watchdog.run(makeShare({ bots: [ { botId: 'botA' } ], deals: [] }), {});
	ok(!findingFor(f, 'watchdog.orphaned_open_deals'), 'no orphan finding when there are no open deals');

	// ── duplicate_open_deals_per_pair ──

	// Two open deals for the SAME bot + pair → finding (the single-deal-start gate allows only one).
	f = await Watchdog.run(makeShare({ deals: [
		{ dealId: 'd1', botId: 'botA', pair: 'BTC/USD' },
		{ dealId: 'd2', botId: 'botA', pair: 'BTC/USD' }
	] }), {});
	const dup = findingFor(f, 'watchdog.duplicate_open_deals');
	ok(dup && /BTC\/USD/.test(dup.detail), 'flags two open deals on the same bot + pair');

	// Same pair on DIFFERENT bots, and different pairs on the same bot → no finding.
	f = await Watchdog.run(makeShare({ deals: [
		{ dealId: 'd1', botId: 'botA', pair: 'BTC/USD' },
		{ dealId: 'd2', botId: 'botB', pair: 'BTC/USD' },
		{ dealId: 'd3', botId: 'botA', pair: 'ETH/USD' }
	] }), {});
	ok(!findingFor(f, 'watchdog.duplicate_open_deals'), 'no finding for the same pair on different bots or different pairs on one bot');

	// ── deal_missing_orders ──
	const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();   // 20 min ago (past the 10-min grace)
	const fresh = new Date(Date.now() - 60 * 1000).toISOString();      // 1 min ago (inside the grace)

	// An old open deal with NO filled orders → finding.
	f = await Watchdog.run(makeShare({ deals: [ { dealId: 'd1', botId: 'botA', pair: 'BTC/USD', date: old, orders: [] } ] }), {});
	const stuck = findingFor(f, 'watchdog.deal_missing_orders');
	ok(stuck && /d1/.test(stuck.detail), 'flags an old open deal that never filled an order');

	// A RECENT deal with no orders (mid-creation) → no finding, thanks to the grace window.
	f = await Watchdog.run(makeShare({ deals: [ { dealId: 'd2', botId: 'botA', pair: 'BTC/USD', date: fresh, orders: [] } ] }), {});
	ok(!findingFor(f, 'watchdog.deal_missing_orders'), 'a just-created deal (inside the grace window) is NOT flagged');

	// An old deal that HAS a filled order → no finding.
	f = await Watchdog.run(makeShare({ deals: [ { dealId: 'd3', botId: 'botA', pair: 'BTC/USD', date: old, orders: [ { filled: 1 } ] } ] }), {});
	ok(!findingFor(f, 'watchdog.deal_missing_orders'), 'a deal that has filled its base order is NOT flagged');

	// ── guide_present ──
	// The shipped docs/README.md exists in the tree, so the in-app Help guide check must NOT flag it.
	// (It reads the real file relative to Watchdog.js; a deployment missing docs/ would produce the finding.)
	f = await Watchdog.run(makeShare({ users: [] }), {});
	ok(!findingFor(f, 'watchdog.guide_missing'), 'the shipped in-app guide (docs/README.md) is present, so guide_present does not flag');
	ok(Watchdog.list().indexOf('guide_present') !== -1, 'guide_present is registered as a built-in check');

	// ── ai_read_only tool-name matcher (the safety net for the AI's read-only invariant) ──
	// Read-only tool names must NOT be flagged; any mutating verb (case-insensitive, in any segment) MUST be.
	// Critically, "open"/"trade" are NOUNS in real read-only tools (get_open_deals, list_open_deals, a trade
	// reader) and must NOT be treated as mutating — this pins the false-positive guard that a regression here hit.
	[ 'get_deals', 'list_bots', 'find_deal', 'count_orders', 'analyze_logs', 'get_balance', 'explore',
	  'get_open_deals', 'list_open_deals', 'find_newest_open_deals', 'get_open_orders_summary', 'get_trade_history' ]
		.forEach(n => ok(!Watchdog.isMutatingToolName(n), 'read-only tool "' + n + '" is not flagged'));

	[ 'create_deal', 'close_deal', 'cancel_order', 'place_order', 'execute_trade', 'modify_bot',
	  'submit_order', 'transfer_funds', 'withdraw_funds', 'set_config', 'stop_bot' ]
		.forEach(n => ok(Watchdog.isMutatingToolName(n), 'mutating tool "' + n + '" IS flagged'));

	// Case-insensitive: a capitalized mutating verb must still be caught.
	ok(Watchdog.isMutatingToolName('Place_Order'), 'matching is case-insensitive (Place_Order flagged)');
	ok(Watchdog.isMutatingToolName('EXECUTE_TRADE'), 'matching is case-insensitive (EXECUTE_TRADE flagged)');

	console.log('WatchdogChecks: ' + passed + ' assertions passed');
})();
