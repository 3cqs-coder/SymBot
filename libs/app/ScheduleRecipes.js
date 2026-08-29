'use strict';


// Recipe catalog (Layer 1: shipped, read-only defaults) + import-on-start seeder + the per-instance
// override store (Layer 2: tombstones) that makes add / remove / re-add durable.
//
// Pre-defined "recipe" tasks ship as JSON definitions under data/recipes/ — inert DATA that
// references a vetted, built-in scheduler handler `type` (e.g. 'error_watchdog') plus its settings.
// A recipe never carries executable code; the code lives only in the handler for its type, in libs/.
//
// On start each shipped recipe is imported ONCE into a user-owned schedule row (idempotent by its
// stable `id`, scoped to this instance), seeded DISABLED so a fresh import never runs until the user
// opts in. After import the row is ordinary user data they fully manage.
//
// Deleting a pre-defined recipe writes a TOMBSTONE (recipe_state, server_id-scoped) so the seeder
// does not re-create it on the next boot — the delete sticks. Re-adding it from the library clears
// the tombstone and creates a fresh disabled row. A shipped-recipe upgrade never overwrites an
// existing user row (seed is import-if-absent); only the fixed handler logic updates automatically.


const fs = require('fs');
const path = require('path');

const RecipeStateDB = require('../mongodb/RecipeStateSchema');

const RECIPES_DIR = path.join(__dirname, 'data', 'recipes');

let shareData;

function init(obj) {

	shareData = obj;
	logger = obj.Common.makeLogger('');   // messages already carry the "ScheduleRecipes:" prefix

	// Self-policing: a shipped recipe file that fails to parse (or lacks id/type) is silently skipped
	// by listShipped so one bad file can't crash boot — but that means it just quietly vanishes from
	// the library. Register a Watchdog check so a broken recipe file is surfaced at boot instead.
	if (obj && obj.Watchdog && typeof obj.Watchdog.register === 'function') {
		obj.Watchdog.register('recipe_file_integrity', auditRecipeIntegrity);
	}
}

function serverId() { return (shareData && shareData.appData && shareData.appData.server_id) || ''; }

// Whether a recipe's task USES AI (makes model calls). Declared per-recipe via `requires_ai`;
// defaults to true only for the ai_analysis type (a user prompt run through the model). Deterministic
// tasks like the error watchdog are false — they work with no AI provider configured at all.
function recipeUsesAI(def) {
	if (def && typeof def.requires_ai === 'boolean') { return def.requires_ai; }
	return !!(def && def.type === 'ai_analysis');
}

let logger = function () {};   // assigned in init() via Common.makeLogger


// Integrity check (Watchdog): flag any shipped recipe FILE that fails to parse or lacks the required
// id/type. listShipped drops these silently (so boot survives a bad file) — this makes the loss
// visible. Returns Watchdog-shaped findings (empty when every recipe file is valid).
function auditRecipeIntegrity() {

	let files = [];
	try { files = fs.readdirSync(RECIPES_DIR).filter(f => f.endsWith('.json')); }
	catch (e) { return []; }

	const bad = [];

	for (const file of files) {
		try {
			const def = JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8'));
			if (!def || typeof def !== 'object' || !def.id || !def.type) { bad.push(file + ' (missing id/type)'); }
		}
		catch (e) { bad.push(file + ' (invalid JSON)'); }
	}

	return bad.length
		? [ { action: 'watchdog.recipe_file_integrity', target: String(bad.length), detail: 'shipped recipe file(s) are broken and were skipped from the library: ' + bad.sort().join(', ') } ]
		: [];
}


// Read and parse every shipped recipe definition. A malformed file is skipped rather than crashing
// boot — one bad recipe must never take the instance down.
function listShipped() {

	let files = [];
	try { files = fs.readdirSync(RECIPES_DIR).filter(f => f.endsWith('.json')); }
	catch (e) { return []; }

	const out = [];

	for (const file of files) {
		try {
			const def = JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, file), 'utf8'));
			if (def && typeof def === 'object' && def.id && def.type) { out.push(def); }
		}
		catch (e) { /* skip a malformed recipe */ }
	}

	return out;
}


// ── Tombstones (Layer 2) ─────────────────────────────────────────────────────────

// The recipe ids this instance has removed (so the seeder skips them).
async function removedIds() {
	try {
		const rows = await RecipeStateDB.RecipeStateSchema.find({ server_id: serverId() }).select({ recipe_id: 1 });
		return new Set((rows || []).map(r => r.recipe_id));
	}
	catch (e) { return new Set(); }
}

async function markRemoved(recipeId) {
	if (!recipeId) { return; }
	try { await RecipeStateDB.RecipeStateSchema.updateOne({ server_id: serverId(), recipe_id: recipeId }, { $set: { server_id: serverId(), recipe_id: recipeId } }, { upsert: true }); }
	catch (e) { logger('ScheduleRecipes: could not tombstone ' + recipeId + ': ' + e.message); }
}

async function clearRemoved(recipeId) {
	if (!recipeId) { return; }
	try { await RecipeStateDB.RecipeStateSchema.deleteOne({ server_id: serverId(), recipe_id: recipeId }); }
	catch (e) { logger('ScheduleRecipes: could not clear tombstone ' + recipeId + ': ' + e.message); }
}


// Every schedule row this instance carries (in ANY state).
async function allRows() {
	const scheduler = shareData && shareData.Scheduler;
	if (!scheduler || typeof scheduler.list !== 'function') { return []; }
	try { const r = await scheduler.list(); return (r && r.schedules) ? r.schedules : (Array.isArray(r) ? r : []); }
	catch (e) { return []; }
}

// The recipe ids this instance already carries as a schedule row (in ANY state).
async function importedIds() {
	const rows = await allRows();
	return new Set(rows.map(s => s && s.settings && s.settings.recipe_id).filter(Boolean));
}

// The schedule row imported from a given shipped recipe, or null.
async function importedRow(recipeId) {
	const rows = await allRows();
	return rows.filter(s => s && s.settings && s.settings.recipe_id === recipeId)[0] || null;
}


// ── Import a single recipe as a disabled, user-owned schedule row ─────────────────
// Shared by the seeder and the "Add from library" path so a recipe is always turned into a row the
// same way. Carries the recipe's provenance so the UI can label it and re-seeding stays idempotent.
async function importRecipe(def) {

	const scheduler = shareData && shareData.Scheduler;
	if (!scheduler || typeof scheduler.add !== 'function') { return { success: false, error: 'Scheduler unavailable' }; }

	const settings = Object.assign({}, def.settings || {}, {
		recipe_id: def.id,
		recipe_name: def.name,
		recipe_description: def.description,
		recipe_version: def.version || '1.0',   // the shipped version this row was imported from — lets the
		                                        // library flag "update available" without ever auto-overwriting
		requires_ai: recipeUsesAI(def),    // so the UI can flag which tasks need AI vs run without it
		ai_optional: def.ai_optional === true   // task runs without AI but offers an opt-in AI enhancement
	});

	return await scheduler.add({
		type: def.type,
		kind: def.kind || 'cron',
		cron: def.cron || '0 * * * *',
		run_at: def.run_at,
		label: def.name,
		prompt: def.prompt,             // required for ai_analysis-typed recipes (validate rejects an empty
		                                // prompt for that type); harmless/undefined for the cron recipes
		enabled: false,                 // opt-in: imported recipes never run until the user enables them
		settings: settings
	});
}


// Import shipped recipes this instance has neither imported before NOR tombstoned, as disabled rows.
// Safe to call on every boot. Returns { seeded, skipped }.
async function seed() {

	const recipes = listShipped();
	if (!recipes.length) { return { seeded: 0, skipped: 0 }; }

	const have = await importedIds();
	const removed = await removedIds();

	let seeded = 0, skipped = 0;

	for (const def of recipes) {

		// The user's own copy wins, and a removed recipe stays removed — never re-import over either.
		if (have.has(def.id) || removed.has(def.id)) { skipped++; continue; }

		try {
			const res = await importRecipe(def);
			if (res && res.success) { seeded++; logger('ScheduleRecipes: imported "' + def.name + '" (' + def.id + ') as a disabled schedule'); }
			else { logger('ScheduleRecipes: could not import ' + def.id + ': ' + ((res && res.error) || 'unknown')); }
		}
		catch (e) { logger('ScheduleRecipes: failed to import ' + def.id + ': ' + e.message); }
	}

	return { seeded: seeded, skipped: skipped };
}


// ── Library surface (for the "Add from library" picker) ──────────────────────────

// The shipped catalog annotated for this instance: `added` (a schedule row already exists),
// `removed` (tombstoned), and `available` (can be added right now = not currently added).
// Compare two dotted version strings numerically. Returns 1 if a>b, -1 if a<b, 0 if equal. Missing
// segments count as 0 ("1.2" === "1.2.0"). Non-numeric junk is treated as 0 so a bad value can't crash.
function compareVersions(a, b) {
	const pa = String(a == null ? '' : a).split('.').map(n => parseInt(n, 10) || 0);
	const pb = String(b == null ? '' : b).split('.').map(n => parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const x = pa[i] || 0, y = pb[i] || 0;
		if (x > y) { return 1; }
		if (x < y) { return -1; }
	}
	return 0;
}

async function catalog() {

	const recipes = listShipped();
	const removed = await removedIds();

	// One pass over the instance's schedules → the installed version per recipe (so we can flag "update
	// available" when the shipped recipe has moved on, WITHOUT ever auto-overwriting the user's row).
	const rows = await allRows();
	const installedVersionById = {};
	for (const s of rows) {
		const rid = s && s.settings && s.settings.recipe_id;
		if (rid) { installedVersionById[rid] = (s.settings.recipe_version != null && s.settings.recipe_version !== '') ? String(s.settings.recipe_version) : '1.0'; }
	}

	return recipes.map(def => {
		const shippedVersion = String(def.version || '1.0');
		const added = Object.prototype.hasOwnProperty.call(installedVersionById, def.id);
		const installedVersion = added ? installedVersionById[def.id] : null;
		return {
			id: def.id,
			name: def.name,
			description: def.description,
			author: def.author || 'core',
			categories: def.categories || [],
			type: def.type,
			requires_ai: recipeUsesAI(def),
			ai_optional: def.ai_optional === true,
			added: added,
			removed: removed.has(def.id),
			available: !added,
			shipped_version: shippedVersion,
			installed_version: installedVersion,
			// True when the user has this recipe installed at an OLDER version than what now ships. They
			// can apply it via "Reset to defaults" (which preserves their enabled/notification choices).
			update_available: added && compareVersions(shippedVersion, installedVersion) > 0
		};
	});
}

// Add a shipped recipe from the library: clear any tombstone and create a fresh disabled row. No-op
// (success) if the instance already has a row for it, so a double-click can't create duplicates.
async function addFromLibrary(recipeId) {

	const def = listShipped().filter(r => r.id === recipeId)[0];
	if (!def) { return { success: false, error: 'Unknown recipe.' }; }

	const have = await importedIds();
	if (have.has(recipeId)) { await clearRemoved(recipeId); return { success: true, already: true }; }

	await clearRemoved(recipeId);

	const res = await importRecipe(def);
	if (res && res.success) { logger('ScheduleRecipes: added "' + def.name + '" (' + def.id + ') from the library'); }
	return res;
}


// ── Reset an imported recipe to its shipped defaults (Layer-2 override: "reset") ───
// A recipe is imported ONCE and then never re-seeded (the user's copy wins), so a later shipped
// upgrade — a better cron default, a renamed label, tuned parameters — never reaches an existing
// row automatically. This is the user-initiated opt-in: re-apply the shipped recipe BODY
// (schedule + parameters + label) to their row on demand. It deliberately PRESERVES the operational
// wiring the user owns — their notification destinations and whether the task is enabled — because
// those are delivery choices, not part of the recipe definition. Nothing here ever changes a user's
// preferences without them asking (the standing "never auto-change a schedule" rule): it fires only
// on an explicit reset action.
async function resetToDefaults(recipeId) {

	const def = listShipped().filter(r => r.id === recipeId)[0];
	if (!def) { return { success: false, error: 'Unknown recipe.' }; }

	const scheduler = shareData && shareData.Scheduler;
	if (!scheduler || typeof scheduler.update !== 'function') { return { success: false, error: 'Scheduler unavailable' }; }

	const row = await importedRow(recipeId);
	if (!row) { return { success: false, error: 'This recipe is not currently added, so there is nothing to reset.' }; }

	// Rebuild settings from the shipped default exactly as a fresh import would, but carry over the
	// user's notification destinations so a reset never silently redirects (or drops) their alerts.
	const settings = Object.assign({}, def.settings || {}, {
		recipe_id: def.id,
		recipe_name: def.name,
		recipe_description: def.description,
		recipe_version: def.version || '1.0',   // adopt the shipped version, so a reset that applies an
		                                        // update also clears the "update available" flag
		requires_ai: recipeUsesAI(def),
		ai_optional: def.ai_optional === true
	});
	if (row.settings && Array.isArray(row.settings.notifications)) { settings.notifications = row.settings.notifications; }

	const res = await scheduler.update(row.schedule_id, {
		kind: def.kind || 'cron',
		cron: def.cron || '0 * * * *',
		run_at: def.run_at,
		label: def.name,
		settings: settings,
		replaceSettings: true          // clean slate: drop any stale keys a merge would keep
		// enabled is intentionally omitted — the user's on/off choice is preserved
	});

	if (res && res.success) { logger('ScheduleRecipes: reset "' + def.name + '" (' + def.id + ') to shipped defaults'); }
	return res;
}


// ── Diff-on-update: what would a "Reset to defaults" actually change? ─────────────
// A shipped-recipe upgrade never auto-applies (the user's row wins), so before someone clicks
// "Reset to defaults" they deserve to see WHICH schedule fields and WHICH recipe parameters would
// change. This computes that field-level diff so an update is never a black box.

// Keys in a row's settings that are provenance/meta or user-owned wiring — NOT tunable recipe
// parameters, so the diff ignores them. `notifications` is deliberately PRESERVED across a reset
// (a delivery choice the user owns), and the recipe_*/requires_ai/ai_optional keys are bookkeeping.
const DIFF_IGNORE_SETTING_KEYS = new Set([
	'recipe_id', 'recipe_name', 'recipe_description', 'recipe_version', 'requires_ai', 'ai_optional', 'notifications'
]);

// Equality by canonical JSON — good enough for recipe settings (plain JSON values). Never throws.
function sameValue(a, b) {
	try { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
	catch (e) { return a === b; }
}

// PURE. Compute the field-level changes between an installed recipe row and the shipped definition a
// reset would apply. Returns { changes: [{ field, scope, from, to }] }; scope is 'schedule' (cron,
// label, …) or 'setting' (a recipe parameter). Ignores provenance/meta and the preserved notification
// wiring. Deterministic (settings keys sorted). Never throws.
function computeUpdateChanges(row, def) {

	const changes = [];
	row = row || {};
	def = def || {};

	// Schedule-level fields a reset re-applies from the shipped definition.
	const schedFields = [
		{ field: 'cron',   from: row.cron,   to: (def.cron || '0 * * * *') },
		{ field: 'kind',   from: row.kind,   to: (def.kind || 'cron') },
		{ field: 'run_at', from: row.run_at, to: (def.run_at != null ? def.run_at : null) },
		{ field: 'label',  from: row.label,  to: def.name }
	];

	for (const f of schedFields) {
		const from = f.from == null ? null : f.from;
		const to = f.to == null ? null : f.to;
		if (!sameValue(from, to)) { changes.push({ field: f.field, scope: 'schedule', from: from, to: to }); }
	}

	// Setting-level parameters: the union of keys across both, minus the ignore set, sorted.
	const cur = (row.settings && typeof row.settings === 'object') ? row.settings : {};
	const shipped = (def.settings && typeof def.settings === 'object') ? def.settings : {};
	const keys = Array.from(new Set([].concat(Object.keys(cur), Object.keys(shipped)))).filter(k => !DIFF_IGNORE_SETTING_KEYS.has(k)).sort();

	for (const k of keys) {
		if (!sameValue(cur[k], shipped[k])) {
			changes.push({
				field: k,
				scope: 'setting',
				from: Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : null,
				to: Object.prototype.hasOwnProperty.call(shipped, k) ? shipped[k] : null
			});
		}
	}

	return { changes };
}

// The changes a "Reset to defaults" would apply for one installed recipe, plus the version move.
// Returns { success, recipe_id, name, update_available, from_version, to_version, changes }.
async function updateDiff(recipeId) {

	const def = listShipped().filter(r => r.id === recipeId)[0];
	if (!def) { return { success: false, error: 'Unknown recipe.' }; }

	const row = await importedRow(recipeId);
	if (!row) { return { success: false, error: 'This recipe is not currently added, so there is nothing to compare.' }; }

	const shippedVersion = String(def.version || '1.0');
	const installedVersion = (row.settings && row.settings.recipe_version != null && row.settings.recipe_version !== '') ? String(row.settings.recipe_version) : '1.0';

	const { changes } = computeUpdateChanges(row, def);

	return {
		success: true,
		recipe_id: def.id,
		name: def.name,
		update_available: compareVersions(shippedVersion, installedVersion) > 0,
		from_version: installedVersion,
		to_version: shippedVersion,
		changes: changes
	};
}


module.exports = { init, listShipped, seed, catalog, addFromLibrary, resetToDefaults, updateDiff, computeUpdateChanges, importedRow, markRemoved, clearRemoved, auditRecipeIntegrity, compareVersions, RECIPES_DIR };