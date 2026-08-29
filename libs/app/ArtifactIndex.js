'use strict';

// ── ArtifactIndex — a per-directory manifest for generated files ─────────────
//
// Tracks generated artifacts (backups, logs, …) with stable metadata so that listing, display, download,
// retention, AI search and off-site (SFTP) upload key on RECORDS instead of parsing identity out of a
// filename. Historically SymBot encoded the instance name into every backup/log filename and re-matched it
// with per-name regexes in many independent places; that is the fragile surface this replaces.
//
// Design invariant — the DIRECTORY is the source of truth for what EXISTS; this index is a REBUILDABLE
// metadata layer. `reconcile()` repairs the index from the directory (adds files it does not yet know,
// drops records whose file is gone), so a lost, corrupt, stale, or hand-edited index self-heals to a
// correct one on the next pass. It can never cause data loss or hide a real file for more than one
// reconcile — the worst case degrades to a plain directory listing, never worse than before.
//
// It lives INSIDE the directory it indexes (e.g. data/instances/<server_id>/backups/.index.json), so it is
// scoped to one instance, travels with the folder when server_id changes (the boot self-heal renames the
// whole folder), and is never part of a backup archive (backups bundle the DB + config, never these
// folders) — so a restore can never overwrite it with a stale copy.
//
// This file is CODE (under libs/); every byte of runtime state it manages lives under data/. It is
// cross-platform: all paths go through `path`, writes are atomic (temp file + rename), and every entry
// point is wrapped so a filesystem hiccup degrades gracefully instead of throwing into a caller.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');


// The manifest filename. A dotfile so directory listings/retention skip it (it is not itself an artifact),
// and a reserved name the artifact predicates must always exclude.
const INDEX_FILE = '.index.json';

// Bump only on an INCOMPATIBLE shape change. `normalize()` upgrades older versions forward and preserves
// unknown fields, so a newer index opened by an older build (a rollback) still reads — future-proofing the
// format the way the config merge and rollback manifest already are.
const SCHEMA_VERSION = 1;

const MS_PER_DAY = 86400000;


// A collision-proof id for a new entry. crypto.randomUUID exists on every supported Node (22+); the
// randomBytes fallback keeps this working on any older/edge runtime rather than throwing.
function newId() {
	try { if (typeof crypto.randomUUID === 'function') { return crypto.randomUUID(); } }
	catch (e) {}
	return crypto.randomBytes(16).toString('hex');
}

// An ISO-8601 UTC timestamp. ISO strings sort lexicographically in true chronological order, so retention
// and display compare them directly with no Date parsing.
function nowIso() { return new Date().toISOString(); }


// A fresh, valid manifest for a kind. `meta` carries the display context (server_id, instance_name) that
// listing shows and that a rename updates — the instance name lives HERE, never in the filename.
function emptyManifest(kind, meta) {
	meta = meta || {};
	return {
		version: SCHEMA_VERSION,
		kind: String(kind || ''),
		server_id: meta.server_id != null ? String(meta.server_id) : '',
		instance_name: meta.instance_name != null ? String(meta.instance_name) : '',
		entries: []
	};
}

// Coerce any parsed object (or garbage) into a valid manifest of this kind, upgrading the version and
// back-filling required fields WITHOUT dropping unknown ones (forward-compat: an older build preserves a
// newer build's extra fields on rewrite). Entries missing a stable id/created_utc get them minted so the
// rest of the code can rely on their presence. De-dupes by `file` (the on-disk natural key), keeping the
// last occurrence. Never throws.
function normalize(raw, kind, meta) {
	const base = emptyManifest(kind, meta);
	if (!raw || typeof raw !== 'object') { return base; }

	const out = Object.assign(base, raw);           // keep unknown top-level fields
	// Never DOWNGRADE the version stamp. If a newer build wrote a higher version and this (older) build is
	// rewriting after a rollback, keep the higher number (and the unknown fields Object.assign preserved), so
	// the file still reads as "last touched by a newer schema" rather than being silently stamped backwards.
	const rawVer = Number(raw.version);
	out.version = Number.isFinite(rawVer) && rawVer > SCHEMA_VERSION ? rawVer : SCHEMA_VERSION;
	out.kind = String(kind || raw.kind || '');
	// Refresh the display context from the live meta when provided (server_id/instance_name can change);
	// otherwise keep whatever the file recorded.
	if (meta && meta.server_id != null) { out.server_id = String(meta.server_id); }
	if (meta && meta.instance_name != null) { out.instance_name = String(meta.instance_name); }

	const seen = new Map();
	const list = Array.isArray(raw.entries) ? raw.entries : [];
	for (const e of list) {
		if (!e || typeof e !== 'object' || !e.file || typeof e.file !== 'string') { continue; }
		const file = path.basename(e.file);         // never let a stored path escape the directory
		if (file === INDEX_FILE) { continue; }
		const entry = Object.assign({}, e, { file });
		if (!entry.id || typeof entry.id !== 'string') { entry.id = newId(); }
		if (!entry.created_utc || typeof entry.created_utc !== 'string') { entry.created_utc = nowIso(); }
		seen.set(file, entry);                       // last write wins on a duplicate file key
	}
	out.entries = Array.from(seen.values());
	return out;
}


// Add or replace an entry, keyed by its `file` basename. Mints id/created_utc when absent. Mutates and
// returns the manifest. Kind-specific fields (a log's utc_start/utc_end, a backup's sftp block) are just
// extra properties on `entry` and are preserved untouched — the core never needs to understand them.
function upsert(manifest, entry) {
	if (!entry || !entry.file) { return manifest; }
	const file = path.basename(String(entry.file));
	if (file === INDEX_FILE) { return manifest; }
	const rec = Object.assign({}, entry, { file });
	if (!rec.id) { rec.id = newId(); }
	if (!rec.created_utc) { rec.created_utc = nowIso(); }
	const i = manifest.entries.findIndex(e => e.file === file);
	if (i >= 0) { rec.id = manifest.entries[i].id || rec.id; manifest.entries[i] = Object.assign({}, manifest.entries[i], rec); }
	else { manifest.entries.push(rec); }
	return manifest;
}

// Drop the entry for a file basename (used after the file itself is deleted). Mutates, returns manifest.
function dropByFile(manifest, file) {
	const base = path.basename(String(file || ''));
	manifest.entries = manifest.entries.filter(e => e.file !== base);
	return manifest;
}


// Entries sorted oldest-first by created_utc (ISO lexical = chronological), file name breaking ties so the
// order is deterministic across platforms.
function sortedOldestFirst(manifest) {
	return manifest.entries.slice().sort((a, b) => {
		if (a.created_utc !== b.created_utc) { return a.created_utc < b.created_utc ? -1 : 1; }
		return a.file < b.file ? -1 : (a.file > b.file ? 1 : 0);
	});
}

// Retention selector — entries strictly older than `maxAgeDays` relative to `now` (ms epoch or Date).
// A missing/invalid created_utc is treated as NOT expired (kept), so a half-written record is never a
// reason to delete a file. Pure; the caller deletes the files and then calls dropByFile. maxAgeDays <= 0
// disables age-based expiry (returns nothing).
function selectExpired(manifest, opts) {
	opts = opts || {};
	const days = Number(opts.maxAgeDays);
	if (!(days > 0)) { return []; }
	const nowMs = (opts.now instanceof Date) ? opts.now.getTime() : (Number.isFinite(opts.now) ? opts.now : Date.now());
	const cutoffIso = new Date(nowMs - days * MS_PER_DAY).toISOString();
	return manifest.entries.filter(e => typeof e.created_utc === 'string' && e.created_utc < cutoffIso);
}

// Retention selector — the OLDEST entries beyond the newest `keep` (used for "keep N backups"). Pure.
// keep <= 0 keeps everything (returns nothing) — a safety default so a mis-read config never wipes backups.
function selectExcess(manifest, opts) {
	opts = opts || {};
	const keep = Number(opts.keep);
	if (!(keep > 0)) { return []; }
	const oldestFirst = sortedOldestFirst(manifest);
	const excess = oldestFirst.length - keep;
	return excess > 0 ? oldestFirst.slice(0, excess) : [];
}


// ── Filesystem I/O (atomic, cross-platform, never throws) ────────────────────

function indexPath(dir) { return path.join(dir, INDEX_FILE); }

// Load + normalize the manifest for a directory. A missing or unreadable/corrupt index yields a fresh empty
// one (the directory, not the index, is the source of truth), so a caller always gets a usable manifest.
function load(dir, kind, meta) {
	let raw = null;
	try { raw = JSON.parse(fs.readFileSync(indexPath(dir), 'utf8')); }
	catch (e) { raw = null; }
	return normalize(raw, kind, meta);
}

// Atomically persist the manifest: write a temp file in the SAME directory, then rename over the target
// (rename within a directory is atomic on every OS and overwrites on Windows too). On a rename failure
// (e.g. a transient AV/file lock on Windows) fall back to a direct write so the update is not simply lost;
// the temp is always cleaned up. Returns true on success. Never throws — a failed save just means the next
// reconcile rebuilds from the directory.
function save(dir, manifest) {
	try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
	const target = indexPath(dir);
	const tmp = target + '.' + process.pid + '.tmp';
	const body = JSON.stringify(manifest, null, 2);
	try {
		fs.writeFileSync(tmp, body);
		try { fs.renameSync(tmp, target); }
		catch (e) { fs.writeFileSync(target, body); try { fs.unlinkSync(tmp); } catch (e2) {} }
		return true;
	}
	catch (e) {
		try { if (fs.existsSync(tmp)) { fs.unlinkSync(tmp); } } catch (e2) {}
		return false;
	}
}


// Reconcile the index against the directory's real contents — the self-healing heart of the design.
//   opts.kind        — the kind label (for a freshly-built manifest).
//   opts.meta        — { server_id, instance_name } display context.
//   opts.isArtifact  — predicate(filename) → is this file one of THIS kind's artifacts? (excludes the index
//                      file, other dotfiles, and unrelated files). Required.
//   opts.deriveEntry — optional(filename, stat) → extra fields to seed a NEWLY discovered entry (e.g. a
//                      log's date/utc bounds). created_utc defaults to the file's mtime when not supplied.
// Adds an entry for every on-disk artifact the index does not know; drops every entry whose file is gone.
// Saves only when something changed. Returns { manifest, added:[files], removed:[files], changed }.
// Never throws.
function reconcile(dir, opts) {
	opts = opts || {};
	// Guard the caller-supplied predicate: a throwing isArtifact is treated as "not an artifact" rather than
	// propagating, so the module's "never throws into a caller" guarantee is intrinsic, not merely contingent
	// on every caller passing a safe callback and wrapping the call.
	const rawIsArtifact = typeof opts.isArtifact === 'function' ? opts.isArtifact : () => false;
	const isArtifact = (name) => { try { return !!rawIsArtifact(name); } catch (e) { return false; } };
	const manifest = load(dir, opts.kind, opts.meta);

	// A single outer guard makes the whole reconcile non-throwing regardless of a caller's callbacks or an
	// unexpected fs error; on any failure the loaded manifest is returned unchanged (degrade, never throw).
	try { return reconcileInner(dir, opts, isArtifact, manifest); }
	catch (e) { return { manifest, added: [], removed: [], changed: false }; }
}

function reconcileInner(dir, opts, isArtifact, manifest) {

	let onDisk = [];
	try { onDisk = fs.readdirSync(dir); }
	catch (e) { onDisk = []; }   // dir missing → nothing on disk; drops stale entries below

	// Best-effort sweep of orphaned temp files (".index.json.<pid>.tmp") left behind if a process died between
	// save()'s temp-write and its rename. The ONLY guard is a short age window: a genuine in-flight temp lives
	// for mere milliseconds (save writes then renames synchronously), so anything older than the window is
	// certainly abandoned. Deliberately NOT keyed on the current pid — under Docker the app restarts as pid 1,
	// so a crash orphan "…​.1.tmp" would forever match a new pid-1 process's own name and never be swept; the
	// age guard alone is both sufficient and correct, and it also protects a concurrent writer's fresh temp.
	// Wrapped per file so a permission hiccup can't derail the reconcile.
	const tmpPrefix = INDEX_FILE + '.';
	for (const name of onDisk) {
		if (name.indexOf(tmpPrefix) !== 0 || name.slice(-4) !== '.tmp') { continue; }
		try {
			const st = fs.statSync(path.join(dir, name));
			if (Date.now() - st.mtimeMs > 30000) { fs.unlinkSync(path.join(dir, name)); }
		}
		catch (e) {}
	}

	const present = new Set();
	const added = [];
	for (const name of onDisk) {
		if (name === INDEX_FILE || name.charAt(0) === '.') { continue; }
		if (!isArtifact(name)) { continue; }
		present.add(name);
		if (manifest.entries.some(e => e.file === name)) { continue; }
		let stat = null;
		try { stat = fs.statSync(path.join(dir, name)); } catch (e) { stat = null; }
		if (!stat || !stat.isFile()) { continue; }
		const seed = {
			file: name,
			created_utc: new Date(stat.mtimeMs).toISOString(),   // best-available creation time for an untracked file
			size: stat.size
		};
		let extra = null;
		if (typeof opts.deriveEntry === 'function') { try { extra = opts.deriveEntry(name, stat); } catch (e) { extra = null; } }
		upsert(manifest, extra ? Object.assign(seed, extra) : seed);
		added.push(name);
	}

	const removed = [];
	manifest.entries = manifest.entries.filter(e => {
		if (present.has(e.file)) { return true; }
		removed.push(e.file);
		return false;
	});

	const changed = added.length > 0 || removed.length > 0;
	if (changed) { save(dir, manifest); }
	return { manifest, added, removed, changed };
}


// ── Convenience wrappers (load → mutate → save), each best-effort ────────────

// Record a newly created artifact (e.g. right after a backup file is written). Returns the stored entry.
function record(dir, kind, meta, entry) {
	const manifest = load(dir, kind, meta);
	upsert(manifest, entry);
	save(dir, manifest);
	const file = path.basename(String(entry && entry.file || ''));
	return manifest.entries.find(e => e.file === file) || null;
}

// Forget an artifact after its file has been deleted.
function forget(dir, file) {
	const manifest = load(dir, null, null);
	dropByFile(manifest, file);
	save(dir, manifest);
	return manifest;
}


module.exports = {
	INDEX_FILE,
	SCHEMA_VERSION,
	// pure helpers
	emptyManifest,
	normalize,
	upsert,
	dropByFile,
	sortedOldestFirst,
	selectExpired,
	selectExcess,
	// io
	indexPath,
	load,
	save,
	reconcile,
	record,
	forget,
	// exposed for tests / callers that mint their own
	newId,
	nowIso
};
