'use strict';

// Tests Common.resolveDataFilePath — how a download resolves a filename to a path. The important new
// property is the HUB path: with a server_id it resolves to the EXACT instance folder (so two instances'
// same-named files, e.g. a bare "<date>.log", stay distinct), and both the filename AND the server_id are
// traversal-guarded. The single-instance path resolves within its own folder. Creates disposable instance
// folders under the real data tree (unique test ids) and removes them afterwards.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Common = require('../../app/Common.js');
Common.init({ appData: { server_id: '', worker_data: { name: '' } } });

const pathRoot = path.resolve(__dirname, '..', '..', '..');
const base = path.join(pathRoot, 'data', 'instances');
const SID_A = 'test-resolve-A-' + Math.floor(Math.random() * 1e9);
const SID_B = 'test-resolve-B-' + Math.floor(Math.random() * 1e9);
const FILE = '2099-12-31.log';   // a date no real log uses, so the no-sid fallback sees only these test files

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

function mk(sid) {
	const dir = path.join(base, sid, 'logs');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, FILE), 'log-of-' + sid);
	return dir;
}

try {
	const dirA = mk(SID_A);
	const dirB = mk(SID_B);

	// Hub WITH server_id → resolves to the exact instance's file (not the other's), even though the bare
	// filename is identical in both folders.
	const pA = Common.resolveDataFilePath('logs', FILE, true, SID_A);
	const pB = Common.resolveDataFilePath('logs', FILE, true, SID_B);
	ok(pA && fs.readFileSync(pA, 'utf8') === 'log-of-' + SID_A, 'Hub with sid A resolves A\'s file');
	ok(pB && fs.readFileSync(pB, 'utf8') === 'log-of-' + SID_B, 'Hub with sid B resolves B\'s file (same filename, different instance)');
	ok(pA !== pB, 'the two same-named files resolve to DISTINCT paths by server_id');

	// A server_id that names no instance → null (not a wrong-file fallback).
	ok(Common.resolveDataFilePath('logs', FILE, true, 'no-such-sid') === null, 'an unknown server_id resolves to null');

	// Traversal guards — both the server_id and the filename are basename-checked.
	ok(Common.resolveDataFilePath('logs', FILE, true, '../' + SID_A) === null, 'a traversal server_id is rejected');
	ok(Common.resolveDataFilePath('logs', FILE, true, '..') === null, 'a ".." server_id is rejected');
	ok(Common.resolveDataFilePath('logs', 'a/b.log', true, SID_A) === null, 'a traversal filename is rejected');

	// Hub WITHOUT server_id → legacy first-match fallback still finds a file (kept for old links / unique names).
	const pAny = Common.resolveDataFilePath('logs', FILE, true);
	ok(pAny && [ 'log-of-' + SID_A, 'log-of-' + SID_B ].indexOf(fs.readFileSync(pAny, 'utf8')) >= 0, 'Hub without a server_id still resolves by first basename match');

	// A SYMLINK named like a valid artifact is REFUSED (never followed), so a link planted in a data dir can't
	// be used to read an arbitrary file. Uses lstat, so the target's realness is irrelevant. Skipped only if the
	// platform can't create symlinks (e.g. unprivileged Windows).
	const SID_L = 'test-resolve-L-' + SID_A.slice(-9);
	const linkDir = path.join(base, SID_L, 'logs');
	let linkMade = false;
	try {
		fs.mkdirSync(linkDir, { recursive: true });
		fs.symlinkSync('/etc/hosts', path.join(linkDir, FILE));
		linkMade = true;
	}
	catch (e) { linkMade = false; }
	if (linkMade) {
		ok(Common.resolveDataFilePath('logs', FILE, true, SID_L) === null, 'a symlink is refused on the Hub server_id path (not followed)');
	}
	try { fs.rmSync(path.join(base, SID_L), { recursive: true, force: true }); } catch (e) {}

	console.log('ResolveDataFilePath: ' + passed + ' assertions passed');
}
catch (e) { console.error('ResolveDataFilePath FAIL: ' + (e && e.stack || e)); process.exitCode = 1; }
finally {
	try { fs.rmSync(path.join(base, SID_A), { recursive: true, force: true }); } catch (e) {}
	try { fs.rmSync(path.join(base, SID_B), { recursive: true, force: true }); } catch (e) {}
}

process.exit(process.exitCode ? 1 : 0);
