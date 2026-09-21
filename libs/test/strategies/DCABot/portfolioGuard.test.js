'use strict';

// Tests the portfolio-loss circuit-breaker decision logic.

const assert = require('assert');
const { evaluatePortfolioLoss } = require('../../../strategies/DCABot/portfolioGuard.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// disabled / no-op cases
ok(evaluatePortfolioLoss(-500, { enabled: false, lossLimit: 100 }).halt === false, 'disabled → never halts');
ok(evaluatePortfolioLoss(-500, { enabled: true, lossLimit: 0 }).halt === false, 'zero limit → never halts');
ok(evaluatePortfolioLoss(250, { enabled: true, lossLimit: 100 }).halt === false, 'net PROFIT → never halts');
ok(evaluatePortfolioLoss(0, { enabled: true, lossLimit: 100 }).halt === false, 'break-even → never halts');

// absolute amount limit
ok(evaluatePortfolioLoss(-100, { enabled: true, lossLimit: 100, windowHours: 24 }).halt === true, 'loss exactly at limit → halts');
ok(evaluatePortfolioLoss(-150, { enabled: true, lossLimit: 100 }).halt === true, 'loss beyond limit → halts');
ok(evaluatePortfolioLoss(-99.99, { enabled: true, lossLimit: 100 }).halt === false, 'loss just under limit → no halt');
ok(/realized loss 150\.00 reached the 100\.00 limit/.test(evaluatePortfolioLoss(-150, { enabled: true, lossLimit: 100 }).reason), 'reason names loss + limit');
ok(/open deals are unaffected/.test(evaluatePortfolioLoss(-150, { enabled: true, lossLimit: 100 }).reason), 'reason states open deals unaffected');

// percent-of-balance limit
ok(evaluatePortfolioLoss(-500, { enabled: true, lossLimitPercent: 5, balance: 10000 }).halt === true, 'loss ≥ 5% of 10000 → halts');
ok(evaluatePortfolioLoss(-400, { enabled: true, lossLimitPercent: 5, balance: 10000 }).halt === false, 'loss < 5% of 10000 → no halt');
ok(evaluatePortfolioLoss(-500, { enabled: true, lossLimitPercent: 5, balance: 0 }).halt === false, 'percent limit ignored when balance unknown');

// either limit can trip
(() => {
	const r = evaluatePortfolioLoss(-120, { enabled: true, lossLimit: 100, lossLimitPercent: 50, balance: 10000 });
	ok(r.halt === true, 'amount trips even when percent does not');
})();

console.log('portfolioGuard: ' + passed + ' assertions passed');
