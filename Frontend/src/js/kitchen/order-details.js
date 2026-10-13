const API_BASE = window.__API_URL;

// Get order ID from URL
const urlParams = new URLSearchParams(window.location.search);
const orderId = urlParams.get('id');

if (!orderId) {
    window.location.href = 'dashboard.html';
}

let orderData = null;

// Initialize page
document.addEventListener('DOMContentLoaded', () => {
    loadOrderDetails();
    loadCurrentUserShift();
});

if (typeof window.onLanguageChange === 'function' || typeof window.onLanguageChangeSafe === 'function' || typeof window.i18nOnLanguageChange === 'function') {
    const register = window.onLanguageChangeSafe || window.onLanguageChange || window.i18nOnLanguageChange;
    register(() => {
        try {
            renderOrderDetails();
        } catch (e) { /* language-change re-render is best-effort */ }
    });
}

async function loadOrderDetails() {
    try {
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${API_BASE}/kitchen/orders/${orderId}/details`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!data.success) {
            showAlert('Error loading order details', 'error');
            return;
        }

        orderData = data.order;
        renderOrderDetails();

    } catch (error) {
        console.error('Error:', error);
        showAlert('Failed to load order details', 'error');
    }
}

function renderOrderDetails() {
    if (!orderData) return;

    // Update header
    document.getElementById('orderNumber').textContent = `Order #${orderData.orderId}`;
    document.getElementById('statusBadge').textContent = window.translateStatus
        ? window.translateStatus(orderData.status)
        : orderData.status.toUpperCase();
    document.getElementById('statusBadge').className = `status-badge status-${orderData.status}`;
    document.getElementById('priorityBadge').textContent = (orderData.priority || 'NORMAL').toUpperCase();
    document.getElementById('priorityBadge').className = `priority-badge priority-${orderData.priority || 'normal'}`;

    // Update customer info
    document.getElementById('customerName').textContent = orderData.customer.name;
    document.getElementById('customerPhone').textContent = orderData.customer.phone;
    document.getElementById('orderType').textContent = orderData.orderType.toUpperCase();
    document.getElementById('tableNumber').textContent = orderData.tableNumber || 'N/A';

    // Render items
    renderOrderItems();

    // Render summary
    document.getElementById('subtotal').textContent = `Br ${orderData.subtotal.toFixed(2)}`;
    document.getElementById('serviceFee').textContent = `Br ${orderData.serviceFee.toFixed(2)}`;
    document.getElementById('totalAmount').textContent = `Br ${orderData.totalAmount.toFixed(2)}`;

    // Render timeline
    renderTimeline();

    // Render actions
    renderActions();
}

function renderOrderItems() {
    const itemsList = document.getElementById('itemsList');
    itemsList.innerHTML = '';

    orderData.items.forEach((item, index) => {
        const itemCard = document.createElement('div');
        itemCard.className = 'item-card';
        itemCard.innerHTML = `
            <div class="item-info">
                <div class="item-name">${item.name}</div>
                ${item.notes ? `<div class="item-notes">Note: ${item.notes}</div>` : ''}
            </div>
            <span class="item-quantity">×${item.quantity}</span>
            <select class="item-status-select" onchange="updateItemStatus('${index}', this.value)">
                <option value="pending" ${item.itemStatus === 'pending' ? 'selected' : ''}>Pending</option>
                <option value="preparing" ${item.itemStatus === 'preparing' ? 'selected' : ''}>Preparing</option>
                <option value="ready" ${item.itemStatus === 'ready' ? 'selected' : ''}>Ready</option>
                <option value="served" ${item.itemStatus === 'served' ? 'selected' : ''}>Served</option>
            </select>
        `;
        itemsList.appendChild(itemCard);
    });
}

function renderTimeline() {
    const timeline = document.getElementById('timeline');
    timeline.innerHTML = '';

    const events = [];

    // Order created
    events.push({
        time: new Date(orderData.createdAt),
        text: 'Order placed'
    });

    // Order accepted
    if (orderData.status !== 'pending') {
        events.push({
            time: orderData.createdAt, // Approximate
            text: 'Order accepted by kitchen'
        });
    }

    // Ready
    if (orderData.readyTime) {
        events.push({
            time: new Date(orderData.readyTime),
            text: 'Order ready for pickup'
        });
    }

    // Completed
    if (orderData.completedTime) {
        events.push({
            time: new Date(orderData.completedTime),
            text: 'Order served'
        });
    }

    // Current time info
    const now = new Date();
    const elapsed = Math.round((now - new Date(orderData.createdAt)) / 60000);
    const isAm = typeof window.getCurrentLanguage === 'function' && window.getCurrentLanguage() === 'am';
    events.push({
        time: now,
        text: isAm ? `በኩሽና ውስጥ ለ${elapsed} ደቂቃ ቆይቷል` : `Currently in kitchen for ${elapsed} minutes`
    });

    events.forEach(event => {
        const item = document.createElement('div');
        item.className = 'timeline-item';
        item.innerHTML = `
            <div class="timeline-dot"></div>
            <div class="timeline-content">
                <div class="timeline-time">${event.time.toLocaleTimeString()}</div>
                <div class="timeline-text">${event.text}</div>
            </div>
        `;
        timeline.appendChild(item);
    });
}

function renderActions() {
    const container = document.getElementById('actionsContainer');
    container.innerHTML = '';

    const status = orderData.status;

    if (status === 'preparing') {
        const readyBtn = document.createElement('button');
        readyBtn.className = 'action-btn btn-ready';
        readyBtn.textContent = '✓ Mark as Ready';
        readyBtn.onclick = markOrderReady;
        container.appendChild(readyBtn);
    }

    if (status === 'ready') {
        const serveBtn = document.createElement('button');
        serveBtn.className = 'action-btn btn-serve';
        serveBtn.textContent = '✓ Mark as Served';
        serveBtn.onclick = markOrderServed;
        container.appendChild(serveBtn);
    }

    // Delay button (for pending and preparing)
    if (status === 'pending' || status === 'preparing') {
        const delayBtn = document.createElement('button');
        delayBtn.className = 'action-btn btn-delay';
        delayBtn.textContent = '⏱ Report Delay';
        delayBtn.onclick = openDelayModal;
        container.appendChild(delayBtn);
    }

    // Back button
    const backBtn = document.createElement('button');
    backBtn.className = 'action-btn btn-back';
    backBtn.textContent = '← Back to Dashboard';
    backBtn.onclick = () => window.location.href = 'dashboard.html';
    container.appendChild(backBtn);
}

async function updateItemStatus(itemIndex, newStatus) {
    try {
        const token = localStorage.getItem('auth_token');
        const itemId = orderData.items[itemIndex].id;

        const response = await fetch(`${API_BASE}/kitchen/orders/${orderId}/items/${itemId}/status`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ itemStatus: newStatus })
        });

        const data = await response.json();

        if (!data.success) {
            showAlert('Failed to update item status', 'error');
            renderOrderItems();
            return;
        }

        showAlert('Item status updated', 'success');
        loadOrderDetails();

    } catch (error) {
        console.error('Error:', error);
        showAlert('Failed to update item status', 'error');
        renderOrderItems();
    }
}

async function markOrderReady() {
    if (!confirm(typeof window.tr === 'function' ? window.tr('kitchen_confirm_mark_ready', 'Mark this order as READY?') : 'Mark this order as READY?')) return;

    try {
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${API_BASE}/kitchen/orders/${orderId}/ready`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!data.success) {
            showAlert('Failed to mark order as ready', 'error');
            return;
        }

        showAlert('Order marked as ready!', 'success');
        setTimeout(() => window.location.reload(), 1500);

    } catch (error) {
        console.error('Error:', error);
        showAlert('Failed to mark order as ready', 'error');
    }
}

async function markOrderServed() {
    if (!confirm(typeof window.tr === 'function' ? window.tr('kitchen_confirm_mark_served', 'Mark this order as SERVED?') : 'Mark this order as SERVED?')) return;

    try {
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${API_BASE}/kitchen/orders/${orderId}/serve`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!data.success) {
            showAlert('Failed to mark order as served', 'error');
            return;
        }

        showAlert('Order marked as served!', 'success');
        setTimeout(() => window.location.href = 'dashboard.html', 1500);

    } catch (error) {
        console.error('Error:', error);
        showAlert('Failed to mark order as served', 'error');
    }
}

function openDelayModal() {
    document.getElementById('delayModal').classList.add('active');
}

function closeDelayModal() {
    document.getElementById('delayModal').classList.remove('active');
    document.getElementById('delayForm').reset();
}

document.getElementById('delayForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const reason = document.getElementById('delayReason').value;

    try {
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${API_BASE}/kitchen/orders/${orderId}/delay`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ reason })
        });

        const data = await response.json();

        if (!data.success) {
            showAlert('Failed to report delay', 'error');
            return;
        }

        showAlert('Delay reported and customer notified', 'success');
        closeDelayModal();
        loadOrderDetails();

    } catch (error) {
        console.error('Error:', error);
        showAlert('Failed to report delay', 'error');
    }
});

function showAlert(message, type = 'info') {
    const container = document.getElementById('alertContainer');
    const alert = document.createElement('div');
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    container.appendChild(alert);

    setTimeout(() => alert.remove(), 4000);
}

async function loadCurrentUserShift() {
    try {
        const token = localStorage.getItem('auth_token');
        const response = await fetch(`${API_BASE}/kitchen-staff/shifts/current`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        // Just for future use - can display shift info on the page
    } catch (error) {
        console.error('Error loading shift:', error);
    }
}
