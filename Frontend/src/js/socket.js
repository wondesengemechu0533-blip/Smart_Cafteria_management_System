/**
 * Smart Cafeteria Ordering System
 * Socket.io Client for Real-time Kitchen Dashboard
 */

const SOCKET_URL = window.SOCKET_URL || window.__API_BASE;

class SocketClient {
    constructor() {
        this.socket = null;
        this.listeners = new Map();
        this.pendingJoins = new Set();
        this.pendingDeliveryJoins = new Set();
    }

    // Fire a DOM notification-sound event (handled by notification-sound.js).
    // Consumers may pass { force } — by default callers that already de-dupe
    // (e.g. kitchen.js) set notifyKey so the same alert never replays.
    notifySound(type, options) {
        try {
            document.dispatchEvent(new CustomEvent('scos:notify:' + type, { detail: options || {} }));
        } catch (e) { /* ignore */ }
    }

    connect(token) {
        // Reuse a single Socket.IO connection — never open a second one.
        if (this.socket) {
            if (this.socket.connected) return;
            // Existing socket (e.g. mid-reconnect): just ensure it is running.
            try {
                this.socket.auth = { token };
                if (typeof this.socket.connect === 'function') this.socket.connect();
            } catch (e) { /* ignore */ }
            return;
        }

        this.socket = io(SOCKET_URL, {
            auth: { token },
            transports: ['websocket', 'polling']
        });

        this.socket.on('connect', () => {
            console.log('Socket connected:', this.socket.id);
            // Join kitchen room for kitchen staff
            if (this.isKitchenStaff()) {
                this.socket.emit('join:kitchen');
            }
            // Join delivery room for delivery staff
            if (this.isDeliveryStaff()) {
                this.socket.emit('join:delivery');
            }
            // Re-apply any order-room joins that were requested before connect.
            this.pendingJoins.forEach((roomId) => {
                this.socket.emit('order:join', roomId);
            });
            this.pendingJoins.clear();
            // Re-apply any delivery-GPS room joins that were requested before connect.
            this.pendingDeliveryJoins.forEach((roomId) => {
                this.socket.emit('delivery:join', roomId);
            });
            this.pendingDeliveryJoins.clear();
            // Let consumers' socketClient.on("connect", cb) listeners fire too.
            this.emit('connect', undefined);
            // Explicit "Connected" signal for pages that render a live-connection
            // badge (customer tracker, courier dashboard, manager monitor).
            this.emit('socket:connected', { id: this.socket.id });
            try {
                window.dispatchEvent(new CustomEvent('scos:socket:connected', { detail: { id: this.socket.id } }));
            } catch (e) { /* non-browser context */ }
        });

        this.socket.on('disconnect', (reason) => {
            console.log('Socket disconnected:', reason);
            // Local-only lifecycle events so any page can render an explicit
            // connection state ("Reconnecting…" / "Connected") instead of
            // silently showing stale GPS. Never sent to the server.
            this.emit('socket:disconnected', { reason });
            this.emit('disconnect', { reason });
            try {
                window.dispatchEvent(new CustomEvent('scos:socket:disconnected', { detail: { reason } }));
            } catch (e) { /* non-browser context */ }
        });

        // Socket.IO's own reconnect lifecycle. Bridged to the same local pub/sub
        // so the customer tracker and the courier dashboard can say
        // "Reconnecting…" and then "Connected" without each one re-implementing
        // reconnection. `connect` (above) already re-joins every queued
        // `order:join` / `delivery:join`, so a reconnect resumes GPS updates
        // without the page having to reload.
        this.socket.io.on('reconnect_attempt', (attempt) => {
            this.emit('socket:reconnecting', { attempt });
            try {
                window.dispatchEvent(new CustomEvent('scos:socket:reconnecting', { detail: { attempt } }));
            } catch (e) { /* non-browser context */ }
        });
        this.socket.on('connect_error', (err) => {
            this.emit('socket:error', { message: err && err.message });
        });
        this.socket.io.on('reconnect_failed', () => {
            this.emit('socket:unavailable', { reason: 'reconnect_failed' });
            try {
                window.dispatchEvent(new CustomEvent('scos:socket:unavailable', { detail: { reason: 'reconnect_failed' } }));
            } catch (e) { /* non-browser context */ }
        });

        this.socket.on('order:new', (order) => {
            // Sound is owned by kitchen.js (isNew + notifiedKeys de-dupe) for
            // the kitchen board. Other roles still get a one-shot chime here
            // using the same notifyKey so notification-sound.js never double-plays.
            const key = order && (order.orderId || order._id) ? String(order.orderId || order._id) : '';
            if (!this.isKitchenStaff()) {
                this.notifySound('order', { notifyKey: key ? 'order:new:' + key : '' });
            }
            this.emit('order:new', order);
        });

        this.socket.on('order:status', (order) => {
            const status = String((order && (order.status || order.orderStatus)) || '').toLowerCase();
            if (!this.isKitchenDashboard()) {
                const key = order && (order.orderId || order._id) ? String(order.orderId || order._id) : '';
                if (status === 'cancelled' || status === 'ready' || status === 'served' || status === 'completed') {
                    const soundType = status === 'cancelled' ? 'cancellation' : 'info';
                    this.notifySound(soundType, { notifyKey: key ? 'order:status:' + status + ':' + key : '' });
                }
            }
            this.emit('order:status', order);
        });

        this.socket.on('order:payment', (order) => {
            this.emit('order:payment', order);
        });

        this.socket.on('order:created', (order) => {
            this.emit('order:created', order);
        });

        this.socket.on('delivery:new', (order) => {
            const key = order && (order.orderId || order._id) ? String(order.orderId || order._id) : '';
            // Kitchen staff are in the `delivery` room, so they receive this
            // frame too - but a delivery dispatch is not a kitchen event and
            // must stay silent on the Kitchen Dashboard.
            if (!this.isKitchenDashboard()) {
                this.notifySound('delivery', { notifyKey: key ? 'delivery:new:' + key : '' });
            }
            this.emit('delivery:new', order);
        });

        this.socket.on('delivery:assigned', (order) => {
            const key = order && (order.orderId || order._id) ? String(order.orderId || order._id) : '';
            // The server also broadcasts this to the shared 'delivery' room so
            // the whole queue refreshes, which means every courier receives it -
            // not just the one it was assigned to. Only the assigned rider may
            // get the alert sound; otherwise a busy cafeteria beeps at every
            // courier for someone else's delivery.
            if (!this.isKitchenDashboard() && this.isAssignedToCurrentUser(order)) {
                const assignedId = order && (order.orderId || order._id) ? String(order.orderId || order._id) : '';
                // A delivery the current rider just claimed themselves still
                // arrives here as delivery:assigned - possibly twice (delivery
                // room + user room). It is their own deliberate action, not a
                // new dispatch, so it must not chime. The claim page sets this
                // flag with a short self-expiring window.
                const muted =
                    typeof window !== 'undefined' &&
                    window.__scosMuteClaimSound === assignedId &&
                    Date.now() - (window.__scosMuteClaimSoundAt || 0) < 10000;
                if (!muted) {
                    this.notifySound('delivery', { notifyKey: key ? 'delivery:assigned:' + key : '' });
                }
            }
            this.emit('delivery:assigned', order);
        });

        // Delivery lifecycle events emitted by delivery.controller.js.
        // These MUST be bridged or socketClient.on(...) listeners on the
        // delivery pages never fire (the bridge is the only path to consumers).
        this.socket.on('delivery:assignment', (order) => {
            this.emit('delivery:assignment', order);
        });
        this.socket.on('delivery:accepted', (order) => {
            this.emit('delivery:accepted', order);
        });
        this.socket.on('delivery:declined', (order) => {
            this.emit('delivery:declined', order);
        });
        this.socket.on('delivery:arrived', (order) => {
            this.emit('delivery:arrived', order);
        });

        // Per-stage delivery lifecycle frames. moveDelivery() in
        // delivery.controller.js emits `delivery:<stage>` to the delivery + admin
        // rooms, and markDelivered re-emits `delivery:delivered` itself because
        // it bypasses moveDelivery for the proof-of-delivery step.
        //
        // These MUST be bridged: deliveries.js and history.js already register
        // socketClient.on(...) listeners for them, and the bridge is the only
        // path from the raw socket to a consumer. Without a bridge those
        // listeners never fire, so a courier who completes a run in another tab
        // leaves this page showing a stale list until a manual refresh.
        const DELIVERY_STAGE_EVENTS = [
            'delivery:picked_up',
            'delivery:out_for_delivery',
            'delivery:delivered',
            'delivery:completed',
            'delivery:failed',
            'delivery:cancelled',
            'delivery:ready-for-pickup',
            // Dispatch-time frames emitted by kitchen.controller.js
            // (sendOrderToDelivery) and order.controller.js (checkout).
            //
            // These were MISSING from this bridge, which is the whole reason
            // "kitchen sent it to delivery but nothing appeared on the courier's
            // Active Deliveries" happened with the socket connected the entire
            // time: the server emitted to the `delivery` room, socket.js received
            // the frame, and then threw it away because no `this.socket.on(...)`
            // handler existed to re-emit it - so every `socketClient.on(...)`
            // listener on the delivery pages (which are the ONLY path consumers
            // have) was silently dead. Adding the name here is all it takes to
            // make the pages refetch the board and show the order live.
            'delivery:dispatch',
            'order:ready-for-delivery',
        ];
        DELIVERY_STAGE_EVENTS.forEach((eventName) => {
            this.socket.on(eventName, (order) => {
                this.emit(eventName, order);
            });
        });

        // Per-order room frame emitted alongside `order:status`. This is the
        // one the Order Tracking page is meant to follow: it goes to
        // `order:<orderId>` / `delivery:<orderId>` and carries the same
        // customer-safe summary, so the tracker can advance from it directly
        // instead of inferring the stage from the broadcast payload.
        this.socket.on('delivery:status', (order) => {
            this.emit('delivery:status', order);
        });

        // Delivery issue reports (delay / wrong address / breakdown ...). The
        // tracking page listens for this to show its delay banner; it was a
        // dead listener for the same reason.
        this.socket.on('delivery:issue', (payload) => {
            this.emit('delivery:issue', payload);
        });

        // Roster / availability changes drive the assignment picker and the
        // "assigned to me" tile.
        this.socket.on('delivery:staff', (payload) => {
            this.emit('delivery:staff', payload);
        });
        this.socket.on('delivery:availability', (payload) => {
            this.emit('delivery:availability', payload);
        });

        // SOS emergency lifecycle.
        ['delivery:emergency', 'delivery:emergency:ack', 'delivery:emergency:resolved']
            .forEach((eventName) => {
                this.socket.on(eventName, (payload) => {
                    this.emit(eventName, payload);
                });
            });

        // Real GPS point broadcast for a delivery (server endorses coordinates).
        this.socket.on('delivery:location', (point) => {
            this.emit('delivery:location', point);
        });

        this.socket.on('notification:new', (notification) => {
            const key = notification && (notification._id || notification.id)
                ? String(notification._id || notification.id)
                : '';
            const notifType = String((notification && notification.type) || '').toLowerCase();

            if (this.isKitchenDashboard()) {
                // On the Kitchen Dashboard, sound is owned ENTIRELY by kitchen.js,
                // and only for two events: a new customer order and a customer
                // cancellation (it raises a repeating, acknowledge-driven loop
                // keyed on `order:new:<id>` / `order:status:cancelled:<id>`).
                //
                // Every other notification type a kitchen account can receive -
                // general, system, promo, ready, stock alerts, issue reports,
                // delivery, payment - must be SILENT here, and must not ring a
                // second time from this shared bridge. The dashboard still shows
                // them in the notification list and badge; only the audio is
                // reserved for the two order-lifecycle events.
            } else {
                const soundType = notifType === 'cancellation' ? 'cancellation' : 'info';
                this.notifySound(soundType, {
                    notifyKey: key ? 'notification:' + soundType + ':' + key : '',
                });
            }
            this.emit('notification:new', notification);
            // Let any open page (delivery sidebar badge, notifications list,
            // customer tracker, kitchen notification store) react without
            // page-specific wiring.
            try {
                window.dispatchEvent(new CustomEvent('notification:refresh', { detail: notification }));
            } catch (e) { /* non-browser context */ }
        });

        // Kitchen stock issue alerts — bridged so any page listening for
        // `stock:alert` / `stock:alert:updated` (manager + kitchen dashboards)
        // refreshes its list in real time without an extra reload.
        this.socket.on('stock:alert', (payload) => {
            this.emit('stock:alert', payload);
        });
        this.socket.on('stock:alert:updated', (payload) => {
            this.emit('stock:alert:updated', payload);
        });
    }

    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    }

    joinOrderRoom(orderId) {
        if (!orderId) return;
        if (this.socket?.connected) {
            this.socket.emit('order:join', orderId);
        } else {
            // Connection is still in progress; remember to join once connected.
            this.pendingJoins.add(orderId);
        }
    }

    leaveOrderRoom(orderId) {
        this.pendingJoins.delete(orderId);
        if (this.socket?.connected) {
            this.socket.emit('order:leave', orderId);
        }
    }

    // Join the room that receives real GPS points for a delivery. The server
    // authorizes the join (owner / assigned delivery person / management).
    joinDeliveryRoom(orderId) {
        if (!orderId) return;
        if (this.socket?.connected) {
            this.socket.emit('delivery:join', orderId);
        } else {
            // Connection is still in progress; remember to join once connected.
            this.pendingDeliveryJoins.add(orderId);
        }
    }

    leaveDeliveryRoom(orderId) {
        this.pendingDeliveryJoins.delete(orderId);
        if (this.socket?.connected) {
            this.socket.emit('delivery:leave', orderId);
        }
    }

    isKitchenStaff() {
        // Check top-level role keys first, then fall back to the stored user.
        let role = localStorage.getItem('role') || localStorage.getItem('userRole') || '';
        if (!role) {
            try {
                role = JSON.parse(localStorage.getItem('current_user'))?.role || '';
            } catch (e) {
                /* ignore */
            }
        }
        const normalized = String(role).toLowerCase();
        return ['kitchen', 'kitchen_staff', 'kitchen staff', 'staff', 'foodmaker', 'admin'].includes(normalized);
    }

    /**
     * Is THIS page the Kitchen Dashboard, which owns its own alert sound?
     *
     * Deliberately page-scoped rather than role-scoped. `isKitchenStaff()`
     * also matches admins (the server puts them in the `kitchen` room), and the
     * admin dashboard shares this very socket client - so keying the "stay
     * silent" policy off the role would mute the admin dashboard's
     * notification sounds too.
     *
     * kitchen.js sets the flag before it connects, so every frame that arrives
     * on the Kitchen Dashboard is judged by the Kitchen policy and every other
     * page keeps its existing per-type chimes.
     */
    isKitchenDashboard() {
        if (this._kdsPage === undefined) {
            this._kdsPage = Boolean(
                typeof window !== 'undefined' && window.SCOS_KDS_OWNS_ALERT_SOUND === true
            );
        }
        return this._kdsPage && this.isKitchenStaff();
    }

    isDeliveryStaff() {
        let role = localStorage.getItem('role') || localStorage.getItem('userRole') || '';
        if (!role) {
            try {
                role = JSON.parse(localStorage.getItem('current_user'))?.role || '';
            } catch (e) {
                /* ignore */
            }
        }
        const normalized = String(role).toLowerCase();
        return ['delivery', 'delivery_staff', 'delivery staff', 'delivery_person', 'delivery person', 'driver', 'rider'].includes(normalized);
    }

    // The authenticated user's id, read the same way delivery/shared.js does.
    currentUserId() {
        try {
            const cu = JSON.parse(localStorage.getItem('current_user'));
            if (cu && cu.id) return String(cu.id);
        } catch (e) { /* ignore */ }
        try {
            const p = JSON.parse(localStorage.getItem('userProfile'));
            if (p && p.id) return String(p.id);
        } catch (e) { /* ignore */ }
        return null;
    }

    /**
     * True when this delivery belongs to the signed-in courier.
     *
     * Used to decide who gets the "new delivery assigned" alert. The server
     * sends the event to the courier's own room AND to the shared delivery
     * room, so the event itself does not imply ownership. When the payload has
     * no owner info at all we stay quiet rather than beep at everyone.
     */
    isAssignedToCurrentUser(order) {
        const me = this.currentUserId();
        if (!me || !order) return false;
        const staff = order.deliveryStaffAssigned;
        const staffId = staff && typeof staff === 'object' ? (staff.id || staff._id) : staff;
        const candidate = staffId || order.deliveryPersonId;
        if (!candidate) return false;
        return String(candidate) === me;
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
    }

    off(event, callback) {
        if (this.listeners.has(event)) {
            const callbacks = this.listeners.get(event);
            const index = callbacks.indexOf(callback);
            if (index > -1) callbacks.splice(index, 1);
        }
    }

    emit(event, data) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).forEach(cb => cb(data));
        }
    }

    get connected() {
        return this.socket?.connected || false;
    }
}

export const socketClient = new SocketClient();
export default socketClient;

// Bridge for classic (non-module) scripts that need the shared connection —
// notification-center.js reuses this socket instead of opening a second one.
if (typeof window !== 'undefined') {
    window.ScosSocketBridge = socketClient;
    // This module is an ES module, so it can finish evaluating AFTER a classic
    // script (e.g. notification-center.js) has already looked for the bridge
    // and found nothing. Announce ourselves so late consumers can bind to the
    // existing connection instead of opening their own.
    try {
        window.dispatchEvent(new CustomEvent('scos:socket-bridge-ready', {
            detail: { socketClient },
        }));
    } catch (e) { /* non-browser context */ }
}