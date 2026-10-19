/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - MANAGER ISSUE REPORTS
   ==========================================================================
   Cafeteria Manager / Cafeteria Admin page logic for kitchen issue reports:
     - GET    /issues                    → cafeteria-scoped list (backend enforces)
     - GET    /issues/:id                → details
     - PATCH  /issues/:id/review         → OPEN → UNDER_REVIEW (manager + admin)
     - PATCH  /issues/:id/investigate    → notes only, no status change
     - PATCH  /issues/:id/request-admin  → UNDER_REVIEW → REQUEST_SENT (manager
                                           + admin). Creates a ResolutionRequest.
     - PATCH  /issues/:id/solution       → REQUEST_SENT → RESOLVED (Cafeteria
                                           Admin only; the manager never sees
                                           this UI and the backend answers 403
                                           to manager JWTs)

   New workflow statuses: OPEN → UNDER_REVIEW → REQUEST_SENT → RESOLVED

   Requires window.AdminAPI (admin-api.js) loaded first.
   Manager identity / cafeteria are NEVER sent from here - the backend takes
   them from the authenticated JWT.
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
    OPEN: 'issue_status_open',
    UNDER_REVIEW: 'issue_status_under_review',
    REQUEST_SENT: 'issue_status_request_sent',
    RESOLVED: 'issue_status_resolved'
  };

  // ------------------------------------------------------------------
  // Resolution permission: only Cafeteria Admin / System Admin may send a
  // solution (the backend answers 403 to anyone else - this gate only keeps
  // the action out of the manager's UI).
  // ------------------------------------------------------------------
  var RESOLVER_ROLES = ['cafeteria_admin', 'admin', 'system_admin'];

  function currentRole() {
    if (window.ScosRoles && window.ScosRoles.getCurrentRole) return window.ScosRoles.getCurrentRole();
    try {
      var cu = JSON.parse(localStorage.getItem('current_user') || 'null');
      if (cu && cu.role) return String(cu.role).toLowerCase();
    } catch (e) { /* ignore */ }
    return String(localStorage.getItem('userRole') || localStorage.getItem('role') || '').toLowerCase();
  }

  function canResolveIssues() {
    var role = currentRole();
    if (window.ScosRoles && window.ScosRoles.normalizeRole) role = window.ScosRoles.normalizeRole(role);
    return RESOLVER_ROLES.indexOf(String(role).toLowerCase()) !== -1;
  }

  // Restock requests are a manager-only action (admins review them in
  // Menu → Restock Requests), so the admin never sees a submit form here.
  var REQUEST_ROLES = ['manager'];

  function canRequestRestock() {
    var role = currentRole();
    if (window.ScosRoles && window.ScosRoles.normalizeRole) role = window.ScosRoles.normalizeRole(role);
    return REQUEST_ROLES.indexOf(String(role).toLowerCase()) !== -1;
  }

  // The Review + Send-Request actions are manager-only (admins use the
  // Cafeteria Admin dashboard's Resolution Requests page).
  function canReviewIssues() {
    var role = currentRole();
    if (window.ScosRoles && window.ScosRoles.normalizeRole) role = window.ScosRoles.normalizeRole(role);
    return REQUEST_ROLES.indexOf(String(role).toLowerCase()) !== -1;
  }

  var CATEGORY_KEYS = {
    equipment: 'issue_category_equipment',
    stock: 'issue_category_stock',
    quality: 'issue_category_quality',
    safety: 'issue_category_safety',
    cleaning: 'issue_category_cleaning',
    staffing: 'issue_category_staffing',
    other: 'issue_category_other'
  };
  var PRIORITY_KEYS = {
    low: 'severity_low',
    medium: 'severity_medium',
    high: 'severity_high',
    critical: 'severity_critical'
  };

  function statusLabel(status) {
    if (typeof window.translateStatus === 'function') {
      var localized = window.translateStatus(status);
      if (localized && localized !== status) return localized;
    }
    var key = STATUS_KEYS[status];
    return key ? tr(key, status) : (status || '—');
  }

  function categoryLabel(category) {
    var key = CATEGORY_KEYS[category];
    return key ? tr(key, category) : (category || '—');
  }

  function priorityLabel(priority) {
    var key = PRIORITY_KEYS[priority];
    var text = key ? tr(key, priority) : (priority || '—');
    return { text: text, raw: priority };
  }

  var allIssues = [];
  var activeStatus = '';
  var selectedIssueId = null;
  var lastFocusRowBtn = null;
  var selectedIssueCache = null;

  function esc(v) {
    return window.AdminAPI.esc(v);
  }

  function personName(person, fallback) {
    if (!person) return fallback || '—';
    if (typeof person === 'object') return person.name || fallback || '—';
    return fallback || '—';
  }

  function statusBadge(status) {
    return '<span class="issue-status-badge issue-status-' + esc(status) + '">' +
      esc(statusLabel(status)) + '</span>';
  }

  function priorityBadge(priority) {
    var p = priorityLabel(priority);
    return '<span class="issue-priority-badge issue-priority-' + esc(p.raw) + '">' + esc(p.text) + '</span>';
  }

  function categoryChip(category) {
    return '<span class="issue-category-chip">' + esc(categoryLabel(category)) + '</span>';
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
    var counts = { OPEN: 0, UNDER_REVIEW: 0, REQUEST_SENT: 0, RESOLVED: 0 };
    allIssues.forEach(function (i) {
      if (counts[i.status] !== undefined) counts[i.status]++;
    });
    var el;
    el = document.getElementById('countAll'); if (el) el.textContent = allIssues.length;
    el = document.getElementById('countOpen'); if (el) el.textContent = counts.OPEN;
    el = document.getElementById('countUnderReview'); if (el) el.textContent = counts.UNDER_REVIEW;
    el = document.getElementById('countRequestSent'); if (el) el.textContent = counts.REQUEST_SENT;
    el = document.getElementById('countResolved'); if (el) el.textContent = counts.RESOLVED;
  }

  function renderIssues() {
    var tbody = document.getElementById('issuesTableBody');
    if (!tbody) return;

    var rows = allIssues.filter(function (i) {
      return !activeStatus || i.status === activeStatus;
    });

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="issue-empty">' +
        '<i class="fa-solid fa-flag"></i>' +
        esc(activeStatus
          ? tr('issue_empty_status', 'No {status} issue reports.', { status: statusLabel(activeStatus) })
          : tr('issue_empty_cafeteria', 'No issue reports for your cafeteria yet.')) +
        '</td></tr>';
      return;
    }

    var html = '';
    rows.forEach(function (issue) {
      html += '<tr>'
        + '<td><strong>' + esc(issue.title) + '</strong></td>'
        + '<td>' + esc(personName(issue.reportedBy, '—')) + '</td>'
        + '<td>' + categoryChip(issue.category) + '</td>'
        + '<td>' + priorityBadge(issue.priority) + '</td>'
        + '<td>' + statusBadge(issue.status) + '</td>'
        + '<td>' + esc(window.AdminAPI.formatDateTime(issue.createdAt)) + '</td>'
        + '<td><button type="button" class="btn btn-sm btn-outline-primary" data-issue-id="' + esc(issue.id) + '">' +
          esc(tr('issue_view', 'View')) + '</button></td>'
        + '</tr>';
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll('button[data-issue-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        lastFocusRowBtn = btn;
        openIssue(btn.getAttribute('data-issue-id'));
      });
    });
  }

  var issuesLoading = false;
  function setRefreshLoading(loading) {
    var btn = document.getElementById('refreshIssuesBtn');
    if (!btn) return;
    btn.disabled = loading;
    var icon = btn.querySelector('i');
    if (icon) icon.className = loading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate';
  }

  function loadIssues(options) {
    options = options || {};
    var tbody = document.getElementById('issuesTableBody');
    if (options.showLoading && tbody) {
      tbody.innerHTML = '<tr><td colspan="7" class="issue-loading">' +
        esc(tr('issue_loading', 'Loading issue reports…')) + '</td></tr>';
    }
    if (options.fromRefresh) {
      if (issuesLoading) return Promise.resolve();
      issuesLoading = true;
      setRefreshLoading(true);
    }

    return window.AdminAPI.get('/issues')
      .then(function (data) {
        allIssues = (data && data.issues) || [];
        updateCounts();
        renderIssues();
        if (options.fromRefresh && window.AdminToast) {
          window.AdminToast.show(tr('admin_issues_refreshed', 'Issue reports refreshed'));
        }
      })
      .catch(function (err) {
        if (tbody) {
          tbody.innerHTML =
            '<tr><td colspan="7" class="issue-empty issue-error">' +
            esc(tr('issue_load_failed', 'Failed to load issue reports: {error}', { error: errorOf(err, 'Unknown error') })) +
            '</td></tr>';
        }
        toast('error', errorOf(err, tr('issue_load_error', 'Could not load issue reports.')));
      })
      .finally(function () {
        if (options.fromRefresh) {
          issuesLoading = false;
          setRefreshLoading(false);
        }
      });
  }

  // ------------------------------------------------------------------
  // Details modal
  // ------------------------------------------------------------------
  function closeModal() {
    var backdrop = document.getElementById('issueModalBackdrop');
    if (backdrop) backdrop.classList.remove('active');
    selectedIssueId = null;
    if (lastFocusRowBtn && typeof lastFocusRowBtn.focus === 'function') {
      try { lastFocusRowBtn.focus(); } catch (e) { /* ignore */ }
    }
  }

  function renderModal(issue) {
    selectedIssueCache = issue;
    var content = document.getElementById('issueModalContent');
    if (!content) return;

    var isOpen = issue.status === 'OPEN';
    var isUnderReview = issue.status === 'UNDER_REVIEW';
    var isRequestSent = issue.status === 'REQUEST_SENT';
    var isResolved = issue.status === 'RESOLVED';

    var html = '';
    html += '<h2>' + esc(issue.title) + '</h2>';
    html += '<div class="modal-meta">' + statusBadge(issue.status) + ' ' +
      priorityBadge(issue.priority) + ' ' + categoryChip(issue.category) + '</div>';

    html += '<div class="detail-block"><h4>' + esc(tr('issue_title_description', 'Description')) +
      '</h4><p>' + esc(issue.description) + '</p></div>';

    html += '<div class="detail-block"><h4>' + esc(tr('issue_title_reported_by', 'Reported By')) +
      '</h4><p>' +
      esc(personName(issue.reportedBy, '—')) + ' · ' + esc(window.AdminAPI.formatDateTime(issue.createdAt)) +
      '</p></div>';

    if (isResolved) {
      // Resolution audit line: who resolved it (admin id) and when.
      html += '<div class="detail-block"><h4>' + esc(tr('issue_resolved_by', 'Resolved By')) +
        '</h4><p>' +
        esc(personName(issue.repliedBy, tr('admin_cafeteria_admin', 'Cafeteria Admin'))) + ' · ' +
        esc(window.AdminAPI.formatDateTime(issue.resolvedAt || issue.repliedAt)) +
        '</p></div>';
      if (issue.solution) {
        html += '<div class="detail-block"><h4>' + esc(tr('issue_title_solution', 'Solution')) +
          '</h4><div class="solution-box">' + esc(issue.solution) + '</div></div>';
      }
      if (issue.resolutionReason) {
        html += '<div class="detail-block"><h4>' + esc(tr('resolution_reason_label', 'Resolution Reason')) + '</h4><p>' + esc(issue.resolutionReason) + '</p></div>';
      }
      if (issue.resolutionSolution) {
        html += '<div class="detail-block"><h4>' + esc(tr('issue_title_solution', 'Solution Detail')) + '</h4><div class="solution-box">' + esc(issue.resolutionSolution) + '</div></div>';
      }
      if (issue.resolutionQuantity != null) {
        html += '<div class="detail-block"><h4>' + esc(tr('stock_updated_qty_label', 'Updated Stock Quantity')) + '</h4><p>' + esc(issue.resolutionQuantity) + '</p></div>';
      }
    }

    // ---- Investigation notes (IssueReport stays its own record) ----
    if (!isResolved) {
      if (issue.itemId) {
        html += '<div class="detail-block"><h4>' + esc(tr('issue_linked_item', 'Linked Menu Item')) + '</h4><p>' +
          esc(issue.itemName || '—') +
          (issue.itemCurrentQuantity != null
            ? ' &middot; ' + esc(tr('stock_current_qty_label', 'Current quantity')) + ': <strong>' + esc(issue.itemCurrentQuantity) + '</strong>'
            : '') +
          '</p></div>';
      }

      html += '<div class="detail-block"><h4>' + esc(tr('issue_investigation_notes', 'Investigation Notes')) + '</h4>';
      if (issue.investigationNotes) {
        html += '<div class="solution-box">' + esc(issue.investigationNotes) + '</div>' +
          '<div class="solution-meta">' +
          esc(tr('issue_by', 'By {name}', { name: personName(issue.investigatedBy, tr('role_manager', 'Manager')) })) +
          ' · ' + esc(window.AdminAPI.formatDateTime(issue.investigatedAt)) + '</div>';
      }
      html += '<textarea id="investNotesInput" maxlength="2000" style="width:100%;min-height:70px;margin-top:8px;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-family:inherit;font-size:0.92rem;resize:vertical;" placeholder="' +
        esc(tr('issue_investigation_placeholder', 'What did you find? Which item/supplier/equipment is affected…')) + '"></textarea>' +
        '<div class="form-error" id="investError"></div>' +
        '<button type="button" class="btn btn-outline-primary" id="saveInvestBtn" style="margin-top:8px;">' +
        '<i class="fa-solid fa-magnifying-glass"></i> ' + esc(tr('issue_save_investigation', 'Save Investigation Notes')) + '</button>' +
        '</div>';

      // ---- Request Restock directly from the issue (linked record only) ----
      if (canRequestRestock() && issue.itemId && !issue.restockRequestId) {
        html += '<div class="detail-block"><h4>' + esc(tr('restock_request_new_title', 'Request Restock')) + '</h4>' +
          '<div style="display:grid;grid-template-columns:140px 1fr;gap:10px;margin-bottom:8px;">' +
          '<label style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#9ca3af;">' +
          esc(tr('restock_qty_label', 'Quantity to request')) +
          '<input type="number" id="issueRestockQtyInput" min="1" step="1" value="10" style="margin-top:4px;width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;"></label>' +
          '<label style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#9ca3af;">' +
          esc(tr('restock_reason_label', 'Reason')) +
          '<input type="text" id="issueRestockReasonInput" maxlength="500" value="' + esc(issue.title) +
          '" style="margin-top:4px;width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;"></label>' +
          '</div>' +
          '<div class="form-error" id="issueRestockError"></div>' +
          '<button type="button" class="btn btn-primary" id="issueRestockBtn">' +
          '<i class="fa-solid fa-truck-arrow-right"></i> ' + esc(tr('restock_submit', 'Submit Restock Request')) + '</button>' +
          '</div>';
      }
    }

    // ---- Linked ResolutionRequest status (traceability) ----
    if (issue.resolutionRequestId) {
      var reqStatus = issue.resolutionRequestStatus;
      var reqLabels = {
        PENDING: tr('req_status_pending', 'Pending'),
        IN_PROGRESS: tr('req_status_in_progress', 'In Progress'),
        RESOLVED: tr('req_status_resolved', 'Resolved'),
        REJECTED: tr('req_status_rejected', 'Rejected'),
      };
      html += '<div class="detail-block"><h4>' + esc(tr('req_status_title', 'Admin Request Status')) + '</h4>' +
        '<p><span class="issue-status-badge issue-status-' +
        (reqStatus === 'RESOLVED' ? 'resolved' : reqStatus === 'REJECTED' ? 'cancelled' : 'acknowledged') +
        '">' + esc(reqLabels[reqStatus] || reqStatus || '—') + '</span></p></div>';
    }

    // ---- Linked restock request status (traceability) ----
    if (issue.restockRequestId) {
      var restockLabels = {
        PENDING: tr('restock_status_pending', 'Pending'),
        APPROVED: tr('restock_status_approved', 'Approved'),
        REJECTED: tr('restock_status_rejected', 'Rejected'),
        RESTOCKED: tr('restock_status_restocked', 'Restocked'),
        CANCELLED: tr('restock_status_cancelled', 'Cancelled'),
      };
      html += '<div class="detail-block"><h4>' + esc(tr('restock_request_status_title', 'Restock Request Status')) + '</h4>' +
        '<p><span class="issue-status-badge issue-status-' +
        (issue.restockRequestStatus === 'RESTOCKED' ? 'resolved' : issue.restockRequestStatus === 'REJECTED' || issue.restockRequestStatus === 'CANCELLED' ? 'cancelled' : 'acknowledged') +
        '">' + esc(restockLabels[issue.restockRequestStatus] || issue.restockRequestStatus || '—') + '</span> ' +
        esc(tr('restock_linked_hint', '(status shown here)')) + '</p></div>';
    }

    // ---- Action buttons based on status + role ----
    if (isOpen && canReviewIssues()) {
      // Manager sees Review Report button when status is OPEN.
      html += '<div class="detail-block">' +
        '<button type="button" class="btn btn-primary" id="reviewIssueBtn">' +
        '<i class="fa-solid fa-magnifying-glass"></i> ' + esc(tr('issue_review', 'Review Report')) + '</button>' +
        '</div>';
    } else if (isOpen && !canReviewIssues()) {
      // Admin view of OPEN issue: hint that manager must review first.
      html += '<div class="detail-block"><div class="quality-hold-warning">' +
        esc(tr('issue_review_hint', 'The Cafeteria Manager must review this issue before it can be sent to the Admin.')) +
        '</div></div>';
    }

    if (isUnderReview && canReviewIssues()) {
      // Manager sees Send Request to Cafeteria Admin button.
      html += '<div class="detail-block"><h4>' + esc(tr('issue_send_admin_request', 'Send Request to Cafeteria Admin')) + '</h4>' +
        '<p style="font-size:0.85rem;color:#6b7280;margin-bottom:8px;">' +
        esc(tr('issue_send_admin_request_hint', 'Describe the action you need the Cafeteria Admin to take (restock, repair, replace, etc.).')) +
        '</p>' +
        '<textarea id="requestedActionInput" maxlength="500" style="width:100%;min-height:60px;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-family:inherit;font-size:0.92rem;resize:vertical;" placeholder="' +
        esc(tr('issue_requested_action_placeholder', 'e.g. Restock 50kg coffee beans, replace oven heating element…')) + '"></textarea>' +
        '<div class="form-error" id="requestActionError"></div>' +
        '<button type="button" class="btn btn-primary" id="sendAdminRequestBtn" style="margin-top:8px;">' +
        '<i class="fa-solid fa-paper-plane"></i> ' + esc(tr('issue_send_request', 'Send Request')) + '</button>' +
        '</div>';
    } else if (isUnderReview && !canReviewIssues()) {
      // Admin view of UNDER_REVIEW issue.
      html += '<div class="detail-block"><div class="quality-hold-warning">' +
        esc(tr('issue_waiting_for_request', 'The Cafeteria Manager has not yet sent a request to the Admin. You can view progress in the Resolution Requests page once a request is submitted.')) +
        '</div></div>';
    }

    if (isRequestSent && canResolveIssues()) {
      // Admin resolution form.
      var resOpts = window.ScosResolution || {};
      var optionCategory = resOpts.categoryForIssue
        ? resOpts.categoryForIssue(issue.category)
        : 'all';
      var reasonOpts = resOpts.reasonsFor
        ? resOpts.reasonsFor(optionCategory)
        : ['Out of Stock', 'Low Stock', 'Equipment Failure', 'Equipment Damage', 'Expired Items', 'Supplier Delay', 'Incorrect Stock Record', 'Maintenance Required', 'Other'];
      var solutionOpts = resOpts.solutionsFor
        ? resOpts.solutionsFor(optionCategory)
        : ['Restocked Items', 'Updated Stock Quantity', 'Ordered New Supplies', 'Repaired Equipment', 'Replaced Equipment', 'Cleaned and Maintained Equipment', 'Removed Expired Items', 'Contacted Supplier', 'Corrected Inventory Record', 'Other'];
      html += '<div class="detail-block"><h4>' + esc(tr('resolution_reason_label', 'Resolution Reason')) + ' *</h4>' +
        '<select id="issueReasonSelect" class="form-select">' +
        '<option value="">' + esc(tr('select_option', 'Select an option')) + '</option>' +
        reasonOpts.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('') +
        '</select><div class="form-error" id="issueReasonError"></div></div>';
      html += '<div class="detail-block"><h4>' + esc(tr('resolution_solution_label', 'Solution / Corrective Action')) + ' *</h4>' +
        '<select id="issueSolutionSelect" class="form-select">' +
        '<option value="">' + esc(tr('select_option', 'Select an option')) + '</option>' +
        solutionOpts.map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('') +
        '</select><div class="form-error" id="solutionError"></div></div>';
      html += '<div class="detail-block" id="issueOtherWrap" style="display:none;">' +
        '<h4>' + esc(tr('resolution_other_explain', 'Please explain (required for Other)')) + ' *</h4>' +
        '<textarea id="issueOtherInput" maxlength="500" placeholder="' + esc(tr('resolution_other_placeholder', 'Explain your Other selection…')) + '"></textarea>' +
        '<div class="form-error" id="issueOtherError"></div></div>';
      html += '<div class="detail-block"><h4>' + esc(tr('manager_stock_resolution_note_label', 'Additional Details (Optional)')) + '</h4>' +
        '<textarea id="issueDetailsInput" maxlength="2000" placeholder="' +
        esc(tr('manager_stock_resolution_placeholder', 'Describe how the issue was resolved…')) + '"></textarea>' +
        '</div>';
      html += '<div class="modal-actions">' +
        '<button type="button" class="btn btn-secondary" id="closeModalBtn2">' +
        esc(tr('issue_close', 'Close')) + '</button>' +
        '<button type="button" class="btn btn-primary" id="sendSolutionBtn">' +
        '<i class="fa-solid fa-check"></i> ' + esc(tr('issue_confirm_resolution', 'Confirm Resolution')) + '</button>' +
        '</div>';
    } else if (isRequestSent) {
      // Manager view of a REQUEST_SENT issue: no Resolve / Confirm Resolution
      // action - resolution belongs to the Cafeteria Admin.
      html += '<div class="detail-block"><div class="quality-hold-warning">' +
        esc(tr('issue_resolution_admin_hint',
          'Only the Cafeteria Admin can resolve this issue report. You can review the details, add investigation notes, and submit a restock request.')) +
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

    var reviewBtn = document.getElementById('reviewIssueBtn');
    if (reviewBtn) {
      reviewBtn.addEventListener('click', function () {
        reviewIssue(issue.id, reviewBtn);
      });
    }

    var investBtn = document.getElementById('saveInvestBtn');
    if (investBtn) {
      investBtn.addEventListener('click', function () {
        saveInvestigation(issue.id, investBtn);
      });
    }

    var sendAdminBtn = document.getElementById('sendAdminRequestBtn');
    if (sendAdminBtn) {
      sendAdminBtn.addEventListener('click', function () {
        sendAdminRequest(issue.id, sendAdminBtn);
      });
    }

    var issueRestockBtn = document.getElementById('issueRestockBtn');
    if (issueRestockBtn) {
      issueRestockBtn.addEventListener('click', function () {
        submitIssueRestock(issue, issueRestockBtn);
      });
    }

    var sendBtn = document.getElementById('sendSolutionBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        sendSolution(issue.id, sendBtn);
      });
    }

    var issueReasonSel = document.getElementById('issueReasonSelect');
    var issueSolSel = document.getElementById('issueSolutionSelect');
    function toggleIssueOtherWrap() {
      var otherWrap = document.getElementById('issueOtherWrap');
      if (!otherWrap) return;
      var showOther = (issueReasonSel && issueReasonSel.value === 'Other') ||
        (issueSolSel && issueSolSel.value === 'Other');
      otherWrap.style.display = showOther ? '' : 'none';
    }
    if (issueReasonSel) issueReasonSel.addEventListener('change', toggleIssueOtherWrap);
    if (issueSolSel) issueSolSel.addEventListener('change', toggleIssueOtherWrap);
    toggleIssueOtherWrap();
  }

  function openIssue(issueId) {
    selectedIssueId = issueId;
    var backdrop = document.getElementById('issueModalBackdrop');
    var content = document.getElementById('issueModalContent');
    if (backdrop) backdrop.classList.add('active');
    if (content) content.innerHTML = '<div class="issue-loading">' +
      esc(tr('issue_loading', 'Loading issue reports…')) + '</div>';

    window.AdminAPI.get('/issues/' + encodeURIComponent(issueId))
      .then(function (data) {
        if (!selectedIssueId) return; // modal closed meanwhile
        renderModal((data && data.issue) || {});
      })
      .catch(function (err) {
        var message = errorOf(err, tr('issue_load_error', 'Could not load the issue report.'));
        if (content) {
          content.innerHTML =
            '<h2>' + esc(tr('issue_title_details', 'Issue Details')) + '</h2>' +
            '<div class="detail-block issue-error"><p>' + esc(message) + '</p></div>' +
            '<div class="modal-actions"><button type="button" class="btn btn-secondary" id="closeModalBtn2">' +
            esc(tr('issue_close', 'Close')) + '</button></div>';
          var b = document.getElementById('closeModalBtn2');
          if (b) b.addEventListener('click', closeModal);
        }
        toast('error', message);
      });
  }

  function reviewIssue(issueId, btn) {
    var notesInput = document.getElementById('investNotesInput');
    var errorEl = document.getElementById('investError');
    var notes = notesInput ? notesInput.value.trim() : '';

    if (errorEl) errorEl.textContent = '';
    if (!notes) {
      if (errorEl) errorEl.textContent = tr('issue_investigation_required', 'Enter your investigation notes first.');
      if (notesInput) notesInput.focus();
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = tr('issue_reviewing', 'Reviewing…'); }
    window.AdminAPI.patch('/issues/' + encodeURIComponent(issueId) + '/review', { notes: notes })
      .then(function (data) {
        toast('success', (data && data.message) || tr('issue_reviewed_toast', 'Issue report marked as under review'));
        loadIssues().then(function () { openIssue(issueId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('issue_review_failed', 'Failed to review the issue report.')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> ' + esc(tr('issue_review', 'Review Report'));
        }
      });
  }

  function sendAdminRequest(issueId, btn) {
    var actionInput = document.getElementById('requestedActionInput');
    var errorEl = document.getElementById('requestActionError');
    var requestedAction = actionInput ? actionInput.value.trim() : '';

    if (errorEl) errorEl.textContent = '';
    if (!requestedAction) {
      if (errorEl) errorEl.textContent = tr('issue_requested_action_required', 'Describe the action you need the Admin to take.');
      if (actionInput) actionInput.focus();
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = tr('issue_sending', 'Sending…'); }
    window.AdminAPI.patch('/issues/' + encodeURIComponent(issueId) + '/request-admin', {
      requestedAction: requestedAction,
    })
      .then(function (data) {
        toast('success', (data && data.message) || tr('issue_request_sent_toast', 'Resolution request sent to Cafeteria Admin'));
        loadIssues().then(function () { openIssue(issueId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('issue_request_send_failed', 'Failed to send the resolution request.')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> ' + esc(tr('issue_send_request', 'Send Request'));
        }
      });
  }

  function sendSolution(issueId, btn) {
    var reasonSel = document.getElementById('issueReasonSelect');
    var solSel = document.getElementById('issueSolutionSelect');
    var otherInput = document.getElementById('issueOtherInput');
    var detailsInput = document.getElementById('issueDetailsInput');
    var reasonError = document.getElementById('issueReasonError');
    var solError = document.getElementById('solutionError');
    var otherError = document.getElementById('issueOtherError');

    var reason = reasonSel ? reasonSel.value : '';
    var solution = solSel ? solSel.value : '';
    var otherText = otherInput ? otherInput.value.trim() : '';
    var details = detailsInput ? detailsInput.value.trim() : '';

    if (reasonError) reasonError.textContent = '';
    if (solError) solError.textContent = '';
    if (otherError) otherError.textContent = '';

    if (!reason) {
      if (reasonError) reasonError.textContent = tr('reason_required', 'Resolution reason is required.');
      if (reasonSel) reasonSel.focus();
      return;
    }
    if (!solution) {
      if (solError) solError.textContent = tr('solution_required', 'Please select a solution.');
      if (solSel) solSel.focus();
      return;
    }
    if ((reason === 'Other' || solution === 'Other') && !otherText) {
      if (otherError) otherError.textContent = tr('other_required', 'Please explain the Other selection.');
      if (otherInput) otherInput.focus();
      return;
    }

    var noteParts = [];
    if (otherText) noteParts.push(tr('resolution_other_prefix', 'Other explanation') + ': ' + otherText);
    if (details) noteParts.push(details);

    if (btn) { btn.disabled = true; btn.textContent = tr('issue_sending', 'Sending…'); }
    window.AdminAPI.patch('/issues/' + encodeURIComponent(issueId) + '/solution', {
      resolutionReason: reason,
      resolutionSolution: solution,
      resolutionNote: noteParts.join('\n\n') || null,
    })
      .then(function (data) {
        toast('success', (data && data.message) || tr('issue_solution_sent', 'Solution sent'));
        loadIssues().then(function () { openIssue(issueId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('issue_solution_failed', 'Failed to send the solution.')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-check"></i> ' + esc(tr('issue_confirm_resolution', 'Confirm Resolution'));
        }
      });
  }

  function saveInvestigation(issueId, btn) {
    var input = document.getElementById('investNotesInput');
    var errorEl = document.getElementById('investError');
    var notes = input ? input.value.trim() : '';

    if (errorEl) errorEl.textContent = '';
    if (!notes) {
      if (errorEl) errorEl.textContent = tr('issue_investigation_required', 'Enter your investigation notes first.');
      if (input) input.focus();
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = tr('issue_saving', 'Saving…'); }
    window.AdminAPI.patch('/issues/' + encodeURIComponent(issueId) + '/investigate', { notes: notes })
      .then(function (data) {
        toast('success', (data && data.message) || tr('issue_investigation_saved', 'Investigation notes recorded'));
        loadIssues().then(function () { openIssue(issueId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('issue_investigation_failed', 'Failed to save the investigation notes.')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> ' + esc(tr('issue_save_investigation', 'Save Investigation Notes'));
        }
      });
  }

  function submitIssueRestock(issue, btn) {
    var qtyInput = document.getElementById('issueRestockQtyInput');
    var reasonInput = document.getElementById('issueRestockReasonInput');
    var errorEl = document.getElementById('issueRestockError');
    var qty = qtyInput ? parseInt(qtyInput.value, 10) : NaN;
    var reason = reasonInput ? reasonInput.value.trim() : '';

    if (errorEl) errorEl.textContent = '';
    if (!Number.isInteger(qty) || qty < 1) {
      if (errorEl) errorEl.textContent = tr('restock_qty_invalid', 'Enter a whole number of at least 1.');
      if (qtyInput) qtyInput.focus();
      return;
    }
    if (!reason) {
      if (errorEl) errorEl.textContent = tr('restock_reason_required', 'A reason for the restock request is required.');
      if (reasonInput) reasonInput.focus();
      return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + esc(tr('restock_submitting', 'Submitting…')); }
    window.AdminAPI.post('/restocks', {
      itemId: issue.itemId,
      requestedQuantity: qty,
      reason: reason,
      issueReportId: issue.id,
    })
      .then(function (data) {
        toast('success', (data && data.message) || tr('restock_submit_success', 'Restock request submitted'));
        loadIssues().then(function () { openIssue(issue.id); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('restock_submit_failed', 'Failed to submit the restock request')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-truck-arrow-right"></i> ' + esc(tr('restock_submit', 'Submit Restock Request'));
        }
      });
  }

  // ------------------------------------------------------------------
  // Real-time: new issue reports arrive without a page reload
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
          socketClient.on('issue:created', function (issue) {
            toast('info', tr('issue_new_realtime', 'New issue report: {title}', {
              title: (issue && issue.title) || ''
            }));
            loadIssues();
          });
          // A linked restock request changed → refresh the open issue so the
          // manager sees the latest status without reloading.
          socketClient.on('restock:updated', function () {
            if (selectedIssueId) openIssue(selectedIssueId);
          });
          socketClient.on('notification:new', function (notification) {
            if (notification && notification.title) {
              toast('info', notification.title + (notification.message ? ': ' + notification.message : ''));
            }
            if (window.refreshNotificationBadge) {
              try { window.refreshNotificationBadge(); } catch (e) { /* ignore */ }
            }
          });
          // This page toasts every `notification:new` itself, so suppress the
          // generic admin notification popup to avoid showing it twice.
          window.ScosNotifPopup = false;
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
    var refreshBtn = document.getElementById('refreshIssuesBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadIssues({ showLoading: true, fromRefresh: true });
      });
    }

    var tabs = document.querySelectorAll('#issueTabs .issue-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        activeStatus = tab.getAttribute('data-status') || '';
        renderIssues();
      });
    });

    var backdrop = document.getElementById('issueModalBackdrop');
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
      renderIssues();
      if (selectedIssueId && selectedIssueCache) renderModal(selectedIssueCache);
    };
    var register = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
    if (typeof register === 'function') register(rerender);
    else window.addEventListener('language:changed', rerender);

    loadIssues({ showLoading: true });
    initRealtime();

    if (window.__managerIssuesTimer) clearInterval(window.__managerIssuesTimer);
    window.__managerIssuesTimer = setInterval(function () { loadIssues(); }, 45000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
