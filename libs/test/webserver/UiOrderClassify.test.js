'use strict';

// Pins the shared client-side classifiers that keep "system vs user" order rungs consistent across the
// instance deal list, the Hub deal list, and the order-history modal:
//   * systemOrderInfo(order)  — labels a manual rung as an auto (system) action or a user Add-Funds action
//     from its manualReason flag (the order-rung analogue of systemPauseInfo).
//   * addedFundsCount(orders) — counts ONLY user Add-Funds rungs (genuine additions to the max, shown as
//     "(+N)"); an auto partial-fill-credit re-uses an existing safety-order slot and must NOT be counted.
// symbot-ui.js is browser code, so it is loaded with a minimal window shim (its jQuery/DOM calls are all
// inside functions, never at load time).

const assert = require('assert');

global.window = global.window || {};
require('../../webserver/public/js/symbot-ui.js');
const UI = global.window.SymBot.UI;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); passed++; }

// ── systemOrderInfo ──────────────────────────────────────────────────────────
const credit = { filled: 1, manual: true, manualReason: 'partial_fill_credit' };
const addf   = { filled: 1, manual: true };
const so     = { filled: 1 };

let info = UI.systemOrderInfo(credit);
ok(info.isManual && info.isSystem, 'auto-credit rung → manual + system');
eq(info.label, 'system', 'auto-credit label is "system"');

info = UI.systemOrderInfo(addf);
ok(info.isManual && !info.isSystem, 'user add-funds rung → manual, NOT system');
eq(info.label, 'manual', 'add-funds label is "manual"');
eq(info.tooltip, 'Manually added funds.', 'add-funds tooltip');

info = UI.systemOrderInfo(so);
ok(!info.isManual && !info.isSystem, 'normal filled safety order → neither manual nor system');

info = UI.systemOrderInfo(null);
ok(!info.isManual && !info.isSystem && info.label === '' && info.tooltip === '', 'null order is safe');

// an unknown manualReason falls back to the user branch (never falsely "system")
info = UI.systemOrderInfo({ manual: true, manualReason: 'something_else' });
ok(info.isManual && !info.isSystem, 'unknown manualReason → user branch, not system');

// ── addedFundsCount ──────────────────────────────────────────────────────────
eq(UI.addedFundsCount([so, credit, credit]), 0, 'VELO case: 2 auto-credits, 0 additions');
eq(UI.addedFundsCount([so, addf, addf]), 2, 'two Add-Funds → 2 additions');
eq(UI.addedFundsCount([so, so, credit, addf]), 1, 'mix: only the Add-Funds counts');
eq(UI.addedFundsCount([so, { manual: true, filled: 0 }]), 0, 'an unfilled manual rung is not an addition');
eq(UI.addedFundsCount(null), 0, 'null orders → 0');
eq(UI.addedFundsCount('nope'), 0, 'non-array → 0');
eq(UI.addedFundsCount([so, so, so]), 0, 'plain safety orders → 0 additions');

console.log('UiOrderClassify: ' + passed + ' assertions passed');
process.exit(0);
