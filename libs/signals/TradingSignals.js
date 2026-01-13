'use strict';

const { ATR, EMA, RSI, MACD, BollingerBands } = require('trading-signals');

let shareData;


const TIMEFRAME_MS = {
	'1m': 60_000,
	'5m': 300_000,
	'15m': 900_000,
	'1h': 3_600_000,
	'4h': 14_400_000,
	'1d': 86_400_000
};


const normalizeToDaily = (value, timeframe) => {

	const tfMs = TIMEFRAME_MS[timeframe] || TIMEFRAME_MS['1d'];

	return value * (TIMEFRAME_MS['1d'] / tfMs);
};


const isLowTimeframe = (tf) => ['1m', '5m', '15m'].includes(tf);


const emaTrendModule = ({ emaFast, emaSlow }) => {

	if (![emaFast, emaSlow].every(Number.isFinite)) return null;

	const trendUp = emaFast > emaSlow;

	return {
		values: { emaFast, emaSlow },
		signals: {
			trendUp,
			trendStrength: Math.abs(emaFast - emaSlow) / emaSlow
		}
	};
};


const rsiModule = ({ rsi }) => {

	if (!Number.isFinite(rsi)) return null;

	return {
		values: { rsi },
		signals: {
			bullishBias: rsi > 50,
			overbought: rsi > 70,
			oversold: rsi < 30
		}
	};
};


const macdModule = ({ macdResult }) => {

	if (!macdResult) return null;

	const { macd, signal, histogram } = macdResult;

	return {
		values: { macd, signal, histogram },
		signals: {
			bullish: macd > signal,
			momentumIncreasing: histogram > 0
		}
	};
};


const volatilityModule = ({ bbResult, lastClose }) => {

	if (!bbResult || !Number.isFinite(lastClose)) return null;

	const widthPct = ((bbResult.upper - bbResult.lower) / lastClose) * 100;

	let volatilityState = 'normal';
	if (widthPct < 4) volatilityState = 'compressed';
	else if (widthPct > 10) volatilityState = 'expanded';

	return {
		values: {
			bbUpper: bbResult.upper,
			bbMiddle: bbResult.middle,
			bbLower: bbResult.lower,
			bbWidthPct: widthPct
		},
		signals: { volatilityState }
	};
};


const computeMarketContextScore = (modules) => {

	let score = 50;

	if (modules.ema?.signals.trendUp) score += 15;
	else score -= 15;

	if (modules.rsi?.signals.bullishBias) score += 10;
	if (modules.rsi?.signals.overbought) score -= 5;
	if (modules.rsi?.signals.oversold) score += 5;

	if (modules.macd?.signals.bullish) score += 10;
	if (modules.macd && !modules.macd.signals.momentumIncreasing) score -= 5;

	if (modules.volatility?.signals.volatilityState === 'compressed') score -= 10;
	if (modules.volatility?.signals.volatilityState === 'expanded') score += 5;

	return Math.max(0, Math.min(score, 100));
};


const computeMarketIndicators = (ohlcv, config = {}) => {

	if (!Array.isArray(ohlcv) || ohlcv.length < 1) return null;

	const timeframe = config.timeframe || '1d';

	const emaFastPeriod = config.emaFastPeriod || 12;
	const emaSlowPeriod = config.emaSlowPeriod || 26;
	const rsiPeriod = config.rsiPeriod || 14;
	const atrPeriod = config.atrPeriod || 14;

	const useMACD = config.useMACD ?? true;
	const macdFastPeriod = config.macdFastPeriod || 12;
	const macdSlowPeriod = config.macdSlowPeriod || 26;
	const macdSignalPeriod = config.macdSignalPeriod || 9;

	const useBollingerBands = config.useBollingerBands ?? true;
	const bbPeriod = config.bbPeriod || 20;
	const bbDeviation = config.bbDeviation || 2;

	const minCandles = Math.max(
		emaSlowPeriod,
		rsiPeriod,
		atrPeriod,
		useMACD ? macdSlowPeriod + macdSignalPeriod + 1 : 0,
		useBollingerBands ? bbPeriod : 0
	);

	if (ohlcv.length < minCandles) return null;

	const emaFast = new EMA(emaFastPeriod);
	const emaSlow = new EMA(emaSlowPeriod);
	const rsi = new RSI(rsiPeriod);
	const atr = new ATR(atrPeriod);
	const bb = useBollingerBands ? new BollingerBands(bbPeriod, bbDeviation) : null;

	let macd = null;

	if (useMACD) {
		macd = new MACD(
			new EMA(macdFastPeriod),
			new EMA(macdSlowPeriod),
			new EMA(macdSignalPeriod)
		);
	}

	for (const candle of ohlcv) {

		const [timestamp, open, high, low, close] = candle.map(Number);

		if (![close, high, low].every(Number.isFinite)) continue;

		emaFast.update(close);
		emaSlow.update(close);
		rsi.update(close);
		atr.update({ close, high, low });
		if (bb) bb.update(close);
		if (macd) macd.add(close);
	}

	const fast = emaFast.getResult()?.valueOf();
	const slow = emaSlow.getResult()?.valueOf();
	const lastRsi = rsi.getResult()?.valueOf();
	const atrVal = atr.getResult()?.valueOf();
	const macdResult = macd?.getResult();
	const bbResult = bb?.getResult();

	if (![fast, slow, lastRsi, atrVal].every(Number.isFinite)) return null;

	const lastClose = Number(ohlcv.at(-1)[4]);
	if (!Number.isFinite(lastClose) || lastClose <= 0) return null;

	/* --- Normalize ATR to daily --- */
	const atrPct = (atrVal / lastClose) * 100;
	const atrDailyPct = normalizeToDaily(atrPct, timeframe);

	const modules = {
		ema: emaTrendModule({ emaFast: fast, emaSlow: slow }),
		rsi: rsiModule({ rsi: lastRsi }),
		macd: macdModule({ macdResult }),
		volatility: volatilityModule({ bbResult, lastClose })
	};

	const marketContextScore = computeMarketContextScore(modules);

	let trendMultiplier = 1;
	if (marketContextScore >= 70) trendMultiplier = 1.35;
	else if (marketContextScore >= 60) trendMultiplier = 1.2;
	else if (marketContextScore <= 40) trendMultiplier = 0.85;
	else if (marketContextScore <= 30) trendMultiplier = 0.7;

	if (modules.volatility?.signals.volatilityState === 'compressed') {
		trendMultiplier *= 0.9;
	}

	/* --- Confidence Warnings --- */
	const confidenceWarnings = [];
	if (isLowTimeframe(timeframe)) {
		trendMultiplier *= 0.8;
		confidenceWarnings.push('low_timeframe_noise');
	}
	if (ohlcv.length < minCandles * 1.5) {
		confidenceWarnings.push('limited_candle_history');
	}

	return {
		emaFast: fast,
		emaSlow: slow,
		rsi: lastRsi,
		atrPct,
		trend: marketContextScore >= 50 ? 'up' : 'down',
		trendMultiplier,

		// Enhanced data
		atrDailyPct,
		timeframe,
		timeframeMs: TIMEFRAME_MS[timeframe] || TIMEFRAME_MS['1d'],

		// MACD
		macd: macdResult?.macd ?? null,
		macdSignal: macdResult?.signal ?? null,
		macdHistogram: macdResult?.histogram ?? null,

		// Bollinger
		bbMiddle: bbResult?.middle ?? null,
		bbUpper: bbResult?.upper ?? null,
		bbLower: bbResult?.lower ?? null,
		volatilityState: modules.volatility?.signals.volatilityState ?? null,

		// Context
		marketContextScore,
		confidenceWarnings,

		marketModules: {
			phase:
				marketContextScore >= 70 ? 'strong_trend' :
				marketContextScore >= 55 ? 'weak_trend' :
				'range'
		}
	};
};


module.exports = {

	computeMarketIndicators,

	init: (obj) => { shareData = obj; }
};
