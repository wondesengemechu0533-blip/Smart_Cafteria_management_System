/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - MANAGER DASHBOARD
   ==========================================================================
   Populates manager/dashboard.html using the shared metrics + orders APIs
   (all authorized for the manager role on the backend):
     - GET /admin/dashboard                  -> stats + revenue + chart series
     - GET /admin/dashboard/recent-orders    -> recent orders table

   Requires window.AdminAPI (admin-api.js) loaded first.
   ========================================================================== */
(function () {
  'use strict';

  if (!window.AdminAPI) return;

  var tr = function (key, fallback, vars) {
    if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
    if (typeof window.getText === 'function') {
      var v = window.getText(key);
      if (v && v !== key) return v;
    }
    return fallback != null ? fallback : key;
  };

  var statusKey = function (code) {
    if (typeof window.translateStatus === 'function') {
      var localized = window.translateStatus(code);
      if (localized && localized !== code) return localized;
    }
    return tr('status_' + String(code || '').toLowerCase(), code || '-');
  };

  var lastStats = null;
  var lastOrders = null;
  var lastChartOrders = null;
  var lastRevenueDays = null;

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value === null || value === undefined ? '0' : String(value);
  }

  function renderStats(d) {
    if (!d) return;
    var o = d.orders || {};
    var r = d.revenue || {};
    setText('statTotalOrders', o.total || 0);
    setText('statPendingOrders', o.pending || 0);
    setText('statCompletedOrders', o.completed || 0);
    var revEl = document.getElementById('statTotalRevenue');
    if (revEl) revEl.innerHTML = (Number(r.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + ' <small>ETB</small>';

    setText('kitchenPreparing', o.preparing || 0);
    setText('kitchenReady', o.ready || 0);
    setText('kitchenServed', o.served || 0);
  }

  function renderOrderStatusChart(o) {
    lastChartOrders = o || lastChartOrders;
    var canvas = document.getElementById('orderStatusChart');
    if (!canvas || typeof Chart === 'undefined') return;
    var keys = ['pending', 'preparing', 'ready', 'served', 'completed', 'cancelled'];
    var labels = keys.map(function (k) {
      var code = k.toUpperCase();
      return statusKey(code);
    });
    var values = keys.map(function (k) { return (lastChartOrders && lastChartOrders[k]) || 0; });

    var existing = window.__managerOrderStatusChart;
    if (existing) existing.destroy();

    window.__managerOrderStatusChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: ['#f59e0b', '#3b82f6', '#8b5cf6', '#10b981', '#22c55e', '#ef4444'],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
      }
    });
  }

  function renderRevenueChart(days) {
    lastRevenueDays = days;
    var canvas = document.getElementById('revenueChart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!days || !days.length) days = [];

    var labels = days.map(function (d) { return (d.date || '').slice(5); });
    var values = days.map(function (d) { return Number(d.revenue || 0); });

    var existing = window.__managerRevenueChart;
    if (existing) existing.destroy();

    window.__managerRevenueChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: tr('manager_revenue_trend', 'Revenue Trend') + ' (ETB)',
          data: values,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.12)',
          fill: true,
          tension: 0.35
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { callback: function (v) { return v; } } }
        }
      }
    });
  }

  function statusClass(status) {
    return String(status || '').toLowerCase();
  }

  function renderRecentOrders(orders) {
    lastOrders = orders;
    var tbody = document.getElementById('recentOrdersTableBody');
    if (!tbody) return;
    if (!orders || !orders.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">' +
        tr('no_recent_orders', 'No recent orders yet.') + '</td></tr>';
      return;
    }
    var html = '';
    orders.forEach(function (o) {
      var customer = o.customer ? (o.customer.name || tr('customer', 'Customer')) : (o.customerName || tr('customer', 'Customer'));
      var amount = Number(o.totalAmount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      var payKey = o.paymentStatus === 'PAID' ? 'status_paid' : (o.paymentStatus === 'PENDING' ? 'status_unpaid' : null);
      var payColor = o.paymentStatus === 'PAID' ? '#16a34a' : (o.paymentStatus === 'PENDING' ? '#f59e0b' : '#6b7280');
      var payText = payKey ? tr(payKey, o.paymentStatus || '') : (o.paymentStatus || '');
      var paymentTag = '<small style="color:' + payColor + '">' + esc(String(payText)) + '</small>';
      html += '<tr>'
        + '<td><a href="../admin/orders.html">' + esc(String(o.orderId || o._id || '-')) + '</a></td>'
        + '<td>' + esc(String(customer)) + '</td>'
        + '<td>' + amount + ' ETB ' + paymentTag + '</td>'
        + '<td><span class="order-status-badge ' + statusClass(o.status) + '">' + esc(String(statusKey(o.status))) + '</span></td>'
        + '<td>' + window.AdminAPI.formatDateTime(o.createdAt) + '</td>'
        + '</tr>';
    });
    tbody.innerHTML = html;
  }

  var dashboardLoading = false;
  function setRefreshLoading(loading) {
    var btn = document.getElementById('refreshMetricsBtn');
    if (!btn) return;
    btn.disabled = loading;
    var icon = btn.querySelector('i');
    if (icon) icon.className = loading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate';
  }

  function loadDashboard(options) {
    options = options || {};
    if (options.fromRefresh) {
      if (dashboardLoading) return;
      dashboardLoading = true;
      setRefreshLoading(true);
    }
    window.AdminAPI.get('/admin/dashboard').then(function (res) {
      if (!res || !res.success) return;
      var data = res.data || {};
      lastStats = data;
      renderStats(data);
      renderOrderStatusChart(data.orders || {});
      renderRevenueChart(data.chart && data.chart.last7Days);

      return window.AdminAPI.get('/admin/dashboard/recent-orders', { limit: 6 }).then(function (r2) {
        if (r2 && r2.orders) renderRecentOrders(r2.orders);
        if (options.fromRefresh && window.AdminToast) {
          window.AdminToast.show(tr('admin_dashboard_refreshed', 'Dashboard refreshed'));
        }
      });
    }).catch(function () {
      var tbody = document.getElementById('recentOrdersTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="table-empty">' +
        tr('report_failed', 'Failed to load metrics. Is the backend running?') + '</td></tr>';
      if (window.AdminToast) window.AdminToast.error(tr('admin_load_metrics_failed', 'Could not load dashboard metrics.'));
    }).finally(function () {
      if (options.fromRefresh) {
        dashboardLoading = false;
        setRefreshLoading(false);
      }
    });
  }

  function esc(v) {
    if (window.AdminAPI && window.AdminAPI.esc) return window.AdminAPI.esc(v);
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function rerenderOnLanguageChange() {
    if (lastStats) {
      renderStats(lastStats);
      renderOrderStatusChart(lastStats.orders || {});
      renderRevenueChart(lastStats.chart && lastStats.chart.last7Days);
    }
    if (lastOrders) renderRecentOrders(lastOrders);
  }

  function init() {
    var refreshBtn = document.getElementById('refreshMetricsBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadDashboard({ fromRefresh: true });
      });
    }

    // Metric cards navigate to their data-nav target (already relative to this
    // page's folder, e.g. ../kitchen/dashboard.html or ../admin/payments.html).
    var cards = document.querySelectorAll('.metric-card[data-nav]');
    cards.forEach(function (card) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', function () {
        var target = card.getAttribute('data-nav');
        if (target) window.location.href = target;
      });
    });

    var register = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
    if (typeof register === 'function') register(rerenderOnLanguageChange);
    else window.addEventListener('language:changed', rerenderOnLanguageChange);

    loadDashboard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();