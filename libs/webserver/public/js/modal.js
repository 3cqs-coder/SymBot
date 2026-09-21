'use strict';

// Shared modal helpers for the .modal-overlay / .modal-box component. One place for open/close,
// backdrop-click, Escape, [data-modal-close] / [data-ac-close] close controls, AND accessibility (focus moves
// into the dialog on open, Tab is trapped inside it, and focus returns to the opener on close). A view that
// needs extra cleanup when a modal closes (e.g. clearing an "editing id") can listen for the `modal:closed`
// event dispatched on the overlay.
//
// Focus management is driven by watching the `.open` class rather than the open/close helpers, so it works the
// same whether a view opens a modal via SymBotModal.open(id) (Access Control) or by toggling the class itself
// (Schedules) — one implementation, no per-view wiring.
(function () {

	let lastFocused = null;

	// Visible, focusable elements within a container, in DOM order.
	function focusables(container) {
		const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
		return Array.prototype.slice.call(container.querySelectorAll(sel)).filter(function (el) { return el.offsetParent !== null; });
	}

	function onOpen(overlay) {
		// Remember what to return focus to when the modal closes (the control that opened it).
		lastFocused = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;

		const box = overlay.querySelector('.modal-box') || overlay;
		if (!box.getAttribute('role')) { box.setAttribute('role', 'dialog'); }
		box.setAttribute('aria-modal', 'true');

		// Move focus into the dialog unless the view already focused something inside it (e.g. a search box).
		setTimeout(function () {
			if (box.contains(document.activeElement)) { return; }
			const f = focusables(box);
			if (f.length) { f[0].focus(); }
			else { box.setAttribute('tabindex', '-1'); box.focus(); }
		}, 0);
	}

	function onClose() {
		if (lastFocused && typeof lastFocused.focus === 'function' && document.contains(lastFocused)) {
			try { lastFocused.focus(); } catch (e) {}
		}
		lastFocused = null;
	}

	function openModal(id) {
		const el = document.getElementById(id);
		if (el) { el.classList.add('open'); }   // focus handled by the observer below
	}

	function closeModals() {
		const open = document.querySelectorAll('.modal-overlay.open');
		for (let i = 0; i < open.length; i++) {
			open[i].classList.remove('open');
			try { open[i].dispatchEvent(new CustomEvent('modal:closed', { bubbles: true })); } catch (e) {}
		}
	}

	// Namespaced (SymBotModal.open / .close) rather than a bare global openModal — the header partial already
	// defines an unrelated jQuery-UI `openModal(modalId, div, …)`, so a global name here would collide with it.
	window.SymBotModal = { open: openModal, close: closeModals };

	// Watch every .modal-overlay for the `.open` class flipping, and run focus-in / focus-restore accordingly —
	// covering both open styles (SymBotModal.open and a view's own classList toggle). Guarded so a browser
	// without MutationObserver simply skips the enhancement (the modals still work).
	if (typeof MutationObserver === 'function') {
		const seenOpen = new WeakSet();
		const mo = new MutationObserver(function (muts) {
			for (let i = 0; i < muts.length; i++) {
				const t = muts[i].target;
				if (!t || !t.classList || !t.classList.contains('modal-overlay')) { continue; }
				const isOpen = t.classList.contains('open');
				if (isOpen && !seenOpen.has(t)) { seenOpen.add(t); onOpen(t); }
				else if (!isOpen && seenOpen.has(t)) { seenOpen.delete(t); onClose(); }
			}
		});
		const start = function () { try { mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: [ 'class' ] }); } catch (e) {} };
		if (document.body) { start(); } else { document.addEventListener('DOMContentLoaded', start); }
	}

	// Delegated close controls and backdrop click. `.modal-close` is intentionally NOT handled here so a view
	// can attach its own routed close (e.g. schedulesView's data-close) without a double fire — this handler
	// covers the generic [data-modal-close] / [data-ac-close] controls only.
	document.addEventListener('click', function (e) {
		const t = e.target;
		if (t && t.closest && t.closest('[data-modal-close], [data-ac-close]')) { closeModals(); return; }
		if (t && t.classList && t.classList.contains('modal-overlay')) { closeModals(); }
	});

	document.addEventListener('keydown', function (e) {

		if (e.key === 'Escape') { closeModals(); return; }

		// Trap Tab within an open modal so keyboard focus cannot wander to the page behind the overlay.
		if (e.key === 'Tab') {
			const overlay = document.querySelector('.modal-overlay.open');
			if (!overlay) { return; }
			const box = overlay.querySelector('.modal-box') || overlay;
			const f = focusables(box);
			if (!f.length) { return; }
			const first = f[0], last = f[f.length - 1], active = document.activeElement;
			if (e.shiftKey && (active === first || !box.contains(active))) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && (active === last || !box.contains(active))) { e.preventDefault(); first.focus(); }
		}
	});

})();
