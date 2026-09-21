'use strict';

// Recipe → handler coverage — a dev-time guard that every shipped recipe's `type` is actually backed by a
// registered scheduler handler. Without this, a recipe whose type is misspelled, or whose handler was renamed
// or never registered, would look fine until a user adds and runs it — then fail with "no handler for type".
//
// It discovers handlers by scanning libs/scheduledtasks/ and calling each module's register() with a stub
// scheduler (register() only calls scheduler.registerHandler at registration time; the real shareData is
// captured for later use inside the handler and is untouched here, so an empty stub is enough). It then asserts
// every recipe returned by ScheduleRecipes.listShipped() names a type in that discovered set. New handlers and
// new recipes are both picked up automatically, so the guard stays correct as the library grows.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Recipes = require('../../app/ScheduleRecipes.js');

const HANDLER_DIR = path.join(__dirname, '..', '..', 'scheduledtasks');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// Collect every job type a scheduledtasks handler registers.
const handlerTypes = new Set();
const stubScheduler = { registerHandler: (type) => { if (type) { handlerTypes.add(type); } } };

for (const file of fs.readdirSync(HANDLER_DIR)) {
	if (!file.endsWith('.js')) { continue; }
	let mod;
	try { mod = require(path.join(HANDLER_DIR, file)); }
	catch (e) { continue; }   // a module that fails to load is a separate problem; other tests cover loading
	if (mod && typeof mod.register === 'function') {
		try { mod.register(stubScheduler, {}); }
		catch (e) { /* not counted here — a handler that needs more than this stub at register time would drop out, which can turn the per-recipe assertions below into a false FAILURE (never a false pass); if that happens, give this stub what the handler needs */ }
	}
}

console.log('\nRecipe → handler coverage (every shipped recipe type must have a registered handler):');

test('at least one handler type was discovered (the scan works)', () => {
	assert.ok(handlerTypes.size > 0, 'no scheduledtasks handler types were discovered — the scan or register() contract changed');
});

test('the performance_report handler is registered (this cycle\'s addition)', () => {
	assert.ok(handlerTypes.has('performance_report'), 'performance_report handler not registered');
});

const shipped = Recipes.listShipped();

test('there is at least one shipped recipe to check', () => {
	assert.ok(Array.isArray(shipped) && shipped.length > 0, 'no shipped recipes discovered');
});

for (const def of shipped) {
	test('recipe "' + def.id + '" (type "' + def.type + '") is backed by a registered handler', () => {
		assert.ok(handlerTypes.has(def.type),
			'no scheduledtasks handler registers type "' + def.type + '" — register a handler for it (in symbot.js) or fix the recipe\'s type. Discovered types: ' + [ ...handlerTypes ].join(', '));
	});
}

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
