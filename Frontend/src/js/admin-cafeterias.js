function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ==========================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN CAFETERIAS
 * ==========================================================================
 * System admin cafeteria management driven by the backend API:
 *   GET    /cafeterias              (list)
 *   GET    /cafeterias/:id/stats    (staff count)
 *   POST   /cafeterias              (create)
 *   PUT    /cafeterias/:id          (update)
 *   POST   /cafeterias/bootstrap    (ensure default)
 *
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ============================================================================
 */
(function () {
  'use strict';

  var state = {
    search: '',
    status: '',
    cafeterias: [],
    staffById: {},
  };

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

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }

  function loadStats() {
    var total = state.cafeterias.length;
    var active = 0;
    var inactive = 0;
    var staff = 0;
    state.cafeterias.forEach(function (c) {
      if ((c.status || 'ACTIVE') === 'ACTIVE') active++;
      else inactive++;
      if (state.staffById[c.id]) staff += Number(state.staffById[c.id]) || 0;
    });
    setText('metricTotalCafeterias', total);
    setText('metricActiveCafeterias', active);
    setText('metricInactiveCafeterias', inactive);
    setText('metricStaffCafeterias', staff);
  }

  function filteredCafeterias() {
    var q = state.search.toLowerCase();
    return state.cafeterias.filter(function (c) {
      if (state.status && (c.status || 'ACTIVE') !== state.status) return false;
      if (!q) return true;
      return (
        String(c.name || '')
          .toLowerCase()
          .indexOf(q) !== -1 ||
        String(c.code || '')
          .toLowerCase()
          .indexOf(q) !== -1 ||
        String(c.address || '')
          .toLowerCase()
          .indexOf(q) !== -1
      );
    });
  }

  async function loadCafeterias() {
    var tbody = document.getElementById('cafeteriasTableBody');
    if (!tbody || !window.AdminAPI) return;

    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">'+tr('loading_cafeterias','Loading cafeterias...')+'</td></tr>';

    try {
      var data = await window.AdminAPI.get('/cafeterias');
      state.cafeterias = data.cafeterias || [];

      // Best-effort staff counts (non-blocking)
      state.staffById = {};
      await Promise.all(
        state.cafeterias.map(function (c) {
          return window.AdminAPI.get('/cafeterias/' + encodeURIComponent(c.id) + '/stats')
            .then(function (d) {
              if (d && d.stats) state.staffById[c.id] = d.stats.staffUsers || 0;
            })
            .catch(function () {
              /* ignore */
            });
        })
      );

      renderCafeterias();
      loadStats();
    } catch (error) {
      tbody.innerHTML =
        '<tr><td colspan="9" class="table-empty">Failed to load cafeterias: ' +
        window.esc(error.message || tr('server_error', 'Server error')) +
        '</td></tr>';
    }
  }

  function renderCafeterias() {
    var tbody = document.getElementById('cafeteriasTableBody');
    if (!tbody) return;

    var list = filteredCafeterias();
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="table-empty">'+tr('no_cafeterias','No cafeterias found.')+'</td></tr>';
      return;
    }

    tbody.innerHTML = list
      .map(function (c) {
        var status =
          (c.status || 'ACTIVE') === 'ACTIVE'
            ? '<span class="badge badge-success">Active</span>'
            : '<span class="badge badge-danger">Inactive</span>';
        var defaultBadge = c.isDefault
          ? '<span class="badge badge-primary">Default</span>'
          : '<span class="badge badge-neutral">—</span>';
        var hours = window.esc((c.openingTime || '07:00') + ' – ' + (c.closingTime || '22:00'));
        var staff = state.staffById[c.id] != null ? state.staffById[c.id] : '—';
        return (
          '<tr>' +
          '<td><strong>' +
          window.esc(c.name) +
          '</strong></td>' +
          '<td>' +
          window.esc(c.code || '-') +
          '</td>' +
          '<td>' +
          window.esc(c.address || '-') +
          '</td>' +
          '<td>' +
          window.esc(c.phone || '-') +
          '</td>' +
          '<td>' +
          hours +
          '</td>' +
          '<td>' +
          status +
          '</td>' +
          '<td>' +
          defaultBadge +
          '</td>' +
          '<td>' +
          staff +
          '</td>' +
          '<td>' +
          '<div class="table-actions">' +
          '<button class="action-btn" data-action="edit" data-id="' +
          window.esc(c.id) +
          '" title="' + tr('edit', 'Edit') + '"><i class="fa-solid fa-pen"></i></button>' +
          '<button class="action-btn" data-action="toggle" data-id="' +
          window.esc(c.id) +
          '" title="' +
          ((c.status || 'ACTIVE') === 'ACTIVE' ? tr('deactivate', 'Deactivate') : tr('activate', 'Activate')) +
          '"><i class="fa-solid ' +
          ((c.status || 'ACTIVE') === 'ACTIVE' ? 'fa-toggle-on' : 'fa-toggle-off') +
          '"></i></button>' +
          '</div>' +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function openAddCafeteriaModal() {
    closeAllModals();
    var form = document.getElementById('cafeteriaForm');
    if (form) form.reset();
    document.getElementById('cafeteriaId').value = '';
    document.getElementById('cafeteriaModalTitle').textContent = tr('add_new_cafeteria', 'Add New Cafeteria');
    document.getElementById('saveCafeteriaBtn').textContent = tr('save_cafeteria', 'Save Cafeteria');
    document.getElementById('cafeteriaStatus').value = 'ACTIVE';
    document.getElementById('cafeteriaOpeningTime').value = '07:00';
    document.getElementById('cafeteriaClosingTime').value = '22:00';
    openModal('cafeteriaModal');
  }

  function findCafeteriaById(id) {
    return state.cafeterias.find(function (c) {
      return c.id === id;
    });
  }

  function openEditCafeteriaModal(cafeteria) {
    if (!cafeteria) return;
    closeAllModals();
    var form = document.getElementById('cafeteriaForm');
    if (form) form.reset();
    document.getElementById('cafeteriaId').value = cafeteria.id || '';
    document.getElementById('cafeteriaName').value = cafeteria.name || '';
    document.getElementById('cafeteriaCode').value = cafeteria.code || '';
    document.getElementById('cafeteriaAddress').value = cafeteria.address || '';
    document.getElementById('cafeteriaPhone').value = cafeteria.phone || '';
    document.getElementById('cafeteriaEmail').value = cafeteria.email || '';
    document.getElementById('cafeteriaStatus').value = cafeteria.status || 'ACTIVE';
    document.getElementById('cafeteriaOpeningTime').value = cafeteria.openingTime || '07:00';
    document.getElementById('cafeteriaClosingTime').value = cafeteria.closingTime || '22:00';
    document.getElementById('cafeteriaModalTitle').textContent = tr('edit_cafeteria', 'Edit Cafeteria');
    document.getElementById('saveCafeteriaBtn').textContent = tr('update_cafeteria', 'Update Cafeteria');
    openModal('cafeteriaModal');
  }

  async function handleCafeteriaFormSubmit(event) {
    event.preventDefault();

    var id = document.getElementById('cafeteriaId').value;
    var payload = {
      name: document.getElementById('cafeteriaName').value.trim(),
      code: document.getElementById('cafeteriaCode').value.trim() || undefined,
      address: document.getElementById('cafeteriaAddress').value.trim(),
      phone: document.getElementById('cafeteriaPhone').value.trim(),
      email: document.getElementById('cafeteriaEmail').value.trim() || undefined,
      status: document.getElementById('cafeteriaStatus').value,
      openingTime: document.getElementById('cafeteriaOpeningTime').value,
      closingTime: document.getElementById('cafeteriaClosingTime').value,
    };

    if (!payload.name) {
      if (window.AdminToast) window.AdminToast.error(tr('cafeteria_name_required', 'Cafeteria name is required'));
      return;
    }

    try {
      if (!id) {
        await window.AdminAPI.post('/cafeterias', payload);
      } else {
        await window.AdminAPI.put('/cafeterias/' + encodeURIComponent(id), payload);
      }
      closeModal('cafeteriaModal');
      if (window.AdminToast) window.AdminToast.success(tr('cafeteria_saved', 'Cafeteria saved successfully'));
      loadCafeterias();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_save_cafeteria', 'Failed to save cafeteria'));
    }
  }

  async function toggleCafeteriaStatus(cafeteria) {
    if (!cafeteria) return;
    var nextStatus = (cafeteria.status || 'ACTIVE') === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    var message =
      (nextStatus === 'INACTIVE' ? tr('deactivate', 'Deactivate') : tr('activate', 'Activate')) + ' cafeteria "' + cafeteria.name + '"?';

    if (!window.confirm(message)) return;

    try {
      await window.AdminAPI.put('/cafeterias/' + encodeURIComponent(cafeteria.id), {
        status: nextStatus,
      });
      if (window.AdminToast)
        window.AdminToast.success(nextStatus === 'ACTIVE' ? tr('cafeteria_activated', 'Cafeteria activated') : tr('cafeteria_deactivated', 'Cafeteria deactivated'));
      loadCafeterias();
    } catch (error) {
      if (window.AdminToast)
        window.AdminToast.error(error.message || tr('error_update_cafeteria_status', 'Failed to update cafeteria status'));
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
    var openBtn = document.getElementById('openAddCafeteriaBtn');
    if (openBtn) openBtn.addEventListener('click', openAddCafeteriaModal);

    var form = document.getElementById('cafeteriaForm');
    if (form) form.addEventListener('submit', handleCafeteriaFormSubmit);

    var searchInput = document.getElementById('cafeteriaSearchInput');
    if (searchInput) {
      searchInput.addEventListener(
        'input',
        debounce(function () {
          state.search = searchInput.value.trim();
          renderCafeterias();
        }, 400)
      );
    }

    var statusFilter = document.getElementById('cafeteriaStatusFilter');
    if (statusFilter) {
      statusFilter.addEventListener('change', function () {
        state.status = statusFilter.value;
        renderCafeterias();
      });
    }

    var resetBtn = document.getElementById('resetCafeteriaFiltersBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        state.search = '';
        state.status = '';
        if (searchInput) searchInput.value = '';
        if (statusFilter) statusFilter.value = '';
        renderCafeterias();
      });
    }

    var tbody = document.getElementById('cafeteriasTableBody');
    if (tbody) {
      tbody.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var id = btn.getAttribute('data-id');
        var action = btn.getAttribute('data-action');
        if (!id) return;
        var cafeteria = findCafeteriaById(id);
        if (!cafeteria) {
          if (window.AdminToast) window.AdminToast.error(tr('cafeteria_not_found', 'Cafeteria not found'));
          return;
        }
        if (action === 'edit') openEditCafeteriaModal(cafeteria);
        else if (action === 'toggle') toggleCafeteriaStatus(cafeteria);
      });
    }

    document.addEventListener('click', function (e) {
      var closeBtn = e.target.closest('[data-close-modal]');
      if (closeBtn) closeModal(closeBtn.getAttribute('data-close-modal'));
    });
  }

  function init() {
    if (!window.AdminAPI) return;
    bindEvents();
    loadCafeterias();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
