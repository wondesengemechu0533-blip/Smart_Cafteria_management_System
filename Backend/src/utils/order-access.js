/**
 * Order Access - one definition of "who may see / act on this order".
 *
 * WHY THIS EXISTS: the read rule and the cancel rule were written twice and
 * drifted. `GET /orders/:id` let the owner, the assigned courier or management
 * through, while `POST /cancellations/request` only recognised the owner or a
 * literal `admin`/`system_admin`. A cafeteria manager or the assigned courier
 * could therefore open the cancellation page, be shown the "Confirm
 * Cancellation" button, click it, and be refused with "You can only cancel your
 * own orders" - a message that is not merely unhelpful, it is false: they were
 * not trying to cancel *their own* order, they were legitimately acting on
 * somebody else's.
 *
 * Both rules now come from here, so a future role change cannot put them out of
 * step again.
 */

const { normalizeRole, SYSTEM_ADMIN_ROLES, CAFETERIA_ADMIN_ROLES } = require('../config/roles');

/**
 * Roles that may cancel ANY order.
 *
 * This is exactly the audience of the staff-side cancel route
 * (`POST /api/v1/admin/orders/:id/cancel`, see routes/admin.order.routes.js):
 * admin, cafeteria_admin, manager, kitchen (+ the system_admin role group).
 * Those roles already had a legitimate way to cancel a customer's order; the
 * customer-facing cancellation endpoint simply did not know about it, which is
 * what produced "You can only cancel your own orders" for a manager.
 *
 * `kitchen` is included for the same reason it appears on that route: it can
 * already cancel there today, and leaving it out would reproduce the exact
 * dead-button state this file exists to prevent.
 */
const ORDER_CANCEL_ROLES = [...SYSTEM_ADMIN_ROLES, ...CAFETERIA_ADMIN_ROLES, 'manager', 'kitchen'];

/** Roles that may read any order (the existing GET /orders/:id policy). */
const OPERATIONS_ROLES = [...SYSTEM_ADMIN_ROLES, ...CAFETERIA_ADMIN_ROLES, 'manager', 'kitchen'];

const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return String(value._id || value.id || '');
  return String(value);
};

/**
 * Describe how `user` relates to `order`.
 *
 * @param {object} order Order document. `deliveryStaffAssigned` may be either a
 *   raw ObjectId or a populated document - both are handled.
 * @param {object} user  `req.user` (needs `id` and `role`).
 * @returns {{isOwner:boolean, isAssignedCourier:boolean, isOperations:boolean,
 *            canCancelManagement:boolean, canView:boolean, canCancel:boolean,
 *            reason:string|null}}
 */
function describeOrderAccess(order, user) {
  const viewerId = idOf(user && user.id);
  const role = normalizeRole(user && user.role);

  const isOwner = Boolean(viewerId) && idOf(order && order.userId) === viewerId;
  const isAssignedCourier =
    Boolean(viewerId) && idOf(order && order.deliveryStaffAssigned) === viewerId;

  const isOperations = OPERATIONS_ROLES.includes(role);
  const canCancelManagement = ORDER_CANCEL_ROLES.includes(role);

  // Read: unchanged from the existing GET /orders/:id policy - owner, the
  // courier who has to deliver it, or an operations role.
  const canView = isOwner || isAssignedCourier || isOperations;

  // Cancel: owner, or a role that already owns a staff-side cancel route.
  //
  // The assigned courier is deliberately NOT given cancel rights. Being able to
  // read an order (to deliver it) is not the same authority as being able to
  // cancel it and trigger a refund - that would let a compromised rider account
  // void any order in its delivery run. A courier who lands here gets an
  // explicit "ask a manager" message instead of the false "your own orders".
  const canCancel = isOwner || canCancelManagement;

  let reason = null;
  if (!canView) {
    reason = 'You do not have access to this order.';
  } else if (!canCancel) {
    reason =
      'This order belongs to another customer. Ask a manager or the cafeteria administrator to cancel it.';
  }

  return {
    isOwner,
    isAssignedCourier,
    isOperations,
    canCancelManagement,
    canView,
    canCancel,
    reason,
  };
}

module.exports = {
  describeOrderAccess,
  ORDER_CANCEL_ROLES,
  OPERATIONS_ROLES,
};
