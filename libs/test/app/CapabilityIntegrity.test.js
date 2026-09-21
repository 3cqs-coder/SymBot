'use strict';

// Capability-name integrity — every capability string referenced by the route-permission RULES, the
// per-action capability maps (ACTION_CAPS), and the role bundles (ROLE_CAPS) MUST be a real capability in the
// Authz catalog. A typo such as "bot.wrte" slips past every other guard: the route is still "gated" (so
// RouteCoverage passes), it does not end in ".read" (so auditGateStrength passes), and it is not a
// "watchdog.*" code (so Diagnostics ignores it). At runtime an owner's "*" grant still matches, so manual
// testing looks fine — but a scoped operator who legitimately holds the REAL capability is silently denied,
// or a role literal typo silently strips that role of a permission. This test pins the whole class at dev time.
//
// (DCABotManager.js has its own small inline action→cap map for the DCA action path; it uses only deal.create
// and deal.close. It lives in the frozen money-path file and is not exported, so it is not imported here — its
// two capabilities are catalog members and are covered by manual review.)

const assert = require('assert');
const Authz = require('../../app/Authz.js');
const RP = require('../../app/RoutePermissions.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const keys = new Set(Authz.CAPABILITY_KEYS || []);
const resources = new Set(Authz.RESOURCES || []);

// A capability reference is valid if it is the wildcard "*", an exact catalog key, or a "resource.*" grant
// form whose resource exists — matching how Authz.grantSatisfies interprets a grant.
function isValidCap(cap) {
	if (cap === '*') { return true; }
	if (typeof cap !== 'string' || cap === '') { return false; }
	if (keys.has(cap)) { return true; }
	if (cap.endsWith('.*')) { return resources.has(cap.slice(0, -2)); }
	return false;
}

console.log('\nCapability-name integrity (every referenced cap exists in the Authz catalog):');

test('the capability catalog is non-empty', () => {
	assert.ok(keys.size > 0, 'Authz.CAPABILITY_KEYS is empty — catalog not loaded');
});

test('every RoutePermissions RULES capability is a catalog capability', () => {
	const bad = (RP.RULES || []).filter(r => r && !isValidCap(r.cap)).map(r => (r.m || '?') + ' ' + String(r.re) + ' -> ' + r.cap);
	assert.deepStrictEqual(bad, [], 'unknown capability in RULES (add it to Authz or fix the typo): ' + JSON.stringify(bad));
});

test('every ACTION_CAPS capability is a catalog capability', () => {
	const bad = [];
	const AC = RP.ACTION_CAPS || {};
	for (const group of Object.keys(AC)) {
		const m = AC[group] || {};
		for (const action of Object.keys(m)) { if (!isValidCap(m[action])) { bad.push(group + '.' + action + ' -> ' + m[action]); } }
	}
	assert.deepStrictEqual(bad, [], 'unknown capability in ACTION_CAPS: ' + JSON.stringify(bad));
});

test('every ROLE_CAPS capability is a catalog capability', () => {
	const bad = [];
	const RC = Authz.ROLE_CAPS || {};
	for (const role of Object.keys(RC)) {
		for (const cap of (RC[role] || [])) { if (!isValidCap(cap)) { bad.push(role + ' -> ' + cap); } }
	}
	assert.deepStrictEqual(bad, [], 'unknown capability in ROLE_CAPS: ' + JSON.stringify(bad));
});

console.log('\nCapabilityIntegrity: ' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
