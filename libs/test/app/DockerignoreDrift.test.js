'use strict';

// Integrity guard for the project's SINGLE Docker build-context ignore file.
//
// All Docker files live under docker/, so there is exactly one ignore file: docker/Dockerfile.dockerignore.
// BuildKit reads it through the <Dockerfile>.dockerignore convention, because compose builds with
// `context: ..` and `dockerfile: ./docker/Dockerfile`. There is deliberately NO root .dockerignore. This test
// guards two things the image's safety depends on:
//   1. No stray root .dockerignore has reappeared. Docker files stay under docker/, and a second ignore file
//      would be one the BuildKit build never reads, free to drift from this one.
//   2. The security-critical exclusions are still present, so a build can never ship a developer's runtime
//      state or real secrets (data/, logs/, backups/, sessions/, config/server*.json, bot-*.json, and the
//      local-only symbot-backlog.md).

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

// 1) There must be no root .dockerignore. The only ignore file is docker/Dockerfile.dockerignore, kept with
// the rest of the Docker files under docker/. A root file would be a second, drift-prone ignore that the
// BuildKit build does not even read.
ok(!fs.existsSync(path.join(root, '.dockerignore')),
	'there must be no root .dockerignore — the only Docker ignore file is docker/Dockerfile.dockerignore (all Docker files live under docker/)');

// 2) The security-critical exclusions must be present in the ignore file, guarding against accidental removal.
// A missing one would ship live secrets or runtime state into the image.
const ignore = patterns('docker/Dockerfile.dockerignore');
const MUST_EXCLUDE = [
	'node_modules/', 'data/', 'logs/', 'backups/', 'sessions/',
	'config/server*.json', 'config/bot-*.json', 'config/*copy*.json', 'config/*real*.json',
	'symbot-backlog.md'
];

for (const pat of MUST_EXCLUDE) {
	ok(ignore.includes(pat),
		'docker/Dockerfile.dockerignore must exclude "' + pat + '" (runtime state or a secret otherwise ships in the image)');
}

console.log('DockerignoreDrift: ' + passed + ' assertions passed');
process.exit(0);
