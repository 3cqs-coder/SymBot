'use strict';

// Regression gate for the deal-analysis DATA-PROVENANCE answer.
//
// The bug: a deal analysis DOES use live OHLCV candles — the report's Trend / RSI / Volatility / ATR / Market
// Score are technical indicators computed from them — and the analysis prompt even carries an explicit
// provenance note saying so. But on a follow-up ("did you use ohlcv?") the weak analysis model (llama3.2)
// denied it, falsely making the user distrust a correct report. The deterministic responder must read the
// provenance note from the conversation and answer from it, never the model.

const assert = require('assert');
const AIClient = require('../../ai/AIClient.js');

const prov = AIClient.analysisDataProvenance;
const asks = AIClient.looksLikeAnalysisDataSourceQuestion;
const parse = AIClient.parseAnalysisProvenance;
const text = AIClient.analysisProvenanceText;

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

const U = (content) => ({ role: 'user', content });
const A = (content) => ({ role: 'assistant', content });
const room = (messages) => ({ messages });

// The real provenance lines emitted by aiAnalyzeDealView.ejs.
const USED = 'This analysis WAS computed from live OHLCV candle data (1h timeframe, 200 candles) fetched from the exchange. The market condition values below (Trend, RSI, Volatility, ATR) are technical indicators derived from that OHLCV data. If the user asks whether OHLCV was used, the correct answer is YES — the indicators in this report come directly from OHLCV candles.';
const NOT_USED = 'Live OHLCV candle data was NOT available for this analysis (the exchange returned too few candles or none). The values below are fallback estimates, not OHLCV-derived indicators.';

// ── Provenance reader ──────────────────────────────────────────────────────
const usedConv = room([ U('## TRADING ANALYSIS REPORT\n### MARKET CONDITIONS\n' + USED), A('TRADING ANALYSIS REPORT ... Market score 85 ...'), U('did you use ohlcv?') ]);
const p1 = prov(usedConv);
ok(p1 && p1.used === true, 'reads used=true from the "WAS computed from live OHLCV" note');
ok(p1 && p1.timeframe === '1h', 'extracts the timeframe (1h) from the note');
ok(p1 && p1.candles === 200, 'extracts the candle count (200) from the note');

const notUsedConv = room([ U('### MARKET CONDITIONS\n' + NOT_USED), A('report...'), U('was ohlcv used?') ]);
const p2 = prov(notUsedConv);
ok(p2 && p2.used === false, 'reads used=false from the "NOT available" note');

// No provenance marker → null (an ordinary chat, so the responder falls through to the model).
ok(prov(room([ U('how are my deals?'), A('You have 9 open deals...'), U('did you use ohlcv?') ])) === null, 'a non-analysis conversation has no provenance marker → null');
ok(prov(room([])) === null, 'an empty conversation → null');

// ── Question detector ──────────────────────────────────────────────────────
for (const q of ['did you use ohlcv?', 'did you use OHLCV data?', 'was ohlcv used?', 'did you use live prices?',
	'did you use candle data?', 'was market data used in this?', 'did the analysis use ohlcv?',
	'where did the indicators come from?', 'are the indicators based on real candle data?']) {
	ok(asks(q), '"' + q + '" is recognized as a data-source question');
}
// Not a data-source question — an ordinary market/concept question must NOT match.
ok(!asks('what does RSI mean?'), '"what does RSI mean?" is a concept question, not a data-source question');
ok(!asks('is the market bullish?'), '"is the market bullish?" is not a data-source question');
ok(!asks('should I add funds?'), '"should I add funds?" is not a data-source question');

// ── Shared parser + formatter (report footer reuse) ────────────────────────
// parseAnalysisProvenance reads the marker straight from a prompt STRING (what the report footer has).
const pp = parse('### MARKET CONDITIONS\n' + USED);
ok(pp && pp.used === true && pp.timeframe === '1h' && pp.candles === 200, 'parseAnalysisProvenance reads used/timeframe/candles from a prompt string');
ok(parse('no marker here') === null, 'parseAnalysisProvenance returns null with no marker');

// analysisProvenanceText is the ONE sentence shared by the report footer and the follow-up answer.
const usedText = text({ used: true, timeframe: '1h', candles: 200 });
ok(/live OHLCV candle data \(1h, 200 candles\)/.test(usedText), 'the shared sentence names the OHLCV source, timeframe and candle count');
ok(/Trend, RSI, Volatility, ATR/.test(usedText), 'the shared sentence lists the OHLCV-derived indicators');
ok(/fallback estimates/.test(text({ used: false })), 'the not-used sentence says the values are fallback estimates');
ok(text(null) === '', 'unknown provenance → empty sentence (no footer / fall through)');

// The report footer and the follow-up answer are the SAME text, by construction (both call analysisProvenanceText).
ok(text(parse('### MARKET CONDITIONS\n' + USED)) === text(prov(usedConv)), 'the report footer and the follow-up answer produce identical provenance text');

console.log('AnalysisDataProvenance: ' + passed + ' assertions passed');
process.exit(passed && !process.exitCode ? 0 : 1);
