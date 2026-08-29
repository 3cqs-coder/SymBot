'use strict';


// Drawdown sentinel — a scheduled risk recipe. Registers the 'drawdown_sentinel' job type: when it
// fires it takes a DETERMINISTIC snapshot of open-deal risk (deals underwater past a threshold, and
// deals whose safety-order ladder is nearly exhausted) and, ONLY when something breaches, delivers a
// concise detailed alert. A clean check is silent. Read-only: it looks at deal state, never trades.
//
// This recipe is `ai_optional`: it works with NO AI configured (the alert is built from figures, not
// a model). If the schedule turns on `settings.ai_enhance` AND an AI provider is available, it also
// appends a short plain-language "AI take" over those figures — best-effort, so a model error or a
// missing provider just omits the narrative and still delivers the deterministic alert.


const DealQuery = require('../queries/DealQuery');

// The AI "take" system prompt lives in a data file (read via the shared AI loader) rather than inline, so
// a stray character in the wording can never turn this source file into a syntax error.
const { readText } = require('../ai/AIGuardrails');
const AI_NARRATIVE_SYSTEM = readText('drawdown-sentinel.txt');


function register(scheduler, shareData) {

	scheduler.registerHandler('drawdown_sentinel', async (job) => {

		const settings = (job && job.settings) || {};

		try {

			const risk = await DealQuery.getDrawdownRisk(settings.underwater_pct, settings.so_used_fraction);

			if (!risk || risk.success !== true) {
				// Route a data-fetch failure through the SAME catch below (which delivers the failure notice),
				// rather than returning silently — otherwise "notify me on failure" would miss it.
				throw new Error((risk && risk.error) || 'no data');
			}

			const breaches = (risk.underwater_count || 0) + (risk.near_max_safety_count || 0);

			// Calm portfolios stay quiet — the run output is the deterministic "nothing breaching" line.
			let output = runSummary(job, risk);

			// Alert only when something breaches.
			if (breaches > 0) {

				let message = formatAlert(job, risk);

				// Optional AI enhancement — appended over the SAME figures. Best-effort and gated.
				if (settings.ai_enhance === true && aiAvailable(shareData)) {
					const narrative = await aiNarrative(shareData, risk);
					if (narrative) { message += '\n\n🧠 AI take: ' + narrative; }
				}

				const targets = shareData.ScheduleNotifier.resolveTargets(job.settings);
				await shareData.ScheduleNotifier.deliver(targets, { message: message, type: 'warning', status: 'error' });

				// Surface the SAME enhanced alert as the stored/manual-run result, so ticking
				// "Enhance with AI" is visible in the run output — not only in the delivered notification.
				output = message;
			}

			return { status: 'ok', output: output };
		}
		catch (e) {

			shareData.Common.logger('Scheduler: drawdown_sentinel run failed for ' + (job && job.schedule_id) + ': ' + e.message);
			try {
				const targets = shareData.ScheduleNotifier.resolveTargets(job.settings);
				await shareData.ScheduleNotifier.deliver(targets, { message: '⚠️ ' + (job.label || 'Drawdown sentinel') + ' failed: ' + e.message, type: 'warning', status: 'error' });
			}
			catch (e2) { /* notify is best-effort */ }

			return { status: 'error', output: 'Drawdown check failed: ' + e.message };
		}
	});
}


// Is an AI provider available for the optional enhancement? (config gate + a callable completePrompt).
function aiAvailable(shareData) {
	const ai = (shareData && shareData.appData && shareData.appData.ai) || {};
	const providerOn = !!((ai.ollama && ai.ollama.enabled) || (ai.openai && ai.openai.enabled));
	return providerOn && shareData.AIClient && typeof shareData.AIClient.completePrompt === 'function';
}

// Build a CORRECT plain-English digest of the risk state, deterministically in code. This is the key
// to a model-agnostic, future-proof AI take: rather than hand a model raw JSON and hope it counts and
// pairs figures correctly (small local models reliably fumble that — e.g. collapsing two different
// safety-order counts into one), we pre-state the facts as clear prose. The model then only has to
// rephrase/interpret correct English, which even a tiny model does reliably and a larger model does
// better — and because every fact it is given is already correct, even a restatement stays accurate.
// Crucially, "ladder exhausted" (no safety orders left) is distinguished from merely "nearing", the
// one thing a model kept softening. Returns '' when there is nothing worth a sentence.
function buildRiskDigest(risk) {

	const parts = [];

	const worst = (Array.isArray(risk.underwater) && risk.underwater[0]) || null;
	if (worst && worst.pair) {
		parts.push(worst.pair + ' is the deepest-underwater open position');
	}

	const near = Array.isArray(risk.near_max_safety) ? risk.near_max_safety : [];
	const exhausted = near.filter((d) => d && d.ladderExhausted);
	const nearing   = near.filter((d) => d && !d.ladderExhausted);

	if (exhausted.length) {
		parts.push(exhausted.length + ' deal(s) have FULLY exhausted their safety-order ladder and can add no more safety orders (' + exhausted.map((d) => d.pair).join(', ') + '), so those positions can only recover on price');
	}
	if (nearing.length) {
		parts.push(nearing.length + ' deal(s) are close to their safety-order limit (' + nearing.map((d) => d.pair).join(', ') + ')');
	}

	if (risk.total_unrealized_pnl != null) {
		const n = Number(risk.total_unrealized_pnl);
		if (!Number.isNaN(n)) {
			parts.push('the open positions overall show an unrealized ' + (n < 0 ? 'loss' : 'gain'));
		}
	}

	return parts.length ? (parts.join('; ') + '.') : '';
}

// One short, grounded narrative — the model interprets the deterministic digest above, never raw
// figures. Best-effort: returns '' on any failure (or an empty digest) so the caller just omits it.
async function aiNarrative(shareData, risk) {
	try {
		const digest = buildRiskDigest(risk);
		if (!digest) { return ''; }

		const model = (typeof shareData.AIClient.getModelName === 'function') ? shareData.AIClient.getModelName() : undefined;
		const out = await shareData.AIClient.completePrompt([
			{ role: 'system', content: AI_NARRATIVE_SYSTEM },
			{ role: 'user', content: digest }
		], model, { temperature: 0.2 });
		return (typeof out === 'string' ? out : '').trim();
	}
	catch (e) { return ''; }
}


const MAX_ROWS = 8;

function formatAlert(job, risk) {

	const lines = [ '🛡️ ' + (job.label || 'Drawdown sentinel') ];

	const parts = [];
	if (risk.underwater_count) { parts.push(risk.underwater_count + ' deal(s) underwater past ' + risk.underwater_threshold_pct + '%'); }
	if (risk.near_max_safety_count) { parts.push(risk.near_max_safety_count + ' deal(s) low on safety orders'); }
	lines.push('', parts.join('  ·  ') + '.');

	if (risk.total_unrealized_pnl != null) { lines.push('Open unrealized P/L: ' + risk.total_unrealized_pnl + '.'); }

	if (risk.underwater_count) {
		lines.push('', 'Underwater (worst first):');
		for (const d of risk.underwater.slice(0, MAX_ROWS)) {
			lines.push('• ' + d.pair + '  ' + d.unrealizedPct + '%' + (d.unrealizedPnl != null ? ('  (' + d.unrealizedPnl + ')') : '') + '  · ' + d.safetyOrdersUsed + ' SOs used');
		}
		if (risk.underwater_count > MAX_ROWS) { lines.push('…and ' + (risk.underwater_count - MAX_ROWS) + ' more.'); }
	}

	if (risk.near_max_safety_count) {
		lines.push('', 'Low on safety orders:');
		for (const d of risk.near_max_safety.slice(0, MAX_ROWS)) {
			lines.push('• ' + d.pair + '  ' + d.safetyOrdersUsed + '/' + d.safetyOrdersMax + ' SOs used' + (d.ladderExhausted ? '  (ladder exhausted)' : ''));
		}
		if (risk.near_max_safety_count > MAX_ROWS) { lines.push('…and ' + (risk.near_max_safety_count - MAX_ROWS) + ' more.'); }
	}

	return lines.join('\n');
}

function runSummary(job, risk) {
	const breaches = (risk.underwater_count || 0) + (risk.near_max_safety_count || 0);
	if (breaches > 0) { return formatAlert(job, risk); }
	return '✓ ' + (job.label || 'Drawdown sentinel') + ': nothing breaching — no deal is underwater past ' + risk.underwater_threshold_pct + '% and none is near its safety-order limit. ' + risk.open_deals + ' open deal(s), unrealized P/L ' + (risk.total_unrealized_pnl != null ? risk.total_unrealized_pnl : 'n/a') + '.';
}


module.exports = { register };