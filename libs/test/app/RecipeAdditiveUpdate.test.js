'use strict';

// ScheduleRecipes.computeAdditiveMerge — the non-destructive recipe update. When a shipped recipe gains a
// new setting (like the event-loop threshold), an existing install should adopt it WITHOUT losing anything
// it customized. These tests pin that: only genuinely-new setting keys are added (at their shipped defaults),
// a value the user tuned is never overwritten, the version/meta markers are refreshed so the "update
// available" flag clears, user-owned wiring (notifications) is never treated as a new parameter, and a
// fresh (empty) row receives every shipped setting.

const assert = require('assert');
const Recipes = require('../../app/ScheduleRecipes.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// A shipped recipe that gained `event_loop_lag_ms` since the user installed it.
const def = {
	id: 'core/x', name: 'X sentinel', description: 'desc', version: '1.1', requires_ai: false, ai_optional: false,
	settings: { disk_free_pct: 10, mem_free_pct: 10, cpu_busy_pct: 92, event_loop_lag_ms: 250, notifications: [ { type: 'browser' } ] }
};
// The user's installed row: on the old version, with a CUSTOMIZED cpu threshold and their own notifications.
const rowSettings = {
	disk_free_pct: 10, mem_free_pct: 10, cpu_busy_pct: 80,   // ← 80 is the user's tuned value
	recipe_id: 'core/x', recipe_version: '1.0', notifications: [ { type: 'telegram', target: { chat: '1' } } ]
};

console.log('\nScheduleRecipes.computeAdditiveMerge (additive, non-destructive update):');

const m = Recipes.computeAdditiveMerge(rowSettings, def);

test('adds only the genuinely-new setting, at its shipped default', () => {
	assert.strictEqual(m.patch.event_loop_lag_ms, 250);
	assert.deepStrictEqual(m.added.map(a => a.field), [ 'event_loop_lag_ms' ]);
	assert.strictEqual(m.added[0].to, 250);
});

test('NEVER overwrites a value the user customized', () => {
	assert.ok(!Object.prototype.hasOwnProperty.call(m.patch, 'cpu_busy_pct'), 'tuned cpu_busy_pct must not be in the merge patch');
	assert.ok(m.preserved.indexOf('cpu_busy_pct') >= 0, 'cpu_busy_pct is reported as preserved');
});

test('does not re-add settings the row already has', () => {
	assert.ok(!Object.prototype.hasOwnProperty.call(m.patch, 'disk_free_pct'));
	assert.ok(!Object.prototype.hasOwnProperty.call(m.patch, 'mem_free_pct'));
});

test('refreshes the version + provenance so the update flag clears', () => {
	assert.strictEqual(m.patch.recipe_version, '1.1');
	assert.strictEqual(m.patch.recipe_id, 'core/x');
	assert.strictEqual(m.patch.recipe_name, 'X sentinel');
});

test('never touches the user-owned notifications (not added, not in the patch)', () => {
	assert.ok(!Object.prototype.hasOwnProperty.call(m.patch, 'notifications'), 'notifications must be left to the merge to preserve');
	assert.strictEqual(m.added.filter(a => a.field === 'notifications').length, 0);
});

test('preserved lists the user\'s real settings, excluding meta/notifications', () => {
	const p = m.preserved.slice().sort();
	assert.deepStrictEqual(p, [ 'cpu_busy_pct', 'disk_free_pct', 'mem_free_pct' ]);
});

test('a fresh (empty) row receives every shipped setting', () => {
	const m2 = Recipes.computeAdditiveMerge({}, def);
	assert.deepStrictEqual(m2.added.map(a => a.field).sort(), [ 'cpu_busy_pct', 'disk_free_pct', 'event_loop_lag_ms', 'mem_free_pct' ]);
	assert.deepStrictEqual(m2.preserved, []);
});

test('never throws on odd input', () => {
	assert.doesNotThrow(() => Recipes.computeAdditiveMerge(null, def));
	assert.doesNotThrow(() => Recipes.computeAdditiveMerge({}, {}));
	assert.doesNotThrow(() => Recipes.computeAdditiveMerge(undefined, undefined));
});

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
