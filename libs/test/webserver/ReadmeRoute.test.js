'use strict';

// In-app Help route coverage — the Help panel fetches ./readme.md and renders the shipped guide client-side, so
// BOTH the instance router and the Hub router must expose that GET route, and the single file they serve
// (docs/README.md) must actually exist. This test builds the REAL routers (the same way RouteCoverage does) and
// asserts the route is wired on each, so a refactor that drops it — leaving the Help button fetching a 404 — is
// caught here rather than by a user opening the guide.
//
// Registration only closes over shareData/upload; no handler is invoked, so a minimal stub is enough.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const express = require('express');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const noop = (req, res, next) => next();
const upload = { single: () => noop, array: () => noop, none: () => noop, fields: () => noop };

// Does the router register a GET handler for the given path?
function hasGet(router, routePath) {
	return (router.stack || []).some((layer) => {
		const r = layer && layer.route;
		return r && r.path === routePath && r.methods && r.methods.get;
	});
}

// Build the real INSTANCE router.
const Routes = require('../../webserver/routes.js');
Routes.init({ appData: {} });
const instanceRouter = express.Router();
Routes.start(instanceRouter, upload);

// Build the real HUB router.
const HubRoutes = require('../../webserver/Hub/routes.js');
if (HubRoutes.init) { HubRoutes.init({ appData: {} }); }
const hubRouter = express.Router();
HubRoutes.start(hubRouter);

console.log('\nIn-app Help route (the guide the Help panel fetches):');

test('instance router serves GET /readme.md', () => {
	assert.ok(hasGet(instanceRouter, '/readme.md'), 'the instance Help route is missing — the Help panel would fetch a 404');
});

test('hub router serves GET /readme.md', () => {
	assert.ok(hasGet(hubRouter, '/readme.md'), 'the Hub Help route is missing — the Help panel would fetch a 404');
});

test('the shipped guide file exists (docs/README.md)', () => {
	const readme = path.join(__dirname, '..', '..', '..', 'docs', 'README.md');
	assert.ok(fs.existsSync(readme), 'docs/README.md not found — the Help route would serve a 404');
	assert.ok(fs.statSync(readme).size > 0, 'docs/README.md is empty');
});

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
