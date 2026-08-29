'use strict';

/**
 * symbot-signal-bot.js
 * Client-side behavior for the Signal Bot setup panel (partialsSignalBotAlerts.ejs).
 * SHARED by the single-instance create/update view and the Hub bot-edit view.
 *
 * Responsibilities:
 *   - "Signal Bot mode" toggle: locks the bot's Start Condition to Manually / API
 *     and reveals the copy-paste alert messages.
 *   - Webhook URL: built from window.location.origin + path. When the instance UI
 *     is opened through the Hub proxy (page under /instance/<port>/…) the URL keeps
 *     that /instance/<port> prefix so the webhook routes back through the Hub to
 *     the instance. (The Hub's own native bot editor doesn't render these cards —
 *     it points the user to open the instance directly; see the partial.)
 *   - Single-pair variant toggle (omit the pair field) and an opt-in "fill in my
 *     token" toggle (the token stays a placeholder until asked for).
 *   - Copy-to-clipboard for each URL and message.
 *
 * The alert bodies themselves are generated server-side
 * (libs/strategies/DCABot/signalBot.js) and delivered in data- attributes, so this
 * script never rebuilds the JSON — it only swaps the pre-generated variants and
 * substitutes the token on request.
 */

(function(window) {

	'use strict';

	var TOKEN_PLACEHOLDER = '{{YOUR_TOKEN}}';

	$(document).ready(function() {

		var $box = $('#signalBotBox');

		if (!$box.length) { return; }

		// When the instance UI is opened THROUGH the Hub proxy, the page lives under
		// /instance/<port>/… and the webhook must keep that same prefix so it routes
		// back through the Hub to the instance (not to the Hub itself). Detect it
		// from the current path; empty for a directly-accessed instance.
		var proxyMatch  = window.location.pathname.match(/^\/instance\/[^/]+/);
		var proxyPrefix = proxyMatch ? proxyMatch[0] : '';


		function applyMode() {

			var on = $('#signalBotMode').is(':checked');

			$('#signalBotHint').toggle(on);
			$('#signalBotAlerts').toggle(on);

			// Signal Bot mode locks the Start Condition to Manually / API and
			// disables the dropdown so it can't be changed by mistake. Unchecking
			// the mode re-enables it. (The submit handler re-enables all fields
			// before serializing, so the locked value is still sent.)
			var $sc = $('#startCondition');

			if ($sc.length) {

				if (on) {

					if ($sc.val() !== 'api') { $sc.val('api').trigger('change'); }

					$sc.prop('disabled', true);
				}
				else {

					$sc.prop('disabled', false);
				}
			}
		}


		function renderBodies() {

			var single    = $('#signalBotSinglePair').is(':checked');
			var showToken = $('#signalBotShowToken').is(':checked') && !!window.__signalBotToken;

			$('.signal-alert-card').each(function() {

				var base = single
					? $(this).attr('data-json-single')
					: $(this).attr('data-json-multi');

				var text = base || '';

				if (showToken) {

					text = text.split(TOKEN_PLACEHOLDER).join(window.__signalBotToken);
				}

				$(this).find('.signal-alert-body').val(text);
			});
		}


		function initUrls() {

			// The Hub's native bot editor injects the target instance's proxy prefix
			// (/instance/<port>) because its own URL is not under /instance/…; a single
			// instance leaves this unset and we auto-detect the prefix from the path.
			// Origin always comes from window.location, so a custom domain / HTTPS front
			// end is reflected automatically.
			var urlPrefix = (typeof window.__signalBotUrlPrefix === 'string' && window.__signalBotUrlPrefix)
				? window.__signalBotUrlPrefix
				: proxyPrefix;

			$('.signal-alert-card').each(function() {

				var path = $(this).attr('data-path') || '';

				// origin + (proxy prefix, if opened via / injected for the Hub proxy) + path.
				// Correct whether the instance is reached directly, through the Hub's
				// /instance/<port> proxy, or from the Hub's native editor.
				$(this).find('.signal-alert-url').val(window.location.origin + urlPrefix + path);
			});
		}


		function copyText(text, btn) {

			function flash() {

				var $b = $(btn);
				var orig = $b.text();

				$b.text('Copied');

				setTimeout(function() { $b.text(orig); }, 1200);
			}

			if (navigator.clipboard && navigator.clipboard.writeText) {

				navigator.clipboard.writeText(text).then(flash, function() { fallbackCopy(text, flash); });
			}
			else {

				fallbackCopy(text, flash);
			}
		}


		function fallbackCopy(text, onDone) {

			var $tmp = $('<textarea>').css({ position: 'fixed', top: '-1000px', left: '-1000px' }).val(text).appendTo('body');

			$tmp[0].select();

			try { document.execCommand('copy'); } catch (e) {}

			$tmp.remove();

			if (typeof onDone === 'function') { onDone(); }
		}


		// ── Wire up ──────────────────────────────────────────────────────────

		$('#signalBotMode').on('change', applyMode);

		// While Signal Bot mode is on the dropdown is disabled, but the form's
		// submit path briefly re-enables every field to read it — so guard against
		// any stray change landing on a non-api value during that window.
		$('#startCondition').on('change', function() {

			if ($('#signalBotMode').is(':checked') && $(this).val() !== 'api') {

				$(this).val('api');
			}
		});

		$('#signalBotSinglePair, #signalBotShowToken').on('change', renderBodies);

		$(document).on('click', '.signal-copy', function(e) {

			e.preventDefault();

			var $card = $(this).closest('.signal-alert-card');
			var what  = $(this).attr('data-copy');

			var text = (what === 'url')
				? $card.find('.signal-alert-url').val()
				: $card.find('.signal-alert-body').val();

			copyText(text, this);
		});

		// After saving a Signal Bot the create view redirects here with ?signal=1.
		// Confirm the save, scroll the panel into view, and briefly highlight it so
		// the now-populated alerts are obviously the next thing to use.
		function announceIfJustSaved() {

			if (!/[?&]signal=1(&|$)/.test(window.location.search)) { return; }

			var $note = $('#signalBotSavedNote');

			if ($note.length) {

				$note.show();
				setTimeout(function() { $note.fadeOut(400); }, 6000);
			}

			$box.css('transition', 'box-shadow 0.3s ease');
			$box.css('box-shadow', '0 0 0 3px rgba(74,166,2,0.55)');
			setTimeout(function() { $box.css('box-shadow', 'none'); }, 1800);

			if ($box[0] && $box[0].scrollIntoView) {

				$box[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		}

		// Exposed so the create/update view can re-assert the Start Condition lock
		// after its resetForm() re-enables every field.
		window.SignalBot = { applyMode: applyMode };

		initUrls();
		renderBodies();
		applyMode();
		announceIfJustSaved();
	});

})(window);