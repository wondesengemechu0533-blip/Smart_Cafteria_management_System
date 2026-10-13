/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - MANAGER ISSUE REPORTS
   ==========================================================================
   Cafeteria Manager page logic for kitchen issue reports:
     - GET    /issues                 → cafeteria-scoped list (backend enforces)
     - GET    /issues/:id             → details
     - PATCH  /issues/:id/accept      → PENDING → ACCEPTED
     - PATCH  /issues/:id/solution    → ACCEPTED → RESOLVED

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
    PENDING: 'issue_status_pending',
    ACCEPTED: 'issue_status_accepted',
    RESOLVED: 'issue_status_resolved'
  };
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
    var counts = { PENDING: 0, ACCEPTED: 0, RESOLVED: 0 };
    allIssues.forEach(function (i) {
      if (counts[i.status] !== undefined) counts[i.status]++;
    });
    var el;
    el = document.getElementById('countAll'); if (el) el.textContent = allIssues.length;
    el = document.getElementById('countPending'); if (el) el.textContent = counts.PENDING;
    el = document.getElementById('countAccepted'); if (el) el.textContent = counts.ACCEPTED;
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

    var isPending = issue.status === 'PENDING';
    var isAccepted = issue.status === 'ACCEPTED';
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

    if (issue.acceptedAt) {
      html += '<div class="detail-block"><h4>' + esc(tr('issue_title_accepted', 'Accepted')) +
        '</h4><p>' +
        esc(personName(issue.acceptedBy, tr('role_manager', 'Manager'))) + ' · ' +
        esc(window.AdminAPI.formatDateTime(issue.acceptedAt)) +
        '</p></div>';
    }

    if (isResolved && issue.solution) {
      html += '<div class="detail-block"><h4>' + esc(tr('issue_title_solution', 'Solution')) + '</h4>' +
        '<div class="solution-box">' + esc(issue.solution) + '</div>' +
        '<div class="solution-meta">' +
        esc(tr('issue_by', 'By {name}', { name: personName(issue.repliedBy, tr('role_manager', 'Manager')) })) +
        ' · ' + esc(window.AdminAPI.formatDateTime(issue.repliedAt)) + '</div></div>';
    }

    if (isPending) {
      html += '<div class="detail-block">' +
        '<button type="button" class="btn btn-primary" id="acceptIssueBtn">' +
        '<i class="fa-solid fa-check"></i> ' + esc(tr('issue_accept', 'Accept')) + '</button>' +
        '</div>';
    }

    if (isAccepted) {
      html += '<div class="detail-block"><h4>' +
        esc(tr('issue_title_send_solution', 'Send Solution / Reply')) + '</h4>' +
        '<textarea id="solutionInput" maxlength="2000" placeholder="' +
        esc(tr('issue_solution_placeholder', 'Write the solution for the kitchen staff...')) + '"></textarea>' +
        '<div class="form-error" id="solutionError"></div>' +
        '</div>';
      html += '<div class="modal-actions">' +
        '<button type="button" class="btn btn-secondary" id="closeModalBtn2">' +
        esc(tr('issue_close', 'Close')) + '</button>' +
        '<button type="button" class="btn btn-primary" id="sendSolutionBtn">' +
        '<i class="fa-solid fa-paper-plane"></i> ' + esc(tr('issue_send_solution', 'Send Solution')) + '</button>' +
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

    var acceptBtn = document.getElementById('acceptIssueBtn');
    if (acceptBtn) {
      acceptBtn.addEventListener('click', function () {
        acceptIssue(issue.id, acceptBtn);
      });
    }

    var sendBtn = document.getElementById('sendSolutionBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        sendSolution(issue.id, sendBtn);
      });
    }
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

  function acceptIssue(issueId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = tr('issue_accepting', 'Accepting…'); }
    window.AdminAPI.patch('/issues/' + encodeURIComponent(issueId) + '/accept', {})
      .then(function (data) {
        toast('success', (data && data.message) || tr('issue_accepted_toast', 'Issue report accepted'));
        loadIssues().then(function () { openIssue(issueId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('issue_accept_failed', 'Failed to accept the issue report.')));
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> ' + esc(tr('issue_accept', 'Accept')); }
      });
  }

  function sendSolution(issueId, btn) {
    var input = document.getElementById('solutionInput');
    var errorEl = document.getElementById('solutionError');
    var solution = input ? input.value.trim() : '';

    if (!solution) {
      if (errorEl) errorEl.textContent = tr('issue_solution_empty', 'Solution cannot be empty.');
      if (input) input.focus();
      return;
    }
    if (errorEl) errorEl.textContent = '';

    if (btn) { btn.disabled = true; btn.textContent = tr('issue_sending', 'Sending…'); }
    window.AdminAPI.patch('/issues/' + encodeURIComponent(issueId) + '/solution', { solution: solution })
      .then(function (data) {
        toast('success', (data && data.message) || tr('issue_solution_sent', 'Solution sent'));
        loadIssues().then(function () { openIssue(issueId); });
      })
      .catch(function (err) {
        toast('error', errorOf(err, tr('issue_solution_failed', 'Failed to send the solution.')));
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> ' + esc(tr('issue_send_solution', 'Send Solution'));
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
