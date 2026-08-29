/*
 * SymBot deal chart — a per-deal candlestick chart (TradingView Lightweight Charts) that overlays the
 * deal's own order ladder, average entry, take-profit target, and fills. Shared verbatim by the
 * instance and Hub deals views. Read-only and self-contained: candles come from /api/markets/ohlcv (public
 * market data via the server's keyless ccxt client) and the overlay comes from the client-side
 * dealTracker the views already maintain, so nothing here touches the trading loop.
 *
 * Opened as a modal with two tabs — "Deal" (this overlay chart, default) and "TradingView" (the
 * existing widget for the same pair). The chart theme is Auto (follows the app) / Light / Dark, and the
 * last tab + theme choice are remembered per browser.
 */
(function () {

	'use strict';

	window.SymBot = window.SymBot || {};

	var LWC       = null;                        // resolved on first open
	var THEME_KEY = 'symbot_chart_theme';        // 'auto' | 'light' | 'dark'
	var TAB_KEY   = 'symbot_chart_tab';          // 'deal' | 'tv'
	var TF_KEY    = 'symbot_chart_timeframe';    // last interval, e.g. '1h'

	// ── palettes ──────────────────────────────────────────────────────────────
	var PALETTES = {
		dark:  { bg:'#151b21', text:'#8b97a3', grid:'#1c242c', border:'#232c35',
		         up:'#2ebd85', down:'#e0555a', buy:'#5b9bd5', avg:'#e0a92e', tp:'#3ddc84', pending:'#d0872e' },
		light: { bg:'#ffffff', text:'#5a6673', grid:'#eef1f4', border:'#d7dde3',
		         up:'#1a9f66', down:'#d64b50', buy:'#2f6fb0', avg:'#b07d00', tp:'#1a9f66', pending:'#b56a00' }
	};

	function num(v) { var n = Number(v); return isFinite(n) ? n : NaN; }

	// Decimal precision for the price axis and every price-line label. Lightweight Charts otherwise
	// defaults to 2 decimals (minMove 0.01), which rounds a sub-cent pair's levels to 0.01 / 0.00. We
	// derive the precision from the smallest visible level so low-priced pairs (e.g. a token at
	// 0.004309) render in full: the leading zeros after the decimal point plus ~4 significant figures.
	// Prices at or above 1 keep the conventional 2 decimals. Capped so a microscopic order can't produce
	// an absurdly wide axis. Read-only display math — nothing here affects orders or the trading loop.
	function priceDecimals(levels) {
		var minV = Infinity;
		for (var i = 0; i < levels.length; i++) {
			var v = Math.abs(Number(levels[i]));
			if (isFinite(v) && v > 0 && v < minV) { minV = v; }
		}
		if (!isFinite(minV)) { return 2; }
		if (minV >= 1) { return 2; }
		var leadingZeros = Math.floor(-Math.log10(minV));
		return Math.min(leadingZeros + 4, 10);
	}

	// SymBot sets body[data-theme="dark"] for dark and removes it for light.
	function appTheme() { return document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }

	function themePref() { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; } }
	function resolveTheme() { var p = themePref(); return (p === 'light' || p === 'dark') ? p : appTheme(); }
	function setThemePref(p) { try { localStorage.setItem(THEME_KEY, p); } catch (e) {} }

	function esc(s) { return (window.SymBot.UI && SymBot.UI.esc) ? SymBot.UI.esc(s) : String(s == null ? '' : s); }

	// Lazy-load the (heavy) charting library only when a chart is first opened, so it never weighs on
	// pages that don't chart. Injected once; subsequent calls resolve immediately.
	var _libPromise = null;
	function ensureLib() {
		if (window.LightweightCharts) { return Promise.resolve(true); }
		if (_libPromise) { return _libPromise; }
		_libPromise = new Promise(function (resolve) {
			var s = document.createElement('script');
			s.src = '/js/vendor/lightweight-charts/lightweight-charts.standalone.production.js';
			s.async = true;
			s.onload  = function () { resolve(!!window.LightweightCharts); };
			// Reset the cached promise on failure so a later reopen can retry (a transient load failure
			// must not permanently break the chart for the rest of the page session).
			s.onerror = function () { _libPromise = null; resolve(false); };
			document.head.appendChild(s);
		});
		return _libPromise;
	}

	// ── pull the deal's overlay data from the client-side dealTracker (present in both views) ──
	function extract(dealId, opts) {

		opts = opts || {};

		// The deals views declare `dealTracker` as a global lexical binding (let/const at script top
		// level), which is NOT a property of window — so read the bare global, guarded, then fall back
		// to window.dealTracker for any context that exposes it that way.
		var globalDT = (typeof dealTracker !== 'undefined' && dealTracker) ? dealTracker : (window.dealTracker || null);
		var t      = (globalDT && globalDT[dealId]) || {};
		var info   = t.info || {};
		var cfg    = t.config || {};
		var orders = Array.isArray(t.orders) ? t.orders : [];

		var out = {
			pair:        info.pair || t.pair || opts.pair || '',
			exchange:    opts.exchange || cfg.exchange || '',
			defaultType: (cfg.exchangeOptions && cfg.exchangeOptions.defaultType) || opts.defaultType || 'spot',
			current:     num(info.price_last),
			avg:         num(info.price_average),
			target:      num(info.price_target),
			orders:      []
		};

		out.orders = orders.map(function (o, i) {
			return {
				price:      num(o.price),
				filled:     !!o.filled,
				dateFilled: o.dateFilled,
				label:      (i === 0) ? 'Base' : ('SO' + i),
				isBase:     (i === 0),
				average:    num(o.average),
				target:     num(o.target)
			};
		}).filter(function (o) { return isFinite(o.price) && o.price > 0; });

		// Fill in average / target from the deepest filled order if the info fields are absent.
		var filled = out.orders.filter(function (o) { return o.filled; });
		var last   = filled[filled.length - 1];
		if ((!isFinite(out.avg)    || out.avg    <= 0) && last && isFinite(last.average)) { out.avg    = last.average; }
		if ((!isFinite(out.target) || out.target <= 0) && last && isFinite(last.target))  { out.target = last.target; }

		return out;
	}

	// ── modal shell + tabs ──────────────────────────────────────────────────
	function open(dealId, opts) {

		if (typeof openModal !== 'function' || typeof jQuery === 'undefined') { return; }

		var deal    = extract(dealId, opts);
		var modalId = (opts && opts.modalId) || ('dealChart' + dealId);

		var lastTab = 'deal';
		try { lastTab = localStorage.getItem(TAB_KEY) || 'deal'; } catch (e) {}

		var html =
			'<div class="sbdc-wrap" style="display:flex;flex-direction:column;height:100%;">' +
				'<div class="sbdc-tabs" style="display:flex;align-items:center;gap:6px;padding:2px 0 10px;border-bottom:1px solid var(--table-border-color,#333);margin-bottom:10px;">' +
					'<button type="button" class="sbdc-tab btnAll" data-tab="deal">Deal</button>' +
					'<button type="button" class="sbdc-tab btnAll" data-tab="tv">TradingView</button>' +
					// Gear opens the app-wide TradingView Settings picker (indicators / interval / bar style)
					// via the existing #tradingViewSettings handler in the header — reused, not reimplemented.
					// Shown only on the TradingView tab (toggled in activate()).
					'<span id="tradingViewSettings" title="Chart indicators &amp; preferences" style="margin-left:auto;display:none;align-items:center;cursor:pointer;color:var(--text-color);"><span class="ui-icon ui-icon-gear"></span></span>' +
				'</div>' +
				'<div class="sbdc-panel sbdc-panel-deal" style="flex:1;display:flex;flex-direction:column;min-height:0;"></div>' +
				// overflow:hidden: the embedded TradingView widget sizes itself off the outer modal, so inside
				// this tab it runs a few px taller than the panel — clip it so the modal never grows a scrollbar.
				'<div class="sbdc-panel sbdc-panel-tv" style="flex:1;display:none;min-height:0;overflow:hidden;"><div id="modalTvInner" style="height:100%;overflow:hidden;"></div></div>' +
			'</div>';

		openModal(modalId, '#modal', 'Chart · ' + esc(deal.pair || ('Deal ' + dealId)), html);

		var $modal = jQuery('#modal');
		var $deal  = $modal.find('.sbdc-panel-deal');
		var $tv    = $modal.find('.sbdc-panel-tv');

		function activate(tab) {
			try { localStorage.setItem(TAB_KEY, tab); } catch (e) {}
			$modal.find('.sbdc-tab').each(function () {
				jQuery(this).css({ 'opacity': jQuery(this).data('tab') === tab ? '1' : '0.6' });
			});
			// The chart-preferences gear only makes sense on the TradingView tab.
			$modal.find('#tradingViewSettings').css('display', tab === 'tv' ? 'inline-flex' : 'none');
			if (tab === 'tv') {
				$deal.hide(); $tv.show();
				renderTradingView(deal, $tv.find('#modalTvInner')[0]);
			}
			else {
				$tv.hide(); $deal.show();
				renderDeal(dealId, deal, $deal[0]);
			}
		}

		$modal.find('.sbdc-tab').on('click', function () { activate(jQuery(this).data('tab')); });

		// When the shared TradingView Settings dialog closes, reload the widget so newly chosen indicators /
		// interval take effect immediately (they persist to dataTracker and are read on widget load). Namespaced
		// + .off first so reopening a chart never stacks handlers. No-op unless the TradingView tab is showing.
		if (typeof jQuery('#modalTvSettings').off === 'function') {
			jQuery('#modalTvSettings').off('dialogclose.sbdc').on('dialogclose.sbdc', function () {
				if ($tv.is(':visible')) {
					var el = $tv.find('#modalTvInner')[0];
					if (el) { el.removeAttribute('data-loaded'); renderTradingView(deal, el); }
				}
			});
		}

		activate(lastTab === 'tv' ? 'tv' : 'deal');
	}

	// ── TradingView tab: load the existing widget INLINE into this tab ─────────
	// We deliberately do NOT call showTradingView() here — it wraps the widget in its own jQuery-UI
	// dialog (openModal), which would stack a second modal over this one. Instead we build the same
	// /api/tradingview URL (via the shared SymBot.UI.tradingViewUrl helper) and .load() it straight into
	// the tab container so it renders inline. jquery/script are already loaded globally, so request neither.
	function renderTradingView(deal, container) {

		if (!container) { return; }

		if (container.getAttribute('data-loaded') === '1') { return; }   // load once per open
		container.setAttribute('data-loaded', '1');

		if (typeof jQuery === 'undefined' || !deal.exchange || !deal.pair ||
		    !(window.SymBot && SymBot.UI && SymBot.UI.tradingViewUrl)) {
			container.innerHTML = '<div style="padding:20px;color:var(--text-color);">TradingView chart is unavailable for this pair.</div>';
			return;
		}

		var url = SymBot.UI.tradingViewUrl(deal.pair, deal.exchange, false, false);

		jQuery(container).html('<div style="padding:20px;color:var(--text-color);">Loading…</div>').load(url);
	}

	// ── Deal tab: candles + overlays ──────────────────────────────────────────
	function renderDeal(dealId, deal, panel) {

		panel.innerHTML = '<div style="padding:20px;color:var(--text-color);">Loading chart…</div>';

		ensureLib().then(function (ok) {

			LWC = window.LightweightCharts;

			if (!ok || !LWC) {
				panel.innerHTML = '<div style="padding:20px;color:var(--text-color);">Chart library failed to load.</div>';
				return;
			}

			_renderDealBody(dealId, deal, panel);
		});
	}

	function _renderDealBody(dealId, deal, panel, isPopout) {

		panel.innerHTML =
			'<div class="sbdc-toolbar" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
				'<span class="sbdc-intervals" style="display:flex;gap:3px;"></span>' +
				'<span class="sbdc-theme" style="display:flex;gap:3px;margin-left:auto;"></span>' +
				(isPopout ? '' : '<button type="button" class="sbdc-popout btnAll" title="Open in a new window">Popout ↗</button>') +
			'</div>' +
			'<div class="sbdc-chart" style="flex:1;min-height:320px;position:relative;"></div>' +
			'<div class="sbdc-facts" style="display:flex;flex-wrap:wrap;gap:6px 18px;padding-top:8px;font-size:0.92rem;color:var(--text-color);opacity:0.9;"></div>';

		var $panel     = jQuery(panel);
		var $intervals = $panel.find('.sbdc-intervals');
		var $theme     = $panel.find('.sbdc-theme');
		var chartEl    = $panel.find('.sbdc-chart')[0];

		// Single light/dark toggle — shows the theme it will switch TO. Follows the app theme until the
		// user overrides it here, after which the choice is remembered per browser.
		var $themeBtn = jQuery('<button type="button" class="btnAll" style="padding:3px 9px;line-height:0;" title="Toggle chart light / dark"></button>');
		// Reuse the header's masked-SVG theme icons so the crescent matches the app toggle exactly.
		function refreshThemeBtn() {
			var icon = resolveTheme() === 'dark' ? 'icon-sun' : 'icon-moon';
			$themeBtn.html('<span class="icon ' + icon + '" style="width:15px;height:15px;"></span>');
		}
		$themeBtn.on('click', function () { setThemePref(resolveTheme() === 'dark' ? 'light' : 'dark'); draw(); refreshThemeBtn(); });
		refreshThemeBtn();
		$theme.append($themeBtn);

		var state = { chart: null, series: null, markers: null, timeframe: null, lines: [] };

		// popout — open the SAME full panel (toolbar + intervals + chart) in a new same-origin window
		if (!isPopout) {
			$panel.find('.sbdc-popout').on('click', function () { popout(deal, state.timeframe); });
		}

		function draw() {
			fetchAndRender(deal, chartEl, state, function (timeframes) {
				buildIntervals($intervals, timeframes, state.timeframe, function (tf) {
					state.timeframe = tf;
					try { localStorage.setItem(TF_KEY, tf); } catch (e) {}
					draw();
				});
				$intervals.find('.sbdc-tf-select').val(state.timeframe);
				renderFacts($panel.find('.sbdc-facts')[0], deal);
			});
		}

		if (!state.timeframe) { try { state.timeframe = localStorage.getItem(TF_KEY) || ''; } catch (e) {} }

		draw();
		jQuery(window).off('resize.sbdc').on('resize.sbdc', function () { if (state.chart) { try { state.chart.applyOptions({ width: chartEl.clientWidth || 600 }); } catch (e) {} } });

		// Recolor an open chart when the APP theme toggles — but only if this chart follows the app
		// (theme pref 'auto'); a chart with an explicit per-chart light/dark choice keeps it. Namespaced +
		// .off first so reopening a chart never stacks handlers. The app toggle fires this via changeMode().
		jQuery(document).off('symbot:thememode.sbdc').on('symbot:thememode.sbdc', function () {
			if (themePref() === 'auto' && state.chart) { draw(); refreshThemeBtn(); }
		});

		// Deterministic teardown: release the chart + its ResizeObserver when the modal closes, rather than
		// leaving them for GC to reclaim on the next redraw. Only the in-modal chart binds this (the popout
		// window tears down on its own unload). .off first so reopening never stacks handlers.
		if (!isPopout) {
			jQuery('#modal').off('dialogclose.sbdcchart').on('dialogclose.sbdcchart', function () {
				if (state.chart) { try { state.chart.remove(); } catch (e) {} state.chart = null; }
				if (state.ro)    { try { state.ro.disconnect(); } catch (e) {} state.ro = null; }
			});
		}
	}

	function buildIntervals($host, timeframes, active, onPick) {
		if ($host.children().length) { return; }   // build once
		var wanted = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
		// ccxt timeframe ids vary in case ('1d' vs '1D', '1h' vs '1H'); match case-insensitively and offer
		// the exchange's own id so the request is valid.
		var lowerMap = {};
		(timeframes || []).forEach(function (tf) { lowerMap[String(tf).toLowerCase()] = tf; });
		var offer = [];
		wanted.forEach(function (w) { if (lowerMap[w]) { offer.push(lowerMap[w]); } });
		if (!offer.length) { offer = (timeframes || []).slice(0, 8); }

		var sel = jQuery('<select class="sbdc-tf-select" title="Interval" style="padding:3px 8px;font-family:inherit;font-size:12px;"></select>');
		offer.forEach(function (tf) {
			var opt = jQuery('<option></option>').attr('value', tf).text(tf);
			if (String(tf).toLowerCase() === String(active || '').toLowerCase()) { opt.attr('selected', 'selected'); }
			sel.append(opt);
		});
		sel.on('change', function () { onPick(jQuery(this).val()); });
		$host.append(sel);
	}

	function renderFacts(el, deal) {
		if (!el) { return; }
		function fmt(v) { return isFinite(v) ? (window.convertNotation ? convertNotation(v) : v) : '—'; }
		var soUsed = deal.orders.filter(function (o) { return o.filled && !o.isBase; }).length;
		el.innerHTML =
			'<span>Avg entry <b>' + fmt(deal.avg) + '</b></span>' +
			'<span>Take profit <b>' + fmt(deal.target) + '</b></span>' +
			'<span>Current <b>' + fmt(deal.current) + '</b></span>' +
			'<span>Safety orders <b>' + soUsed + ' used</b></span>';
	}

	// ── fetch candles + draw the chart and overlays ───────────────────────────
	function fetchAndRender(deal, chartEl, state, onReady) {

		var tf  = state.timeframe || '1h';
		// Unified OHLCV endpoint (same on the instance and the Hub) — backed by the isolated MarketData module.
		var url = './api/markets/ohlcv?exchange=' + encodeURIComponent(deal.exchange) +
		          '&pair=' + encodeURIComponent(deal.pair) +
		          '&type=' + encodeURIComponent(deal.defaultType) +
		          '&timeframe=' + encodeURIComponent(tf) + '&limit=400';

		chartEl.style.opacity = '0.5';

		fetch(url, { headers: { 'Accept': 'application/json' } })
			.then(function (r) { return r.json(); })
			.then(function (res) {
				chartEl.style.opacity = '1';
				res = res || {};
				var timeframes = Array.isArray(res.timeframes) ? res.timeframes : [];
				if (res.timeframe) { state.timeframe = res.timeframe; }
				else if (!state.timeframe) { state.timeframe = '1h'; }

				if (res.success && Array.isArray(res.candles) && res.candles.length) {
					drawChart(deal, chartEl, state, res.candles, false);
				}
				else if (res.available === false) {
					// Exchange has no candle API — lite fallback (order fills as a line).
					drawChart(deal, chartEl, state, fillsAsLine(deal), true);
				}
				else {
					message(chartEl, res.error ? 'Couldn’t load candles for ' + esc(deal.pair) + '. ' + esc(res.error) : 'No chart data available.', deal, chartEl, state);
				}
				onReady(timeframes);
			})
			.catch(function (e) {
				chartEl.style.opacity = '1';
				message(chartEl, 'Couldn’t load candles (' + esc(e && e.message ? e.message : 'network error') + ').', deal, chartEl, state);
				onReady([]);
			});
	}

	// A minimal line built from the deal's own filled orders + current price, for exchanges with no OHLCV.
	function fillsAsLine(deal) {
		var pts = deal.orders.filter(function (o) { return o.filled && o.dateFilled; })
			.map(function (o) { return { time: Math.floor(Date.parse(o.dateFilled) / 1000), value: o.price }; })
			.filter(function (p) { return isFinite(p.time) && isFinite(p.value); })
			.sort(function (a, b) { return a.time - b.time; });
		// Lightweight Charts requires strictly ascending, unique timestamps — two orders can fill in the
		// same second, so drop any point whose time is not greater than the previous one.
		var uniq = [];
		for (var i = 0; i < pts.length; i++) { if (!uniq.length || pts[i].time > uniq[uniq.length - 1].time) { uniq.push(pts[i]); } }
		if (isFinite(deal.current) && uniq.length) { uniq.push({ time: uniq[uniq.length - 1].time + 3600, value: deal.current }); }
		return uniq;
	}

	function drawChart(deal, chartEl, state, data, lite) {

		if (state.chart) { try { state.chart.remove(); } catch (e) {} state.chart = null; }
		if (state.ro)    { try { state.ro.disconnect(); } catch (e) {} state.ro = null; }
		chartEl.innerHTML = '';

		var pal = PALETTES[resolveTheme()] || PALETTES.dark;

		var chart = LWC.createChart(chartEl, {
			width: chartEl.clientWidth || 600,
			height: Math.max(chartEl.clientHeight || 0, 340),
			layout: { attributionLogo: true, background: { color: pal.bg }, textColor: pal.text,
			          fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif' },
			grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
			rightPriceScale: { borderColor: pal.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
			timeScale: { borderColor: pal.border, timeVisible: true, secondsVisible: false },
			crosshair: { mode: LWC.CrosshairMode.Normal }
		});

		// Extend the candle-based autoscale to include the KEY levels (average, take-profit, current, the
		// filled orders, and the single next pending safety order) so they're always visible — but do NOT
		// let a deep safety-order ladder stretch the scale and squash the candles into a sliver. Deeper
		// pending orders are still drawn as lines; they simply sit off-screen until price approaches them.
		var extendLevels = [];
		[deal.avg, deal.target, deal.current].forEach(function (v) { if (isFinite(v)) { extendLevels.push(v); } });
		deal.orders.forEach(function (o) { if (o.filled && isFinite(o.price)) { extendLevels.push(o.price); } });
		var nextPending = null;
		for (var pi = 0; pi < deal.orders.length; pi++) { if (!deal.orders[pi].filled) { nextPending = deal.orders[pi]; break; } }
		if (nextPending && isFinite(nextPending.price)) { extendLevels.push(nextPending.price); }

		// One price format for the whole series — drives the right-axis labels and every price line, so a
		// low-priced pair shows its real levels instead of rounding to 0.01 / 0.00.
		var prec = priceDecimals(extendLevels);
		var priceFormat = { type: 'price', precision: prec, minMove: Math.pow(10, -prec) };

		var scaleProvider = function (orig) {
			var res = (typeof orig === 'function') ? orig() : null;
			if (!res || !res.priceRange) { return res; }
			var lo = res.priceRange.minValue, hi = res.priceRange.maxValue;
			extendLevels.forEach(function (v) { if (v < lo) { lo = v; } if (v > hi) { hi = v; } });
			res.priceRange.minValue = lo;
			res.priceRange.maxValue = hi;
			return res;
		};

		var series;
		if (lite) {
			series = chart.addSeries(LWC.LineSeries, { color: pal.buy, lineWidth: 2, priceFormat: priceFormat, autoscaleInfoProvider: scaleProvider });
			series.setData(data);
		}
		else {
			series = chart.addSeries(LWC.CandlestickSeries, {
				upColor: pal.up, downColor: pal.down, borderVisible: false,
				wickUpColor: pal.up, wickDownColor: pal.down,
				priceLineVisible: true, priceLineStyle: LWC.LineStyle.Dotted, priceLineColor: pal.text,
				priceFormat: priceFormat,
				autoscaleInfoProvider: scaleProvider
			});
			series.setData(data);
		}

		// Order lines: draw all FILLED orders, but cap the number of PENDING lines so a deep ladder of
		// 20-30 safety orders doesn't flood the chart. Deeper pending orders beyond the cap are omitted —
		// they'd be far off-screen anyway.
		var PENDING_CAP = 12, pendingDrawn = 0;
		deal.orders.forEach(function (o) {
			if (!o.filled) { if (pendingDrawn >= PENDING_CAP) { return; } pendingDrawn++; }
			series.createPriceLine({
				price: o.price, color: o.filled ? pal.buy : pal.pending, lineWidth: 1,
				lineStyle: o.filled ? LWC.LineStyle.Solid : LWC.LineStyle.Dashed,
				axisLabelVisible: true, title: o.label + (o.filled ? '' : ' (pending)')
			});
		});
		if (isFinite(deal.avg))    { series.createPriceLine({ price: deal.avg,    color: pal.avg, lineWidth: 2, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: true, title: 'Avg entry' }); }
		if (isFinite(deal.target)) { series.createPriceLine({ price: deal.target, color: pal.tp,  lineWidth: 2, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: true, title: 'Take profit' }); }

		// fill markers
		var markers = deal.orders.filter(function (o) { return o.filled && o.dateFilled; }).map(function (o) {
			return { time: Math.floor(Date.parse(o.dateFilled) / 1000), position: 'belowBar', color: pal.buy, shape: 'arrowUp', text: o.label };
		}).filter(function (m) { return isFinite(m.time); }).sort(function (a, b) { return a.time - b.time; });
		if (markers.length && LWC.createSeriesMarkers) { try { LWC.createSeriesMarkers(series, markers); } catch (e) {} }

		state.chart  = chart;
		state.series = series;

		function fit() { try { chart.applyOptions({ width: chartEl.clientWidth || 600 }); chart.timeScale().fitContent(); } catch (e) {} }
		fit();
		requestAnimationFrame(fit);
		setTimeout(fit, 120);

		// The modal opens with a ~250ms scale animation, so the container keeps growing after drawChart
		// runs. The one-shot fits above can all land mid-animation (most likely when candles are cached,
		// e.g. reopening on 1d), leaving the chart stuck at a fraction of the modal width. Observing the
		// element resizes the chart to whatever the FINAL width turns out to be — no matter the timing.
		// During the settle window we also re-fit the time scale: bar spacing computed at the interim
		// (narrower) width would otherwise anchor the candles to the right, leaving a blank gap on the
		// left (the candles appear to "start in the middle"). After settling we only track width, so a
		// later window resize preserves whatever range the user has panned/zoomed to.
		if (typeof ResizeObserver === 'function') {
			try {
				var fitUntil = Date.now() + 900;
				state.ro = new ResizeObserver(function () {
					var w = chartEl.clientWidth;
					if (w <= 0) { return; }
					try {
						chart.applyOptions({ width: w, height: Math.max(chartEl.clientHeight || 0, 340) });
						if (Date.now() < fitUntil) { chart.timeScale().fitContent(); }
					} catch (e) {}
				});
				state.ro.observe(chartEl);
			} catch (e) {}
		}

		if (lite) { messageBadge(chartEl, 'Your exchange doesn’t provide candles — showing your order fills and levels.'); }
	}

	function message(host, text, deal, chartEl, state) {
		host.innerHTML = '<div style="padding:24px;color:var(--text-color);text-align:center;">' + text +
			'<br><br><button type="button" class="btnAll sbdc-retry">Retry</button></div>';
		// Vanilla DOM (no jQuery): message() also runs inside the popout window, which never loads jQuery.
		var btn = host.querySelector('.sbdc-retry');
		if (btn) { btn.addEventListener('click', function () { fetchAndRender(deal, chartEl, state, function () {}); }); }
	}

	function messageBadge(host, text) {
		var b = document.createElement('div');
		b.style.cssText = 'position:absolute;top:6px;left:6px;z-index:5;font-size:0.8rem;background:rgba(0,0,0,0.45);color:#fff;padding:3px 8px;border-radius:4px;';
		b.textContent = text;
		host.appendChild(b);
	}

	// ── popout: same-origin new window that renders the FULL deal panel ───────
	// Loads the app stylesheet + jQuery + the chart library + this component, then re-renders the same
	// panel (interval dropdown, theme toggle, overlays) — so the popout has the same controls as the
	// modal, not just a bare chart.
	function popout(deal, timeframe) {
		var w = window.open('', 'sbdc_' + (deal.pair || '').replace(/[^a-z0-9]/gi, ''), 'width=1040,height=680');
		if (!w) { return; }
		var origin = window.location.origin;
		var dark   = resolveTheme() === 'dark';
		// The popped window's base is about:blank, so set an explicit <base> at our origin — otherwise the
		// /js and /css tags and the relative ./api/markets/ohlcv fetch can't resolve. JSON.stringify does
		// not escape '<', so neutralize it (and the JS line separators) before embedding in a <script>.
		var payload = JSON.stringify({ deal: deal, timeframe: timeframe || '1h', theme: resolveTheme() })
			.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
		w.document.write(
			'<!doctype html><html><head><meta charset="utf-8"><base href="' + origin + '/">' +
			'<title>Chart · ' + esc(deal.pair) + '</title>' +
			'<link rel="stylesheet" href="' + origin + '/css/style.css">' +
			'<style>html,body{margin:0;height:100%;} #c{position:absolute;inset:0;background:' + (dark ? '#151b21' : '#fff') + ';}</style>' +
			'</head><body' + (dark ? ' data-theme="dark"' : '') + '><div id="c"></div>' +
			'<script src="' + origin + '/js/vendor/jquery/jquery.min.js"><\/script>' +
			'<script src="' + origin + '/js/vendor/lightweight-charts/lightweight-charts.standalone.production.js"><\/script>' +
			'<script src="' + origin + '/js/symbot-ui.js"><\/script>' +
			'<script>window.__SBDC=' + payload + ';<\/script>' +
			'<script src="' + origin + '/js/symbot-deal-chart.js"><\/script>' +
			'<script>SymBot.DealChart._popoutRender(document.getElementById("c"), window.__SBDC);<\/script>' +
			'</body></html>'
		);
		w.document.close();
	}

	// Called inside the popped window to render the FULL panel from the serialized payload.
	function popoutRender(el, payload) {
		LWC = window.LightweightCharts;
		if (!LWC || !payload || !payload.deal || typeof jQuery === 'undefined') { return; }
		try { if (payload.theme)     { localStorage.setItem(THEME_KEY, payload.theme); } } catch (e) {}
		try { if (payload.timeframe) { localStorage.setItem(TF_KEY, payload.timeframe); } } catch (e) {}
		el.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;padding:10px;box-sizing:border-box;';
		_renderDealBody('popout', payload.deal, el, true);
	}

	window.SymBot.DealChart = { open: open, _popoutRender: popoutRender };

})();
