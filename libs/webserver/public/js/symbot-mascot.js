/**
 * SymBot.Mascot — the animated logo character for the AI chat.
 *
 * Faithful to the SymBot emblem (real vector paths). Personality comes from
 * motion + light only — no added features. Reacts to the chat's states:
 *   idle | thinking | positive | concerned
 *
 * Placement arc: large "hero" when the chat is empty; shrinks to a small
 * header presence once a conversation starts, so it never competes with the
 * content while you're reading an analysis.
 *
 * The mascot is always rendered as hardcoded SVG markup with data-anim="on"
 * baked in, so it animates purely via CSS the moment it is in the DOM — the
 * same reliable mechanism as the server-rendered loader partial. There is no
 * JS mount step and no user toggle.
 *
 * Public API (one entry point):
 *   const m = SymBot.Mascot.attachToChat({ isAnalysis: fn });
 *   m.onSend()  m.onStreamChunk()  m.onComplete()  m.onError()
 *   m.onReset() m.onHistory()  m.setThinking()  m.setState(s)  m.refresh()
 */
(function () {

	const SymBot = window.SymBot || (window.SymBot = {});

	const VIEWBOX = '-8 32 91 92';
	const SVG_INNER = "<defs><linearGradient id=\"SVGID_1_%UID%\" gradientUnits=\"userSpaceOnUse\" x1=\"2\" y1=\"81.273\" x2=\"6.6312\" y2=\"81.273\"> <stop offset=\"0\" style=\"stop-color:#43C7ED\"/> <stop offset=\"0.9966\" style=\"stop-color:#75C378\"/> </linearGradient><linearGradient id=\"SVGID_2_%UID%\" gradientUnits=\"userSpaceOnUse\" x1=\"64.6776\" y1=\"81.273\" x2=\"69.3088\" y2=\"81.273\"> <stop offset=\"0\" style=\"stop-color:#43C7ED\"/> <stop offset=\"0.9966\" style=\"stop-color:#75C378\"/> </linearGradient><linearGradient id=\"SVGID_3_%UID%\" gradientUnits=\"userSpaceOnUse\" x1=\"33.0827\" y1=\"93.3708\" x2=\"38.2257\" y2=\"69.175\"> <stop offset=\"0\" style=\"stop-color:#43C7ED\"/> <stop offset=\"0.9966\" style=\"stop-color:#75C378\"/> </linearGradient><linearGradient id=\"SVGID_4_%UID%\" gradientUnits=\"userSpaceOnUse\" x1=\"33.399\" y1=\"91.8829\" x2=\"37.9093\" y2=\"70.6633\"> <stop offset=\"0\" style=\"stop-color:#43C7ED\"/> <stop offset=\"0.9966\" style=\"stop-color:#75C378\"/> </linearGradient><linearGradient id=\"SVGID_5_%UID%\" gradientUnits=\"userSpaceOnUse\" x1=\"29.8443\" y1=\"108.6079\" x2=\"44.0274\" y2=\"41.882\"> <stop offset=\"0\" style=\"stop-color:#43C7ED\"/> <stop offset=\"0.9966\" style=\"stop-color:#75C378\"/> </linearGradient><linearGradient id=\"SVGID_6_%UID%\" gradientUnits=\"userSpaceOnUse\" x1=\"34.7854\" y1=\"72.5831\" x2=\"37.2715\" y2=\"60.8868\"> <stop offset=\"0\" style=\"stop-color:#43C7ED\"/> <stop offset=\"0.9966\" style=\"stop-color:#75C378\"/> </linearGradient><linearGradient id=\"SVGID_7_%UID%\" gradientUnits=\"userSpaceOnUse\" x1=\"33.9837\" y1=\"101.7294\" x2=\"36.8073\" y2=\"88.4455\"> <stop offset=\"0\" style=\"stop-color:#43C7ED\"/> <stop offset=\"0.9966\" style=\"stop-color:#75C378\"/> </linearGradient></defs><g class=\"sbm-body\"><g class=\"sbm-ring\"><path fill=\"url(#SVGID_5_%UID%)\" d=\"M38.02,54.35c-0.26-0.65-0.79-1.16-1.44-1.42v-3.63l0.22-0.05c1.29-0.32,2.37-1.18,2.98-2.37 c0.04-0.08,0.08-0.16,0.12-0.24c0.07-0.15,0.12-0.29,0.16-0.43c0.02-0.08,0.05-0.15,0.07-0.22c0.1-0.39,0.16-0.79,0.16-1.19 c0-0.17-0.01-0.35-0.03-0.52c-0.01-0.07-0.02-0.15-0.03-0.23c-0.04-0.23-0.09-0.46-0.17-0.69c-0.03-0.09-0.06-0.17-0.09-0.24 c-0.7-1.77-2.37-2.91-4.27-2.91c-1.34,0-2.61,0.58-3.49,1.6c-0.06,0.08-0.12,0.14-0.16,0.2c-0.11,0.15-0.22,0.31-0.32,0.47 c-0.04,0.06-0.07,0.13-0.11,0.2c-0.11,0.21-0.21,0.44-0.29,0.68c-0.02,0.07-0.05,0.14-0.07,0.22c-0.11,0.39-0.16,0.8-0.16,1.22 c0,0.83,0.22,1.64,0.65,2.35c0.62,1.04,1.66,1.81,2.83,2.1l0.22,0.05v3.6c-0.68,0.25-1.24,0.77-1.51,1.45 C19.4,55.56,8.63,67.23,8.63,81.27c0,14.05,10.77,25.71,24.66,26.92c0.11,0.26,0.25,0.51,0.45,0.73c0.45,0.51,1.08,0.82,1.76,0.86 c0.05,0,0.11,0,0.16,0c0.63,0,1.22-0.23,1.69-0.64c0.3-0.27,0.53-0.59,0.67-0.95c13.89-1.21,24.65-12.87,24.65-26.92 C62.68,67.23,51.91,55.56,38.02,54.35z M37.93,106.06c-0.1-0.19-0.21-0.36-0.36-0.53c-0.45-0.51-1.08-0.82-1.76-0.86 c-0.68-0.04-1.34,0.19-1.85,0.64c-0.24,0.22-0.43,0.47-0.57,0.74c-12.75-1.15-22.62-11.88-22.62-24.79 c0-11.38,7.68-21.07,18.23-23.99c1.41-0.39,2.88-0.66,4.38-0.8c0.43,0.82,1.28,1.39,2.27,1.39c0.99,0,1.85-0.56,2.27-1.39 c1.54,0.14,3.04,0.42,4.49,0.83c10.5,2.95,18.13,12.62,18.13,23.96C60.54,94.18,50.68,104.91,37.93,106.06z\"/></g><g class=\"sbm-arcs\"><path fill=\"url(#SVGID_6_%UID%)\" d=\"M51,67.49c-0.08-0.01-0.15-0.02-0.23-0.02c-0.1,0-0.19,0.01-0.29,0.02l-0.32,0.05l-0.22-0.24 c-0.75-0.8-1.56-1.53-2.42-2.19c-3.54-2.73-7.94-4.25-12.47-4.25c-3.32,0-6.51,0.78-9.39,2.29c-1.05,0.55-2.05,1.19-3.01,1.92 c-0.37,0.28-0.74,0.59-1.12,0.92l-0.24,0.22l-0.31-0.08c-0.15-0.04-0.3-0.06-0.45-0.06c-0.38,0-0.74,0.12-1.04,0.35 c-0.75,0.58-0.89,1.66-0.32,2.41c0.09,0.12,0.2,0.22,0.31,0.31c0.24,0.18,0.52,0.3,0.83,0.34c0.08,0.01,0.15,0.02,0.23,0.02 c0.19,0,0.37-0.03,0.55-0.09c0.18-0.06,0.34-0.15,0.49-0.26c0.53-0.41,0.78-1.1,0.62-1.76l-0.08-0.36l0.28-0.24 c0.33-0.28,0.65-0.55,0.97-0.8c0.46-0.35,0.93-0.68,1.41-0.99c3.08-1.96,6.6-2.99,10.29-2.99c5.14,0,10.1,2.08,13.68,5.71 c0.09,0.09,0.18,0.19,0.27,0.28l0.25,0.27l-0.12,0.35c-0.01,0.02-0.01,0.04-0.02,0.06c-0.03,0.09-0.05,0.18-0.06,0.28 c-0.02,0.17-0.02,0.33,0.01,0.49c0.04,0.28,0.16,0.55,0.33,0.78c0.09,0.12,0.19,0.22,0.31,0.31c0.3,0.23,0.67,0.36,1.06,0.36 c0.38,0,0.74-0.12,1.04-0.35c0.36-0.28,0.6-0.68,0.66-1.14c0.06-0.45-0.06-0.91-0.34-1.27C51.86,67.78,51.46,67.55,51,67.49z\"/><path fill=\"url(#SVGID_7_%UID%)\" d=\"M51.82,91.81c-0.3-0.23-0.66-0.35-1.04-0.35c-0.38,0-0.76,0.13-1.06,0.36c-0.12,0.09-0.22,0.19-0.31,0.31 c-0.28,0.36-0.4,0.81-0.34,1.27c0.02,0.11,0.04,0.23,0.08,0.33l0.12,0.35l-0.25,0.27c-3.6,3.81-8.69,5.99-13.96,5.99 c-4.27,0-8.31-1.37-11.7-3.98c-0.32-0.24-0.64-0.51-0.97-0.8l-0.28-0.24l0.08-0.36c0.16-0.66-0.09-1.35-0.62-1.76 c-0.3-0.23-0.66-0.36-1.04-0.36c-0.08,0-0.15,0.01-0.23,0.02c-0.3,0.04-0.59,0.16-0.83,0.34c-0.12,0.09-0.22,0.2-0.31,0.31 c-0.58,0.75-0.43,1.83,0.32,2.41c0.3,0.23,0.66,0.35,1.04,0.35c0.15,0,0.3-0.02,0.45-0.06l0.31-0.08l0.24,0.22 c0.38,0.33,0.75,0.64,1.12,0.92c3.59,2.76,7.88,4.21,12.4,4.21c5.63,0,11.06-2.35,14.89-6.45l0.22-0.24l0.32,0.05 c0.09,0.02,0.19,0.02,0.29,0.02c0.08,0,0.15-0.01,0.23-0.02c0.45-0.06,0.86-0.29,1.14-0.66c0.28-0.36,0.4-0.82,0.34-1.27 C52.42,92.49,52.19,92.09,51.82,91.81z\"/></g><path fill=\"url(#SVGID_1_%UID%)\" d=\"M4.5,87.24H4.13C2.95,87.24,2,86.28,2,85.11v-7.67c0-1.18,0.95-2.13,2.13-2.13H4.5c1.18,0,2.13,0.95,2.13,2.13 v7.67C6.63,86.28,5.68,87.24,4.5,87.24z\"/><path fill=\"url(#SVGID_2_%UID%)\" d=\"M67.18,87.24h-0.37c-1.18,0-2.13-0.95-2.13-2.13v-7.67c0-1.18,0.95-2.13,2.13-2.13h0.37 c1.18,0,2.13,0.95,2.13,2.13v7.67C69.31,86.28,68.36,87.24,67.18,87.24z\"/><g class=\"sbm-wave\"><path fill=\"url(#SVGID_3_%UID%)\" d=\"M24.12,91.35c3.43,1.36,7.36,0.11,9.35-2.99c1.63-2.53,4.79-3.72,7.69-2.89c0.32,0.1,0.58,0.19,0.74,0.26 c1.31,0.52,2.4,1.41,3.19,2.58l2.26,3.4l4.16-10.47c1.58-3.96-0.36-8.47-4.33-10.05c-3.43-1.36-7.36-0.11-9.35,2.99 c-1.66,2.57-4.75,3.74-7.69,2.89c-0.25-0.07-0.48-0.16-0.74-0.26c-1.31-0.52-2.4-1.41-3.19-2.58l-2.26-3.4l-4.16,10.47 C18.22,85.27,20.16,89.78,24.12,91.35z M20.49,81.58l3.64-9.15l1.47,2.21c0.87,1.29,2.09,2.28,3.53,2.86 c0.27,0.11,0.53,0.2,0.81,0.28c3.26,0.94,6.69-0.35,8.53-3.2c1.8-2.79,5.35-3.93,8.45-2.7c3.58,1.42,5.33,5.49,3.91,9.08 l-3.64,9.15l-1.47-2.21c-0.86-1.29-2.09-2.28-3.53-2.86c-0.17-0.07-0.45-0.17-0.81-0.28c-3.21-0.93-6.72,0.39-8.53,3.2 c-1.8,2.79-5.35,3.93-8.45,2.7C20.82,89.24,19.06,85.16,20.49,81.58z\"/><path fill=\"url(#SVGID_4_%UID%)\" d=\"M24.68,89.94c2.76,1.1,5.91,0.08,7.51-2.39c1.99-3.1,5.85-4.54,9.39-3.53c0.39,0.11,0.68,0.23,0.88,0.3 c1.59,0.63,2.93,1.72,3.89,3.15l0.66,0.98l3.09-7.78c1.27-3.19-0.29-6.81-3.48-8.07c-2.75-1.1-5.92-0.09-7.52,2.39 c-2.03,3.15-5.8,4.56-9.4,3.53c-0.29-0.08-0.57-0.18-0.88-0.3c-1.59-0.63-2.93-1.72-3.89-3.15l-0.66-0.98l-3.09,7.77 C19.94,85.05,21.5,88.67,24.68,89.94z\"/></g></g>";

	let seq = 0;

	// A complete, self-contained mascot SVG string with a fixed gradient namespace,
	// for cases where we inject markup directly (e.g. the inline thinking bubble)
	// and want CSS animation without a mount() call.
	function SVG_INNER_STATIC(state, uid) {
		uid = uid || 'st' + (++seq);
		const inner = SVG_INNER.split('%UID%').join(uid);
		return '<svg class="sbm-mascot" viewBox="' + VIEWBOX + '" data-state="' + (state || 'thinking') + '" xmlns="http://www.w3.org/2000/svg">' + inner + '</svg>';
	}

	SymBot.Mascot = {

		/**
		 * Returns the full-box animated-mascot loader markup (mascot in "thinking"
		 * + a caption), as a string. Pure hardcoded markup with data-anim="on", so
		 * it animates via CSS the instant it's inserted — no mount, no timing race.
		 * One source for every "loading…" surface (chat open, analysis, loading a
		 * saved conversation), and it works anywhere the mascot script is loaded
		 * (including the standalone popout, which has no server-rendered template).
		 */
		loaderHtml: function (caption) {
			return '<div class="aiChatContainer"><div class="ai-loader chat-mascot-hero" style="height:100%;min-height:220px;">' +
				'<span class="sbm-wrap sbm-size-hero" data-anim="on">' + SVG_INNER_STATIC('thinking') + '</span>' +
				'<div class="chat-mascot-hero-text">' + (caption || 'Loading…') + '</div></div></div>';
		},

		/**
		 * Unified chat controller — the SINGLE place that wires the mascot into an
		 * AI chat surface (modal OR popout). Both views call this instead of each
		 * duplicating mount/hero/state logic, so behavior stays identical.
		 *
		 * The mascot is rendered as hardcoded markup (SVG_INNER_STATIC) with
		 * data-anim="on" baked in, so it animates via CSS the instant it is in the
		 * DOM — no createElement mount, no timing races. Same mechanism the
		 * loaderHtml() helper uses for every "loading…" surface.
		 *
		 * config = { isAnalysis: fn() -> bool }
		 * Returns lifecycle hooks: onSend, onStreamChunk, onComplete, onError,
		 * onReset, onHistory, setThinking, setState, refresh.
		 */
		attachToChat: function (config) {

			config = config || {};
			const isAnalysis = config.isAnalysis || function () { return false; };

			// Hero uses the SAME hardcoded-markup approach as the loader (which
			// animates reliably): the full SVG with data-anim="on"/data-state baked
			// in, so it animates via CSS the instant it's in the DOM — no mount() call,
			// no timing dependency. This is the empty-chat welcome mascot.
			const HERO_HTML =
				'<div id="chatMascotHero" class="chat-mascot-hero">' +
				'<div id="chatMascotHeroArt"><span class="sbm-wrap sbm-size-hero" data-anim="on">' +
				SVG_INNER_STATIC('idle') + '</span></div>' +
				'<div class="chat-mascot-hero-text">Ask me about your bots, deals, or the market.</div></div>';

			let header = null, hero = null, pending = null;

			function $(sel) { return window.jQuery ? jQuery(sel) : null; }

			function mount(attempt) {
				// Both mascots use the SAME reliable hardcoded-markup approach as the
				// loader: inject the full animated SVG directly (CSS animates it), no
				// timing-sensitive createElement mount. One mechanism everywhere.
				const $hdr = $('#chatMascotHeader');
				if ($hdr && $hdr.length && $hdr.children('.sbm-wrap').length === 0) {
					$hdr.html('<span class="sbm-wrap sbm-size-header" data-anim="on">' + SVG_INNER_STATIC(pending || 'idle') + '</span>');
					header = true;
				}
				if (pending) { setState(pending); pending = null; }
				if ((!header) && (attempt || 0) < 20) setTimeout(function () { mount((attempt || 0) + 1); }, 50);
				else if (!header && $hdr) $hdr.css('display', 'none');
			}

			function setState(state) {
				if (!header) pending = state;
				// Both mascots are static markup; set data-state directly so CSS updates.
				const hdrSvg = document.querySelector('#chatMascotHeader .sbm-mascot');
				if (hdrSvg) hdrSvg.setAttribute('data-state', state);
				const heroSvg = document.querySelector('#chatMascotHeroArt .sbm-mascot');
				if (heroSvg) heroSvg.setAttribute('data-state', state);
			}
			// Decide which mascot is visible. Analysis = header only (always streaming).
			// Chat = big hero when empty, small header once a conversation is underway.
			function layout() {
				if (isAnalysis()) {
					$('#chatMascotHero').hide();
					$('#aiChatBox').removeClass('chat-empty');
					$('#chatMascotHeader').show();
					return;
				}
				const hasMsgs = $('#aiChatBox .message').length > 0;
				if (!hasMsgs && $('#chatMascotHero').length === 0) {
					$('#aiChatBox').prepend(HERO_HTML);
				}
				$('#chatMascotHero').toggle(!hasMsgs);
				$('#aiChatBox').toggleClass('chat-empty', !hasMsgs);
				$('#chatMascotHeader').toggle(hasMsgs);
			}

			// Inline "thinking" bubble shown in the chat while awaiting a response —
			// reliable follow-up feedback (like the old spinner) that doesn't depend
			// on the small header mascot being noticed. Reuses the mascot at bubble size.
			function showThinkingBubble() {
				const $box = $('#aiChatBox');
				if (!$box || !$box.length || $box.find('#chatThinkingBubble').length) return;
				$box.append(
					'<div id="chatThinkingBubble" class="message bot-message chat-thinking-bubble">' +
					'<span class="sbm-wrap sbm-size-header" data-anim="on">' + SVG_INNER_STATIC('thinking') + '</span>' +
					'<span class="chat-thinking-dots"><i></i><i></i><i></i></span></div>'
				);
				const box = $box[0]; if (box) box.scrollTop = box.scrollHeight;
			}
			function hideThinkingBubble() {
				const b = document.getElementById('chatThinkingBubble');
				if (b && b.parentNode) b.parentNode.removeChild(b);
			}

			mount(0);
			layout();

			const api = {
				// user sent a message → show the inline thinking bubble, and (since the
				// bubble is now a message) re-layout so the big empty-state hero hides.
				onSend:        function () { showThinkingBubble(); layout(); setState('thinking'); },
				// first streamed chunk arrived → drop the bubble, show the right mascot
				onStreamChunk: function () { hideThinkingBubble(); layout(); },
				// response finished → return the header mascot to a calm idle. (We do
				// NOT guess emotional tone from the text — keyword matching mislabels
				// normal trading answers as "concerned", which looked wrong.)
				onComplete:    function () { hideThinkingBubble(); setState('idle'); },
				onError:       function () { hideThinkingBubble(); setState('idle'); },
				// new conversation / cleared box → restore the empty-state hero
				onReset:       function () { hideThinkingBubble(); layout(); },
				onHistory:     function () { layout(); },
				setThinking:   function () { setState('thinking'); },
				setState:      setState,
				refresh:       layout
			};
			// expose the hero refresh for the shared conversations module (reset path)
			window.AIChatConv_updateMascotHero = layout;
			return api;
		}
	};

})();