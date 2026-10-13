function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  if (typeof window.getText === 'function') { var r = window.getText(key); if (r && r !== key) return r; }
  return fallback;
}
/**
 * Cashier Payments
 * - GET /api/v1/cashier/payments
 */
(function () {
  'use strict';

  var state = { page: 1, limit: 10, search: '', status: 'all', method: 'all', date: '', total: 0, pages: 1 };

  function showError(message) {
    var banner = document.getElementById('errorBanner');
    if (banner) {
      banner.style.display = 'block';
      banner.textContent = message;
    }
  }
  function hideError() {
    var banner = document.getElementById('errorBanner');
    if (banner) banner.style.display = 'none';
  }

  function statusBadge(status) {
    var s = String(status || 'PENDING').toUpperCase();
    var cls = 'badge-warning';
    if (s === 'PAID') cls = 'badge-success';
    else if (s === 'FAILED' || s === 'CANCELLED') cls = 'badge-danger';
    else if (s === 'REFUNDED') cls = 'badge-neutral';
    return '<span class="badge ' + cls + '">' + window.esc(s) + '</span>';
  }

  function renderPayments(payments) {
    var body = document.getElementById('paymentsTableBody');
    if (!body) return;
    if (!payments.length) {
      body.innerHTML = '<tr><td colspan="7" class="table-empty">No payments found.</td></tr>';
      return;
    }
    body.innerHTML = payments
      .map(function (p) {
        return (
          '<tr>' +
          '<td><strong>#' + window.esc(p.orderId || '—') + '</strong></td>' +
          '<td>' + window.esc(p.customerName || '—') + '</td>' +
          '<td>' + window.esc(p.method || '—') + '</td>' +
          '<td><strong>' + window.CashierAPI.formatCurrency(p.amount, p.currency) + '</strong></td>' +
          '<td>' + statusBadge(p.paymentStatus) + '</td>' +
          '<td>' + window.esc(p.transactionId || '—') + '</td>' +
          '<td>' + window.CashierAPI.formatDateTime(p.paidAt || p.createdAt) + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderPagination() {
    var info = document.getElementById('paymentsPaginationInfo');
    var prev = document.getElementById('prevPaymentsPageBtn');
    var next = document.getElementById('nextPaymentsPageBtn');
    if (info) info.textContent = tr('page_of_payments', 'Page {page} of {pages} ({total} payments)').replace('{page}', state.page).replace('{pages}', Math.max(state.pages, 1)).replace('{total}', state.total);
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= state.pages;
  }

  async function loadPayments() {
    var body = document.getElementById('paymentsTableBody');
    if (!body || !window.CashierAPI) return;
    body.innerHTML = '<tr><td colspan="7" class="table-empty">Loading payments...</td></tr>';
    try {
      var res = await window.CashierAPI.get('/cashier/payments', {
        page: state.page,
        limit: state.limit,
        search: state.search,
        status: state.status,
        method: state.method,
        date: state.date,
      });
      state.total = res.total || 0;
      state.pages = res.pages || Math.max(Math.ceil(state.total / state.limit), 1);
      renderPayments(res.payments || []);
      renderPagination();
      hideError();
    } catch (e) {
      body.innerHTML = tr('failed_load_payments', 'Failed to load payments: {error}', { error: e.message || '' });
      showError(e.message);
    }
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function applyFilters() {
    var search = document.getElementById('paymentSearchInput');
    var status = document.getElementById('paymentStatusFilter');
    var method = document.getElementById('paymentMethodFilter');
    var date = document.getElementById('paymentDateFilter');
    state.search = search ? search.value.trim() : '';
    state.status = status ? status.value : 'all';
    state.method = method ? method.value : 'all';
    state.date = date ? date.value : '';
    state.page = 1;
    loadPayments();
  }

  function bindEvents() {
    var search = document.getElementById('paymentSearchInput');
    if (search) {
      search.addEventListener('input', debounce(function () {
        state.search = search.value.trim();
        state.page = 1;
        loadPayments();
      }, 400));
    }

    var applyBtn = document.getElementById('applyPaymentFiltersBtn');
    if (applyBtn) applyBtn.addEventListener('click', applyFilters);
    ['paymentStatusFilter', 'paymentMethodFilter', 'paymentDateFilter'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', applyFilters);
    });

    var refresh = document.getElementById('refreshPaymentsBtn');
    if (refresh) refresh.addEventListener('click', loadPayments);

    var prev = document.getElementById('prevPaymentsPageBtn');
    var next = document.getElementById('nextPaymentsPageBtn');
    if (prev) prev.addEventListener('click', function () { if (state.page > 1) { state.page--; loadPayments(); } });
    if (next) next.addEventListener('click', function () { if (state.page < state.pages) { state.page++; loadPayments(); } });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    loadPayments();
  });
})();
