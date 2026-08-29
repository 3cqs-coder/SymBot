'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Per-instance state for the pre-defined recipe library (see libs/app/Recipes.js).
//
// A row here is a TOMBSTONE: it records that this instance's user deleted a shipped recipe, so the
// import-on-start seeder must NOT re-create it. Presence = removed; re-adding the recipe from the
// library deletes the tombstone. Scoped by `server_id` (like schedules) so, under a Hub sharing one
// database, each instance keeps its own recipe choices — one instance removing the watchdog never
// hides it on another.
const RecipeStateSchema = new Schema({
	server_id: { type: String, default: '', index: true },
	recipe_id: { type: String, required: true },
}, {
	collection: 'recipe_state',
	timestamps: true
});

// At most one tombstone per (instance, recipe).
RecipeStateSchema.index({ server_id: 1, recipe_id: 1 }, { unique: true });

module.exports = {
	'RecipeStateSchema': mongoose.model('RecipeStateSchema', RecipeStateSchema)
};
