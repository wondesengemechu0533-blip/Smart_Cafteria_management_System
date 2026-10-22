/**
 * ==========================================================================
 *   SMART CAFETERIA ORDERING SYSTEM - SHARED REPORT PERIOD CONTROLS
 * ==========================================================================
 * The Reports & Analytics page and the Revenue / System Analytics page both
 * need the same period filter (Today / Yesterday / Last 7 Days / Last 30 Days /
 * This Month / Custom Date Range) and the same "what range did the server
 * actually use?" display.
 *
 * The period is resolved SERVER-SIDE (Africa/Addis_Ababa calendar days), so
 * the client only sends `period` (plus the two dates for a custom range) and
 * renders the range the API reports back. The client never computes its own
 * boundaries - that is what used to make two pages disagree about the period
 * they were showing.
 * ========================================================================== */
(function (global) {
  'use strict';

  var PERIODS = ['today', 'yesterday', 'last7', 'last30', 'last90', 'month', 'year', 'custom'];

  var LABELS = {
    today: 'Today',
    yesterday: 'Yesterday',
    last7: 'Last 7 Days',
    last30: 'Last 30 Days',
    last90: 'Last 90 Days',
    month: 'This Month',
    year: 'This Year',
    custom: 'Custom Date Range',
  };

  function el(id) {
    return id ? document.getElementById(id) : null;
  }

  function fieldValue(id, fallback) {
    var node = el(id);
    if (!node) return fallback;
    return node.value !== undefined && node.value !== '' ? node.value : fallback;
  }

  /**
   * The query the API expects for the currently selected period.
   */
  function buildQuery(periodId, startId, endId) {
    var period = fieldValue(periodId, 'month');
    var params = { period: period };
    if (period === 'custom') {
      var start = fieldValue(startId, '');
      var end = fieldValue(endId, '');
      if (start) params.startDate = start;
      if (end) params.endDate = end;
    }
    return params;
  }

  /**
   * Enable the custom date inputs only while a custom range is selected.
   */
  function syncCustomInputs(periodId, startId, endId) {
    var isCustom = fieldValue(periodId, 'month') === 'custom';
    var start = el(startId);
    var end = el(endId);
    if (start) start.disabled = !isCustom;
    if (end) end.disabled = !isCustom;
  }

  function label(period) {
    return LABELS[period] || period || '';
  }

  /**
   * Parse a YYYY-MM-DD as a LOCAL calendar date (never UTC), so a report for
   * 2026-10-01 is never rendered as 2026-09-30 in a negative-offset timezone.
   */
  function parseDate(value) {
    if (!value) return null;
    var raw = String(value);
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (match) {
      return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }
    var parsed = new Date(raw);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatDate(value) {
    var d = parseDate(value);
    if (!d) return '—';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /**
   * "Oct 1, 2026 - Oct 22, 2026" for the range the API resolved.
   */
  function formatRange(range) {
    if (!range || !range.startDate) return '';
    return formatDate(range.startDate) + ' - ' + formatDate(range.endDate);
  }

  function toInputValue(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  /**
   * Pre-fill the custom range with the last 30 days so the two inputs are
   * never blank when the user switches to "Custom Date Range".
   */
  function fillCustomDefaults(startId, endId) {
    var start = el(startId);
    var end = el(endId);
    if (!start || !end) return;
    if (start.value && end.value) return;
    var today = new Date();
    var from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
    start.value = toInputValue(from);
    end.value = toInputValue(today);
  }

  global.ScosReportPeriod = {
    PERIODS: PERIODS,
    LABELS: LABELS,
    buildQuery: buildQuery,
    syncCustomInputs: syncCustomInputs,
    label: label,
    formatDate: formatDate,
    formatRange: formatRange,
    parseDate: parseDate,
    toInputValue: toInputValue,
    fillCustomDefaults: fillCustomDefaults,
  };
})(typeof window !== 'undefined' ? window : globalThis);
