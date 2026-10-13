function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  if (typeof window.getText === 'function') { var r = window.getText(key); if (r && r !== key) return r; }
  return fallback;
}
/**
 * ==========================================================================
   SMART CAFETERIA ADMIN — SHARED UTILITIES
   ==========================================================================
   Common UI utilities: modals, tables, forms, confirmations, loading states.
   ========================================================================== */
(function () {
  'use strict';

  // --- Modal Management ---
  function openModal(id) { var el = document.getElementById(id); if (el) el.classList.add('open'); }
  function closeModal(id) { var el = document.getElementById(id); if (el) el.classList.remove('open'); }
  function closeAllModals() { document.querySelectorAll('.modal-overlay.open').forEach(function(m) { m.classList.remove('open'); }); }

  document.addEventListener('click', function(e) {
    var closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) closeModal(closeBtn.getAttribute('data-close-modal'));
  });

  // --- Form Helpers ---
  function serializeForm(form) {
    var data = {};
    new FormData(form).forEach(function(value, key) { data[key] = value; });
    return data;
  }

  function populateForm(form, data) {
    if (!data) return;
    for (var key in data) {
      var input = form.querySelector('[name="' + key + '"]');
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = !!data[key];
      else if (input.type === 'radio') {
        var radio = form.querySelector('[name="' + key + '"][value="' + data[key] + '"]');
        if (radio) radio.checked = true;
      } else input.value = data[key] || '';
    }
  }

  function resetForm(form) { form.reset(); }

  function setFormLoading(form, loading) {
    var btn = form.querySelector('[type="submit"]');
    if (!btn) return;
    if (loading) { if (btn.disabled) return; btn.disabled = true; btn.dataset.originalText = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...'; }
    else { btn.disabled = false; btn.innerHTML = btn.dataset.originalText || 'Save'; delete btn.dataset.originalText; }
  }

  // --- Table Helpers ---
  function renderTable(tbody, rows, renderRow) {
    if (!tbody) return;
    if (!rows || !rows.length) { tbody.innerHTML = '<tr><td colspan="100" class="table-empty">No data found</td></tr>'; return; }
    tbody.innerHTML = rows.map(renderRow).join('');
  }

  function createPagination(paginationEl, state, onChange) {
    if (!paginationEl) return;
    var info = paginationEl.querySelector('.pagination-info');
    var prevBtn = paginationEl.querySelector('[data-action="prev"]');
    var nextBtn = paginationEl.querySelector('[data-action="next"]');

    if (info) info.textContent = tr('page_info', 'Page {page} of {pages} ({total} items)').replace('{page}', state.page).replace('{pages}', Math.max(state.pages, 1)).replace('{total}', state.total);
    if (prevBtn) prevBtn.disabled = state.page <= 1;
    if (nextBtn) nextBtn.disabled = state.page >= state.pages;

    if (prevBtn) prevBtn.onclick = function() { if (state.page > 1) { state.page--; onChange(); } };
    if (nextBtn) nextBtn.onclick = function() { if (state.page < state.pages) { state.page++; onChange(); } };
  }

  // --- Confirmation Dialog ---
  function confirmAction(message, onConfirm) {
    if (window.confirm(message)) onConfirm();
  }

  // --- Loading States ---
  function setLoading(btn, loading, originalText) {
    if (!btn) return;
    if (loading) { if (btn.disabled) return; btn.disabled = true; btn.dataset.originalText = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...'; }
    else { btn.disabled = false; btn.innerHTML = btn.dataset.originalText || originalText || 'Save'; delete btn.dataset.originalText; }
  }

  // --- Debounce ---
  function debounce(fn, delay) {
    var timer = null;
    return function() { var args = arguments; clearTimeout(timer); timer = setTimeout(function() { fn.apply(null, args); }, delay); };
  }

  // --- Export ---
  window.AdminUI = {
    openModal: openModal,
    closeModal: closeModal,
    closeAllModals: closeAllModals,
    serializeForm: serializeForm,
    populateForm: populateForm,
    resetForm: resetForm,
    setFormLoading: setFormLoading,
    renderTable: renderTable,
    createPagination: createPagination,
    confirmAction: confirmAction,
    setLoading: setLoading,
    debounce: debounce
  };
})();