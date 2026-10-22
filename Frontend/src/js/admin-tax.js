function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - TAX / VAT
 * ================================================================
 * Driver for pages/admin/tax.html - the TAX COMPLIANCE page.
 *
 * This page answers tax questions only:
 *   what VAT rate is configured, how much was taxable, how much VAT was
 *   collected, how much was refunded, how much is retained, how many
 *   taxable transactions there are, and what every single transaction
 *   contributed.
 *
 * It deliberately shows NO financial dashboard: gross sales, food subtotal,
 * service fees, delivery fees, payment collections and average order value
 * belong to the Revenue / System Analytics page (revenue.html).
 *
 * Endpoint:
 *   GET /reports/tax   period | startDate | endDate | limit
 *
 * Every figure is computed on the server from the stored Order / Payment /
 * Refund records and the CONFIGURED tax settings, in the
 * Africa/Addis_Ababa reporting timezone.
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

  function statusVariant(status) {
    var s = String(status || '').toUpperCase();
    var map = {
      PAID: 'cmp',
      COMPLETED: 'cmp',
      REFUNDED: 'rfnd',
      REFUND_REQUESTED: 'rfnd',
      REFUND_APPROVED: 'rfnd',
      PENDING: 'pend',
      PROCESSING: 'prep',
      FAILED: 'cxl',
      REJECTED: 'cxl',
      CANCELLED: 'cxl',
    };
    return map[s] || 'muted';
  }

  function badge(status) {
    if (!status || status === 'NONE') return '<span class="order-badge muted">—</span>';
    return (
      '<span class="order-badge ' + statusVariant(status) + '">' + esc(String(status).toUpperCase()) + '</span>'
    );
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
    granularity: 'daily',
    report: null,
  };

  var charts = {};

  function destroyChart(key) {
    if (charts[key]) {
      charts[key].destroy();
      charts[key] = null;
    }
  }

  /* ============================================================
   * PERIOD FILTER (own controls - this page is independent)
   * ============================================================ */
  function periodQuery() {
    if (!window.ScosReportPeriod) return { period: 'month' };
    return window.ScosReportPeriod.buildQuery('taxPeriodSelect', 'taxStartDate', 'taxEndDate');
  }

  function syncPeriodInputs() {
    if (window.ScosReportPeriod) {
      window.ScosReportPeriod.syncCustomInputs('taxPeriodSelect', 'taxStartDate', 'taxEndDate');
    }
  }

  function setUpdated(range, period) {
    var el = document.getElementById('taxUpdatedAt');
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
   * TREND CHART
   * ============================================================ */
  function renderTrendChart(trends) {
    var canvas = document.getElementById('taxTrendChart');
    var emptyEl = document.getElementById('taxTrendChartEmpty');
    if (!canvas) return;
    destroyChart('taxTrend');

    var rows = (trends && trends[state.granularity]) || [];
    if (!rows.length || typeof Chart === 'undefined') {
      canvas.classList.add('d-none');
      if (emptyEl) emptyEl.classList.remove('d-none');
      return;
    }
    canvas.classList.remove('d-none');
    if (emptyEl) emptyEl.classList.add('d-none');

    var taxCtx = canvas.getContext('2d');
    charts.taxTrend = new Chart(taxCtx, {
      type: 'bar',
      data: {
        labels: rows.map(function (r) {
          return r.label || r.date;
        }),
        datasets: [
          {
            label: t('tax_vat_collected'),
            data: rows.map(function (r) {
              return r.vatCollected !== undefined ? r.vatCollected : 0;
            }),
            backgroundColor: 'rgba(34,197,94,0.85)',
            borderColor: '#22c55e',
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
          title: { display: true, text: t('tax_trends'), font: { size: 14, weight: 'bold' }, color: '#334155' },
          legend: { display: true, position: 'bottom', labels: { usePointStyle: true, padding: 16 } },
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
                var row = rows[ctx.dataIndex] || {};
                var rate = row.vatRate || (state.report && state.report.tax ? state.report.tax.configuredVatRate : 0) || 0;
                return t('tax_vat_collected') + ': ' + Number(ctx.parsed.y).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ETB (rate ' + rate + '%)';
              },
              afterLabel: function (ctx) {
                var row = rows[ctx.dataIndex] || {};
                var taxable = row.taxableSales !== undefined ? row.taxableSales : (row.taxableBase || 0);
                return 'Taxable amount: ' + Number(taxable).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ETB';
              },
            },
          },
        },
        scales: {
          x: { title: { display: true, text: 'Date / Reporting Period' }, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, title: { display: true, text: 'VAT (ETB)' }, grid: { color: 'rgba(148,163,184,0.15)' }, ticks: { callback: function (v) { return Number(v).toLocaleString('en-US'); } } },
        },
      },
    });
  }

  /* ============================================================
   * REPORT
   * ============================================================ */
  function buildExportRows(report) {
    var tax = report.tax || {};
    var rows = [];
    rows.push(['Smart Cafeteria - VAT / Tax Compliance Report']);
    rows.push(['Period', window.ScosReportPeriod ? window.ScosReportPeriod.label(report.period) : report.period]);
    rows.push(['Range', report.range ? report.range.startDate + ' to ' + report.range.endDate : '']);
    rows.push(['Tax authority', tax.taxAuthorityName || '']);
    rows.push(['VAT number', tax.vatNumber || '']);
    rows.push(['Configured VAT rate (%)', tax.configuredVatRate || 0]);
    rows.push(['Generated', new Date().toLocaleString()]);
    rows.push([]);
    rows.push(['Taxable sales (ETB)', report.taxableSales]);
    rows.push(['VAT collected (ETB)', report.vatCollected]);
    rows.push(['VAT refunded (ETB)', report.vatRefunded]);
    rows.push(['Net VAT retained (ETB)', report.netVatRetained]);
    rows.push(['Taxable transactions', report.transactionCount]);
    rows.push([]);
    rows.push(['Monthly breakdown']);
    rows.push(['Month', 'Taxable sales', 'VAT collected', 'VAT refunded', 'Net VAT retained', 'Transactions']);
    (report.monthlyBreakdown || []).forEach(function (m) {
      rows.push([
        m.month,
        m.taxableSales,
        m.vatCollected,
        m.vatRefunded,
        m.netVatRetained,
        m.transactions,
      ]);
    });
    rows.push([]);
    rows.push(['VAT transaction details']);
    rows.push([
      'Order',
      'Date',
      'Type',
      'Taxable amount (ETB)',
      'VAT rate (%)',
      'VAT amount (ETB)',
      'VAT refunded (ETB)',
      'Net VAT (ETB)',
      'Payment status',
      'Refund status',
    ]);
    (report.transactions || []).forEach(function (tx) {
      rows.push([
        tx.orderId,
        tx.date,
        tx.orderType,
        tx.taxableBase,
        tx.vatRate,
        tx.vatAmount,
        tx.vatRefunded,
        tx.netVat,
        tx.paymentStatus,
        tx.refundStatus,
      ]);
    });
    return rows;
  }

  async function loadTaxReport() {
    try {
      var data = await window.AdminAPI.get('/reports/tax', periodQuery());
      var report = data.report || {};
      state.report = report;

      setUpdated(report.range, report.period);

      var tax = report.tax || {};
      setText('taxConfiguredRate', (tax.configuredVatRate || 0) + '%');
      setMoney('taxTaxableSales', report.taxableSales);
      setMoney('taxVatCollected', report.vatCollected);
      setMoney('taxVatRefunded', report.vatRefunded);
      setMoney('taxNetVatRetained', report.netVatRetained);
      setText('taxTransactionCount', report.transactionCount || 0);

      var authority = document.getElementById('taxAuthorityName');
      if (authority) {
        authority.textContent = tax.taxAuthorityName
          ? tax.taxAuthorityName + (tax.vatNumber ? ' · ' + tax.vatNumber : '')
          : '';
      }

      renderTrendChart(report.trends || {});

      var monthlyBody = document.getElementById('taxMonthlyBody');
      var months = report.monthlyBreakdown || [];
      monthlyBody.innerHTML = months.length
        ? months
            .map(function (m) {
              return (
                '<tr><td><strong>' +
                esc(m.month) +
                '</strong></td><td>' +
                money(m.taxableSales) +
                '</td><td>' +
                money(m.vatCollected) +
                '</td><td>' +
                money(m.vatRefunded) +
                '</td><td><strong>' +
                money(m.netVatRetained) +
                '</strong></td><td>' +
                (m.transactions || 0) +
                '</td></tr>'
              );
            })
            .join('')
        : emptyRow(6, t('report_empty'));

      var txBody = document.getElementById('taxTransactionsBody');
      var transactions = report.transactions || [];
      txBody.innerHTML = transactions.length
        ? transactions
            .map(function (tx) {
              return (
                '<tr>' +
                '<td class="mono-ref">' +
                esc(tx.orderId || '-') +
                '</td>' +
                '<td>' +
                esc(tx.date || '-') +
                '</td>' +
                '<td>' +
                esc(tx.orderType || '-') +
                '</td>' +
                '<td>' +
                money(tx.taxableBase) +
                '</td>' +
                '<td>' +
                (tx.vatRate || 0) +
                '%</td>' +
                '<td><strong>' +
                money(tx.vatAmount) +
                '</strong></td>' +
                '<td>' +
                badge(tx.paymentStatus) +
                '</td>' +
                '<td>' +
                badge(tx.refundStatus) +
                '</td>' +
                '</tr>'
              );
            })
            .join('')
        : emptyRow(8, t('report_empty'));

      var note = document.getElementById('taxTransactionsNote');
      if (note) {
        note.textContent = report.transactionsTruncated
          ? t('tax_transactions_truncated').replace('{shown}', transactions.length).replace('{total}', report.totalTransactions)
          : t('tax_transactions_shown').replace('{total}', report.transactionCount);
      }
    } catch (error) {
      var message = (error && error.message) || 'Server error';
      var tbody = document.getElementById('taxTransactionsBody');
      if (tbody) tbody.innerHTML = emptyRow(8, t('report_failed') + ': ' + message);
      if (window.AdminToast) window.AdminToast.error(message);
    }
  }

  /* ============================================================
   * EXPORT
   * ============================================================ */
  function exportCsv() {
    if (!state.report) {
      if (window.AdminToast) window.AdminToast.error('No tax data to export yet');
      return;
    }
    downloadCsv(
      'smart-cafeteria-tax-report-' + new Date().toISOString().split('T')[0] + '.csv',
      buildExportRows(state.report)
    );
  }

  /* ============================================================
   * EVENTS
   * ============================================================ */
  function bindEvents() {
    var periodSelect = document.getElementById('taxPeriodSelect');
    if (periodSelect) {
      periodSelect.addEventListener('change', function () {
        syncPeriodInputs();
        if (periodSelect.value === 'custom') {
          if (window.ScosReportPeriod) {
            window.ScosReportPeriod.fillCustomDefaults('taxStartDate', 'taxEndDate');
          }
          return;
        }
        if (periodSelect.value === 'month') state.granularity = 'daily';
        if (periodSelect.value === 'year') state.granularity = 'monthly';
        document.querySelectorAll('#taxTrendGranularity [data-granularity]').forEach(function (other) {
          var active = other.getAttribute('data-granularity') === state.granularity;
          other.classList.toggle('btn-primary', active);
          other.classList.toggle('btn-secondary', !active);
        });
        loadTaxReport();
      });
    }

    var applyBtn = document.getElementById('taxApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', loadTaxReport);

    document.querySelectorAll('#taxTrendGranularity [data-granularity]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.granularity = btn.getAttribute('data-granularity');
        document.querySelectorAll('#taxTrendGranularity [data-granularity]').forEach(function (other) {
          var active = other === btn;
          other.classList.toggle('btn-primary', active);
          other.classList.toggle('btn-secondary', !active);
        });
        if (state.report) renderTrendChart(state.report.trends || {});
      });
    });

    var exportTaxBtn = document.getElementById('exportTaxCsvBtn');
    if (exportTaxBtn) exportTaxBtn.addEventListener('click', exportCsv);
  }

  function init() {
    syncPeriodInputs();
    if (window.ScosReportPeriod) {
      window.ScosReportPeriod.fillCustomDefaults('taxStartDate', 'taxEndDate');
    }
    var periodSelect = document.getElementById('taxPeriodSelect');
    if (periodSelect && periodSelect.value === 'year') state.granularity = 'monthly';
    else state.granularity = 'daily';
    bindEvents();

    var refreshBtn = document.getElementById('refreshTaxBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadTaxReport);

    var exportBtn = document.getElementById('exportTaxBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportCsv);

    loadTaxReport();

    window.addEventListener('languageChanged', loadTaxReport);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
