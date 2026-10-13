function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * Cashier Orders
 * - GET  /api/v1/cashier/orders
 * - PATCH /api/v1/cashier/orders/:id/mark-paid
 */
(function () {
  'use strict';

  var state = { page: 1, limit: 10, search: '', status: 'all', paymentStatus: 'all', total: 0, pages: 1 };

  var PAYMENT_BADGE = { PAID: 'badge-success', PENDING: 'badge-warning', FAILED: 'badge-danger', REFUNDED: 'badge-neutral' };
  var STATUS_BADGE = {
    PENDING: 'badge-warning',
    PREPARING: 'badge-info',
    READY: 'badge-primary',
    SERVED: 'badge-success',
    COMPLETED: 'badge-success',
    CANCELLED: 'badge-danger',
    DELIVERED: 'badge-success',
  };

  function badge(cls, text) {
    return '<span class="badge ' + cls + '">' + window.esc(text) + '</span>';
  }

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

  function renderOrders(orders) {
    var body = document.getElementById('ordersTableBody');
    if (!body) return;
    if (!orders.length) {
      body.innerHTML = '<tr><td colspan="8" class="table-empty">No orders found.</td></tr>';
      return;
    }

    body.innerHTML = orders
      .map(function (o) {
        var isPaid = String(o.paymentStatus || '').toUpperCase() === 'PAID';
        var action = isPaid
          ? '<span class="text-muted">—</span>'
          : '<button type="button" class="btn btn-sm btn-success confirm-payment-btn" data-id="' +
            window.esc(o.id) +
            '" data-order="' +
            window.esc(o.orderId) +
            '">Confirm Payment</button>';
        return (
          '<tr>' +
          '<td><strong>#' + window.esc(o.orderId) + '</strong></td>' +
          '<td>' + window.esc(o.customerName || '—') + '</td>' +
          '<td><strong>' + window.CashierAPI.formatCurrency(o.totalAmount) + '</strong></td>' +
          '<td>' + window.esc(o.paymentMethod || '—') + '</td>' +
          '<td>' + badge(PAYMENT_BADGE[o.paymentStatus] || 'badge-warning', o.paymentStatus || '—') + '</td>' +
          '<td>' + badge(STATUS_BADGE[o.orderStatus] || 'badge-neutral', o.orderStatus || '—') + '</td>' +
          '<td>' + window.CashierAPI.formatDateTime(o.createdAt) + '</td>' +
          '<td>' + action + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderPagination() {
    var info = document.getElementById('ordersPaginationInfo');
    var prev = document.getElementById('prevOrdersPageBtn');
    var next = document.getElementById('nextOrdersPageBtn');
    if (info) info.textContent = tr('page_of_orders', 'Page {page} of {pages} ({total} orders)').replace('{page}', state.page).replace('{pages}', Math.max(state.pages, 1)).replace('{total}', state.total);
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= state.pages;
  }

  async function loadOrders() {
    var body = document.getElementById('ordersTableBody');
    if (!body || !window.CashierAPI) return;
    body.innerHTML = '<tr><td colspan="8" class="table-empty">Loading orders...</td></tr>';
    try {
      var res = await window.CashierAPI.get('/cashier/orders', {
        page: state.page,
        limit: state.limit,
        search: state.search,
        status: state.status,
        paymentStatus: state.paymentStatus,
      });
      state.total = res.total || 0;
      state.pages = res.pages || Math.max(Math.ceil(state.total / state.limit), 1);
      renderOrders(res.orders || []);
      renderPagination();
      hideError();
    } catch (e) {
      body.innerHTML = tr('failed_load_orders', 'Failed to load orders: {error}', { error: e.message || '' });
      showError(e.message);
    }
  }

  async function confirmPayment(orderId) {
    if (!window.confirm(tr('cash_confirm_payment', 'Confirm CASH payment for order #{orderId}?', { orderId: orderId }))) return;
    try {
      var res = await window.CashierAPI.patch('/cashier/orders/' + encodeURIComponent(orderId) + '/mark-paid', { method: 'CASH' });
      window.CashierToast.success(res.message || tr('payment_confirmed', 'Payment confirmed.'));
      loadOrders();
    } catch (e) {
      window.CashierToast.error(e.message);
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

  function bindEvents() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.confirm-payment-btn');
      if (btn) confirmPayment(btn.getAttribute('data-id'));
    });

    var search = document.getElementById('orderSearchInput');
    if (search) {
      search.addEventListener('input', debounce(function () {
        state.search = search.value.trim();
        state.page = 1;
        loadOrders();
      }, 400));
    }

    function applyFilters() {
      var status = document.getElementById('orderStatusFilter');
      var payment = document.getElementById('orderPaymentFilter');
      state.status = status ? status.value : 'all';
      state.paymentStatus = payment ? payment.value : 'all';
      state.page = 1;
      loadOrders();
    }

    var applyBtn = document.getElementById('applyOrderFiltersBtn');
    if (applyBtn) applyBtn.addEventListener('click', applyFilters);
    var status = document.getElementById('orderStatusFilter');
    var payment = document.getElementById('orderPaymentFilter');
    if (status) status.addEventListener('change', applyFilters);
    if (payment) payment.addEventListener('change', applyFilters);

    var refresh = document.getElementById('refreshOrdersBtn');
    if (refresh) refresh.addEventListener('click', loadOrders);

    var prev = document.getElementById('prevOrdersPageBtn');
    var next = document.getElementById('nextOrdersPageBtn');
    if (prev) prev.addEventListener('click', function () { if (state.page > 1) { state.page--; loadOrders(); } });
    if (next) next.addEventListener('click', function () { if (state.page < state.pages) { state.page++; loadOrders(); } });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    loadOrders();
  });
})();
