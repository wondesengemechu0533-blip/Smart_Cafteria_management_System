function tr(key, fallback, vars) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * ==========================================================================
 * SMART CAFETERIA ORDERING SYSTEM - ADMIN CATEGORIES
 * ==========================================================================
 * Admin Category Management driven by the backend API:
 *   GET    /admin/categories        (list)
 *   GET    /admin/categories/:id    (details)
 *   POST   /admin/categories        (create)
 *   PUT    /admin/categories/:id    (update)
 *   PATCH  /admin/categories/:id/status (toggle active)
 *   DELETE /admin/categories/:id    (delete)
 *
 * Requires window.AdminAPI (admin-api.js) loaded first.
 * ============================================================================
 */
(function () {
  "use strict";

  var state = {
    page: 1,
    limit: 10,
    search: "",
    status: "",
    sort: "created"
  };

  var pendingImage = null;
  var ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
  var MAX_IMAGE_SIZE = 2 * 1024 * 1024;

  function escapeHtml(value) {
    return window.esc(value);
  }

  function openModal(id) { var el = document.getElementById(id); if (el) el.classList.add("open"); }
  function closeModal(id) { var el = document.getElementById(id); if (el) el.classList.remove("open"); }
  function closeAllModals() { document.querySelectorAll(".modal-overlay.open").forEach(function(m) { m.classList.remove("open"); }); }

  function categoryName(cat) {
    if (!cat) return "";
    var n = cat.name;
    if (n && typeof n === "object") return n.en || n.am || "";
    return String(n || "");
  }

  function categoryDescription(cat) {
    if (!cat) return "";
    var d = cat.description;
    if (d && typeof d === "object") return d.en || d.am || "";
    return String(d || "");
  }

  function formatTimeRange(availTime) {
    if (!availTime || !availTime.enabled) return tr('always_available', 'Always available');
    if (availTime.startTime && availTime.endTime) {
      return availTime.startTime + " — " + availTime.endTime;
    }
    return tr('enabled_no_times', 'Enabled (no times set)');
  }

  /* ============================================================
   * IMAGE HANDLING
   * ============================================================ */
  function resetImageState() {
    pendingImage = null;
    if (catImageUrlDebounce) clearTimeout(catImageUrlDebounce);
    var fileInput = document.getElementById("categoryImageFile");
    var urlInput = document.getElementById("categoryImageUrl");
    var previewRow = document.getElementById("categoryImagePreviewRow");
    var preview = document.getElementById("categoryImagePreview");
    var loading = document.getElementById("imageLoading");
    var error = document.getElementById("imageError");
    var feedback = document.getElementById("urlFeedback");
    if (fileInput) fileInput.value = "";
    if (urlInput) { urlInput.value = ""; urlInput.classList.remove("url-valid"); urlInput.classList.remove("url-invalid"); }
    if (feedback) { feedback.textContent = ""; feedback.className = "url-feedback"; }
    if (loading) loading.style.display = "none";
    if (error) error.style.display = "none";
    if (previewRow) previewRow.style.display = "none";
    if (preview) { preview.removeAttribute("src"); preview.onerror = null; preview.onload = null; }
  }

  var catImageUrlDebounce = null;

  function catIsValidUrl(string) {
    try {
      var url = new URL(string);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch (_) {
      return false;
    }
  }

  function handleImageFileChange(file) {
    if (!file) return;
    if (ALLOWED_IMAGE_TYPES.indexOf(file.type) === -1) {
      pendingImage = null;
      if (window.AdminToast) window.AdminToast.error(tr('invalid_image_type', 'Invalid image type. Allowed: JPG, JPEG, PNG, WEBP'));
      document.getElementById("categoryImageFile").value = "";
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      pendingImage = null;
      if (window.AdminToast) window.AdminToast.error(tr('image_too_large', 'Image too large. Maximum size is 2 MB'));
      document.getElementById("categoryImageFile").value = "";
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      pendingImage = { type: "file", value: String(reader.result) };
      document.getElementById("categoryImageUrl").value = "";
      var catPreview = document.getElementById("categoryImagePreview");
      var catLoading = document.getElementById("imageLoading");
      var catError = document.getElementById("imageError");
      if (catLoading) catLoading.style.display = "none";
      if (catError) catError.style.display = "none";
      catPreview.style.display = "none";
      catPreview.onerror = null;
      catPreview.onload = function () { catPreview.style.display = "block"; };
      catPreview.src = String(reader.result);
      document.getElementById("categoryImagePreviewRow").style.display = "flex";
    };
    reader.readAsDataURL(file);
  }

  function handleImageUrlInput(value) {
    if (catImageUrlDebounce) clearTimeout(catImageUrlDebounce);
    var urlInput = document.getElementById("categoryImageUrl");
    var feedback = document.getElementById("urlFeedback");
    var preview = document.getElementById("categoryImagePreview");
    var loading = document.getElementById("imageLoading");
    var error = document.getElementById("imageError");

    catImageUrlDebounce = setTimeout(function () {
      if (value && value.trim()) {
        var trimmed = value.trim();
        if (!catIsValidUrl(trimmed)) {
          if (feedback) { feedback.textContent = tr('valid_url_required', 'Please enter a valid URL (http:// or https://)'); feedback.className = "url-feedback invalid"; }
          if (urlInput) { urlInput.classList.add("url-invalid"); urlInput.classList.remove("url-valid"); }
          pendingImage = null;
          document.getElementById("categoryImagePreviewRow").style.display = "none";
          document.getElementById("categoryImagePreview").removeAttribute("src");
          if (loading) loading.style.display = "none";
          if (error) error.style.display = "none";
          document.getElementById("categoryImageFile").value = "";
          return;
        }
        if (urlInput) { urlInput.classList.remove("url-invalid"); urlInput.classList.add("url-valid"); }
        if (feedback) { feedback.textContent = tr('loading_preview', 'Loading preview...'); feedback.className = "url-feedback valid"; }
        pendingImage = { type: "url", value: trimmed };
        document.getElementById("categoryImageFile").value = "";
        if (loading) loading.style.display = "flex";
        if (error) error.style.display = "none";
        preview.style.display = "none";
        preview.onerror = function () {
          if (loading) loading.style.display = "none";
          if (error) error.style.display = "flex";
          preview.style.display = "none";
          if (feedback) { feedback.textContent = tr('preview_unavailable', 'Preview unavailable here, but the URL will still be saved.'); feedback.className = "url-feedback valid"; }
        };
        preview.onload = function () {
          if (loading) loading.style.display = "none";
          if (error) error.style.display = "none";
          preview.style.display = "block";
          if (feedback) { feedback.textContent = tr('image_preview_loaded', 'Image preview loaded'); feedback.className = "url-feedback valid"; }
        };
        preview.src = trimmed;
        document.getElementById("categoryImagePreviewRow").style.display = "flex";
      } else {
        if (feedback) { feedback.textContent = ""; feedback.className = "url-feedback"; }
        if (urlInput) { urlInput.classList.remove("url-valid"); urlInput.classList.remove("url-invalid"); }
        pendingImage = null;
        if (loading) loading.style.display = "none";
        if (error) error.style.display = "none";
      }
    }, 600);
  }

  document.addEventListener("click", function(e) {
    var closeBtn = e.target.closest("[data-close-modal]");
    if (closeBtn) closeModal(closeBtn.getAttribute("data-close-modal"));
  });

  async function loadCategories() {
    var tbody = document.getElementById("categoriesTableBody");
    if (!tbody || !window.AdminAPI) return;

    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">'+tr('loading_categories','Loading categories...')+'</td></tr>';

    try {
      var data = await window.AdminAPI.get("/admin/categories", {
        page: state.page,
        limit: state.limit,
        search: state.search,
        status: state.status,
        sort: state.sort
      });

      state.total = data.total || 0;
      state.pages = data.pages || Math.max(Math.ceil(state.total / state.limit), 1);
      window.__categoriesCache = data.categories || [];
      renderCategories(window.__categoriesCache);
      renderPagination();
    } catch (error) {
      tbody.innerHTML = tr('failed_load_categories', 'Failed to load categories: {error}', { error: error.message || '' });
    }
  }

  function renderCategories(categories) {
    var tbody = document.getElementById("categoriesTableBody");
    if (!tbody) return;

    if (!categories.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="table-empty">'+tr('no_categories','No categories found.')+'</td></tr>';
      return;
    }

    tbody.innerHTML = categories.map(function (cat) {
      var isActive = cat.isActive !== false;
      var icon = cat.icon || "fa-solid fa-tag";
      var badges = "";
      if (cat.isFeatured) badges += ' <span class="badge badge-warning">Featured</span>';
      if (cat.showOnHomepage) badges += ' <span class="badge badge-info">Homepage</span>';
      return (
        "<tr>" +
        '<td><strong>' + window.esc(categoryName(cat)) + '</strong><br><small class="table-muted">' + window.esc(icon) + badges + '</small></td>' +
        '<td><strong>' + Number(cat.itemCount || 0) + '</strong>' + (Number(cat.itemCount || 0) === 0 ? '<br><small class="table-muted">No foods yet</small>' : '') + '</td>' +
        '<td>' + (isActive ? '<span class="badge badge-success">' + tr('active', 'Active') + '</span>' : '<span class="badge badge-danger">' + tr('inactive', 'Inactive') + '</span>') + '</td>' +
        '<td>' + window.esc(categoryDescription(cat) || "-") + '</td>' +
        '<td>' + window.AdminAPI.formatDate(cat.createdAt) + '</td>' +
        '<td>' +
        '<div class="table-actions">' +
          '<button class="action-btn" data-action="view" data-id="' + window.esc(cat.id) + '" title="' + tr('view_details', 'View details') + '"><i class="fa-solid fa-eye"></i></button>' +
          '<button class="action-btn" data-action="edit" data-id="' + window.esc(cat.id) + '" title="' + tr('edit_category', 'Edit category') + '"><i class="fa-solid fa-pen"></i></button>' +
          '<button class="action-btn" data-action="toggle" data-id="' + window.esc(cat.id) + '" title="' + (isActive ? tr('deactivate', 'Deactivate') : tr('activate', 'Activate')) + '"><i class="fa-solid ' + (isActive ? "fa-toggle-on" : "fa-toggle-off") + '"></i></button>' +
          '<button class="action-btn danger" data-action="delete" data-id="' + window.esc(cat.id) + '" title="' + tr('delete_category', 'Delete category') + '"><i class="fa-solid fa-trash"></i></button>' +
        '</div>' +
        '</td>' +
        '</tr>'
      );
    }).join("");
  }

  function renderPagination() {
    var info = document.getElementById("paginationInfo");
    var prevBtn = document.getElementById("prevPageBtn");
    var nextBtn = document.getElementById("nextPageBtn");

    if (info) info.textContent = tr('page_of_categories', 'Page {page} of {pages} ({total} categories)').replace('{page}', state.page).replace('{pages}', Math.max(state.pages, 1)).replace('{total}', state.total);
    if (prevBtn) prevBtn.disabled = state.page <= 1;
    if (nextBtn) nextBtn.disabled = state.page >= state.pages;
  }

  function changePage(delta) {
    state.page += delta;
    if (state.page < 1) state.page = 1;
    loadCategories();
  }

  function openAddCategoryModal() {
    closeAllModals();
    resetImageState();
    var form = document.getElementById("categoryForm");
    if (form) form.reset();
    document.getElementById("categoryId").value = "";
    document.getElementById("categoryModalTitle").textContent = tr('admin_add_new_category', 'Add New Category');
    document.getElementById("saveCategoryBtn").textContent = tr('admin_save_category', 'Save Category');
    document.getElementById("categoryIsActive").checked = true;
    document.getElementById("categoryIsFeatured").checked = false;
    document.getElementById("categoryShowOnHomepage").checked = false;
    document.getElementById("categoryAvailEnabled").checked = false;
    document.getElementById("categorySortOrder").value = 0;
    document.getElementById("categoryNotes").value = "";
    document.getElementById("categoryAvailStart").value = "";
    document.getElementById("categoryAvailEnd").value = "";
    document.getElementById("availabilityTimeRow").style.display = "none";
    openModal("categoryModal");
  }

  function openEditCategoryModal(category) {
    if (!category) return;
    closeAllModals();
    resetImageState();
    document.getElementById("categoryForm").reset();
    document.getElementById("categoryId").value = category.id || "";
    document.getElementById("categoryName").value = categoryName(category);
    document.getElementById("categorySlug").value = category.slug || "";
    document.getElementById("categoryIcon").value = category.icon || "fa-solid fa-tag";
    document.getElementById("categoryImageUrl").value = category.imageUrl || "";
    document.getElementById("categoryDescription").value = categoryDescription(category);
    document.getElementById("categoryIsActive").checked = category.isActive !== false;
    document.getElementById("categorySortOrder").value = category.sortOrder || 0;
    document.getElementById("categoryIsFeatured").checked = category.isFeatured === true;
    document.getElementById("categoryShowOnHomepage").checked = category.showOnHomepage === true;
    document.getElementById("categoryNotes").value = category.notes || "";

    var avail = category.availabilityTime || {};
    document.getElementById("categoryAvailEnabled").checked = avail.enabled === true;
    document.getElementById("categoryAvailStart").value = avail.startTime || "";
    document.getElementById("categoryAvailEnd").value = avail.endTime || "";
    document.getElementById("availabilityTimeRow").style.display = avail.enabled ? "grid" : "none";

    if (category.imageUrl) {
      var src = category.imageUrl.indexOf("http") === 0 ? category.imageUrl : window.__API_BASE + category.imageUrl;
      var loading = document.getElementById("imageLoading");
      var error = document.getElementById("imageError");
      var preview = document.getElementById("categoryImagePreview");
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
      preview.src = src;
      preview.style.display = "none";
      document.getElementById("categoryImagePreviewRow").style.display = "flex";
    }

    document.getElementById("categoryModalTitle").textContent = tr('admin_edit_category', 'Edit Category');
    document.getElementById("saveCategoryBtn").textContent = tr('admin_update_category', 'Update Category');
    openModal("categoryModal");
  }

  async function handleCategoryFormSubmit(event) {
    event.preventDefault();

    var id = document.getElementById("categoryId").value;
    var availEnabled = document.getElementById("categoryAvailEnabled").checked;
    var payload = {
      name: document.getElementById("categoryName").value.trim(),
      slug: document.getElementById("categorySlug").value.trim() || document.getElementById("categoryName").value.trim().toLowerCase().replace(/\s+/g, "-"),
      icon: (document.getElementById("categoryIcon").value || "fa-solid fa-tag").trim(),
      description: document.getElementById("categoryDescription").value,
      isActive: document.getElementById("categoryIsActive").checked,
      sortOrder: parseInt(document.getElementById("categorySortOrder").value, 10) || 0,
      isFeatured: document.getElementById("categoryIsFeatured").checked,
      showOnHomepage: document.getElementById("categoryShowOnHomepage").checked,
      availabilityTime: {
        enabled: availEnabled,
        startTime: availEnabled ? document.getElementById("categoryAvailStart").value : "",
        endTime: availEnabled ? document.getElementById("categoryAvailEnd").value : "",
      },
      notes: document.getElementById("categoryNotes").value,
    };

    if (pendingImage) {
      if (pendingImage.type === "remove") {
        payload.imageUrl = "";
      } else {
        payload.imageUrl = pendingImage.value;
      }
    } else if (!id) {
      payload.imageUrl = null;
    }

    if (!payload.name) {
      if (window.AdminToast) window.AdminToast.error(tr('category_name_required', 'Category name is required'));
      return;
    }

    try {
      if (!id) {
        await window.AdminAPI.post("/admin/categories", payload);
      } else {
        await window.AdminAPI.put("/admin/categories/" + encodeURIComponent(id), payload);
      }
      closeModal("categoryModal");
      if (window.AdminToast) window.AdminToast.success(tr('category_saved', 'Category saved successfully'));
      loadCategories();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_save_category', 'Failed to save category'));
    }
  }

  async function toggleCategoryStatus(category) {
    if (!category) return;
    var nextStatus = category.isActive !== false ? false : true;
    var message = (category.isActive !== false ? "Deactivate" : "Activate") + ' category "' + categoryName(category) + '"?';

    if (!window.confirm(message)) return;

    try {
      await window.AdminAPI.patch("/admin/categories/" + encodeURIComponent(category.id) + "/status", { isActive: nextStatus });
      if (window.AdminToast) window.AdminToast.success(nextStatus ? tr('category_activated', 'Category activated') : tr('category_deactivated', 'Category deactivated'));
      loadCategories();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_update_category_status', 'Failed to update category status'));
    }
  }

  async function deleteCategory(category) {
    if (!category) return;
    if (!window.confirm(tr('admin_delete_category_confirm', 'Delete category "{name}"? This action cannot be undone.', { name: categoryName(category) }))) return;

    try {
      await window.AdminAPI.del("/admin/categories/" + encodeURIComponent(category.id));
      if (window.AdminToast) window.AdminToast.success(tr('category_deleted', 'Category deleted successfully'));
      if (state.total === 1 && state.page > 1) state.page--;
      loadCategories();
    } catch (error) {
      if (window.AdminToast) window.AdminToast.error(error.message || tr('error_delete_category', 'Failed to delete category'));
    }
  }

  function findCategoryById(id) {
    return window.AdminAPI.get("/admin/categories/" + encodeURIComponent(id)).then(function(d) { return d.category; }).catch(function() { return null; });
  }

  function bindEvents() {
    var openBtn = document.getElementById("openAddCategoryBtn");
    if (openBtn) openBtn.addEventListener("click", openAddCategoryModal);

    var form = document.getElementById("categoryForm");
    if (form) form.addEventListener("submit", handleCategoryFormSubmit);

    var availToggle = document.getElementById("categoryAvailEnabled");
    if (availToggle) {
      availToggle.addEventListener("change", function() {
        document.getElementById("availabilityTimeRow").style.display = availToggle.checked ? "grid" : "none";
      });
    }

    var fileInput = document.getElementById("categoryImageFile");
    if (fileInput) fileInput.addEventListener("change", function () {
      handleImageFileChange(fileInput.files[0]);
    });

    var urlInput = document.getElementById("categoryImageUrl");
    if (urlInput) urlInput.addEventListener("input", function () {
      handleImageUrlInput(urlInput.value);
    });

    var removeImageBtn = document.getElementById("removeCategoryImageBtn");
    if (removeImageBtn) {
      removeImageBtn.addEventListener("click", function () {
        pendingImage = { type: "remove", value: "" };
        document.getElementById("categoryImageFile").value = "";
        document.getElementById("categoryImageUrl").value = "";
        var urlInput = document.getElementById("categoryImageUrl");
        if (urlInput) { urlInput.classList.remove("url-valid"); urlInput.classList.remove("url-invalid"); }
        var feedback = document.getElementById("urlFeedback");
        if (feedback) { feedback.textContent = ""; feedback.className = "url-feedback"; }
        var preview = document.getElementById("categoryImagePreview");
        var loading = document.getElementById("imageLoading");
        var error = document.getElementById("imageError");
        if (preview) preview.removeAttribute("src");
        if (loading) loading.style.display = "none";
        if (error) error.style.display = "none";
        preview.onerror = null;
        preview.onload = null;
        document.getElementById("categoryImagePreviewRow").style.display = "none";
      });
    }

    var searchInput = document.getElementById("categorySearchInput");
    if (searchInput) {
      var debounceTimer = null;
      searchInput.addEventListener("input", function() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function() {
          state.search = searchInput.value.trim();
          state.page = 1;
          loadCategories();
        }, 400);
      });
    }

    var statusFilter = document.getElementById("statusFilter");
    if (statusFilter) {
      statusFilter.addEventListener("change", function() {
        state.status = statusFilter.value;
        state.page = 1;
        loadCategories();
      });
    }
    var sortFilter = document.getElementById("sortFilter");
    if (sortFilter) sortFilter.addEventListener("change", function() { state.sort = sortFilter.value; state.page = 1; loadCategories(); });

    var resetBtn = document.getElementById("resetFiltersBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", function() {
        if (searchInput) searchInput.value = "";
        if (statusFilter) statusFilter.value = "";
        state.search = "";
        state.status = "";
        state.page = 1;
        loadCategories();
      });
    }

    var prevBtn = document.getElementById("prevPageBtn");
    if (prevBtn) prevBtn.addEventListener("click", function() { if (state.page > 1) changePage(-1); });
    var nextBtn = document.getElementById("nextPageBtn");
    if (nextBtn) nextBtn.addEventListener("click", function() { changePage(1); });

    var tbody = document.getElementById("categoriesTableBody");
    if (tbody) {
      tbody.addEventListener("click", async function(e) {
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        var id = btn.getAttribute("data-id");
        var action = btn.getAttribute("data-action");
        if (!id) return;

        var category = (window.__categoriesCache || []).find(function(c) { return c.id === id; });
        if (!category && (action === "view" || action === "edit" || action === "toggle" || action === "delete")) {
          category = await findCategoryById(id);
        }
        if (!category) {
          if (window.AdminToast) window.AdminToast.error(tr('category_not_found', 'Category not found'));
          return;
        }

        if (action === "view") {
          var details = await window.AdminAPI.get("/admin/categories/" + encodeURIComponent(category.id));
          var cat = details.category || category;
          document.getElementById("categoryDetailIcon").textContent = cat.icon || "🍽️";
          document.getElementById("categoryDetailName").textContent = categoryName(cat);
          document.getElementById("categoryDetailDescription").textContent = categoryDescription(cat) || tr('no_description', 'No description');
          document.getElementById("categoryDetailId").textContent = cat.id || "-";
          document.getElementById("categoryDetailSlug").textContent = cat.slug || cat.id || "-";
          document.getElementById("categoryDetailStatus").textContent = cat.isActive ? tr('active', 'Active') : tr('inactive', 'Inactive');
          document.getElementById("categoryDetailCount").textContent = (details.foods || []).length;
          document.getElementById("categoryDetailSortOrder").textContent = cat.sortOrder || 0;
          document.getElementById("categoryDetailFeatured").textContent = cat.isFeatured ? tr('yes', 'Yes') : tr('no', 'No');
          document.getElementById("categoryDetailHomepage").textContent = cat.showOnHomepage ? tr('yes', 'Yes') : tr('no', 'No');
          document.getElementById("categoryDetailAvailTime").textContent = formatTimeRange(cat.availabilityTime);
          document.getElementById("categoryDetailNotes").textContent = cat.notes || "—";
          document.getElementById("categoryDetailCreated").textContent = window.AdminAPI.formatDate(cat.createdAt);
          document.getElementById("categoryDetailUpdated").textContent = window.AdminAPI.formatDate(cat.updatedAt);
          document.getElementById("categoryDetailFoods").innerHTML = (details.foods || []).map(function(food) {
            return '<tr><td>' + window.esc(food.name.en || food.name) + '</td><td>' + Number(food.price || 0) + ' ETB</td><td>' + Number(food.stockQuantity || 0) + '</td><td>' + window.esc(food.availabilityStatus || "-") + '</td></tr>';
          }).join("") || '<tr><td colspan="4">No foods have been added to this category yet.</td></tr>';
          openModal("categoryDetailsModal");
        } else if (action === "edit") openEditCategoryModal(category);
        else if (action === "toggle") toggleCategoryStatus(category);
        else if (action === "delete") deleteCategory(category);
      });
    }
  }

  function init() {
    bindEvents();
    loadCategories();
    window.AdminAPI.get("/admin/categories/stats").then(function(data) {
      var stats = data.stats || {};
      document.getElementById("metricTotalCategories").textContent = stats.totalCategories || 0;
      document.getElementById("metricActiveCategories").textContent = stats.active || 0;
      document.getElementById("metricInactiveCategories").textContent = stats.inactive || 0;
      document.getElementById("metricEmptyCategories").textContent = stats.empty || 0;
    }).catch(function() {});
  }

  document.addEventListener("DOMContentLoaded", init);
})();
