'use strict';

// Drift-guard for the unified Access Control routes. The API-key CRUD, user management, and the audit log are
// SECURITY-SENSITIVE authorization endpoints that used to be copied into both the instance and Hub route files
// (where the capability guards, the privilege-bounding on user creation, and the audit-event names could
// drift). They now live once in libs/webserver/sharedRoutes.js and are registered on BOTH surfaces. This test
// builds the REAL instance and Hub routers and asserts every shared Access Control route is present on each,
// exactly once (a leftover per-surface copy would register it twice), so the unification can't silently regress
// — either by a route disappearing from one surface or by a duplicate creeping back in.

const assert = require('assert');
const express = require('express');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

const noop = (req, res, next) => next();
const upload = { single: () => noop, array: () => noop, none: () => noop, fields: () => noop };

// Collect { "METHOD path": count } from a built router's stack.
function routeCounts(router) {
	const counts = {};
	for (const layer of (router.stack || [])) {
		if (!layer.route) { continue; }
		const path = layer.route.path;
		for (const m of Object.keys(layer.route.methods || {})) {
			if (!layer.route.methods[m]) { continue; }
			const key = m.toUpperCase() + ' ' + path;
			counts[key] = (counts[key] || 0) + 1;
		}
	}
	return counts;
}

// The routes now single-sourced in sharedRoutes.js (must appear on BOTH surfaces). Includes the Access
// Control CRUD plus the authentication routes (/login GET+POST and /logout) that were unified into
// sharedRoutes so the instance and Hub can never drift on them.
const SHARED_ACCESS_ROUTES = [
	'GET /api/keys',
	'POST /api/keys',
	'POST /api/keys/:id/rotate',
	'POST /api/keys/:id/status',
	'GET /api/users',
	'POST /api/users',
	'POST /api/users/:id/role',
	'POST /api/users/:id/status',
	'GET /api/audit',
	'GET /login',
	'POST /login',
	'GET /logout'
];

// Build the real instance router.
const Routes = require('../../webserver/routes.js');
Routes.init({ appData: {} });
const instanceRouter = express.Router();
Routes.start(instanceRouter, upload);
const instanceCounts = routeCounts(instanceRouter);

// Build the real Hub router.
const HubRoutes = require('../../webserver/Hub/routes.js');
if (HubRoutes.init) { HubRoutes.init({ appData: {} }); }
const hubRouter = express.Router();
HubRoutes.start(hubRouter);
const hubCounts = routeCounts(hubRouter);

console.log('\nShared Access Control routes present exactly once on both surfaces:');

for (const r of SHARED_ACCESS_ROUTES) {
	ok(instanceCounts[r] === 1, 'instance registers "' + r + '" exactly once (got ' + (instanceCounts[r] || 0) + ')');
	ok(hubCounts[r] === 1, 'Hub registers "' + r + '" exactly once (got ' + (hubCounts[r] || 0) + ')');
}

// The instance-only key routes must remain ONLY on the instance (they were never on the Hub).
const INSTANCE_ONLY = [ 'POST /api/keys/:id/ip', 'POST /api/keys/:id/expiry', 'GET /api/client-ip', 'GET /api/diagnostics' ];
for (const r of INSTANCE_ONLY) {
	ok(instanceCounts[r] === 1, 'instance keeps its own "' + r + '"');
	ok(!hubCounts[r], 'Hub does not have the instance-only "' + r + '"');
}

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
process.exit(failed ? 1 : 0);
