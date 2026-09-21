'use strict';

// Tests the capability-drift Watchdog check: an active API key whose capabilities exceed what its
// current owner could grant is flagged. Uses the real Authz/Users.toPrincipal with mocked DB accessors.

const assert = require('assert');
const Watchdog = require('../../app/Watchdog.js');
const Users = require('../../app/Users.js');   // toPrincipal is pure (no DB / no init needed)

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const mockUsers = [
	{ user_id: 'owner1',  role: 'owner',  grants: [] },
	{ user_id: 'viewer1', role: 'viewer', grants: [] }
];

const mockKeys = [
	{ key_id: 'kA', name: 'ownerKey',  owner_user_id: 'owner1',  capabilities: [ 'bot.write' ], status: 'active' },   // owner can grant → no drift
	{ key_id: 'kB', name: 'viewerKey', owner_user_id: 'viewer1', capabilities: [ 'bot.write' ], status: 'active' },   // viewer cannot → DRIFT
	{ key_id: 'kC', name: 'orphanKey', owner_user_id: 'gone',    capabilities: [ 'bot.read' ],  status: 'active' },   // owner removed → DRIFT
	{ key_id: 'kD', name: 'internal',  owner_user_id: 'system',  capabilities: [ '*' ],          status: 'active', is_internal: true }, // skipped
	{ key_id: 'kE', name: 'revoked',   owner_user_id: 'viewer1', capabilities: [ '*' ],          status: 'revoked' }, // skipped (not active)
	{ key_id: 'kF', name: 'starViewer',owner_user_id: 'viewer1', capabilities: [ '*' ],          status: 'active' },  // viewer with '*' → DRIFT
	{ key_id: 'kG', name: 'operatorKey',owner_user_id: 'owner',  capabilities: [ 'bot.write' ], status: 'active' }   // reserved 'owner' (implicit single-operator) → NOT drift
];

const shareData = {
	Authz: require('../../app/Authz.js'),
	ApiKeys: { listRaw: async () => mockKeys },
	Users:   { listRaw: async () => mockUsers, toPrincipal: Users.toPrincipal }
};

(async () => {

	const findings = await Watchdog.run(shareData, {});
	const drift = findings.filter(f => f.action === 'watchdog.capability_drift');

	ok(drift.length === 1, 'exactly one capability_drift finding emitted');

	const detail = drift[0].detail;
	ok(/viewerKey/.test(detail), 'flags the viewer-owned key that holds bot.write');
	ok(/orphanKey \(owner removed\)/.test(detail), 'flags the key whose owner was removed');
	ok(/starViewer/.test(detail), "flags the viewer-owned key holding '*'");
	ok(!/ownerKey/.test(detail), 'does NOT flag the owner-owned key (owner can grant it)');
	ok(!/internal/.test(detail), 'skips the internal signals key');
	ok(!/revoked/.test(detail), 'skips a non-active (revoked) key');
	ok(!/operatorKey/.test(detail), "does NOT flag a key owned by the reserved 'owner' implicit operator");
	ok(drift[0].target === '3', 'target count is 3 drifted keys');

	console.log('CapabilityDrift: ' + passed + ' assertions passed');
})();
