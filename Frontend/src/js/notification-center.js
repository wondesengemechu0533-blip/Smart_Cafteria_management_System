/**
 * ==========================================================================
 *   SMART CAFETERIA — SHARED NOTIFICATION CENTRE
 * ==========================================================================
 * Single implementation of the notification panel used by the kitchen and the
 * admin/manager sidebars. Reuses the existing REST API
 * (`GET/PATCH/DELETE /api/v1/notifications`) and the existing `notification:new`
 * socket event, so nothing is persisted or emitted twice.
 *
 * Classic (non-module) script — usable from any page:
 *   <script src="../../js/notification-center.js"></script>
 *
 * Exposes `window.ScosNotifications`:
 *   ScosNotifications.mount(options)      -> panel controller instance
 *   ScosNotifications.ingest(notification) -> realtime insert (dedupes)
 *   ScosNotifications.refreshBadge(el)     -> update a sidebar/bell badge
 *   ScosNotifications.connectRealtime()    -> subscribe to notification:new
 *
 * The API serialises notifications as
 *   { id, title, message, type, orderId, link, meta, isRead, createdAt, timeAgo }
 * — note `id`/`isRead` (NOT `_id`/`read`).
 * ==========================================================================
 */
(function (global) {
  'use strict';

  var POLL_MS = 30000;

  // ---------------------------------------------------------------- helpers

  function t(key, fallback) {
    try {
      if (typeof global.tr === 'function' && global.tr !== t) return global.tr(key, fallback);
      if (typeof global.getText === 'function') {
        var v = global.getText(key);
        if (v && v !== key) return v;
      }
    } catch (e) {}
    return fallback;
  }

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function apiBase() {
    return global.__API_URL || (global.__API_BASE ? global.__API_BASE + '/api/v1' : '') || '/api/v1';
  }

  function token() {
    try {
      return localStorage.getItem('auth_token') || '';
    } catch (e) {
      return '';
    }
  }

  function request(path, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json', Authorization: 'Bearer ' + token() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(apiBase() + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }).then(function (res) {
      if (res.status === 204) return { success: true };
      return res
        .json()
        .catch(function () {
          return { success: false, error: 'Invalid server response' };
        })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || data.message || 'Request failed (' + res.status + ')');
            err.status = res.status;
            throw err;
          }
          return data;
        });
    });
  }

  // Normalise any notification shape (API row or socket payload) to a single
  // internal record so the renderer never has to guess which field it got.
  function normalize(raw) {
    if (!raw) return null;
    var id = raw.id || raw._id || null;
    if (!id) return null;
    var meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    return {
      id: String(id),
      title: raw.title || '',
      message: raw.message || '',
      type: raw.type || 'system',
      orderId: raw.orderId != null && raw.orderId !== '' ? String(raw.orderId) : null,
      link: raw.link || null,
      eventKey: raw.eventKey || meta.eventKey || null,
      // 'new' | 'cancelled' - set by the backend on order lifecycle events.
      eventType: raw.eventType || meta.eventType || null,
      customerName: raw.customerName || meta.customerName || null,
      orderType: raw.orderType || meta.orderType || null,
      totalAmount: raw.totalAmount != null ? raw.totalAmount : meta.totalAmount != null ? meta.totalAmount : null,
      cancellationReason: raw.cancellationReason || meta.cancellationReason || null,
      // Order details the kitchen card shows. Read from the top level first so
      // a producer that sets them explicitly wins over the `meta` copy.
      items: Array.isArray(raw.items) ? raw.items : Array.isArray(meta.items) ? meta.items : null,
      paymentStatus: raw.paymentStatus || meta.paymentStatus || null,
      orderStatus: raw.orderStatus || meta.orderStatus || null,
      orderTypeLabel: raw.orderTypeLabel || meta.orderTypeLabel || null,
      orderTime: raw.orderTime || meta.orderTime || null,
      // Delivery-domain tags. The backend sets them explicitly on assignment
      // notices (`assignment`/`unassigned`) and on every delivery lifecycle
      // step (`deliveryStatus`, `failureReason`), so a panel can filter on real
      // fields instead of matching notification titles.
      assignment: raw.assignment === true || meta.assignment === true,
      unassigned: raw.unassigned === true || meta.unassigned === true,
      deliveryStatus: raw.deliveryStatus || meta.deliveryStatus || null,
      failureReason: raw.failureReason || meta.failureReason || null,
      issueId: raw.issueId || meta.issueId || null,
      issueStatus: raw.issueStatus || meta.status || null,
      // Top-level from the API, but read from meta too so a socket frame built
      // straight from a producer still carries it.
      deliveryId: raw.deliveryId || meta.deliveryId || null,
      isRead: raw.isRead === true || raw.read === true,
      readAt: raw.readAt || null,
      createdAt: raw.createdAt || raw.updatedAt || new Date().toISOString(),
    };
  }

  function sortByCreatedDesc(list) {
    return list.slice().sort(function (a, b) {
      var ta = new Date(a.createdAt).getTime() || 0;
      var tb = new Date(b.createdAt).getTime() || 0;
      if (tb !== ta) return tb - ta;
      // Stable tie-break so two notifications created in the same millisecond
      // keep a deterministic order instead of flipping between renders.
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  }

  // ------------------------------------------------------------ presentation

  var TYPE_INFO = {
    order: { icon: 'fa-receipt', cls: 'order', label: 'New order' },
    cancellation: { icon: 'fa-circle-xmark', cls: 'cancellation', label: 'Cancelled' },
    status_update: { icon: 'fa-utensils', cls: 'preparation', label: 'Status update' },
    ready: { icon: 'fa-bell-concierge', cls: 'preparation', label: 'Ready' },
    promo: { icon: 'fa-tags', cls: 'promo', label: 'Promo' },
    system: { icon: 'fa-cog', cls: 'system', label: 'System' },
    stock: { icon: 'fa-triangle-exclamation', cls: 'stock', label: 'Stock' },
    // Kitchen StockAlert workflow (kitchen reports → manager badge/toast →
    // manager acknowledges/resolves → reporting staff gets the response).
    stock_alert: { icon: 'fa-triangle-exclamation', cls: 'stock', label: 'Stock alert' },
    // Delivery-domain types. Without an entry here these fell through to the
    // generic icon, which made a real delivery problem indistinguishable from
    // an ordinary system notice on the Notifications page.
    delivery_issue: { icon: 'fa-triangle-exclamation', cls: 'stock', label: 'Delivery problem' },
    delivery_otp: { icon: 'fa-key', cls: 'general', label: 'Delivery code' },
    delivery_emergency: { icon: 'fa-siren', cls: 'stock', label: 'Delivery emergency' },
    delivery_assigned: { icon: 'fa-hand-holding-hand', cls: 'order', label: 'Delivery assignment' },
    delivery_status: { icon: 'fa-truck-fast', cls: 'preparation', label: 'Delivery status' },
    // A refund the customer was waiting on has completed. Without an entry here
    // it fell through to the generic info icon, so "your money is back" looked
    // identical to an ordinary system notice.
    refund: { icon: 'fa-arrow-rotate-left', cls: 'refund', label: 'Refund processed' },
  };

  function typeInfo(type) {
    return TYPE_INFO[type] || { icon: 'fa-circle-info', cls: 'general', label: 'Notification' };
  }

  function relativeTime(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '';
    var seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 45) return t('notif_just_now', 'Just now');
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('notif_minutes_ago', '{n} min ago').replace('{n}', minutes);
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return t('notif_hours_ago', '{n} hr ago').replace('{n}', hours);
    var days = Math.floor(hours / 24);
    if (days < 7) return t('notif_days_ago', '{n} day(s) ago').replace('{n}', days);
    return date.toLocaleDateString();
  }

  function absoluteTime(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString();
  }

  /** Render one notification card. Every field required by the panel spec. */
  function renderCard(notif, options) {
    var opts = options || {};
    var info = typeInfo(notif.type);
    var readCls = notif.isRead ? '' : ' unread';
    var badgeCls = notif.isRead ? 'read' : 'unread';
    var badgeText = notif.isRead ? t('notif_read', 'Read') : t('notif_unread', 'Unread');
    var relative = relativeTime(notif.createdAt);
    var absolute = absoluteTime(notif.createdAt);

    var metaParts = [];
    if (notif.orderId) {
      metaParts.push(
        '<span class="notif-chip notif-chip-order"><i class="fa-solid fa-receipt"></i>' +
          esc(t('notif_order_id', 'Order')) +
          ' #<span class="notif-order-id">' +
          esc(notif.orderId) +
          '</span></span>'
      );
    }
    if (notif.customerName) {
      metaParts.push(
        '<span class="notif-chip notif-chip-customer"><i class="fa-solid fa-user"></i>' +
          esc(notif.customerName) +
          '</span>'
      );
    }
    metaParts.push(
      '<span class="notif-chip notif-chip-type ' + esc(info.cls) + '"><i class="fa-solid ' + esc(info.icon) + '"></i>' +
        esc(info.label) +
        '</span>'
    );

    var titleAttr = relative ? ' title="' + esc(absolute) + '"' : '';

    return (
      '<article class="notif-card' +
      readCls +
      '" data-id="' +
      esc(notif.id) +
      '" data-order-id="' +
      esc(notif.orderId || '') +
      '"' +
      titleAttr +
      (notif.isRead ? ' aria-read="true"' : ' aria-read="false"') +
      '>' +
      '<div class="notif-icon ' +
      esc(info.cls) +
      '"><i class="fa-solid ' +
      esc(info.icon) +
      '"></i></div>' +
      '<div class="notif-body">' +
      '<div class="notif-title">' +
      esc(notif.title) +
      '</div>' +
      '<div class="notif-message">' +
      esc(notif.message) +
      '</div>' +
      '<div class="notif-meta">' +
      '<span class="notif-time">' +
      esc(relative) +
      '</span>' +
      // Exact date/time is shown inline (the card title attribute repeats it as
      // a tooltip) so both the relative and the absolute time are always visible.
      '<span class="notif-time-abs">' +
      esc(absolute) +
      '</span>' +
      metaParts.join('') +
      '<span class="notif-badge ' +
      badgeCls +
      '">' +
      esc(badgeText) +
      '</span>' +
      '</div>' +
      '</div>' +
      '<button type="button" class="notif-delete" data-action="delete" title="' +
      esc(t('notif_delete', 'Delete')) +
      '" aria-label="' +
      esc(t('notif_delete', 'Delete')) +
      '"><i class="fa-solid fa-xmark"></i></button>' +
      '</article>'
    );
  }

  // ------------------------------------------------------------------ panel

  /**
   * Mount the notification panel.
   *
   * @param {Object} options
   * @param {string|Element} options.list      container for the cards
   * @param {string|Element} [options.empty]   empty-state element
   * @param {string|Element} [options.filter]   filter tab container
   * @param {string|Element} [options.badge]    unread badge element
   * @param {string|Element} [options.count]    "x unread" label element
   * @param {string}  [options.filterAttr]     value of data-filter on a tab
   * @param {boolean} [options.markViewedAsRead=false]
   *        When false (the default) opening the panel never changes read state —
   *        only clicking a single notification marks that one read. Required so
   *        acknowledging Order A can never mark Order B as handled.
   * @param {boolean} [options.realtime=true]
   * @param {number}  [options.pollMs=30000]    polling fallback interval
   * @param {function} [options.matchFilter]    (filterValue, notification) =>
   *        page-owned filter predicate; replaces the built-in all/unread/type
   *        logic when supplied.
   * @param {Object}   [options.emptyMessages]  per-filter empty-state copy, e.g.
   *        { unread: 'No unread notifications' }. Falls back to the generic copy.
   */
  function mount(options) {
    var opts = options || {};
    var listEl = typeof opts.list === 'string' ? document.getElementById(opts.list) : opts.list;
    var emptyEl = typeof opts.empty === 'string' ? document.getElementById(opts.empty) : opts.empty;
    var filterEl = typeof opts.filter === 'string' ? document.getElementById(opts.filter) : opts.filter;
    var badgeEl = typeof opts.badge === 'string' ? document.getElementById(opts.badge) : opts.badge;
    var countEl = typeof opts.count === 'string' ? document.getElementById(opts.count) : opts.count;
    var markViewedAsRead = opts.markViewedAsRead === true;

    var state = {
      items: [],
      filter: 'all',
      listEl: listEl,
      emptyEl: emptyEl,
      badgeEl: badgeEl,
      countEl: countEl,
    };

    function visible() {
      // A page may own its filter semantics (e.g. the delivery panel groups by
      // `assignment` / `deliveryStatus` rather than by raw type). When
      // `matchFilter` is supplied it fully replaces the built-in logic, so the
      // kitchen/admin behaviour below is untouched.
      if (typeof opts.matchFilter === 'function') {
        return state.items.filter(function (n) {
          try {
            return opts.matchFilter(state.filter, n);
          } catch (e) {
            return true;
          }
        });
      }
      if (state.filter === 'unread') {
        return state.items.filter(function (n) {
          return !n.isRead;
        });
      }
      // `type:<name>` narrows to a single notification type, e.g. type:order
      // (new orders) or type:cancellation (cancellations). Anything else that
      // is not 'all' is treated as a literal type name for backwards
      // compatibility with older markup.
      var filter = String(state.filter || 'all');
      if (filter.indexOf('type:') === 0) {
        var wanted = filter.slice(5);
        return state.items.filter(function (n) {
          return n.type === wanted;
        });
      }
      if (filter !== 'all') {
        return state.items.filter(function (n) {
          return n.type === filter;
        });
      }
      return state.items;
    }

    function render() {
      if (!state.listEl) return;
      var shown = visible();
      if (shown.length === 0) {
        state.listEl.innerHTML = '';
        if (state.emptyEl) {
          state.emptyEl.style.display = 'block';
          var msg = state.emptyEl.querySelector('[data-empty-message]');
          if (msg) {
            // A page can name the empty state per filter, so "Unread" says
            // "No unread notifications" instead of the vague "nothing in this
            // view" - otherwise a correctly-empty filter reads as a broken one.
            var custom =
              opts.emptyMessages && typeof opts.emptyMessages === 'object'
                ? opts.emptyMessages[state.filter]
                : null;
            if (custom) {
              msg.textContent = custom;
            } else {
              msg.textContent =
                state.items.length === 0
                  ? t('notif_none_yet', 'No notifications yet')
                  : t('notif_none_in_filter', 'No notifications in this view');
            }
          }
        }
      } else {
        if (state.emptyEl) state.emptyEl.style.display = 'none';
        state.listEl.innerHTML = shown.map(function (n) { return renderCard(n, opts); }).join('');
      }
      updateFilterCounts();
      updateCountLabels();
    }

    /** How many items the given filter would show. Uses the page's own predicate. */
    function filterCount(filter) {
      var total = 0;
      for (var i = 0; i < state.items.length; i += 1) {
        var n = state.items[i];
        try {
          if (typeof opts.matchFilter === 'function') {
            if (opts.matchFilter(filter, n)) total += 1;
          } else if (filter === 'all') {
            total += 1;
          } else if (filter === 'unread') {
            if (!n.isRead) total += 1;
          } else if (String(filter).indexOf('type:') === 0) {
            if (n.type === filter.slice(5)) total += 1;
          } else if (n.type === filter) {
            total += 1;
          }
        } catch (e) {
          /* an unmatchable notification is simply not counted */
        }
      }
      return total;
    }

    /**
     * Publish a per-tab count so a filter is provably live.
     *
     * A tab that renders nothing is indistinguishable from a tab whose click
     * handler is dead unless it says how much is behind it. The count is
     * recomputed on every render, so it always agrees with the list underneath
     * and moves the moment a socket notification arrives.
     */
    function updateFilterCounts() {
      if (!filterEl) return;
      filterEl.querySelectorAll('[data-count-for]').forEach(function (el) {
        var key = el.getAttribute('data-count-for');
        el.textContent = String(filterCount(key));
        el.setAttribute('data-empty', filterCount(key) === 0 ? '1' : '0');
      });
    }

    function updateCountLabels() {
      var unread = state.items.filter(function (n) { return !n.isRead; }).length;
      if (state.countEl) state.countEl.textContent = String(unread);
      setBadge(state.badgeEl, unread);
      // Keep every other badge on the page (sidebar + navbar bell) in sync.
      refreshBadges(unread);
    }

    async function load() {
      try {
        var data = await request('/notifications');
        var list = (data && data.notifications) || [];
        state.items = sortByCreatedDesc(
          list.map(normalize).filter(Boolean)
        );
        render();
        if (markViewedAsRead) markVisibleAsRead();
      } catch (err) {
        console.error('Failed to load notifications:', err);
        if (state.listEl) state.listEl.innerHTML = '';
        if (state.emptyEl) {
          state.emptyEl.style.display = 'block';
          var msg = state.emptyEl.querySelector('[data-empty-message]');
          if (msg) msg.textContent = t('notif_load_failed', 'Failed to load notifications.');
        }
      }
    }

    // Requirement: opening the panel marks ONLY the notifications actually
    // displayed as read — one PATCH per id, never a bulk read-all, so an
    // unrelated (or filtered-out) notification keeps its unread state and one
    // order can never acknowledge another.
    var marking = false;
    async function markVisibleAsRead() {
      if (marking) return;
      var targets = visible().filter(function (n) { return !n.isRead; });
      if (targets.length === 0) return;
      marking = true;
      try {
        for (var i = 0; i < targets.length; i += 1) {
          // Mark locally first so the row updates instantly; a failed PATCH is
          // corrected on the next load().
          targets[i].isRead = true;
        }
        render();
        for (var j = 0; j < targets.length; j += 1) {
          await markRead(targets[j].id, { silent: true });
        }
      } finally {
        marking = false;
      }
    }

    async function markRead(id, options2) {
      var quiet = options2 && options2.silent;
      // Update the stored record first, then render. Without this the only thing
      // that ever flipped `isRead` was the click handler's own bookkeeping, so a
      // caller using the exported markRead() left the row styled unread, the
      // badge stale and the "Unread" filter still showing it until the next poll.
      // Local-first also means a failed PATCH is corrected by the next load()
      // instead of leaving the UI claiming read for a notification the server
      // still considers unread.
      var target = null;
      for (var i = 0; i < state.items.length; i += 1) {
        if (state.items[i].id === id) {
          target = state.items[i];
          break;
        }
      }
      if (target && !target.isRead) {
        target.isRead = true;
        render();
      }
      try {
        await request('/notifications/' + encodeURIComponent(id) + '/read', { method: 'PATCH' });
        dispatchRefresh();
        return true;
      } catch (err) {
        if (!quiet) console.error('Failed to mark notification as read:', err);
        return false;
      }
    }

    async function remove(id) {
      try {
        await request('/notifications/' + encodeURIComponent(id), { method: 'DELETE' });
        // Remove only the clicked row — every other notification stays put.
        state.items = state.items.filter(function (n) { return n.id !== id; });
        render();
        dispatchRefresh();
        return true;
      } catch (err) {
        console.error('Failed to delete notification:', err);
        return false;
      }
    }

    async function markAllRead() {
      try {
        await request('/notifications/read-all', { method: 'PATCH' });
        state.items.forEach(function (n) { n.isRead = true; });
        render();
        dispatchRefresh();
        if (typeof opts.onToast === 'function') opts.onToast(t('notif_all_marked', 'All notifications marked as read'));
        return true;
      } catch (err) {
        console.error('Failed to mark all notifications as read:', err);
        return false;
      }
    }

    async function clearAll() {
      try {
        await request('/notifications', { method: 'DELETE' });
        state.items = [];
        render();
        dispatchRefresh();
        if (typeof opts.onToast === 'function') opts.onToast(t('notif_cleared', 'All notifications cleared'));
        return true;
      } catch (err) {
        console.error('Failed to clear notifications:', err);
        return false;
      }
    }

    /** Realtime insert — prepends unless the id is already known (dedupe). */
    function ingest(raw) {
      var notif = normalize(raw);
      if (!notif) return null;
      var existingIndex = -1;
      for (var i = 0; i < state.items.length; i += 1) {
        if (state.items[i].id === notif.id) {
          existingIndex = i;
          break;
        }
      }
      if (existingIndex !== -1) {
        // Already known (socket replay / duplicate emit): keep read state and
        // never append a second copy of the same notification.
        state.items[existingIndex] = notif;
      } else {
        state.items.unshift(notif);
      }
      state.items = sortByCreatedDesc(state.items);
      render();
      dispatchRefresh();
      return notif;
    }

    function setFilter(filter) {
      state.filter = filter;
      if (filterEl) {
        filterEl.querySelectorAll('[data-filter]').forEach(function (tab) {
          tab.classList.toggle('active', tab.getAttribute('data-filter') === filter);
        });
      }
      render();
    }

    // --- delegated event listeners (bound once; survives re-render) ---------
    if (listEl && !listEl.dataset.notifBound) {
      listEl.dataset.notifBound = '1';
      listEl.addEventListener('click', function (e) {
        var card = e.target.closest ? e.target.closest('.notif-card') : null;
        if (!card || !state.listEl.contains(card)) return;
        var id = card.getAttribute('data-id');

        if (e.target.closest('[data-action="delete"]')) {
          e.preventDefault();
          e.stopPropagation();
          remove(id);
          return;
        }

        // Clicking a notification only affects that notification.
        if (card.classList.contains('unread')) {
          var target = null;
          for (var i = 0; i < state.items.length; i += 1) {
            if (state.items[i].id === id) target = state.items[i];
          }
          if (target) {
            target.isRead = true;
            // Re-render (rather than patch the node) so the "Unread" filter and
            // the badge immediately reflect the new read state. Every other
            // notification keeps its own row and its own read state.
            render();
          }
          markRead(id, { silent: true });
        }

        openRelated(card, id);
      });
    }

    function openRelated(card, id) {
      if (typeof opts.onOpen === 'function') {
        opts.onOpen(id, card);
        return;
      }
      var orderId = card.getAttribute('data-order-id');
      if (!orderId) return;
      var target = null;
      for (var i = 0; i < state.items.length; i += 1) {
        if (state.items[i].id === id) target = state.items[i];
      }
      var link = (target && target.link) || '';
      window.location.href = link || (opts.ordersUrl || '/src/pages/kitchen/orders.html') + '?orderId=' + encodeURIComponent(orderId);
    }

    // Poll as a safety net for missed socket frames; the socket is the fast path.
    if (opts.poll !== false) {
      setInterval(load, opts.pollMs || POLL_MS);
    }

    render();
    load();
    if (opts.realtime !== false) connectRealtime(ingest);

    var api = {
      state: state,
      load: load,
      render: render,
      ingest: ingest,
      setFilter: setFilter,
      markRead: markRead,
      markAllRead: markAllRead,
      clearAll: clearAll,
      remove: remove,
      filterCount: filterCount,
      get filter() { return state.filter; },
      get items() { return state.items; },
    };
    if (opts.exposeAs) global[opts.exposeAs] = api;
    return api;
  }

  // ----------------------------------------------------------------- badges

  function setBadge(el, count) {
    if (!el) return;
    var n = Number(count) || 0;
    var isDot = el.classList.contains('badge-dot');
    el.textContent = n > 99 ? '99+' : n > 0 ? String(n) : '';
    el.style.display = n > 0 ? (isDot ? 'inline-flex' : 'inline-block') : 'none';
    el.setAttribute('data-count', String(n));
  }

  var lastKnownUnread = null;

  /** Refresh every `[data-notif-badge]` element on the page. */
  function refreshBadges(count) {
    if (typeof count === 'number') lastKnownUnread = count;
    document.querySelectorAll('[data-notif-badge]').forEach(function (el) {
      setBadge(el, lastKnownUnread || 0);
    });
  }

  function fetchUnreadCount() {
    return request('/notifications/unread')
      .then(function (data) {
        lastKnownUnread = (data && data.count) || 0;
        refreshBadges();
        return lastKnownUnread;
      })
      .catch(function () {
        return lastKnownUnread || 0;
      });
  }

  /**
   * Refresh every `[data-notif-badge]` element on the page (sidebar link +
   * navbar bell). Exposed as `window.refreshNotificationBadge` by the layouts.
   */
  function refreshBadge() {
    return fetchUnreadCount();
  }

  function dispatchRefresh() {
    fetchUnreadCount();
    try {
      global.dispatchEvent(new CustomEvent('notification:refresh'));
    } catch (e) {}
  }

  // --------------------------------------------------------------- realtime

  var sinks = [];
  var transportBound = false;
  var bridgeBound = false;
  var ownSocket = null;

  function deliver(notif) {
    if (!notif) return;
    sinks.slice().forEach(function (fn) {
      try {
        fn(notif);
      } catch (e) {}
    });
  }

  /**
   * Prefer the page's existing Socket.IO connection. A page that already owns
   * one (the kitchen dashboard, driven by js/socket.js) must NEVER get a second
   * connection from this module - that would be a competing notification
   * pipeline and would double-count every event.
   */
  function bindBridge() {
    if (bridgeBound) return true;
    var bridge = global.ScosSocketBridge;
    if (!bridge || typeof bridge.on !== 'function') return false;
    bridge.on('notification:new', deliver);
    bridgeBound = true;
    if (ownSocket) {
      // A fallback connection was opened before the bridge appeared; close it
      // so the page ends up with exactly one socket.
      try {
        ownSocket.close();
      } catch (e) {}
      ownSocket = null;
    }
    return true;
  }

  /**
   * Bind exactly one realtime transport.
   * 1. `window.ScosSocketBridge` — the shared client from js/socket.js, used
   *    when the page already owns a connection (no second socket is opened).
   *    js/socket.js is an ES module, so it can land AFTER this classic script;
   *    we therefore also listen for its `scos:socket-bridge-ready` event.
   * 2. Otherwise this module opens a single Socket.IO connection itself.
   * 3. Always also listen to the `notification:refresh` DOM event that
   *    js/socket.js dispatches, so a page that wires its own socket still
   *    feeds this module.
   */
  function ensureTransport() {
    if (transportBound) return;
    transportBound = true;

    // `socket.js` dispatches `notification:refresh` with the notification as
    // `detail` for every `notification:new` frame.
    global.addEventListener('notification:refresh', function (e) {
      var detail = e && e.detail;
      if (detail && (detail.id || detail._id)) deliver(detail);
    });

    // js/socket.js announces itself once the shared client exists.
    global.addEventListener('scos:socket-bridge-ready', function () {
      bindBridge();
    });

    if (bindBridge()) return;

    if (typeof global.io === 'undefined') return; // realtime unavailable; polling covers it
    try {
      ownSocket = global.io(global.SOCKET_URL || global.__API_BASE || apiBase().replace(/\/api\/v1$/, ''), {
        auth: { token: token() },
        transports: ['websocket', 'polling'],
      });
      ownSocket.on('notification:new', deliver);
    } catch (e) {
      ownSocket = null;
    }
  }

  /** Register a realtime listener (used by mount() and available to pages). */
  function connectRealtime(onNotification) {
    if (typeof onNotification === 'function' && sinks.indexOf(onNotification) === -1) {
      sinks.push(onNotification);
    }
    if (token()) ensureTransport();
  }

  /**
   * Run `cb` once the centre is available.
   *
   * `admin-layout.js` now loads this file asynchronously (after the shared
   * socket), so a page script that mounts the panel on DOMContentLoaded can run
   * before `window.ScosNotifications` exists. Callers use this instead of
   * giving up. Fires immediately when the centre is already present, and also
   * responds to the `scos:notification-centre:ready` event.
   */
  function whenReady(cb) {
    if (typeof cb !== 'function') return;
    if (global.ScosNotifications && global.ScosNotifications.mount) {
      cb(global.ScosNotifications);
      return;
    }
    var settled = false;
    function done() {
      if (settled) return;
      if (!global.ScosNotifications || !global.ScosNotifications.mount) return;
      settled = true;
      cb(global.ScosNotifications);
    }
    global.addEventListener('scos:notification-centre:ready', done);
    // Safety net: poll briefly in case the ready event is missed.
    var tries = 0;
    var timer = setInterval(function () {
      done();
      tries += 1;
      if (settled || tries > 60) clearInterval(timer);
    }, 100);
  }

  global.ScosNotifications = {
    whenReady: whenReady,
    mount: mount,
    request: request,
    normalize: normalize,
    renderCard: renderCard,
    typeInfo: typeInfo,
    relativeTime: relativeTime,
    absoluteTime: absoluteTime,
    sortByCreatedDesc: sortByCreatedDesc,
    setBadge: setBadge,
    refreshBadge: refreshBadge,
    refreshBadges: refreshBadges,
    fetchUnreadCount: fetchUnreadCount,
    connectRealtime: connectRealtime,
    poll: function (ms) {
      setInterval(fetchUnreadCount, ms || POLL_MS);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
