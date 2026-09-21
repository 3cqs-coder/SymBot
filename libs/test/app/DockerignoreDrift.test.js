'use strict';

// Drift guard for the TWO build-context ignore files that must stay in sync:
//   • .dockerignore                      — read by the classic Docker builder
//   • docker/Dockerfile.dockerignore     — read by BuildKit (<Dockerfile>.dockerignore)
// Both are documented as "kept in sync," and the image's safety depends on it: they exclude a developer's
// runtime state and real secrets (data/, logs/, backups/, sessions/, config/server*.json, bot-*.json, the
// local-only symbot-backlog.md) from the build context. If one builder's file drifts from the other — or a
// critical exclusion is removed from both — an image built with that builder could ship live secrets or state.
// The two files' COMMENTS legitimately differ (each describes its own role), so this compares only the effective
// ignore PATTERNS (non-comment, non-blank lines). Mirrors the project's other *Drift.test.js guards.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

function patterns(file) {
	const text = fs.readFileSync(path.join(root, file), 'utf8');
	return text.split(/\r?\n/)
		.map(l => l.trim())
		.filter(l => l && l[0] !== '#');
}

const classic  = patterns('.dockerignore');
const buildkit = patterns('docker/Dockerfile.dockerignore');

// 1) The two builders must apply the SAME exclusions (order-independent set equality).
const setA = [ ...new Set(classic) ].sort();
const setB = [ ...new Set(buildkit) ].sort();
assert.deepStrictEqual(setA, setB,
	'.dockerignore and docker/Dockerfile.dockerignore must exclude the same patterns; they have drifted:\n' +
	'  only in .dockerignore: ' + classic.filter(p => !buildkit.includes(p)).join(', ') + '\n' +
	'  only in Dockerfile.dockerignore: ' + buildkit.filter(p => !classic.includes(p)).join(', '));
passed++;

// 2) The security-critical exclusions must be present in BOTH (guards against removal, not just divergence).
// A missing one of these would ship live secrets or runtime state into the image under that builder.
const MUST_EXCLUDE = [
	'node_modules/', 'data/', 'logs/', 'backups/', 'sessions/',
	'config/server*.json', 'config/bot-*.json', 'config/*copy*.json', 'config/*real*.json',
	'symbot-backlog.md'
];

for (const pat of MUST_EXCLUDE) {
	ok(classic.includes(pat),  '.dockerignore must exclude "' + pat + '" (runtime state or a secret otherwise ships in the image)');
	ok(buildkit.includes(pat), 'docker/Dockerfile.dockerignore must exclude "' + pat + '"');
}

console.log('DockerignoreDrift: ' + passed + ' assertions passed');
process.exit(0);
