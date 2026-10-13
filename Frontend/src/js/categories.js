function tr(key, fallback, vars) {
  if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
  if (typeof window.getText === 'function') { var r = window.getText(key); if (r && r !== key) return r; }
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - CATEGORIES MODULE
 * ================================================================
 * Handles:
 * - Category state & retrieval
 * - Category item count aggregation
 * - Category UI rendering & active state management
 * - Admin category management (Add, Update, Delete)
 * ================================================================
 */

const MENU_CATEGORIES = window.MENU_CATEGORIES || [];
import { getAllMenuItems } from "./menu.js";

// ================================================================
// 1. CATEGORY STATE
// ================================================================

let categories = Array.isArray(MENU_CATEGORIES) ? [...MENU_CATEGORIES] : [];
let activeCategoryId = null;

// ================================================================
// 2. HELPER FUNCTIONS
// ================================================================

/**
 * Get localized or default category name.
 */
function getCategoryName(category, language = "en") {
  if (!category) return "";
  if (typeof category.name === "string") return category.name;

  return (
    category.name?.[language] ||
    category.name?.en ||
    category.name?.am ||
    category.id ||
    ""
  );
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHTML(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ================================================================
// 3. CATEGORY DATA ACCESSORS
// ================================================================

/**
 * Get all categories with calculated item counts.
 */
export function getCategories(language = "en") {
  const allItems = getAllMenuItems();

  return categories.map(category => {
    const count = allItems.filter(item => item.category === category.id).length;

    return {
      ...category,
      displayName: getCategoryName(category, language),
      itemCount: count
    };
  });
}

/**
 * Get category details by ID.
 */
export function getCategoryById(categoryId, language = "en") {
  if (!categoryId) return null;

  const category = categories.find(cat => cat.id === categoryId);
  if (!category) return null;

  const allItems = getAllMenuItems();
  const count = allItems.filter(item => item.category === categoryId).length;

  return {
    ...category,
    displayName: getCategoryName(category, language),
    itemCount: count
  };
}

// ================================================================
// 4. ACTIVE CATEGORY FILTER STATE
// ================================================================

export function setActiveCategory(categoryId) {
  activeCategoryId = categoryId && categoryId.trim() !== "" ? categoryId : null;
}

export function getActiveCategory() {
  return activeCategoryId;
}

export function clearActiveCategory() {
  activeCategoryId = null;
}

// ================================================================
// 5. ADMIN CATEGORY MANAGEMENT
// ================================================================

export function addCategory(categoryData = {}) {
  if (!categoryData.id || !categoryData.name) {
    return { success: false, error: tr('category_id_name_required', 'Category ID and name are required.') };
  }

  const idExists = categories.some(cat => cat.id === categoryData.id);
  if (idExists) {
    return { success: false, error: tr('category_id_exists', 'Category ID already exists.') };
  }

  const newCategory = {
    id: categoryData.id.toLowerCase().replace(/\s+/g, "-"),
    name: categoryData.name,
    icon: categoryData.icon || "🍔",
    description: categoryData.description || ""
  };

  categories.push(newCategory);
  return { success: true, category: newCategory };
}

export function updateCategory(id, updates = {}) {
  const index = categories.findIndex(cat => cat.id === id);
  if (index === -1) {
    return { success: false, error: tr('category_not_found_generic', 'Category not found.') };
  }

  categories[index] = {
    ...categories[index],
    ...updates
  };

  return { success: true, category: categories[index] };
}

export function deleteCategory(id) {
  const index = categories.findIndex(cat => cat.id === id);
  if (index === -1) {
    return { success: false, error: tr('category_not_found_generic', 'Category not found.') };
  }

  // Prevent deletion if items are still assigned to this category
  const allItems = getAllMenuItems();
  const hasItems = allItems.some(item => item.category === id);

  if (hasItems) {
    return {
      success: false,
      error: tr('category_has_active_items', 'Cannot delete category containing active menu items.')
    };
  }

  categories.splice(index, 1);
  return { success: true };
}

// ================================================================
// 6. UI RENDERER
// ================================================================

/**
 * Dynamically render category buttons into a target container.
 * @param {string} containerId - DOM container ID (e.g., 'category-list')
 * @param {Function} onSelectCallback - Event handler when a category is clicked
 * @param {string} language - Localized language choice ('en' | 'am')
 */
export function renderCategoriesUI(containerId = "category-list", onSelectCallback, language = "en") {
  const container = document.getElementById(containerId);
  if (!container) return;

  const categoryDataList = getCategories(language);
  const totalCount = getAllMenuItems().length;

  const allButtonHTML = `
    <button 
      type="button" 
      class="filter-btn ${activeCategoryId === null ? 'active' : ''}" 
      data-category="all"
    >
      <span class="category-icon">🍽️</span>
      <span class="category-name">All Items</span>
      <span class="category-badge">${totalCount}</span>
    </button>
  `;

  const categoryButtonsHTML = categoryDataList.map(cat => {
    const isActive = activeCategoryId === cat.id ? 'active' : '';
    return `
      <button 
        type="button" 
        class="filter-btn ${isActive}" 
        data-category="${escapeHTML(cat.id)}"
      >
        <span class="category-icon">${escapeHTML(cat.icon || '🍽️')}</span>
        <span class="category-name">${escapeHTML(cat.displayName)}</span>
        <span class="category-badge">${cat.itemCount}</span>
      </button>
    `;
  }).join('');

  container.innerHTML = allButtonHTML + categoryButtonsHTML;

  // Event Delegation
  container.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const selectedCat = btn.getAttribute('data-category');
      const targetCat = selectedCat === 'all' ? null : selectedCat;

      setActiveCategory(targetCat);

      container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (typeof onSelectCallback === 'function') {
        onSelectCallback(targetCat);
      }
    });
  });
}