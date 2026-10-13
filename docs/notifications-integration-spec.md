# Notifications — End-to-End Integration Specification

**System:** Smart Cafeteria Ordering System
**Scope:** Cross-role notifications (Customer, Cafeteria Staff, Admin)
**Status:** Implementation plan / integration spec
**Last verified against codebase:** Backend `src/`, Frontend `src/`

---

## 1. Overview & Architecture

Notifications are delivered across all three roles using a **persist-first + real-time fan-out** pattern:

1. **Persist (source of truth):** Every notification is written to the MongoDB `notifications` collection. This guarantees delivery to users who are offline when the event occurs (they see it on next fetch).
2. **Fan-out (real-time):** After persisting, the backend emits a Socket.IO event to the specific target room so online users receive it instantly without polling.
3. **Fallback (polling):** Pages that do not (or cannot) keep a live socket connection poll the REST API on an interval.

Three transport layers work together:

| Layer | Mechanism | Closest to real-time |
|-------|-----------|----------------------|
| REST (fetch) | `GET /api/v1/notifications` | On page load, on interval |
| Socket.IO | `notification:new` event | Push, sub-second |
| Reconnect poll | 30s interval fetch (kitchen) | Drift tolerance |

---

## 2. Roles & Event Ownership

| Role | Represents | Primary events they receive | Primary events they trigger |
|------|-----------|-----------------------------|------------------------------|
| **Customer** (`customer`) | End user placing/collecting orders | Order accepted, preparing, ready, served, rejected; feedback reply; promo | Place order, request cancellation, submit feedback |
| **Cafeteria Staff** (`kitchen`) | Kitchen accepting/preparing/serving | `order:new` (new paid order), `order:status` (broadcast), stock/item alerts | Accept, mark ready, mark served, reject, stock changes |
| **Admin** (`admin`) | Operations/management | New feedback, stock alerts, order/dashboard signals | Respond to feedback, update/cancel orders, dispatch promos |

> Roles are enforced at the model level in `Backend/src/models/User.js` via the `role` enum: `["customer", "kitchen", "admin"]`. Socket room membership is derived from the decoded JWT `role` claim (`Backend/src/socket/index.js`).

---

## 3. Database Model — Notification Log

**File:** `Backend/src/models/Notification.js`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | `ObjectId` ref `User` | ✅ | Recipient. Enables per-user querying and per-user Socket.IO rooms. |
| `title` | `String` | ✅ | Short heading (e.g. "Order Ready!") |
| `message` | `String` | ✅ | Body text. Localized where the caller supplies localized strings. |
| `type` | `String` enum | default `system` | `order`, `promo`, `system`, `status_update`, `ready` |
| `orderId` | `String` | default `null` | Order number link, used to deep-link to order tracking. |
| `link` | `String` | default `null` | Client route to open on click (e.g. `/src/pages/customer/order-tracking.html?orderId=...`). |
| `isRead` | `Boolean` | default `false` | Read-state flag. |
| `readAt` | `Date` | default `null` | When it was marked read. |
| `createdAt` / `updatedAt` | `Date` | auto | Timestamps (schema `timestamps: true`). |

**Model methods / helpers:**
- Instance method `markAsRead()` — sets `isRead = true`, `readAt = new Date()`, returns saved doc.
- Convenience methods in `notification.service.js`: `markNotificationAsRead`, `markAllNotificationsAsRead`, `getUserNotifications`, `sendNotification`.

**Indexes (recommended):** compound `{ userId: 1, isRead: 1, createdAt: -1 }` for inbox + unread-count queries.

**Type mapping used by the frontend renderer:**

| `type` value | Icon | Icon class |
|--------------|------|-----------|
| `order` / `status_update` / `ready` | `fa-utensils` | `icon-order` |
| `promo` | `fa-tags` | `icon-promo` |
| `system` (default) | `fa-bell` | `icon-system` |

---

## 4. Backend API Endpoints (Node.js / Express)

**Mount point:** `app.use('/api/v1/notifications', notificationRoutes)` in `Backend/server.js`.
**Base path:** `/api/v1/notifications`
**Auth:** all routes gated by `protect` middleware (`router.use(protect)` in `notification.routes.js`); every controller filters by `req.user.id`, so a user can only ever see/manipulate their own rows.

| Method | Path | Auth | Purpose | Request / Query | Success Response |
|--------|------|------|---------|-----------------|------------------|
| GET | `/api/v1/notifications` | Private | List current user's notifications | `?unread=true` optional filter | `{ success, count, notifications: [...] }` |
| GET | `/api/v1/notifications/unread` | Private | Unread count (badge) | — | `{ success, count }` |
| PATCH | `/api/v1/notifications/read-all` | Private | Mark all unread as read | — | `{ success, message, count }` |
| PATCH | `/api/v1/notifications/:id/read` | Private | Mark one as read | — | `{ success, message }` |
| DELETE | `/api/v1/notifications/:id` | Private | Delete one | — | `{ success, message }` |

**Note on the two service/controller implementations:** The controller (`notification.controller.js`) is the mounted, production route and uses `HTTP_STATUS`/`MESSAGES` from `config/constants` plus a `getTimeAgo()` serializer. There is also a separate `notification.service.js` (ESM) with equivalent helpers. **Do not dual-write** — standardize on the controller for HTTP and use the service only for reusable off-HTTP helpers.

### GET /api/v1/notifications — response item
```json
{
  "id": "65f...",
  "title": "Order Ready!",
  "message": "Your order #ORD-123 is ready for pickup.",
  "type": "ready",
  "orderId": "ORD-123",
  "link": "/src/pages/customer/order-tracking.html?orderId=ORD-123",
  "isRead": false,
  "createdAt": "2026-09-03T08:00:00.000Z",
  "timeAgo": "Just now"
}
```

---

## 5. Socket.IO Real-Time Layer

### 5.1 Server setup — `Backend/src/socket/index.js`
- `setupSocketIO(io)` attaches a JWT middleware that decodes `socket.handshake.auth.token` into `socket.user` (with `id` and `role`).
- On connection it auto-joins role rooms:
  - `['kitchen','KITCHEN_STAFF','STAFF','ADMIN']` → room `'kitchen'`
  - `['admin','ADMIN']` → room `'admin'`
- Registers `registerOrderHandlers` and `registerNotificationHandlers`.

### 5.2 Notification room wiring — `Backend/src/socket/notification.socket.js`
- Each authenticated socket auto-joins **`user:<id>`** (their private room).
- This is the room the backend targets when fanning out a notification to one specific user.

### 5.3 Emit helper — `Backend/src/utils/socket.js`
- `emitSocketEvent(room | null, eventName, payload)` → `io.to(room).emit(...)` or `io.emit(...)`.
- Safely no-ops with a warning if Socket.IO is not initialized (so notification creation is never fatal).

### 5.4 Order room handlers — `Backend/src/socket/order.socket.js`
- `join:kitchen`, `join:admin`, `order:join <orderId>` → join `order:<orderId>`, `order:leave <orderId>`.

### 5.5 Server event contract (emitted events)

| Event name | Target room | Emitted from | Payload |
|------------|-------------|--------------|---------|
| `order:new` | `'kitchen'` | `order-queue.service.js` (payment confirmed — see §6.1) | `orderSummary` |
| `order:created` | `order:<id>` | `order.controller.js` | `orderSummary` |
| `order:status` | `'kitchen'` + `order:<id>` | `kitchen.controller.js`, `order.controller.js` | `orderSummary` |
| `order:payment` | `'kitchen'` + `order:<id>` | `order-queue.service.js` (payment confirmed) | `orderSummary` |
| `order:delayed` | `order:<id>` | `kitchen.controller.js` | — |
| `item:status:updated` | `order:<id>` | `kitchen.controller.js` | — |
| `item:unavailable` | `'kitchen'` | `kitchen.controller.js` | — |
| `stock:alert` | `'admin'` | `kitchen.controller.js` | — |
| `feedback:new` | `'admin'` | `feedback.controller.js` | feedback |
| **`notification:new`** | **`user:<userId>`** | kitchen/order/feedback controllers | notification (see §5.6) |

### 5.6 `notification:new` payload (the notification bell / toast contract)
```json
{
  "id": "65f...",
  "title": "Order Ready!",
  "message": "Your order #ORD-123 is ready for pickup.",
  "type": "ready",
  "orderId": "ORD-123",
  "link": "/src/pages/customer/order-tracking.html?orderId=ORD-123",
  "isRead": false,
  "createdAt": "2026-09-03T08:00:00.000Z"
}
```

---

## 6. Complete Event-Trigger Lifecycle (per role)

Pattern used across the codebase (see `kitchen.controller.js` accept/ready/serve, `order.controller.js`, `feedback.controller.js`):
1. Mutate domain state (order status, feedback reply).
2. **Persist** the notification via `Notification.create({ userId, title, message, type, orderId, link, isRead:false })`.
3. Emit `order:*` events to kitchen/order rooms for UI refresh.
4. **Emit `notification:new`** to `user:<userId>` for the recipient's real-time toast/badge.
5. Return HTTP response. Offline users receive the row on next `GET /notifications`.

### 6.1 Customer lifecycle — from placing to collecting an order

| # | Trigger (actor/event) | Controller action | Notification persisted (customer) | Socket emitted |
|---|----------------------|-------------------|-----------------------------------|----------------|
| 1 | Customer places order | `order.controller.js` `createOrder` | (implicit confirmation — order record) | `order:created` → `order:<id>` |
| 2 | **Payment successful** → order = PENDING, enters the kitchen queue | `order-queue.service.js` `releaseOrderToKitchen` (Chapa verify/callback, `payments/simulate`, cashier `mark-paid`) | durable `order` notification to kitchen + management (`kitchen:new:<id>`) | `order:new` → kitchen, `order:payment` → kitchen & `order:<id>` |
| 3 | Kitchen accepts → `preparing` | `kitchen.controller.js` `acceptOrder` | `status_update` "Order Accepted!… estimated time" + link | `order:status` → kitchen & order room; `notification:new` → `user:<id>` |
| 4 | Kitchen marks **ready** | `kitchen.controller.js` `markOrderReady` | `ready` "Order Ready for pickup" + link | `order:status`; `notification:new` → `user:<id>` |
| 5 | Kitchen marks **served** | `kitchen.controller.js` `markOrderServed` | `status_update` "Order Served" | `order:status`; `notification:new` → `user:<id>` |
| 6 | Kitchen **rejects** | `kitchen.controller.js` `rejectOrder` | `system` "Order Rejected" | `order:status` |
| 7 | Admin updates status (alt path) | `admin.order.controller.js` update status | `status_update` (READY etc.) — best-effort | (order rooms) |
| 8 | Admin replies to feedback | `feedback.controller.js` reply | `system` "Reply to your feedback" | `notification:new` → `user:<id>` |

> The kitchen board, its orders list and its stats filter on `paymentStatus: 'PAID'`, and `kitchen.acceptOrder` rejects an unpaid order with `409 PAYMENT_REQUIRED`. An unpaid order is therefore invisible to the kitchen — and its cancellation is not broadcast to the kitchen room — until a payment confirms it.

> Admin update path (`admin.order.controller.js:364`) creates a notification but currently does **not** emit `notification:new`. If real-time is desired for admin-driven status changes, mirror the socket emit used in `updateOrderStatus`.

### 6.2 Kitchen (Cafeteria Staff) lifecycle

| # | Trigger | Notification / signal | Channel |
|---|---------|----------------------|---------|
| 1 | New paid order placed | `order:new` arrives in kitchen room | Socket push (`order:new`), plus 30s poll fallback |
| 2 | Order status changes (any accepted/ready/served) | `order:status` broadcast to kitchen room | Socket push |
| 3 | Item becomes unavailable / stock low | `item:unavailable` (kitchen), `stock:alert` (admin) | Socket push |
| 4 | Kitchen Notification Center | `GET /api/v1/notifications` + `GET .../unread` for badge | REST (kitchen `notifications.js` polls every 30s) |

Kitchen's own notification inbox uses the **same** `/api/v1/notifications` endpoints scoped by `req.user.id` (a kitchen user's `userId`), but the **renderer** (`pages/kitchen/notifications.js`) maps its own extended `type` set: `order`, `preparation`, `stock`, `system`.

### 6.3 Admin lifecycle

| # | Trigger | Notification / signal | Channel |
|---|---------|----------------------|---------|
| 1 | New customer feedback submitted | `feedback:new` → admin room | Socket push |
| 2 | Stock alert generated | `stock:alert` → admin room | Socket push |
| 3 | Admin Notification Center | `GET /api/v1/notifications` + unread count | REST |

---

## 7. Frontend Integration

### 7.1 API client — `Frontend/src/services/notification.service.js`
Wraps the REST endpoints via `api`:
- `getAll()`, `getUnread()`, `getUnreadCount()`, `markAsRead(id)`, `markAllAsRead()`, `delete(id)`.

### 7.2 Shared Socket client — `Frontend/src/js/socket.js`
Class `SocketClient`:
- `connect(token)` — connects with `auth:{token}`, `transports:['websocket','polling']`, auto-`join:kitchen` for staff, re-applies pending `order:join`s, and **re-broadcasts `notification:new`** to internal listeners.
- `joinOrderRoom(orderId)` / `leaveOrderRoom(orderId)`.
- `on(event, cb)` / `off(...)` for consumers.

> **Important:** the previous header "unified-header.js" injected a bell element. That has been removed per the header cleanup task; badge updates rely on an element with id `notification-badge`, `.notification-badge`, or `notifBadge` (see `customer-realtime.js` `updateBadge()`).

### 7.3 Customer real-time — `Frontend/src/js/customer-realtime.js`
Loaded on customer pages (module script). Flow:
1. Refuse to run if no token or role !== `customer`.
2. Ensure Socket.IO is loaded (dynamically inject `socket.io-4.7.5.min.js` if absent), then `socketClient.connect(token)`.
3. On `notification:new`:
   - `showToast(notification)` — fixed top-right toast, green left-border when `type === 'ready'`.
   - `updateBadge()` — fetch `GET /notifications/unread`, update badge element.
   - dispatch `window` `CustomerEvent('customer:notification', {detail})`.
   - if on the notifications page, dispatch `notification:refresh`.
4. Initial `updateBadge()` on load.
5. Offline recovery: because the row is persisted, the badge/inbox is correct after the next REST fetch.

### 7.4 Customer Notification Center — `Frontend/src/pages/customer/notifications.html` + `src/js/notification.js`
- Fetch `GET /api/v1/notifications` (Bearer token from `localStorage.auth_token`).
- Render list; `unread` class when `!isRead`; icon per type (§3).
- Click item → `PATCH /:id/read` then re-render.
- Delete button → `DELETE /:id` then re-render.
- "Mark All as Read" → `PATCH /read-all`; "Clear All" falls back to mark-all-as-read (backend has no bulk delete).
- Real-time: `socket.on('notification:new', () => renderNotifications())` refreshes the list.

### 7.5 Kitchen Notification Center — `Frontend/src/pages/kitchen/notifications.js`
- Import `api`, fetch `/notifications` + `/notifications/unread`.
- Render with type→icon map (`order`/`preparation`/`stock`/`system`), read/unread badges, delete, mark-one-read, mark-all-read, filter tabs.
- **Polling fallback:** `setInterval(() => { fetchNotifications(); updateBadge(); }, 30000)`.

### 7.6 Order-tracking page
- `order-tracking.html` uses `socketClient.joinOrderRoom(orderId)` and listens for `order:status`/`notification:new` to update progress without refresh.

---

## 8. Recommended Polling vs WebSocket decision table

| Page | WebSocket | Poll interval | Rationale |
|------|-----------|---------------|-----------|
| Customer menu, cart, checkout | ✅ (customer-realtime) | — | Push for order-ready toasts |
| Customer order-tracking | ✅ (order room join) | — | Live progress steps |
| Customer notifications | ✅ (`notification:new` re-render) | on load | Push re-render |
| Kitchen dashboard/orders | ✅ (kitchen room) | — | Live new-order tickets |
| Kitchen notifications | — | 30s | Simpler, low-rate alerts, matches existing code |
| Admin dashboard | ✅ (admin room) | — | Live feedback/stock alerts |

---

## 9. Sequence Diagram (happy path — order ready)

```
Customer            Kitchen             Server (Express)          Socket.IO              DB (Mongo)
   |                   |                      |                       |                      |
   |  place order      |                      |                       |                      |
   |------------------>|  POST /api/v1/orders |                       |                      |
   |                   |                      |-- order:new --------> kitchen room           |
   |                   |                      |-- order:created -----> order:<id>            |
   |                   |   PATCH /accept      |                       |                      |
   |                   |--------------------->|  create Notification --|----> insert         |
   |                   |                      |-- order:status ------> kitchen               |
   |                   |                      |-- order:status ------> order:<id>            |
   |                   |                      |-- notification:new --> user:<customer>       |
   |                   |                      |                       |                      |
   |  <--- toast + badge (real-time)          |                       |                      |
   |                   |   PATCH /ready       |                       |                      |
   |                   |--------------------->|  create Notification --|----> insert         |
   |                   |                      |-- notification:new --> user:<customer>  (🔔 Order Ready!) |
```

---

## 10. Security & Best Practices

- **Authorization:** every notification endpoint filters by `req.user.id`; a user cannot read/mark/delete another user's notifications (verified in controller queries `{ _id, userId: req.user.id }`).
- **Socket auth:** token verified via JWT; rooms are per-user/per-role so clients cannot join arbitrary user rooms from the browser.
- **Best-effort guarantees:** notification writes are wrapped so a slow/failed socket emit never fails the primary request; persist-first ensures offline delivery.
- **Escaping:** frontend renderers escape message/title HTML (`escapeHtml`) before interpolation to prevent XSS via stored messages.
- **Do not double-import the model path:** `Notification` is required in both `controller` and `service`; keep one source file (model) shared across both.
- **Localization:** `title`/`message` are stored as authored. For bilingual UI, store a language key or per-language fields rather than a single localized string, and render via `i18n.js` (`applyTranslations`).

---

## 11. Implementation Checklist

- [ ] Persist notifications for: order accepted, preparing, ready, served, rejected; admin status change; feedback reply; promo broadcast.
- [ ] Emit `notification:new` to `user:<id>` for **every** persisted per-user notification (add the missing emit in `admin.order.controller.js`).
- [ ] Keep REST endpoints `/api/v1/notifications` (+ `/unread`, `/read-all`, `/:id/read`, `/:id`) as the offline/fallback path.
- [ ] Mount `customer-realtime.js` on all customer pages that should show toasts/badges.
- [ ] Maintain the kitchen 30s poll fallback; consider socket only if push latency matters.
- [ ] Verify unread badge element availability after header cleanup (id `notification-badge` / `.notification-badge` / `notifBadge`).
- [ ] Add compound index `{ userId:1, isRead:1, createdAt:-1 }`.
- [ ] Standardize `type` enum across kitchen renderer map and customer renderer map.
