function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - REVENUE / SYSTEM ANALYTICS
 * ================================================================
 * Driver for pages/admin/revenue.html - the FINANCIAL report page.
 *
 * This page answers financial questions:
 *   how much was sold, how much was actually collected, how much was
 *   refunded, how the period compares with the one before it, how the
 *   revenue splits by food item and order type and which payment methods
 *   collected it.
 *
 * The TAX compliance report (VAT calculation, taxable sales, transaction
 * level VAT records) lives on its own page - pages/admin/tax.html - so the
 * two pages never show the same content. This page only carries a short VAT
 * summary with a link to that page.
 *
 * Endpoint:
 *   GET /reports/finance   financial summary + revenue analytics
 *
 * Every figure comes from the stored Order / Payment / Refund collections and
 * from the CONFIGURED tax settings - nothing is hard-coded and nothing is
 * cached in the browser.
 * ================================================================
 */
(function () {
  'use strict';

  /* ============================================================
   * HELPERS
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

  function badge(status) {
    if (!status) return '<span class="order-badge muted">—</span>';
    var s = String(status).toUpperCase();
    var variant = 'muted';
    if (s === 'PAID' || s === 'COMPLETED' || s === 'REFUNDED') variant = 'cmp';
    else if (s === 'PENDING') variant = 'pend';
    else if (s === 'FAILED' || s === 'CANCELLED') variant = 'cxl';
    else if (s.indexOf('REFUND') !== -1) variant = 'rfnd';
    return '<span class="order-badge ' + variant + '">' + esc(s) + '</span>';
  }

  function emptyRow(colspan, message) {
    return '<tr><td colspan="' + colspan + '" class="table-empty">' + esc(message) + '</td></tr>';
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
   * STATE
   * ============================================================ */
  var state = {
    tab: 'financial',
    period: 'month',
    granularity: 'daily',
    taxGranularity: 'daily',
    finance: null,
  };

  var charts = {};

  function destroyChart(key) {
    if (charts[key]) {
      charts[key].destroy();
      charts[key] = null;
    }
  }

  /* ============================================================
   * PERIOD FILTER (shared with the Reports & Analytics page)
   * ============================================================ */
  function periodQuery() {
    if (!window.ScosReportPeriod) return { period: 'month' };
    return window.ScosReportPeriod.buildQuery('finPeriodSelect', 'finStartDate', 'finEndDate');
  }

  function syncPeriodInputs() {
    if (window.ScosReportPeriod) {
      window.ScosReportPeriod.syncCustomInputs('finPeriodSelect', 'finStartDate', 'finEndDate');
    }
  }

  function setUpdated(range, period) {
    var el = document.getElementById('financeUpdatedAt');
    if (!el) return;
    if (!range) {
      el.textContent = '';
      return;
    }
    var label = window.ScosReportPeriod ? window.ScosReportPeriod.label(period) : period;
    var text = window.ScosReportPeriod ? window.ScosReportPeriod.formatRange(range) : '';
    el.textContent = (label ? label + ' · ' : '') + text;
  }

  /* ============================================================
   * FINANCIAL SUMMARY
   * ============================================================ */
  function renderReconciliation(reconciliation) {
    var tbody = document.getElementById('finReconciliationBody');
    if (!tbody) return;

    var rows = [
      ['Order value (gross sales)', reconciliation.orderValue, 'Order records'],
      [
        'Components (food + fees + VAT)',
        reconciliation.componentTotal,
        'Order records',
      ],
      ['Component difference', reconciliation.componentDifference, 'Gross - components'],
      ['Collections (successful payments)', reconciliation.collections, 'Payment records'],
      ['Collection variance', reconciliation.collectionVariance, 'Collections - order value'],
      ['Not collected yet', reconciliation.unpaidValue, 'Orders without a successful payment'],
      ['Successful refunds', reconciliation.successfulRefunds, 'Processed refund records'],
      ['Net collected revenue', reconciliation.netCollectedRevenue, 'Collections - refunds'],
      ['Expected net (orders - unpaid - refunds)', reconciliation.expectedNet, 'Derived from orders'],
      ['Net difference', reconciliation.netDifference, 'Net collected - expected net'],
    ];

    tbody.innerHTML = rows
      .map(function (row) {
        var isTotal = row[0] === 'Net collected revenue';
        return (
          '<tr' +
          (isTotal ? ' class="fw-bold"' : '') +
          '><td>' +
          esc(row[0]) +
          '</td><td' +
          (isTotal ? ' style="font-weight:600"' : '') +
          '>' +
          money(row[1]) +
          ' ETB</td><td>' +
          esc(row[2]) +
          '</td></tr>'
        );
      })
      .join('');

    var status = document.getElementById('reconciliationStatus');
    if (status) {
      status.textContent = reconciliation.balanced
        ? t('revenue_balanced')
        : t('revenue_difference_found');
      status.className = 'text-muted ' + (reconciliation.balanced ? 'text-success' : 'text-warning');
    }
  }

  function buildFinancialExport(report) {
    var summary = report.summary || {};
    var reconciliation = report.reconciliation || {};
    var rows = [];
    rows.push(['Smart Cafeteria - Financial Report']);
    rows.push(['Period', window.ScosReportPeriod ? window.ScosReportPeriod.label(report.period) : report.period]);
    rows.push(['Range', report.range ? report.range.startDate + ' to ' + report.range.endDate : '']);
    rows.push(['Generated', new Date().toLocaleString()]);
    rows.push([]);
    rows.push(['Financial Summary (ETB)']);
    rows.push(['Gross Sales', summary.grossSales]);
    rows.push(['Food Subtotal', summary.foodSubtotal]);
    rows.push(['Discounts', summary.discounts]);
    rows.push(['VAT Collected', summary.vatCollected]);
    rows.push(['Service Fees', summary.serviceFees]);
    rows.push(['Delivery Fees', summary.deliveryFees]);
    rows.push(['Successful Payment Collections', summary.successfulCollections]);
    rows.push(['Successful Refunds', summary.successfulRefunds]);
    rows.push(['Net Collected Revenue', summary.netCollectedRevenue]);
    rows.push(['Average Order Value', summary.averageOrderValue]);
    rows.push(['Orders', summary.orderCount]);
    rows.push([]);
    rows.push(['Reconciliation (ETB)']);
    rows.push(['Order value', reconciliation.orderValue]);
    rows.push(['Component total', reconciliation.componentTotal]);
    rows.push(['Component difference', reconciliation.componentDifference]);
    rows.push(['Collections', reconciliation.collections]);
    rows.push(['Collection variance', reconciliation.collectionVariance]);
    rows.push(['Not collected yet', reconciliation.unpaidValue]);
    rows.push(['Successful refunds', reconciliation.successfulRefunds]);
    rows.push(['Net collected revenue', reconciliation.netCollectedRevenue]);
    rows.push(['Expected net', reconciliation.expectedNet]);
    rows.push(['Net difference', reconciliation.netDifference]);
    rows.push([]);
    rows.push(['Payment methods']);
    rows.push(['Method', 'Transactions', 'Amount (ETB)', 'Share %']);
    ((report.payments && report.payments.byMethod) || []).forEach(function (m) {
      rows.push([m.label || m.method, m.count, m.amount, m.share]);
    });
    rows.push([]);
    rows.push(['Revenue by food item']);
    rows.push(['Item', 'Quantity', 'Revenue (ETB)']);
    (report.revenueByFoodItem || []).forEach(function (f) {
      rows.push([f.name, f.quantity, f.revenue]);
    });
    rows.push([]);
    rows.push(['Revenue by order type']);
    rows.push(['Type', 'Orders', 'Revenue (ETB)', 'Share %']);
    (report.revenueByOrderType || []).forEach(function (o) {
      rows.push([o.label || o.type, o.orders, o.revenue, o.share]);
    });
    return rows;
  }

  async function loadFinance() {
    try {
      var data = await window.AdminAPI.get('/reports/finance', periodQuery());
      var report = data.report || {};
      state.finance = report;

      setUpdated(report.range, report.period);

      var summary = report.summary || {};
      setMoney('finGrossSales', summary.grossSales);
      setMoney('finFoodSubtotal', summary.foodSubtotal);
      setMoney('finDiscounts', summary.discounts);
      setMoney('finServiceFees', summary.serviceFees);
      setMoney('finDeliveryFees', summary.deliveryFees);
      setMoney('finCollections', summary.successfulCollections);
      setMoney('finRefunds', summary.successfulRefunds);
      setMoney('finNetCollected', summary.netCollectedRevenue);
      setMoney('finAvgOrder', summary.averageOrderValue);

      // Short VAT pointer - the full tax compliance report (including the
      // transaction level VAT records) is on its own page.
      var tax = report.tax || {};
      setText('finVatRate', (tax.configuredVatRate || 0) + '%');
      setMoney('finVatCollected', tax.vatCollected);
      setMoney('finNetVatRetained', tax.netVatRetained);

      renderReconciliation(report.reconciliation || {});

      /* ---- comparison with the previous period ---- */
      var comparison = report.comparison || {};
      setMoney('finCurrentGross', summary.grossSales);
      setMoney('finPreviousGross', comparison.grossSales);
      setText('finGrossChange', formatChange(comparison.change ? comparison.change.grossSales : 0));
      setText('finNetChange', formatChange(comparison.change ? comparison.change.netCollectedRevenue : 0));

      /* ---- payment totals ---- */
      var payments = report.payments || {};
      var successful = payments.successful || { count: 0, amount: 0 };
      var pending = payments.pending || { count: 0, amount: 0 };
      var failed = payments.failed || { count: 0, amount: 0 };
      var refunded = payments.refunded || { count: 0, amount: 0 };
      setText('finPaySuccessful', (successful.count || 0) + ' · ' + money(successful.amount) + ' ETB');
      setText('finPayPending', (pending.count || 0) + ' · ' + money(pending.amount) + ' ETB');
      setText('finPayFailed', (failed.count || 0) + ' · ' + money(failed.amount) + ' ETB');
      setText('finPayRefunded', (refunded.count || 0) + ' · ' + money(refunded.amount) + ' ETB');

      /* ---- revenue by food item ---- */
      var foodBody = document.getElementById('finFoodRevenueBody');
      var foodRows = report.revenueByFoodItem || [];
      foodBody.innerHTML = foodRows.length
        ? foodRows
            .map(function (f) {
              return (
                '<tr><td>' +
                esc(f.name) +
                '</td><td>' +
                (f.quantity || 0) +
                '</td><td><strong>' +
                money(f.revenue) +
                '</strong></td></tr>'
              );
            })
            .join('')
        : emptyRow(3, t('report_empty'));

      /* ---- revenue by order type ---- */
      var typeBody = document.getElementById('finOrderTypeRevenueBody');
      var typeRows = report.revenueByOrderType || [];
      typeBody.innerHTML = typeRows.length
        ? typeRows
            .map(function (o) {
              return (
                '<tr><td><strong>' +
                esc(o.label || o.type) +
                '</strong></td><td>' +
                (o.orders || 0) +
                '</td><td><strong>' +
                money(o.revenue) +
                '</strong></td></tr>'
              );
            })
            .join('')
        : emptyRow(3, t('report_empty'));

      /* ---- payment method breakdown ---- */
      var methodBody = document.getElementById('finPaymentMethodsBody');
      var methodRows = payments.byMethod || [];
      methodBody.innerHTML = methodRows.length
        ? methodRows
            .map(function (m) {
              return (
                '<tr><td>' +
                esc(m.label || m.method) +
                '</td><td>' +
                (m.count || 0) +
                '</td><td><strong>' +
                money(m.amount) +
                '</strong></td><td>' +
                (m.share || 0) +
                '%</td></tr>'
              );
            })
            .join('')
        : emptyRow(4, t('report_empty'));

      renderTrendChart(report.trends || {});
    } catch (error) {
      var message = (error && error.message) || 'Server error';
      var tbody = document.getElementById('finReconciliationBody');
      if (tbody) tbody.innerHTML = emptyRow(3, t('report_failed') + ': ' + message);
      if (window.AdminToast) window.AdminToast.error(message);
    }
  }

  function formatChange(value) {
    var n = Number(value);
    if (!isFinite(n)) return '0%';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  /* ============================================================
   * REVENUE TREND CHART
   * ============================================================ */
  function renderTrendChart(trends) {
    var canvas = document.getElementById('finTrendChart');
    var emptyEl = document.getElementById('finTrendChartEmpty');
    if (!canvas) return;
    destroyChart('trend');

    var rows = (trends && (trends[state.granularity] || trends.daily)) || [];
    if (!rows.length || typeof Chart === 'undefined') {
      canvas.classList.add('d-none');
      if (emptyEl) emptyEl.classList.remove('d-none');
      return;
    }
    canvas.classList.remove('d-none');
    if (emptyEl) emptyEl.classList.add('d-none');

    var yearView = state.period === 'year';
    var chartType = yearView ? 'line' : 'bar';
    var revData = rows.map(function (r) {
      return r.netCollected !== undefined ? r.netCollected : (Number(r.collections) || 0) - (Number(r.refunds) || 0);
    });
    var revCtx = canvas.getContext('2d');
    charts.trend = new Chart(revCtx, {
      type: chartType,
      data: {
        labels: rows.map(function (r) {
          return r.label || r.date;
        }),
        datasets: [
          yearView
            ? {
                label: t('revenue_collections'),
                data: revData,
                borderColor: '#4f46e5',
                backgroundColor: 'rgba(79,70,229,0.12)',
                tension: 0.3,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBackgroundColor: '#4f46e5',
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                fill: true,
                borderWidth: 3,
              }
            : {
                label: t('revenue_collections'),
                data: revData,
                backgroundColor: 'rgba(79,70,229,0.85)',
                borderColor: '#4f46e5',
                borderWidth: 1,
                borderRadius: 6,
                maxBarThickness: 48,
              },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'x',
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          title: { display: true, text: t('revenue_trends'), font: { size: 14, weight: 'bold' }, color: '#334155' },
          legend: { position: 'bottom', labels: { usePointStyle: true, padding: 16 } },
          tooltip: {
            backgroundColor: 'rgba(15,23,42,0.9)',
            padding: 12,
            cornerRadius: 8,
            titleFont: { weight: 'bold' },
            callbacks: {
              title: function (items) {
                return items && items.length ? items[0].label : '';
              },
              label: function (ctx) {
                return t('revenue_collections') + ': ' + Number(ctx.parsed.y).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ETB';
              },
              footer: function (items) {
                var period = rows && items && items.length ? (rows[items[0].dataIndex].label || rows[items[0].dataIndex].date) : '';
                return period ? 'Period: ' + period : '';
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: 'Date / Reporting Period' }, grid: { display: false }, ticks: { maxRotation: 45, autoSkip: true } },
          y: { beginAtZero: true, title: { display: true, text: 'Revenue (ETB)' }, grid: { color: 'rgba(148,163,184,0.15)' }, ticks: { callback: function (v) { return Number(v).toLocaleString('en-US'); } } },
        },
      },
    });
  }


  /* ============================================================
   * TABS
   * ============================================================ */
  var LOADERS = {
    financial: loadFinance,
    analytics: loadFinance,
  };

  function loadActiveTab() {
    var loader = LOADERS[state.tab];
    if (loader) loader();
  }

  function switchTab(name) {
    if (!LOADERS[name]) name = 'financial';
    state.tab = name;
    Object.keys(LOADERS).forEach(function (key) {
      var section = document.getElementById('financeView-' + key);
      if (section) section.classList.toggle('d-none', key !== name);
    });
    document.querySelectorAll('#financeTabs .report-tab-btn').forEach(function (btn) {
      var active = btn.getAttribute('data-report-tab') === name;
      btn.classList.toggle('btn-primary', active);
      btn.classList.toggle('btn-secondary', !active);
      btn.classList.toggle('active', active);
    });
    loadActiveTab();
  }

  function exportCsv() {
    if (!state.finance) {
      if (window.AdminToast) window.AdminToast.error('No report data to export yet');
      return;
    }
    downloadCsv(
      'smart-cafeteria-financial-report-' + new Date().toISOString().split('T')[0] + '.csv',
      buildFinancialExport(state.finance)
    );
  }

  /* ============================================================
   * EVENTS
   * ============================================================ */
  function bindEvents() {
    var periodSelect = document.getElementById('finPeriodSelect');
    if (periodSelect) {
      periodSelect.addEventListener('change', function () {
        syncPeriodInputs();
        state.period = periodSelect.value;
        if (periodSelect.value === 'custom') {
          if (window.ScosReportPeriod) {
            window.ScosReportPeriod.fillCustomDefaults('finStartDate', 'finEndDate');
          }
          return;
        }
        if (periodSelect.value === 'month') state.granularity = 'daily';
        if (periodSelect.value === 'year') state.granularity = 'monthly';
        document.querySelectorAll('#finTrendGranularity [data-granularity]').forEach(function (other) {
          var active = other.getAttribute('data-granularity') === state.granularity;
          other.classList.toggle('btn-primary', active);
          other.classList.toggle('btn-secondary', !active);
        });
        loadActiveTab();
      });
    }

    var applyBtn = document.getElementById('finApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', loadActiveTab);

    document.querySelectorAll('#financeTabs .report-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.getAttribute('data-report-tab'));
      });
    });

    document.querySelectorAll('#finTrendGranularity [data-granularity]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.granularity = btn.getAttribute('data-granularity');
        document.querySelectorAll('#finTrendGranularity [data-granularity]').forEach(function (other) {
          var active = other === btn;
          other.classList.toggle('btn-primary', active);
          other.classList.toggle('btn-secondary', !active);
        });
        if (state.finance) renderTrendChart(state.finance.trends || {});
      });

    });
  }

  function init() {
    syncPeriodInputs();
    if (window.ScosReportPeriod) {
      window.ScosReportPeriod.fillCustomDefaults('finStartDate', 'finEndDate');
    }
    var periodSelect = document.getElementById('finPeriodSelect');
    if (periodSelect && periodSelect.value) state.period = periodSelect.value;
    bindEvents();

    var refreshBtn = document.getElementById('refreshRevenueBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadActiveTab);

    var exportBtn = document.getElementById('exportRevenueBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportCsv);

    var hash = window.location.hash.replace('#', '');
    switchTab(LOADERS[hash] ? hash : 'financial');

    window.addEventListener('hashchange', function () {
      var h = window.location.hash.replace('#', '');
      if (LOADERS[h] && state.tab !== h) switchTab(h);
    });

    window.addEventListener('languageChanged', loadActiveTab);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
