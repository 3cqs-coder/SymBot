'use strict';

// CorpusTool — verify or regenerate the AI learning SEED corpus (libs/ai/data/seed-learning.json).
//
// The seed corpus ships as a checksummed pack: its manifest carries a SHA-256 checksum over the records
// (an integrity check, not a cryptographic signature), so a corrupted or hand-edited file is caught
// (verifyPack rejects a checksum mismatch, and the routing test gate fails). That protects users from a
// broken pack — but it also means that after you edit the
// records (add coverage for a new tool, fix a pattern) the checksum no longer matches and must be
// recomputed. This module is the one place that does both jobs, exposed through the `corpus` console
// command:
//
//   node symbot.js corpus check     → verify integrity + report which registered tools have no pattern
//   node symbot.js corpus regen     → recompute the checksum/count/tools_version for the CURRENT records
//
// It is pure and dependency-light (no DB, no webserver, no trading), so it is safe to run standalone.

const fs = require('fs');
const path = require('path');
const AIMemory = require('./AIMemory.js');
const AITools = require('./AITools.js');

const SEED_PATH = path.join(__dirname, 'data', 'seed-learning.json');

function loadPack() { return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')); }

// Which registered tools have NO pattern in the corpus (same signal as the ai_learning_coverage
// watchdog). Returns a sorted array of tool names.
function uncoveredTools(pack) {
	const covered = new Set();
	for (const r of (pack.records || [])) {
		for (const t of (r.tools || [])) { const c = AITools.resolveTool(t); if (c) { covered.add(c); } }
	}
	const skip = (AITools.NO_CORPUS_NEEDED instanceof Set) ? AITools.NO_CORPUS_NEEDED : new Set();
	return AITools.TOOLS.map(t => t.name).filter(n => !covered.has(n) && !skip.has(n)).sort();
}

// Verify the corpus against this install's tool registry. Returns a plain report object; never throws.
function check() {
	let pack;
	try { pack = loadPack(); }
	catch (e) { return { ok: false, error: 'Could not read the seed corpus: ' + e.message }; }

	const validTools = new Set(AITools.TOOLS.map(t => t.name));
	const v = AIMemory.verifyPack(pack, { validTools, aliases: AITools.TOOL_ALIASES });

	return {
		ok: !!v.ok,
		error: v.error || null,
		records: (pack.records || []).length,
		accepted: v.count != null ? v.count : null,
		rejected: v.rejected || 0,
		manifest_checksum: (pack.manifest && pack.manifest.checksum) || null,
		expected_checksum: AIMemory.packChecksum((pack.records || []).map(AIMemory.sanitizePattern).filter(Boolean)),
		tools_version_file: (pack.manifest && pack.manifest.tools_version) || null,
		tools_version_now: AITools.toolSignature(),
		uncovered: uncoveredTools(pack)
	};
}

// Recompute the manifest checksum, count, and tools_version for the CURRENT records (preserving the
// provenance card), and — unless opts.write === false — write the file back. Returns what changed.
function regen(opts) {
	opts = opts || {};

	const pack = loadPack();
	const before = (pack.manifest && pack.manifest.checksum) || null;
	const m = pack.manifest || {};

	const rebuilt = AIMemory.buildPack(pack.records, {
		source:        m.source,
		created:       m.created,
		symbotVersion: m.symbot_version,
		toolsVersion:  AITools.toolSignature(),   // stamp the CURRENT tool set the pack was built against
		license:       m.license,
		description:   m.description,
		author:        m.author,
		language:      m.language
	});

	// Preserve any extra card fields buildPack does not carry through.
	const out = { manifest: Object.assign({}, m, rebuilt.manifest), records: rebuilt.records };
	const after = out.manifest.checksum;
	const changed = (before !== after) || ((pack.records || []).length !== rebuilt.records.length);

	if (opts.write !== false) { fs.writeFileSync(SEED_PATH, JSON.stringify(out, null, '\t') + '\n'); }

	return { changed, before, after, records_in: (pack.records || []).length, records_out: rebuilt.records.length, dropped: (pack.records || []).length - rebuilt.records.length };
}

module.exports = { SEED_PATH, check, regen, uncoveredTools };
