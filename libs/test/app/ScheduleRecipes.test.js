'use strict';

// Tests the recipe seeder + library surface: shipped recipes are discovered, imported ONCE as
// disabled rows, never re-imported over a row the user owns, exposed as a catalog annotated with
// what's added, and addable on demand. No DB — a fake Scheduler captures add() calls and a growing
// row list mimics persistence. (Tombstone PERSISTENCE across restart is verified live in the browser
// + a direct DB check, since it needs Mongo; here markRemoved/clearRemoved degrade to no-ops.)

const assert = require('assert');
const ScheduleRecipes = require('../../app/ScheduleRecipes.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; console.log('  ok   - ' + m); }

function fakeScheduler() {
	const rows = [];
	return {
		rows,
		list: async () => ({ schedules: rows.slice() }),
		add: async (data) => {
			const row = Object.assign({ schedule_id: 'id_' + rows.length }, data);
			rows.push(row);
			return { success: true, schedule: row };
		},
		update: async (scheduleId, data) => {
			const row = rows.filter(r => r.schedule_id === scheduleId)[0];
			if (!row) { return { success: false, error: 'not found' }; }
			if (data.kind != null) { row.kind = data.kind; }
			if (data.cron != null) { row.cron = data.cron; }
			if (data.label != null) { row.label = data.label; }
			if (data.settings && typeof data.settings === 'object') {
				// mirror the real Scheduler: replace when replaceSettings, else merge; enabled untouched
				row.settings = data.replaceSettings === true ? Object.assign({}, data.settings) : Object.assign({}, row.settings || {}, data.settings);
			}
			return { success: true, schedule: row };
		}
	};
}
function shareDataWith(sched) {
	return { Scheduler: sched, Common: { logger: () => {}, makeLogger: () => () => {} }, appData: { server_id: 'test-instance' } };
}

(async () => {

	const shipped = ScheduleRecipes.listShipped();
	ok(shipped.length >= 1, 'at least one shipped recipe is discovered');
	const watchdog = shipped.filter(r => r.id === 'core/watchdog-error-scanner')[0];
	ok(!!watchdog, 'the watchdog recipe ships');
	ok(watchdog.type === 'error_watchdog' && watchdog.enabled === false, 'watchdog recipe targets error_watchdog and defaults disabled');

	// ── seed ──
	const sched = fakeScheduler();
	ScheduleRecipes.init(shareDataWith(sched));

	const r1 = await ScheduleRecipes.seed();
	ok(r1.seeded === shipped.length, 'first seed imports all shipped recipes (' + r1.seeded + ')');
	const findRow = (id) => sched.rows.filter(r => r.settings && r.settings.recipe_id === id)[0];
	const row = findRow('core/watchdog-error-scanner');
	ok(!!row && row.enabled === false, 'imported watchdog row is disabled (opt-in)');
	ok(row.type === 'error_watchdog', 'imported row carries the recipe type');
	ok(row.settings.target_days === 1 && row.settings.baseline_days === 3, 'imported row carries the recipe default settings');

	const r2 = await ScheduleRecipes.seed();
	ok(r2.seeded === 0 && r2.skipped === shipped.length, 'second seed is idempotent (imports 0, skips existing)');

	// user changes a preference + enables → a later seed never overwrites it
	row.settings.baseline_days = 7; row.enabled = true;
	await ScheduleRecipes.seed();
	ok(row.settings.baseline_days === 7 && row.enabled === true, 'the user\'s preferences survive re-seed');

	// ── catalog ──
	const cat = await ScheduleRecipes.catalog();
	const c = cat.filter(x => x.id === 'core/watchdog-error-scanner')[0];
	ok(!!c && c.added === true && c.available === false, 'catalog marks an imported recipe as added / not available');
	ok(Array.isArray(c.categories), 'catalog entry exposes categories for discovery');

	// ── addFromLibrary on a fresh instance (nothing imported yet) ──
	const sched2 = fakeScheduler();
	ScheduleRecipes.init(shareDataWith(sched2));
	const catBefore = await ScheduleRecipes.catalog();
	ok(catBefore[0].added === false && catBefore[0].available === true, 'on a fresh instance the recipe is available to add');
	const add = await ScheduleRecipes.addFromLibrary('core/watchdog-error-scanner');
	ok(add && add.success, 'addFromLibrary succeeds');
	ok(sched2.rows.length === 1 && sched2.rows[0].settings.recipe_id === 'core/watchdog-error-scanner' && sched2.rows[0].enabled === false, 'addFromLibrary creates one disabled row with provenance');
	const addAgain = await ScheduleRecipes.addFromLibrary('core/watchdog-error-scanner');
	ok(addAgain && addAgain.success && sched2.rows.length === 1, 'adding an already-present recipe is a no-op (no duplicate row)');
	const unknown = await ScheduleRecipes.addFromLibrary('core/does-not-exist');
	ok(unknown && unknown.success === false, 'adding an unknown recipe fails gracefully');

	// ── resetToDefaults (Layer-2 "reset" override) ──
	// The imported row from sched2 above. User diverges its schedule + a parameter + notifications + enabled,
	// then resets: the recipe BODY (cron/label/params) returns to shipped, while the user's notifications and
	// enabled state are preserved, and stale user-added keys are dropped.
	const rrow = sched2.rows[0];
	const shippedDef = ScheduleRecipes.listShipped().filter(r => r.id === 'core/watchdog-error-scanner')[0];
	rrow.cron = '15 6 * * 1';
	rrow.label = 'My custom name';
	rrow.enabled = true;
	rrow.settings.baseline_days = 99;
	rrow.settings.stale_extra_key = 'leftover';
	rrow.settings.notifications = [ { type: 'telegram', target: { chatId: 'g1' }, on: [ 'always' ] } ];

	const rr = await ScheduleRecipes.resetToDefaults('core/watchdog-error-scanner');
	ok(rr && rr.success, 'resetToDefaults succeeds on an imported recipe');
	ok(rrow.cron === (shippedDef.cron || '0 * * * *') && rrow.label === shippedDef.name, 'reset restores the shipped schedule + label');
	ok(rrow.settings.baseline_days === shippedDef.settings.baseline_days, 'reset restores shipped parameters');
	ok(rrow.settings.stale_extra_key === undefined, 'reset drops stale user-added settings keys (clean replace)');
	ok(Array.isArray(rrow.settings.notifications) && rrow.settings.notifications[0].type === 'telegram', 'reset PRESERVES the user\'s notification destinations');
	ok(rrow.enabled === true, 'reset PRESERVES the user\'s enabled state');
	ok(rrow.settings.recipe_id === 'core/watchdog-error-scanner', 'reset keeps the recipe provenance stamp');

	const rrMissing = await ScheduleRecipes.resetToDefaults('core/does-not-exist');
	ok(rrMissing && rrMissing.success === false, 'resetToDefaults on an unknown recipe fails gracefully');

	// ── computeUpdateChanges (pure diff-on-update) ─────────────────────────────
	// A synthetic installed row vs a shipped definition. The diff must surface changed schedule
	// fields and changed/added/removed recipe parameters, while IGNORING provenance/meta and the
	// user-owned notification wiring.
	const cdRow = {
		cron: '0 * * * *', kind: 'cron', run_at: null, label: 'Old Label',
		settings: {
			recipe_id: 'x', recipe_name: 'X', recipe_version: '1.0', requires_ai: false, ai_optional: false,
			notifications: [ { type: 'telegram' } ],   // user-owned → must be ignored
			baseline_days: 7,                            // changed
			threshold: 5,                                // unchanged
			removed_key: 'gone'                          // present in row, absent in shipped → removed
		}
	};
	const cdDef = {
		id: 'x', name: 'New Label', version: '1.1', cron: '*/30 * * * *', kind: 'cron',
		settings: {
			recipe_id: 'x', recipe_name: 'X', recipe_version: '1.1', requires_ai: false, ai_optional: false,
			notifications: [],                           // different, but ignored (preserved on reset)
			baseline_days: 14,                           // changed 7 → 14
			threshold: 5,                                // unchanged
			added_key: 'new'                             // absent in row, present in shipped → added
		}
	};

	const cd = ScheduleRecipes.computeUpdateChanges(cdRow, cdDef);
	const byField = {}; cd.changes.forEach(c => { byField[c.field] = c; });

	ok(!cd.changes.some(c => c.field === 'notifications'), 'diff IGNORES the user-owned notifications key');
	ok(!cd.changes.some(c => c.field === 'recipe_version'), 'diff ignores the recipe_version bookkeeping key');
	ok(!cd.changes.some(c => c.field === 'threshold'), 'an unchanged parameter is not reported');
	ok(byField['cron'] && byField['cron'].scope === 'schedule' && byField['cron'].to === '*/30 * * * *', 'a changed cron is flagged as a schedule change');
	ok(byField['label'] && byField['label'].to === 'New Label', 'a changed label is flagged');
	ok(byField['baseline_days'] && byField['baseline_days'].from === 7 && byField['baseline_days'].to === 14, 'a changed parameter shows from → to');
	ok(byField['removed_key'] && byField['removed_key'].to === null, 'a parameter dropped in the new version shows to=null');
	ok(byField['added_key'] && byField['added_key'].from === null && byField['added_key'].to === 'new', 'a parameter added in the new version shows from=null');

	// Identical row/def → no changes at all.
	const cdSame = ScheduleRecipes.computeUpdateChanges(cdDef.settings ? { cron: cdDef.cron, kind: 'cron', run_at: null, label: cdDef.name, settings: cdDef.settings } : {}, cdDef);
	ok(cdSame.changes.length === 0, 'an already-up-to-date row produces an empty diff');

	console.log('\nScheduleRecipes: ' + passed + ' assertions passed');
	process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });