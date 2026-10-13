const API_BASE = window.__API_URL;

let allItems = [];

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
    loadMenuAvailability();
});

function isAmharic() {
    return typeof window.getCurrentLanguage === 'function' && window.getCurrentLanguage() === 'am';
}

function tr(key, fallback, vars) {
    if (typeof window.tr === 'function' && window.tr !== tr) return window.tr(key, fallback, vars);
    if (typeof window.getText === 'function') {
        const v = window.getText(key);
        if (v && v !== key) return v;
    }
    return fallback != null ? fallback : key;
}

function registerLangChange(fn) {
    const register = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
    if (typeof register === 'function') register(fn);
    else window.addEventListener('language:changed', fn);
}

registerLangChange(() => {
    try {
        if (!document.getElementById('itemsGrid')) return;
        filterItems();
    } catch (e) { /* best-effort re-render */ }
});

async function loadMenuAvailability() {
    try {
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${API_BASE}/kitchen/menu-availability`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!data.success) {
            showAlert(tr('kitchen_error_loading_menu', 'Error loading menu items'), 'error');
            return;
        }

        allItems = data.items || [];
        renderItems(allItems);

    } catch (error) {
        console.error('Error:', error);
        showAlert(tr('kitchen_failed_loading_menu', 'Failed to load menu items'), 'error');
    }
}

function renderItems(items) {
    const grid = document.getElementById('itemsGrid');
    if (!grid) return;
    grid.innerHTML = '';

    if (items.length === 0) {
        grid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; padding: 40px; color: #666;">' + escapeHtml(tr('kitchen_no_items', 'No items found')) + '</p>';
        return;
    }

    items.forEach(item => {
        const card = document.createElement('div');
        card.className = `item-card ${!item.isAvailable ? 'unavailable' : ''}`;

        const lastUpdate = item.lastUpdate ? new Date(item.lastUpdate).toLocaleDateString() : tr('kitchen_never', 'Never');
        const nameObj = item.name && typeof item.name === 'object' ? item.name : { en: item.name };
        const lang = (typeof window.getCurrentLanguage === 'function' && window.getCurrentLanguage()) || 'en';
        const itemName = (lang === 'am' && nameObj.am) ? nameObj.am : (nameObj.en || item.name || '');

        card.innerHTML = `
            <div class="item-header">
                <div class="item-name">${escapeHtml(itemName)}</div>
                <span class="availability-badge ${item.isAvailable ? 'badge-available' : 'badge-unavailable'}">
                    ${item.isAvailable ? '<i class="fa-solid fa-check"></i> ' + escapeHtml(tr('kitchen_available', 'Available')) : '<i class="fa-solid fa-xmark"></i> ' + escapeHtml(tr('kitchen_unavailable', 'Unavailable'))}
                </span>
            </div>

            <div class="item-details">
                <div class="detail-item">
                    <span class="detail-label">${escapeHtml(tr('kitchen_category', 'Category'))}</span>
                    <span class="detail-value">${escapeHtml(item.category)}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">${escapeHtml(tr('kitchen_price', 'Price'))}</span>
                    <span class="detail-value">Br ${escapeHtml(String(item.price))}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">${escapeHtml(tr('kitchen_prep_time', 'Prep Time'))}</span>
                    <span class="detail-value">${escapeHtml(String(item.preparationTime))} ${escapeHtml(tr('kitchen_mins', 'mins'))}</span>
                </div>
                <div class="detail-item">
                    <span class="detail-label">${escapeHtml(tr('kitchen_last_updated', 'Last Updated'))}</span>
                    <span class="detail-value">${escapeHtml(lastUpdate)}</span>
                </div>
            </div>

            ${item.outOfStockReason ? `
                <div class="unavailable-reason">
                    <strong>${escapeHtml(tr('kitchen_reason', 'Reason'))}:</strong> ${escapeHtml(item.outOfStockReason)}
                </div>
            ` : ''}

            <div class="action-buttons">
                ${item.isAvailable ? `
                    <button class="btn btn-mark-unavailable" onclick="openUnavailableModal('${escapeHtml(item.id)}')">
                        ${escapeHtml(tr('kitchen_mark_unavailable', 'Mark Unavailable'))}
                    </button>
                ` : `
                    <button class="btn btn-mark-available" onclick="markAvailable('${escapeHtml(item.id)}')">
                        ${escapeHtml(tr('kitchen_mark_available', 'Mark Available'))}
                    </button>
                `}
            </div>
        `;

        grid.appendChild(card);
    });
}

function filterItems() {
    const category = document.getElementById('categoryFilter').value;
    const status = document.getElementById('statusFilter').value;

    let filtered = allItems;

    if (category) {
        filtered = filtered.filter(item => item.category === category);
    }

    if (status === 'available') {
        filtered = filtered.filter(item => item.isAvailable);
    } else if (status === 'unavailable') {
        filtered = filtered.filter(item => !item.isAvailable);
    }

    renderItems(filtered);
}

function openUnavailableModal(itemId) {
    document.getElementById('itemIdForModal').value = itemId;
    document.getElementById('unavailableModal').classList.add('active');
}

function closeUnavailableModal() {
    document.getElementById('unavailableModal').classList.remove('active');
    document.getElementById('unavailableForm').reset();
}

document.getElementById('unavailableForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const itemId = document.getElementById('itemIdForModal').value;
    const reason = document.getElementById('unavailableReason').value;

    try {
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${API_BASE}/kitchen/menu/${itemId}/availability`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                isAvailable: false,
                reason: reason
            })
        });

        const data = await response.json();

        if (!data.success) {
            showAlert(tr('kitchen_failed_update_availability', 'Failed to update availability'), 'error');
            return;
        }

        showAlert(tr('kitchen_item_marked_unavailable', 'Item marked as unavailable and customers notified'), 'success');
        closeUnavailableModal();
        loadMenuAvailability();

    } catch (error) {
        console.error('Error:', error);
        showAlert(tr('kitchen_failed_update_availability', 'Failed to update availability'), 'error');
    }
});

async function markAvailable(itemId) {
    if (!confirm(tr('kitchen_confirm_mark_available', 'Mark this item as available?'))) return;

    try {
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${API_BASE}/kitchen/menu/${itemId}/availability`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                isAvailable: true
            })
        });

        const data = await response.json();

        if (!data.success) {
            showAlert(tr('kitchen_failed_update_availability', 'Failed to update availability'), 'error');
            return;
        }

        showAlert(tr('kitchen_item_marked_available', 'Item marked as available'), 'success');
        loadMenuAvailability();

    } catch (error) {
        console.error('Error:', error);
        showAlert(tr('kitchen_failed_update_availability', 'Failed to update availability'), 'error');
    }
}

function showAlert(message, type = 'info') {
    const container = document.getElementById('alertContainer');
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    container.appendChild(alert);

    setTimeout(() => alert.remove(), 4000);
}
