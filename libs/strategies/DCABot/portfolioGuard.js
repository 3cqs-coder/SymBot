'use strict';

// Portfolio-loss circuit-breaker trigger (pure decision logic).
//
// SymBot's circuit breaker already trips on market/feed anomalies (deal-trigger velocity, sudden price
// crashes, repeated bad prices). This adds the missing account-level safety net: halt opening NEW deals
// when realized losses over a rolling window breach a configured limit. It NEVER force-closes an open
// deal — like the rest of the breaker it only pauses new base orders, so positions are left to play out.
//
// This module is PURE (no DB, no shareData) so the decision is unit-testable; the caller (DCABot)
// supplies the realized net profit it aggregated over the window and, when configured, the account
// balance for the percent-of-balance limit.

// Decide whether to halt. Inputs:
//   netProfit  — realized NET profit (money) over the window; NEGATIVE means a net loss.
//   opts.enabled        — master on/off for this trigger.
//   opts.lossLimit      — absolute loss limit in quote currency (0/absent = disabled).
//   opts.lossLimitPercent, opts.balance — optional: halt if the loss reaches this % of balance.
//   opts.windowHours    — the rolling window (for the message only).
// Returns { halt: bool, reason: string }. A limit of 0 (or a non-loss) never halts. Pure; never throws.
function evaluatePortfolioLoss(netProfit, opts) {

	if (!opts || !opts.enabled) { return { halt: false, reason: '' }; }

	const loss = -(Number(netProfit) || 0);   // positive when there is a net loss
	if (!(loss > 0)) { return { halt: false, reason: '' }; }

	const amt = Number(opts.lossLimit) || 0;
	const pct = Number(opts.lossLimitPercent) || 0;
	const bal = Number(opts.balance) || 0;
	const hours = Number(opts.windowHours) || 24;

	const reasons = [];

	if (amt > 0 && loss >= amt) {
		reasons.push('realized loss ' + loss.toFixed(2) + ' reached the ' + amt.toFixed(2) + ' limit');
	}

	if (pct > 0 && bal > 0) {
		const pctLimit = bal * (pct / 100);
		if (loss >= pctLimit) {
			reasons.push('realized loss ' + loss.toFixed(2) + ' reached ' + pct + '% of balance (' + pctLimit.toFixed(2) + ')');
		}
	}

	if (reasons.length) {
		return {
			'halt': true,
			'reason': 'Portfolio loss over ' + hours + 'h: ' + reasons.join('; ') + '. New deals paused; open deals are unaffected.'
		};
	}

	return { halt: false, reason: '' };
}

module.exports = {
	evaluatePortfolioLoss
};
