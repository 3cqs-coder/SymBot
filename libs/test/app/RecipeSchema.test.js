'use strict';

// Shipped-recipe schema validity — a dev-time guard that every recipe JSON under libs/app/data/recipes/ is
// not just parseable with an id+type (auditRecipeIntegrity already checks that, and RecipeHandlerCoverage
// checks the type has a handler) but that the fields the scheduler and notifier actually consume are VALID.
// A recipe can pass the existing checks yet silently misbehave once a user adds it:
//   * a bad cron string makes Scheduler.arm() reject it, so the seeded task never fires;
//   * a notification "type" the notifier does not understand seeds fine and then never delivers;
//   * an "on" value outside the vocabulary never matches, so that channel is silently inert;
//   * a bogus/too-high min_symbot_version is a decorative field that reads as a real gate.
// This test pins all of that at dev time. All shipped recipes pass today, so it is preventive.

const assert = require('assert');
const cron = require('node-cron');
const Recipes = require('../../app/ScheduleRecipes.js');
const Notifications = require('../../app/Notifications.js');
const appVersion = require('../../../package.json').version;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// Channel types the notifier can actually deliver: the UI-offered set plus webhook (both documented in
// ScheduleNotifier). The "on" condition vocabulary mirrors ScheduleNotifier.conditionMatches.
const VALID_CHANNELS = new Set([].concat(Notifications.CHANNELS || [], [ 'webhook' ]));
const VALID_ON = new Set([ 'always', 'success', 'failure', 'missed' ]);

const shipped = Recipes.listShipped();

console.log('\nShipped-recipe schema validity:');

test('there is at least one shipped recipe', () => {
	assert.ok(Array.isArray(shipped) && shipped.length > 0, 'no shipped recipes discovered');
});

for (const def of shipped) {
	const id = (def && def.id) || '(no id)';

	test('recipe "' + id + '" has the required identity + description fields', () => {
		assert.ok(def.id && typeof def.id === 'string', 'missing id');
		assert.ok(def.type && typeof def.type === 'string', 'missing type');
		assert.ok(def.name && typeof def.name === 'string', 'missing name');
		assert.ok(def.description && typeof def.description === 'string', 'missing description');
	});

	test('recipe "' + id + '" has boolean AI flags where present', () => {
		if ('requires_ai' in def) { assert.strictEqual(typeof def.requires_ai, 'boolean', 'requires_ai must be boolean'); }
		if ('ai_optional' in def) { assert.strictEqual(typeof def.ai_optional, 'boolean', 'ai_optional must be boolean'); }
	});

	test('recipe "' + id + '" declares a valid min_symbot_version not newer than the app', () => {
		assert.ok(def.min_symbot_version, 'min_symbot_version is missing (it reads as a real gate, so keep it accurate)');
		assert.ok(/^\d+(\.\d+)*$/.test(String(def.min_symbot_version)), 'min_symbot_version is not a dotted version: ' + def.min_symbot_version);
		assert.ok(Recipes.compareVersions(def.min_symbot_version, appVersion) <= 0,
			'min_symbot_version ' + def.min_symbot_version + ' is newer than the app version ' + appVersion + ' — it would never seed on this build');
	});

	test('recipe "' + id + '" has a valid cron (when kind is cron)', () => {
		if (def.kind === 'cron') {
			assert.ok(typeof def.cron === 'string' && def.cron !== '', 'a cron recipe needs a cron string');
			assert.ok(cron.validate(def.cron), 'invalid cron expression "' + def.cron + '" — the scheduler would refuse to arm it');
		}
	});

	test('recipe "' + id + '" notifications use known channel types and conditions', () => {
		const notes = (def.settings && Array.isArray(def.settings.notifications)) ? def.settings.notifications : [];
		for (const n of notes) {
			assert.ok(n && VALID_CHANNELS.has(n.type), 'unknown notification channel type "' + (n && n.type) + '" (would never deliver)');
			for (const cond of (Array.isArray(n.on) ? n.on : [])) {
				assert.ok(VALID_ON.has(cond), 'unknown notification condition "' + cond + '" (would never match)');
			}
		}
	});
}

console.log('\nRecipeSchema: ' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
