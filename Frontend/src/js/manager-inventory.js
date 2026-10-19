/**
 * ==========================================================================
   SMART CAFETERIA ORDERING SYSTEM - MANAGER INVENTORY
   ==========================================================================
   Cafeteria Manager "Inventory" page logic:
      - GET   /admin/menu?limit=100          → inventory list (MongoDB)
      - GET   /admin/menu/:id                → load ONE item's real data for Edit
      - GET   /categories                    → category options for the Edit form
      - PUT   /admin/menu/:id                → Edit + Restock / Update Quantity
      - GET   /kitchen/stock-alerts          → active LOW STOCK / OUT OF STOCK
        alerts; a resolved alert is cleared automatically by the backend only
        when the ACTUAL quantity rises above the configured minimum stock rule.
        Alert history is preserved (status transitions, never deletion).

   Stock status (computed server-side in `sanitize` and re-derived here so the
   table stays consistent with the database):
      quantity == 0         → OUT OF STOCK
      quantity <= minimum   → LOW STOCK
      quantity >  minimum   → IN STOCK

   ACTION COLUMN CONTRACT (regression fix):
   The Actions cell is rendered UNCONDITIONALLY for every row, for every stock
   status (IN STOCK, LOW STOCK, OUT OF STOCK). There is no status-based branch
   that can drop the buttons. Click handling is delegated from the table body,
   so every button always resolves the row's MongoDB `_id` (data-id) — even
   after a re-render — and opens the correct modal with the item's real data.
   Buttons are only shown to roles the backend actually authorizes; the server
   still enforces authorization on every write.

   Real-time: `stock:alert` / `stock:alert:updated` events refresh the table
   and alert summary so no manual reload is needed after quantity changes.
   ========================================================================== */
(function () {
  'use strict';

  if (!window.AdminAPI) return;

  var tr = function (key, fallback) {
    if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback);
    return fallback != null ? fallback : key;
  };

  // Roles the backend PUT /admin/menu/:id route actually authorizes.
  var EDIT_ROLES = ['admin', 'system_admin', 'cafeteria_admin', 'manager', 'kitchen'];
  var ACTION_COLS = 6; // Item | Category | Current Quantity | Min Stock | Status | Actions

  var allItems = [];
  var activeAlerts = [];
  var categories = [];
  var search = '';
  var statusFilter = '';
  var searchTimer = null;

  function esc(v) {
    return window.AdminAPI.esc(v);
  }

  function toast(type, message) {
    if (window.AdminToast && window.AdminToast[type]) window.AdminToast[type](message);
  }

  function errorOf(err, fallback) {
    return err && err.message ? err.message : fallback;
  }

  function normalizedRole() {
    var role = '';
    if (window.ScosRoles && window.ScosRoles.getCurrentRole) role = window.ScosRoles.getCurrentRole();
    if (!role) {
      try {
        var cu = JSON.parse(localStorage.getItem('current_user') || 'null');
        if (cu && cu.role) role = cu.role;
      } catch (e) { /* ignore */ }
    }
    if (!role) role = localStorage.getItem('userRole') || localStorage.getItem('role') || '';
    role = String(role).toLowerCase();
    if (window.ScosRoles && window.ScosRoles.normalizeRole) {
      var n = window.ScosRoles.normalizeRole(role);
      if (n) return n;
    }
    return role;
  }

  function canManageInventory() {
    return EDIT_ROLES.indexOf(normalizedRole()) !== -1;
  }

  // ------------------------------------------------------------------
  // Stock status derivation (mirrors the backend getStockStatus rule)
  // ------------------------------------------------------------------
  function deriveStockStatus(item) {
    var quantity = Math.max(0, Number(item.stockQuantity) || 0);
    var min = Math.max(0, Number(item.lowStockThreshold) || 0);
    if (quantity === 0) return 'OUT_OF_STOCK';
    if (quantity <= min) return 'LOW_STOCK';
    return 'IN_STOCK';
  }

  function statusOf(item) {
    return item.stockStatus || deriveStockStatus(item);
  }

  function statusBadge(status) {
    var cls = status === 'OUT_OF_STOCK' ? 'out' : status === 'LOW_STOCK' ? 'low' : 'in';
    var label = status === 'OUT_OF_STOCK' ? 'OUT OF STOCK' : status === 'LOW_STOCK' ? 'LOW STOCK' : 'IN STOCK';
    return '<span class="stock-level-badge stock-level-' + cls + '">' + esc(label) + '</span>';
  }

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------
  function loadInventory() {
    return window.AdminAPI.get('/admin/menu', { limit: 100 })
      .then(function (data) {
        allItems = (data && data.items) || [];
        renderInventory();
      })
      .catch(function (err) {
        var body = document.getElementById('inventoryTableBody');
        if (body)
          body.innerHTML =
            '<tr><td colspan="' + ACTION_COLS + '" class="inv-empty"><i class="fa-solid fa-triangle-exclamation"></i>' +
            esc(errorOf(err, tr('error_server', 'Server error'))) +
            '</td></tr>';
      });
  }

  function loadActiveAlerts() {
    return window.AdminAPI.get('/kitchen/stock-alerts', { status: 'active' })
      .then(function (data) {
        var list = (data && data.alerts) || [];
        activeAlerts = list.filter(function (a) {
          return a.status === 'active' && (a.alertType === 'low_stock' || a.alertType === 'out_of_stock');
        });
        renderActiveAlerts();
      })
      .catch(function () {
        activeAlerts = [];
        renderActiveAlerts();
      });
  }

  function loadCategories() {
    return window.AdminAPI.get('/categories')
      .then(function (data) {
        categories = (data && data.categories) || [];
      })
      .catch(function () {
        categories = [];
      });
  }

  function refreshAll() {
    loadInventory();
    loadActiveAlerts();
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function updateStats() {
    var total = allItems.length;
    var inStock = 0;
    var low = 0;
    var out = 0;
    allItems.forEach(function (item) {
      var status = statusOf(item);
      if (status === 'OUT_OF_STOCK') out++;
      else if (status === 'LOW_STOCK') low++;
      else inStock++;
    });
    document.getElementById('statTotal').textContent = String(total);
    document.getElementById('statInStock').textContent = String(inStock);
    document.getElementById('statLowStock').textContent = String(low);
    document.getElementById('statOutOfStock').textContent = String(out);
  }

  function renderActiveAlerts() {
    var box = document.getElementById('activeAlertsBox');
    if (!box) return;
    if (!activeAlerts.length) {
      box.innerHTML =
        '<div class="active-alert-line" style="background:#ecfdf5;border-color:#a7f3d0;color:#065f46;">' +
        '<i class="fa-solid fa-circle-check"></i> No active stock alerts — all items satisfy their minimum stock rules.</div>';
      return;
    }
    var rows = activeAlerts
      .map(function (a) {
        return (
          '<div class="active-alert-line"><i class="fa-solid fa-bell"></i> ' +
          '<div><strong>' + esc(a.itemName || 'Item') + '</strong> — ' +
          esc(a.alertType === 'out_of_stock' ? 'OUT OF STOCK' : 'LOW STOCK') + ' of ' +
          esc(a.reason || '') + '</div></div>'
        );
      })
      .join('');
    box.innerHTML =
      '<div style="margin-bottom:20px;"><h3 style="margin:0 0 8px;font-size:0.95rem;color:#92400e;">' +
      '<i class="fa-solid fa-bell"></i> Active Stock Alerts (' + activeAlerts.length + ')</h3>' + rows + '</div>';
  }

  function filteredItems() {
    var s = search.toLowerCase();
    return allItems.filter(function (item) {
      var name = (item.name && (item.name.en || '')) || '';
      var category = item.category || '';
      var status = statusOf(item);
      if (s && name.toLowerCase().indexOf(s) === -1 && category.toLowerCase().indexOf(s) === -1) return false;
      if (statusFilter && status !== statusFilter) return false;
      return true;
    });
  }

  /**
   * Build the Actions cell. ALWAYS returns a fully-populated cell for every
   * status — this is the regression fix. The only variation is whether the
   * viewer is authorized to manage inventory (permissions are never bypassed:
   * the backend re-checks authorization on every write).
   */
  function actionsCell(item) {
    var id = esc(item.id);
    if (!canManageInventory()) {
      return '<td class="inv-actions-cell"><span class="inv-readonly">View only</span></td>';
    }
    return (
      '<td class="inv-actions-cell">' +
      '<div class="inv-actions">' +
      '<button type="button" class="btn btn-sm btn-secondary inv-action-btn" data-action="edit" data-id="' + id + '" ' +
      'title="Edit item details and stock" aria-label="Edit item">' +
      '<i class="fa-solid fa-pen"></i> Edit</button>' +
      '<button type="button" class="btn btn-sm btn-primary inv-action-btn" data-action="restock" data-id="' + id + '" ' +
      'title="Restock / Update Quantity" aria-label="Restock or update quantity">' +
      '<i class="fa-solid fa-truck-ramp-box"></i> Restock / Update Quantity</button>' +
      '</div></td>'
    );
  }

  function renderInventory() {
    var body = document.getElementById('inventoryTableBody');
    if (!body) return;
    var items = filteredItems();
    updateStats();
    if (!items.length) {
      body.innerHTML =
        '<tr><td colspan="' + ACTION_COLS + '" class="inv-empty"><i class="fa-solid fa-box-open"></i>' +
        esc(tr('inventory_no_items', 'No inventory items found.')) + '</td></tr>';
      return;
    }
    body.innerHTML = items
      .map(function (item) {
        var status = statusOf(item);
        return (
          '<tr>' +
          '<td><strong>' + esc((item.name && item.name.en) || '—') + '</strong></td>' +
          '<td>' + esc(item.category || '—') + '</td>' +
          '<td class="qty-cell"><strong>' + esc(Number(item.stockQuantity) || 0) + '</strong></td>' +
          '<td class="qty-cell">' + esc(Number(item.lowStockThreshold) || 0) + '</td>' +
          '<td>' + statusBadge(status) + '</td>' +
          actionsCell(item) +
          '</tr>'
        );
      })
      .join('');
  }

  // ------------------------------------------------------------------
  // Event delegation (robust for every status and after re-renders)
  // ------------------------------------------------------------------
  function findItemById(id) {
    for (var i = 0; i < allItems.length; i++) {
      if (String(allItems[i].id) === String(id)) return allItems[i];
    }
    return null;
  }

  function onTableClick(e) {
    var btn = e.target.closest ? e.target.closest('button[data-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');
    var item = findItemById(id);
    if (!item) {
      toast('error', tr('inventory_item_missing', 'That inventory item is no longer available. Refreshing…'));
      refreshAll();
      return;
    }
    if (action === 'edit') openEditModal(item);
    else if (action === 'restock') openUpdateModal(item);
  }

  // ------------------------------------------------------------------
  // Restock / Update Quantity modal
  // ------------------------------------------------------------------
  function openUpdateModal(item) {
    document.getElementById('updateItemId').value = String(item.id);
    document.getElementById('updateItemName').textContent = (item.name && item.name.en) || '—';
    document.getElementById('updateItemCurrent').textContent =
      'Current quantity: ' + (Number(item.stockQuantity) || 0) + ' — minimum stock level: ' + (Number(item.lowStockThreshold) || 0);
    document.getElementById('updateNewQty').value = Number(item.stockQuantity) || 0;
    document.getElementById('updateMinStock').value = Number(item.lowStockThreshold) || 0;
    document.getElementById('updateQtyError').textContent = '';
    document.getElementById('updateMinStockError').textContent = '';
    openBackdrop('invModalBackdrop');
  }

  function closeUpdateModal() {
    closeBackdrop('invModalBackdrop');
  }

  function validateQuantity(value) {
    if (value === null || value === '' || isNaN(Number(value))) return 'Quantity is required';
    var n = Number(value);
    if (!Number.isInteger(n)) return 'Quantity must be a whole number';
    if (n < 0) return 'Quantity cannot be negative';
    return null;
  }

  async function handleUpdateSubmit(e) {
    e.preventDefault();
    var id = document.getElementById('updateItemId').value;
    var qtyRaw = document.getElementById('updateNewQty').value;
    var minRaw = document.getElementById('updateMinStock').value;

    var qtyError = validateQuantity(qtyRaw);
    if (qtyError) {
      document.getElementById('updateQtyError').textContent = qtyError;
      return;
    }
    var minError = validateQuantity(minRaw);
    if (minError) {
      document.getElementById('updateMinStockError').textContent = minError;
      return;
    }

    var qty = parseInt(qtyRaw, 10);
    var min = parseInt(minRaw, 10);
    await saveStock(id, qty, min, 'invModalSave', closeUpdateModal);
  }

  async function saveStock(id, qty, min, saveBtnId, onSuccess) {
    var saveBtn = document.getElementById(saveBtnId);
    if (saveBtn) saveBtn.disabled = true;
    try {
      var data = await window.AdminAPI.put('/admin/menu/' + encodeURIComponent(id), {
        stockQuantity: qty,
        lowStockThreshold: min,
      });
      var status = data && data.item ? statusOf(data.item) : null;
      toast('success', status ? 'Quantity updated — status is now ' + status.replace('_', ' ') : tr('stock_updated', 'Stock updated successfully'));
      if (onSuccess) onSuccess();
      refreshAll();
    } catch (error) {
      toast('error', errorOf(error, tr('error_update_stock', 'Failed to update stock')));
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Edit item modal (loads the selected item's REAL data by _id)
  // ------------------------------------------------------------------
  function categoryOptions(selected) {
    var list = categories || [];
    var found = list.some(function (c) {
      return c.id === selected;
    });
    var options = list
      .map(function (c) {
        var label = (c.name && (c.name.en || c.name.am)) || c.id;
        return '<option value="' + esc(c.id) + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(label) + '</option>';
      })
      .join('');
    if (selected && !found) {
      options = '<option value="' + esc(selected) + '" selected>' + esc(selected) + '</option>' + options;
    }
    if (!options) {
      options = '<option value="' + esc(selected || '') + '" selected>' + esc(selected || '') + '</option>';
    }
    return options;
  }

  async function openEditModal(item) {
    var id = item.id;
    // Load the authoritative record from MongoDB so the form shows real data.
    var fresh = null;
    try {
      var res = await window.AdminAPI.get('/admin/menu/' + encodeURIComponent(id));
      fresh = (res && res.item) || null;
    } catch (e) {
      fresh = null;
    }
    var data = fresh || item;

    if (!categories.length) await loadCategories();

    document.getElementById('editItemId').value = String(id);
    document.getElementById('editNameEn').value = (data.name && data.name.en) || '';
    document.getElementById('editNameAm').value = (data.name && data.name.am) || '';
    document.getElementById('editCategory').innerHTML = categoryOptions(data.category);
    document.getElementById('editPrice').value = Number(data.price) || 0;
    document.getElementById('editPrepTime').value = Number(data.preparationTime) || 10;
    document.getElementById('editStockQty').value = Number(data.stockQuantity) || 0;
    document.getElementById('editMinStock').value = Number(data.lowStockThreshold) || 0;
    ['editNameEnError', 'editNameAmError', 'editPriceError', 'editStockError', 'editMinStockError', 'editFormError'].forEach(function (eid) {
      var el = document.getElementById(eid);
      if (el) el.textContent = '';
    });
    openBackdrop('editModalBackdrop');
  }

  function closeEditModal() {
    closeBackdrop('editModalBackdrop');
  }

  function setErr(id, msg) {
    var el = document.getElementById(id);
    if (el) el.textContent = msg || '';
    return !msg;
  }

  async function handleEditSubmit(e) {
    e.preventDefault();
    var id = document.getElementById('editItemId').value;
    var nameEn = (document.getElementById('editNameEn').value || '').trim();
    var nameAm = (document.getElementById('editNameAm').value || '').trim();
    var category = document.getElementById('editCategory').value;
    var priceRaw = document.getElementById('editPrice').value;
    var prepRaw = document.getElementById('editPrepTime').value;
    var qtyRaw = document.getElementById('editStockQty').value;
    var minRaw = document.getElementById('editMinStock').value;

    var ok = true;
    ok = setErr('editNameEnError', nameEn ? '' : 'English name is required') && ok;
    ok = setErr('editNameAmError', nameAm ? '' : 'Amharic name is required') && ok;

    var price = Number(priceRaw);
    ok = setErr('editPriceError', !isNaN(price) && price >= 0 ? '' : 'Price must be a non-negative number') && ok;

    var prep = Number(prepRaw);
    var prepOk = !isNaN(prep) && prep >= 1;

    var qtyErr = validateQuantity(qtyRaw);
    ok = setErr('editStockError', qtyErr || '') && ok;

    var minErr = validateQuantity(minRaw);
    ok = setErr('editMinStockError', minErr || '') && ok;

    if (!ok) {
      setErr('editFormError', 'Please correct the highlighted fields.');
      return;
    }
    setErr('editFormError', '');

    var body = {
      name: { en: nameEn, am: nameAm },
      category: category,
      price: price,
      stockQuantity: parseInt(qtyRaw, 10),
      lowStockThreshold: parseInt(minRaw, 10),
    };
    if (prepOk) body.preparationTime = prep;

    var saveBtn = document.getElementById('editModalSave');
    if (saveBtn) saveBtn.disabled = true;
    try {
      var res = await window.AdminAPI.put('/admin/menu/' + encodeURIComponent(id), body);
      var status = res && res.item ? statusOf(res.item) : null;
      toast('success', status ? 'Item saved — status is now ' + status.replace('_', ' ') : tr('item_updated', 'Item updated'));
      closeEditModal();
      refreshAll();
    } catch (error) {
      toast('error', errorOf(error, tr('error_update_item', 'Failed to update item')));
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Modal helpers
  // ------------------------------------------------------------------
  function openBackdrop(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('active');
  }
  function closeBackdrop(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('active');
  }

  // ------------------------------------------------------------------
  // Event bindings
  // ------------------------------------------------------------------
  function bindEvents() {
    var refreshBtn = document.getElementById('refreshInventoryBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshAll);

    var searchInput = document.getElementById('invSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          search = searchInput.value || '';
          renderInventory();
        }, 250);
      });
    }

    var statusFilterEl = document.getElementById('invStatusFilter');
    if (statusFilterEl) {
      statusFilterEl.addEventListener('change', function () {
        statusFilter = statusFilterEl.value || '';
        renderInventory();
      });
    }

    // Delegated: works for every row / every status / after re-render.
    var tbody = document.getElementById('inventoryTableBody');
    if (tbody) tbody.addEventListener('click', onTableClick);

    var updateForm = document.getElementById('invUpdateForm');
    if (updateForm) updateForm.addEventListener('submit', handleUpdateSubmit);

    var editForm = document.getElementById('invEditForm');
    if (editForm) editForm.addEventListener('submit', handleEditSubmit);

    var cancelUpdate = document.getElementById('invModalCancel');
    if (cancelUpdate) cancelUpdate.addEventListener('click', closeUpdateModal);

    var cancelEdit = document.getElementById('editModalCancel');
    if (cancelEdit) cancelEdit.addEventListener('click', closeEditModal);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeUpdateModal();
        closeEditModal();
      }
    });

    // Real-time stock alert refreshes keep quantity/status/alerts in sync.
    if (window.socket) {
      window.socket.on('stock:alert', refreshAll);
      window.socket.on('stock:alert:updated', refreshAll);
      window.socket.on('stock:alert:resolved', refreshAll);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    loadCategories();
    refreshAll();
  });
})();
