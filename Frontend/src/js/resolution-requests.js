/**
 * ==========================================================================
   SMART CAFETERIA ADMIN — RESOLUTION REQUESTS PAGE
   ==========================================================================
   Cafeteria Admin page logic for processing Manager Resolution Requests:
     - GET   /resolution-requests             → cafeteria-scoped list
     - GET   /resolution-requests/:id         → details
     - PATCH /resolution-requests/:id/accept  → PENDING → IN_PROGRESS
     - PATCH /resolution-requests/:id/reject  → PENDING → REJECTED (reason req.)
     - PATCH /resolution-requests/:id/resolve → IN_PROGRESS → RESOLVED

   Requires window.AdminAPI (admin-api.js) loaded first.
   Admin identity / cafeteria are NEVER sent from here - the backend takes
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

  var STATUS_LABELS = {
    PENDING: 'req_status_pending',
    IN_PROGRESS: 'req_status_in_progress',
    RESOLVED: 'req_status_resolved',
    REJECTED: 'req_status_rejected',
  };

  var allRequests = [];
  var activeStatus = '';
  var selectedRequestId = null;
  var lastFocusRowBtn = null;
  var selectedRequestCache = null;

  function esc(v) { return window.AdminAPI.esc(v); }

  function personName(person, fallback) {
    if (!person) return fallback || '—';
    if (typeof person === 'object') return person.name || fallback || '—';
    return fallback || '—';
  }

  function statusLabel(status) {
    var key = STATUS_LABELS[status];
    return key ? tr(key, status) : (status || '—');
  }

  function statusBadge(status) {
    return '<span class="req-status-badge req-status-' + esc(status) + '">' + esc(statusLabel(status)) + '</span>';
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
    var counts = { PENDING: 0, IN_PROGRESS: 0, RESOLVED: 0, REJECTED: 0 };
    allRequests.forEach(function (r) {
      if (counts[r.status] !== undefined) counts[r.status]++;
    });
    var el;
    el = document.getElementById('countAll'); if (el) el.textContent = allRequests.length;
    el = document.getElementById('countPending'); if (el) el.textContent = counts.PENDING;
    el = document.getElementById('countInProgress'); if (el) el.textContent = counts.IN_PROGRESS;
    el = document.getElementById('countResolved'); if (el) el.textContent = counts.RESOLVED;
    el = document.getElementById('countRejected'); if (el) el.textContent = counts.REJECTED;
  }

  function renderRequests() {
    var tbody = document.getElementById('requestsTableBody');
    if (!tbody) return;

    var rows = allRequests.filter(function (r) {
      return !activeStatus || r.status === activeStatus;
    });

    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="empty-state">' +
        '<i class="fa-solid fa-file-signature"></i>' +
        esc(activeStatus
          ? tr('req_empty_status', 'No {status} requests.', { status: statusLabel(activeStatus) })
          : tr('req_empty', 'No resolution requests yet.')) +
        '</td></tr>';
      return;
    }

    var html = '';
    rows.forEach(function (req) {
      html += '<tr>'
        + '<td><strong>' + esc(req.issueTitle || '—') + '</strong></td>'
        + '<td>' + esc(req.requestedAction) + '</td>'
        + '<td>' + esc(personName(req.requestedBy, '—')) + '</td>'
        + '<td>' + esc(window.AdminAPI.formatDateTime(req.createdAt)) + '</td>'
        + '<td>' + statusBadge(req.status) + '</td>'
        + '<td><button type="button" class="btn btn-sm btn-outline-primary" data-req-id="' + esc(req.id) + '">' +
          esc(tr('req_view', 'View')) + '</button></td>'
        + '</tr>';
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll('button[data-req-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        lastFocusRowBtn = btn;
        openRequest(btn.getAttribute('data-req-id'));
      });
    });
  }

  function loadRequests(options) {
    options = options || {};
    var tbody = document.getElementById('requestsTableBody');
    if (options.showLoading && tbody) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading-state">' +
        '<i class="fa-solid fa-spinner fa-spin"></i> ' + esc(tr('req_loading', 'Loading requests…')) + '</td></tr>';
    }

    return window.AdminAPI.get('/resolution-requests')
      .then(function (data) {
        allRequests = (data && data.requests) || [];
        updateCounts();
        renderRequests();
        if (options.fromRefresh && window.AdminToast) {
          window.AdminToast.show(tr('req_refreshed', 'Requests refreshed'));
        }
      })
      .catch(function (err) {
        if (tbody) {
          tbody.innerHTML =
            '<tr><td colspan="6" class="empty-state" style="color:#dc2626;">' +
            esc(tr('req_load_failed', 'Failed to load requests: {error}', { error: errorOf(err, 'Unknown error') })) +
            '</td></tr>';
        }
        toast('error', errorOf(err, tr('req_load_error', 'Could not load resolution requests.')));
      });
  }

  // ------------------------------------------------------------------
  // Details modal
  // ------------------------------------------------------------------
  function closeModal() {
    var backdrop = document.getElementById('reqModalBackdrop');
    if (backdrop) backdrop.classList.remove('active');
    selectedRequestId = null;
    if (lastFocusRowBtn && typeof lastFocusRowBtn.focus === 'function') {
      try { lastFocusRowBtn.focus(); } catch (e) { /* ignore */ }
    }
  }

  function renderModal(req) {
    selectedRequestCache = req;
    var content = document.getElementById('reqModalContent');
    if (!content) return;

    var isPending = req.status === 'PENDING';
    var isInProgress = req.status === 'IN_PROGRESS';

    var html = '';
    html += '<h2>' + esc(req.issueTitle || tr('req_no_issue_title', 'Issue Report')) + '</h2>';
    html += '<div class="modal-meta">' + statusBadge(req.status) + '</div>';

    html += '<div class="detail-block"><h4>' + esc(tr('req_col_action', 'Requested Action')) + '</h4>' +
      '<div class="solution-box">' + esc(req.requestedAction) + '</div></div>';

    if (req.investigationNotes) {
      html += '<div class="detail-block"><h4>' + esc(tr('issue_investigation_notes', 'Investigation Notes')) + '</h4>' +
        '<div class="solution-box">' + esc(req.investigationNotes) + '</div>' +
        '<div class="solution-meta">' +
        esc(tr('issue_by', 'By {name}', { name: personName(req.requestedBy, tr('role_manager', 'Manager')) })) +
        ' · ' + esc(window.AdminAPI.formatDateTime(req.createdAt)) + '</div></div>';
    } else {
      html += '<div class="detail-block"><h4>' + esc(tr('issue_investigation_notes', 'Investigation Notes')) + '</h4>' +
        '<p style="color:#9ca3af;">' + esc(tr('req_no_notes', 'No investigation notes provided.')) + '</p></div>';
    }

    html += '<div class="detail-block"><h4>' + esc(tr('req_col_manager', 'Requested By')) + '</h4><p>' +
      esc(personName(req.requestedBy, tr('role_manager', 'Manager'))) + ' · ' +
      esc(window.AdminAPI.formatDateTime(req.createdAt)) + '</p></div>';

    if (req.acceptedAt) {
      html += '<div class="detail-block"><h4>' + esc(tr('req_accepted', 'Accepted By')) + '</h4><p>' +
        esc(personName(req.acceptedBy, tr('admin_cafeteria_admin', 'Cafeteria Admin'))) + ' · ' +
        esc(window.AdminAPI.formatDateTime(req.acceptedAt)) + '</p></div>';
    }
    if (req.rejectedAt) {
      html += '<div class="detail-block"><h4>' + esc(tr('req_rejected', 'Rejected By')) + '</h4><p>' +
        esc(personName(req.rejectedBy, tr('admin_cafeteria_admin', 'Cafeteria Admin'))) + ' · ' +
        esc(window.AdminAPI.formatDateTime(req.rejectedAt)) + '</p></div>';
      if (req.rejectionReason) {
        html += '<div class="detail-block"><h4>' + esc(tr('req_rejection_reason', 'Rejection Reason')) + '</h4>' +
          '<div class="solution-box">' + esc(req.rejectionReason) + '</div></div>';
      }
    }
    if (req.resolvedAt) {
      html += '<div class="detail-block"><h4>' + esc(tr('req_resolved', 'Resolved By')) + '</h4><p>' +
        esc(personName(req.resolvedBy, tr('admin_cafeteria_admin', 'Cafeteria Admin'))) + ' · ' +
        esc(window.AdminAPI.formatDateTime(req.resolvedAt)) + '</p></div>';
      if (req.resolutionNote) {
        html += '<div class="detail-block"><h4>' + esc(tr('req_resolution_note', 'Resolution Note')) + '</h4>' +
          '<div class="solution-box">' + esc(req.resolutionNote) + '</div></div>';
      }
    }

    // Action forms
    if (isPending) {
      html += '<div class="detail-block"><h4>' + esc(tr('req_note_label', 'Note (optional)')) + '</h4>' +
        '<textarea id="adminNoteInput" maxlength="1000" placeholder="' +
        esc(tr('req_note_placeholder', 'Add a note for the manager…')) + '"></textarea></div>';
      html += '<div class="modal-actions">' +
        '<button type="button" class="btn btn-secondary" id="closeReqBtn">' + esc(tr('issue_close', 'Close')) + '</button>' +
        '<button type="button" class="btn btn-danger" id="rejectReqBtn">' +
        '<i class="fa-solid fa-xmark"></i> ' + esc(tr('req_reject', 'Reject')) + '</button>' +
        '<button type="button" class="btn btn-primary" id="acceptReqBtn">' +
        '<i class="fa-solid fa-check"></i> ' + esc(tr('req_accept', 'Accept')) + '</button>' +
        '</div>';
    } else if (isInProgress) {
      html += '<div class="detail-block"><h4>' + esc(tr('req_resolution_note_label', 'Resolution Note')) + '</h4>' +
        '<textarea id="resolutionNoteInput" maxlength="2000" placeholder="' +
        esc(tr('req_resolution_note_placeholder', 'Describe how the issue was resolved…')) + '"></textarea>' +
        '<div class="form-error" id="resolveError"></div></div>';
      html += '<div class="modal-actions">' +
        '<button type="button" class="btn btn-secondary" id="closeReqBtn">' + esc(tr('issue_close', 'Close')) + '</button>' +
        '<button type="button" class="btn btn-primary" id="resolveReqBtn">' +
        '<i class="fa-solid fa-check"></i> ' + esc(tr('req_resolve', 'Mark Resolved')) + '</button>' +
        '</div>';
    } else {
      html += '<div class="modal-actions">' +
        '<button type="button" class="btn btn-secondary" id="closeReqBtn">' + esc(tr('issue_close', 'Close')) + '</button>' +
        '</div>';
    }

    content.innerHTML = html;

    var closeBtn = document.getElementById('closeReqBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    var acceptBtn = document.getElementById('acceptReqBtn');
    if (acceptBtn) acceptBtn.addEventListener('click', function () { acceptRequest(req.id, acceptBtn); });

    var rejectBtn = document.getElementById('rejectReqBtn');
    if (rejectBtn) rejectBtn.addEventListener('click', function () { rejectRequest(req.id, rejectBtn); });

    var resolveBtn = document.getElementById('resolveReqBtn');
    if (resolveBtn) resolveBtn.addEventListener('click', function () { resolveRequest(req.id, resolveBtn); });
  }

  function openRequest(reqId) {
    selectedRequestId = reqId;
    var backdrop = document.getElementById('reqModalBackdrop');
    var content = document.getElementById('reqModalContent');
    if (backdrop) backdrop.classList.add('active');
    if (content) content.innerHTML = '<div class="loading-state">' +
      '<i class="fa-solid fa-spinner fa-spin"></i> ' + esc(tr('req_loading', 'Loading requests…')) + '</div>';

    window.AdminAPI.get('/resolution-requests/' + encodeURIComponent(reqId))
      .then(function (data) {
        if (!selectedRequestId) return; // modal closed meanwhile
        renderModal((data && data.request) || {});
      })
      .catch(function (err) {
        var message = errorOf(err, tr('req_load_error', 'Could not load the request.'));
        if (content) {
          content.innerHTML = '<h2>' + esc(tr('req_details', 'Request Details')) + '</h2>' +
            '<div class="detail-block" style="color:#dc2626;">' + esc(message) + '</div>' +
            '<div class="modal-actions"><button type="button" class="btn btn-secondary" id="closeReqBtn">' +
            esc(tr('issue_close', 'Close')) + '</button></div>';
          var b = document.getElementById('closeReqBtn');
          if (b) b.addEventListener('click', closeModal);
        }
        toast('error', message);
      });
  }

  function acceptRequest(reqId, btn) {
    var noteInput = document.getElementById('adminNoteInput');
    var note = noteInput ? noteInput.value.trim() : '';
    if (btn) { btn.disabled = true; btn.textContent = tr('req_accepting', 'Accepting…'); }
    window.AdminAPI.patch('/resolution-requests/' + encodeURIComponent(reqId) + '/accept', { note: note || null })
      .then(function (data) {
        toast('success', (data && data.message) || tr('req_accepted_toast', 'Request accepted'));
        loadRequests().then(function () { openRequest(reqId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('req_accept_failed', 'Failed to accept the request.')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-check"></i> ' + esc(tr('req_accept', 'Accept'));
        }
      });
  }

  function rejectRequest(reqId, btn) {
    var noteInput = document.getElementById('adminNoteInput');
    var reason = noteInput ? noteInput.value.trim() : '';
    if (!reason) {
      toast('error', tr('req_rejection_reason_required', 'Rejection reason is required.'));
      if (noteInput) noteInput.focus();
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = tr('req_rejecting', 'Rejecting…'); }
    window.AdminAPI.patch('/resolution-requests/' + encodeURIComponent(reqId) + '/reject', { reason: reason })
      .then(function (data) {
        toast('success', (data && data.message) || tr('req_rejected_toast', 'Request rejected'));
        loadRequests().then(function () { openRequest(reqId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('req_reject_failed', 'Failed to reject the request.')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-xmark"></i> ' + esc(tr('req_reject', 'Reject'));
        }
      });
  }

  function resolveRequest(reqId, btn) {
    var noteInput = document.getElementById('resolutionNoteInput');
    var errorEl = document.getElementById('resolveError');
    var note = noteInput ? noteInput.value.trim() : '';
    if (errorEl) errorEl.textContent = '';
    if (!note) {
      if (errorEl) errorEl.textContent = tr('req_resolution_note_required', 'Resolution note is required.');
      if (noteInput) noteInput.focus();
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = tr('req_resolving', 'Resolving…'); }
    window.AdminAPI.patch('/resolution-requests/' + encodeURIComponent(reqId) + '/resolve', { note: note })
      .then(function (data) {
        toast('success', (data && data.message) || tr('req_resolved_toast', 'Request resolved and issue marked as resolved'));
        loadRequests().then(function () { openRequest(reqId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('req_resolve_failed', 'Failed to resolve the request.')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-check"></i> ' + esc(tr('req_resolve', 'Mark Resolved'));
        }
      });
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  function init() {
    var refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        loadRequests({ showLoading: true, fromRefresh: true });
      });
    }

    var tabs = document.querySelectorAll('#requestTabs .request-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        activeStatus = tab.getAttribute('data-status') || '';
        renderRequests();
      });
    });

    var backdrop = document.getElementById('reqModalBackdrop');
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
      renderRequests();
      if (selectedRequestId && selectedRequestCache) renderModal(selectedRequestCache);
    };
    var register = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
    if (typeof register === 'function') register(rerender);
    else window.addEventListener('language:changed', rerender);

    loadRequests({ showLoading: true });

    if (window.__reqTimer) clearInterval(window.__reqTimer);
    window.__reqTimer = setInterval(function () { loadRequests(); }, 45000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
