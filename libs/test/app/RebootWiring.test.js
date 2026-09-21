'use strict';

// Guards the WIRING of the Hub-aware reboot, complementing RebootAfterOp.test.js (which locks the function's
// contract). The original bug was a CALLER — the DB-restore flow — omitting the Hub-aware branch and calling a
// bare exit(0), which under the Hub is treated as an intentional clean shutdown and never respawns, leaving the
// restored instance offline. A regression that re-inlined a bare shutdown in any of the three reboot flows
// (restore, rollback, system update) would pass RebootAfterOp.test.js, so this test pins that all three flows
// route through the shared helper.
//
// This is a lightweight source-level assertion (a full three-flow integration test would need heavy DB/crypto/
// worker fixtures). It counts the `await rebootAfterOp()` call sites: exactly three today — a successful DB
// restore, a successful rollback, and a successful system update. If a flow is edited to bypass the helper the
// count drops and this fails; if a NEW legitimate reboot flow is added, update EXPECTED_CALLS deliberately so
// the change is a conscious one.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const systemPath = path.resolve(__dirname, '..', '..', 'app', 'System.js');
const src = fs.readFileSync(systemPath, 'utf8');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ')'); passed++; }

const EXPECTED_CALLS = 3;   // restore success, rollback success, system-update success

// The helper must exist and be exported (RebootAfterOp.test.js proves its behavior).
ok(/async function rebootAfterOp\s*\(/.test(src), 'rebootAfterOp is defined in System.js');
ok(/\brebootAfterOp\b\s*,/.test(src) || /\brebootAfterOp\b\s*$/m.test(src), 'rebootAfterOp is exported for reuse/testing');

// Every reboot flow must route through the shared helper — not a bare shutdownFunction()/process.exit — so the
// Hub-aware branch can never be omitted again.
const callCount = (src.match(/await rebootAfterOp\(\)/g) || []).length;
eq(callCount, EXPECTED_CALLS,
	'all reboot flows (restore/rollback/update) call the shared Hub-aware reboot; a changed count means a flow ' +
	'was re-wired to bypass rebootAfterOp (regression) or a new reboot flow was added (update EXPECTED_CALLS)');

console.log('RebootWiring: ' + passed + ' assertions passed');
process.exit(0);
