'use strict';

// Shared modal helpers for the .modal-overlay / .modal-box component. One place for open/close,
// backdrop-click, Escape, and [data-modal-close] / [data-ac-close] close controls, so a view does
// not re-implement the same wiring. A view that needs extra cleanup when a modal closes (e.g.
// clearing an "editing id") can listen for the `modal:closed` event dispatched on the overlay.
(function () {

	function openModal(id) {

		const el = document.getElementById(id);
		if (el) { el.classList.add('open'); }
	}

	function closeModals() {

		const open = document.querySelectorAll('.modal-overlay.open');

		for (let i = 0; i < open.length; i++) {

			open[i].classList.remove('open');
			try { open[i].dispatchEvent(new CustomEvent('modal:closed', { bubbles: true })); } catch (e) {}
		}
	}

	// Namespaced (SymBotModal.open / .close) rather than a bare global openModal — the header
	// partial already defines an unrelated jQuery-UI `openModal(modalId, div, …)`, so a global name
	// here would collide with it.
	window.SymBotModal = { open: openModal, close: closeModals };

	// Delegated close controls and backdrop click. `.modal-close` is intentionally NOT handled here
	// so a view can attach its own routed close (e.g. schedulesView's data-close) without a double
	// fire — this handler covers the generic [data-modal-close] / [data-ac-close] controls only.
	document.addEventListener('click', function (e) {

		const t = e.target;

		if (t && t.closest && t.closest('[data-modal-close], [data-ac-close]')) { closeModals(); return; }
		if (t && t.classList && t.classList.contains('modal-overlay')) { closeModals(); }
	});

	// Escape closes any open modal.
	document.addEventListener('keydown', function (e) {

		if (e.key === 'Escape') { closeModals(); }
	});

})();
