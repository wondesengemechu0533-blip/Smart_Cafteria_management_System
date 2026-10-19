function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN REPORTS
 * ================================================================
 * Role-aware driver for reports.html.
 *
 *   System admin / tax authority -> Summary | Revenue & VAT | Tax Compliance
 *     (backend: /admin/reports/summary, /reports/revenue, /reports/tax-compliance)
 *
 *   Cafeteria admin / manager -> Sales | Orders | Payments | Refunds |
 *     Menu Performance
 *     (backend: /cafeteria/reports/*, cafeteria scope resolved server-side)
 *
 * The client never sends a cafeteria id: it is derived from the authenticated
 * user on the backend. Period ranges are also resolved server-side.
 *
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ================================================================
 */
(function () {
  'use strict';

  /* ============================================================
   * SHARED HELPERS
   * ============================================================ */
  function t(key) {
    return window.t ? window.t(key) : key;
  }

  function esc(value) {
    return window.esc ? window.esc(value) : String(value === null || value === undefined ? '' : value);
  }

  function money(value) {
    if (value === null || value === undefined) return '0.00';
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setMoney(id, value) {
    setText(id, money(value) + ' ETB');
  }

  function getRole() {
    if (window.ScosRoles && ScosRoles.getCurrentRole) return ScosRoles.getCurrentRole();
    return '';
  }

  function statusVariant(status) {
    var s = String(status || '').toUpperCase();
    var map = {
      PENDING: 'pend',
      PREPARING: 'prep',
      IN_PREP: 'prep',
      INPREP: 'prep',
      READY: 'rd',
      SERVED: 'svd',
      COMPLETED: 'cmp',
      CANCELLED: 'cxl',
      CANCELED: 'cxl',
      PAID: 'cmp',
      APPROVED: 'cmp',
      REFUNDED: 'rfnd',
      REFUND_REQUESTED: 'rfnd',
      REJECTED: 'cxl',
      FAILED: 'cxl',
      REFUND_FAILED: 'cxl',
      SUCCESS: 'cmp',
      FAILURE: 'cxl',
    };
    return map[s] || 'muted';
  }

  function badge(status) {
    if (!status) return '<span class="order-badge muted">—</span>';
    return '<span class="order-badge ' + statusVariant(status) + '">' + esc(String(status).toUpperCase()) + '</span>';
  }

  function emptyRow(colspan, message) {
    return '<tr><td colspan="' + colspan + '" class="table-empty">' + esc(message) + '</td></tr>';
  }

  function cfPeriodQuery(extra) {
    var params = { period: document.getElementById('cfPeriodSelect').value };
    if (params.period === 'custom') {
      var s = document.getElementById('cfStartDate').value;
      var e = document.getElementById('cfEndDate').value;
      if (s) params.startDate = s;
      if (e) params.endDate = e;
    }
    if (extra) {
      for (var key in extra) {
        if (extra[key] !== undefined && extra[key] !== null && extra[key] !== '') params[key] = extra[key];
      }
    }
    return params;
  }

  function renderPager(id, pg, onChange) {
    var el = document.getElementById(id);
    if (!el) return;
    if (!pg || pg.pages <= 1) {
      el.innerHTML = pg ? '<span class="pager-info">' + pg.total + ' ' + esc(t('report_records')) + '</span>' : '';
      return;
    }
    el.innerHTML =
      '<span class="pager-info">' +
      pg.total +
      ' ' +
      esc(t('report_records')) +
      ' — ' +
      esc(t('report_page')) +
      ' ' +
      pg.page +
      '/' +
      pg.pages +
      '</span>' +
      '<button class="btn btn-secondary" data-pg="prev"' +
      (pg.page <= 1 ? ' disabled' : '') +
      '><i class="fa-solid fa-chevron-left"></i></button>' +
      '<button class="btn btn-secondary" data-pg="next"' +
      (pg.page >= pg.pages ? ' disabled' : '') +
      '><i class="fa-solid fa-chevron-right"></i></button>';
    var prev = el.querySelector('[data-pg="prev"]');
    var next = el.querySelector('[data-pg="next"]');
    if (prev)
      prev.addEventListener('click', function () {
        if (pg.page > 1) onChange(pg.page - 1);
      });
    if (next)
      next.addEventListener('click', function () {
        if (pg.page < pg.pages) onChange(pg.page + 1);
      });
  }

  function downloadCsv(filename, rows) {
    var csv = rows
      .map(function (row) {
        return row
          .map(function (cell) {
            var value = String(cell === null || cell === undefined ? '' : cell);
            return /[",\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
          })
          .join(',');
      })
      .join('\r\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /* ============================================================
   * ROLE DETECTION
   * ============================================================ */
  var CAFETERIA_ROLES = ['cafeteria_admin', 'manager'];
  var SYSTEM_ROLES = ['admin', 'system_admin'];
  var role = getRole();
  var isCafeteria = CAFETERIA_ROLES.indexOf(role) !== -1;
  var isSystem = SYSTEM_ROLES.indexOf(role) !== -1;
  if (!isCafeteria && !isSystem) isSystem = true;

  /* ============================================================
   * ------------------------------------------------------------
   * SYSTEM ADMIN / TAX AUTHORITY REPORTS (existing)
   * ------------------------------------------------------------
   * ============================================================ */
  var lastReport = null;

  var PERIOD_LABELS = {
    today: 'Today',
    yesterday: 'Yesterday',
    last7: 'Last 7 Days',
    last30: 'Last 30 Days',
    month: 'This Month',
    custom: 'Custom Date Range',
  };

  function getSystemQuery() {
    var period = document.getElementById('periodSelect').value;
    var startDate = document.getElementById('startDateInput').value;
    var endDate = document.getElementById('endDateInput').value;

    var params = '?period=' + encodeURIComponent(period);
    if (period === 'custom' && startDate) params += '&startDate=' + encodeURIComponent(startDate);
    if (period === 'custom' && endDate) params += '&endDate=' + encodeURIComponent(endDate);
    return params;
  }

  function toggleCustomRange() {
    var period = document.getElementById('periodSelect').value;
    var isCustom = period === 'custom';
    document.getElementById('startDateInput').disabled = !isCustom;
    document.getElementById('endDateInput').disabled = !isCustom;
  }

  async function loadReport() {
    try {
      var data = await window.AdminAPI.get('/admin/reports/summary' + getSystemQuery());
      var report = data.report || {};
      lastReport = report;

      document.getElementById('metricRevenueTitle').textContent =
        'Revenue (' + (PERIOD_LABELS[report.period] || report.period) + ')';
      setMoney('metricTotalRevenue', report.revenue);

      setText('metricTotalOrders', report.orders.totalOrders || 0);
      setText('metricCompletedOrders', report.orders.completedOrders || 0);
      setText('metricCancelledOrders', report.orders.cancelledOrders || 0);

      setText('metricSuccessfulPayments', report.payments.successfulPayments || 0);
      setText('metricFailedPayments', report.payments.failedPayments || 0);
      setText('metricPendingPayments', report.payments.pendingPayments || 0);

      renderTopFoods(report.mostOrderedFoods || []);

      var updated = document.getElementById('reportUpdatedAt');
      if (updated) {
        var rangeText =
          report.range && report.range.startDate && report.range.endDate
            ? report.range.startDate + ' to ' + report.range.endDate
            : 'all time';
        var when = report.generatedAt ? window.AdminAPI.formatDateTime(report.generatedAt) : 'just now';
        updated.textContent = tr('period_generated', 'Period: {range} - generated {when}.').replace('{range}', rangeText).replace('{when}', when);
      }

      if (window.AdminToast) window.AdminToast.show('Report refreshed');
    } catch (error) {
      var message = (error && error.message) || 'Server error';
      var tbody = document.getElementById('topFoodsBody');
      if (tbody) {
        tbody.innerHTML =
          '<tr><td colspan="5" class="table-empty">Failed to load report: ' + esc(message) + '</td></tr>';
      }
      if (window.AdminToast) window.AdminToast.error(message);
    }
  }

  function renderTopFoods(foods) {
    var tbody = document.getElementById('topFoodsBody');
    if (!tbody) return;

    if (!foods.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No food items ordered in this period.</td></tr>';
      return;
    }

    tbody.innerHTML = foods
      .map(function (food, index) {
        return (
          '<tr>' +
          '<td><span class="rank-badge">' +
          (index + 1) +
          '</span></td>' +
          '<td><strong>' +
          esc(food.name) +
          '</strong></td>' +
          '<td>' +
          (food.totalQuantity || 0) +
          '</td>' +
          '<td>' +
          (food.orderCount || 0) +
          '</td>' +
          '<td><strong>' +
          money(food.totalRevenue) +
          '</strong></td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function exportSystemCsv() {
    if (!lastReport) {
      if (window.AdminToast) window.AdminToast.error('No report data to export yet');
      return;
    }

    var rows = [];
    rows.push(['Smart Cafeteria - Reports Summary']);
    rows.push(['Period', PERIOD_LABELS[lastReport.period] || lastReport.period]);
    rows.push(['Range', lastReport.range.startDate + ' to ' + lastReport.range.endDate]);
    rows.push(['Generated', new Date().toLocaleString()]);
    rows.push([]);

    rows.push(['Revenue (ETB)']);
    rows.push(['Total Revenue', lastReport.revenue]);
    rows.push([]);

    rows.push(['Orders']);
    rows.push(['Total Orders', lastReport.orders.totalOrders]);
    rows.push(['Completed Orders', lastReport.orders.completedOrders]);
    rows.push(['Cancelled Orders', lastReport.orders.cancelledOrders]);
    rows.push([]);

    rows.push(['Payments']);
    rows.push(['Successful Payments', lastReport.payments.successfulPayments]);
    rows.push(['Failed Payments', lastReport.payments.failedPayments]);
    rows.push(['Pending Payments', lastReport.payments.pendingPayments]);
    rows.push([]);

    rows.push(['Most Ordered Foods']);
    rows.push(['Rank', 'Food Item', 'Total Quantity', 'Times Ordered', 'Revenue (ETB)']);
    lastReport.mostOrderedFoods.forEach(function (food, index) {
      rows.push([index + 1, food.name, food.totalQuantity, food.orderCount, food.totalRevenue]);
    });

    downloadCsv(
      'smart-cafeteria-report-' +
        (lastReport.period || 'summary') +
        '-' +
        new Date().toISOString().split('T')[0] +
        '.csv',
      rows
    );
  }

  function switchSystemTab(name) {
    ['summary', 'revenue', 'tax'].forEach(function (key) {
      var section = document.getElementById('reportView-' + key);
      if (section) section.classList.toggle('d-none', key !== name);
    });
    document.querySelectorAll('#systemReports .report-tab-btn').forEach(function (btn) {
      var active = btn.getAttribute('data-report-tab') === name;
      btn.classList.toggle('btn-primary', active);
      btn.classList.toggle('btn-secondary', !active);
      btn.classList.toggle('active', active);
    });
    // Keep URL hash in sync so the sidebar can highlight Tax / VAT or Revenue
    if (name === 'revenue' || name === 'tax') {
      if (window.location.hash.replace('#', '') !== name) {
        window.location.hash = name;
      }
    } else if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  async function loadRevenueReport() {
    var fromDate = document.getElementById('revenueFromDate').value;
    var toDate = document.getElementById('revenueToDate').value;
    var tbody = document.getElementById('revenueDailyBody');

    try {
      var data = await window.AdminAPI.get('/reports/revenue', { fromDate: fromDate, toDate: toDate });
      var report = data.report || {};
      var summary = report.summary || {};

      setMoney('metricRevenueGross', summary.gross);
      setMoney('metricRevenueSubtotal', summary.subtotal);
      setMoney('metricRevenueVat', summary.vat);
      setMoney('metricRevenueServiceFees', summary.serviceFees);
      setMoney('metricRevenueDeliveryFees', summary.deliveryFees);
      setMoney(
        'metricRevenuePlatformShare',
        summary.platformShare !== undefined ? summary.platformShare : summary.platformFees
      );
      setMoney('metricRevenueNetIncome', report.netCafeteriaIncome);
      setMoney('metricRevenueAvgOrder', report.averageOrderValue);
      setText('metricRevenueOrderCount', summary.orderCount || 0);
      setMoney('revenueTotalTaxRemitted', report.totalTaxRemitted);

      renderDailyBreakdown(report.dailyBreakdown || []);

      var rangeEl = document.getElementById('revenueReportRange');
      if (rangeEl) {
        rangeEl.textContent =
          (fromDate || report.fromDate || 'All time') + ' to ' + (toDate || report.toDate || 'All time');
      }

      if (window.AdminToast) window.AdminToast.show('Revenue report loaded');
    } catch (error) {
      if (tbody) {
        tbody.innerHTML =
          '<tr><td colspan="7" class="table-empty">Failed to load revenue report: ' +
          esc(error.message || 'Server error') +
          '</td></tr>';
      }
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_load_revenue_report', 'Failed to load revenue report'));
    }
  }

  function renderDailyBreakdown(days) {
    var tbody = document.getElementById('revenueDailyBody');
    if (!tbody) return;

    if (!days.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No daily data for the selected range.</td></tr>';
      return;
    }

    tbody.innerHTML = days
      .map(function (day) {
        return (
          '<tr>' +
          '<td>' +
          esc(day.date || '-') +
          '</td>' +
          '<td>' +
          (day.orders || 0) +
          '</td>' +
          '<td><strong>' +
          money(day.gross) +
          '</strong></td>' +
          '<td>' +
          money(day.vat) +
          '</td>' +
          '<td>' +
          money(day.serviceFees) +
          '</td>' +
          '<td>' +
          money(day.deliveryFees) +
          '</td>' +
          '<td>' +
          money(day.subtotal) +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  async function loadTaxCompliance() {
    var year = document.getElementById('taxYearInput').value;
    var tbody = document.getElementById('taxMonthlyBody');

    try {
      var data = await window.AdminAPI.get('/reports/tax-compliance', { year: year });
      var report = data.report || {};

      setText('taxTransactionCount', report.transactionCount || 0);
      setMoney('taxGrossSales', report.grossSales);
      setMoney('taxTaxableBase', report.taxableBase);
      setMoney('taxVatCollected', report.vatCollected);

      renderTaxMonthly(report.monthlyBreakdown || []);

      var periodEl = document.getElementById('taxReportPeriod');
      if (periodEl) periodEl.textContent = report.period || year || 'All time';

      if (window.AdminToast) window.AdminToast.show('Tax compliance report loaded');
    } catch (error) {
      if (tbody) {
        tbody.innerHTML =
          '<tr><td colspan="3" class="table-empty">Failed to load tax compliance report: ' +
          esc(error.message || 'Server error') +
          '</td></tr>';
      }
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_load_tax_report', 'Failed to load tax compliance report'));
    }
  }

  function renderTaxMonthly(months) {
    var tbody = document.getElementById('taxMonthlyBody');
    if (!tbody) return;

    if (!months.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="table-empty">No monthly data for this year.</td></tr>';
      return;
    }

    tbody.innerHTML = months
      .map(function (m) {
        return (
          '<tr>' +
          '<td>' +
          esc(m.month || '-') +
          '</td>' +
          '<td>' +
          money(m.grossSales) +
          '</td>' +
          '<td><strong>' +
          money(m.vatCollected) +
          '</strong></td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function bindSystemEvents() {
    var periodSelect = document.getElementById('periodSelect');
    if (periodSelect) {
      periodSelect.addEventListener('change', toggleCustomRange);
      periodSelect.addEventListener('change', function () {
        if (periodSelect.value !== 'custom') loadReport();
      });
    }

    var applyBtn = document.getElementById('applyReportBtn');
    if (applyBtn) applyBtn.addEventListener('click', loadReport);

    document.querySelectorAll('#systemReports .report-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchSystemTab(btn.getAttribute('data-report-tab'));
      });
    });

    var loadRevenueBtn = document.getElementById('loadRevenueBtn');
    if (loadRevenueBtn) loadRevenueBtn.addEventListener('click', loadRevenueReport);

    var loadTaxBtn = document.getElementById('loadTaxBtn');
    if (loadTaxBtn) loadTaxBtn.addEventListener('click', loadTaxCompliance);

    var taxYear = document.getElementById('taxYearInput');
    if (taxYear && !taxYear.value) taxYear.value = new Date().getFullYear();
  }

  function initSystem() {
    document.getElementById('systemReports').classList.remove('d-none');
    document.getElementById('cafeteriaReports').classList.add('d-none');
    toggleCustomRange();
    bindSystemEvents();

    // Initial tab from URL hash (e.g. reports.html#tax → Tax / VAT)
    var hash = window.location.hash.replace('#', '');
    var initialTab = hash === 'revenue' || hash === 'tax' ? hash : 'summary';
    switchSystemTab(initialTab);
    if (initialTab === 'revenue') loadRevenueReport();
    else if (initialTab === 'tax') loadTaxCompliance();
    else loadReport();

    window.addEventListener('hashchange', function () {
      var h = window.location.hash.replace('#', '');
      var tab = h === 'revenue' || h === 'tax' ? h : 'summary';
      switchSystemTab(tab);
      if (tab === 'revenue') loadRevenueReport();
      else if (tab === 'tax') loadTaxCompliance();
      else loadReport();
    });
  }

  /* ============================================================
   * ------------------------------------------------------------
   * CAFETERIA REPORTS
   * ------------------------------------------------------------
   * ============================================================ */
  var cfCharts = {};
  var cfState = {
    tab: 'cf-sales',
    ordersPage: 1,
    paymentsPage: 1,
    refundsPage: 1,
    menuCategoriesReady: false,
    export: null,
  };

  function destroyChart(key) {
    if (cfCharts[key]) {
      cfCharts[key].destroy();
      cfCharts[key] = null;
    }
  }

  function toggleCfCustomRange() {
    var isCustom = document.getElementById('cfPeriodSelect').value === 'custom';
    document.getElementById('cfStartDate').disabled = !isCustom;
    document.getElementById('cfEndDate').disabled = !isCustom;
  }

  async function loadCafeteriaName() {
    var el = document.getElementById('cafeteriaScopeName');
    try {
      var data = await window.AdminAPI.get('/cafeterias/mine');
      if (el) el.textContent = (data.cafeteria && data.cafeteria.name) || t('report_scope_default');
    } catch (error) {
      if (el) el.textContent = t('report_scope_default');
    }
  }

  function cfSetUpdated(range) {
    var el = document.getElementById('cfUpdatedAt');
    if (!el || !range) {
      if (el) el.textContent = '';
      return;
    }
    var fmt = function (d) {
      return window.AdminAPI.formatDate(d);
    };
    el.textContent = t('report_period_label') + ': ' + fmt(range.startDate) + ' — ' + fmt(range.endDate);
  }

  function cfFail(tbodyId, colspan, error) {
    var tbody = document.getElementById(tbodyId);
    if (tbody) tbody.innerHTML = emptyRow(colspan, t('report_failed') + ': ' + ((error && error.message) || ''));
    if (window.AdminToast) window.AdminToast.error((error && error.message) || tr('error_load_report', 'Failed to load report'));
  }

  /* ---------- SALES ---------- */
  function renderSalesChart(rows) {
    var canvas = document.getElementById('cfSalesChart');
    var emptyEl = document.getElementById('cfSalesChartEmpty');
    if (!canvas) return;
    destroyChart('sales');

    if (!rows.length || typeof Chart === 'undefined') {
      canvas.classList.add('d-none');
      if (emptyEl) emptyEl.classList.remove('d-none');
      return;
    }
    canvas.classList.remove('d-none');
    if (emptyEl) emptyEl.classList.add('d-none');

    cfCharts.sales = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: rows.map(function (r) {
          return r.date;
        }),
        datasets: [
          {
            label: t('report_col_sales'),
            data: rows.map(function (r) {
              return r.sales;
            }),
            borderColor: '#4f46e5',
            backgroundColor: 'rgba(79,70,229,0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }

  async function loadCfSales() {
    var tbody = document.getElementById('cfSalesMethodBody');
    try {
      var data = await window.AdminAPI.get('/cafeteria/reports/sales', cfPeriodQuery());
      var r = data.report;
      cfSetUpdated(r.range);

      setMoney('cfTotalSales', r.totalSales);
      setMoney('cfTodaySales', r.todaySales);
      setMoney('cfWeekSales', r.weeklySales);
      setMoney('cfMonthSales', r.monthlySales);
      setMoney('cfAvgOrder', r.averageOrderValue);
      setText('cfCompletedOrders', r.completedOrders || 0);
      setMoney('cfPaidRevenue', r.totalRevenue);

      renderSalesChart(r.salesByDate || []);

      if (!r.salesByPaymentMethod.length) {
        tbody.innerHTML = emptyRow(3, t('report_empty'));
      } else {
        tbody.innerHTML = r.salesByPaymentMethod
          .map(function (m) {
            return (
              '<tr><td>' +
              esc(m.method) +
              '</td><td>' +
              (m.orders || 0) +
              '</td><td><strong>' +
              money(m.sales) +
              '</strong></td></tr>'
            );
          })
          .join('');
      }

      cfState.export = {
        name: 'cafeteria-sales',
        rows: [['Method', 'Orders', 'Sales (ETB)']].concat(
          r.salesByPaymentMethod.map(function (m) {
            return [m.method, m.orders, m.sales];
          })
        ),
      };
    } catch (error) {
      cfFail('cfSalesMethodBody', 3, error);
    }
  }

  /* ---------- ORDERS ---------- */
  async function loadCfOrders() {
    var tbody = document.getElementById('cfOrdersBody');
    try {
      var data = await window.AdminAPI.get(
        '/cafeteria/reports/orders',
        cfPeriodQuery({
          status: document.getElementById('cfOrderStatus').value,
          paymentStatus: document.getElementById('cfOrderPaymentStatus').value,
          page: cfState.ordersPage,
          limit: 20,
        })
      );
      var r = data.report;
      cfSetUpdated(r.range);

      setText('cfOrdersTotal', r.counts.total || 0);
      setText('cfOrdersPending', r.counts.pending || 0);
      setText('cfOrdersPreparing', r.counts.preparing || 0);
      setText('cfOrdersReady', r.counts.ready || 0);
      setText('cfOrdersCompleted', r.counts.completed || 0);
      setText('cfOrdersCancelled', r.counts.cancelled || 0);
      setText('cfOrdersRefunded', r.counts.refunded || 0);

      if (!r.orders.length) {
        tbody.innerHTML = emptyRow(9, t('report_empty'));
      } else {
        tbody.innerHTML = r.orders
          .map(function (o) {
            return (
              '<tr>' +
              '<td><strong>' +
              esc(o.orderId || '-') +
              '</strong></td>' +
              '<td>' +
              esc(o.customerName || '-') +
              '</td>' +
              '<td>' +
              esc(o.orderType || '-') +
              '</td>' +
              '<td>' +
              esc(o.tableNumber || '-') +
              '</td>' +
              '<td><strong>' +
              money(o.totalAmount) +
              '</strong></td>' +
              '<td>' +
              badge(o.status) +
              '</td>' +
              '<td>' +
              esc(o.paymentMethod || '-') +
              '</td>' +
              '<td>' +
              badge(o.paymentStatus) +
              '</td>' +
              '<td>' +
              esc(window.AdminAPI.formatDateTime(o.createdAt)) +
              '</td>' +
              '</tr>'
            );
          })
          .join('');
      }

      renderPager('cfOrdersPager', r.pagination, function (p) {
        cfState.ordersPage = p;
        loadCfOrders();
      });

      cfState.export = {
        name: 'cafeteria-orders',
        rows: [['Order', 'Customer', 'Type', 'Table', 'Amount', 'Status', 'Method', 'Payment', 'Date']].concat(
          r.orders.map(function (o) {
            return [
              o.orderId,
              o.customerName,
              o.orderType,
              o.tableNumber,
              o.totalAmount,
              o.status,
              o.paymentMethod,
              o.paymentStatus,
              o.createdAt,
            ];
          })
        ),
      };
    } catch (error) {
      cfFail('cfOrdersBody', 9, error);
    }
  }

  /* ---------- PAYMENTS ---------- */
  async function loadCfPayments() {
    var tbody = document.getElementById('cfPaymentsBody');
    try {
      var data = await window.AdminAPI.get(
        '/cafeteria/reports/payments',
        cfPeriodQuery({
          status: document.getElementById('cfPayStatus').value,
          method: document.getElementById('cfPayMethod').value,
          page: cfState.paymentsPage,
          limit: 20,
        })
      );
      var r = data.report;
      cfSetUpdated(r.range);

      setText('cfPayTotal', r.counts.total || 0);
      setText('cfPayPaid', r.counts.paid || 0);
      setText('cfPayPending', r.counts.pending || 0);
      setText('cfPayFailed', r.counts.failed || 0);
      setText('cfPayRefunded', r.counts.refunded || 0);
      setMoney('cfPayPaidAmount', r.totalPaidAmount);

      var methodBody = document.getElementById('cfPayMethodsBody');
      if (!r.paymentMethods.length) {
        methodBody.innerHTML = emptyRow(3, t('report_empty'));
      } else {
        methodBody.innerHTML = r.paymentMethods
          .map(function (m) {
            return (
              '<tr><td>' +
              esc(m.method) +
              '</td><td>' +
              (m.count || 0) +
              '</td><td><strong>' +
              money(m.amount) +
              '</strong></td></tr>'
            );
          })
          .join('');
      }

      if (!r.transactions.length) {
        tbody.innerHTML = emptyRow(8, t('report_empty'));
      } else {
        tbody.innerHTML = r.transactions
          .map(function (p) {
            return (
              '<tr>' +
              '<td class="mono-ref">' +
              esc(p.paymentNumber || '-') +
              '</td>' +
              '<td>' +
              esc(p.orderRef || '-') +
              '</td>' +
              '<td>' +
              esc(p.customerName || '-') +
              '</td>' +
              '<td><strong>' +
              money(p.amount) +
              '</strong></td>' +
              '<td>' +
              esc(p.method || '-') +
              '</td>' +
              '<td>' +
              badge(p.status) +
              '</td>' +
              '<td>' +
              esc(p.reference || '-') +
              '</td>' +
              '<td>' +
              esc(window.AdminAPI.formatDateTime(p.paymentDate)) +
              '</td>' +
              '</tr>'
            );
          })
          .join('');
      }

      renderPager('cfPaymentsPager', r.pagination, function (p) {
        cfState.paymentsPage = p;
        loadCfPayments();
      });

      cfState.export = {
        name: 'cafeteria-payments',
        rows: [['Payment No', 'Order', 'Customer', 'Amount', 'Method', 'Status', 'Reference', 'Date']].concat(
          r.transactions.map(function (p) {
            return [
              p.paymentNumber,
              p.orderRef,
              p.customerName,
              p.amount,
              p.method,
              p.status,
              p.reference,
              p.paymentDate,
            ];
          })
        ),
      };
    } catch (error) {
      cfFail('cfPaymentsBody', 8, error);
    }
  }

  /* ---------- REFUNDS ---------- */
  async function loadCfRefunds() {
    var tbody = document.getElementById('cfRefundsBody');
    try {
      var data = await window.AdminAPI.get(
        '/cafeteria/reports/refunds',
        cfPeriodQuery({
          status: document.getElementById('cfRefStatus').value,
          page: cfState.refundsPage,
          limit: 20,
        })
      );
      var r = data.report;
      cfSetUpdated(r.range);

      setText('cfRefTotal', r.counts.total || 0);
      setText('cfRefRequested', r.counts.requested || 0);
      setText('cfRefApproved', r.counts.approved || 0);
      setText('cfRefRejected', r.counts.rejected || 0);
      setText('cfRefCompleted', r.counts.completed || 0);
      setText('cfRefFailed', r.counts.failed || 0);
      setMoney('cfRefAmount', r.totalRefundedAmount);

      if (!r.refunds.length) {
        tbody.innerHTML = emptyRow(9, t('report_empty'));
      } else {
        tbody.innerHTML = r.refunds
          .map(function (rf) {
            return (
              '<tr>' +
              '<td class="mono-ref">' +
              esc(rf.refundNumber || '-') +
              '</td>' +
              '<td>' +
              esc(rf.orderRef || '-') +
              '</td>' +
              '<td>' +
              esc(rf.customerName || '-') +
              '</td>' +
              '<td><strong>' +
              money(rf.amount) +
              '</strong></td>' +
              '<td><span class="report-desc">' +
              esc(rf.reason || '-') +
              '</span></td>' +
              '<td>' +
              badge(rf.status) +
              '</td>' +
              '<td>' +
              esc(rf.paymentMethod || '-') +
              '</td>' +
              '<td>' +
              esc(rf.requestedBy || '-') +
              '</td>' +
              '<td>' +
              esc(window.AdminAPI.formatDateTime(rf.requestedAt)) +
              '</td>' +
              '</tr>'
            );
          })
          .join('');
      }

      renderPager('cfRefundsPager', r.pagination, function (p) {
        cfState.refundsPage = p;
        loadCfRefunds();
      });

      cfState.export = {
        name: 'cafeteria-refunds',
        rows: [
          ['Refund No', 'Order', 'Customer', 'Amount', 'Reason', 'Status', 'Method', 'Requested By', 'Date'],
        ].concat(
          r.refunds.map(function (rf) {
            return [
              rf.refundNumber,
              rf.orderRef,
              rf.customerName,
              rf.amount,
              rf.reason,
              rf.status,
              rf.paymentMethod,
              rf.requestedBy,
              rf.requestedAt,
            ];
          })
        ),
      };
    } catch (error) {
      cfFail('cfRefundsBody', 9, error);
    }
  }

  /* ---------- MENU PERFORMANCE ---------- */
  function menuRows(items, colspan) {
    if (!items.length) return emptyRow(colspan, t('report_empty'));
    return items
      .map(function (i) {
        return (
          '<tr><td>' +
          esc(i.name) +
          '</td><td>' +
          (i.totalQuantity || 0) +
          '</td><td><strong>' +
          money(i.totalRevenue) +
          '</strong></td></tr>'
        );
      })
      .join('');
  }

  async function loadCfMenu() {
    var mostBody = document.getElementById('cfMenuMostBody');
    try {
      var data = await window.AdminAPI.get(
        '/cafeteria/reports/menu-performance',
        cfPeriodQuery({ category: document.getElementById('cfMenuCategory').value })
      );
      var r = data.report;
      cfSetUpdated(r.range);

      setText('cfMenuTotal', r.summary.totalItems || 0);
      setText('cfMenuAvailable', r.summary.availableItems || 0);
      setText('cfMenuUnavailable', r.summary.unavailableItems || 0);
      setText('cfMenuQty', r.summary.totalQuantitySold || 0);
      setMoney('cfMenuRevenue', r.summary.totalRevenue);

      if (!cfState.menuCategoriesReady) {
        var select = document.getElementById('cfMenuCategory');
        var seen = {};
        (r.items || []).forEach(function (i) {
          if (i.category && !seen[i.category]) {
            seen[i.category] = true;
            var opt = document.createElement('option');
            opt.value = i.category;
            opt.textContent = i.categoryName || i.category;
            select.appendChild(opt);
          }
        });
        cfState.menuCategoriesReady = true;
      }

      mostBody.innerHTML = menuRows(r.mostOrdered || [], 3);
      document.getElementById('cfMenuLeastBody').innerHTML = menuRows(r.leastOrdered || [], 3);

      var catBody = document.getElementById('cfMenuCatsBody');
      if (!r.bestCategories.length) {
        catBody.innerHTML = emptyRow(4, t('report_empty'));
      } else {
        catBody.innerHTML = r.bestCategories
          .map(function (c) {
            return (
              '<tr><td>' +
              esc(c.categoryName || c.category) +
              '</td><td>' +
              (c.itemCount || 0) +
              '</td><td>' +
              (c.totalQuantity || 0) +
              '</td><td><strong>' +
              money(c.totalRevenue) +
              '</strong></td></tr>'
            );
          })
          .join('');
      }

      cfState.export = {
        name: 'cafeteria-menu',
        rows: [['Item', 'Category', 'Quantity', 'Revenue']].concat(
          (r.items || []).map(function (i) {
            return [i.name, i.categoryName, i.totalQuantity, i.totalRevenue];
          })
        ),
      };
    } catch (error) {
      cfFail('cfMenuMostBody', 3, error);
    }
  }

  /* ============================================================
   * INVENTORY / STOCK
   * ============================================================ */
  async function loadCfInventory() {
    try {
      var r = await window.AdminAPI.get('/cafeteria/reports/inventory');
      var report = r.report || {};

      setText('cfInvTotalItems', report.summary ? report.summary.totalItems : 0);
      setText('cfInvAvailable', report.summary ? report.summary.availableItems : 0);
      setText('cfInvLowStock', report.summary ? report.summary.lowStockItems : 0);
      setText('cfInvOutOfStock', report.summary ? report.summary.outOfStockItems : 0);
      setText('cfInvTotalQty', report.summary ? report.summary.totalStockQuantity : 0);
      setMoney('cfInvTotalValue', report.summary ? report.summary.totalStockValue : 0);

      var tbody = document.getElementById('cfInvBody');
      if (!tbody) return;
      var items = report.items || [];
      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="table-empty">No inventory data available.</td></tr>';
        return;
      }
      tbody.innerHTML = items
        .map(function (item) {
          var statusClass = item.outOfStock ? 'cxl' : item.lowStock ? 'pend' : 'cmp';
          var statusText = item.outOfStock ? 'OUT OF STOCK' : item.lowStock ? 'LOW STOCK' : 'IN STOCK';
          return (
            '<tr>' +
            '<td>' + esc(item.name) + '</td>' +
            '<td>' + esc(item.category) + '</td>' +
            '<td>' + money(item.price) + ' ETB</td>' +
            '<td>' + item.stockQuantity + '</td>' +
            '<td>' + item.lowStockThreshold + '</td>' +
            '<td><span class="order-badge ' + statusClass + '">' + statusText + '</span></td>' +
            '<td>' + money(item.price * item.stockQuantity) + ' ETB</td>' +
            '</tr>'
          );
        })
        .join('');

      cfState.export = {
        name: 'cafeteria-inventory',
        rows: [['Item', 'Category', 'Price', 'Stock', 'Threshold', 'Status', 'Value']].concat(
          items.map(function (i) {
            return [i.name, i.category, i.price, i.stockQuantity, i.lowStockThreshold, i.outOfStock ? 'OUT OF STOCK' : i.lowStock ? 'LOW STOCK' : 'IN STOCK', i.price * i.stockQuantity];
          })
        ),
      };
    } catch (error) {
      cfFail('cfInvBody', 7, error);
    }
  }

  var CF_LOADERS = {
    'cf-sales': loadCfSales,
    'cf-orders': loadCfOrders,
    'cf-payments': loadCfPayments,
    'cf-refunds': loadCfRefunds,
    'cf-menu': loadCfMenu,
    'cf-inventory': loadCfInventory,
  };

  function loadActiveCafeteriaTab() {
    var loader = CF_LOADERS[cfState.tab];
    if (loader) loader();
  }

  function switchCafeteriaTab(name) {
    cfState.tab = name;
    Object.keys(CF_LOADERS).forEach(function (key) {
      var section = document.getElementById('cfView-' + key);
      if (section) section.classList.toggle('d-none', key !== name);
    });
    document.querySelectorAll('#cafeteriaReports .report-tab-btn').forEach(function (btn) {
      var active = btn.getAttribute('data-report-tab') === name;
      btn.classList.toggle('btn-primary', active);
      btn.classList.toggle('btn-secondary', !active);
      btn.classList.toggle('active', active);
    });
    loadActiveCafeteriaTab();
  }

  function exportCafeteriaCsv() {
    if (!cfState.export) {
      if (window.AdminToast) window.AdminToast.error('No report data to export yet');
      return;
    }
    downloadCsv(cfState.export.name + '-' + new Date().toISOString().split('T')[0] + '.csv', cfState.export.rows);
  }

  function bindCafeteriaEvents() {
    var periodSelect = document.getElementById('cfPeriodSelect');
    if (periodSelect) {
      periodSelect.addEventListener('change', toggleCfCustomRange);
      periodSelect.addEventListener('change', function () {
        if (periodSelect.value !== 'custom') loadActiveCafeteriaTab();
      });
    }

    var applyBtn = document.getElementById('cfApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', loadActiveCafeteriaTab);

    document.querySelectorAll('#cafeteriaReports .report-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchCafeteriaTab(btn.getAttribute('data-report-tab'));
      });
    });

    var filterMap = [
      [
        'cfOrderStatus',
        function () {
          cfState.ordersPage = 1;
          loadCfOrders();
        },
      ],
      [
        'cfOrderPaymentStatus',
        function () {
          cfState.ordersPage = 1;
          loadCfOrders();
        },
      ],
      [
        'cfPayStatus',
        function () {
          cfState.paymentsPage = 1;
          loadCfPayments();
        },
      ],
      [
        'cfPayMethod',
        function () {
          cfState.paymentsPage = 1;
          loadCfPayments();
        },
      ],
      [
        'cfRefStatus',
        function () {
          cfState.refundsPage = 1;
          loadCfRefunds();
        },
      ],
      [
        'cfMenuCategory',
        function () {
          loadCfMenu();
        },
      ],
    ];
    filterMap.forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (el) el.addEventListener('change', pair[1]);
    });
  }

  function initCafeteria() {
    document.getElementById('cafeteriaReports').classList.remove('d-none');
    document.getElementById('systemReports').classList.add('d-none');
    toggleCfCustomRange();
    bindCafeteriaEvents();
    loadCafeteriaName();

    // Determine initial tab from URL hash (e.g. reports.html#cf-orders)
    var hash = window.location.hash.replace('#', '');
    var initialTab = CF_LOADERS[hash] ? hash : 'cf-sales';
    switchCafeteriaTab(initialTab);

    // Listen for hash changes so sidebar links between report tabs work
    // without a full page reload (e.g. clicking Order Report while on Sales Report)
    window.addEventListener('hashchange', function () {
      var h = window.location.hash.replace('#', '');
      if (CF_LOADERS[h] && cfState.tab !== h) {
        switchCafeteriaTab(h);
      }
    });

    window.addEventListener('languageChanged', function () {
      loadCafeteriaName();
      loadActiveCafeteriaTab();
    });
  }

  /* ============================================================
   * BOOTSTRAP
   * ============================================================ */
  function init() {
    var refreshBtn = document.getElementById('refreshReportsBtn');
    var exportBtn = document.getElementById('exportCsvBtn');

    if (isCafeteria) {
      initCafeteria();
      if (refreshBtn) refreshBtn.addEventListener('click', loadActiveCafeteriaTab);
      if (exportBtn) exportBtn.addEventListener('click', exportCafeteriaCsv);
    } else {
      initSystem();
      if (refreshBtn) refreshBtn.addEventListener('click', loadReport);
      if (exportBtn) exportBtn.addEventListener('click', exportSystemCsv);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
