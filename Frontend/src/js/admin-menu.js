/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN MENU MANAGEMENT
 * ================================================================
 * Admin Menu Management driven by the backend API:
 *   GET    /admin/menu            (list / search / filter / sort / paginate)
 *   GET    /admin/menu/stats      (metric cards)
 *   GET    /admin/menu/:id        (details)
 *   POST   /admin/menu            (create)
 *   PUT    /admin/menu/:id        (update: price, category, image, ...)
 *   PATCH  /admin/menu/:id/availability (enable / disable)
 *   DELETE /admin/menu/:id        (delete)
 *
 * Image upload: validated client-side, then sent as a base64 data URL.
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ================================================================
 */
(function () {
  "use strict";

  var state = {
    page: 1,
    limit: 10,
    search: "",
    category: "",
    availability: "",
    sort: "newest"
  };

  var pendingImage = null; // { type: 'file'|'url'|'remove', value } or null to keep
  var editingItem = null;

  var FALLBACK_CATEGORIES = [
    { id: "breakfast", name: "Breakfast" },
    { id: "main-meals", name: "Main Meals" },
    { id: "fasting", name: "Fasting" },
    { id: "beverages", name: "Beverages" },
    { id: "snacks", name: "Snacks" },
  ];

  var ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
  var MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2 MB

  function money(value) {
    if (value === null || value === undefined) return "0";
    return Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function categoryLabel(cat) {
    function idOf(value) {
      if (value === null || value === undefined) return null;
      if (typeof value === "object") {
        return value.id != null ? String(value.id).toLowerCase() : null;
      }
      return String(value).toLowerCase();
    }
    function nameOf(c) {
      if (!c) return "";
      if (c.name && typeof c.name === "object") return c.name.en || c.name.am || c.name || c.id || "";
      return c.name || c.id || "";
    }

    var id = idOf(cat);
    if (id) {
      var found = (window.__categories || FALLBACK_CATEGORIES).find(function (c) {
        return idOf(c) === id;
      });
      if (found) return nameOf(found);
    }

    if (cat && typeof cat === "object") return nameOf(cat);
    return cat || "—";
  }

  function escapeHtml(value) {
    return window.esc(value);
  }

  function itemImage(item) {
    var src = item.image
      ? (item.image.indexOf("http") === 0 ? item.image : window.__API_BASE + item.image)
      : "";
    if (!src) return '<div class="food-image-thumb no-image"><i class="fa-solid fa-utensils"></i></div>';
    return '<img class="food-image-thumb" src="' + window.esc(src) + '" alt="' + window.esc(item.name.en) + '" loading="lazy">';
  }

  function availabilityBadge(item) {
    var available = item.availabilityStatus === "AVAILABLE" || (item.availability && item.isAvailable && Number(item.stockQuantity || 0) > 0);
    var cls = available ? "order-badge avail-on" : "order-badge avail-off";
    return '<span class="' + cls + '">' + (available ? "Available" : "Unavailable") + "</span>";
  }

  /* ============================================================
   * MODALS
   * ============================================================ */
  function openModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add("open");
  }

  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove("open");
  }

  function closeAllModals() {
    document.querySelectorAll(".modal-overlay.open").forEach(function (m) {
      m.classList.remove("open");
    });
  }

  /* ============================================================
   * CATEGORIES
   * ============================================================ */
  async function loadCategories() {
    try {
      var data = await window.AdminAPI.get("/categories");
      window.__categories = (data.categories || []).filter(function (c) { return c.isActive !== false; });
    } catch (e) {
      window.__categories = FALLBACK_CATEGORIES;
    }
    populateCategorySelects();
  }

  function populateCategorySelects() {
    var cats = window.__categories || FALLBACK_CATEGORIES;
    var options = cats
      .map(function (c) {
        var name = (c.name && (c.name.en || c.name)) || c.id;
        return '<option value="' + window.esc(c.id) + '">' + window.esc(name) + "</option>";
      })
      .join("");

    var filter = document.getElementById("categoryFilter");
    var formSelect = document.getElementById("itemCategory");
    if (filter) filter.innerHTML = '<option value="">All Categories</option>' + options;
    if (formSelect) formSelect.innerHTML = '<option value="">Select category</option>' + options;
  }

  /* ============================================================
   * DATA LOADING
   * ============================================================ */
  async function loadStats() {
    try {
      var data = await window.AdminAPI.get("/admin/menu/stats");
      var stats = data.stats || {};
      document.getElementById("metricTotalItems").textContent = stats.totalItems || 0;
      document.getElementById("metricAvailableItems").textContent = stats.availableItems || 0;
      document.getElementById("metricOutOfStockItems").textContent = stats.outOfStockItems || 0;
      document.getElementById("metricTotalCategories").textContent = stats.totalCategories || 0;
    } catch (e) {
      // stats are supplementary
    }
  }

  function availabilityQueryValue() {
    if (state.availability === "AVAILABLE") return "available";
    if (state.availability === "OUT_OF_STOCK") return "out_of_stock";
    return "";
  }

  async function loadMenuItems() {
    var tbody = document.getElementById("menuTableBody");
    if (!tbody || !window.AdminAPI) return;

    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Loading menu items...</td></tr>';

    try {
      var data = await window.AdminAPI.get("/admin/menu", {
        page: state.page,
        limit: state.limit,
        search: state.search,
        category: state.category,
        availability: availabilityQueryValue(),
        sort: state.sort
      });

      window.__menuCache = data.items || [];
      renderMenuItems(window.__menuCache);

      var info = document.getElementById("menuPaginationInfo");
      var total = data.total || 0;
      var pages = Math.max(data.pages || 1, 1);
      if (info) info.textContent = "Page " + (data.page || state.page) + " of " + pages + " (" + total + " items)";
      var prevBtn = document.getElementById("menuPrevPageBtn");
      var nextBtn = document.getElementById("menuNextPageBtn");
      if (prevBtn) prevBtn.disabled = (data.page || 1) <= 1;
      if (nextBtn) nextBtn.disabled = (data.page || 1) >= pages;
      state.page = data.page || 1;
    } catch (error) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Failed to load menu: ' + window.esc(error.message || "Server error") + "</td></tr>";
    }
  }

  function renderMenuItems(items) {
    var tbody = document.getElementById("menuTableBody");
    if (!tbody) return;

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No menu items found.</td></tr>';
      return;
    }

    tbody.innerHTML = items.map(function (item) {
      var available = item.availabilityStatus === "AVAILABLE" || (item.availability && item.isAvailable && Number(item.stockQuantity || 0) > 0);
      var toggleBtn =
        '<button class="action-btn" data-action="toggle" data-id="' + item.id + '" title="' +
        (available ? "Make unavailable" : "Make available") + '">' +
        '<i class="fa-solid ' + (available ? "fa-circle-xmark" : "fa-circle-check") + '"></i></button>';

      return (
        "<tr>" +
        '<td>' +
          '<div class="user-cell">' +
            itemImage(item) +
            "<div>" +
              "<strong>" + escapeHtml(item.name.en) + "</strong>" +
              "<small>" + escapeHtml(item.name.am) + "</small>" +
            "</div>" +
          "</div>" +
        "</td>" +
        '<td><span class="cat-pill">' + escapeHtml(categoryLabel(item.category)) + "</span></td>" +
        '<td class="price-cell">' + money(item.price) + " ETB</td>" +
        '<td class="stock-cell">' + Number(item.stockQuantity || 0) + (Number(item.stockQuantity || 0) <= Number(item.lowStockThreshold || 0) ? ' <span class="order-badge suspended-badge">Low</span>' : '') + "</td>" +
        '<td class="prep-cell">' + (item.preparationTime || 10) + " min</td>" +
        "<td>" + availabilityBadge(item) + "</td>" +
        '<td class="date-cell">' + window.AdminAPI.formatDate(item.updatedAt) + "</td>" +
        "<td>" +
          '<div class="table-actions">' +
            '<button class="action-btn" data-action="view" data-id="' + item.id + '" title="View details"><i class="fa-solid fa-eye"></i></button>' +
            '<button class="action-btn" data-action="edit" data-id="' + item.id + '" title="Edit item (price / category / image)"><i class="fa-solid fa-pen"></i></button>' +
            '<button class="action-btn" data-action="stock" data-id="' + item.id + '" title="Update stock quantity"><i class="fa-solid fa-box"></i></button>' +
            toggleBtn +
            '<button class="action-btn danger" data-action="delete" data-id="' + item.id + '" title="Delete item"><i class="fa-solid fa-trash"></i></button>' +
          "</div>" +
        "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function changePage(delta) {
    state.page += delta;
    if (state.page < 1) state.page = 1;
    loadMenuItems();
  }

  /* ============================================================
   * ADD / EDIT
   * ============================================================ */
  function resetImageState() {
    pendingImage = null;
    editingItem = null;
    document.getElementById("itemImageFile").value = "";
    document.getElementById("itemImageUrl").value = "";
    document.getElementById("imagePreviewRow").style.display = "none";
    document.getElementById("itemImagePreview").removeAttribute("src");
    var urlInput = document.getElementById("itemImageUrl");
    if (urlInput) { urlInput.classList.remove("url-valid"); urlInput.classList.remove("url-invalid"); }
    var feedback = document.getElementById("urlFeedback");
    if (feedback) { feedback.textContent = ""; feedback.className = "url-feedback"; }
    var loading = document.getElementById("imageLoading");
    var error = document.getElementById("imageError");
    if (loading) loading.style.display = "none";
    if (error) error.style.display = "none";
    var preview = document.getElementById("itemImagePreview");
    if (preview) { preview.onerror = null; preview.onload = null; }
  }

  function openAddItemModal() {
    closeAllModals();
    resetImageState();
    document.getElementById("menuItemForm").reset();
    document.getElementById("itemId").value = "";
    document.getElementById("itemPrepTime").value = 10;
    document.getElementById("itemStockQuantity").value = 0;
    document.getElementById("itemLowStockThreshold").value = 5;
    document.getElementById("itemPopular").checked = false;
    document.getElementById("itemRecommended").checked = false;
    document.getElementById("itemHomepage").checked = false;
    document.getElementById("itemAvailable").checked = true;
    document.getElementById("itemAvailableLabel").textContent = "Available for ordering";
    document.getElementById("menuModalTitle").textContent = "Add New Menu Item";
    document.getElementById("saveMenuItemBtn").textContent = "Save Item";
    openModal("menuItemModal");
  }

  function openEditItemModal(item) {
    closeAllModals();
    resetImageState();
    editingItem = item;

    document.getElementById("itemId").value = item.id;
    document.getElementById("itemNameEn").value = item.name.en || "";
    document.getElementById("itemNameAm").value = item.name.am || "";
    document.getElementById("itemCategory").value =
      item.category && typeof item.category === "object"
        ? (item.category.id != null ? item.category.id : (item.category.name && item.category.name.en))
        : item.category;
    document.getElementById("itemPrice").value = item.price;
    document.getElementById("itemPrepTime").value = item.preparationTime || 10;
    document.getElementById("itemStockQuantity").value = item.stockQuantity || 0;
    document.getElementById("itemLowStockThreshold").value = item.lowStockThreshold || 5;
    document.getElementById("itemPopular").checked = item.isPopular === true;
    document.getElementById("itemRecommended").checked = item.isRecommended === true;
    document.getElementById("itemHomepage").checked = item.showOnHomepage === true;
    document.getElementById("itemAvailable").checked = !!(item.availability && item.isAvailable);
    document.getElementById("itemAvailableLabel").textContent =
      item.availability && item.isAvailable ? "Available for ordering" : "Not available for ordering";
    document.getElementById("itemDescriptionEn").value = (item.description && item.description.en) || "";
    document.getElementById("itemDescriptionAm").value = (item.description && item.description.am) || "";

    var previewRow = document.getElementById("imagePreviewRow");
    var preview = document.getElementById("itemImagePreview");
    var loading = document.getElementById("imageLoading");
    var error = document.getElementById("imageError");
    if (item.image) {
      var imgSrc = item.image.indexOf("http") === 0 ? item.image : window.__API_BASE + item.image;
      if (loading) loading.style.display = "flex";
      if (error) error.style.display = "none";
      preview.onerror = function () {
        if (loading) loading.style.display = "none";
        if (error) error.style.display = "flex";
        preview.style.display = "none";
      };
       preview.onload = function () {
        if (loading) loading.style.display = "none";
        if (error) error.style.display = "none";
        preview.style.display = "block";
      };
      preview.src = imgSrc;
      preview.style.display = "none";
      previewRow.style.display = "flex";
    } else {
      previewRow.style.display = "none";
      preview.removeAttribute("src");
      preview.onerror = null;
      preview.onload = null;
      if (loading) loading.style.display = "none";
      if (error) error.style.display = "none";
    }

    document.getElementById("menuModalTitle").textContent = "Edit Menu Item";
    document.getElementById("saveMenuItemBtn").textContent = "Update Item";
    openModal("menuItemModal");
  }

  function buildMenuItemPayload() {
    return {
      name: {
        en: document.getElementById("itemNameEn").value.trim(),
        am: document.getElementById("itemNameAm").value.trim()
      },
      category: document.getElementById("itemCategory").value,
      price: parseFloat(document.getElementById("itemPrice").value),
      preparationTime: parseInt(document.getElementById("itemPrepTime").value) || 10,
      description: {
        en: document.getElementById("itemDescriptionEn").value.trim(),
        am: document.getElementById("itemDescriptionAm").value.trim()
      },
      available: document.getElementById("itemAvailable").checked,
      stockQuantity: parseInt(document.getElementById("itemStockQuantity").value, 10) || 0,
      lowStockThreshold: parseInt(document.getElementById("itemLowStockThreshold").value, 10) || 0,
      isPopular: document.getElementById("itemPopular").checked,
      isRecommended: document.getElementById("itemRecommended").checked,
      showOnHomepage: document.getElementById("itemHomepage").checked
    };
  }

  async function handleMenuItemSubmit(event) {
    event.preventDefault();

    var payload = buildMenuItemPayload();
    if (!payload.name.en || !payload.name.am) {
      if (window.AdminToast) window.AdminToast.error("Both English and Amharic names are required");
      return;
    }
    if (isNaN(payload.price) || payload.price < 0) {
      if (window.AdminToast) window.AdminToast.error("Price must be a non-negative number");
      return;
    }

    if (pendingImage) {
      if (pendingImage.type === "remove") {
        payload.image = "";
      } else {
        payload.image = pendingImage.value;
      }
    } else if (!editingItem) {
      payload.image = null;
    }

    var id = document.getElementById("itemId").value;

    try {
      var data;
      if (id) {
        data = await window.AdminAPI.put("/admin/menu/" + id, payload);
      } else {
        data = await window.AdminAPI.post("/admin/menu", payload);
      }

      closeModal("menuItemModal");
      if (window.AdminToast) window.AdminToast.success(id ? "Menu item updated" : "Menu item added");
      if (state.page > 1 && !id) state.page = 1;
      loadMenuItems();
      loadStats();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || "Failed to save menu item");
    }
  }

  /* ============================================================
   * IMAGE HANDLING
   * ============================================================ */
  function handleImageFileChange(file) {
    if (!file) return;
    if (ALLOWED_IMAGE_TYPES.indexOf(file.type) === -1) {
      pendingImage = null;
      if (window.AdminToast) window.AdminToast.error("Invalid image type. Allowed: JPG, JPEG, PNG, WEBP");
      document.getElementById("itemImageFile").value = "";
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      pendingImage = null;
      if (window.AdminToast) window.AdminToast.error("Image too large. Maximum size is 2 MB");
      document.getElementById("itemImageFile").value = "";
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      pendingImage = { type: "file", value: String(reader.result) };
      document.getElementById("itemImageUrl").value = "";
      var filePreview = document.getElementById("itemImagePreview");
      var fileLoading = document.getElementById("imageLoading");
      var fileError = document.getElementById("imageError");
      if (fileLoading) fileLoading.style.display = "none";
      if (fileError) fileError.style.display = "none";
      filePreview.style.display = "none";
      filePreview.onerror = null;
      filePreview.onload = function () { filePreview.style.display = "block"; };
      filePreview.src = String(reader.result);
      document.getElementById("imagePreviewRow").style.display = "flex";
    };
    reader.readAsDataURL(file);
  }

  var imageUrlDebounce = null;

  function isValidUrl(string) {
    try {
      var url = new URL(string);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (_) {
      return false;
    }
  }

  function handleImageUrlInput(value) {
    if (imageUrlDebounce) clearTimeout(imageUrlDebounce);
    var urlInput = document.getElementById("itemImageUrl");
    var feedback = document.getElementById("urlFeedback");
    var preview = document.getElementById("itemImagePreview");
    var loading = document.getElementById("imageLoading");
    var error = document.getElementById("imageError");

    imageUrlDebounce = setTimeout(function () {
      if (value && value.trim()) {
        var trimmed = value.trim();
        if (!isValidUrl(trimmed)) {
          if (feedback) { feedback.textContent = "Please enter a valid URL (http:// or https://)"; feedback.className = "url-feedback invalid"; }
          if (urlInput) { urlInput.classList.add("url-invalid"); urlInput.classList.remove("url-valid"); }
          pendingImage = null;
          document.getElementById("imagePreviewRow").style.display = "none";
          document.getElementById("itemImagePreview").removeAttribute("src");
          if (loading) loading.style.display = "none";
          if (error) error.style.display = "none";
          document.getElementById("itemImageFile").value = "";
          return;
        }
        if (urlInput) { urlInput.classList.remove("url-invalid"); urlInput.classList.add("url-valid"); }
        if (feedback) { feedback.textContent = "Loading preview..."; feedback.className = "url-feedback valid"; }
        pendingImage = { type: "url", value: trimmed };
        document.getElementById("itemImageFile").value = "";
        if (loading) loading.style.display = "flex";
        if (error) error.style.display = "none";
        preview.style.display = "none";
        preview.onerror = function () {
          if (loading) loading.style.display = "none";
          if (error) error.style.display = "flex";
          preview.style.display = "none";
          if (feedback) { feedback.textContent = "Preview unavailable here, but the URL will still be saved."; feedback.className = "url-feedback valid"; }
        };
        preview.onload = function () {
          if (loading) loading.style.display = "none";
          if (error) error.style.display = "none";
          preview.style.display = "block";
          if (feedback) { feedback.textContent = "Image preview loaded"; feedback.className = "url-feedback valid"; }
        };
        preview.src = trimmed;
        document.getElementById("imagePreviewRow").style.display = "flex";
      } else {
        if (feedback) { feedback.textContent = ""; feedback.className = "url-feedback"; }
        if (urlInput) { urlInput.classList.remove("url-valid"); urlInput.classList.remove("url-invalid"); }
        pendingImage = null;
        if (loading) loading.style.display = "none";
        if (error) error.style.display = "none";
      }
    }, 600);
  }

  /* ============================================================
   * VIEW / TOGGLE / DELETE / STOCK
   * ============================================================ */
  function viewMenuItem(item) {
    closeAllModals();

    var thumb = item.image
      ? (item.image.indexOf("http") === 0 ? item.image : window.__API_BASE + item.image)
      : "";
    var imageEl = document.getElementById("viewItemImage");
    if (thumb) {
      imageEl.src = thumb;
      imageEl.style.display = "block";
    } else {
      imageEl.style.display = "none";
    }

    document.getElementById("viewItemName").textContent = item.name.en + (item.name.am ? " / " + item.name.am : "");
    document.getElementById("viewItemCategory").textContent = categoryLabel(item.category);
    document.getElementById("viewItemId").textContent = item.id;
    document.getElementById("viewItemPrice").textContent = money(item.price) + " ETB";
    document.getElementById("viewItemAvailability").textContent =
      item.availability && item.isAvailable ? "Available" : "Unavailable";
    document.getElementById("viewItemPrepTime").textContent = (item.preparationTime || 10) + " min";
    document.getElementById("viewItemDescEn").textContent = (item.description && item.description.en) || "—";
    document.getElementById("viewItemDescAm").textContent = (item.description && item.description.am) || "—";
    document.getElementById("viewItemCreated").textContent = window.AdminAPI.formatDateTime(item.createdAt);
    document.getElementById("viewItemUpdated").textContent = window.AdminAPI.formatDateTime(item.updatedAt);
    openModal("viewItemModal");
  }

  function openToggleAvailModal(item) {
    closeAllModals();
    var available = item.availability && item.isAvailable;
    document.getElementById("toggleAvailTitle").textContent = available ? "Make Unavailable" : "Make Available";
    document.getElementById("toggleAvailMsg").textContent =
      "Are you sure you want to make \"" + item.name.en + "\" " + (available ? "unavailable" : "available") + "?";
    var iconWrap = document.getElementById("toggleAvailIconWrap");
    iconWrap.className = available ? "confirm-icon warning" : "confirm-icon success";
    iconWrap.querySelector("i").className = available ? "fa-solid fa-circle-xmark" : "fa-solid fa-circle-check";
    var confirmBtn = document.getElementById("confirmToggleAvailBtn");
    confirmBtn.className = available ? "btn btn-danger" : "btn btn-success";
    confirmBtn.textContent = available ? "Make Unavailable" : "Make Available";
    confirmBtn.onclick = async function () {
      try {
        await window.AdminAPI.patch("/admin/menu/" + item.id + "/availability", { available: !available });
        closeModal("toggleAvailModal");
        if (window.AdminToast) window.AdminToast.success(!available ? "Item is now available" : "Item is now unavailable");
        loadMenuItems();
        loadStats();
      } catch (error) {
        if (window.AdminToast) window.AdminToast.error(error.message || "Failed to update availability");
      }
    };
    openModal("toggleAvailModal");
  }

  function openDeleteItemModal(item) {
    closeAllModals();
    document.getElementById("deleteItemName").textContent = item.name.en;
    var confirmBtn = document.getElementById("confirmDeleteItemBtn");
    confirmBtn.onclick = async function () {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
      try {
        await window.AdminAPI.del("/admin/menu/" + item.id);
        closeModal("deleteItemModal");
        if (window.AdminToast) window.AdminToast.success("Menu item deleted");
        if (window.__menuCache && window.__menuCache.length === 1 && state.page > 1) state.page--;
        loadMenuItems();
        loadStats();
      } catch (error) {
        if (window.AdminToast) window.AdminToast.error(error.message || "Failed to delete menu item");
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
      }
    };
    openModal("deleteItemModal");
  }

  function openStockModal(item) {
    closeAllModals();
    document.getElementById("stockItemId").value = item.id;
    document.getElementById("stockItemName").textContent = item.name.en;
    document.getElementById("stockItemCat").textContent = categoryLabel(item.category);
    var thumb = item.image
      ? (item.image.indexOf("http") === 0 ? item.image : window.__API_BASE + item.image)
      : "";
    var thumbEl = document.getElementById("stockItemThumb");
    if (thumb) { thumbEl.src = thumb; thumbEl.style.display = "block"; }
    else { thumbEl.style.display = "none"; }
    document.getElementById("stockCurrentQty").value = item.stockQuantity || 0;
    document.getElementById("stockNewQty").value = item.stockQuantity || 0;
    document.getElementById("stockThreshold").value = item.lowStockThreshold || 5;
    openModal("stockModal");
  }

  async function handleStockSubmit(e) {
    e.preventDefault();
    var id = document.getElementById("stockItemId").value;
    var newQty = parseInt(document.getElementById("stockNewQty").value, 10);
    var threshold = parseInt(document.getElementById("stockThreshold").value, 10);
    if (isNaN(newQty) || newQty < 0) {
      if (window.AdminToast) window.AdminToast.error("Stock quantity must be a non-negative number");
      return;
    }
    var saveBtn = document.getElementById("saveStockBtn");
    saveBtn.disabled = true;
    try {
      await window.AdminAPI.put("/admin/menu/" + id, {
        stockQuantity: newQty,
        lowStockThreshold: threshold
      });
      closeModal("stockModal");
      if (window.AdminToast) window.AdminToast.success("Stock updated successfully");
      loadMenuItems();
      loadStats();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || "Failed to update stock");
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function findItemById(id) {
    try {
      var data = await window.AdminAPI.get("/admin/menu/" + id);
      return data.item || null;
    } catch (e) {
      return null;
    }
  }

  /* ============================================================
   * EVENT BINDINGS
   * ============================================================ */
  function bindEvents() {
    var addBtn = document.getElementById("openAddMenuModalBtn");
    if (addBtn) addBtn.addEventListener("click", openAddItemModal);

    var refreshBtn = document.getElementById("refreshMenuBtn");
    if (refreshBtn) refreshBtn.addEventListener("click", function () {
      loadMenuItems();
      loadStats();
      if (window.AdminToast) window.AdminToast.show("Menu refreshed");
    });

    var form = document.getElementById("menuItemForm");
    if (form) form.addEventListener("submit", handleMenuItemSubmit);

    document.querySelectorAll("[data-close-modal]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        closeModal(btn.getAttribute("data-close-modal"));
      });
    });

    var searchInput = document.getElementById("menuSearchInput");
    if (searchInput) {
      var debounceTimer = null;
      searchInput.addEventListener("input", function () {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
          state.search = searchInput.value.trim();
          state.page = 1;
          loadMenuItems();
        }, 400);
      });
    }

    var categoryFilter = document.getElementById("categoryFilter");
    if (categoryFilter) {
      categoryFilter.addEventListener("change", function () {
        state.category = categoryFilter.value;
        state.page = 1;
        loadMenuItems();
      });
    }

    var availabilityFilter = document.getElementById("availabilityFilter");
    if (availabilityFilter) {
      availabilityFilter.addEventListener("change", function () {
        state.availability = availabilityFilter.value;
        state.page = 1;
        loadMenuItems();
      });
    }

    var sortSelect = document.getElementById("menuSortSelect");
    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        state.sort = sortSelect.value;
        state.page = 1;
        loadMenuItems();
      });
    }

    var resetBtn = document.getElementById("resetMenuFiltersBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (searchInput) searchInput.value = "";
        if (categoryFilter) categoryFilter.value = "";
        if (availabilityFilter) availabilityFilter.value = "";
        if (sortSelect) sortSelect.value = "newest";
        state.search = "";
        state.category = "";
        state.availability = "";
        state.sort = "newest";
        state.page = 1;
        loadMenuItems();
      });
    }

    var prevBtn = document.getElementById("menuPrevPageBtn");
    var nextBtn = document.getElementById("menuNextPageBtn");
    if (prevBtn) prevBtn.addEventListener("click", function () { changePage(-1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { changePage(1); });

    var fileInput = document.getElementById("itemImageFile");
    if (fileInput) fileInput.addEventListener("change", function () {
      handleImageFileChange(fileInput.files[0]);
    });

    var urlInput = document.getElementById("itemImageUrl");
    if (urlInput) urlInput.addEventListener("input", function () {
      handleImageUrlInput(urlInput.value);
    });

    var removeImageBtn = document.getElementById("removeImageBtn");
    if (removeImageBtn) {
      removeImageBtn.addEventListener("click", function () {
        pendingImage = { type: "remove", value: "" };
        document.getElementById("itemImageFile").value = "";
        document.getElementById("itemImageUrl").value = "";
        var urlInput = document.getElementById("itemImageUrl");
        if (urlInput) { urlInput.classList.remove("url-valid"); urlInput.classList.remove("url-invalid"); }
        var feedback = document.getElementById("urlFeedback");
        if (feedback) { feedback.textContent = ""; feedback.className = "url-feedback"; }
        var preview = document.getElementById("itemImagePreview");
        var loading = document.getElementById("imageLoading");
        var error = document.getElementById("imageError");
        if (preview) preview.removeAttribute("src");
        if (loading) loading.style.display = "none";
        if (error) error.style.display = "none";
        preview.onerror = null;
        preview.onload = null;
        document.getElementById("imagePreviewRow").style.display = "none";
      });
    }

    var availCheckbox = document.getElementById("itemAvailable");
    var availLabel = document.getElementById("itemAvailableLabel");
    if (availCheckbox && availLabel) {
      availCheckbox.addEventListener("change", function () {
        availLabel.textContent = availCheckbox.checked ? "Available for ordering" : "Not available for ordering";
      });
    }

    var tbody = document.getElementById("menuTableBody");
    if (tbody) {
      tbody.addEventListener("click", async function (e) {
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        var id = btn.getAttribute("data-id");
        var action = btn.getAttribute("data-action");
        if (!id) return;

        var item = (window.__menuCache || []).find(function (i) { return i.id === id; });
        if (!item) item = await findItemById(id);
        if (!item) {
          if (window.AdminToast) window.AdminToast.error("Menu item not found");
          return;
        }

        if (action === "view") viewMenuItem(item);
        else if (action === "edit") openEditItemModal(item);
        else if (action === "stock") openStockModal(item);
        else if (action === "toggle") openToggleAvailModal(item);
        else if (action === "delete") openDeleteItemModal(item);
      });
    }

    var stockForm = document.getElementById("stockForm");
    if (stockForm) stockForm.addEventListener("submit", handleStockSubmit);
  }

  function init() {
    bindEvents();
    loadCategories().then(function () {
      loadMenuItems();
      loadStats();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();