/**
 * ==========================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN TABLES
 * ==========================================================================
 * Admin Table Management driven by the backend API:
 *   GET    /admin/tables        (list)
 *   GET    /admin/tables/stats  (metrics)
 *   GET    /admin/tables/:id    (details)
 *   POST   /admin/tables        (create)
 *   PUT    /admin/tables/:id    (update)
 *   PATCH  /admin/tables/:id/status (toggle active)
 *   DELETE /admin/tables/:id    (delete)
 *
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ============================================================================
 */
(function () {
  'use strict';

  var state = {
    page: 1,
    limit: 10,
    search: '',
    status: '',
    sort: 'number',
    total: 0,
    pages: 1,
  };
  var loadSeq = 0;

  var STATUS_LABELS = {
    available: 'status_available',
    occupied: 'status_occupied',
    reserved: 'status_reserved',
    maintenance: 'status_maintenance',
  };

  var STATUS_BADGES = {
    available: 'badge-success',
    occupied: 'badge-danger',
    reserved: 'badge-warning',
    maintenance: 'badge-neutral',
  };

  function tr(key, fallback, vars) {
    if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
    if (typeof window.getText === 'function') {
      var v = window.getText(key);
      if (v && v !== key) return v;
    }
    return fallback != null ? fallback : key;
  }

  function statusLabel(status) {
    if (typeof window.translateStatus === 'function') {
      var localized = window.translateStatus(status);
      if (localized && localized !== status) return localized;
    }
    var key = STATUS_LABELS[status];
    return key ? tr(key, status) : (status || '—');
  }

  function openModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('open');
  }
  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }
  function closeAllModals() {
    document.querySelectorAll('.modal-overlay.open').forEach(function (m) {
      m.classList.remove('open');
    });
  }

  async function loadStats() {
    if (!window.AdminAPI) return;
    try {
      var data = await window.AdminAPI.get('/admin/tables/stats');
      var s = (data && data.stats) || {};
      setText('metricTotalTables', s.totalTables || 0);
      setText('metricAvailableTables', s.available || 0);
      setText('metricOccupiedTables', s.occupied || 0);
      setText('metricReservedTables', s.reserved || 0);
    } catch (e) {
      /* ignore metric failures */
    }
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }

  async function loadTables() {
    var tbody = document.getElementById('tablesTableBody');
    if (!tbody || !window.AdminAPI) return;

    var seq = ++loadSeq;
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">' + tr('loading', 'Loading tables...') + '</td></tr>';

    try {
      var data = await window.AdminAPI.get('/admin/tables', {
        page: state.page,
        limit: state.limit,
        search: state.search,
        status: state.status,
        sort: state.sort,
      });
      if (seq !== loadSeq) return;

      state.total = data.total || 0;
      state.pages = data.pages || Math.max(Math.ceil(state.total / state.limit), 1);
      renderTables(data.tables || []);
      renderPagination();
      loadStats();
    } catch (error) {
      if (seq !== loadSeq) return;
      tbody.innerHTML =
        '<tr><td colspan="7" class="table-empty">' +
        window.esc(tr('error_server', 'Failed to load tables: ') + (error.message || '')) +
        '</td></tr>';
    }
  }

  function renderTables(tables) {
    var tbody = document.getElementById('tablesTableBody');
    if (!tbody) return;

    if (!tables.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">' + tr('no_data', 'No tables found.') + '</td></tr>';
      return;
    }

    tbody.innerHTML = tables
      .map(function (t) {
        var status = t.status || 'available';
        var statusBadge =
          '<span class="badge ' +
          (STATUS_BADGES[status] || 'badge-neutral') +
          '">' +
          window.esc(statusLabel(status)) +
          '</span>';
        var activeBadge =
          t.isActive !== false
            ? '<span class="badge badge-success">' + window.esc(tr('status_active', 'Active')) + '</span>'
            : '<span class="badge badge-danger">' + window.esc(tr('status_inactive', 'Inactive')) + '</span>';
        return (
          '<tr>' +
          '<td><strong>' +
          window.esc(t.tableNumber) +
          '</strong></td>' +
          '<td>' +
          Number(t.seats || 0) +
          '</td>' +
          '<td>' +
          window.esc(t.zone || '-') +
          '</td>' +
          '<td>' +
          statusBadge +
          '</td>' +
          '<td>' +
          activeBadge +
          '</td>' +
          '<td>' +
          '<div class="table-actions">' +
          '<button class="action-btn" data-action="edit" data-id="' +
          window.esc(t.id) + '" title="' + tr('edit_table', 'Edit table') + '"><i class="fa-solid fa-pen"></i></button>' +
          '<button class="action-btn" data-action="toggle" data-id="' +
          window.esc(t.id) +
          '" title="' +
          (t.isActive !== false ? tr('deactivate', 'Deactivate') : tr('activate', 'Activate')) +
          '"><i class="fa-solid ' +
          (t.isActive !== false ? 'fa-toggle-on' : 'fa-toggle-off') +
          '"></i></button>' +
          '<button class="action-btn danger" data-action="delete" data-id="' +
          window.esc(t.id) + '" title="' + tr('delete_table', 'Delete table') + '"><i class="fa-solid fa-trash"></i></button>' +
          '</div>' +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderPagination() {
    var info = document.getElementById('tablePaginationInfo');
    var prevBtn = document.getElementById('prevTablePageBtn');
    var nextBtn = document.getElementById('nextTablePageBtn');

    if (info)
      info.textContent =
        tr('page_of_tables', 'Page {page} of {pages} ({total} tables)').replace('{page}', state.page).replace('{pages}', Math.max(state.pages, 1)).replace('{total}', state.total);
    if (prevBtn) prevBtn.disabled = state.page <= 1;
    if (nextBtn) nextBtn.disabled = state.page >= state.pages;
  }

  function findTableById(id) {
    return window.AdminAPI.get('/admin/tables/' + encodeURIComponent(id))
      .then(function (d) {
        return d.table;
      })
      .catch(function () {
        return null;
      });
  }

  function openAddTableModal() {
    closeAllModals();
    var form = document.getElementById('tableForm');
    if (form) form.reset();
    document.getElementById('tableId').value = '';
    document.getElementById('tableModalTitle').textContent = tr('admin_add_table', 'Add New Table');
    document.getElementById('saveTableBtn').textContent = tr('save_table', 'Save Table');
    document.getElementById('tableIsActive').checked = true;
    document.getElementById('tableSeats').value = 4;
    document.getElementById('tableOccupancyStatus').value = 'available';
    openModal('tableModal');
  }

  function openEditTableModal(table) {
    if (!table) return;
    closeAllModals();
    var form = document.getElementById('tableForm');
    if (form) form.reset();
    document.getElementById('tableId').value = table.id || '';
    document.getElementById('tableNumber').value = table.tableNumber || '';
    document.getElementById('tableSeats').value = table.seats || 4;
    document.getElementById('tableZone').value = table.zone || '';
    document.getElementById('tableOccupancyStatus').value = table.status || 'available';
    document.getElementById('tableIsActive').checked = table.isActive !== false;
    document.getElementById('tableNotes').value = table.notes || '';
    document.getElementById('tableModalTitle').textContent = tr('admin_edit_table', 'Edit Table');
    document.getElementById('saveTableBtn').textContent = tr('update_table', 'Update Table');
    openModal('tableModal');
  }

  async function handleTableFormSubmit(event) {
    event.preventDefault();

    var id = document.getElementById('tableId').value;
    var payload = {
      tableNumber: document.getElementById('tableNumber').value.trim(),
      seats: parseInt(document.getElementById('tableSeats').value, 10) || 4,
      zone: document.getElementById('tableZone').value.trim() || 'Main Hall',
      status: document.getElementById('tableOccupancyStatus').value,
      isActive: document.getElementById('tableIsActive').checked,
      notes: document.getElementById('tableNotes').value,
    };

    if (!payload.tableNumber) {
      if (window.AdminToast) window.AdminToast.error('Table number is required');
      return;
    }

    try {
      if (!id) {
        await window.AdminAPI.post('/admin/tables', payload);
      } else {
        await window.AdminAPI.put('/admin/tables/' + encodeURIComponent(id), payload);
      }
      closeModal('tableModal');
      if (window.AdminToast) window.AdminToast.success(tr('admin_table_saved', 'Table saved successfully'));
      loadTables();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('admin_table_save_failed', 'Failed to save table'));
    }
  }

  async function toggleTableStatus(table) {
    if (!table) return;
    var nextStatus = table.isActive !== false ? false : true;
    var message = tr(
      nextStatus ? 'admin_confirm_activate_table' : 'admin_confirm_deactivate_table',
      (nextStatus ? 'Activate' : 'Deactivate') + ' table "' + table.tableNumber + '"?'
    );

    if (!window.confirm(message)) return;

    try {
      await window.AdminAPI.patch('/admin/tables/' + encodeURIComponent(table.id) + '/status', {
        isActive: nextStatus,
      });
      if (window.AdminToast)
        window.AdminToast.success(nextStatus ? tr('admin_table_activated', 'Table activated') : tr('admin_table_deactivated', 'Table deactivated'));
      loadTables();
    } catch (error) {
      if (window.AdminToast)
        window.AdminToast.error(error.message || tr('admin_table_status_update_failed', 'Failed to update table status'));
    }
  }

  async function deleteTable(table) {
    if (!table) return;
    if (!window.confirm(tr('admin_delete_table_confirm', 'Delete table "{table}"? This action cannot be undone.', { table: table.tableNumber })))
      return;

    try {
      await window.AdminAPI.del('/admin/tables/' + encodeURIComponent(table.id));
      if (window.AdminToast) window.AdminToast.success('Table deleted successfully');
      if (state.total === 1 && state.page > 1) state.page--;
      loadTables();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('admin_table_delete_failed', 'Failed to delete table'));
    }
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(self, args);
      }, wait);
    };
  }

  function bindEvents() {
    var openBtn = document.getElementById('openAddTableBtn');
    if (openBtn) openBtn.addEventListener('click', openAddTableModal);

    var form = document.getElementById('tableForm');
    if (form) form.addEventListener('submit', handleTableFormSubmit);

    var searchInput = document.getElementById('tableSearchInput');
    if (searchInput) {
      searchInput.addEventListener(
        'input',
        debounce(function () {
          state.search = searchInput.value.trim();
          state.page = 1;
          loadTables();
        }, 400)
      );
    }

    var statusFilter = document.getElementById('tableStatusFilter');
    if (statusFilter) {
      statusFilter.addEventListener('change', function () {
        state.status = statusFilter.value;
        state.page = 1;
        loadTables();
      });
    }

    var sortFilter = document.getElementById('tableSortFilter');
    if (sortFilter) {
      sortFilter.addEventListener('change', function () {
        state.sort = sortFilter.value;
        state.page = 1;
        loadTables();
      });
    }

    var resetBtn = document.getElementById('resetTableFiltersBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        state.search = '';
        state.status = '';
        state.sort = 'number';
        state.page = 1;
        if (searchInput) searchInput.value = '';
        if (statusFilter) statusFilter.value = '';
        if (sortFilter) sortFilter.value = 'number';
        loadTables();
      });
    }

    var prevBtn = document.getElementById('prevTablePageBtn');
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        if (state.page > 1) {
          state.page--;
          loadTables();
        }
      });
    }

    var nextBtn = document.getElementById('nextTablePageBtn');
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        if (state.page < state.pages) {
          state.page++;
          loadTables();
        }
      });
    }

    var tbody = document.getElementById('tablesTableBody');
    if (tbody) {
      tbody.addEventListener('click', async function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var id = btn.getAttribute('data-id');
        var action = btn.getAttribute('data-action');
        if (!id) return;
        var table = await findTableById(id);
        if (!table) {
          if (window.AdminToast) window.AdminToast.error('Table not found');
          return;
        }
        if (action === 'edit') openEditTableModal(table);
        else if (action === 'toggle') toggleTableStatus(table);
        else if (action === 'delete') deleteTable(table);
      });
    }

    document.addEventListener('click', function (e) {
      var closeBtn = e.target.closest('[data-close-modal]');
      if (closeBtn) closeModal(closeBtn.getAttribute('data-close-modal'));
    });
  }

  var initialized = false;

  function init() {
    if (initialized) return;
    if (!window.AdminAPI) return;
    initialized = true;
    bindEvents();
    loadTables();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
