# Smart Cafeteria Ordering System — Use Cases

**Version:** 1.0
**Status:** Implemented / Verified
Companion document to `docs/SRS.md`. Each use case maps to concrete
backend/frontend surfaces of the Smart Cafeteria Ordering System.

---

## Actors

| Actor | Canonical role | Notes |
|---|---|---|
| Anonymous visitor | — | Can browse menu and order flow via customer pages |
| Customer | `customer` | Places orders, pays (Chapa), tracks status, gives feedback |
| Kitchen staff | `kitchen` | Prepares orders; accepts `kitchen_staff`/`staff`/`foodmaker` aliases |
| System admin | `admin` | All admin capabilities incl. user management & financial settings |
| Cafeteria admin | `cafeteria_admin` | Manages the cafeteria staff, menu, orders, reports |
| Manager | `manager` | Daily operations: orders, payments, menu, feedback, reports |
| Cashier | `cashier` | Takes payments, processes refunds |
| Delivery staff | `delivery` | Accepts/executes deliveries; accepts `delivery_staff`/`driver`/`rider` aliases |
| Tax authority | `tax_authority` | Government: reads VAT compliance figures only |

---

## UC-1 Login and Dashboard Redirect

**Primary actor:** any user.
**Precondition:** account exists.
**Main flow:**
1. User submits credentials on `src/pages/common/login.html`.
2. Backend validates and returns token + user (canonical role).
3. Frontend normalizes the role via `ScosRoles` and stores session keys.
4. User is redirected to the role's dashboard (`FR-1.2`).

**Postconditions:** `auth_token`, `current_user`, `userRole`, `role` in localStorage.

**Notes (bug fixes verified):** legacy roles (`cafeteria_manager`, `system_admin`,
`kitchen_staff`, `delivery_staff`) redirect correctly; `tax_authority` now lands on
`government/dashboard.html`; `manager` no longer falls through to the customer menu.

---

## UC-2 Access a Staff Dashboard

**Primary actor:** any staff member.
**Main flow:**
1. User navigates to a staff page (admin / manager / cashier / delivery / kitchen).
2. Shared guards (`admin-api.js` / `admin-layout.js` / layout auth guards) verify a
   staff role; otherwise redirect to login.
3. `admin-layout.js` renders a sidebar filtered by role (`ScosRoles.visiblePages`).

**Postcondition:** unauthorized users cannot reach staff pages.

**Notes:** manager sees Dashboard, Menu, Categories, Orders, Deliveries, Payments,
Cancellations, Feedback, Reports, Activity (no Users/Settings). Tax authority has its
own restricted dashboard.

---

## UC-3 Create a Staff User with Role Assignment

**Primary actor:** system admin / cafeteria admin.
**Main flow:**
1. Admin opens Users page and fills the form with a target role.
2. Backend `createUser` validates `canManageUser(actorRole, currentRole?, newRole)`.
3. Only system admin may assign `admin`, `cafeteria_admin`, `tax_authority`.
4. Action is audit-logged (`USER_CREATED` / `USER_ROLE_CHANGED`).

**Alternate flow:** cafeteria admin tries to create an `admin` — rejected 403.

**Postcondition:** user exists with allowed role; audit entry recorded.

---

## UC-4 Session Idle Timeout (10 minutes)

**Primary actor:** any staff member.
**Main flow:**
1. Staff member is idle for 10 minutes (backend idle guard; frontend idle timer).
2. Frontend shows a 60-second warning dialog.
3. If the user does not confirm activity, frontend logs out locally and the
   backend rejects further staff requests with `SESSION_IDLE_TIMEOUT`.
4. "Stay signed in" resets the frontend and backend idle timers.

---

## UC-5 View VAT / Tax Compliance (Government)

**Primary actor:** tax authority.
**Main flow:**
1. User logs in as `tax_authority` → redirected to `government/dashboard.html`.
2. Dashboard calls `GET /reports/tax-compliance` (aggregate figures, no PII)
   and `GET /reports/revenue`.
3. Backend authorizes only `tax_authority`, `admin`, `cafeteria_admin` for the
   compliance report and logs `TAX_REPORT_ACCESSED` for every read.

**Postcondition:** Government sees monthly VAT breakdown, taxable base, VAT collected,
transaction counts; daily revenue context; can filter by year.

**Restriction:** no order/customer PII is ever returned by these endpoints.

---

## UC-6 Change Financial / VAT Settings

**Primary actor:** system admin.
**Main flow:**
1. Admin opens Settings and edits `vat_enabled`, `vat_rate`, `vat_number`,
   `tax_authority_name`, `platform_fee_rate`, `service_fee`.
2. `updateSetting` enforces `ADMIN_ONLY_SETTING_KEYS`; other staff roles get 403.

**Alternate flow:** cafeteria_admin attempts the same change — rejected.

---

## UC-7 Acknowledge Feedback Without Replying

**Primary actor:** staff (admin/cafeteria admin/manager).
**Main flow:**
1. Staff opens a feedback item in the details modal.
2. Staff clicks "Send" leaving the reply field empty.
3. Frontend closes the modal and refreshes the list (no backend call required);
   no dead-end prompt.

**Notes:** there is no feedback-reply endpoint; reply is optional to avoid blocking.

---

## UC-8 Realtime Order Notification Chime

**Primary actor:** kitchen / delivery / admin surfaces.
**Main flow:**
1. A new order / delivery assignment / notification is pushed via Socket.io.
2. `socket.js` dispatches `scos:notify:*` DOM events.
3. `notification-sound.js` plays a chime (WebAudio), respecting the
   `scos_notify_sound` toggle and page visibility.

---

## UC-9 Regulatory Audit Trail

**Primary actor:** any user trigger; viewed by system admin.
**Main flow:**
1. Systems record audit events (login, logout, user management, payments,
   feedback, tax report access, refund) via `utils/audit.js`.
2. `GET /admin/activity-logs` lists them with the available actions list.