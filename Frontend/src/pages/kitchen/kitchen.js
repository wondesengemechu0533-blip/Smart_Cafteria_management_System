function tr(key, fallback, vars) {
  if (typeof window.tr === "function") return window.tr(key, fallback, vars);
  return fallback;
}
/**
 * Kitchen Display System (KDS) Module
 * Features: Real-time Socket.io updates, Status Filters, State Progression, Dynamic Elapsed Time
 */

import { socketClient } from "../../js/socket.js";
import api from "../../js/api.js";

// Alert tuning.
const ALERT_LOOP_INTERVAL_MS = 6000;
// Both new-order AND cancellation alerts repeat until a person acknowledges
// them, with no time-based cutoff. A 30-minute cap on cancellations meant an
// unattended kitchen silently stopped being told an order was cancelled.
const ORDER_ALERT_NO_MAX_DURATION = Infinity;
// Statuses that mean "nobody in the kitchen has picked this up yet".
const AWAITING_KITCHEN_STATUSES = ['pending', 'received', ''];
// On the very first snapshot of a session, anything older than this is treated
// as pre-existing board content rather than a fresh order.
const BASELINE_GRACE_MS = 60 * 1000;
const ACK_STORE_KEY = 'scos_kitchen_ack_events';
// Backend notification types that represent a customer order lifecycle event.
const KITCHEN_EVENT_TYPES = ['order', 'cancellation'];

document.addEventListener('DOMContentLoaded', () => {
    KDS.init();
});

const KDS = {
    orders: new Map(), // orderId -> order object
    sentToDelivery: new Set(), // orderIds already sent to delivery
    pickedUpToDriver: new Set(), // orderIds handed to driver
    notifiedKeys: new Set(),
    soundKeys: new Set(),
    pendingAlerts: new Set(),
    // orderId -> { order, eventType } : the banner shows the newest unhandled
    // event per order. The per-notification record (notifByEvent) is what the
    // persistent panel renders, so nothing is ever lost.
    newOrderAlerts: new Map(),
    alerted: new Set(), // "<orderId>|<eventType>" already alerted in this session
    // "<orderId>|<eventType>" -> { id, orderId, eventType, title, message, ... }
    // The BACKEND is the source of truth for "has the kitchen seen this?":
    // an entry exists only while the matching notification is still unread
    // server-side, so a refresh can never make an unseen alert disappear.
    notifByEvent: new Map(),
    acknowledged: null, // event keys acknowledged (sound de-dupe cache only)
    mutedAlerts: new Set(),
    initialLoadComplete: false,
    currentFilter: 'all',
    // WHY is the board empty? `unpaidInWindow` > 0 with an empty queue means the
    // orders exist but are waiting on payment confirmation - a different problem
    // from "no work", and one the kitchen cannot act on. Both are 0 until the
    // first dashboard response fills them in.
    ordersInWindow: 0,
    unpaidInWindow: 0,
    // Opt-in triage view. OFF by default: an unconfirmed payment must never be
    // worked, so it is only ever requested when someone explicitly asks for it.
    includeUnpaid: false,
    loadError: null,
    // The board is polled every 15s, but on a slow database link a single
    // response can take longer than that. Without this handle the next tick
    // starts a SECOND request while the first is still running, and the two (then
    // four, then eight) pile up until the connection is saturated and every
    // request hits the client timeout - which is exactly what "Could not load
    // the kitchen queue / Request timed out" looked like.
    _boardRequest: null,
    // The 15s default is right for a normal API call but not for this one: the
    // dashboard ships the whole board, so it is given room to finish rather than
    // being aborted part-way through a slow transfer.
    DASHBOARD_TIMEOUT_MS: 60000,
    gridContainer: null,
    tableBody: null,
    pendingCountEl: null,
    preparingCountEl: null,
    readyCountEl: null,
    soundToggleBtn: null,
    soundToggleIcon: null,
    soundToggleLabel: null,
    toastStack: null,
    newOrderBanner: null,
    notifPanel: null,
    notifList: null,
    notifCountEl: null,
    unlockBanner: null,
    enableSoundBtn: null,
    updateInterval: null,
    pollInterval: null,
    notifPollInterval: null,
    _inflight: new Set(),
    _bannerSignature: null,
    // Monotonic arrival counter. Gives every notification a stable tie-breaker
    // for the newest-first sort when two share the same createdAt millisecond.
    _notifSeq: 0,
    // Event keys acknowledged in THIS session. A poll snapshot taken before the
    // PATCH landed still lists them, so without this an acknowledged row would
    // reappear in the list - and re-ring - on the next refresh.
    locallyAcknowledged: new Set(),

    STATUS_LABELS: {
        pending: 'Pending',
        preparing: 'In Preparation',
        ready: 'Ready',
        served: 'Completed',
        completed: 'Completed',
        cancelled: 'Cancelled',
        received: 'Pending'
    },

    statusLabel(status) {
        const key = String(status || '').toLowerCase();
        if (window.translateStatus) { const loc = window.translateStatus(status); if (loc && loc !== status) return loc; }
        return this.STATUS_LABELS[key] || status || '—';
    },

    setActionLoading(orderId, loading) {
        const containers = [this.gridContainer, this.tableBody];
        containers.forEach(container => {
            if (!container) return;
            const buttons = container.querySelectorAll(
                `.js-action-btn[data-id="${orderId}"], .js-send-delivery-btn[data-id="${orderId}"], .js-handoff-btn[data-id="${orderId}"], .js-cancel-btn[data-id="${orderId}"]`
            );
            buttons.forEach(btn => {
                btn.disabled = loading;
                btn.classList.toggle('btn-loading', loading);
            });
        });
    },

    async init() {
        // Declare, BEFORE the socket connects, that this page owns the kitchen
        // alert-sound policy. socket.js reads this to stay silent for every
        // notification type except a new order and a cancellation, so the two
        // loops started here are the only sounds the Kitchen Dashboard makes.
        window.SCOS_KDS_OWNS_ALERT_SOUND = true;
        if (window.ScosSocketBridge && '_kdsPage' in window.ScosSocketBridge) {
            window.ScosSocketBridge._kdsPage = true;
        }

        this.cacheDOM();
        this.bindEvents();
        this.bindSoundToggle();
        this.bindAutoplayUnlock();
        this.bindNotificationPanel();
        this.acknowledged = this.loadAcknowledged();
        this.initialLoadComplete = false;
        this.setupSocketListeners();
        // Order matters: the board's "baseline" logic must see which orders are
        // genuinely still unacknowledged, and never mistake an unseen order for
        // pre-existing board content. That is a requirement on WHEN the snapshot
        // is read, not on when the request is sent - and on this link (measured
        // ~8 KB/s) serialising the two cost a whole extra round trip before the
        // board even started loading. Start both now; loadInitialOrders awaits
        // this promise immediately before it takes the baseline.
        const notificationsReady = this.loadKitchenNotifications();
        await this.loadInitialOrders({ notificationsReady });
        this.hydrateAlertsFromNotifications();
        this.initialLoadComplete = true;
        this.startTimer();
        this.startPolling();
        this.startNotificationPolling();
        this.render();
        this.maybeShowUnlockBanner();
    },

    cacheDOM() {
        this.gridContainer = document.getElementById('kitchenTicketsGrid');
        this.tableBody = document.getElementById('kitchenOrdersBody');
        this.pendingCountEl = document.getElementById('pendingCount');
        this.preparingCountEl = document.getElementById('preparingCount');
        this.readyCountEl = document.getElementById('readyCount');
        this.cancelledCountEl = document.getElementById('cancelledCount');
        this.soundToggleBtn = document.getElementById('soundToggleBtn');
        this.soundToggleIcon = document.getElementById('soundToggleIcon');
        this.soundToggleLabel = document.getElementById('soundToggleLabel');
        this.toastStack = document.getElementById('kdsToastStack');
        this.newOrderBanner = document.getElementById('kdsNewOrderBanner');
        this.notifPanel = document.getElementById('kdsNotifPanel');
        this.notifList = document.getElementById('kdsNotifList');
        this.notifCountEl = document.getElementById('kdsNotifUnreadCount');
        this.unlockBanner = document.getElementById('soundUnlockBanner');
        this.enableSoundBtn = document.getElementById('enableSoundBtn');
    },

    bindEvents() {
        const filterButtons = document.querySelectorAll('.filter-group .btn, .filter-trigger');
        filterButtons.forEach(button => {
            button.addEventListener('click', () => {
                // "Not paid yet" is a two-step action (re-fetch, then switch),
                // owned by setIncludeUnpaid(). Handling it here as well would
                // switch the tab before the rows exist and flash an empty table.
                if (button.hasAttribute('aria-pressed')) return;
                filterButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                this.currentFilter = button.dataset.status || 'all';
                this.render();
            });
        });

        // "Retry" in the empty state: re-fetch, and clear the error only if the
        // request actually succeeds (loadInitialOrders/refreshOrders own that).
        document.addEventListener('click', (e) => {
            const retry = e.target.closest && e.target.closest('[data-reload-orders]');
            if (retry) { this.loadInitialOrders(); return; }
            // The "Not paid yet" triage toggle. The filter-bar button flips it
            // on/off; the identical button inside the empty state only turns it
            // ON (it exists precisely because the board is empty).
            const unpaidBtn = e.target.closest && e.target.closest('[data-toggle-unpaid]');
            if (!unpaidBtn) return;
            e.preventDefault();
            this.setIncludeUnpaid(
                unpaidBtn.hasAttribute('aria-pressed') ? !this.includeUnpaid : true
            );
        });

        // NOTE: an alert is deliberately NOT dismissed by generic page
        // interaction. Only an explicit acknowledgement (viewing the ticket or
        // acting on it) stops the repeating sound, so clicking a filter or
        // scrolling can never silence an order the kitchen has not seen yet.
    },

    // --- Notification sound control (enable / disable) ---
    isSoundEnabled() {
        if (window.ScosNotify && typeof window.ScosNotify.enabled === 'function') {
            return window.ScosNotify.enabled();
        }
        try {
            return localStorage.getItem('scos_notify_sound') !== '0';
        } catch (e) {
            return true;
        }
    },

    updateSoundToggleUI() {
        const on = this.isSoundEnabled();
        if (this.soundToggleIcon) {
            this.soundToggleIcon.className = on ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
        }
        if (this.soundToggleLabel) {
            this.soundToggleLabel.textContent = on ? '🔊 Sound ON' : '🔇 Sound OFF';
        }
        if (this.soundToggleBtn) {
            this.soundToggleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
            this.soundToggleBtn.title = on ? 'Mute notification sound (🔊 ON)' : 'Enable notification sound (🔇 OFF)';
        }
    },

    bindSoundToggle() {
        this.updateSoundToggleUI();
        if (!this.soundToggleBtn) return;
        this.soundToggleBtn.addEventListener('click', () => {
            const next = !this.isSoundEnabled();
            if (window.ScosNotify && typeof window.ScosNotify.toggle === 'function') {
                window.ScosNotify.toggle(next);
            } else {
                try {
                    localStorage.setItem('scos_notify_sound', next ? '1' : '0');
                } catch (e) { /* ignore */ }
            }
            if (next) {
                this.unlockSound('toggle-on');
                this.hideUnlockBanner();
            }
            this.updateSoundToggleUI();
        });
    },

    // --- Browser autoplay unlock CTA ---
    bindAutoplayUnlock() {
        if (this.enableSoundBtn && !this.enableSoundBtn.dataset.bound) {
            this.enableSoundBtn.dataset.bound = '1';
            this.enableSoundBtn.addEventListener('click', () => {
                this.unlockSound('cta');
                this.hideUnlockBanner();
            });
        }
        if (window.ScosNotify) {
            document.addEventListener('scos:sound:blocked', () => {
                if (this.isSoundEnabled()) this.maybeShowUnlockBanner();
            });
            document.addEventListener('scos:sound:unlocked', () => {
                this.hideUnlockBanner();
                this.updateSoundToggleUI();
            });
        }
    },

    unlockSound(source) {
        if (window.ScosNotify && typeof window.ScosNotify.unlock === 'function') {
            window.ScosNotify.unlock(source);
        }
        // Also resume the page <audio> element under the same gesture.
        const audio = document.getElementById('orderNotificationSound');
        if (audio) {
            try {
                audio.muted = true;
                const p = audio.play();
                if (p && typeof p.then === 'function') {
                    p.then(() => {
                        audio.pause();
                        audio.currentTime = 0;
                        audio.muted = false;
                    }).catch(() => {
                        audio.muted = false;
                    });
                }
            } catch (e) { /* ignore */ }
        }
    },

    maybeShowUnlockBanner() {
        if (!this.unlockBanner || !this.isSoundEnabled()) return;
        const blocked = window.ScosNotify && typeof window.ScosNotify.isBlocked === 'function'
            ? window.ScosNotify.isBlocked()
            : false;
        if (blocked) this.unlockBanner.hidden = false;
    },

    hideUnlockBanner() {
        if (this.unlockBanner) this.unlockBanner.hidden = true;
    },

    claimNotification(key) {
        if (!key || this.notifiedKeys.has(key)) return false;
        this.notifiedKeys.add(key);
        return true;
    },

    // --- Acknowledgement persistence -------------------------------------
    // These local records are only a *sound de-dupe cache* for this browser.
    // The authoritative "has kitchen staff seen this?" state lives in the
    // backend (`Notification.isRead`), which is what makes an alert survive a
    // reload on a different machine and what the staff actually acknowledge.
    // Keys are "<orderId>|<eventType>" so acknowledging a new order can never
    // silence a later cancellation of that same order.
    ackStoreKey() {
        let userId = '';
        try {
            const stored = JSON.parse(localStorage.getItem('current_user') || 'null');
            userId = (stored && (stored._id || stored.id)) || '';
        } catch (e) {
            userId = '';
        }
        if (!userId) {
            try {
                userId = localStorage.getItem('userId') || localStorage.getItem('user_id') || '';
            } catch (e) {
                userId = '';
            }
        }
        return ACK_STORE_KEY + ':' + (userId || 'default');
    },

    loadAcknowledged() {
        try {
            const raw = localStorage.getItem(this.ackStoreKey());
            const parsed = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return new Set();
            // Older builds stored bare orderIds meaning "new order seen". Map
            // them onto the new key shape so an already-handled order does not
            // re-alarm, while cancellations stay unacknowledged (they were never
            // tracked before) and therefore still ring - the safe direction.
            return new Set(parsed.map((v) => (String(v).includes('|') ? String(v) : `${v}|new`)));
        } catch (e) {
            return new Set();
        }
    },

    saveAcknowledged() {
        if (!this.acknowledged) return;
        try {
            const trimmed = Array.from(this.acknowledged).slice(-500);
            localStorage.setItem(this.ackStoreKey(), JSON.stringify(trimmed));
        } catch (e) { /* storage unavailable - alerts still work this session */ }
    },

    isAcknowledged(key) {
        if (!key) return true;
        if (!this.acknowledged) this.acknowledged = this.loadAcknowledged();
        return this.acknowledged.has(String(key));
    },

    markAcknowledged(key) {
        if (!key) return;
        if (!this.acknowledged) this.acknowledged = this.loadAcknowledged();
        this.acknowledged.add(String(key));
        this.saveAcknowledged();
    },

    // --- Event key helpers ------------------------------------------------
    // One identity per (order, event) pair. Mirrors the backend's
    // `eventKey` = kitchen:<event>:<orderId> so a single order event can never
    // produce two notifications, two toasts, or two alarm sounds.
    eventKey(orderId, eventType) {
        const event = eventType === 'cancelled' ? 'cancelled' : 'new';
        return `${String(orderId)}|${event}`;
    },

    soundKeyFor(orderId, eventType) {
        // The notification-sound.js de-dupe key for this event. One key per
        // (order, event) pair so every entry point - socket frame, notification
        // frame, poll reconcile - resolves to the same loop, and acknowledging
        // one event never touches the other's.
        return eventType === 'cancelled'
            ? 'order:status:cancelled:' + orderId
            : 'order:new:' + orderId;
    },

    normalizeEventType(notification) {
        const meta = (notification && notification.meta) || {};
        const raw = String(
            (notification && notification.eventType) || meta.eventType || ''
        ).toLowerCase();
        if (raw === 'cancelled' || raw === 'cancellation') return 'cancelled';
        if (String((notification && notification.type) || '').toLowerCase() === 'cancellation') {
            return 'cancelled';
        }
        return 'new';
    },

    /**
     * Is this a kitchen-facing order-lifecycle notification?
     *
     * The audience check is essential: the customer ALSO gets notifications with
     * `type: 'order'` ("Order Ready!"), and treating one of those as a kitchen
     * new order would alert the kitchen about its own status messages. The
     * backend tags kitchen events with `eventKey`/`meta.audience`.
     */
    isKitchenOrderEvent(notification) {
        if (!notification) return false;
        if (notification.isRead === true || notification.read === true) return false;
        const meta = notification.meta && typeof notification.meta === 'object' ? notification.meta : {};
        const eventKey = String(notification.eventKey || meta.eventKey || '');
        const audience = String(meta.audience || '');
        const isKitchen = eventKey.startsWith('kitchen:') || audience === 'kitchen';
        if (!isKitchen) return false;
        if (!KITCHEN_EVENT_TYPES.includes(String(notification.type || '').toLowerCase())) return false;
        if (!notification.orderId) return false;
        return true;
    },

    toNotifRecord(notification) {
        if (!this.isKitchenOrderEvent(notification)) return null;
        const meta = notification.meta && typeof notification.meta === 'object' ? notification.meta : {};
        const eventType = this.normalizeEventType(notification);
        return {
            id: String(notification.id || notification._id),
            orderId: String(notification.orderId),
            eventType,
            eventKey: notification.eventKey || meta.eventKey || null,
            type: String(notification.type || '').toLowerCase(),
            title: notification.title || (eventType === 'cancelled' ? 'Order Cancelled' : 'New Customer Order'),
            message: notification.message || '',
            customerName: meta.customerName || null,
            orderType: meta.orderType || null,
            totalAmount: meta.totalAmount ?? null,
            cancellationReason: meta.cancellationReason || null,
            // The server's real creation time is the only ordering input. An
            // already-seen record keeps its original arrival sequence so a
            // reconnect re-sort cannot reshuffle the list.
            createdAt: notification.createdAt || new Date().toISOString(),
            _seq: this._notifSeq++,
        };
    },

    /**
     * Minimal order-shaped object built purely from a notification's metadata.
     * Used when the alert refers to an order that is no longer on the board (a
     * cancellation the kitchen never saw). It is NEVER written into `orders`,
     * so it can never overwrite real order data.
     */
    orderStubFromNotification(record) {
        return {
            orderId: record.orderId,
            customerName: record.customerName,
            orderType: record.orderType || 'dine-in',
            totalAmount: record.totalAmount,
            itemCount: null,
            items: [],
            status: record.eventType === 'cancelled' ? 'cancelled' : 'pending',
            cancellationReason: record.cancellationReason,
            eventAt: record.createdAt,
        };
    },

    // --- Backend notification store ---------------------------------------
    /**
     * Re-read every notification this kitchen account still has UNREAD and
     * rebuild the alert set from it. This is the path that makes requirement
     * "the notification must not disappear before staff see it" true across
     * refreshes: read state lives in MongoDB, not in a JS array.
     */
    async loadKitchenNotifications(options) {
        const opts = options || {};
        try {
            // `types` is the server-side half of the filter below. toNotifRecord
            // already throws away every notification that is not an order or
            // cancellation event - so without this the API shipped them, this
            // page paid to transfer them over a link measured at ~8 KB/s, and they
            // were then discarded one line later.
            const response = await api.get(
                '/notifications?unread=true&limit=200&types=' + KITCHEN_EVENT_TYPES.join(',')
            );
            if (!response || !response.success) return 0;

            const incoming = new Map();
            (response.notifications || []).forEach((raw) => {
                const record = this.toNotifRecord(raw);
                if (!record) return;
                const key = this.eventKey(record.orderId, record.eventType);
                // Skip anything already acknowledged here; the server snapshot
                // may predate our PATCH.
                if (this.locallyAcknowledged.has(key)) return;
                incoming.set(key, record);
            });

            // MERGE, never blind-replace. A poll snapshot is taken at request
            // time, so a notification that arrived over the socket while the
            // request was in flight is not in it - replacing the store outright
            // made the brand-new order vanish from the list until the next poll.
            // Anything still held locally that the server has not yet caught up
            // with is kept; anything the server has caught up with wins.
            const merged = new Map(incoming);
            this.notifByEvent.forEach((record, key) => {
                if (this.locallyAcknowledged.has(key)) return;
                if (!merged.has(key)) merged.set(key, record);
            });
            this.notifByEvent = merged;

            this.renderNotificationPanel();
            if (opts.hydrate) this.hydrateAlertsFromNotifications();
            return merged.size;
        } catch (error) {
            console.warn('Failed to load kitchen notifications:', error && error.message);
            return 0;
        }
    },

    /**
     * Raise the alert for every order event the backend still reports unread.
     *
     * The store is authoritative: if the server says a notification is unread
     * we must alert, even if this browser previously considered the order
     * handled - the local cache may have been written by a session that crashed
     * before the PATCH landed. This is also what restores the sound after a
     * page refresh or a Socket.IO reconnect: unread means "nobody has
     * acknowledged this yet", so the alarm has to be sounding again.
     */
    hydrateAlertsFromNotifications() {
        let raised = 0;
        this.notifByEvent.forEach((record) => {
            const live = this.orders.get(record.orderId);
            if (this.raiseOrderEventAlert(live || this.orderStubFromNotification(record), record.eventType, {
                fromNotification: record,
                stub: !live,
            })) {
                raised++;
            }
        });
        if (raised) this.renderAlertBanner();
        return raised;
    },

    /**
     * Handle a `notification:new` frame for this kitchen account.
     *
     * De-duplicated on (orderId, eventType), so a re-broadcast of the same
     * order event adds nothing and rings nothing further.
     */
    handleIncomingNotification(raw) {
        const record = this.toNotifRecord(raw);
        if (!record) return false;
        const key = this.eventKey(record.orderId, record.eventType);
        // Already acknowledged in this session: a late or duplicated
        // Socket.IO frame must never resurrect it (or restart its alarm).
        if (this.locallyAcknowledged.has(key)) return false;
        if (this.notifByEvent.has(key)) return false; // already known & still unread
        this.notifByEvent.set(key, record);
        this.renderNotificationPanel();

        const live = this.orders.get(record.orderId);
        this.raiseOrderEventAlert(live || this.orderStubFromNotification(record), record.eventType, {
            fromNotification: record,
            stub: !live,
        });
        return true;
    },

    /**
     * Mark ONE order event acknowledged in the backend and stop its alarm.
     *
     * `eventType` omitted => every still-unread event for that order (used when
     * staff open or action the ticket itself). Either way the PATCH is per
     * notification id, so an unrelated order's notification is never touched.
     */
    async acknowledgeNotification(record) {
        if (!record || !record.id) return false;
        const key = this.eventKey(record.orderId, record.eventType);
        const known = this.notifByEvent.get(key) || record;
        // Update the UI first so the row disappears the instant staff click it,
        // and remember it so a stale poll snapshot cannot bring it back.
        this.locallyAcknowledged.add(key);
        this.notifByEvent.delete(key);
        this.renderNotificationPanel();
        try {
            await api.patch(`/notifications/${encodeURIComponent(known.id)}/read`);
            if (typeof window.refreshNotificationBadge === 'function') {
                window.refreshNotificationBadge();
            }
            return true;
        } catch (error) {
            console.warn('Failed to mark notification as read:', error && error.message);
            return false;
        }
    },

    async acknowledgeNotificationsForOrder(orderId, eventType) {
        const prefix = `${String(orderId)}|`;
        const targets = Array.from(this.notifByEvent.entries())
            .filter(([key]) => key.startsWith(prefix) && (!eventType || key === prefix + eventType))
            .map(([, record]) => record);
        for (const record of targets) {
            await this.acknowledgeNotification(record);
        }
        return targets.length;
    },

    // --- Persistent kitchen notification panel ---------------------------
    bindNotificationPanel() {
        if (this.notifList && !this.notifList.dataset.kdsBound) {
            this.notifList.dataset.kdsBound = '1';
            // Delegated: the list is re-rendered constantly, so a per-row
            // handler would be lost every time.
            this.notifList.addEventListener('click', (e) => {
                const row = e.target.closest('[data-notif-key]');
                if (!row || !this.notifList.contains(row)) return;
                const record = this.notifByEvent.get(row.dataset.notifKey);
                if (!record) return;
                if (e.target.closest('[data-notif-open]')) {
                    e.preventDefault();
                    // focusOrder acknowledges on its own; the row handler below
                    // must not fire a second PATCH for the same notification.
                    this.focusOrder(record.orderId, record.eventType);
                    return;
                }
                // Viewing the row IS the acknowledgement (requirement: clicking
                // a notification marks that one, and only that one, as read).
                this.acknowledgeAlert(record.orderId, record.eventType, { silent: true });
            });
            // The row is focusable, so Enter/Space must work too - otherwise the
            // only way to acknowledge a notification is a mouse click.
            this.notifList.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const row = e.target.closest('[data-notif-key]');
                if (!row || !this.notifList.contains(row)) return;
                e.preventDefault();
                const record = this.notifByEvent.get(row.dataset.notifKey);
                if (!record) return;
                this.acknowledgeAlert(record.orderId, record.eventType, { silent: true });
            });
        }
        this.renderNotificationPanel();
    },

    renderNotificationPanel() {
        if (this.notifCountEl) {
            const count = this.notifByEvent.size;
            this.notifCountEl.textContent = String(count);
            this.notifCountEl.hidden = count === 0;
        }
        if (!this.notifList) return;

        // The panel is never hidden while unread items exist and never
        // auto-dismisses: it is the durable record of "the kitchen has not seen
        // this yet", so it must outlive any toast.
        //
        // Newest FIRST, by the notification's real createdAt. A customer order
        // that arrives over Socket.IO therefore lands at the top immediately -
        // no refresh - and older notifications stay below it.
        const records = this.sortNotificationsNewestFirst(
            Array.from(this.notifByEvent.values())
        );

        if (records.length === 0) {
            this.notifList.innerHTML =
                '<li class="kds-notif-empty" data-empty-message>All caught up — no unread kitchen notifications.</li>';
            return;
        }

        this.notifList.innerHTML = records
            .map((record) => {
                const isCancel = record.eventType === 'cancelled';
                const when = this.formatRelativeTime(record.createdAt);
                const reason = record.cancellationReason
                    ? `<div class="kds-notif-reason"><i class="fa-solid fa-circle-info"></i> ${this.escapeHtml(record.cancellationReason)}</div>`
                    : '';
                return `
                <li class="kds-notif-row ${isCancel ? 'kds-notif-row-cancelled' : ''}"
                    data-notif-key="${this.escapeHtml(this.eventKey(record.orderId, record.eventType))}"
                    data-order-id="${this.escapeHtml(record.orderId)}"
                    role="button" tabindex="0" title="Click to mark as viewed / acknowledged">
                    <i class="fa-solid ${isCancel ? 'fa-circle-xmark' : 'fa-receipt'} kds-notif-icon"></i>
                    <div class="kds-notif-body">
                        <div class="kds-notif-title">
                            ${isCancel ? 'Order Cancelled' : 'New Customer Order'}
                            <span class="kds-notif-order">#${this.escapeHtml(record.orderId)}</span>
                            <span class="kds-notif-when">${this.escapeHtml(when)}</span>
                        </div>
                        <div class="kds-notif-message">${this.escapeHtml(record.message)}</div>
                        ${reason}
                    </div>
                    <div class="kds-notif-actions">
                        <button type="button" class="kds-notif-btn" data-notif-open="1">View</button>
                        <button type="button" class="kds-notif-btn kds-notif-btn-ack">Mark viewed</button>
                    </div>
                </li>`;
            })
            .join('');
    },

    escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    /**
     * Epoch millis for a notification's real creation time.
     *
     * Returns a real number even for an unparseable value (0) so the sort
     * comparator can never produce NaN - a NaN comparison makes Array.sort
     * treat the entries as equal and silently keep insertion order, which is
     * exactly how a new order ended up below older ones.
     */
    notificationTimestamp(value) {
        const ms = new Date(value).getTime();
        return Number.isFinite(ms) ? ms : 0;
    },

    /**
     * Newest-first ordering, by the notification's real createdAt.
     *
     * `_seq` breaks ties deterministically so two notifications created in the
     * same millisecond still keep a stable, arrival-order (newest last-seen
     * first) sequence instead of shuffling on every repaint.
     *
     * Deliberately does NOT call `this.notificationTimestamp`: Array#sort
     * invokes its comparator with `this` bound to the array being sorted, not to
     * KDS, so a `this.` call here would throw on every render.
     */
    sortNotificationsNewestFirst(records) {
        const ts = (value) => {
            const ms = new Date(value).getTime();
            return Number.isFinite(ms) ? ms : 0;
        };
        return records.slice().sort((a, b) => {
            const diff = ts(b.createdAt) - ts(a.createdAt);
            if (diff !== 0) return diff;
            return (b._seq || 0) - (a._seq || 0);
        });
    },


    formatRelativeTime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} min ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hr ago`;
        return date.toLocaleDateString();
    },

    // --- Alert lifecycle --------------------------------------------------

    /**
     * The ONLY two events that may make an audible alert on this dashboard:
     * a brand-new customer order, and a customer cancelling an order.
     *
     * Sound is raised exclusively through startAlertLoop() from
     * raiseOrderEventAlert(), which is reached from the `order:new` frame, the
     * cancelled `order:status` frame and the durable `notification:new` frame.
     * There is deliberately no one-shot `playSoundOnce` helper any more: it was
     * the path that rang for plain status changes (ready / served / completed),
     * which are not events the kitchen needs to be told about.
     */
    isAudibleAlertEvent(eventType) {
        return eventType === 'new' || eventType === 'cancelled';
    },

    /**
     * Start the alarm for ONE order event.
     *
     * `soundType` is 'new' or 'cancelled'. The two are independent
     * notifications for the same order and are allowed to ring together: an
     * unread cancellation must still be heard even if the new-order alert for
     * that order was already acknowledged.
     *
     * If opts.maxDurationMs is set (e.g. 1000), the sound plays for that
     * many milliseconds and then stops automatically. If omitted or Infinity,
     * the sound repeats until acknowledged (original behaviour).
     */
    startAlertLoop(orderId, soundType, opts) {
        if (!orderId) return false;
        const event = soundType === 'cancelled' ? 'cancelled' : 'new';
        // Hard gate: only NEW_ORDER and ORDER_CANCELLED may ever be audible.
        // Anything else that reaches this function is refused outright.
        if (!this.isAudibleAlertEvent(event)) return false;
        const eventKey = this.eventKey(String(orderId), event);
        // Muted per EVENT, not per order: acknowledging a new order must not
        // prevent a later cancellation of that same order from alerting.
        if (this.mutedAlerts.has(eventKey)) return false;

        const sound = window.ScosNotify;
        if (!sound || typeof sound.startLoop !== 'function') return false;

        const key = this.soundKeyFor(orderId, event);
        if (sound.isLooping && sound.isLooping(key)) return false;

        return sound.startLoop(key, event === 'cancelled' ? 'cancellation' : 'order', {
            intervalMs: Number(opts && opts.intervalMs) || ALERT_LOOP_INTERVAL_MS,
            maxDurationMs: opts && opts.maxDurationMs !== undefined
                ? opts.maxDurationMs
                : ORDER_ALERT_NO_MAX_DURATION
        });
    },

    /**
     * Stop the alarm for ONE order event.
     *
     * `eventType` omitted acknowledges every event for that order (used when
     * staff open or action the ticket itself). Crucially, the pause of the
     * shared audio element only happens once NO loop is left, so clearing one
     * notification never silences another unread one.
     */
    stopAlertLoop(orderId, eventType) {
        if (!orderId) return;
        const sound = window.ScosNotify;
        const events = eventType ? [eventType] : ['new', 'cancelled'];
        events.forEach((event) => {
            const evt = event === 'cancelled' ? 'cancelled' : 'new';
            this.mutedAlerts.add(this.eventKey(String(orderId), evt));
            if (sound && typeof sound.stopLoop === 'function') {
                sound.stopLoop(this.soundKeyFor(orderId, evt));
            }
        });
        if (!sound) return;
        // Only cut the shared element when nothing else is still alerting.
        const stillRinging = typeof sound.anyLooping === 'function'
            ? sound.anyLooping()
            : true;
        if (!stillRinging && typeof sound.stopPlayback === 'function') {
            sound.stopPlayback();
        }
    },

    stopAllAlertLoops() {
        const sound = window.ScosNotify;
        if (!sound) return;
        if (typeof sound.stopAllLoops === 'function') sound.stopAllLoops();
        if (typeof sound.stopPlayback === 'function') sound.stopPlayback();
    },

    markAlertPending(orderId) {
        if (!orderId) return;
        this.pendingAlerts.add(orderId);
    },

    /**
     * Raise the alert for ONE order event: toast, unread ticket marker,
     * persistent banner entry and a repeating sound that only stops on
     * acknowledgement.
     *
     * Safe to call repeatedly and from several independent entry points (the
     * `order:new` socket frame, the `order:status` cancellation frame, the
     * backend `notification:new` frame and the board poll). The first one to
     * get here raises the alert; every later one is a no-op for toast and sound
     * because `alerted` is keyed on "<orderId>|<eventType>". That is what
     * guarantees a single order event is never announced or rung twice, even
     * though it travels down several channels at once.
     *
     * @param {Object} order - Live order, or a metadata-only stub.
     * @param {string} eventType - 'new' or 'cancelled'.
     * @param {Object} options - { stub, fromNotification }.
     * @returns {boolean} True when this call actually raised the alert.
     */
    raiseOrderEventAlert(order, eventType, options) {
        if (!order || !order.orderId) return false;
        const opts = options || {};
        const event = eventType === 'cancelled' ? 'cancelled' : 'new';
        const orderId = String(order.orderId);
        const key = this.eventKey(orderId, event);

        // Defence in depth: an acknowledged event must never be re-raised (e.g.
        // a replayed `order:new`). An unread backend notification always wins
        // over the local cache, because the server is the source of truth.
        const hasUnread = this.notifByEvent.has(key);
        if (!hasUnread && !opts.stub && this.isAcknowledged(key)) return false;

        // Merge, for the same reason as handleStatusUpdate. This runs RIGHT AFTER a
        // status frame was merged, and a raw `set` here undid that merge - so the
        // cancellation alert path was the thing that stripped `items` /
        // `createdAt` from a just-cancelled order and left a blank row under the
        // Cancelled tab.
        if (!opts.stub) this.orders.set(orderId, this.mergeOrder(this.orders.get(orderId), order));

        // The banner entry carries the event's real time so the banner can be
        // ordered newest-first, and a stable arrival sequence as tie-breaker.
        // A `notification:new` frame is authoritative; otherwise fall back to
        // the order's own timestamp.
        const eventTime = (opts.fromNotification && opts.fromNotification.createdAt)
            || order.eventAt
            || order.cancellationProcessedAt
            || order.updatedAt
            || order.createdAt
            || order.orderTime
            || null;
        const existingEntry = this.newOrderAlerts.get(orderId);
        this.newOrderAlerts.set(orderId, {
            order,
            eventType: event,
            createdAt: (existingEntry && existingEntry.createdAt) || eventTime,
            _seq: (existingEntry && existingEntry._seq) || this._notifSeq++,
        });

        if (this.alerted.has(key)) {
            // Already announced in this session - keep the banner honest, but
            // no second toast and no second alarm.
            this.renderAlertBanner();
            return false;
        }
        this.alerted.add(key);
        this.notifiedKeys.add(this.soundKeyFor(orderId, event));

        this.showOrderEventToast(order, event);
        this.markAlertPending(orderId);
        this.startAlertLoop(orderId, event, { maxDurationMs: 1000 });
        this.maybeShowUnlockBanner();
        this.updateStats();
        this.renderAlertBanner();
        this.render();
        return true;
    },

    /** Back-compat wrapper: a plain "new customer order" event. */
    raiseNewOrderAlert(order) {
        return this.raiseOrderEventAlert(order, 'new');
    },

    /**
     * Reconcile the live real-order data from /kitchen/dashboard against the
     * unacknowledged set. This is the safety net that guarantees a new order is
     * never silently dropped when the socket message is missed (backgrounded
     * tab, reconnect, dropped frame).
     *
     * @param {Array} orders - Real orders from the kitchen dashboard.
     * @param {Object} options - { adoptBaseline } for the first load of a session.
     */
    syncNewOrderAlerts(orders, options) {
        const adoptBaseline = Boolean(options && options.adoptBaseline);
        const list = Array.isArray(orders) ? orders : [];
        let raised = 0;

        list.forEach(order => {
            if (!order || !order.orderId) return;
            const status = String(order.status || order.orderStatus || '').toLowerCase();
            if (!AWAITING_KITCHEN_STATUSES.includes(status)) return;

            if (adoptBaseline) {
                // Orders already on the board when the page opened are the
                // starting point, not fresh arrivals - except anything placed
                // moments ago, which is treated as an unacknowledged new order.
                const createdAt = new Date(order.createdAt || order.orderTime || 0).getTime();
                const isJustPlaced = Number.isFinite(createdAt) && (Date.now() - createdAt) < BASELINE_GRACE_MS;
                if (!isJustPlaced) {
                    // Leave any still-unread backend notification alone: if the
                    // server says staff have not seen this, the board baseline
                    // must not paper over it.
                    if (!this.notifByEvent.has(this.eventKey(order.orderId, 'new'))) {
                        this.markAcknowledged(this.eventKey(order.orderId, 'new'));
                        this.notifiedKeys.add('order:new:' + order.orderId);
                    }
                    return;
                }
            }

            if (this.alerted.has(this.eventKey(order.orderId, 'new'))) return;
            if (this.raiseNewOrderAlert(order)) raised++;
        });

        // Orders that have moved past "pending" (or vanished) are no longer
        // awaiting the kitchen: acknowledge them so the banner never points at
        // an order that is already being handled. A cancellation is exempt -
        // the kitchen must still be told to stop cooking, and to acknowledge it.
        this.newOrderAlerts.forEach((entry, orderId) => {
            if (!entry || entry.eventType === 'cancelled') return;
            if (!list.length) return;
            if (!this.alerted.has(this.eventKey(orderId, 'new'))) return;
            const live = list.find(o => o && String(o.orderId) === String(orderId));
            const status = String((live && (live.status || live.orderStatus)) || '').toLowerCase();
            if (live && !AWAITING_KITCHEN_STATUSES.includes(status)) {
                this.markAcknowledged(this.eventKey(orderId, 'new'));
                this.newOrderAlerts.delete(orderId);
                this.pendingAlerts.delete(orderId);
                this.acknowledgeNotificationsForOrder(orderId, 'new').catch(() => {});
            }
        });

        if (raised) this.renderAlertBanner();
        return raised;
    },

    formatAlertSummary(order) {
        if (!order) return '';
        const parts = [`#${order.orderId}`];
        if (order.customerName) parts.push(order.customerName);
        const type = String(order.orderType || 'dine-in').toLowerCase();
        parts.push(this.capitalize(type));
        if (order.tableNumber && order.tableNumber !== 'N/A') parts.push(`Table ${order.tableNumber}`);
        const items = Array.isArray(order.items) ? order.items : [];
        const count = order.itemCount != null
            ? order.itemCount
            : items.reduce((n, it) => n + (Number(it.quantity) || 0), 0);
        if (count) parts.push(`${count} item${count === 1 ? '' : 's'}`);
        return parts.join(' · ');
    },

    renderAlertBanner() {
        const banner = this.newOrderBanner;
        if (!banner) return;

        // Newest first, using the REAL event time from the backend
        // notification (or the order's own createdAt when the alert came from
        // the board rather than a notification). The previous implementation
        // rendered Map insertion order, so an order that arrived a moment ago
        // was appended BELOW the alerts already on screen.
        const entries = this.sortNotificationsNewestFirst(
            Array.from(this.newOrderAlerts.entries()).map(([orderId, entry]) => ({
                orderId: String(orderId),
                order: (entry && entry.order) || {},
                eventType: (entry && entry.eventType) || 'new',
                createdAt: (entry && entry.createdAt)
                    || (entry && entry.order && (entry.order.eventAt || entry.order.createdAt || entry.order.orderTime))
                    || null,
                _seq: (entry && entry._seq) || 0,
            }))
        );
        // Rebuild only when the set of unacknowledged events actually changes,
        // so the periodic board refresh cannot swap the banner out from under
        // a click.
        const signature = entries
            .map(e => `${e.orderId}|${e.eventType}`)
            .sort()
            .join(',');
        if (signature === this._bannerSignature) return;
        this._bannerSignature = signature;

        if (entries.length === 0) {
            banner.hidden = true;
            banner.innerHTML = '';
            return;
        }

        const newCount = entries.filter(e => e.eventType === 'new').length;
        const cancelCount = entries.length - newCount;

        banner.hidden = false;
        banner.innerHTML = '';

        const headline = document.createElement('div');
        headline.className = 'kds-new-order-headline';

        const icon = document.createElement('i');
        icon.className = newCount > 0 ? 'fa-solid fa-bell' : 'fa-solid fa-circle-xmark';

        const title = document.createElement('span');
        const bits = [];
        if (newCount > 0) {
            bits.push(newCount === 1 ? '1 new order' : `${newCount} new orders`);
        }
        if (cancelCount > 0) {
            bits.push(cancelCount === 1 ? '1 cancellation' : `${cancelCount} cancellations`);
        }
        title.textContent = `${bits.join(' · ')} - action needed`;

        const pulse = document.createElement('span');
        pulse.className = 'kds-new-order-pulse';
        pulse.textContent = 'Alerting';

        headline.append(icon, title, pulse);

        const list = document.createElement('ul');
        list.className = 'kds-new-order-list';
        entries.forEach(entry => {
            const { orderId, order, eventType } = entry;
            const isCancel = eventType === 'cancelled';

            const item = document.createElement('li');
            item.className = 'kds-new-order-item' + (isCancel ? ' kds-new-order-item-cancelled' : '');
            item.dataset.orderId = orderId;
            item.dataset.eventType = eventType;

            const summary = document.createElement('span');
            summary.className = 'kds-new-order-summary';
            summary.textContent = this.formatAlertSummary(order);
            if (isCancel && order.cancellationReason) {
                const reason = document.createElement('span');
                reason.className = 'kds-new-order-reason';
                reason.textContent = `Reason: ${order.cancellationReason}`;
                summary.appendChild(reason);
            }

            const actions = document.createElement('span');
            actions.className = 'kds-new-order-actions';

            const viewBtn = document.createElement('button');
            viewBtn.type = 'button';
            viewBtn.className = 'kds-new-order-btn';
            viewBtn.textContent = 'View';
            viewBtn.addEventListener('click', () => {
                this.focusOrder(orderId, eventType);
            });

            const ackBtn = document.createElement('button');
            ackBtn.type = 'button';
            ackBtn.className = 'kds-new-order-btn kds-new-order-btn-stop';
            ackBtn.textContent = isCancel ? 'Mark viewed' : 'Stop sound';
            ackBtn.addEventListener('click', () => {
                this.acknowledgeAlert(orderId, eventType);
            });

            actions.append(viewBtn, ackBtn);
            item.append(summary, actions);
            list.appendChild(item);
        });

        banner.append(headline, list);
    },

    /**
     * Acknowledge an order event in BOTH places:
     *  - the backend (PATCH .../read), so the unread state is durable and
     *    shared across every kitchen terminal and survives a refresh;
     *  - the local sound cache, so this browser stops ringing immediately.
     *
     * @param {string} orderId
     * @param {string} eventType - 'new'/'cancelled', or omitted to acknowledge
     *                            every still-unread event for that order.
     * @param {Object} options - { silent } to skip the re-render churn.
     */
    acknowledgeAlert(orderId, eventType, options) {
        if (!orderId) return;
        const opts = options || {};
        const id = String(orderId);
        const key = eventType ? this.eventKey(id, eventType) : null;

        // Both the loop and the local cache are keyed per event, so clearing a
        // new-order alert can never hide a cancellation raised moments later.
        this.markAcknowledged(key);
        if (key) {
            this.alerted.add(key);
        } else {
            this.alerted.add(this.eventKey(id, 'new'));
            this.alerted.add(this.eventKey(id, 'cancelled'));
        }
        // Stop ONLY this event's alarm. Omitting eventType (staff opened or
        // actioned the ticket) stops every event for this one order - and still
        // leaves any other order's alarm ringing.
        this.stopAlertLoop(id, eventType || null);
        this.newOrderAlerts.delete(id);
        this.pendingAlerts.delete(id);

        // Fire-and-forget: the UI must respond instantly, and the next poll will
        // reconcile if this PATCH fails.
        this.acknowledgeNotificationsForOrder(id, eventType || null)
            .catch(() => {});

        if (opts.silent) return;
        this.renderAlertBanner();
        this.updateStats();
        this.render();
    },

    focusOrder(orderId, eventType) {
        this.acknowledgeAlert(orderId, eventType);
        const target = [this.gridContainer, this.tableBody]
            .filter(Boolean)
            .flatMap(container => Array.from(container.querySelectorAll('[data-order-id]')))
            .find(el => el.dataset.orderId === String(orderId));
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('kds-ticket-focused');
        setTimeout(() => target.classList.remove('kds-ticket-focused'), 2500);
    },

    showOrderEventToast(order, eventType) {
        if (!this.toastStack || !order) return;

        const orderId = order.orderId || order._id || '—';
        const customer = order.customerName || 'Customer';
        const type = String(order.orderType || 'dine-in');
        const normalizedEventType = String(eventType || 'new').toLowerCase();
        const isCancellation = normalizedEventType === 'cancelled' || normalizedEventType === 'cancellation';
        const alertEvent = isCancellation ? 'cancelled' : 'new';
        const eventLabel = isCancellation ? 'Cancellation' : 'New order';
        const title = isCancellation ? `Order #${orderId} cancelled` : `New order #${orderId}`;
        const table = order.tableNumber && order.tableNumber !== 'N/A'
            ? ` · Table ${order.tableNumber}`
            : '';
        const eventTime = order.eventAt || order.cancellationProcessedAt || order.updatedAt || order.createdAt || order.orderTime || order.orderDate;
        let timeLabel = 'now';
        if (eventTime) {
            const date = new Date(eventTime);
            if (!Number.isNaN(date.getTime())) {
                timeLabel = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }
        }
        const items = Array.isArray(order.items) ? order.items : [];
        const itemCount = order.itemCount != null
            ? order.itemCount
            : items.reduce((n, it) => n + (Number(it.quantity) || 0), 0);
        const itemPreview = items
            .slice(0, 3)
            .map(it => `${it.quantity || 1}× ${it.name}`)
            .join(', ');
        const more = items.length > 3 ? ` +${items.length - 3} more` : '';
        const totalValue = Number(order.totalAmount);
        const total = order.totalAmount != null && Number.isFinite(totalValue)
            ? ` · ${totalValue.toFixed(2)} ETB`
            : '';

        const toast = document.createElement('div');
        toast.className = `kds-toast${isCancellation ? ' kds-toast-cancelled' : ''} kds-toast-alerting`;
        toast.setAttribute('role', isCancellation ? 'alert' : 'status');

        const titleEl = document.createElement('div');
        titleEl.className = 'kds-toast-title';
        const icon = document.createElement('i');
        icon.className = isCancellation ? 'fa-solid fa-circle-xmark' : 'fa-solid fa-bell';
        const titleText = document.createElement('span');
        titleText.textContent = title;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'kds-toast-close';
        close.setAttribute('aria-label', 'Dismiss');
        close.textContent = '×';
        titleEl.append(icon, titleText, close);

        const meta = document.createElement('div');
        meta.className = 'kds-toast-meta';
        meta.textContent = `${customer} · Event: ${eventLabel} · ${this.capitalize(type)}${table} · ${timeLabel}`;

        const itemDetails = document.createElement('div');
        itemDetails.className = 'kds-toast-items';
        itemDetails.textContent = `${itemCount} item${itemCount === 1 ? '' : 's'}${itemPreview ? ` — ${itemPreview}${more}` : ''}${total}`;

        const actions = document.createElement('div');
        actions.className = 'kds-toast-actions';

        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'kds-toast-action';
        viewBtn.textContent = 'View order';

        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'kds-toast-action kds-toast-action-stop';
        stopBtn.textContent = isCancellation ? 'Mark viewed' : 'Stop sound';
        stopBtn.dataset.orderId = orderId;

        actions.append(viewBtn, stopBtn);
        toast.append(titleEl, meta, itemDetails, actions);

        viewBtn.addEventListener('click', () => {
            // Viewing the order is an acknowledgement: stop this order's alert
            // only, so any other unacknowledged order keeps ringing.
            this.focusOrder(orderId, alertEvent);
            toast.remove();
        });

        const stopSound = () => {
            this.acknowledgeAlert(orderId, alertEvent);
            stopBtn.disabled = true;
            stopBtn.textContent = isCancellation ? 'Acknowledged' : 'Sound stopped';
            toast.classList.remove('kds-toast-alerting');
        };
        stopBtn.addEventListener('pointerdown', stopSound);
        stopBtn.addEventListener('click', stopSound);

        close.addEventListener('click', () => {
            this.acknowledgeAlert(orderId, alertEvent);
            toast.remove();
        });

        this.toastStack.appendChild(toast);
        while (this.toastStack.children.length > 5) {
            this.toastStack.firstElementChild.remove();
        }
    },

    /**
     * The dashboard URL, including the opt-in unpaid view.
     *
     * `includeUnpaid` is only sent when the user asked for it, so the default
     * request (and therefore the default kitchen board) is unchanged.
     */
    dashboardUrl() {
        return this.includeUnpaid
            ? '/kitchen/dashboard?includeUnpaid=1'
            : '/kitchen/dashboard';
    },

    /**
     * Record WHY the board looks empty.
     *
     * The kitchen queue only ever lists PAID orders (payment confirmed -> the
     * order joins the queue). So a database full of freshly-placed, not-yet-paid
     * orders produced a board of zeros that looked identical to "nothing to
     * cook". The backend reports both counts; keeping them lets the empty state
     * name the real cause instead of guessing.
     */
    applyDiagnostics(response) {
        const d = (response && response.diagnostics) || {};
        this.ordersInWindow = Number(d.ordersInWindow) || 0;
        this.unpaidInWindow = Number(d.unpaidInWindow) || 0;
    },

    /** Turn the opt-in unpaid view on/off, reload, and reveal the rows. */
    async setIncludeUnpaid(on) {
        this.includeUnpaid = Boolean(on);
        const btn = document.querySelector('[data-toggle-unpaid][aria-pressed]');
        if (btn) btn.setAttribute('aria-pressed', String(this.includeUnpaid));

        await this.loadInitialOrders();

        // Land on the view the user just asked for. Toggling OFF must return to
        // the paid queue, never leave them sitting on the triage tab.
        this.currentFilter = this.includeUnpaid ? 'unpaid' : 'all';

        // The banner is only meaningful while the triage rows are on screen.
        const banner = document.getElementById('unpaidBanner');
        if (banner) banner.hidden = !(this.includeUnpaid && this.countForFilter('unpaid'));

        // Re-sync the active tab on the buttons. Without this, turning the view
        // OFF left "Not paid yet" highlighted while showing the paid queue.
        document.querySelectorAll('.filter-group .btn, .filter-trigger').forEach((b) => {
            const status = b.dataset && b.dataset.status;
            b.classList.toggle('active', status === this.currentFilter);
        });

        this.render();
    },

    /**
     * Fetch the dashboard, one request at a time.
     *
     * The board polls every 15s, but a response can take longer than that on a
     * slow link. Callers therefore JOIN an in-flight request instead of starting
     * another, so a slow round trip degrades into "the next tick reuses the
     * answer" rather than into a pile of overlapping requests that each burn the
     * client timeout. `_boardRequest` is cleared as soon as it settles, so the
     * tick after a failure starts a genuinely fresh attempt.
     */
    requestDashboard() {
        if (this._boardRequest) return this._boardRequest;
        this._boardRequest = Promise.resolve()
            .then(() => api.get(this.dashboardUrl(), { timeout: this.DASHBOARD_TIMEOUT_MS }))
            .finally(() => { this._boardRequest = null; });
        return this._boardRequest;
    },

    async loadInitialOrders(options) {
        try {
            const response = await this.requestDashboard();
            if (response.success) {
                // A successful load means an empty queue is a real answer. Only a
                // failure below may claim "could not load" - otherwise a broken
                // request and a genuinely empty cafeteria look identical.
                this.loadError = null;
                this.applyDiagnostics(response);
                // Combine all orders from different statuses.
                const allOrders = [
                    ...(response.orders.pending || []),
                    ...(response.orders.preparing || []),
                    ...(response.orders.ready || []),
                    ...(response.orders.cancelled || []),
                    // The opt-in "not paid yet" view. Never mixed into the
                    // kitchen's own counts - these must not be worked.
                    ...(response.orders.unpaid || [])
                ];
                allOrders.forEach(order => {
                    this.orders.set(order.orderId, order);
                    // Seed de-dupe keys so page refresh / reconnect / redelivery
                    // of already-known orders can never chime as "new".
                    if (order.orderId) {
                        this.notifiedKeys.add('order:new:' + order.orderId);
                        if (String(order.status || order.orderStatus || '').toLowerCase() === 'cancelled') {
                            this.notifiedKeys.add('order:status:cancelled:' + order.orderId);
                        }
                    }
                });
                // First snapshot of the session: treat the current board as the
                // baseline, but still alert on an order placed moments ago.
                this.syncNewOrderAlerts(allOrders, { adoptBaseline: true });
                this.updateStats();
                this.render();
                this.renderAlertBanner();
            } else {
                this.loadError = (response && response.error) || 'The kitchen queue could not be loaded.';
            }
        } catch (error) {
            console.error('Failed to load initial orders:', error);
            // Keep whatever is already on screen, but tell the truth about why
            // it may be stale instead of leaving an unexplained empty table.
            this.loadError = (error && error.message) || 'Could not reach the kitchen queue.';
        }
    },

    async refreshOrders() {
        try {
            const response = await this.requestDashboard();
            if (response.success) {
                this.loadError = null;
                this.applyDiagnostics(response);
                const allOrders = [
                    ...(response.orders.pending || []),
                    ...(response.orders.preparing || []),
                    ...(response.orders.ready || []),
                    ...(response.orders.cancelled || []),
                    ...(response.orders.unpaid || [])
                ];
                allOrders.forEach(order => {
                    // Poll refreshes update the board from real data and are also
                    // the safety net for a missed socket event: any order that is
                    // still unacknowledged raises its alert here.
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
                this.syncNewOrderAlerts(allOrders);
                this.loadError = null;
                this.updateStats();
                this.render();
                this.renderAlertBanner();
            } else {
                this.loadError = (response && response.error) || 'The kitchen queue could not be loaded.';
            }
        } catch (error) {
            console.error('Failed to refresh orders:', error);
            this.loadError = (error && error.message) || 'Could not reach the kitchen queue.';
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
        // Refreshes only update the board — they never chime for old rows.
        socketClient.on('connect', () => {
            if (this.initialLoadComplete) {
                this.refreshOrders();
                // Anything that arrived while this terminal was disconnected is
                // already unread server-side, so a resync is what restores the
                // alert rather than relying on a frame that was never sent.
                this.loadKitchenNotifications({ hydrate: true });
            }
            const live = document.getElementById('kdsLiveIndicator');
            if (live) {
                live.innerHTML = '<i class="fa-solid fa-signal"></i> Live updates';
            }
        });

        // Real-time: customer places order → backend emits order:new → kitchen room.
        socketClient.on('order:new', (order) => this.handleNewOrder(order));
        socketClient.on('order:status', (order) => this.handleStatusUpdate(order));
        socketClient.on('order:payment', (order) => this.handlePaymentComplete(order));

        // Durable, per-recipient order events. This is the channel that also
        // reaches a kitchen terminal that was offline when the order arrived,
        // and it carries the notification id needed to acknowledge server-side.
        // It is de-duplicated against `order:new` / `order:status`, so an order
        // event that arrives on both frames still alerts exactly once.
        socketClient.on('notification:new', (notification) => {
            this.handleIncomingNotification(notification);
        });

        // Catch-all used by other pages (and by ourselves after a reconnect) to
        // resync the unread list.
        if (typeof window !== 'undefined') {
            window.addEventListener('notification:refresh', () => {
                this.loadKitchenNotifications({ hydrate: true });
            });
        }

        // Register listeners before connecting so a fast connection cannot
        // deliver an order event before the handlers are ready.
        // socketClient reuses a single Socket.IO connection (no second client).
        socketClient.connect(token);
    },

    handleNewOrder(order) {
        if (!order || !order.orderId) return;
        // The kitchen queue is payment-gated (payment successful -> order = PENDING
        // -> kitchen dashboard), and the backend only sends PAID orders here.
        // Re-check so a stray pre-payment frame can never put an unpaid row on
        // the board - it arrives again once the payment is confirmed.
        if (order.paymentStatus && order.paymentStatus !== 'PAID') return;
        const wasKnown = this.orders.has(order.orderId);
        console.log('New order received:', order.orderId, wasKnown ? '(board refresh)' : '(new)');
        // The board row must appear even when this terminal had already
        // acknowledged the event, so record the order before rendering.
        // Merged, so a "board refresh" frame (the order already known) cannot
        // blank the items a previous full load supplied.
        this.orders.set(String(order.orderId), this.mergeOrder(this.orders.get(String(order.orderId)), order));
        // Re-render the table so the new order appears at the top immediately
        // Sorted by newest-first via getFilteredOrders(), no toast/sound emitted.
        this.render();
    },

    handleStatusUpdate(order) {
        if (!order || !order.orderId) return;
        console.log('Order status update:', order);
        const key = String(order.orderId);
        const prev = this.orders.get(key);
        const prevStatus = String(prev?.status || prev?.orderStatus || '').toLowerCase();
        const nextStatus = String(order.status || order.orderStatus || '').toLowerCase();
        const statusKey = 'order:status:' + nextStatus + ':' + order.orderId;
        const statusChanged = prevStatus !== nextStatus;
        // MERGE, never replace.
        //
        // A socket status frame is a patch, not a full order. Replacing the
        // stored record with it dropped `items` / `createdAt` / `customerName`
        // whenever the frame was lean, and a row missing those renders as an
        // empty Items cell and "00 mins" - most visibly on a CANCELLED order,
        // which then looked like a broken row under the Cancelled tab.
        this.orders.set(key, this.mergeOrder(prev, order));

        if (statusChanged && nextStatus === 'cancelled') {
            // A cancellation is a first-class order event: it gets its own
            // durable backend notification, its own sound and its own banner
            // row, and it must be acknowledged like a new order. Routed through
            // the same helper so the `order:status` frame and the
            // `notification:new` frame cannot double-alert.
            this.raiseOrderEventAlert(order, 'cancelled');
        }
        // NOTE: deliberately NO sound for ready / served / completed. On the
        // Kitchen Dashboard an audible alert means "a new order arrived" or
        // "an order was cancelled" - nothing else. A status transition the
        // kitchen itself just performed is not an event worth a chime, and it
        // used to ring over any unacknowledged order alert.

        // An order that has moved on is no longer awaiting the kitchen. A
        // cancellation alert is exempt: the kitchen must still be told to stop
        // cooking and to acknowledge that it saw the cancellation.
        if (statusChanged && nextStatus !== 'cancelled' && this.newOrderAlerts.has(order.orderId)) {
            const entry = this.newOrderAlerts.get(order.orderId);
            if (entry && entry.eventType === 'new') {
                this.markAcknowledged(this.eventKey(order.orderId, 'new'));
                this.newOrderAlerts.delete(order.orderId);
                this.pendingAlerts.delete(order.orderId);
                this.acknowledgeNotificationsForOrder(order.orderId, 'new').catch(() => {});
                this.renderAlertBanner();
            }
        }

        this.updateStats();
        this.render();
    },

    handlePaymentComplete(order) {
        console.log('Payment completed for order:', order);
        // Merge for the same reason as handleStatusUpdate: a payment frame must
        // not blank out the items / timestamp the row is already showing.
        this.orders.set(String(order.orderId), this.mergeOrder(this.orders.get(String(order.orderId)), order));
        this.updateStats();
        this.render();
    },

    /** True for a row shown only in the opt-in "Not paid yet" view. */
    isUnpaidOrder(order) {
        if (!order) return false;
        if (String(order.status || '').toLowerCase() === 'cancelled') return false;
        return String(order.paymentStatus || '').toUpperCase() !== 'PAID';
    },

    /**
     * Fold a partial payload into the order we already hold.
     *
     * Incoming fields win, EXCEPT when they are absent or blank - a lean socket
     * frame must never erase the items list, customer name or createdAt that the
     * REST load already supplied. This is what keeps a cancelled order complete
     * enough to render after a live cancellation frame arrives.
     */
    mergeOrder(prev, incoming) {
        if (!prev) return incoming;
        if (!incoming) return prev;
        const merged = Object.assign({}, prev);
        Object.keys(incoming).forEach((key) => {
            const value = incoming[key];
            if (value === undefined || value === null || value === '') return;
            if (Array.isArray(value) && value.length === 0) return;
            merged[key] = value;
        });
        // The order id is the map key, so keep it authoritative and stable even
        // if a frame omits it or spells it differently.
        merged.orderId = prev.orderId || incoming.orderId;
        return merged;
    },

    updateStats() {
        let pending = 0, preparing = 0, ready = 0, cancelled = 0;

        this.orders.forEach(order => {
            const status = (order.status || order.orderStatus || '').toLowerCase();
            const isPaid = String(order.paymentStatus || '').toUpperCase() === 'PAID';
            // Kitchen WORK is PAID-only: when the opt-in "Not paid yet" view is
            // loaded those rows share this store, so they must be excluded here
            // or the stage tiles would report work the kitchen may not do.
            // A CANCELLATION is counted in every payment state - including one
            // cancelled before paying, which is exactly the record that says
            // "do not cook this ticket".
            if (status === 'cancelled') { cancelled++; return; }
            if (!isPaid) return;
            if (status === 'pending' || status === 'received') pending++;
            else if (status === 'preparing') preparing++;
            // Sent to delivery is still food waiting at the pass, so it counts
            // as ready work (and the board keeps showing "Waiting for Courier
            // Pickup" instead of dropping the ticket from every tile).
            else if (status === 'ready' || status === 'ready_for_delivery') ready++;
        });

        if (this.pendingCountEl) this.pendingCountEl.textContent = pending;
        if (this.preparingCountEl) this.preparingCountEl.textContent = preparing;
        if (this.readyCountEl) this.readyCountEl.textContent = ready;
        if (this.cancelledCountEl) this.cancelledCountEl.textContent = cancelled;
    },

    getFilteredOrders() {
        const orders = Array.from(this.orders.values());
        // Normalize status: handle both status/orderStatus fields and map variants
        const normalize = (s) => {
            if (!s) return '';
            const v = String(s).toLowerCase().trim();
            // Map known variants
            const map = {
                'in_preparation': 'preparing',
                'in prep': 'preparing',
                'preparing': 'preparing',
                'ready': 'ready',
                'served': 'served',
                'completed': 'completed',
                'cancelled': 'cancelled',
                // Spelling variants the backend / legacy rows can carry.
                'canceled': 'cancelled',
                'received': 'pending',
                'pending': 'pending',
            };
            return map[v] || v;
        };

        if (!this.currentFilter || this.currentFilter.toLowerCase() === 'all') {
            let filtered = orders.filter(o => {
                const s = normalize(o.status || o.orderStatus || '');
                // Cancelled is terminal, so it lives under its own tab; the tab
                // counts next to the filter buttons are what tell the two apart.
                if (s === 'served' || s === 'completed' || s === 'cancelled') return false;
                // The opt-in "Not paid yet" rows are in the store ONLY when the
                // user asked for them. They must never surface as kitchen work,
                // so "All Active" drops them exactly like a paid-order filter
                // would. They are reachable through their own tab.
                if (String(o.paymentStatus || '').toUpperCase() !== 'PAID') return false;
                return true;
            });
            // Sort by newest first using MongoDB createdAt, fallback to orderTime
            return filtered.sort((a, b) => {
                const ac = new Date(a.createdAt || a.orderTime || '').getTime();
                const bc = new Date(b.createdAt || b.orderTime || '').getTime();
                return bc - ac;
            });
        }
        const filter = this.currentFilter.toLowerCase();
        let filtered = orders.filter(o => {
            const s = normalize(o.status || o.orderStatus || '');
            if (filter === 'served') return s === 'served';
            if (filter === 'pending') return s === 'pending' || s === 'received';
            if (filter === 'preparing') return s === 'preparing';
            // Sent orders stay under the Ready tab with their "Waiting for
            // Courier Pickup" button - filtering them out would hide live work.
            if (filter === 'ready') return s === 'ready' || s === 'ready_for_delivery';
            // CANCELLED used to have no branch here, so the "Cancelled" tab
            // matched nothing at all and always rendered the empty row even
            // while cancelled orders were sitting in `this.orders`. Every filter
            // that has a button needs a branch here.
            if (filter === 'cancelled' || filter === 'canceled') return s === 'cancelled';
            if (filter === 'failed') return s === 'failed';
            // "Not paid yet" - the opt-in triage view. Identified by payment, not
            // by status, and deliberately EXCLUDED from every other filter (and
            // from the kitchen's own counts) so an unconfirmed payment can never
            // be mistaken for kitchen work.
            if (filter === 'unpaid') {
                return s !== 'cancelled' && String(o.paymentStatus || '').toUpperCase() !== 'PAID';
            }
            // Unknown filter: do not silently hide real work.
            return true;
        });
        // Sort by newest first using MongoDB createdAt, fallback to orderTime
        return filtered.sort((a, b) => {
            const ac = new Date(a.createdAt || a.orderTime || '').getTime();
            const bc = new Date(b.createdAt || b.orderTime || '').getTime();
            return bc - ac;
        });
    },

    /**
     * Rows each filter tab would show, without touching this.currentFilter.
     * Used to put a real count on every tab so a legitimately empty stage is
     * distinguishable from a filter that is not working.
     */
    countForFilter(filter) {
        const previous = this.currentFilter;
        let count = 0;
        try {
            this.currentFilter = filter;
            count = this.getFilteredOrders().length;
        } finally {
            this.currentFilter = previous;
        }
        return count;
    },

    /** Readable name for the active filter, for the empty-state message. */
    filterLabel(filter) {
        const labels = {
            all: 'active', pending: 'pending', preparing: 'preparing',
            ready: 'ready', cancelled: 'cancelled', served: 'served', failed: 'failed',
            // The opt-in triage view - its label reads as a caveat, not a stage.
            unpaid: 'not paid yet',
        };
        return labels[String(filter || 'all').toLowerCase()] || String(filter || 'active');
    },

    getElapsedTime(createdAt) {
        if (!createdAt) return '00 mins';
        const diffMs = new Date() - new Date(createdAt);
        const diffMins = Math.floor(diffMs / 60000);
        return `${String(diffMins).padStart(2, '0')} mins`;
    },

    async updateOrderStatus(orderId, newStatus) {
        if (this._inflight.has(orderId)) return;
        this.acknowledgeAlert(orderId);
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
            case 'pending':
            case 'received': return 'badge-pending';
            case 'preparing': return 'badge-preparing';
            case 'ready':
            case 'ready_for_delivery': return 'badge-ready';
            case 'picked_up': return 'badge-picked-up';
            case 'cancelled': return 'badge-cancelled';
            case 'served':
            case 'completed': return 'badge-served';
            default: return '';
        }
    },

    /**
     * Viewing a ticket counts as acknowledging it: clicking a card/row stops
     * that order's repeating sound and clears its unread marker. No event type
     * is given, so every still-unread event for that one order is cleared -
     * nothing belonging to any other order is affected.
     */
    bindViewAcknowledge(container) {
        if (!container) return;
        container.querySelectorAll('[data-order-id]').forEach(el => {
            el.addEventListener('click', (e) => {
                // Action buttons acknowledge on their own.
                if (e.target.closest('button, a')) return;
                const orderId = el.dataset.orderId;
                this.acknowledgeAlert(orderId);
            });
        });
    },

    getActionButtonHTML(order) {
        const status = String(order.status || order.orderStatus || '').toLowerCase();
        const orderId = order.orderId;
        const isDelivery = String(order.orderType || '').toLowerCase() === 'delivery';
        const canCancel = status === 'pending' || status === 'received' || status === 'preparing';

        const cancelBtn = canCancel
            ? `<button class="btn btn-cancel js-cancel-btn" data-id="${orderId}" title="Cancel order">
                        <i class="fa-solid fa-ban"></i> Cancel
                    </button>`
            : '';

        if (status === 'pending' || status === 'received') {
            return `${cancelBtn}
                    <button class="btn btn-advance js-action-btn" data-id="${orderId}" data-next-status="preparing">
                        <i class="fa-solid fa-fire"></i> Start Preparation
                    </button>`;
        } else if (status === 'preparing') {
            return `${cancelBtn}
                    <button class="btn btn-advance js-action-btn" data-id="${orderId}" data-next-status="ready">
                        <i class="fa-solid fa-check"></i> Mark Ready
                    </button>`;
        } else if (status === 'ready') {
            // Delivery orders STOP here. The kitchen's last action is "Send to
            // Delivery"; from READY onward the delivery staff own Pickup, Out for
            // Delivery, Arrived, Delivered and Completed on their dashboard. The
            // old "Hand to Driver" button is gone so the kitchen can never
            // advance the delivery state machine itself.
            if (isDelivery) {
                if (this.sentToDelivery.has(orderId)) {
                    return `<button class="btn btn-delivery-sent" disabled>
                        <i class="fa-solid fa-truck-pickup"></i> Waiting for Courier Pickup
                    </button>`;
                }
                return `<button class="btn btn-delivery js-send-delivery-btn" data-id="${orderId}">
                            <i class="fa-solid fa-truck-pickup"></i> Send to Delivery
                        </button>`;
            }
            return `<button class="btn btn-advance js-action-btn" data-id="${orderId}" data-next-status="served">
                        <i class="fa-solid fa-circle-check"></i> Mark Completed
                    </button>`;
        } else if (status === 'ready_for_delivery') {
            // Sent to delivery (persisted server-side, so this survives a
            // refresh without the in-memory sentToDelivery set). The kitchen's
            // work is done; the courier owns every later stage.
            return `<button class="btn btn-delivery-sent" disabled>
                        <i class="fa-solid fa-truck-pickup"></i> Waiting for Courier Pickup
                    </button>`;
        } else if (status === 'picked_up') {
            // The courier has collected it - the kitchen has nothing left to do.
            return `<span style="color: var(--text-muted); font-size: 0.85rem;">Picked up by courier</span>`;
        } else if (status === 'served' || status === 'completed') {
            return `<span style="color: var(--text-muted); font-size: 0.85rem;">Completed</span>`;
        } else if (status === 'cancelled') {
            return `<span style="color: var(--text-muted); font-size: 0.85rem;">Cancelled</span>`;
        }
        return '';
    },

    async cancelOrder(orderId) {
        if (this._inflight.has(orderId)) return;
        const order = this.orders.get(orderId);
        const label = order ? `#${orderId}` : `#${orderId}`;
        // Confirm BEFORE acknowledging: backing out of the dialog must not mark
        // a real, unhandled order event as seen in the backend.
        if (!window.confirm(`Cancel order ${label}? The customer will be notified.`)) return;
        this.acknowledgeAlert(orderId);

        this._inflight.add(orderId);
        this.setActionLoading(orderId, true);
        try {
            const response = await api.patch(`/kitchen/orders/${orderId}/reject`, {
                reason: 'Cancelled by kitchen'
            });
            if (response.success) {
                const live = this.orders.get(orderId);
                if (live) {
                    live.status = 'cancelled';
                    live.cancellationReason = 'Cancelled by kitchen';
                }
                this.updateStats();
                this.render();
            }
        } catch (error) {
            console.error('Failed to cancel order:', error);
            const isStatusConflict = error.status === 400 && /status/i.test(error.message || '');
            if (isStatusConflict) {
                await this.refreshOrders();
                const live = this.orders.get(orderId);
                if (live && String(live.status).toLowerCase() === 'cancelled') return;
            }
            alert((error && error.message) || 'Failed to cancel order. Please try again.');
        } finally {
            this._inflight.delete(orderId);
            this.setActionLoading(orderId, false);
        }
    },

    async sendToDelivery(orderId) {
        if (this._inflight.has(orderId)) return;
        this.acknowledgeAlert(orderId);
        this._inflight.add(orderId);
        this.setActionLoading(orderId, true);
        try {
            const response = await api.post(`/kitchen/orders/${orderId}/send-to-delivery`, {});
            if (response.success) {
                this.sentToDelivery.add(orderId);
                // Mirror the persisted server state locally so the card flips
                // to "Waiting for Courier Pickup" immediately (the next board
                // poll returns READY_FOR_DELIVERY and keeps it there).
                const live = this.orders.get(orderId);
                if (live && response.order) {
                    live.status = response.order.status || 'ready_for_delivery';
                    live.orderStatus = response.order.orderStatus || 'READY_FOR_DELIVERY';
                    if (response.order.readyForDeliveryAt) live.readyForDeliveryAt = response.order.readyForDeliveryAt;
                }
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

    async markReadyForPickup(orderId) {
        if (this._inflight.has(orderId)) return;
        this.acknowledgeAlert(orderId);
        this._inflight.add(orderId);
        this.setActionLoading(orderId, true);
        try {
            // Nudges the assigned courier that the order is waiting. It does NOT
            // move the order: only the courier can confirm pickup, on their own
            // dashboard, via PATCH /api/v1/deliveries/:orderId/pickup.
            const response = await api.post(`/kitchen/orders/${orderId}/ready-for-pickup`);
            if (response.success) {
                this.sentToDelivery.add(orderId);
                alert(response.message || `Order #${orderId} is ready for pickup`);
                this.render();
            }
        } catch (error) {
            console.error('Failed to mark order ready for pickup:', error);
            alert((error && error.message) || 'Failed to notify the courier. Please try again.');
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

    /**
     * Why the queue is empty, in the viewer's own words.
     *
     * Three genuinely different states used to render the same grey line
     * ("No all orders found in queue."), which is exactly the "the table is
     * broken / empty" report:
     *   1. the request failed  -> say so, and offer a retry
     *   2. this stage is empty  -> say which stage, and how many are elsewhere
     *   3. nothing at all       -> say the queue is genuinely clear
     */
    emptyStateHtml(colspan) {
        const stage = this.filterLabel(this.currentFilter);
        const isAllTab = stage === 'active';
        const openTotal = this.countForFilter('all');
        const cancelledTotal = this.countForFilter('cancelled');
        const sp = colspan ? ` colspan="${colspan}"` : '';
        const center = 'style="text-align:center;color:var(--text-muted);padding:32px;"';

        // 1. The request itself failed.
        if (this.loadError) {
            return `
                <tr><td${sp} ${center}>
                    <i class="fa-solid fa-plug-circle-xmark" style="font-size:1.6rem;color:#f59e0b;"></i>
                    <p style="margin:10px 0 4px;"><strong>Could not load the kitchen queue</strong></p>
                    <p style="margin:0 0 12px;font-size:0.85rem;">${this.escapeHtml(String(this.loadError))}</p>
                    <button type="button" class="btn btn-secondary" data-reload-orders>
                        <i class="fa-solid fa-rotate"></i> Retry
                    </button>
                </td></tr>`;
        }

        // 2. Nothing at all - on ANY tab. Say exactly that, and name the real cause
        //    when we know it: orders that exist but are not PAID yet are held
        //    out of the queue BY DESIGN, and that is not the same as "no work".
        if (openTotal === 0 && cancelledTotal === 0) {
            const unpaid = this.unpaidInWindow || 0;
            const unpaidShown = this.countForFilter('unpaid');
            if (unpaid > 0) {
                const openView = `
                    <p style="margin:8px 0 12px;font-size:0.85rem;">
                        ${unpaid} order${unpaid === 1 ? '' : 's'} exist${unpaid === 1 ? 's' : ''} but
                        ${unpaid === 1 ? 'is' : 'are'} still awaiting payment confirmation, so
                        ${unpaid === 1 ? 'it is' : 'they are'} held out of the kitchen queue on purpose.
                    </p>
                    ${unpaidShown > 0
                        ? `<p style="margin:0 0 10px;font-size:0.85rem;">They are listed under <strong>Not paid yet</strong> (${unpaidShown}).</p>`
                        : `<button type="button" class="btn btn-secondary" data-toggle-unpaid>
                               <i class="fa-solid fa-eye"></i> Show not-paid orders
                           </button>`}`;
                return `
                    <tr><td${sp} ${center}>
                        <i class="fa-solid fa-hourglass-half" style="font-size:1.6rem;color:#b45309;"></i>
                        <p style="margin:10px 0 4px;"><strong>Nothing on the queue yet.</strong></p>
                        <p style="margin:0;font-size:0.85rem;">
                            No pending, preparing, ready or cancelled orders.
                        </p>
                        ${openView}
                    </td></tr>`;
            }
            return `
                <tr><td${sp} ${center}>
                    <i class="fa-solid fa-mug-hot" style="font-size:1.6rem;"></i>
                    <p style="margin:10px 0 4px;"><strong>The kitchen queue is clear.</strong></p>
                    <p style="margin:0;font-size:0.85rem;">
                        No pending, preparing, ready or cancelled orders right now.
                        New orders appear here automatically.
                    </p>
                </td></tr>`;
        }

        // 3. This stage is empty, but there IS work elsewhere.
        const elsewhere = [];
        if (openTotal > 0) {
            elsewhere.push(`${openTotal} active order${openTotal === 1 ? '' : 's'}`);
        }
        if (cancelledTotal > 0) {
            elsewhere.push(`${cancelledTotal} cancelled order${cancelledTotal === 1 ? '' : 's'}`);
        }
        return `
            <tr><td${sp} ${center}>
                <i class="fa-solid fa-inbox" style="font-size:1.6rem;"></i>
                <p style="margin:10px 0 4px;">
                    No <strong>${this.escapeHtml(stage)}</strong> orders
                    ${isAllTab ? '' : 'in this filter'}.
                </p>
                <p style="margin:0;font-size:0.85rem;">
                    The queue currently holds ${elsewhere.join(' and ')} — pick another filter tab to see ${openTotal === 1 ? 'it' : 'them'}.
                </p>
            </td></tr>`;
    },

    /**
     * Put a real count on every filter button.
     *
     * A tab showing 0 must be distinguishable from a tab that is not working -
     * which is how the broken "Cancelled" tab went unnoticed. Each button gets
     * the row count for its own status, read through the same getFilteredOrders()
     * the list itself uses, so the badge can never disagree with the rows.
     */
    renderFilterCounts() {
        document.querySelectorAll('.filter-group .btn, .filter-trigger').forEach((button) => {
            const key = button.dataset && button.dataset.status;
            if (!key) return;
            // While the triage view is OFF no unpaid row is loaded, so the tab
            // would always read 0. Report what is being WITHHELD instead - that
            // number is the whole point of the button.
            const count = (key === 'unpaid' && !this.includeUnpaid)
                ? (this.unpaidInWindow || 0)
                : this.countForFilter(key);
            let badge = button.querySelector('.tab-count');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'tab-count';
                button.appendChild(badge);
            }
            badge.textContent = String(count);
            badge.setAttribute('data-count-for', key);
            button.title = `${this.filterLabel(key)}: ${count} order${count === 1 ? '' : 's'}`;
        });
    },

    /**
     * HTML-escape text interpolated into the empty state.
     *
     * Done with a regex rather than the usual `div.textContent = v; return
     * div.innerHTML` trick: that trick only works on a real detached element, and
     * silently returns "" anywhere else (a DOM-less test, or a stripped-down
     * host). The empty state is the one place a bug shows up as a blank message.
     */
    escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    render() {
        const filtered = this.getFilteredOrders();
        this.renderFilterCounts();

        // Grid view (dashboard.html)
        if (this.gridContainer) {
            if (filtered.length === 0) {
                this.gridContainer.innerHTML = this.emptyStateHtml();
            } else {
                this.gridContainer.innerHTML = filtered.map(order => `
                    <div class="ticket-card ${order.status?.toLowerCase()} ${this.getOrderTypeLabel(order) === 'delivery' ? 'ticket-delivery' : ''} ${this.pendingAlerts.has(order.orderId) ? 'kds-ticket-unread' : ''}" data-order-id="${order.orderId}">
                        <div class="ticket-header">
                            <span class="ticket-id">#${order.orderId}</span>
                            <div class="ticket-badges">
                                ${this.pendingAlerts.has(order.orderId) ? '<span class="badge kds-unread-badge">New</span>' : ''}
                                <span class="badge ${this.getBadgeClass(order.status)}">${this.statusLabel(order.status || order.orderStatus)}</span>
                            </div>
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

                this.gridContainer.querySelectorAll('.js-cancel-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        this.cancelOrder(e.currentTarget.dataset.id);
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

                this.bindViewAcknowledge(this.gridContainer);
            }
        }

        // Table view (orders.html)
        if (this.tableBody) {
            if (filtered.length === 0) {
                this.tableBody.innerHTML = this.emptyStateHtml(7);
            } else {
                this.tableBody.innerHTML = filtered.map(order => {
                    const elapsed = this.getElapsedTime(order.createdAt || order.orderTime);
                    return `
                        <tr data-order-id="${order.orderId}" data-unpaid="${this.isUnpaidOrder(order) ? '1' : '0'}">
                            <td>
                                <strong>#${order.orderId}</strong>
                                ${this.pendingAlerts.has(order.orderId) ? '<span class="badge kds-unread-badge">New</span>' : ''}
                            </td>
                            <td>${order.customerName || 'Unknown'}</td>
                            <td><span class="badge badge-type"><i class="fa-solid ${this.getOrderTypeIcon(order)}"></i> ${this.capitalize(this.getOrderTypeLabel(order))}</span></td>
                            <td>${this.formatItems(order)}</td>
                            <td><span class="badge ${this.getBadgeClass(order.status)}">${this.statusLabel(order.status || order.orderStatus)}</span></td>
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

                this.tableBody.querySelectorAll('.js-cancel-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        this.cancelOrder(e.currentTarget.dataset.id);
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

                this.bindViewAcknowledge(this.tableBody);
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
        // Safety net: re-fetch the real kitchen dashboard so a new order is
        // never missed when a socket event is dropped (backgrounded tab,
        // reconnect, transient network failure). Any order found here that is
        // still unacknowledged raises the same alert + repeating sound.
        this.pollInterval = setInterval(() => {
            this.refreshOrders();
        }, 15000);
    },

    startNotificationPolling() {
        // The board poll above can only see orders that are still on the board.
        // This one asks the backend directly which order events are still
        // UNREAD for this kitchen account, so a cancellation for an order that
        // has already left the board can still be delivered, still beep, and
        // still be acknowledged - and stays queued across a page refresh.
        this.notifPollInterval = setInterval(() => {
            this.loadKitchenNotifications({ hydrate: true });
        }, 20000);
    }
};

// Make KDS globally accessible for debugging
window.KDS = KDS;