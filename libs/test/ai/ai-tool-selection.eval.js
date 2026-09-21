'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Offline regression check for AI tool SHORTLISTING (libs/ai/AITools.js selectTools).
//
// Runs entirely offline — no model, no database, no network — so it verifies in
// milliseconds that a question still routes to the right tool after a tool/description/
// examples change. It does NOT test the model's final tool CHOICE (that needs the live
// model); it tests that the correct tool is at least made AVAILABLE to the model.
//
// Not deployed (see the tests-not-deployed convention): production never requires this file.
// Run it manually:   node test/ai-tool-selection.eval.js
// Exit code is 0 when every case passes and every tool is covered, 1 otherwise.
// ─────────────────────────────────────────────────────────────────────────────

const aiTools = require('../../ai/AITools.js');

// A case passes if selectTools(q) contains AT LEAST ONE of `expect`. Several intents legitimately
// map to more than one acceptable tool (e.g. "why is this deal stuck" → diagnose_deal OR
// get_paused_deals), so `expect` is an allow-set, not a single answer.
const CASES = [
	// deals — status / ranking / proximity
	{ q: 'which single deal is closest to hitting take profit',        expect: ['get_deals_closest_to_take_profit'] },
	{ q: 'which deal will close first',                                expect: ['get_deals_closest_to_take_profit'] },
	{ q: 'what are my best performing deals',                          expect: ['get_top_deals'] },
	{ q: 'show me my three worst deals by profit',                     expect: ['get_top_deals'] },
	{ q: 'list my open deals',                                         expect: ['list_open_deals'] },
	{ q: 'give me the status of all my open positions',               expect: ['get_open_deals_status'] },
	{ q: 'which deals have been open the longest',                    expect: ['find_oldest_open_deals'] },
	{ q: 'which deals are running out of safety orders',              expect: ['find_deals_near_max_safety_orders'] },
	{ q: 'which deals are nearly exhausted on their ladder',          expect: ['find_deals_near_max_safety_orders'] },

	// single deal / pair
	{ q: 'tell me about my ABT/USD deal, how far underwater is it',    expect: ['get_deals_for_pair', 'get_deal', 'diagnose_deal'] },
	{ q: 'how is my BTC deal doing',                                   expect: ['get_deals_for_pair', 'get_pair_performance'] },
	// A SINGLE named pair's performance routes to get_performance_summary (pair=) or the pair's
	// deals — NOT get_pair_performance, which ranks ACROSS pairs and cannot filter to one.
	{ q: 'how has ETH performed for me overall',                       expect: ['get_performance_summary', 'get_deals_for_pair', 'get_pair_performance'] },
	// Contrastive diagnosis → compare_deal_to_baseline (or diagnose_deal).
	{ q: 'why did this deal do worse than my other ones',             expect: ['compare_deal_to_baseline', 'diagnose_deal'] },
	// Error baseline anomaly → analyze_error_baseline.
	{ q: 'are there more errors than usual today',                    expect: ['analyze_error_baseline', 'summarize_recent_errors'] },
	{ q: 'is anything unusual or spiking in the logs',                expect: ['analyze_error_baseline', 'summarize_recent_errors'] },
	// Per-period time-series (day/week/month buckets) → get_deals_over_time, NOT the lump-total tools.
	{ q: 'how many deals did I close each day this week',              expect: ['get_deals_over_time'] },
	{ q: 'show my profit by month this year',                         expect: ['get_deals_over_time'] },
	{ q: 'show the fill ladder and orders on this deal',              expect: ['get_deal_orders'] },
	{ q: 'walk me through the full timeline of this deal',           expect: ['get_deal_timeline', 'get_deal_events', 'diagnose_deal'] },
	{ q: 'why is this deal stuck and not filling',                    expect: ['diagnose_deal', 'get_paused_deals', 'get_deal_events'] },
	{ q: 'which deals are paused right now',                          expect: ['get_paused_deals'] },
	{ q: 'what is the deal id for my SPK position',                   expect: ['find_deal_id'] },

	// risk / exposure / portfolio / balance
	{ q: 'which of my positions are the riskiest',                   expect: ['get_open_risk_summary'] },
	{ q: 'how much am I down overall',                               expect: ['get_open_risk_summary', 'get_open_deals_status'] },
	{ q: 'how much dry powder do I have left to deploy',            expect: ['get_exposure_summary'] },
	{ q: 'what is my total capital exposure',                       expect: ['get_exposure_summary'] },
	{ q: 'give me an overall portfolio summary',                    expect: ['get_portfolio_summary'] },
	{ q: 'what is my available account balance on the exchange',    expect: ['get_balance'] },

	// performance / bots
	{ q: 'what is my overall win rate this month',                  expect: ['get_performance_summary'] },
	{ q: 'how many deals have I completed',                         expect: ['get_performance_summary'] },
	{ q: 'how is my SymSync bot performing',                        expect: ['get_bot_performance'] },
	{ q: 'what bots do I have configured',                          expect: ['list_bots'] },
	{ q: 'show me my recently closed deals and their profit',      expect: ['list_recent_completed_deals'] },
	{ q: 'give me a deep expert analysis of my account',           expect: ['get_expert_analysis'] },

	// logs / forensics
	{ q: 'show me the most common errors in the logs',             expect: ['summarize_recent_errors'] },
	{ q: 'search my logs for insufficient funds and sell errors',  expect: ['search_logs'] },
	{ q: 'how often does this warning appear over the week',       expect: ['analyze_logs', 'search_logs'] },
	{ q: 'how many orders were placed today',                      expect: ['count_orders', 'analyze_logs'] },
	{ q: 'what happened between 2pm and 3pm across all deals',     expect: ['get_events_in_window'] },
	{ q: 'was there an incident around 3pm, correlate the errors', expect: ['find_incident', 'get_events_in_window'] },
	{ q: 'were there any implausible or zero price ticks today',   expect: ['scan_price_anomalies'] },
	{ q: 'how many times has symbot restarted today',              expect: ['count_restarts'] },

	// system
	{ q: 'is the circuit breaker active, why are new deals not starting', expect: ['get_circuit_breaker_status'] },

	// bots / schedules / audit / open-order analytics
	{ q: 'compare my bots against each other',                       expect: ['compare_bot_performance', 'get_bot_performance'] },
	{ q: 'what scheduled tasks and automations do I have',           expect: ['list_schedules'] },
	{ q: 'who changed my configuration recently, audit trail',       expect: ['list_audit_events'] },
	{ q: 'show my drawdown risk',                                    expect: ['get_drawdown_risk', 'get_open_risk_summary'] },
	{ q: 'how many open orders are resting on the exchange',         expect: ['get_open_orders_summary', 'count_orders'] },
];

function run() {

	let pass = 0;
	const failures = [];

	for (const c of CASES) {

		const sel = aiTools.selectTools(c.q);
		const hit = c.expect.some(t => sel.includes(t));

		if (hit) { pass++; }
		else { failures.push({ q: c.q, expect: c.expect, got: sel }); }
	}

	// Coverage: every real tool (excluding the always-appended `explore` sub-agent and the
	// always-present CORE tools) should be the expected answer in at least one case, so a tool that
	// silently stops being routable is caught.
	const allTools = aiTools.TOOLS.map(t => t.name).filter(n => n !== 'explore');
	const covered = new Set();
	for (const c of CASES) { for (const t of c.expect) { covered.add(t); } }
	const uncovered = allTools.filter(n => !covered.has(n));

	console.log('AI tool-selection eval\n');
	for (const f of failures) {
		console.log('  FAIL  "' + f.q + '"');
		console.log('        expected one of [' + f.expect.join(', ') + ']');
		console.log('        got shortlist   [' + f.got.join(', ') + ']');
	}
	console.log('\n  ' + pass + '/' + CASES.length + ' cases routed correctly');

	if (uncovered.length) {
		console.log('  NOTE: tools with no case in this harness: ' + uncovered.join(', '));
	}

	const ok = failures.length === 0 && uncovered.length === 0;
	console.log('\n  ' + (ok ? 'PASS — all cases routed and every tool covered' : 'FAIL — see above'));
	return ok ? 0 : 1;
}

process.exit(run());
