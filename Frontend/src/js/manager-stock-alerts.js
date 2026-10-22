/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - MANAGER STOCK ALERTS
   ==========================================================================
   Cafeteria Manager page logic for stock alerts:
      - GET   /kitchen/stock-alerts          → cafeteria-scoped list (system
        threshold alerts + kitchen issue reports; backend enforces)
       - PATCH /kitchen/stock-alerts/:id/acknowledge → active → acknowledged
       - PATCH /kitchen/stock-alerts/:id/resolve     → record actual resolution
         (Cafeteria Manager / Cafeteria Admin / System Admin may resolve - the
         backend allows all three; optional newStockQuantity records the real
         received amount)
      - POST  /kitchen/menu/:itemId/availability    → mark item unavailable

   Requires window.AdminAPI (admin-api.js) + admin-layout.js loaded first.
   Manager identity / cafeteria are NEVER sent from here - the backend takes
   them from the authenticated JWT and tenancy-scopes the data per cafeteria.
   Real-time: `stock:alert` / `stock:alert:updated` refresh the alert list.
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
  var allAlerts = [];
  var activeStatus = '';
  var selectedAlertId = null;
  var lastFocusRowBtn = null;
  var COLS = 8; // Item | Type | Current | Min | Severity | Status | Reported At | Actions

  // ------------------------------------------------------------------
  // Resolution permission: Cafeteria Manager, Cafeteria Admin, and System Admin may mark a
  // stock alert as resolved.
  var RESOLVER_ROLES = ['manager', 'cafeteria_admin', 'admin', 'system_admin'];

  function currentRole() {
    if (window.ScosRoles && window.ScosRoles.getCurrentRole) return window.ScosRoles.getCurrentRole();
    try {
      var cu = JSON.parse(localStorage.getItem('current_user') || 'null');
      if (cu && cu.role) return String(cu.role).toLowerCase();
    } catch (e) { /* ignore */ }
    return String(localStorage.getItem('userRole') || localStorage.getItem('role') || '').toLowerCase();
  }

  function canResolveAlerts() {
    var role = currentRole();
    if (window.ScosRoles && window.ScosRoles.normalizeRole) role = window.ScosRoles.normalizeRole(role);
    return RESOLVER_ROLES.indexOf(String(role).toLowerCase()) !== -1;
  }

  function esc(v) {
    return window.AdminAPI.esc(v);
  }

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

  function statusBadge(status) {
    return '<span class="stock-status-badge stock-status-' + esc(status) + '">' + esc(statusLabel(status)) + '</span>';
  }

  function priorityBadge(priority) {
    var fallbacks = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
    var text = priority ? tr('severity_' + priority, fallbacks[priority] || priority) : '—';
    return '<span class="stock-priority-badge stock-priority-' + esc(priority || 'low') + '">' + esc(text) + '</span>';
  }

  function typeChip(type) {
    return '<span class="stock-type-chip">' + esc(typeLabel(type)) + '</span>';
  }

  function qtyText(value, min) {
    if (value == null) return '—';
    var text = esc(value);
    if (min != null) text += ' <span class="qty-min">/ ' + esc(min) + '</span>';
    return text;
  }

  function toast(type, message) {
    if (window.AdminToast && window.AdminToast[type]) window.AdminToast[type](message);
  }

  function errorOf(err, fallback) {
    if (err && err.message) return err.message;
    return fallback;
  }

  // ------------------------------------------------------------------
  // In-flight guard: ONE mutating request per alert at a time. Disabling the
  // clicked button is not enough on its own - the modal can be re-rendered
  // mid-request (socket `stock:alert:updated`, closing and reopening the
  // alert), which hands the user a fresh, enabled button and used to fire a
  // duplicate PATCH.
  // ------------------------------------------------------------------
  var inFlight = {};

  // Fields the acknowledge/resolve responses confirm on the server; only these
  // are merged into the cached row (everything else stays list-sourced).
  var UPDATABLE_FIELDS = [
    'status', 'acknowledgedBy', 'assignedTo', 'assignedAt', 'assignedNote',
    'resolutionNote', 'resolutionReason', 'resolutionSolution',
    'resolutionQuantity', 'resolvedBy', 'resolvedAt',
  ];

  /**
   * Apply a backend-confirmed alert payload to the cached row and re-render the
   * table + detail modal immediately. This is what flips
   *   Take Responsibility → Mark Solved → Resolved
   * without a page refresh and without waiting for a follow-up list fetch: if
   * that fetch fails or is slow the modal is already in the right state.
   */
  function applyAlertUpdate(alertId, payload) {
    var cached = allAlerts.find(function (a) { return a.id === alertId; });
    if (!cached || !payload) return null;
    UPDATABLE_FIELDS.forEach(function (key) {
      if (payload[key] !== undefined) cached[key] = payload[key];
    });
    updateCounts();
    renderAlerts();
    if (selectedAlertId === alertId) renderModal(cached);
    return cached;
  }


  // ------------------------------------------------------------------
  // Alert list
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
        '<tr><td colspan="' + COLS + '" class="stock-empty">' +
        '<i class="fa-solid fa-triangle-exclamation"></i>' +
        esc(activeStatus
          ? tr('stock_empty_status', 'No {status} stock alerts.', { status: statusLabel(activeStatus) })
          : tr('stock_empty_cafeteria', 'No stock alerts for your cafeteria yet.')) +
        '</td></tr>';
      return;
    }

    var html = '';
    rows.forEach(function (alert) {
      var isInventory = alert.source === 'inventory';
      var viewBtn = '<button type="button" class="btn btn-sm btn-outline-primary" data-alert-id="' + esc(alert.id) + '">' +
        esc(tr('issue_view', 'View')) + '</button>';
      var sourceTag = isInventory
        ? ' <span class="source-chip source-inventory" title="' + esc(tr('stock_inventory_auto', 'System')) + '">' +
          '<i class="fa-solid fa-gears"></i></span>'
        : '';
      html += '<tr' + (isInventory ? ' class="stock-source-inventory"' : '') + '>'
        + '<td><strong>' + esc(alert.itemName) + '</strong>' + sourceTag + '</td>'
        + '<td>' + typeChip(alert.alertType) + '</td>'
        + '<td class="qty-cell">' + qtyText(alert.currentQuantity) + '</td>'
        + '<td class="qty-cell">' + (alert.minimumQuantity == null ? '—' : esc(alert.minimumQuantity)) + '</td>'
        + '<td>' + priorityBadge(alert.severity) + '</td>'
        + '<td>' + statusBadge(alert.status) + '</td>'
        + '<td>' + esc(window.AdminAPI.formatDateTime(alert.createdAt)) + '</td>'
        + '<td>' + viewBtn + '</td>'
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
      tbody.innerHTML = '<tr><td colspan="' + COLS + '" class="stock-loading">' +
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
            '<tr><td colspan="' + COLS + '" class="stock-empty stock-error">' +
            esc(tr('stock_load_failed_manage', 'Failed to load stock alerts: {error}', { error: errorOf(err, 'Unknown error') })) +
            '</td></tr>';
        }
        // Background refreshes (after a confirmed action) must not bury the
        // action's own success/error toast under a secondary fetch error.
        if (!options.silent) {
          toast('error', errorOf(err, tr('issue_load_error', 'Could not load issue reports.')));
        }
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
    var isOpen = isActive || isAcknowledged;
    var hasItem = !!alert.itemId;

    var html = '';
    html += '<h2>' + esc(alert.itemName) + '</h2>';
    html += '<div class="modal-meta">' + statusBadge(alert.status) + ' ' +
      priorityBadge(alert.severity) + ' ' + typeChip(alert.alertType) + '</div>';

    // Stock snapshot: current vs minimum threshold (from the live item).
    if (alert.currentQuantity != null || alert.minimumQuantity != null) {
      html += '<div class="detail-block"><h4>' + esc(tr('stock_item_label', 'Item')) + '</h4><p>' +
        esc(tr('stock_current_qty_label', 'Current quantity')) + ': <strong>' + qtyText(alert.currentQuantity) + '</strong>' +
        (alert.minimumQuantity != null
          ? ' &middot; ' + esc(tr('stock_min_qty_label', 'Minimum threshold')) + ': <strong>' + esc(alert.minimumQuantity) + '</strong>'
          : '') +
        (alert.stockStatus
          ? ' &middot; <strong>' + esc(alert.stockStatus === 'OUT_OF_STOCK' ? tr('stock_out_of_stock', 'Out of Stock') : tr('stock_low_stock', 'Low Stock')) + '</strong>'
          : '') +
        '</p></div>';
    }
    if (alert.qualityHold) {
      html += '<div class="detail-block"><div class="quality-hold-warning">' +
        '<i class="fa-solid fa-triangle-exclamation"></i> ' +
        esc(tr('quality_hold_warning', 'This item is on quality hold: it cannot be marked available until the quality issue is resolved.')) +
        '</div></div>';
    }

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
    // Take Responsibility persists the assignment (assignedTo/assignedAt) in
    // MongoDB - show who owns the alert while it is In Progress.
    if (alert.assignedTo) {
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_assigned_to', 'Assigned To')) +
        '</h4><p>' + esc(alert.assignedTo) +
        (alert.assignedAt ? ' · ' + esc(window.AdminAPI.formatDateTime(alert.assignedAt)) : '') +
        '</p></div>';
    }
    if (alert.assignedNote) {
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_assigned_note', 'Assignment Note')) +
        '</h4><p>' + esc(alert.assignedNote) + '</p></div>';
    }

    if (isResolved) {
      if (alert.resolutionReason) {
        html += '<div class="detail-block"><h4>' + esc(tr('resolution_reason_label', 'Resolution Reason')) + '</h4><p>' + esc(alert.resolutionReason) + '</p></div>';
      }
      if (alert.resolutionSolution) {
        html += '<div class="detail-block"><h4>' + esc(tr('resolution_solution_label', 'Solution / Corrective Action')) + '</h4><p>' + esc(alert.resolutionSolution) + '</p></div>';
      }
      if (alert.resolutionQuantity != null) {
        html += '<div class="detail-block"><h4>' + esc(tr('stock_updated_qty_label', 'Updated Stock Quantity')) + '</h4><p>' + esc(alert.resolutionQuantity) + '</p></div>';
      }
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_resolution', 'Resolution')) + '</h4>' +
        '<div class="solution-box">' + esc(alert.resolutionNote || '—') + '</div>' +
        '<div class="solution-meta">' +
        esc(tr('issue_by', 'By {name}', { name: alert.resolvedBy || tr('role_manager', 'Manager') })) +
        ' · ' + esc(window.AdminAPI.formatDateTime(alert.resolvedAt)) + '</div></div>';
    }

    // ---- Open-alert workflow: mark unavailable ----
    if (isOpen) {
      if (hasItem) {
        // Mark unavailable: safety net for stock-out / quality problems.
        html += '<div class="detail-block"><h4>' + esc(tr('stock_safety_title', 'Safety Actions')) + '</h4>' +
          '<button type="button" class="btn btn-outline-danger" id="markUnavailableBtn">' +
          '<i class="fa-solid fa-ban"></i> ' + esc(tr('stock_mark_unavailable', 'Mark Item Unavailable')) + '</button>' +
          '</div>';
      }
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
    } else if (isAcknowledged && canResolveAlerts()) {
      var resOpts = window.ScosResolution || {};
      var optionCategory = resOpts.categoryForStockAlert
        ? resOpts.categoryForStockAlert(alert.alertType)
        : 'stock';
      var reasonOpts = resOpts.reasonsFor
        ? resOpts.reasonsFor(optionCategory)
        : ['Out of Stock', 'Low Stock', 'Expired Items', 'Supplier Delay', 'Incorrect Stock Record', 'Other'];
      var solutionOpts = resOpts.solutionsFor
        ? resOpts.solutionsFor(optionCategory)
        : ['Restocked Items', 'Updated Stock Quantity', 'Ordered New Supplies', 'Removed Expired Items', 'Contacted Supplier', 'Corrected Inventory Record', 'Other'];
      html += '<div class="detail-block"><h4>' + esc(tr('resolution_reason_label', 'Resolution Reason')) + ' *</h4>' +
        '<select id="resolutionReasonSelect" class="form-select">' +
        '<option value="">' + esc(tr('select_option', 'Select an option')) + '</option>' +
        reasonOpts.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('') +
        '</select><div class="form-error" id="resolutionReasonError"></div></div>';
      html += '<div class="detail-block"><h4>' + esc(tr('resolution_solution_label', 'Solution / Corrective Action')) + ' *</h4>' +
        '<select id="resolutionSolutionSelect" class="form-select">' +
        '<option value="">' + esc(tr('select_option', 'Select an option')) + '</option>' +
        solutionOpts.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('') +
        '</select><div class="form-error" id="resolutionSolutionError"></div></div>';
      html += '<div class="detail-block" id="resolutionOtherWrap" style="display:none;">' +
        '<h4>' + esc(tr('resolution_other_explain', 'Please explain (required for Other)')) + ' *</h4>' +
        '<textarea id="resolutionOtherInput" maxlength="500" placeholder="' + esc(tr('resolution_other_placeholder', 'Explain your Other selection…')) + '"></textarea>' +
        '<div class="form-error" id="resolutionOtherError"></div></div>';
      if (hasItem) {
        html += '<div class="detail-block"><h4>' + esc(tr('stock_record_qty_label', 'Record Actual Stock Quantity (Optional)')) + '</h4>' +
          '<input type="number" id="newStockQtyInput" min="0" step="1" placeholder="' +
          esc(tr('stock_record_qty_placeholder', 'Leave empty unless you are recording the physical count…')) + '">' +
          '<p class="field-hint">' + esc(tr('stock_record_qty_hint', 'If the item is still at/below its minimum after this, the alert stays open until real stock arrives.')) + '</p>' +
          '<div class="form-error" id="newStockQtyError"></div></div>';
      }
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_resolution_note_label', 'Additional Details (Optional)')) + '</h4>' +
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
    } else if (isAcknowledged) {
      // View-only branch for roles that may NOT resolve (kitchen, cashier,
      // ...). The cafeteria manager, cafeteria admin and system admin all fall
      // into the branch above, because the backend lets all three resolve.
      html += '<div class="detail-block"><div class="quality-hold-warning">' +
        esc(tr('stock_resolution_admin_hint',
          'Only a manager or administrator can mark this stock alert as resolved. You can mark the item unavailable.')) +
        '</div></div>';
      html += '<div class="modal-actions">' +
        '<button type="button" class="btn btn-secondary" id="closeModalBtn2">' +
        esc(tr('issue_close', 'Close')) + '</button>' +
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

    var reasonSel = document.getElementById('resolutionReasonSelect');
    var solSel = document.getElementById('resolutionSolutionSelect');
    function toggleOtherWrap() {
      var otherWrap = document.getElementById('resolutionOtherWrap');
      if (!otherWrap) return;
      var showOther = (reasonSel && reasonSel.value === 'Other') || (solSel && solSel.value === 'Other');
      otherWrap.style.display = showOther ? '' : 'none';
    }
    if (reasonSel) reasonSel.addEventListener('change', toggleOtherWrap);
    if (solSel) solSel.addEventListener('change', toggleOtherWrap);
    toggleOtherWrap();

    var resolveBtn = document.getElementById('resolveBtn');
    if (resolveBtn) resolveBtn.addEventListener('click', function () { resolveAlert(alert.id, resolveBtn); });

    var unavailableBtn = document.getElementById('markUnavailableBtn');
    if (unavailableBtn) unavailableBtn.addEventListener('click', function () { markUnavailable(alert, unavailableBtn); });
  }

  function markUnavailable(alert, btn) {
    var key = 'unavailable:' + alert.itemId;
    if (inFlight[key]) return;                     // no duplicate availability PATCH
    if (!window.confirm(tr('stock_mark_unavailable_confirm', 'Mark this item as unavailable? Customers will no longer be able to order it.'))) return;
    if (btn) btn.disabled = true;
    inFlight[key] = true;

    window.AdminAPI.patch('/kitchen/menu/' + encodeURIComponent(alert.itemId) + '/availability', {
      isAvailable: false,
      reason: tr('stock_mark_unavailable_reason', 'Marked unavailable from stock alert'),
    })
      .then(function (data) {
        toast('success', (data && data.message) || tr('stock_mark_unavailable_success', 'Item marked unavailable'));
        loadAlerts({ silent: true }).then(function () { if (selectedAlertId) openAlert(selectedAlertId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('stock_mark_unavailable_failed', 'Failed to mark the item unavailable')));
        if (btn) btn.disabled = false;
      })
      .finally(function () {
        delete inFlight[key];
      });
  }

  function openAlert(alertId) {
    selectedAlertId = alertId;
    var backdrop = document.getElementById('stockModalBackdrop');
    var content = document.getElementById('stockModalContent');
    if (backdrop) backdrop.classList.add('active');
    if (content) content.innerHTML = '<div class="stock-loading">' +
      esc(tr('issue_loading', 'Loading stock alerts…')) + '</div>';

    var cached = allAlerts.find(function (a) { return a.id === alertId; });
    if (cached) {
      renderModal(cached);
      return;
    }
    toast('error', tr('stock_not_found', 'Stock alert not found'));
    closeModal();
  }

  function acknowledgeAlert(alertId, btn) {
    // Duplicate click / re-render while the request is still in flight.
    if (inFlight[alertId]) return;

    var noteInput = document.getElementById('ackNoteInput');
    var errorEl = document.getElementById('ackError');
    var note = noteInput ? noteInput.value.trim() : '';

    if (errorEl) errorEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = tr('issue_accepting', 'Submitting…'); }
    inFlight[alertId] = 'acknowledge';

    window.AdminAPI.patch('/kitchen/stock-alerts/' + encodeURIComponent(alertId) + '/acknowledge', { note: note })
      .then(function (data) {
        toast('success', (data && data.message) || tr('stock_ack_success', 'Alert acknowledged successfully'));
        // The backend confirmed IN_PROGRESS (assignment + status saved): swap
        // Take Responsibility for Mark Solved immediately from this response,
        // then refresh the list/counts in the background. This transition does
        // NOT depend on a follow-up GET succeeding, and the alert is never
        // resolved at this stage.
        applyAlertUpdate(alertId, data && data.alert);
        loadAlerts({ silent: true });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('stock_failed_ack', 'Failed to acknowledge alert')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-user-check"></i> ' + esc(tr('manager_stock_acknowledge', 'Acknowledge & Take Responsibility'));
        }
      })
      .finally(function () {
        delete inFlight[alertId];
      });
  }

  function resolveAlert(alertId, btn) {
    // Duplicate click / re-render while a resolve request is still in flight.
    if (inFlight[alertId]) return;

    var reasonSel = document.getElementById('resolutionReasonSelect');
    var solSel = document.getElementById('resolutionSolutionSelect');
    var otherInput = document.getElementById('resolutionOtherInput');
    var detailsInput = document.getElementById('resolutionInput');
    var qtyInput = document.getElementById('newStockQtyInput');
    var reasonError = document.getElementById('resolutionReasonError');
    var solError = document.getElementById('resolutionSolutionError');
    var otherError = document.getElementById('resolutionOtherError');
    var detailsError = document.getElementById('resolutionError');
    var qtyError = document.getElementById('newStockQtyError');

    var reason = reasonSel ? reasonSel.value : '';
    var solution = solSel ? solSel.value : '';
    var otherText = otherInput ? otherInput.value.trim() : '';
    var details = detailsInput ? detailsInput.value.trim() : '';
    var qtyRaw = qtyInput ? qtyInput.value.trim() : '';

    if (reasonError) reasonError.textContent = '';
    if (solError) solError.textContent = '';
    if (otherError) otherError.textContent = '';
    if (detailsError) detailsError.textContent = '';
    if (qtyError) qtyError.textContent = '';

    if (!reason) {
      if (reasonError) reasonError.textContent = tr('reason_required', 'Resolution reason is required.');
      if (reasonSel) reasonSel.focus();
      return;
    }
    if (!solution) {
      if (solError) solError.textContent = tr('solution_required', 'Solution is required.');
      if (solSel) solSel.focus();
      return;
    }
    if ((reason === 'Other' || solution === 'Other') && !otherText) {
      if (otherError) otherError.textContent = tr('other_required', 'Please explain the Other selection.');
      if (otherInput) otherInput.focus();
      return;
    }

    var newStockQuantity = null;
    if (qtyRaw !== '') {
      var parsed = parseInt(qtyRaw, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        if (qtyError) qtyError.textContent = tr('stock_record_qty_invalid', 'Enter a whole number of 0 or more (or leave it empty).');
        if (qtyInput) qtyInput.focus();
        return;
      }
      newStockQuantity = parsed;
    }

    var noteParts = [];
    if (otherText) noteParts.push(tr('resolution_other_prefix', 'Other explanation') + ': ' + otherText);
    if (details) noteParts.push(details);
    var resolutionNote = noteParts.join('\n\n');

    if (btn) { btn.disabled = true; btn.textContent = tr('issue_sending', 'Sending…'); }
    inFlight[alertId] = 'resolve';

    var payload = {
      resolutionReason: reason,
      resolutionSolution: solution,
      resolutionNote: resolutionNote || null,
    };
    if (newStockQuantity != null) payload.newStockQuantity = newStockQuantity;

    window.AdminAPI.patch('/kitchen/stock-alerts/' + encodeURIComponent(alertId) + '/resolve', payload)
      .then(function (data) {
        if (data && data.resolved === false) {
          // Genuine resolution blocked: stock still at/below threshold. The
          // backend kept the alert open, so show its message as an ERROR and
          // put the button back - never a success state.
          toast('error', data.message || tr('stock_resolve_still_low', 'Stock is still below the minimum - the alert stays open.'));
          applyAlertUpdate(alertId, data && data.alert);
          loadAlerts({ silent: true }).then(function () {
            if (selectedAlertId === alertId) openAlert(alertId);
          });
        } else {
          // Backend saved the resolution (status + resolver confirmed): flip to
          // the final Resolved state NOW and drop both action buttons.
          toast('success', (data && data.message) || tr('stock_resolve_success', 'Alert marked as resolved'));
          applyAlertUpdate(alertId, data && data.alert);
          loadAlerts({ silent: true });
        }
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('stock_failed_resolve', 'Failed to resolve alert')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-check"></i> ' + esc(tr('manager_stock_mark_resolved', 'Mark as Resolved'));
        }
      })
      .finally(function () {
        delete inFlight[alertId];
      });
  }

  // ------------------------------------------------------------------
  // Real-time: new reports / status changes
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
          // Status change on any alert (acknowledge/resolve) → refresh.
          socketClient.on('stock:alert:updated', function () {
            loadAlerts();
            if (selectedAlertId) openAlert(selectedAlertId);
          });
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
