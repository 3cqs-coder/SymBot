'use strict';

// libs/app/FileLock.js — a tiny cross-process advisory file lock, used as SymBot's SINGLETON-INSTANCE guard.
//
// Why this exists: the Hub supervises instances as worker_threads, so a Hub crash can never leak an OS process —
// but nothing stops TWO Hub processes (a double service start, or a manual start racing the old one) from each
// reading the same hub config and spawning a worker for the same server_id. That is two DCA engines trading one
// exchange account. The in-memory duplicate guard (isServerIdInUse) only sees its OWN process, so it cannot catch
// this. A file lock is the one thing that IS visible across processes.
//
// Mechanism: one lock file per key under data/locks/, carrying the holder's pid/host/timestamp plus a random
// nonce. A holder that crashes or whose pid is reused is
// detected as STALE (by a TTL and a same-host liveness check) and reclaimed atomically; a live holder refreshes
// its timestamp on a heartbeat so a long-running instance is never judged stale and stolen. Pure Node (fs + crypto),
// cross-platform: the atomic create-or-fail ('wx') and rename-aside reclaim work the same on macOS, Linux, Windows.
//
// This module is intentionally self-contained (no dependency on Common's export surface) so it can be unit-tested
// in isolation and can never be dragged into a require cycle on the boot path.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TTL_MS = 30 * 1000;    // a lock not refreshed within this is stale (a crashed or reused-pid holder)
const BEAT_MS = 10 * 1000;   // a held lock refreshes its timestamp this often, so a live long-lived instance stays valid
const BIRTH_GRACE_MS = 2500; // how long acquire rides out a torn/just-born file or a stale-reclaim race before giving up
const IS_WINDOWS = process.platform === 'win32';

// The install root (…/SymBot), two levels up from libs/app — the same anchor Common.js uses. Lock files live under
// <root>/data/locks, so the lock is automatically scoped to THIS install: two processes of the same install share a
// lock file and are mutually excluded; a different install has its own data dir and is independent.
const LOCK_ROOT = path.join(path.resolve(__dirname, '..', '..'), 'data', 'locks');

function locksDir() { return LOCK_ROOT; }

// The lock file path for a KEY (any stable string). The key is hashed so the lock name is filesystem-safe and
// fixed-length; every process under the same install that passes the same key gets the same lock file.
function lockPathFor(key) {
	const h = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
	return path.join(LOCK_ROOT, h + '.lock');
}

function record(nonce, role) {
	return JSON.stringify({ v: 1, pid: process.pid, host: os.hostname(), at: Date.now(), nonce, role: role || '' });
}

// process.kill(pid, 0) sends no signal — it only probes existence/permission. ESRCH => the pid is gone; EPERM =>
// it exists but is owned by another user (so it IS alive). An invalid pid is treated as not alive.
function isProcessAlive(pid) {
	const n = Number(pid);
	if (!Number.isInteger(n) || n <= 0) { return false; }
	try { process.kill(n, 0); return true; }
	catch (e) { return e && e.code === 'EPERM'; }
}

// Is a holder record stale — i.e. safe to reclaim? On THIS host the pid is AUTHORITATIVE: a live holder is never
// stale (even if its heartbeat lagged past the TTL during an event-loop stall, a laptop suspend/resume, or a long
// GC pause), and a dead pid is immediately reclaimable. This is the money-safe ordering — never steal a lock whose
// owning process is still alive on this machine, since that would put two engines on one account. A holder on a
// DIFFERENT host cannot have its pid probed, so it is aged out by the TTL alone.
//
// Accepted cost: if a hard-killed holder's pid is later REUSED by an unrelated live process on this host, its
// leftover lock is not auto-reclaimed and must be cleared manually (or waited out until that unrelated process
// exits and a later start sees the pid dead). This is rare — especially on Linux's large pid space — and is far
// preferable to the alternative (a TTL that ages out a genuinely-alive holder and lets a duplicate engine start).
function stale(held) {
	if (!held) { return true; }
	if (held.host === os.hostname() && held.pid) { return !isProcessAlive(held.pid); }
	return (Date.now() - (held.at || 0) > TTL_MS);   // foreign host: pid unprobeable, age out by TTL
}

// Atomic rename with a brief Windows retry. POSIX rename(2) atomically replaces the destination and never fails
// because a reader has it open, so it runs once; on Windows a concurrent reader/antivirus can throw a TRANSIENT
// lock error, so a few short backoffs turn an intermittent failure into success without weakening atomicity.
const RENAME_RETRY_ERRNOS = [ 'EPERM', 'EACCES', 'EBUSY', 'EEXIST' ];
async function renameWithRetry(src, dest) {
	const tries = IS_WINDOWS ? 5 : 1;
	for (let i = 0; i < tries; i++) {
		try { await fsp.rename(src, dest); return; }
		catch (e) {
			const transient = !!(e && RENAME_RETRY_ERRNOS.indexOf(e.code) >= 0);
			if (i === tries - 1 || !transient) { throw e; }
			await new Promise((r) => setTimeout(r, 20 * (i + 1)));
		}
	}
}

async function readHolder(p) {
	try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch (_) { return null; }
}

// Reclaim and heartbeat rename a temp file into place (p + '.reclaim.' + nonce / p + '.beat.' + nonce). A hard
// crash (SIGKILL/power loss) in the tiny window between creating that temp and renaming/removing it leaves the
// temp behind, and nothing else visits data/locks/, so over a long-lived install those orphans would slowly
// accumulate. This throttled, age-gated sweep removes them. The age gate is far beyond any live rename window, so
// a temp a running acquire/refresh is still using can never be swept. Best-effort and detached — it never blocks
// or fails an acquire, and it swallows every error (a missing dir, a racing remove).
const TEMP_RE = /\.(reclaim|beat)\.[0-9a-f]+$/;
const TEMP_STALE_MS = 5 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
let lastSweep = 0;
async function sweepStaleTemps(dir) {
	let names;
	try { names = await fsp.readdir(dir); } catch (_) { return; }
	const now = Date.now();
	for (const n of names) {
		if (!TEMP_RE.test(n)) { continue; }
		const f = path.join(dir, n);
		try { const st = await fsp.stat(f); if (now - st.mtimeMs > TEMP_STALE_MS) { await fsp.rm(f, { force: true }); } } catch (_) {}
	}
}

// Acquire the singleton lock for `key`, returning { p, nonce, holder:null } on success. Unlike a short-op lock, a
// singleton NEVER waits for a live holder to "finish" (an instance never finishes) — if another LIVE process holds
// the lock, this rejects immediately with an Error whose code is 'ALREADY_RUNNING' and whose `.holder` carries the
// live holder's record, so the caller can name the pid. A crashed holder's STALE lock is reclaimed atomically and
// acquisition proceeds. A torn/just-born file (a simultaneous starter mid-write) is ridden out for BIRTH_GRACE_MS.
async function acquireSingleton(key, opts) {
	const role = opts && opts.role;
	const p = lockPathFor(key);
	try { await fsp.mkdir(path.dirname(p), { recursive: true }); } catch (_) {}

	// Opportunistically clear any crash-orphaned reclaim/heartbeat temp files (throttled, detached, best-effort so
	// it never slows or blocks the acquire itself).
	if (Date.now() - lastSweep > SWEEP_EVERY_MS) { lastSweep = Date.now(); sweepStaleTemps(path.dirname(p)).catch(() => {}); }

	const nonce = crypto.randomBytes(12).toString('hex');
	const deadline = Date.now() + BIRTH_GRACE_MS;

	for (;;) {
		let fh = null;
		try { fh = await fsp.open(p, 'wx'); } catch (e) { if (e.code !== 'EEXIST') { throw e; } }
		if (fh) { try { await fh.write(record(nonce, role)); } finally { await fh.close(); } return { p, nonce, holder: null }; }

		// Held by someone. Read it. ENOENT means it vanished between the open and the read (another racer reclaimed
		// it) — retry the create. Any OTHER error (EACCES/EPERM, a persistent Windows read-lock, the path replaced
		// by a directory) is NOT transient: rethrow so startGuard fails OPEN rather than spinning this loop forever.
		let raw = null;
		try { raw = await fsp.readFile(p, 'utf8'); }
		catch (e) { if (e && e.code === 'ENOENT') { continue; } throw e; }
		let held = null;
		try { held = JSON.parse(raw); } catch (_) {}

		// An empty or torn file is a BIRTH in progress (another starter created it but hasn't written the record yet).
		// Wait briefly rather than reclaiming a lock that is about to become valid.
		if (!held) {
			let ageMs = Infinity;
			try { ageMs = Date.now() - (await fsp.stat(p)).mtimeMs; }
			catch (e) { if (e && e.code === 'ENOENT') { continue; } throw e; } // vanished -> retry; persistent error -> fail open
			if (ageMs < 3000 && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 60)); continue; }
		}

		if (stale(held)) {
			// Reclaim atomically: rename the stale file aside — only one racer's rename can move a given file; the
			// loser gets ENOENT and retries. Re-confirm the moved file really was stale; if a fresh lock slipped in
			// between the read and the rename, put it back rather than dropping a live holder's lock.
			const aside = p + '.reclaim.' + nonce;
			try {
				await renameWithRetry(p, aside);
				let moved = null;
				try { moved = JSON.parse(await fsp.readFile(aside, 'utf8')); } catch (_) {}
				if (stale(moved)) { await fsp.rm(aside, { force: true }); }
				else { try { await renameWithRetry(aside, p); } catch (_) { await fsp.rm(aside, { force: true }); } }
			} catch (_) {} // lost the reclaim race -> retry
			continue;
		}

		// A genuinely LIVE holder. A singleton refuses immediately (after riding out the birth-race window in case
		// this is a torn read of a lock that is being reclaimed right now).
		if (Date.now() >= deadline) {
			const err = new Error('Another instance is already running (pid ' + (held && held.pid) + ' on ' + (held && held.host) + ').');
			err.code = 'ALREADY_RUNNING';
			err.holder = held;
			throw err;
		}
		await new Promise((r) => setTimeout(r, 120));
	}
}

// Refresh a held lock's timestamp ATOMICALLY (temp + rename), and only while we still own it — so a reader never
// sees a torn record, and a beat can never resurrect a lock that was already reclaimed and replaced.
async function refresh(p, nonce, role) {
	try {
		let cur = null;
		try { cur = JSON.parse(await fsp.readFile(p, 'utf8')); } catch (_) {}
		if (!cur || cur.nonce !== nonce) { return; } // no longer ours — do not touch a new holder's file
		const tmp = p + '.beat.' + nonce;
		await fsp.writeFile(tmp, record(nonce, role));
		await renameWithRetry(tmp, p);
	} catch (_) {}
}

// Release the lock — remove it only if it is still OURS (a reclaimed-and-replaced lock now carries a different
// nonce and must not be removed from under its new owner).
async function release(p, nonce) {
	try { const cur = JSON.parse(await fsp.readFile(p, 'utf8')); if (cur && cur.nonce === nonce) { await fsp.rm(p, { force: true }); } } catch (_) {}
}

// A synchronous best-effort release for the process 'exit' path, where the event loop is already stopping and an
// async release can't run. Only removes the file if the nonce still matches ours.
function releaseSync(p, nonce) {
	try { const cur = JSON.parse(fs.readFileSync(p, 'utf8')); if (cur && cur.nonce === nonce) { fs.rmSync(p, { force: true }); } } catch (_) {}
}

// The production singleton guard: acquire the lock for `key`; on success start an unref'd heartbeat and return a
// handle whose release() clears the beat and removes the lock. On a confirmed LIVE conflict, log a clear fatal
// message via `logger` and exit(1) — refusing to start a second engine is the whole point.
//
// FAIL-OPEN on any OTHER (non-conflict) error (an unwritable data dir, a filesystem quirk): log loudly and start
// WITHOUT the guard rather than turn an infrastructure hiccup into a trading outage. The guard is added safety, not
// a new hard dependency for booting. `exit`/`logger` are injectable so the conflict path is unit-testable.
async function startGuard(options) {
	const key = options.key;
	const role = options.role || 'instance';
	const logger = options.logger || function () {};
	const exit = options.exit || function (c) { process.exit(c); };

	let acquired;
	try {
		acquired = await acquireSingleton(key, { role });
	} catch (e) {
		if (e && e.code === 'ALREADY_RUNNING') {
			logger('FATAL: refusing to start — another ' + role + ' is already running for this configuration. ' + e.message +
				' If you are certain it is not, stop it (or wait ' + Math.round(TTL_MS / 1000) + 's for a crashed one to age out) and retry.');
			exit(1);
			return null; // reached only when a test injects a non-exiting `exit`
		}
		logger('WARNING: singleton guard could not acquire its lock (' + (e && e.message) + '); continuing WITHOUT duplicate-start protection.');
		return null;
	}

	const { p, nonce } = acquired;
	const beat = setInterval(() => { refresh(p, nonce, role); }, BEAT_MS);
	if (beat.unref) { beat.unref(); }

	let released = false;
	let onExit = null;
	const handle = {
		p,
		nonce,
		async release() {
			if (released) { return; }
			released = true;
			clearInterval(beat);
			if (onExit) { try { process.removeListener('exit', onExit); } catch (_) {} }
			await release(p, nonce);
		},
		releaseSync() {
			if (released) { return; }
			released = true;
			clearInterval(beat);
			if (onExit) { try { process.removeListener('exit', onExit); } catch (_) {} }
			releaseSync(p, nonce);
		}
	};

	// Backstop for every exit path the caller's own shutdown doesn't reach (a forced/timed-out exit, a bare
	// process.exit). Registered here so no caller can forget it; idempotent with an explicit release() via the
	// `released` flag, and removed on release so repeated acquire/release cycles in one process can't accumulate
	// listeners. The 'exit' phase can only run synchronous code, hence releaseSync.
	onExit = () => { try { handle.releaseSync(); } catch (_) {} };
	try { process.once('exit', onExit); } catch (_) {}

	return handle;
}

module.exports = {
	TTL_MS, BEAT_MS, BIRTH_GRACE_MS, TEMP_STALE_MS,
	locksDir, lockPathFor, record, isProcessAlive, stale, readHolder, sweepStaleTemps,
	acquireSingleton, refresh, release, releaseSync, startGuard
};
