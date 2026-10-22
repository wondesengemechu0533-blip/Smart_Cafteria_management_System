/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - MANAGER DASHBOARD
   ==========================================================================
   Populates manager/dashboard.html using the shared metrics + orders APIs
   (all authorized for the manager role on the backend):
     - GET /admin/dashboard                  -> stats + revenue + chart series + feedback
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

  var currentDateRange = { days: 7, startDate: null, endDate: null };
  var lastStats = null;
  var lastOrders = null;
  var lastChartOrders = null;
  var lastRevenueDays = null;
  var lastFeedbackDist = null;
  var orderStatusChartInstance = null;
  var revenueChartInstance = null;
  var feedbackRatingChartInstance = null;
  var dashboardLoading = false;

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value === null || value === undefined ? '0' : String(value);
  }

  function setHtml(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function showElement(id, show) {
    var el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  }

  function updateDateRangeDisplay() {
    var display = document.getElementById('dateRangeDisplay');
    if (!display) return;
    var text = '';
    if (currentDateRange.startDate && currentDateRange.endDate) {
      text = tr('admin_custom_range', 'Custom Range: {start} to {end}', {
        start: currentDateRange.startDate,
        end: currentDateRange.endDate
      });
    } else {
      text = tr('admin_last_n_days', 'Last {days} Days', { days: currentDateRange.days });
    }
    display.textContent = text;
  }

  function setActiveFilterButton(groupId, days) {
    var group = document.getElementById(groupId);
    if (!group) return;
    var buttons = group.querySelectorAll('button[data-days]');
    buttons.forEach(function (btn) {
      btn.classList.toggle('active', parseInt(btn.dataset.days, 10) === days);
      btn.classList.toggle('btn-primary', parseInt(btn.dataset.days, 10) === days);
      btn.classList.toggle('btn-outline-primary', parseInt(btn.dataset.days, 10) !== days);
    });
  }

  function renderStats(d) {
    if (!d) return;
    var u = d.users || {};
    var m = d.menu || {};
    var o = d.orders || {};
    var r = d.revenue || {};
    var f = d.feedback || {};

    setText('statTotalUsers', u.total || 0);
    setText('statCustomers', u.customers || 0);
    setText('statTotalMenu', m.total || 0);
    setText('statAvailableNow', m.available || 0);
    setText('statTotalFeedback', f.total || 0);
    setText('statPendingFeedback', f.pending || 0);
    setText('statResolvedFeedback', f.resolved || 0);
    setText('statAvgRating', (f.averageRating || 0).toFixed(1));

    var revEl = document.getElementById('statTotalRevenue');
    if (revEl) revEl.innerHTML = (Number(r.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + ' <small>ETB</small>';

    setText('kitchenPreparing', o.preparing || 0);
    setText('kitchenReady', o.ready || 0);
    setText('kitchenServed', o.served || 0);
  }

  function renderOrderStatusChart(ordersInRange) {
    var canvas = document.getElementById('orderStatusChart');
    if (!canvas || typeof Chart === 'undefined') return;

    showElement('orderStatusChartLoading', false);
    showElement('orderStatusChartError', false);

    var keys = ['pending', 'preparing', 'ready', 'served', 'completed', 'cancelled'];
    var labels = keys.map(function (k) {
      var code = k.toUpperCase();
      return statusKey(code);
    });
    var values = keys.map(function (k) { return (ordersInRange && ordersInRange[k]) || 0; });

    var hasData = values.some(function (v) { return v > 0; });
    showElement('orderStatusChartEmpty', !hasData);
    canvas.style.display = hasData ? '' : 'none';

    if (orderStatusChartInstance) orderStatusChartInstance.destroy();

    orderStatusChartInstance = new Chart(canvas, {
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
    var canvas = document.getElementById('revenueChart');
    if (!canvas || typeof Chart === 'undefined') return;

    showElement('revenueChartLoading', false);
    showElement('revenueChartError', false);

    if (!days || !days.length) days = [];

    var labels = days.map(function (d) { return (d.date || '').slice(5); });
    var values = days.map(function (d) { return Number(d.revenue || 0); });

    var hasData = values.some(function (v) { return v > 0; });
    showElement('revenueChartEmpty', !hasData);
    canvas.style.display = hasData ? '' : 'none';

    if (revenueChartInstance) revenueChartInstance.destroy();

    revenueChartInstance = new Chart(canvas, {
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
          y: { beginAtZero: true, ticks: { callback: function (v) { return v.toLocaleString(); } } }
        }
      }
    });
  }

  function renderFeedbackRatingChart(dist) {
    var canvas = document.getElementById('feedbackRatingChart');
    if (!canvas || typeof Chart === 'undefined') return;

    showElement('feedbackRatingChartLoading', false);
    showElement('feedbackRatingChartError', false);

    if (!dist) dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    var labels = ['1 ★', '2 ★', '3 ★', '4 ★', '5 ★'];
    var values = [dist[1] || 0, dist[2] || 0, dist[3] || 0, dist[4] || 0, dist[5] || 0];

    var hasData = values.some(function (v) { return v > 0; });
    showElement('feedbackRatingChartEmpty', !hasData);
    canvas.style.display = hasData ? '' : 'none';

    if (feedbackRatingChartInstance) feedbackRatingChartInstance.destroy();

    feedbackRatingChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: tr('manager_feedback_rating_distribution', 'Feedback Rating Distribution'),
          data: values,
          backgroundColor: ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e'],
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (context) {
                return context.dataset.label + ': ' + context.raw + ' ' + tr('feedback_count', 'feedback(s)');
              }
            }
          }
        },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 } }
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
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">' +
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

      var statusDisplay = o.orderStatus || o.status || '';
      var statusBadge = '<span class="order-status-badge ' + statusClass(statusDisplay) + '">' + esc(String(statusKey(statusDisplay))) + '</span>';

      var itemsSummary = (o.items || []).map(function (i) {
        return i.name + ' x' + i.quantity;
      }).join(', ');

      html += '<tr>'
        + '<td><a href="../admin/orders.html?id=' + esc(String(o._id || '')) + '">' + esc(String(o.orderId || o._id || '-')) + '</a></td>'
        + '<td>' + esc(String(customer)) + '</td>'
        + '<td>' + esc(String(itemsSummary || '-')) + '</td>'
        + '<td>' + amount + ' ETB ' + paymentTag + '</td>'
        + '<td>' + paymentTag + '</td>'
        + '<td>' + statusBadge + '</td>'
        + '<td>' + window.AdminAPI.formatDateTime(o.createdAt) + '</td>'
        + '<td><a href="../admin/order-details.html?id=' + esc(String(o._id || '')) + '" class="btn btn-sm btn-outline-primary" data-i18n="manager_view_details">View</a></td>'
        + '</tr>';
    });
    tbody.innerHTML = html;
  }

  function setRefreshLoading(loading) {
    var btn = document.getElementById('refreshMetricsBtn');
    if (!btn) return;
    btn.disabled = loading;
    var icon = btn.querySelector('i');
    if (icon) icon.className = loading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate';
  }

  function buildQueryParams() {
    var params = {};
    if (currentDateRange.startDate && currentDateRange.endDate) {
      params.startDate = currentDateRange.startDate;
      params.endDate = currentDateRange.endDate;
    } else {
      params.days = currentDateRange.days;
    }
    return params;
  }

  function loadDashboard(options) {
    options = options || {};
    if (options.fromRefresh) {
      if (dashboardLoading) return;
      dashboardLoading = true;
      setRefreshLoading(true);
    }

    var params = buildQueryParams();

    window.AdminAPI.get('/admin/dashboard', params).then(function (res) {
      if (!res || !res.success) return;
      var data = res.data || {};
      lastStats = data;
      renderStats(data);
      renderOrderStatusChart(data.chart && data.chart.ordersInRange);
      renderRevenueChart(data.chart && data.chart.series);
      renderFeedbackRatingChart(data.feedback && data.feedback.ratingDistribution);

      var limit = document.getElementById('recentOrdersLimit') ? parseInt(document.getElementById('recentOrdersLimit').value, 10) : 10;
      return window.AdminAPI.get('/admin/dashboard/recent-orders', Object.assign({ limit: limit }, params)).then(function (r2) {
        if (r2 && r2.orders) renderRecentOrders(r2.orders);
        if (options.fromRefresh && window.AdminToast) {
          window.AdminToast.show(tr('admin_dashboard_refreshed', 'Dashboard refreshed'));
        }
      });
    }).catch(function (err) {
      console.error('Dashboard load error:', err);
      var tbody = document.getElementById('recentOrdersTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty">' +
        tr('report_failed', 'Failed to load metrics. Is the backend running?') + '</td></tr>';
      showElement('orderStatusChartLoading', false);
      showElement('orderStatusChartError', true);
      setHtml('orderStatusChartErrorMsg', tr('admin_load_metrics_failed', 'Could not load dashboard metrics.'));
      showElement('revenueChartLoading', false);
      showElement('revenueChartError', true);
      setHtml('revenueChartErrorMsg', tr('admin_load_metrics_failed', 'Could not load dashboard metrics.'));
      showElement('feedbackRatingChartLoading', false);
      showElement('feedbackRatingChartError', true);
      setHtml('feedbackRatingChartErrorMsg', tr('admin_load_metrics_failed', 'Could not load dashboard metrics.'));
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
      .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
      .replace(/"/g, '"').replace(/'/g, "'");
  }

  function rerenderOnLanguageChange() {
    if (lastStats) {
      renderStats(lastStats);
      renderOrderStatusChart(lastStats.chart && lastStats.chart.ordersInRange);
      renderRevenueChart(lastStats.chart && lastStats.chart.series);
      renderFeedbackRatingChart(lastStats.feedback && lastStats.feedback.ratingDistribution);
    }
    if (lastOrders) renderRecentOrders(lastOrders);
    updateDateRangeDisplay();
  }

  function applyDateRange(days, startDate, endDate) {
    currentDateRange.days = days;
    currentDateRange.startDate = startDate;
    currentDateRange.endDate = endDate;
    setActiveFilterButton('quickFilterBtns', days);
    setActiveFilterButton('orderStatusChartFilters', days);
    setActiveFilterButton('revenueChartFilters', days);
    updateDateRangeDisplay();
    loadDashboard();
  }

  function init() {
    var refreshBtn = document.getElementById('refreshMetricsBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadDashboard({ fromRefresh: true });
      });
    }

    var resetBtn = document.getElementById('resetFiltersBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        currentDateRange = { days: 7, startDate: null, endDate: null };
        setActiveFilterButton('quickFilterBtns', 7);
        setActiveFilterButton('orderStatusChartFilters', 7);
        setActiveFilterButton('revenueChartFilters', 7);
        showElement('startDateGroup', false);
        showElement('endDateGroup', false);
        showElement('applyCustomGroup', false);
        var startInput = document.getElementById('startDateInput');
        var endInput = document.getElementById('endDateInput');
        if (startInput) startInput.value = '';
        if (endInput) endInput.value = '';
        updateDateRangeDisplay();
        loadDashboard();
        if (window.AdminToast) {
          window.AdminToast.show(tr('admin_filters_reset', 'Filters reset to default'));
        }
      });
    }

    // Quick filter buttons
    var quickFilterBtns = document.getElementById('quickFilterBtns');
    if (quickFilterBtns) {
      quickFilterBtns.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-days]');
        if (btn) {
          var days = parseInt(btn.dataset.days, 10);
          applyDateRange(days, null, null);
          showElement('startDateGroup', false);
          showElement('endDateGroup', false);
          showElement('applyCustomGroup', false);
        }
        var customBtn = e.target.closest('#customRangeToggle');
        if (customBtn) {
          var show = customBtn.classList.toggle('active');
          showElement('startDateGroup', show);
          showElement('endDateGroup', show);
          showElement('applyCustomGroup', show);
          if (show) {
            var today = new Date();
            var weekAgo = new Date(today);
            weekAgo.setDate(weekAgo.getDate() - 6);
            var startInput = document.getElementById('startDateInput');
            var endInput = document.getElementById('endDateInput');
            if (startInput) startInput.value = weekAgo.toISOString().split('T')[0];
            if (endInput) endInput.value = today.toISOString().split('T')[0];
          }
        }
      });
    }

    // Apply custom range
    var applyCustomBtn = document.getElementById('applyCustomBtn');
    if (applyCustomBtn) {
      applyCustomBtn.addEventListener('click', function () {
        var startInput = document.getElementById('startDateInput');
        var endInput = document.getElementById('endDateInput');
        var startDate = startInput ? startInput.value : '';
        var endDate = endInput ? endInput.value : '';
        if (!startDate || !endDate) {
          if (window.AdminToast) window.AdminToast.error(tr('admin_invalid_date_range', 'Please select both start and end dates.'));
          return;
        }
        if (endDate < startDate) {
          if (window.AdminToast) window.AdminToast.error(tr('admin_end_before_start', 'End date cannot be before start date.'));
          return;
        }
        applyDateRange(null, startDate, endDate);
      });
    }

    // Chart filter buttons
    ['orderStatusChartFilters', 'revenueChartFilters'].forEach(function (id) {
      var group = document.getElementById(id);
      if (group) {
        group.addEventListener('click', function (e) {
          var btn = e.target.closest('button[data-days]');
          if (btn) {
            var days = parseInt(btn.dataset.days, 10);
            applyDateRange(days, null, null);
            showElement('startDateGroup', false);
            showElement('endDateGroup', false);
            showElement('applyCustomGroup', false);
            var customToggle = document.getElementById('customRangeToggle');
            if (customToggle) customToggle.classList.remove('active');
          }
        });
      }
    });

    // Recent orders limit change
    var limitSelect = document.getElementById('recentOrdersLimit');
    if (limitSelect) {
      limitSelect.addEventListener('change', function () {
        loadDashboard();
      });
    }

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