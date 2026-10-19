/**
 * Single source of truth for user roles, role aliases, role groups,
 * and role-assignment (privilege) rules.
 *
 * Canonical roles stored in MongoDB (User.role? enum):
  *   customer, kitchen, admin, system_admin, cafeteria_admin, manager, cashier,
  *   delivery
 *
 * Aliases are normalized to canonical values so that legacy/alternate
 * spellings (e.g. system_admin, cafeteria_manager, kitchen_staff,
 * delivery_staff) are handled consistently on the backend and frontend.
 */

const ROLES = [
  'customer',
  'kitchen',
  'admin',
  'system_admin',
  'cafeteria_admin',
  'manager',
  'cashier',
  'delivery',
];

// Legacy / alternative spellings -> canonical role
const ROLE_ALIASES = {
  customer: 'customer',
  kitchen: 'kitchen',
  foodmaker: 'kitchen',
  'kitchen staff': 'kitchen',
  kitchen_staff: 'kitchen',
  staff: 'kitchen',
  admin: 'admin',
  systemadmin: 'admin',
  'system admin': 'admin',
  system_admin: 'system_admin',
  cafeteria_admin: 'cafeteria_admin',
  'cafeteria admin': 'cafeteria_admin',
  manager: 'manager',
  'cafeteria manager': 'manager',
  cafeteria_manager: 'manager',
  cashier: 'cashier',
  delivery: 'delivery',
  delivery_staff: 'delivery',
  'delivery staff': 'delivery',
  delivery_person: 'delivery',
  'delivery person': 'delivery',
  driver: 'delivery',
  rider: 'delivery',
};

// Role values keyed for convenient access (ROLES.CUSTOMER, ROLES.ADMIN, ...)
const ROLE_VALUES = Object.fromEntries(ROLES.map((r) => [r.toUpperCase(), r]));

/**
 * Normalize an arbitrary role value/case to its canonical form.
 * Returns '' for empty input and the raw value for unrecognized roles.
 */
function normalizeRole(role) {
  const value = String(role ?? '').trim();
  if (!value) return '';
  const key = value.toLowerCase();
  if (ROLES.includes(key)) return key;
  return ROLE_ALIASES[key] || value;
}

const isAdminRole = (role) => {
  const n = normalizeRole(role);
  return n === 'admin' || n === 'system_admin';
};

// Role groups for route-gating (RBAC), single source of truth.
const SYSTEM_ADMIN_ROLES = ['admin', 'system_admin'];
const CAFETERIA_ADMIN_ROLES = ['cafeteria_admin'];
const MANAGEMENT_ROLES = ['cafeteria_admin', 'manager'];
const CASHIER_ROLES = ['cafeteria_admin', 'manager', 'cashier'];
const OPERATIONS_ROLES = ['cafeteria_admin', 'manager', 'kitchen'];
const TAX_AUTHORITY_ROLES = ['cafeteria_admin'];
const ALL_STAFF_ROLES = [
  'admin',
  'system_admin',
  'cafeteria_admin',
  'manager',
  'cashier',
  'kitchen',
  'delivery',
];

const ROLE_GROUPS = {
  SYSTEM_ADMIN: SYSTEM_ADMIN_ROLES,
  CAFETERIA_ADMIN: CAFETERIA_ADMIN_ROLES,
  MANAGEMENT: MANAGEMENT_ROLES,
  CASHIER: CASHIER_ROLES,
  OPERATIONS: OPERATIONS_ROLES,
  TAX_AUTHORITY: TAX_AUTHORITY_ROLES,
  ALL_STAFF: ALL_STAFF_ROLES,
};

const ALL_ROLES_IGNORING_ACTOR = ROLES;

// What each actor may create/assign. System Admin manages everything,
// including cafeteria admins and tax authorities. A cafeteria admin manages
// cafeteria floor staff (manager, cashier, kitchen, delivery) and customers.
// A cafeteria manager manages ONLY delivery staff: the manager owns dispatch
// (delivery.routes.js MANAGER_ROLES) and the manager dashboard's delivery
// assignment board, so hiring a rider belongs to the same responsibility. This
// stays inside the single role system - there is no second user type.
const ASSIGNMENT_MATRIX = {
  admin: ALL_ROLES_IGNORING_ACTOR,
  system_admin: ALL_ROLES_IGNORING_ACTOR,
  cafeteria_admin: ['kitchen', 'delivery', 'cashier'],
  manager: ['delivery'],
  cashier: [],
  kitchen: [],
  delivery: [],
  customer: [],
};

/**
 * Can `actorRole` assign the role `targetRole`?
 */
function canAssignRole(actorRole, targetRole) {
  const actor = normalizeRole(actorRole);
  const target = normalizeRole(targetRole);
  if (!ROLES.includes(target)) return false; // invalid/unknown target role
  return Boolean(ASSIGNMENT_MATRIX[actor] && ASSIGNMENT_MATRIX[actor].includes(target));
}

/**
 * Can `actorRole` manage a user whose current role is `currentTargetRole` and
 * (optionally) move them to `newTargetRole`?
 * - An actor may never manage a user whose role is above their own influence.
 * - A role change target must also be within the actor's assignable set.
 */
function canManageUser(actorRole, currentTargetRole, newTargetRole = null) {
  const actor = normalizeRole(actorRole);
  const current = normalizeRole(currentTargetRole);
  if (!ROLES.includes(current)) return false;
  const assignable = ASSIGNMENT_MATRIX[actor] || [];
  if (!assignable.includes(current)) return false;
  if (newTargetRole) {
    return canAssignRole(actor, newTargetRole);
  }
  return true;
}

module.exports = {
  ROLES,
  ROLE_ALIASES,
  ROLE_VALUES,
  ROLE_GROUPS,
  SYSTEM_ADMIN_ROLES,
  CAFETERIA_ADMIN_ROLES,
  MANAGEMENT_ROLES,
  CASHIER_ROLES,
  OPERATIONS_ROLES,
  TAX_AUTHORITY_ROLES,
  ALL_STAFF_ROLES,
  ASSIGNMENT_MATRIX,
  normalizeRole,
  isAdminRole,
  canAssignRole,
  canManageUser,
};
