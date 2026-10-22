function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN ACTIVITY LOG
 * ================================================================
 * Audit trail page driven by the backend:
 *   GET /admin/activity-logs
 *   Supports: search, action, entity, start/end date + pagination.
 *
 * Note: the backend never stores passwords, tokens or secrets.
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ================================================================
 */
(function () {
  'use strict';

  function t(key) {
    if (window.t) {
      var resolved = window.t(key);
      if (resolved && resolved !== key) return resolved;
    }
    return key;
  }

  var state = {
    page: 1,
    limit: 20,
    search: '',
    role: 'all',
    action: 'all',
    entity: '',
    startDate: '',
    endDate: '',
  };

  var ACTION_LABELS = {
    ADMIN_LOGIN: 'Admin Login',
    LOGIN: 'Login',
    LOGIN_FAILED: 'Login Failed',
    LOGOUT: 'Logout',
    REGISTRATION: 'Registration',
    PASSWORD_RESET: 'Password Reset',
    PASSWORD_CHANGED: 'Password Changed',
    USER_CREATED: 'User Created',
    USER_UPDATED: 'User Updated',
    USER_ACTIVATED: 'User Activated',
    USER_DEACTIVATED: 'User Deactivated',
    USER_DELETED: 'User Deleted',
    ROLE_CHANGED: 'Role Changed',
    FOOD_CREATED: 'Food Created',
    FOOD_UPDATED: 'Food Updated',
    FOOD_DELETED: 'Food Deleted',
    FOOD_AVAILABILITY_CHANGED: 'Availability Changed',
    ORDER_CREATED: 'Order Created',
    ORDER_STATUS_CHANGED: 'Order Status Changed',
    ORDER_STATUS_UPDATED: 'Order Status Updated',
    ORDER_CANCELLED: 'Order Cancelled',
    ORDER_REFUNDED: 'Order Refunded',
    CANCELLATION_REQUESTED: 'Cancellation Requested',
    CANCELLATION_AUTO_FULFILLED: 'Cancellation Auto-fulfilled',
    CANCELLATION_APPROVED: 'Cancellation Approved',
    CANCELLATION_REJECTED: 'Cancellation Rejected',
    CATEGORY_CREATED: 'Category Created',
    CATEGORY_UPDATED: 'Category Updated',
    CATEGORY_STATUS_CHANGED: 'Category Status Changed',
    CATEGORY_DELETED: 'Category Deleted',
    SETTINGS_UPDATED: 'Settings Updated',
    'settings.update': 'Settings Updated',
    'auth.password.change': 'Password Changed',
    PAYMENT_CREATED: 'Payment Created',
    PAYMENT_VERIFIED: 'Payment Verified',
    PAYMENT_FAILED: 'Payment Failed',
    PAYMENT_REFUND_INITIATED: 'Payment Refund Initiated',
    CASHIER_PAYMENT_CONFIRMED: 'Payment Confirmed',
    CASHIER_RECEIPT_GENERATED: 'Receipt Generated',
    REFUND_REQUESTED: 'Refund Requested',
    REFUND_APPROVED: 'Refund Approved',
    REFUND_REJECTED: 'Refund Rejected',
    REFUND_COMPLETED: 'Refund Completed',
    REFUND_CONFIRMED: 'Refund Confirmed',
    REFUND_FAILED: 'Refund Failed',
    DELIVERY_ASSIGNED: 'Delivery Assigned',
    DELIVERY_ACCEPTED: 'Delivery Accepted',
    DELIVERY_PICKED_UP: 'Delivery Picked Up',
    DELIVERY_OUT_FOR_DELIVERY: 'Out for Delivery',
    DELIVERY_ARRIVED: 'Delivery Arrived',
    DELIVERY_DELIVERED: 'Delivered',
    // Emitted by the delivery state machine (DELIVERED -> COMPLETED) but was
    // missing here, so those rows rendered as a raw action name.
    DELIVERY_COMPLETED: 'Delivery Completed',
    // Also emitted by the reassignment flow.
    DELIVERY_REASSIGNED: 'Delivery Reassigned',
    DELIVERY_CANCELLED: 'Delivery Cancelled',
    // Emitted by the delivery-issue controller. These were unlabelled, so every
    // issue a courier reported showed up in the activity log as a raw key.
    DELIVERY_ISSUE_REPORTED: 'Delivery Problem Reported',
    DELIVERY_ISSUE_HOLD: 'Delivery Put On Hold',
    DELIVERY_ISSUE_REASSIGN: 'Delivery Reassigned After Issue',
    DELIVERY_ISSUE_CANCEL_DELIVERY: 'Delivery Cancelled After Issue',
    FEEDBACK_SUBMITTED: 'Feedback Submitted',
    FEEDBACK_UPDATED: 'Feedback Updated',
    TAX_REPORT_ACCESSED: 'Tax Report Accessed',
  };

  function actionClass(action) {
    if (!action) return 'act-other';
    if (action.indexOf('ADMIN_LOGIN') === 0) return 'act-login';
    if (action.indexOf('USER_') === 0) return 'act-user';
    if (action.indexOf('FOOD_') === 0) return 'act-food';
    if (action.indexOf('ORDER_') === 0) return 'act-order';
    if (action.indexOf('CATEGORY_') === 0) return 'act-category';
    if (action.indexOf('ROLE_') === 0) return 'act-user';
    if (action.indexOf('SETTINGS_') === 0 || action === 'settings.update' || action === 'auth.password.change')
      return 'act-setting';
    return 'act-other';
  }

  function actionLabel(action) {
    if (ACTION_LABELS[action]) {
      var key = 'activity_' + String(ACTION_LABELS[action]).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      var loc = t(key);
      if (loc && loc !== key) return loc;
      return ACTION_LABELS[action];
    }
    if (!action) return '-';
    return String(action)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function getQuery() {
    var params = '?page=' + state.page + '&limit=' + state.limit;
    if (state.search) params += '&search=' + encodeURIComponent(state.search);
    if (state.role && state.role !== 'all') params += '&role=' + encodeURIComponent(state.role);
    if (state.action && state.action !== 'all') params += '&action=' + encodeURIComponent(state.action);
    if (state.entity) params += '&entityType=' + encodeURIComponent(state.entity);
    if (state.startDate) params += '&startDate=' + encodeURIComponent(state.startDate);
    if (state.endDate) params += '&endDate=' + encodeURIComponent(state.endDate);
    return params;
  }

  function setLoading(loading) {
    var refreshBtn = document.getElementById('refreshLogsBtn');
    if (refreshBtn) {
      refreshBtn.disabled = loading;
      var icon = refreshBtn.querySelector('i');
      if (icon) icon.className = loading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-rotate';
    }
  }

  function showTableLoading() {
    var tbody = document.getElementById('logsTableBody');
    if (tbody) {
      tbody.innerHTML =
        '<tr><td colspan="10" class="table-empty">' + window.esc(t('admin_loading_logs')) + '</td></tr>';
    }
  }

  var logsLoading = false;
  async function loadLogs(showLoader) {
    if (showLoader) {
      if (logsLoading) return;
      logsLoading = true;
      setLoading(true);
      showTableLoading();
    }
    try {
      var data = await window.AdminAPI.get('/admin/activity-logs' + getQuery());
      populateActions(data.availableActions);
      var logs = data.logs || [];
      renderLogs(logs);
      renderPagination(data.total || 0, data.pages || 0);
    } catch (error) {
      var tbody = document.getElementById('logsTableBody');
      if (tbody) {
        tbody.innerHTML =
          '<tr><td colspan="10" class="table-empty">' +
          window.esc(t('admin_logs_load_failed')) +
          ': ' +
          window.esc(error.message || t('server_error')) +
          '</td></tr>';
      }
      if (window.AdminToast) window.AdminToast.error(error.message || t('admin_logs_load_failed'));
    } finally {
      if (showLoader) {
        logsLoading = false;
        setLoading(false);
      }
    }
  }

  function populateActions(actions) {
    var select = document.getElementById('logActionFilter');
    if (!select || !actions || !actions.length) return;
    var current = select.value;
    select.innerHTML =
      '<option value="all">' +
      window.esc(t('admin_all_actions')) +
      '</option>' +
      actions
        .map(function (action) {
          return '<option value="' + window.esc(action) + '">' + window.esc(actionLabel(action)) + '</option>';
        })
        .join('');
    if (current && current !== 'all') select.value = current;
  }

  function resultBadge(result) {
    var cls = 'order-badge muted';
    var label = result || '-';
    switch (String(result || '').toUpperCase()) {
      case 'SUCCESS':
        cls = 'order-badge cmp';
        break;
      case 'FAILED':
        cls = 'order-badge cxl';
        break;
      case 'PENDING':
        cls = 'order-badge pend';
        break;
    }
    return '<span class="' + cls + '">' + window.esc(label) + '</span>';
  }

  function rolePill(role) {
    var r = String(role || '').toLowerCase();
    var cls = 'rp-customer';
    if (r === 'admin' || r === 'system_admin') cls = 'rp-admin';
    else if (r === 'system') cls = 'rp-system';
    else if (r === 'manager' || r === 'cafeteria_manager' || r === 'cafeteria_admin') cls = 'rp-manager';
    else if (r === 'cashier' || r === 'kitchen' || r === 'delivery') cls = 'rp-staff';
    var label;
    if (r === 'admin' || r === 'system_admin' || r === 'system') label = tr('role_system_admin', 'System Admin');
    else if (r === 'manager' || r === 'cafeteria_manager') label = tr('role_cafeteria_manager', 'Cafeteria Manager');
    // 'cafeteria_admin' is a legacy alias of 'manager' (see config/roles.js), so
    // it renders as Cafeteria Manager instead of a separate Cafeteria Admin
    // role that no longer exists.
    else if (r === 'cafeteria_admin') label = tr('role_cafeteria_manager', 'Cafeteria Manager');
    else if (r === 'kitchen') label = tr('admin_user_role_kitchen', 'Kitchen Staff');
    else if (r === 'delivery') label = tr('role_delivery', 'Delivery Staff');
    else if (r === 'cashier') label = tr('role_cashier', 'Cashier');
    else if (r === 'customer') label = tr('role_customer', 'Customer');
    else label = r ? r.replace(/_/g, ' ') : '-';
    return '<span class="role-pill ' + cls + '">' + window.esc(label) + '</span>';
  }

  function timeCell(timestamp) {
    if (!timestamp) return '<span class="log-time">-</span>';
    var d = new Date(timestamp);
    if (isNaN(d.getTime())) return '<span class="log-time">-</span>';
    var date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    var time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return (
      '<span class="log-time"><span class="log-date">' +
      window.esc(date) +
      '</span><span class="log-clock">' +
      window.esc(time) +
      '</span></span>'
    );
  }

  function renderLogs(logs) {
    var tbody = document.getElementById('logsTableBody');
    if (!tbody) return;

    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="table-empty">' + window.esc(t('admin_no_logs')) + '</td></tr>';
      return;
    }

    tbody.innerHTML = logs
      .map(function (log) {
        var rawName = log.adminName || 'System';
        var initial = String(rawName).trim().charAt(0).toUpperCase() || 'S';
        var rawEmail = log.adminEmail || '-';
        var entityType = log.entityType || '';
        var rawEntityId = log.entityId || '-';
        var description = window.esc(log.description || '-');
        var ip = window.esc(log.ip || '-');
        return (
          '<tr>' +
          '<td><div class="log-agent"><span class="log-avatar">' +
          window.esc(initial) +
          '</span><span class="log-name">' +
          window.esc(rawName) +
          '</span></div></td>' +
          '<td class="log-email" title="' +
          window.esc(rawEmail) +
          '">' +
          window.esc(rawEmail) +
          '</td>' +
          '<td>' +
          rolePill(log.actorRole || log.adminRole) +
          '</td>' +
          '<td><span class="action-badge ' +
          actionClass(log.action) +
          '">' +
          window.esc(actionLabel(log.action)) +
          '</span></td>' +
          '<td>' +
          (entityType ? '<span class="entity-pill">' + window.esc(entityType) + '</span>' : '-') +
          '</td>' +
          '<td class="mono-ref" title="' +
          window.esc(rawEntityId) +
          '">' +
          window.esc(rawEntityId) +
          '</td>' +
          '<td class="log-desc">' +
          description +
          '</td>' +
          '<td>' +
          resultBadge(log.result) +
          '</td>' +
          '<td class="mono-ref log-ip">' +
          ip +
          '</td>' +
          '<td>' +
          timeCell(log.timestamp) +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderPagination(total, pages) {
    var info = document.getElementById('logsPaginationInfo');
    if (info) {
      info.textContent = t('page_records') ? t('page_records').replace('{page}', state.page).replace('{pages}', Math.max(state.pages || 1, 1)).replace('{total}', state.total || 0) : ('Page ' + state.page + ' of ' + (state.pages || 1) + ' (' + (state.total || 0) + ' records)')
        .replace('{page}', state.page)
        .replace('{pages}', pages || 1)
        .replace('{total}', total);
    }

    var prev = document.getElementById('prevLogsBtn');
    var next = document.getElementById('nextLogsBtn');
    if (prev) prev.disabled = state.page <= 1;
    if (next) next.disabled = state.page >= (pages || 1);
  }

  function syncFilters() {
    state.search = document.getElementById('logSearchInput').value.trim();
    state.role = document.getElementById('logRoleFilter').value;
    state.action = document.getElementById('logActionFilter').value;
    state.entity = document.getElementById('logEntityFilter').value;
    state.startDate = document.getElementById('logStartDate').value;
    state.endDate = document.getElementById('logEndDate').value;
    state.page = 1;
  }

  function resetFilters() {
    document.getElementById('logSearchInput').value = '';
    document.getElementById('logRoleFilter').value = 'all';
    document.getElementById('logActionFilter').value = 'all';
    document.getElementById('logEntityFilter').value = '';
    document.getElementById('logStartDate').value = '';
    document.getElementById('logEndDate').value = '';
    syncFilters();
    loadLogs(true);
  }

  function bindEvents() {
    var searchInput = document.getElementById('logSearchInput');
    if (searchInput) {
      searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          state.search = searchInput.value.trim();
          state.page = 1;
          loadLogs(true);
        }
      });
    }

    ['logRoleFilter', 'logActionFilter', 'logEntityFilter', 'logStartDate', 'logEndDate'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', function () {
          syncFilters();
          loadLogs(true);
        });
      }
    });

    var resetBtn = document.getElementById('resetLogFiltersBtn');
    if (resetBtn) resetBtn.addEventListener('click', resetFilters);

    var prevBtn = document.getElementById('prevLogsBtn');
    if (prevBtn)
      prevBtn.addEventListener('click', function () {
        if (state.page > 1) {
          state.page -= 1;
          loadLogs(true);
        }
      });

    var nextBtn = document.getElementById('nextLogsBtn');
    if (nextBtn)
      nextBtn.addEventListener('click', function () {
        state.page += 1;
        loadLogs(true);
      });

    var refreshBtn = document.getElementById('refreshLogsBtn');
    if (refreshBtn)
      refreshBtn.addEventListener('click', function () {
        loadLogs(true);
      });
  }

  function init() {
    bindEvents();
    loadLogs();
    ['languageChanged', 'language:changed'].forEach(function (evt) {
      window.addEventListener(evt, function () {
        loadLogs();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
