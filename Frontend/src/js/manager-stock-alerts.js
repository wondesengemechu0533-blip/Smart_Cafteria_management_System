/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - MANAGER STOCK ALERTS
   ==========================================================================
   Cafeteria Manager page logic for kitchen stock issue reports:
     - GET   /kitchen/stock-alerts          → cafeteria-scoped list (backend enforces)
     - PATCH /kitchen/stock-alerts/:id/acknowledge → active → acknowledged (+ assignment note)
     - PATCH /kitchen/stock-alerts/:id/resolve     → acknowledged → resolved (+ resolution note)

   Requires window.AdminAPI (admin-api.js) + admin-layout.js loaded first.
   Manager identity / cafeteria are NEVER sent from here - the backend takes
   them from the authenticated JWT and tenancy-scopes the data per cafeteria.
   Real-time: `stock:alert` (new report) / `stock:alert:updated` (status
   change) refresh the list without a manual reload.
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

  var STATUS_KEYS = {
    active: 'status_active_filter',
    acknowledged: 'status_acknowledged_filter',
    resolved: 'status_resolved_filter',
    cancelled: 'status_cancelled_filter',
  };
  var TYPE_KEYS = {
    out_of_stock: 'stock_out_of_stock',
    low_stock: 'stock_low_stock',
    ingredient_shortage: 'ingredient_shortage',
    quality_issue: 'quality_issue',
  };
  var PRIORITY_KEYS = {
    low: 'severity_low',
    medium: 'severity_medium',
    high: 'severity_high',
    critical: 'severity_critical',
  };

  function statusLabel(status) {
    var key = STATUS_KEYS[status];
    return key ? tr(key, status) : (status || '—');
  }

  function typeLabel(type) {
    var fallbacks = {
      out_of_stock: 'Out of Stock',
      low_stock: 'Low Stock',
      ingredient_shortage: 'Ingredient Shortage',
      quality_issue: 'Quality Issue',
    };
    var key = TYPE_KEYS[type];
    return key ? tr(key, fallbacks[type] || type) : (type || '—');
  }

  function priorityLabel(priority) {
    var key = PRIORITY_KEYS[priority];
    var text = key ? tr(key, priority) : (priority || '—');
    return { text: text, raw: priority };
  }

  var allAlerts = [];
  var activeStatus = '';
  var selectedAlertId = null;
  var lastFocusRowBtn = null;

  function esc(v) {
    return window.AdminAPI.esc(v);
  }

  function statusBadge(status) {
    return '<span class="stock-status-badge stock-status-' + esc(status) + '">' + esc(statusLabel(status)) + '</span>';
  }

  function priorityBadge(priority) {
    var p = priorityLabel(priority);
    return '<span class="stock-priority-badge stock-priority-' + esc(p.raw) + '">' + esc(p.text) + '</span>';
  }

  function typeChip(type) {
    return '<span class="stock-type-chip">' + esc(typeLabel(type)) + '</span>';
  }

  function toast(type, message) {
    if (window.AdminToast && window.AdminToast[type]) window.AdminToast[type](message);
  }

  function errorOf(err, fallback) {
    if (err && err.message) return err.message;
    return fallback;
  }

  // ------------------------------------------------------------------
  // List
  // ------------------------------------------------------------------
  function updateCounts() {
    var counts = { active: 0, acknowledged: 0, resolved: 0 };
    allAlerts.forEach(function (a) {
      if (counts[a.status] !== undefined) counts[a.status]++;
    });
    var el;
    el = document.getElementById('countAll'); if (el) el.textContent = allAlerts.length;
    el = document.getElementById('countActive'); if (el) el.textContent = counts.active;
    el = document.getElementById('countAcknowledged'); if (el) el.textContent = counts.acknowledged;
    el = document.getElementById('countResolved'); if (el) el.textContent = counts.resolved;
  }

  function renderAlerts() {
    var tbody = document.getElementById('stockTableBody');
    if (!tbody) return;

    var rows = allAlerts.filter(function (a) {
      return !activeStatus || a.status === activeStatus;
    });

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="stock-empty">' +
        '<i class="fa-solid fa-triangle-exclamation"></i>' +
        esc(activeStatus
          ? tr('stock_empty_status', 'No {status} stock alerts.', { status: statusLabel(activeStatus) })
          : tr('stock_empty_cafeteria', 'No stock alerts for your cafeteria yet.')) +
        '</td></tr>';
      return;
    }

    var html = '';
    rows.forEach(function (alert) {
      var isReport = alert.source === 'report';
      var actionHtml = isReport
        ? '<button type="button" class="btn btn-sm btn-outline-primary" data-alert-id="' + esc(alert.id) + '">' +
          esc(tr('issue_view', 'View')) + '</button>'
        : '<span style="color:#9ca3af;font-size:0.8rem;">' + esc(tr('stock_inventory_auto', 'System')) + '</span>';
      html += '<tr' + (isReport ? '' : ' class="stock-source-inventory"') + '>'
        + '<td><strong>' + esc(alert.itemName) + '</strong></td>'
        + '<td>' + typeChip(alert.alertType) + '</td>'
        + '<td>' + priorityBadge(alert.severity) + '</td>'
        + '<td>' + esc(alert.reportedBy || '—') + '</td>'
        + '<td>' + statusBadge(alert.status) + '</td>'
        + '<td>' + esc(window.AdminAPI.formatDateTime(alert.createdAt)) + '</td>'
        + '<td>' + actionHtml + '</td>'
        + '</tr>';
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll('button[data-alert-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        lastFocusRowBtn = btn;
        openAlert(btn.getAttribute('data-alert-id'));
      });
    });
  }

  var alertsLoading = false;
  function setRefreshLoading(loading) {
    var btn = document.getElementById('refreshStockBtn');
    if (!btn) return;
    btn.disabled = loading;
    var icon = btn.querySelector('i');
    if (icon) icon.className = loading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate';
  }

  function loadAlerts(options) {
    options = options || {};
    var tbody = document.getElementById('stockTableBody');
    if (options.showLoading && tbody) {
      tbody.innerHTML = '<tr><td colspan="7" class="stock-loading">' +
        esc(tr('issue_loading', 'Loading stock alerts…')) + '</td></tr>';
    }
    if (options.fromRefresh) {
      if (alertsLoading) return Promise.resolve();
      alertsLoading = true;
      setRefreshLoading(true);
    }

    return window.AdminAPI.get('/kitchen/stock-alerts')
      .then(function (data) {
        allAlerts = (data && data.alerts) || [];
        updateCounts();
        renderAlerts();
        if (options.fromRefresh && window.AdminToast) {
          window.AdminToast.show(tr('admin_stock_refreshed', 'Stock alerts refreshed'));
        }
      })
      .catch(function (err) {
        if (tbody) {
          tbody.innerHTML =
            '<tr><td colspan="7" class="stock-empty stock-error">' +
            esc(tr('stock_load_failed_manage', 'Failed to load stock alerts: {error}', { error: errorOf(err, 'Unknown error') })) +
            '</td></tr>';
        }
        toast('error', errorOf(err, tr('issue_load_error', 'Could not load issue reports.')));
      })
      .finally(function () {
        if (options.fromRefresh) {
          alertsLoading = false;
          setRefreshLoading(false);
        }
      });
  }

  // ------------------------------------------------------------------
  // Details modal
  // ------------------------------------------------------------------
  function closeModal() {
    var backdrop = document.getElementById('stockModalBackdrop');
    if (backdrop) backdrop.classList.remove('active');
    selectedAlertId = null;
    if (lastFocusRowBtn && typeof lastFocusRowBtn.focus === 'function') {
      try { lastFocusRowBtn.focus(); } catch (e) { /* ignore */ }
    }
  }

  function renderModal(alert) {
    var content = document.getElementById('stockModalContent');
    if (!content) return;

    var isActive = alert.status === 'active';
    var isAcknowledged = alert.status === 'acknowledged';
    var isResolved = alert.status === 'resolved';
    var isCancelled = alert.status === 'cancelled';

    var html = '';
    html += '<h2>' + esc(alert.itemName) + '</h2>';
    html += '<div class="modal-meta">' + statusBadge(alert.status) + ' ' +
      priorityBadge(alert.severity) + ' ' + typeChip(alert.alertType) + '</div>';

    html += '<div class="detail-block"><h4>' + esc(tr('issue_title_description', 'Description')) +
      '</h4><p>' + esc(alert.reason) + '</p></div>';

    html += '<div class="detail-block"><h4>' + esc(tr('issue_title_reported_by', 'Reported By')) +
      '</h4><p>' +
      esc(alert.reportedBy || '—') + ' · ' + esc(window.AdminAPI.formatDateTime(alert.createdAt)) +
      '</p></div>';

    if (isAcknowledged || isResolved) {
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_acknowledged_by', 'Acknowledged By')) +
        '</h4><p>' + esc(alert.acknowledgedBy || '—') + '</p></div>';
    }
    if (alert.assignedNote) {
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_assigned_note', 'Assignment Note')) +
        '</h4><p>' + esc(alert.assignedNote) + '</p></div>';
    }

    if (isResolved) {
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_resolution', 'Resolution')) + '</h4>' +
        '<div class="solution-box">' + esc(alert.resolutionNote || '—') + '</div>' +
        '<div class="solution-meta">' +
        esc(tr('issue_by', 'By {name}', { name: alert.resolvedBy || tr('role_manager', 'Manager') })) +
        ' · ' + esc(window.AdminAPI.formatDateTime(alert.resolvedAt)) + '</div></div>';
    }

    if (isActive) {
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_acknowledge', 'Acknowledge & Take Responsibility')) +
        '</h4>' +
        '<input type="text" id="ackNoteInput" maxlength="500" placeholder="' +
        esc(tr('manager_stock_note_placeholder', 'Optional note — who is responsible and what will be done…')) + '">' +
        '<div class="form-error" id="ackError"></div>' +
        '</div>';
      html += '<div class="modal-actions">' +
        '<button type="button" class="btn btn-secondary" id="closeModalBtn2">' +
        esc(tr('issue_close', 'Close')) + '</button>' +
        '<button type="button" class="btn btn-primary" id="ackBtn">' +
        '<i class="fa-solid fa-user-check"></i> ' + esc(tr('manager_stock_acknowledge', 'Acknowledge & Take Responsibility')) + '</button>' +
        '</div>';
    } else if (isAcknowledged) {
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_mark_resolved', 'Mark as Resolved')) + '</h4>' +
        '<textarea id="resolutionInput" maxlength="2000" placeholder="' +
        esc(tr('manager_stock_resolution_placeholder', 'Describe how the issue was resolved…')) + '"></textarea>' +
        '<div class="form-error" id="resolutionError"></div>' +
        '</div>';
      html += '<div class="modal-actions">' +
        '<button type="button" class="btn btn-secondary" id="closeModalBtn2">' +
        esc(tr('issue_close', 'Close')) + '</button>' +
        '<button type="button" class="btn btn-primary" id="resolveBtn">' +
        '<i class="fa-solid fa-check"></i> ' + esc(tr('manager_stock_mark_resolved', 'Mark as Resolved')) + '</button>' +
        '</div>';
    } else {
      html += '<div class="modal-actions">' +
        '<button type="button" class="btn btn-secondary" id="closeModalBtn2">' +
        esc(tr('issue_close', 'Close')) + '</button>' +
        '</div>';
    }

    content.innerHTML = html;

    var closeBtn = document.getElementById('closeModalBtn2');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    var ackBtn = document.getElementById('ackBtn');
    if (ackBtn) ackBtn.addEventListener('click', function () { acknowledgeAlert(alert.id, ackBtn); });

    var resolveBtn = document.getElementById('resolveBtn');
    if (resolveBtn) resolveBtn.addEventListener('click', function () { resolveAlert(alert.id, resolveBtn); });
  }

  function openAlert(alertId) {
    selectedAlertId = alertId;
    var backdrop = document.getElementById('stockModalBackdrop');
    var content = document.getElementById('stockModalContent');
    if (backdrop) backdrop.classList.add('active');
    if (content) content.innerHTML = '<div class="stock-loading">' +
      esc(tr('issue_loading', 'Loading stock alerts…')) + '</div>';

    var cached = allAlerts.find(function (a) { return a.id === alertId; });
    if (cached && cached.source === 'report') {
      renderModal(cached);
      return;
    }
    toast('error', tr('stock_not_found', 'Stock alert not found'));
    closeModal();
  }

  function acknowledgeAlert(alertId, btn) {
    var noteInput = document.getElementById('ackNoteInput');
    var errorEl = document.getElementById('ackError');
    var note = noteInput ? noteInput.value.trim() : '';

    if (errorEl) errorEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = tr('issue_accepting', 'Submitting…'); }

    window.AdminAPI.patch('/kitchen/stock-alerts/' + encodeURIComponent(alertId) + '/acknowledge', { note: note })
      .then(function (data) {
        toast('success', (data && data.message) || tr('stock_ack_success', 'Alert acknowledged successfully'));
        loadAlerts().then(function () { openAlert(alertId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('stock_failed_ack', 'Failed to acknowledge alert')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-user-check"></i> ' + esc(tr('manager_stock_acknowledge', 'Acknowledge & Take Responsibility'));
        }
      });
  }

  function resolveAlert(alertId, btn) {
    var input = document.getElementById('resolutionInput');
    var errorEl = document.getElementById('resolutionError');
    var resolution = input ? input.value.trim() : '';

    if (!resolution) {
      if (errorEl) errorEl.textContent = tr('stock_resolution_empty', 'Resolution note cannot be empty.');
      if (input) input.focus();
      return;
    }
    if (errorEl) errorEl.textContent = '';

    if (btn) { btn.disabled = true; btn.textContent = tr('issue_sending', 'Sending…'); }

    window.AdminAPI.patch('/kitchen/stock-alerts/' + encodeURIComponent(alertId) + '/resolve', { resolutionNote: resolution })
      .then(function (data) {
        toast('success', (data && data.message) || tr('stock_resolve_success', 'Alert marked as resolved'));
        loadAlerts().then(function () { openAlert(alertId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('stock_failed_resolve', 'Failed to resolve alert')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-check"></i> ' + esc(tr('manager_stock_mark_resolved', 'Mark as Resolved'));
        }
      });
  }

  // ------------------------------------------------------------------
  // Real-time: new reports / status changes arrive without a page reload
  // ------------------------------------------------------------------
  function initRealtime() {
    var token = localStorage.getItem('auth_token');
    if (!token) return;

    var connect = function () {
      import('/src/js/socket.js')
        .then(function (mod) {
          var socketClient = mod.socketClient;
          if (typeof io === 'undefined') return;
          socketClient.connect(token);
          // New report → refresh list. The in-app notification toast is shown
          // by admin-layout's notification popup, so no extra toast here.
          socketClient.on('stock:alert', function () { loadAlerts(); });
          // Status change on any alert (acknowledge/resolve) → refresh list.
          socketClient.on('stock:alert:updated', function () { loadAlerts(); });
        })
        .catch(function () { /* polling fallback below */ });
    };

    if (typeof io === 'undefined') {
      var script = document.createElement('script');
      script.src = '/public/assets/vendor/js/socket.io-4.7.5.min.js';
      script.onload = connect;
      script.onerror = function () { /* polling fallback */ };
      document.head.appendChild(script);
    } else {
      connect();
    }
  }

  function init() {
    var refreshBtn = document.getElementById('refreshStockBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadAlerts({ showLoading: true, fromRefresh: true });
      });
    }

    var tabs = document.querySelectorAll('#stockTabs .stock-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        activeStatus = tab.getAttribute('data-status') || '';
        renderAlerts();
      });
    });

    var backdrop = document.getElementById('stockModalBackdrop');
    if (backdrop) {
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) closeModal();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeModal();
    });

    var rerender = function () {
      updateCounts();
      renderAlerts();
    };
    var register = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
    if (typeof register === 'function') register(rerender);
    else window.addEventListener('language:changed', rerender);

    loadAlerts({ showLoading: true });
    initRealtime();

    if (window.__managerStockTimer) clearInterval(window.__managerStockTimer);
    window.__managerStockTimer = setInterval(function () { loadAlerts(); }, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();