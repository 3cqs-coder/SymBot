'use strict';

// Drift-guard for the minimum Node.js version. The floor is stated in three places that MUST agree:
//   * package.json  "engines.node"  (the runtime source of truth — Bootstrap.js enforces against it)
//   * docker/Dockerfile  every  FROM node:<tag>  (the image the Docker deployment actually runs on)
//   * docs/README.md  the "vXX.YY" the requirements section states to the user
// A bump that updates one surface but not another would ship a silent inconsistency — the exact single-source
// invariant the project cares about (the README even calls its number "the single minimum the rest of the
// documentation refers back to"). This test parses the major.minor floor from package.json and asserts the
// Dockerfile tags and the README prose match it. Pure file reads + regex, no network, no process spawn.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

// ── Source of truth: package.json engines.node (e.g. ">=22.15.0") ────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const engines = (pkg.engines && pkg.engines.node) || '';
const m = engines.match(/(\d+)\.(\d+)(?:\.\d+)?/);
ok(!!m, 'package.json engines.node states a concrete version (' + engines + ')');

const major = m ? m[1] : null;
const minor = m ? m[2] : null;
const floor = major + '.' + minor;   // "22.15"

// ── Dockerfile: every `FROM node:<tag>` must match the floor's major.minor ────────
const dockerfile = fs.readFileSync(path.join(root, 'docker', 'Dockerfile'), 'utf8');
const froms = [...dockerfile.matchAll(/^FROM\s+node:(\d+)\.(\d+)/gim)];
ok(froms.length > 0, 'Dockerfile has at least one `FROM node:<version>` line');

for (const f of froms) {
	ok(f[1] === major && f[2] === minor,
		'Dockerfile `FROM node:' + f[1] + '.' + f[2] + '` matches the package.json floor (' + floor + ')');
}

// ── README: the requirements line must state the same vXX.YY ─────────────────────
const readme = fs.readFileSync(path.join(root, 'docs', 'README.md'), 'utf8');
ok(readme.indexOf('v' + floor) !== -1,
	'README states the minimum as v' + floor + ' (matches the package.json floor)');

// Guard against a stale OLDER minor lingering in the README requirements section — a lower "v22.<n>" than the
// floor would mislead a reader about what actually runs. (Feature-specific notes may cite a different number;
// this checks only that no v<major>.<lower-minor> appears as a stated minimum in the requirements area.)
const reqIdx = readme.indexOf('or later (a current v22 LTS release) must be installed');
if (reqIdx !== -1) {
	const around = readme.slice(Math.max(0, reqIdx - 200), reqIdx + 50);
	const stated = [...around.matchAll(new RegExp('v' + major + '\\.(\\d+)', 'g'))];
	let bad = false;
	for (const s of stated) { if (Number(s[1]) < Number(minor)) { bad = true; } }
	ok(!bad, 'the README requirements line names no v' + major + ' minor lower than the floor (' + floor + ')');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
