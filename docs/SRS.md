# Smart Cafeteria Ordering System — Software Requirements Specification (SRS)

**Version:** 1.0
**Status:** Implemented / Verified
**Scope:** Role-Based Access Control, Audit Logging, Security, Tax/VAT reporting, session management.

---

## 1. Introduction

### 1.1 Purpose
This document specifies the functional and non-functional requirements for the
RBAC, audit, security, and reporting layer of the Smart Cafeteria Ordering
System (SCOS). It is the normative reference for the roles, permissions,
session policy, and government-facing tax surface implemented in the system.

### 1.2 Scope
- Role model and centralized role normalization (backend + frontend).
- Authentication redirection and staff session policy (10-minute inactivity timeout).
- Privilege enforcement on user management (who can create/assign which roles).
- Audit trail of consequential actions.
- VAT / tax separation and the government (tax authority) dashboard.
- Financial settings restricted to system admins only.
- Deliverables: `docs/SRS.md`, `docs/use-cases.md`, test matrix, implementation report.

### 1.3 Definitions
- **Canonical role** – one of: `customer`, `kitchen`, `admin`, `cafeteria_admin`,
  `manager`, `cashier`, `delivery`, `tax_authority`.
- **Legacy alias** – role spellings kept for backward compatibility (e.g.
  `system_admin`, `cafeteria_manager`, `kitchen_staff`, `delivery_staff`, `foodmaker`),
  normalized to the canonical role.
- **Staff** – any of `admin`, `cafeteria_admin`, `manager`, `cashier`, `kitchen`,
  `delivery`, `tax_authority`.
- **System admin** – canonical `admin`.

---

## 2. Overall Description

### 2.1 Product Perspective
SCOS is a web cafeteria ordering platform (Node.js/Express + MongoDB backend,
vanilla JS frontend, Socket.io real-time). This feature set layers security and
reporting on the existing architecture without any rebuild.

### 2.2 Roles

| Canonical role | Legacy aliases accepted | Home dashboard |
|---|---|---|
| `customer` | — | `src/pages/customer/menu.html` |
| `kitchen` | `kitchen_staff`, `staff`, `foodmaker` | `src/pages/kitchen/dashboard.html` |
| `admin` | `system_admin`, `system admin`, `systemadmin` | `src/pages/admin/dashboard.html` |
| `cafeteria_admin` | `cafeteria admin` | `src/pages/admin/admin-dashboard.html` |
| `manager` | `cafeteria_manager`, `cafeteria manager` | `src/pages/manager/dashboard.html` |
| `cashier` | — | `src/pages/cashier/dashboard.html` |
| `delivery` | `delivery_staff`, `delivery staff`, `driver`, `rider` | `src/pages/delivery/history.html` |
| `tax_authority` | `government`, `tax authority`, `government authority` | `src/pages/government/dashboard.html` |

---

## 3. Functional Requirements

### FR-1 Authentication & Redirects
- **FR-1.1** A successful login stores the canonical role in `current_user.role`
  (lowercase) and a legacy upper-case session key (`userRole`, `role`).
- **FR-1.2** Every role is redirected to its correct dashboard after login
  (see role table). Legacy roles must resolve correctly (bug fix: `cafeteria_manager`
  previously fell through to the customer redirect; `tax_authority` pointed at a
  non-existent page).
- **FR-1.3** Non-staff or unauthenticated sessions are redirected to the login page
  on staff surfaces; only staff roles pass the shared auth guard.

### FR-2 Frontend Role Helpers (REQ)
- **FR-2.1** A single shared module (`Frontend/src/js/roles.js`, `window.ScosRoles`)
  provides `normalizeRole`, `getCurrentRole`, `isStaff`, `dashboardForRole`,
  `visiblePages`.
- **FR-2.2** `admin-api.js` and `admin-layout.js` automatically include the role
  helpers and guard staff pages for **all** staff roles (bug fix: previously only
  `ADMIN`/`admin` passed, locking out manager, cafeteria_admin and tax_authority).

### FR-3 Privileged User Management
- **FR-3.1** Only the system `admin` may create/assign the `admin`,
  `cafeteria_admin` and `tax_authority` roles.
- **FR-3.2** `cafeteria_admin` may manage `manager`, `cashier`, `kitchen`,
  `delivery`, `customer`.
- **FR-3.3** `manager` and every lower role cannot create/manage users
  (`Backend/src/routes/user.routes.js` already restricts to admin + cafeteria_admin).
- **FR-3.4** Users may edit their own profile; no user can elevate a role they
  are not allowed to assign; the last system admin cannot be demoted/deleted;
  an admin cannot self-demote.
- **FR-3.5** All consequences (create, update, role change, delete, status change,
  reset password) are audit-logged.

### FR-4 Session Timeout (10 minutes)
- **FR-4.1** Backend: staff requests are rejected with `401 { code: "SESSION_IDLE_TIMEOUT" }`
  after an idle period (default 10 minutes) enforced by
  `Backend/src/middleware/idleSession.middleware.js` for all staff roles.
- **FR-4.2** The timeout source is the configurable setting
  `session_timeout_minutes` (default 10; legacy stored `60` migrated once to 10)
  plus `SESSION_IDLE_TIMEOUT_MINUTES` env override.
- **FR-4.3** Frontend (`Frontend/src/js/session-timeout.js`):
  - idle timer of 10 minutes on staff pages;
  - 60-second warning dialog before forced logout;
  - "Stay signed in" resets the timer;
  - logout calls the backend `/api/v1/auth/logout`, clears all session keys.

### FR-5 Audit Trail
- **FR-5.1** The following are recorded via the centralized audit utility
  (`Backend/src/utils/audit.js` → `ActivityLog`):
  - `REGISTRATION`, `LOGIN` (all roles), `LOGIN_FAILED`, `LOGOUT`;
  - `USER_CREATED`, `USER_UPDATED`, `USER_ROLE_CHANGED`, `USER_STATUS_CHANGED`,
    `USER_PASSWORD_RESET`, `USER_DELETED`;
  - `PAYMENT_CREATED`, `PAYMENT_VERIFIED`, `PAYMENT_FAILED`, `PAYMENT_REFUND_INITIATED`;
  - `FEEDBACK_SUBMITTED`;
  - `TAX_REPORT_ACCESSED` (every government compliance report read).
- **FR-5.2** `availableActions` (admin settings) reflects the full action list.

### FR-6 Government / Tax Authority Surface
- **FR-6.1** Endpoints
  - `GET /api/v1/reports/tax-compliance` — aggregate VAT figures only (no PII);
    authorized: `tax_authority`, `admin`, `cafeteria_admin`; audit-logged.
  - `GET /api/v1/reports/revenue` — gross/VAT/net income; authorized:
    `admin`, `cafeteria_admin`, `manager`, `cashier`, `tax_authority`.
- **FR-6.2** Dashboard `src/pages/government/dashboard.html` shows gross sales,
  VAT collected, taxable base, paid transactions, monthly VAT breakdown and
  daily revenue/VAT, with a year filter.

### FR-7 Financial Settings Admin-Only
- **FR-7.1** `vat_enabled`, `vat_rate`, `vat_number`, `tax_authority_name`,
  `platform_fee_rate` can only be changed by the system `admin`.

### FR-8 Feedback
- **FR-8.1** Replying to feedback is optional (bug fix: a mandatory reply field
  previously dead-ended staff because no reply endpoint exists). Staff may
  acknowledge/dismiss feedback without entering text.

### FR-9 Notifications / Sound
- **FR-9.1** `Frontend/src/js/notification-sound.js` plays a short chime on
  `order:new`, `delivery:new`, `delivery:assigned` and `notification:new`
  (WebAudio, respects `scos_notify_sound` toggle, no autoplay errors).

### FR-10 Role Responsibilities (Cafeteria Manager vs System Admin)
The permission matrix below is enforced on the BACKEND
(`Backend/src/config/setting-permissions.js` → `admin.controller.js`
`updateSetting`); the frontend only mirrors it so it never offers a control
that is guaranteed to be refused. An unauthorized write answers **403**, an
invalid value answers **400**.

| Setting | Cafeteria Manager | System Admin |
|---|---|---|
| Personal profile | own account only | own account only |
| Password & 2FA | own account only (current password verified) | own account only |
| Cafeteria opening hours | manage | configure / override |
| Delivery fee | manage **if authorized** | configure / override |
| Service fee | manage **if authorized** | configure / override |
| Menu, inventory & stock operations | manage | system-wide oversight |
| Currency & global order limits | restricted (403) | manage |
| Notification preferences | own preferences only | own preferences only |
| System-wide security & access | restricted (403) | manage |

- **FR-10.1** Delivery fee and service fee remain **separate** settings
  (`delivery_fee`, `service_fee`); neither is derived from the other and each
  is stored in exactly one `Setting` record.
- **FR-10.2** A Cafeteria Manager may change the fees only while
  `manager_fee_management_enabled` is on. The System Admin owns that switch
  (`Platform Permissions` card in Settings); a manager may never change it.
- **FR-10.3** Fees are validated as finite, non-negative numbers.
- **FR-10.4** Order money is computed on the backend
  (`services/finance.service.js`) and **snapshotted** onto the order
  (`serviceFee`, `deliveryFee`, `vatRate`, `vatAmount`); changing the settings
  afterwards never rewrites an existing order, its invoice or its payment.
- **FR-10.5** 2FA and the notification preferences are **per user**
  (`User.twoFactorEnabled`, `User.notificationPreferences`). The global
  `two_factor_enabled` setting is the System Admin's *policy* (2FA required),
  never another account's personal state.
- **FR-10.6** `GET /api/v1/admin/settings` returns the caller's permission map
  (`permissions.editable` / `permissions.restricted`) so the UI can grey out
  restricted fields instead of failing at submit time.

---

## 4. Non-Functional Requirements

| ID | Requirement | Verification |
|---|---|---|
| NFR-1 | **Performance** – role-guard middleware adds O(1) work; idle map bounded to 5,000 entries with 2×-timeout purge; reports aggregate in one pass. | Load test / code review |
| NFR-2 | **Security** – no secrets committed; live Atlas credentials & Chapa test keys remain in `.env` (gitignored); recommendation to rotate. | `git check-ignore`, secret scan |
| NFR-3 | **Backward compatibility** – DB stores canonical roles; alias normalization keeps legacy values working. | migration + login tests |
| NFR-4 | **Reliability** – backend timeout independent of frontend; idle guard re-reads setting every 60s. | operator test |
| NFR-5 | **Accessibility / UX** – dark theme, translated labels, responsive sidebar retained on all surfaces. | visual check |

---

## 5. Assumptions & Constraints
- MongoDB replica/DNS used for production DB always (no local-only fallback)
  per project setting `MONGODB_URI`.
- Chapa is the only payment gateway integrated (test keys in `.env.example`).
- Frontend and backend may run on different ports in development (config.js
  resolves API base accordingly).

## 6. Out of Scope
- Real-time position tracking of delivery riders (only status notifications).
- Customer registration via Chapa (Chapa is payment only).
- Multi-tenancy beyond the single cafeteria.