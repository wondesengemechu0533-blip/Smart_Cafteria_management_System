/**
 * Kitchen Display System (KDS) Module
 * Features: Real-time Socket.io updates, Status Filters, State Progression, Dynamic Elapsed Time
 */

import { socketClient } from "../../js/socket.js";
import api from "../../js/api.js";

document.addEventListener('DOMContentLoaded', () => {
    KDS.init();
});

const KDS = {
    orders: new Map(), // orderId -> order object
    sentToDelivery: new Set(), // orderIds already sent to delivery
    pickedUpToDriver: new Set(), // orderIds handed to driver
    currentFilter: 'all',
    gridContainer: null,
    tableBody: null,
    pendingCountEl: null,
    preparingCountEl: null,
    readyCountEl: null,
    updateInterval: null,
    _inflight: new Set(),

    setActionLoading(orderId, loading) {
        const containers = [this.gridContainer, this.tableBody];
        containers.forEach(container => {
            if (!container) return;
            const buttons = container.querySelectorAll(
                `.js-action-btn[data-id="${orderId}"], .js-send-delivery-btn[data-id="${orderId}"], .js-handoff-btn[data-id="${orderId}"]`
            );
            buttons.forEach(btn => {
                btn.disabled = loading;
                btn.classList.toggle('btn-loading', loading);
            });
        });
    },

    async init() {
        this.cacheDOM();
        this.bindEvents();
        this.setupSocketListeners();
        await this.loadInitialOrders();
        this.startTimer();
        this.startPolling();
        this.render();
    },

    cacheDOM() {
        this.gridContainer = document.getElementById('kitchenTicketsGrid');
        this.tableBody = document.getElementById('kitchenOrdersBody');
        this.pendingCountEl = document.getElementById('pendingCount');
        this.preparingCountEl = document.getElementById('preparingCount');
        this.readyCountEl = document.getElementById('readyCount');
    },

    bindEvents() {
        const filterButtons = document.querySelectorAll('.filter-group .btn');
        filterButtons.forEach(button => {
            button.addEventListener('click', () => {
                filterButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                this.currentFilter = button.dataset.status || 'all';
                this.render();
            });
        });
    },

    async loadInitialOrders() {
        try {
            const response = await api.get('/kitchen/dashboard');
            if (response.success) {
                // Combine all orders from different statuses
                const allOrders = [
                    ...(response.orders.pending || []),
                    ...(response.orders.preparing || []),
                    ...(response.orders.ready || [])
                ];
                allOrders.forEach(order => {
                    this.orders.set(order.orderId, order);
                });
                this.updateStats();
                this.render();
            }
        } catch (error) {
            console.error('Failed to load initial orders:', error);
        }
    },

    async refreshOrders() {
        try {
            const response = await api.get('/kitchen/dashboard');
            if (response.success) {
                const allOrders = [
                    ...(response.orders.pending || []),
                    ...(response.orders.preparing || []),
                    ...(response.orders.ready || [])
                ];
                allOrders.forEach(order => {
                    this.orders.set(order.orderId, order);
                });
                // Drop orders that are no longer active (served/cancelled/etc.)
                const activeIds = new Set(allOrders.map(o => o.orderId));
                const servedOrCancelled = [];
                this.orders.forEach((order, orderId) => {
                    if (!activeIds.has(orderId) &&
                        ['served', 'cancelled', 'delivered', 'out_for_delivery', 'picked_up'].includes(String(order.status || '').toLowerCase())) {
                        servedOrCancelled.push(orderId);
                    }
                });
                servedOrCancelled.forEach(id => this.orders.delete(id));
                this.updateStats();
                this.render();
            }
        } catch (error) {
            console.error('Failed to refresh orders:', error);
        }
    },

    setupSocketListeners() {
        const token = localStorage.getItem('auth_token');
        if (!token) {
            console.warn('No auth token found, skipping socket connection');
            return;
        }

        // Re-fetch orders whenever the socket (re)connects so any orders created
        // while disconnected are picked up and always displayed.
        socketClient.on('connect', () => {
            this.refreshOrders();
        });

        socketClient.on('order:new', (order) => this.handleNewOrder(order));
        socketClient.on('order:status', (order) => this.handleStatusUpdate(order));
        socketClient.on('order:payment', (order) => this.handlePaymentComplete(order));

        // Register listeners before connecting so a fast connection cannot
        // deliver an order event before the handlers are ready.
        socketClient.connect(token);
    },

    handleNewOrder(order) {
        console.log('New order received:', order);
        this.orders.set(order.orderId, order);
        this.playNotificationSound();
        this.updateStats();
        this.render();
    },

    handleStatusUpdate(order) {
        console.log('Order status update:', order);
        this.orders.set(order.orderId, order);
        this.updateStats();
        this.render();
    },

    handlePaymentComplete(order) {
        console.log('Payment completed for order:', order);
        this.orders.set(order.orderId, order);
        this.updateStats();
        this.render();
    },

    updateStats() {
        let pending = 0, preparing = 0, ready = 0;
        
        this.orders.forEach(order => {
            const status = order.status?.toLowerCase();
            if (status === 'pending') pending++;
            else if (status === 'preparing') preparing++;
            else if (status === 'ready') ready++;
        });

        if (this.pendingCountEl) this.pendingCountEl.textContent = pending;
        if (this.preparingCountEl) this.preparingCountEl.textContent = preparing;
        if (this.readyCountEl) this.readyCountEl.textContent = ready;
    },

    getFilteredOrders() {
        const orders = Array.from(this.orders.values());
        if (!this.currentFilter || this.currentFilter.toLowerCase() === 'all') {
            return orders.filter(o => o.status !== 'served' && o.status !== 'cancelled');
        }
        return orders.filter(o => 
            o.status?.toLowerCase() === this.currentFilter.toLowerCase()
        );
    },

    getElapsedTime(createdAt) {
        if (!createdAt) return '00 mins';
        const diffMs = new Date() - new Date(createdAt);
        const diffMins = Math.floor(diffMs / 60000);
        return `${String(diffMins).padStart(2, '0')} mins`;
    },

    async updateOrderStatus(orderId, newStatus) {
        if (this._inflight.has(orderId)) return;
        this._inflight.add(orderId);
        this.setActionLoading(orderId, true);

        try {
            const endpoint = newStatus === 'preparing' ? 'accept' : 
                            newStatus === 'ready' ? 'ready' : 
                            newStatus === 'served' ? 'serve' : null;
            
            if (!endpoint) return;

            const response = await api.patch(`/kitchen/orders/${orderId}/${endpoint}`);
            if (response.success) {
                // Socket will handle the update, but we can optimistically update
                const order = this.orders.get(orderId);
                if (order) {
                    order.status = newStatus;
                    if (newStatus === 'ready') order.readyTime = new Date().toISOString();
                    if (newStatus === 'served') order.completedTime = new Date().toISOString();
                    this.updateStats();
                    this.render();
                }
            }
        } catch (error) {
            console.error('Failed to update order status:', error);
            const isStatusConflict = error.status === 400 && /status/i.test(error.message || '');
            if (isStatusConflict) {
                await this.refreshOrders();
                const live = this.orders.get(orderId);
                if (live && live.status?.toLowerCase() === newStatus) return;
            }
            alert((error && error.message) || 'Failed to update order status. Please try again.');
        } finally {
            this._inflight.delete(orderId);
            this.setActionLoading(orderId, false);
        }
    },

    getBadgeClass(status) {
        switch (status?.toLowerCase()) {
            case 'pending': return 'badge-pending';
            case 'preparing': return 'badge-preparing';
            case 'ready': return 'badge-ready';
            case 'picked_up': return 'badge-picked-up';
            case 'cancelled': return 'badge-cancelled';
            case 'served': return 'badge-served';
            default: return '';
        }
    },

    getActionButtonHTML(order) {
        const status = order.status?.toLowerCase();
        const orderId = order.orderId;
        const isDelivery = String(order.orderType || '').toLowerCase() === 'delivery';
        
        if (status === 'pending') {
            return `<button class="btn btn-advance js-action-btn" data-id="${orderId}" data-next-status="preparing">
                        <i class="fa-solid fa-fire"></i> Start Prep
                    </button>`;
        } else if (status === 'preparing') {
            return `<button class="btn btn-advance js-action-btn" data-id="${orderId}" data-next-status="ready">
                        <i class="fa-solid fa-check"></i> Mark Ready
                    </button>`;
        } else if (status === 'ready') {
            if (isDelivery) {
                const sent = this.sentToDelivery.has(orderId);
                const pickedUp = this.pickedUpToDriver.has(orderId);
                if (pickedUp) {
                    return `<button class="btn btn-delivery-sent" disabled>
                        <i class="fa-solid fa-handshake"></i> Handed to Driver
                    </button>`;
                }
                if (sent) {
                    return `<button class="btn btn-handoff js-handoff-btn" data-id="${orderId}">
                        <i class="fa-solid fa-handshake"></i> Hand to Driver
                    </button>`;
                }
                return `<button class="btn btn-delivery js-send-delivery-btn" data-id="${orderId}">
                            <i class="fa-solid fa-truck-pickup"></i> Send to Delivery
                        </button>`;
            }
            return `<button class="btn btn-advance js-action-btn" data-id="${orderId}" data-next-status="served">
                        <i class="fa-solid fa-box-archive"></i> Mark Served
                    </button>`;
        } else if (status === 'picked_up') {
            if (isDelivery) {
                return `<button class="btn btn-delivery-sent" disabled>
                    <i class="fa-solid fa-handshake"></i> Handed to Driver
                </button>`;
            }
            return `<span style="color: var(--text-muted); font-size: 0.85rem;">Done</span>`;
        }
    },

    async sendToDelivery(orderId) {
        if (this._inflight.has(orderId)) return;
        this._inflight.add(orderId);
        this.setActionLoading(orderId, true);
        try {
            const response = await api.post(`/kitchen/orders/${orderId}/send-to-delivery`, {});
            if (response.success) {
                this.sentToDelivery.add(orderId);
                alert(response.message || `Delivery staff notified for order #${orderId}`);
                this.render();
            }
        } catch (error) {
            console.error('Failed to send order to delivery:', error);
            alert((error && error.message) || 'Failed to send order to delivery. Please try again.');
        } finally {
            this._inflight.delete(orderId);
            this.setActionLoading(orderId, false);
        }
    },

    async handoffToDriver(orderId) {
        if (this._inflight.has(orderId)) return;
        this._inflight.add(orderId);
        this.setActionLoading(orderId, true);
        try {
            const response = await api.patch(`/kitchen/orders/${orderId}/picked-up`);
            if (response.success) {
                this.pickedUpToDriver.add(orderId);
                alert(response.message || `Order #${orderId} handed to driver`);
                this.render();
            }
        } catch (error) {
            console.error('Failed to hand order to driver:', error);
            alert((error && error.message) || 'Failed to hand order to driver. Please try again.');
        } finally {
            this._inflight.delete(orderId);
            this.setActionLoading(orderId, false);
        }
    },

    getOrderTypeLabel(order) {
        const type = String(order.orderType || 'dine-in').toLowerCase();
        return type;
    },

    getOrderTypeIcon(order) {
        const type = String(order.orderType || 'dine-in').toLowerCase();
        if (type === 'delivery') return 'fa-truck-fast';
        if (type === 'takeaway') return 'fa-bag-shopping';
        return 'fa-utensils';
    },

    capitalize(str) {
        return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
    },

    getDeliveryAddress(order) {
        const info = order.deliveryInfo || {};
        return [info.subCity, info.location].filter(Boolean).join(', ');
    },

    formatItems(order) {
        return order.items?.map(item => 
            `${item.quantity}x ${item.name}${item.notes ? ` <small style="color:var(--text-muted)">(${item.notes})</small>` : ''}`
        ).join('<br>') || 'No items';
    },

    render() {
        const filtered = this.getFilteredOrders();

        // Grid view (dashboard.html)
        if (this.gridContainer) {
            if (filtered.length === 0) {
                this.gridContainer.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 32px;">
                        No <strong>${this.currentFilter}</strong> orders found in queue.
                    </div>`;
            } else {
                this.gridContainer.innerHTML = filtered.map(order => `
                    <div class="ticket-card ${order.status?.toLowerCase()} ${this.getOrderTypeLabel(order) === 'delivery' ? 'ticket-delivery' : ''}" data-order-id="${order.orderId}">
                        <div class="ticket-header">
                            <span class="ticket-id">#${order.orderId}</span>
                            <span class="badge ${this.getBadgeClass(order.status)}">${order.status}</span>
                        </div>
                        <div class="ticket-customer">
                            <i class="fa-solid fa-user"></i> ${order.customerName || 'Unknown'}
                        </div>
                        <div class="ticket-type">
                            <i class="fa-solid ${this.getOrderTypeIcon(order)}"></i> ${this.capitalize(this.getOrderTypeLabel(order))}
                            ${this.getOrderTypeLabel(order) === 'delivery' && this.getDeliveryAddress(order) ? `<span class="ticket-address"> · 📍 ${this.getDeliveryAddress(order)}</span>` : ''}
                        </div>
                        ${order.tableNumber && order.tableNumber !== 'N/A' ?
                            `<div class="ticket-table"><i class="fa-solid fa-table"></i> Table: ${order.tableNumber}</div>` : ''}
                        <div class="ticket-items">
                            ${this.formatItems(order)}
                        </div>
                        <div class="ticket-time">
                            <i class="fa-solid fa-clock"></i> ${this.getElapsedTime(order.createdAt || order.orderTime)} ago
                        </div>
                        <div class="ticket-actions-group">
                            ${this.getActionButtonHTML(order)}
                        </div>
                    </div>
                `).join('');

                this.gridContainer.querySelectorAll('.js-action-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const orderId = e.currentTarget.dataset.id;
                        const nextStatus = e.currentTarget.dataset.nextStatus;
                        this.updateOrderStatus(orderId, nextStatus);
                    });
                });

                this.gridContainer.querySelectorAll('.js-send-delivery-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const orderId = e.currentTarget.dataset.id;
                        this.sendToDelivery(orderId);
                    });
                });

                this.gridContainer.querySelectorAll('.js-handoff-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const orderId = e.currentTarget.dataset.id;
                        this.handoffToDriver(orderId);
                    });
                });
            }
        }

        // Table view (orders.html)
        if (this.tableBody) {
            if (filtered.length === 0) {
                this.tableBody.innerHTML = `
<tr>
                            <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 32px;">
                                No <strong>${this.currentFilter}</strong> orders found in queue.
                            </td>
                        </tr>`;
            } else {
                this.tableBody.innerHTML = filtered.map(order => {
                    const elapsed = this.getElapsedTime(order.createdAt || order.orderTime);
                    return `
                        <tr data-order-id="${order.orderId}">
                            <td><strong>#${order.orderId}</strong></td>
                            <td>${order.customerName || 'Unknown'}</td>
                            <td><span class="badge badge-type"><i class="fa-solid ${this.getOrderTypeIcon(order)}"></i> ${this.capitalize(this.getOrderTypeLabel(order))}</span></td>
                            <td>${this.formatItems(order)}</td>
                            <td><span class="badge ${this.getBadgeClass(order.status)}">${order.status}</span></td>
                            <td>${elapsed}</td>
                            <td>${this.getActionButtonHTML(order)}</td>
                        </tr>`;
                }).join('');

                this.tableBody.querySelectorAll('.js-action-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const orderId = e.currentTarget.dataset.id;
                        const nextStatus = e.currentTarget.dataset.nextStatus;
                        this.updateOrderStatus(orderId, nextStatus);
                    });
                });

                this.tableBody.querySelectorAll('.js-send-delivery-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const orderId = e.currentTarget.dataset.id;
                        this.sendToDelivery(orderId);
                    });
                });

                this.tableBody.querySelectorAll('.js-handoff-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const orderId = e.currentTarget.dataset.id;
                        this.handoffToDriver(orderId);
                    });
                });
            }
        }
    },

    playNotificationSound() {
        const audio = document.getElementById('orderNotificationSound');
        if (audio) {
            audio.play().catch(e => console.log('Audio play failed:', e));
        }
    },

    startTimer() {
        this.updateInterval = setInterval(() => {
            this.gridContainer?.querySelectorAll('.ticket-time').forEach(el => {
                const orderId = el.closest('.ticket-card')?.dataset.orderId;
                const order = orderId ? this.orders.get(orderId) : null;
                if (order) {
                    el.innerHTML = `<i class="fa-solid fa-clock"></i> ${this.getElapsedTime(order.createdAt || order.orderTime)} ago`;
                }
            });
        }, 30000); // Update every 30 seconds
    },

    startPolling() {
        // Fallback safety net: periodically re-fetch the kitchen dashboard so
        // new orders always appear even if a socket message was missed.
        this.pollInterval = setInterval(() => {
            this.refreshOrders();
        }, 30000); // Refresh every 30 seconds
    }
};

// Make KDS globally accessible for debugging
window.KDS = KDS;