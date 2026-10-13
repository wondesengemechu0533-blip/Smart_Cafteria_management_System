# Smart Cafeteria Ordering System — RBAC/Security Test Matrix

**Scope:** role-based access control, redirects, session policy, audit, and
government reporting implemented in this workstream.

Legend: ✅ verified | ⚠️ requires manual/live run | ➖ not applicable

---

## Backend — Route authorization

| # | Endpoint | `admin` | `cafeteria_admin` | `manager` | `cashier` | `kitchen` | `delivery` | `tax_authority` | `customer` |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `POST /api/v1/auth/login` | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| 2 | `GET /admin/dashboard` | ✅ | ✅ | ✅ | ➖ | ✅ (listed) | ➖ | ➖ | 401 |
| 3 | `GET /admin/activity-logs` | ✅ | ✅ | ✅ | ➖ | ➖ | ➖ | ⚠️ direct | 401 |
| 4 | `GET /admin/settings` | ✅ | ✅ | ❌ 403 | ❌ | ❌ | ❌ | ❌ | 401 |
| 5 | `PUT /admin/settings/:key` (finance) | ✅ | ❌ 403 | ❌ | ❌ | ❌ | ❌ | ❌ | 401 |
| 6 | `GET /users` | ✅ | ✅ | ❌ 403 | ❌ | ❌ | ❌ | ❌ | 401 |
| 7 | `POST /users` create `admin` | ✅ | ❌ 403 | ❌ | ❌ | ❌ | ❌ | ❌ | 401 |
| 8 | `POST /users` create `cashier` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | 401 |
| 9 | `GET /reports/tax-compliance` | ✅ | ✅ | ❌ 403 | ❌ | ❌ | ❌ | ✅ | 401 |
| 10 | `GET /reports/revenue` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | 401 |
| 11 | `PATCH /cancellations/:id/approve` | ✅ | ❌ 403 | ❌ | ❌ | ❌ | ❌ | ❌ | 401 |
| 12 | `GET /kitchen/reports/stats/detailed` | ✅ | ✅ | ✅ | ➖ | ✅ | ➖ | ❌ | 401 |
| 13 | Staff request after 10-min idle | 401 `SESSION_IDLE_TIMEOUT` (staff roles) | | | | | | | 401 (auth) |

### Privilege matrix — who may assign which role (create/assign)

| Actor \\ Target role | `admin` | `cafeteria_admin` | `tax_authority` | `manager` | `cashier`/`kitchen`/`delivery`/`customer` |
|---|---|---|---|---|---|
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cafeteria_admin` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `manager` & below | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## Frontend — pages & redirects

| # | Surface | Behavior | Status |
|---|---|---|---|
| 14 | Login as `manager` | lands on `manager/dashboard.html` (previously fell to customer menu) | ✅ code, ⚠️ live |
| 15 | Login as `tax_authority` | lands on `government/dashboard.html` (previously 404 `tax/dashboard.html`) | ✅ code, ⚠️ live |
| 16 | Login as kitchen/delivery/cashier/cafeteria_admin | unchanged landing | ✅ |
| 17 | `admin-api.js` guard | accepts ALL staff roles (was ADMIN-only) | ✅ code |
| 18 | `manager/dashboard.html` | loads `manager-dashboard.js` (was 404) + metrics/recent orders | ✅ code, ⚠️ live |
| 19 | `admin-layout.js` sidebar | role-filtered; manager hides Users/Settings; links resolve `../admin/` on manager page | ✅ code |
| 20 | Government dashboard | VAT cards + monthly/daily tables + year filter + guard | ✅ code, ⚠️ live |
| 21 | Session idle timeout | 10-min idle → 60s warning → auto-logout (staff pages) | ✅ code |
| 22 | Notification sound | chime on order/delivery/notification events + toggle | ✅ code |
| 23 | Feedback reply | optional (no dead-end) | ✅ code |

---

## Security — checks

| # | Check | Result |
|---|---|---|
| 24 | `.env` contains real Atlas credentials + Chapa test keys | gitignored; rotation recommended (report §N) |
| 25 | `.env.example` documents `SESSION_IDLE_TIMEOUT_MINUTES` + JWT expiry | ✅ |
| 26 | No secrets shipped to a non-ignored path | ✅ |
| 27 | Audit logged for REGISTRATION, LOGIN (all), LOGOUT, payments, feedback, tax report access | ✅ code |

---

## Runbook — required manual verification

1. Seed one user per role; log each in from `common/login.html`; confirm the
   landing dashboard matches §2.2 of SRS.
2. As `manager`, open sidebar; Users & Settings must be hidden; Dashboard,
   Orders, Payments, Reports must load data.
3. As `tax_authority`, open `government/dashboard.html`; verify VAT cards and
   tables populate; verify a `TAX_REPORT_ACCESSED` audit line is created.
4. Confirm 403 on `PUT /admin/settings/vat_rate` for cafeteria_admin.
5. Confirm 403 create-admin attempt by cafeteria_admin.
6. Idle a staff page for 10 minutes (or temporarily set
   `SESSION_IDLE_TIMEOUT_MINUTES=1`) → warning dialog → forced logout → backend
   returns `SESSION_IDLE_TIMEOUT` on further staff calls.
7. Place an order (kitchen) and a delivery assignment → chime with toggle off/on.