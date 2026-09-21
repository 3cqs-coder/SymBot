'use strict';

// Recipe version lock — a dev-time guardrail against a silent recipe change.
//
// A shipped recipe carries a `version`, and the app only prompts an existing install to adopt changes when
// that version moves. So editing a recipe's content (settings, cron, description, …) WITHOUT bumping its
// version is a real mistake: those installs are never told, and never offered the new default. This test
// records a content fingerprint (hash of everything EXCEPT `version`) of every shipped recipe in a committed
// lock, and fails if a recipe's content changed while its version stayed the same — telling the developer to
// bump the version. It is a test, not a runtime Watchdog, because only a developer can act on it (an operator
// cannot change shipped code), so surfacing it at runtime would be noise.
//
// Workflow after intentionally changing a recipe:
//   1. bump the recipe's "version" in its .json (if you changed its content), then
//   2. run:  node libs/test/app/RecipeVersionLock.test.js --update
// to refresh the lock, and commit both.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Recipes = require('../../app/ScheduleRecipes.js');

const LOCK_PATH = path.join(__dirname, 'recipe-lock.json');

function currentFingerprints() {
	const out = {};
	for (const def of Recipes.listShipped()) {
		out[def.id] = { version: String(def.version || '1.0'), hash: Recipes.recipeContentHash(def) };
	}
	return out;
}

// --update / --relock: regenerate the lock from the recipes on disk.
if (process.argv.includes('--update') || process.argv.includes('--relock')) {
	const fp = currentFingerprints();
	fs.writeFileSync(LOCK_PATH, JSON.stringify(fp, null, 2) + '\n');
	console.log('recipe-lock.json regenerated with ' + Object.keys(fp).length + ' recipe(s).');
	process.exit(0);
}

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

let lock = null;
try { lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); } catch (e) { lock = null; }

console.log('\nRecipe version lock (a content change must bump the recipe version):');

test('the lock exists — run this test with --update to create/refresh it', () => {
	assert.ok(lock && typeof lock === 'object', 'recipe-lock.json missing or unreadable');
});

const cur = currentFingerprints();

for (const id of Object.keys(cur)) {
	test('recipe "' + id + '" is unchanged since its lock (or its version was bumped)', () => {
		const l = lock && lock[id];
		assert.ok(l, 'recipe "' + id + '" is not in the lock — run --update to record it');

		if (cur[id].hash !== l.hash) {
			if (cur[id].version === l.version) {
				assert.fail('recipe "' + id + '" CONTENT changed but its version is still ' + cur[id].version +
					'. Bump "version" in its .json so existing installs are prompted, then run --update to refresh the lock.');
			}
			assert.fail('recipe "' + id + '" changed and its version moved ' + l.version + ' → ' + cur[id].version +
				'. Run --update to refresh the lock, then commit it.');
		}

		assert.strictEqual(cur[id].version, l.version,
			'recipe "' + id + '" version changed ' + l.version + ' → ' + cur[id].version + ' with no content change — run --update to refresh the lock.');
	});
}

for (const id of Object.keys(lock || {})) {
	if (!cur[id]) {
		test('lock entry "' + id + '" still ships', () => {
			assert.fail('recipe "' + id + '" is in the lock but no longer shipped — run --update to refresh the lock.');
		});
	}
}

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
