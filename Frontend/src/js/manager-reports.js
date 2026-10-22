function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - REPORTS & ANALYTICS
 * ================================================================
 * Driver for pages/admin/reports.html - the OPERATIONAL report page.
 *
 * This page answers operational questions:
 *   how many orders were placed / completed / cancelled / are pending,
 *   how many payments succeeded / failed / are pending,
 *   how the orders are spread over the fulfilment statuses and the order
 *   types (dine-in / takeaway / delivery), which foods are popular and how
 *   the order volume moved over the period.
 *
 * The FINANCIAL report (revenue, collections, VAT) lives on its own page -
 * pages/admin/revenue.html - so the two pages never show the same cards.
 *
 * Endpoints:
 *   summary    GET /admin/reports/summary      (system roles)
 *              GET /cafeteria/reports/summary  (cafeteria roles)
 *   orders     GET /cafeteria/reports/orders
 *   payments   GET /cafeteria/reports/payments
 *   sales      GET /cafeteria/reports/sales
 *   refunds    GET /cafeteria/reports/refunds
 *   menu       GET /cafeteria/reports/menu-performance
 *   inventory  GET /cafeteria/reports/inventory
 *
 * The cafeteria scope and the period boundaries are resolved on the server,
 * so the numbers always match the range the API reports back.
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
    // Fallback: roles.js is normally loaded by admin-layout.js, but the page
    // must still pick the right scope (cafeteria vs system) if it is missing.
    var raw = localStorage.getItem('userRole') || localStorage.getItem('role') || '';
    return String(raw || '').trim().toLowerCase();
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
  // This is the Cafeteria Manager reports page: it is always scoped to the
  // manager's cafeteria and exposes the cafeteria operational tabs.
  var role = 'manager';
  var isCafeteria = true;

  /* ============================================================
   * PERIOD FILTER (shared with the Revenue / System Analytics page)
   * ============================================================ */
  function periodQuery(extra) {
    var params = window.ScosReportPeriod
      ? window.ScosReportPeriod.buildQuery('reportPeriodSelect', 'reportStartDate', 'reportEndDate')
      : { period: 'month' };
    if (extra) {
      for (var key in extra) {
        if (extra[key] !== undefined && extra[key] !== null && extra[key] !== '') params[key] = extra[key];
      }
    }
    return params;
  }

  function syncPeriodInputs() {
    if (window.ScosReportPeriod) {
      window.ScosReportPeriod.syncCustomInputs('reportPeriodSelect', 'reportStartDate', 'reportEndDate');
    }
  }

  function setUpdated(range, labelText) {
    var el = document.getElementById('reportUpdatedAt');
    if (!el) return;
    if (!range) {
      el.textContent = '';
      return;
    }
    var text = window.ScosReportPeriod ? window.ScosReportPeriod.formatRange(range) : '';
    var periodLabel = labelText || (window.ScosReportPeriod ? window.ScosReportPeriod.label(range.period) : '');
    el.textContent = (periodLabel ? periodLabel + ' · ' : '') + text;
  }

  /* ============================================================
   * CHARTS
   * ============================================================ */
  var charts = {};

  function destroyChart(key) {
    if (charts[key]) {
      charts[key].destroy();
      charts[key] = null;
    }
  }

  function renderStatusChart(rows) {
    var canvas = document.getElementById('opStatusChart');
    var emptyEl = document.getElementById('opStatusChartEmpty');
    if (!canvas) return;
    destroyChart('status');

    if (!rows.length || typeof Chart === 'undefined') {
      canvas.classList.add('d-none');
      if (emptyEl) emptyEl.classList.remove('d-none');
      return;
    }
    canvas.classList.remove('d-none');
    if (emptyEl) emptyEl.classList.add('d-none');

    var palette = ['#4f46e5', '#22c55e', '#f59e0b', '#06b6d4', '#ec4899', '#ef4444', '#8b5cf6', '#64748b'];
    charts.status = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: rows.map(function (r) {
          return r.status;
        }),
        datasets: [
          {
            data: rows.map(function (r) {
              return r.count;
            }),
            backgroundColor: rows.map(function (r, i) {
              return palette[i % palette.length];
            }),
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } },
      },
    });
  }

  function renderTrendsChart(rows) {
    var canvas = document.getElementById('opTrendsChart');
    var emptyEl = document.getElementById('opTrendsChartEmpty');
    if (!canvas) return;
    destroyChart('trends');

    if (!rows.length || typeof Chart === 'undefined') {
      canvas.classList.add('d-none');
      if (emptyEl) emptyEl.classList.remove('d-none');
      return;
    }
    canvas.classList.remove('d-none');
    if (emptyEl) emptyEl.classList.add('d-none');

    charts.trends = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: rows.map(function (r) {
          return r.date;
        }),
        datasets: [
          {
            label: t('report_op_trend_orders'),
            data: rows.map(function (r) {
              return r.orders;
            }),
            borderColor: '#4f46e5',
            backgroundColor: 'rgba(79,70,229,0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
          {
            label: t('report_op_trend_completed'),
            data: rows.map(function (r) {
              return r.completed;
            }),
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,0.12)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
          {
            label: t('report_op_trend_cancelled'),
            data: rows.map(function (r) {
              return r.cancelled;
            }),
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239,68,68,0.12)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }

  /* ============================================================
   * SUMMARY (operational)
   * ============================================================ */
  var summaryExport = null;

  function renderStatusTable(rows) {
    var tbody = document.getElementById('opStatusBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = emptyRow(3, t('report_empty'));
      return;
    }
    tbody.innerHTML = rows
      .map(function (row) {
        return (
          '<tr>' +
          '<td>' +
          badge(row.status) +
          '</td>' +
          '<td>' +
          (row.count || 0) +
          '</td>' +
          '<td>' +
          (row.share || 0) +
          '%</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderOrderTypes(rows) {
    var tbody = document.getElementById('opOrderTypesBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = emptyRow(4, t('report_empty'));
      return;
    }
    tbody.innerHTML = rows
      .map(function (row) {
        return (
          '<tr>' +
          '<td><strong>' +
          esc(row.label || row.type) +
          '</strong></td>' +
          '<td>' +
          (row.orders || 0) +
          '</td>' +
          '<td>' +
          (row.share || 0) +
          '%</td>' +
          '<td><strong>' +
          money(row.revenue) +
          ' ETB</strong></td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderMostOrderedFoods(rows) {
    var tbody = document.getElementById('opMostFoodsBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = emptyRow(6, t('report_empty'));
      return;
    }
    tbody.innerHTML = rows
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
          esc(food.category || '-') +
          '</td>' +
          '<td>' +
          (food.totalQuantity || 0) +
          '</td>' +
          '<td>' +
          (food.orderCount || 0) +
          '</td>' +
          '<td><strong>' +
          money(food.totalRevenue) +
          ' ETB</strong></td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderFoodPopularity(rows) {
    var tbody = document.getElementById('opFoodPopularityBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = emptyRow(5, t('report_empty'));
      return;
    }
    var total = rows.reduce(function (sum, row) {
      return sum + (row.totalQuantity || 0);
    }, 0);
    tbody.innerHTML = rows
      .map(function (row) {
        var share = total ? ((row.totalQuantity || 0) / total) * 100 : 0;
        return (
          '<tr>' +
          '<td>' +
          esc(row.name) +
          '</td>' +
          '<td>' +
          esc(row.category || '-') +
          '</td>' +
          '<td>' +
          (row.totalQuantity || 0) +
          '</td>' +
          '<td>' +
          (row.orderCount || 0) +
          '</td>' +
          '<td>' +
          share.toFixed(2) +
          '%</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  async function loadSummary() {
    var endpoint = isCafeteria ? '/cafeteria/reports/summary' : '/admin/reports/summary';
    try {
      var data = await window.AdminAPI.get(endpoint, periodQuery());
      var report = data.report || {};
      var orders = report.orders || {};
      var payments = report.payments || {};

      setUpdated(report.range, report.period);

      setText('opTotalOrders', orders.total || 0);
      setText('opCompletedOrders', orders.completed || 0);
      setText('opCancelledOrders', orders.cancelled || 0);
      setText('opPendingOrders', orders.pending || 0);
      setText('opInProgressOrders', orders.inProgress || 0);

      setText('opSuccessfulPayments', payments.successful || 0);
      setText('opFailedPayments', payments.failed || 0);
      setText('opPendingPayments', payments.pending || 0);
      setText('opRefundedPayments', payments.refunded || 0);

      var statusRows = report.statusDistribution || [];
      renderStatusChart(statusRows);
      renderStatusTable(statusRows);
      renderOrderTypes(report.orderTypes || []);
      renderTrendsChart(report.trends || []);
      renderMostOrderedFoods(report.mostOrderedFoods || []);
      renderFoodPopularity(report.foodPopularity || []);

      summaryExport = {
        name: 'reports-operational-summary',
        rows: buildSummaryExport(report),
      };
    } catch (error) {
      var message = (error && error.message) || 'Server error';
      var tbody = document.getElementById('opMostFoodsBody');
      if (tbody) tbody.innerHTML = emptyRow(6, t('report_failed') + ': ' + message);
      if (window.AdminToast) window.AdminToast.error(message);
    }
  }

  function buildSummaryExport(report) {
    var orders = report.orders || {};
    var payments = report.payments || {};
    var rows = [];
    rows.push(['Smart Cafeteria - Operational Report']);
    rows.push(['Period', (window.ScosReportPeriod ? window.ScosReportPeriod.label(report.period) : report.period)]);
    rows.push([
      'Range',
      report.range ? report.range.startDate + ' to ' + report.range.endDate : '',
    ]);
    rows.push(['Generated', new Date().toLocaleString()]);
    rows.push([]);
    rows.push(['Orders']);
    rows.push(['Total Orders', orders.total || 0]);
    rows.push(['Completed Orders', orders.completed || 0]);
    rows.push(['Cancelled Orders', orders.cancelled || 0]);
    rows.push(['Pending Orders', orders.pending || 0]);
    rows.push(['In Progress Orders', orders.inProgress || 0]);
    rows.push([]);
    rows.push(['Payments']);
    rows.push(['Successful Payments', payments.successful || 0]);
    rows.push(['Failed Payments', payments.failed || 0]);
    rows.push(['Pending Payments', payments.pending || 0]);
    rows.push(['Refunded Payments', payments.refunded || 0]);
    rows.push([]);
    rows.push(['Order Status Distribution']);
    rows.push(['Status', 'Orders', 'Share %']);
    (report.statusDistribution || []).forEach(function (row) {
      rows.push([row.status, row.count, row.share]);
    });
    rows.push([]);
    rows.push(['Orders by Type']);
    rows.push(['Type', 'Orders', 'Share %', 'Value (ETB)']);
    (report.orderTypes || []).forEach(function (row) {
      rows.push([row.label || row.type, row.orders, row.share, row.revenue]);
    });
    rows.push([]);
    rows.push(['Most Ordered Foods']);
    rows.push(['Rank', 'Item', 'Category', 'Quantity Sold', 'Times Ordered', 'Value (ETB)']);
    (report.mostOrderedFoods || []).forEach(function (food, index) {
      rows.push([
        index + 1,
        food.name,
        food.category,
        food.totalQuantity,
        food.orderCount,
        food.totalRevenue,
      ]);
    });
    rows.push([]);
    rows.push(['Food Popularity & Quantity Sold']);
    rows.push(['Item', 'Category', 'Quantity Sold', 'Times Ordered']);
    (report.foodPopularity || []).forEach(function (food) {
      rows.push([food.name, food.category, food.totalQuantity, food.orderCount]);
    });
    return rows;
  }

  /* ============================================================
   * SALES (cafeteria only)
   * ============================================================ */
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

    charts.sales = new Chart(canvas.getContext('2d'), {
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
      var data = await window.AdminAPI.get('/cafeteria/reports/sales', periodQuery());
      var r = data.report;
      setUpdated(r.range, r.period);

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

  /* ============================================================
   * ORDERS
   * ============================================================ */
  async function loadCfOrders() {
    var tbody = document.getElementById('cfOrdersBody');
    try {
      var data = await window.AdminAPI.get(
        '/cafeteria/reports/orders',
        periodQuery({
          status: document.getElementById('cfOrderStatus').value,
          paymentStatus: document.getElementById('cfOrderPaymentStatus').value,
          page: cfState.ordersPage,
          limit: 20,
        })
      );
      var r = data.report;
      setUpdated(r.range, r.period);

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

  /* ============================================================
   * PAYMENTS
   * ============================================================ */
  async function loadCfPayments() {
    var tbody = document.getElementById('cfPaymentsBody');
    try {
      var data = await window.AdminAPI.get(
        '/cafeteria/reports/payments',
        periodQuery({
          status: document.getElementById('cfPayStatus').value,
          method: document.getElementById('cfPayMethod').value,
          page: cfState.paymentsPage,
          limit: 20,
        })
      );
      var r = data.report;
      setUpdated(r.range, r.period);

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

  /* ============================================================
   * REFUNDS (cafeteria only)
   * ============================================================ */
  async function loadCfRefunds() {
    var tbody = document.getElementById('cfRefundsBody');
    try {
      var data = await window.AdminAPI.get(
        '/cafeteria/reports/refunds',
        periodQuery({
          status: document.getElementById('cfRefStatus').value,
          page: cfState.refundsPage,
          limit: 20,
        })
      );
      var r = data.report;
      setUpdated(r.range, r.period);

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

  /* ============================================================
   * MENU PERFORMANCE (cafeteria only)
   * ============================================================ */
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
        periodQuery({ category: document.getElementById('cfMenuCategory').value })
      );
      var r = data.report;
      setUpdated(r.range, r.period);

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
   * INVENTORY (cafeteria only)
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
        tbody.innerHTML = emptyRow(7, t('report_empty'));
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
            return [
              i.name,
              i.category,
              i.price,
              i.stockQuantity,
              i.lowStockThreshold,
              i.outOfStock ? 'OUT OF STOCK' : i.lowStock ? 'LOW STOCK' : 'IN STOCK',
              i.price * i.stockQuantity,
            ];
          })
        ),
      };
    } catch (error) {
      cfFail('cfInvBody', 7, error);
    }
  }

  /* ============================================================
   * TABS
   * ============================================================ */
  var cfState = {
    tab: 'summary',
    ordersPage: 1,
    paymentsPage: 1,
    refundsPage: 1,
    menuCategoriesReady: false,
    export: null,
  };

  function cfFail(tbodyId, colspan, error) {
    var tbody = document.getElementById(tbodyId);
    if (tbody) tbody.innerHTML = emptyRow(colspan, t('report_failed') + ': ' + ((error && error.message) || ''));
    if (window.AdminToast) window.AdminToast.error((error && error.message) || tr('error_load_report', 'Failed to load report'));
  }

  var LOADERS = {
    summary: loadSummary,
    orders: loadCfOrders,
    payments: loadCfPayments,
    sales: loadCfSales,
    refunds: loadCfRefunds,
    menu: loadCfMenu,
    inventory: loadCfInventory,
  };

  var CAFETERIA_ONLY_TABS = ['sales', 'refunds', 'menu', 'inventory'];

  function loadActiveTab() {
    var loader = LOADERS[cfState.tab];
    if (loader) loader();
  }

  function switchTab(name) {
    if (!LOADERS[name]) name = 'summary';
    if (CAFETERIA_ONLY_TABS.indexOf(name) !== -1 && !isCafeteria) name = 'summary';
    cfState.tab = name;
    cfState.export = null;

    Object.keys(LOADERS).forEach(function (key) {
      var section = document.getElementById('reportView-' + key);
      if (section) section.classList.toggle('d-none', key !== name);
    });
    document.querySelectorAll('#reportTabs .report-tab-btn').forEach(function (btn) {
      var active = btn.getAttribute('data-report-tab') === name;
      btn.classList.toggle('btn-primary', active);
      btn.classList.toggle('btn-secondary', !active);
      btn.classList.toggle('active', active);
    });
    loadActiveTab();
  }

  function exportCsv() {
    if (cfState.tab === 'summary') {
      if (!summaryExport) {
        if (window.AdminToast) window.AdminToast.error('No report data to export yet');
        return;
      }
      downloadCsv(
        summaryExport.name + '-' + new Date().toISOString().split('T')[0] + '.csv',
        summaryExport.rows
      );
      return;
    }
    if (!cfState.export) {
      if (window.AdminToast) window.AdminToast.error('No report data to export yet');
      return;
    }
    downloadCsv(cfState.export.name + '-' + new Date().toISOString().split('T')[0] + '.csv', cfState.export.rows);
  }

  /* ============================================================
   * EVENTS
   * ============================================================ */
  function bindEvents() {
    var periodSelect = document.getElementById('reportPeriodSelect');
    if (periodSelect) {
      periodSelect.addEventListener('change', function () {
        syncPeriodInputs();
        if (periodSelect.value === 'custom') {
          if (window.ScosReportPeriod) {
            window.ScosReportPeriod.fillCustomDefaults('reportStartDate', 'reportEndDate');
          }
          return;
        }
        loadActiveTab();
      });
    }

    var applyBtn = document.getElementById('reportApplyBtn');
    if (applyBtn) applyBtn.addEventListener('click', loadActiveTab);

    document.querySelectorAll('#reportTabs .report-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.getAttribute('data-report-tab'));
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

  async function loadScopeName() {
    var el = document.getElementById('reportScopeName');
    if (!el) return;
    if (!isCafeteria) {
      el.textContent = t('report_scope_all_cafeterias');
      return;
    }
    try {
      var data = await window.AdminAPI.get('/cafeterias/mine');
      el.textContent = (data.cafeteria && data.cafeteria.name) || t('report_scope_default');
    } catch (error) {
      el.textContent = t('report_scope_default');
    }
  }

  function applyRoleVisibility() {
    document.querySelectorAll('#reportTabs .cafeteria-only').forEach(function (btn) {
      btn.classList.toggle('d-none', !isCafeteria);
    });
  }

  function init() {
    var content = document.getElementById('reportContent');
    if (content) content.classList.remove('d-none');

    applyRoleVisibility();
    syncPeriodInputs();
    if (window.ScosReportPeriod) {
      window.ScosReportPeriod.fillCustomDefaults('reportStartDate', 'reportEndDate');
    }
    bindEvents();
    loadScopeName();

    var refreshBtn = document.getElementById('refreshReportsBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadActiveTab);

    var exportBtn = document.getElementById('exportCsvBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportCsv);

    // Initial tab from the URL hash (e.g. reports.html#orders)
    var hash = window.location.hash.replace('#', '');
    switchTab(LOADERS[hash] ? hash : 'summary');

    window.addEventListener('hashchange', function () {
      var h = window.location.hash.replace('#', '');
      if (LOADERS[h] && cfState.tab !== h) switchTab(h);
    });

    window.addEventListener('languageChanged', function () {
      loadScopeName();
      loadActiveTab();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
