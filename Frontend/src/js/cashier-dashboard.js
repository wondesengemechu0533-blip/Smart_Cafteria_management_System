function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * Cashier Dashboard
 * - Loads GET /api/v1/cashier/dashboard
 * - Renders day summary stat cards and the recent orders table
 * - Lets the cashier confirm cash payment for unpaid orders via
 *   PATCH /api/v1/cashier/orders/:id/mark-paid
 */
(function () {
  'use strict';

  var PAYMENT_BADGE_CLASS = {
    PAID: 'badge-success',
    PENDING: 'badge-warning',
    FAILED: 'badge-danger',
    CANCELLED: 'badge-danger',
    REFUNDED: 'badge-neutral'
  };

  function normalizeValue(s) {
    return (s || '').toString().trim().toUpperCase();
  }

  function orderStatusLabel(s) {
    var n = (s || '').toString().trim().toLowerCase();
    var map = window.ORDER_STATUS_LABELS || {};
    return map[n] || s || '—';
  }

  function paymentBadge(status) {
    var n = normalizeValue(status);
    var extra = n === 'PAID' ? '✓ ' : '';
    return '<span class="badge ' + (PAYMENT_BADGE_CLASS[n] || 'badge-warning') + '">' + window.esc(extra + (status || '—')) + '</span>';
  }

  function formatMoney(v) {
    return window.CashierAPI.formatCurrency(v);
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

  function renderStats(dashboard) {
    var set = function (id, v) {
      var el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    set('statTodayOrders', dashboard.todayOrders || 0);
    set('statPendingPayments', dashboard.pendingPayments || 0);
    set('statGrossToday', formatMoney(dashboard.grossToday));
    set('statVatToday', formatMoney(dashboard.vatCollectedToday));
    set('statCashToday', formatMoney(dashboard.cashCollectedToday));
    set('statNetCash', formatMoney(dashboard.netCashAtHand));
  }

  function renderOrders(orders) {
    var body = document.getElementById('recentOrdersTableBody');
    if (!body) return;

    if (!orders.length) {
      body.innerHTML = '<tr><td colspan="8" class="table-empty">No orders recorded today.</td></tr>';
      return;
    }

    var html = '';
    orders.forEach(function (order) {
      var isPaid = normalizeValue(order.paymentStatus) === 'PAID';
      var action = isPaid
        ? '<span class="text-muted">—</span>'
        : '<button type="button" class="btn btn-sm btn-success confirm-payment-btn" data-id="' + window.esc(order.id) + '" data-order="' + window.esc(order.orderId) + '"><i class="fa-solid fa-money-bill-wave"></i> Confirm Payment</button>';

      html += '<tr>';
      html += '<td><strong>#' + window.esc(order.orderId) + '</strong></td>';
      html += '<td>' + window.esc(order.customerName || '—') + '</td>';
      html += '<td><strong>' + formatMoney(order.totalAmount) + '</strong></td>';
      html += '<td>' + window.esc(order.paymentMethod || '—') + '</td>';
      html += '<td>' + paymentBadge(order.paymentStatus) + '</td>';
      html += '<td>' + window.esc(orderStatusLabel(order.orderStatus)) + '</td>';
      html += '<td>' + window.CashierAPI.formatDateTime(order.createdAt) + '</td>';
      html += '<td>' + action + '</td>';
      html += '</tr>';
    });
    body.innerHTML = html;
  }

  async function loadDashboard() {
    try {
      var res = await window.CashierAPI.get('/cashier/dashboard');
      var dashboard = res.dashboard || {};
      renderStats(dashboard);
      renderOrders(dashboard.recentOrders || []);
      hideError();
    } catch (e) {
      showError(tr('error_load_report', 'Failed to load dashboard: ') + e.message);
    }
  }

  async function confirmPayment(orderId) {
    if (!window.confirm(tr('cash_confirm_payment', 'Confirm CASH payment for order #{orderId}?', { orderId: orderId }))) return;
    try {
      var res = await window.CashierAPI.patch('/cashier/orders/' + encodeURIComponent(orderId) + '/mark-paid', { method: 'CASH' });
      window.CashierToast.success(res.message || tr('payment_confirmed', 'Payment confirmed.'));
      loadDashboard();
    } catch (e) {
      window.CashierToast.error(e.message);
    }
  }

  function bindEvents() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.confirm-payment-btn');
      if (btn) {
        confirmPayment(btn.getAttribute('data-id'));
      }
    });

    var refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadDashboard);
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    loadDashboard();
  });
})();