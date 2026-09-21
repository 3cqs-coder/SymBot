'use strict';

// Route permission coverage — a dev-time guard that every data-changing route is gated by the access-control
// map (or an inline capability guard). It builds the REAL router and runs the SAME auditCoverage the boot
// Watchdog runs, so a newly-added mutating route that forgot its permission is caught HERE, in the suite,
// before it can ship — not only at runtime on a production boot. (This test exists because exactly that
// slipped through once: a new POST route was added without a RoutePermissions rule.)
//
// Registration only closes over shareData/upload; no handler is invoked, so a minimal stub is enough.

const assert = require('assert');
const express = require('express');
const RP = require('../../app/RoutePermissions.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const noop = (req, res, next) => next();
const upload = { single: () => noop, array: () => noop, none: () => noop, fields: () => noop };

// Build the real INSTANCE router.
const Routes = require('../../webserver/routes.js');
Routes.init({ appData: {} });
const instanceRouter = express.Router();
Routes.start(instanceRouter, upload);

console.log('\nRoute permission coverage (every mutating route must be gated):');

test('instance router registered its routes', () => {
	assert.ok((instanceRouter.stack || []).length > 0, 'no routes registered — the test is not exercising the real router');
});

test('no instance mutating route is missing a permission gate (matches the boot Watchdog)', () => {
	const uncovered = RP.auditCoverage(instanceRouter);
	assert.deepStrictEqual(uncovered, [],
		'these data-changing routes have no permission gate — add each to libs/app/RoutePermissions.js RULES (or an inline cap() guard): ' + JSON.stringify(uncovered));
});

// Build and audit the real HUB router too — the Hub runs the same Watchdog, so its routes must be gated as
// well. (Hub route registration takes only the router; it uses no upload middleware.)
const HubRoutes = require('../../webserver/Hub/routes.js');
if (HubRoutes.init) { HubRoutes.init({ appData: {} }); }
const hubRouter = express.Router();
HubRoutes.start(hubRouter);

test('hub router registered its routes', () => {
	assert.ok((hubRouter.stack || []).length > 0, 'no Hub routes registered — the test is not exercising the real Hub router');
});

test('no hub mutating route is missing a permission gate (matches the boot Watchdog)', () => {
	const uncovered = RP.auditCoverage(hubRouter);
	assert.deepStrictEqual(uncovered, [],
		'these Hub data-changing routes have no permission gate — add each to libs/app/RoutePermissions.js RULES (or an inline cap() guard): ' + JSON.stringify(uncovered));
});

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
