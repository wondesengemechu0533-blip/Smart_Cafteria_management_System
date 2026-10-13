/**
 * One-off, idempotent backfill of the delivery Notifications-page filter tags.
 *
 * WHY
 * ---
 * The delivery panel filters notifications on structured `meta` tags:
 *   meta.assignment / meta.unassigned -> the "Assignments" tab
 *   meta.deliveryStatus                -> the "Status Updates" tab
 *   type === 'delivery_issue'          -> the "Problems" tab
 *
 * Those tags were only ever written by notification rows created AFTER the tag
 * contract landed. Every pre-existing row has `meta: { orderType: 'delivery' }`
 * and nothing else, so it can never satisfy any of those predicates and the tab
 * renders its empty state even though matching rows are plainly visible under
 * "All". No amount of clicking fixes that: the data simply lacks the tag.
 *
 * This script stamps the tags onto the historical rows. It is safe to re-run -
 * every statement only touches rows the tag does not already apply to, so a
 * second run reports 0 modified rather than re-tagging anything.
 *
 * HOW IT IDENTIFIES LEGACY ROWS
 * ----------------------------
 * Titles and links are the only signal the old rows carry. They are stable
 * because every one of them was emitted by this controller:
 *   assignment -> "Delivery Assigned!", "Delivery Reassigned to You",
 *                 "Delivery Retry Assigned"  (meta.assignment)
 *   unassignment -> "Delivery Reassigned", "Delivery Retry Reassigned"
 *                 (meta.assignment + meta.unassigned - the previous courier was
 *                 told the job was taken off them)
 *
 * Reassignment notices to the NEW courier are tagged `assignment` only, and the
 * "taken off you" notice is tagged both. An exact-title match (not a substring)
 * is used so "Delivery Reassigned" cannot swallow
 * "Delivery Reassigned to You", and `deliveryStatus` is deliberately NOT
 * backfilled: guessing a lifecycle step from a title would be fabrication, and
 * "Status Updates" is now correctly populated going forward by
 * notifyStepRecipients() without any guesswork.
 *
 * USAGE
 *   node scripts/backfill-delivery-notification-tags.js           # report + apply
 *   node scripts/backfill-delivery-notification-tags.js --dry-run # report only
 */
const mongoose = require('mongoose');
require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');

// Titles emitted to the courier being given the job.
const ASSIGNMENT_TITLES = ['Delivery Assigned!', 'Delivery Reassigned to You', 'Delivery Retry Assigned'];
// Titles emitted to the courier who LOST the job. Tagged as an assignment so the
// tab shows "everything about who is assigned", plus `unassigned` so a panel can
// distinguish "you got it" from "it was taken off you".
const UNASSIGNED_TITLES = ['Delivery Reassigned', 'Delivery Retry Reassigned'];

const isAssignment = (title) => ASSIGNMENT_TITLES.includes(title);
const isUnassigned = (title) => UNASSIGNED_TITLES.includes(title);

async function run() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const Notification = require('../src/models/Notification');
  const col = mongoose.connection.db.collection('notifications');

  // How many rows each predicate can see before we touch anything.
  const scoped = await col.countDocuments({
    type: 'status_update',
    title: { $in: [...ASSIGNMENT_TITLES, ...UNASSIGNED_TITLES] },
  });
  const unassignedRows = await col.countDocuments({ title: { $in: UNASSIGNED_TITLES } });

  console.log(`legacy delivery assignment rows in scope: ${scoped}`);
  console.log(`  of which "taken off you" notices:        ${unassignedRows}`);

  // Assignment filter.
  const assignFilter = {
    type: 'status_update',
    title: { $in: [...ASSIGNMENT_TITLES, ...UNASSIGNED_TITLES] },
    'meta.assignment': { $ne: true },
  };
  // The "taken off you" half, tagged separately on top of `assignment`.
  const unassignFilter = {
    type: 'status_update',
    title: { $in: UNASSIGNED_TITLES },
    'meta.unassigned': { $ne: true },
  };

  const toAssign = await col.countDocuments(assignFilter);
  const toUnassign = await col.countDocuments(unassignFilter);
  console.log(`\nrows missing meta.assignment:  ${toAssign}`);
  console.log(`rows missing meta.unassigned: ${toUnassign}`);

  if (DRY_RUN) {
    console.log('\n--dry-run: no writes performed. Re-run without --dry-run to apply.');
    await mongoose.disconnect();
    return;
  }

  if (toAssign > 0) {
    // `meta` is Schema.Types.Mixed, so this is a plain field update. Setting
    // `meta.assignment` on a document that already has a `meta` object merges
    // into it rather than replacing the object.
    const r1 = await col.updateMany(assignFilter, { $set: { 'meta.assignment': true } });
    console.log(`\nstamped meta.assignment on ${r1.modifiedCount} row(s)`);
  } else {
    console.log('\nmeta.assignment: nothing to do');
  }

  if (toUnassign > 0) {
    const r2 = await col.updateMany(unassignFilter, {
      $set: { 'meta.assignment': true, 'meta.unassigned': true },
    });
    console.log(`stamped meta.assignment + meta.unassigned on ${r2.modifiedCount} row(s)`);
  } else {
    console.log('meta.unassigned: nothing to do');
  }

  // --- Promote legacy rows onto the REAL notification types -----------------
  //
  // The panel filters now read `type` (delivery_assigned / delivery_status /
  // delivery_issue) rather than leaning on the meta tags alone, so rows written
  // before those types existed must be promoted or they would only ever match
  // through the fallback path.
  //
  // Both selectors below key off STRUCTURED fields only - an exact title list
  // for assignments, and the presence of `meta.deliveryStatus` for lifecycle
  // steps. Nothing here infers a category from free-form message text.
  //
  // Idempotent: each selector requires `type: 'status_update'`, so rows already
  // promoted (or already carrying a new type) are never re-touched.
  const promoteAssignments = {
    type: 'status_update',
    title: { $in: [...ASSIGNMENT_TITLES, ...UNASSIGNED_TITLES] },
  };
  // Any delivery row that already recorded a lifecycle step.
  const promoteStatus = {
    type: 'status_update',
    'meta.orderType': 'delivery',
    'meta.deliveryStatus': { $exists: true, $ne: null },
  };

  const toPromoteAssign = await col.countDocuments(promoteAssignments);
  const toPromoteStatus = await col.countDocuments(promoteStatus);
  console.log(`\nrows still on status_update that are assignments:  ${toPromoteAssign}`);
  console.log(`rows still on status_update that are status steps: ${toPromoteStatus}`);

  if (DRY_RUN) {
    console.log('\n--dry-run: type promotion not performed. Re-run without --dry-run to apply.');
  } else {
    if (toPromoteAssign > 0) {
      const r3 = await col.updateMany(promoteAssignments, { $set: { type: 'delivery_assigned' } });
      console.log(`\npromoted ${r3.modifiedCount} row(s) to type=delivery_assigned`);
    }
    if (toPromoteStatus > 0) {
      const r4 = await col.updateMany(promoteStatus, { $set: { type: 'delivery_status' } });
      console.log(`promoted ${r4.modifiedCount} row(s) to type=delivery_status`);
    }
  }

  // Verify through the model (not the raw collection) so we exercise the same
  // schema the API serves.
  const verify = await Notification.countDocuments({ 'meta.assignment': true });
  const verifyUn = await Notification.countDocuments({ 'meta.unassigned': true });
  const verifyAssigned = await Notification.countDocuments({ type: 'delivery_assigned' });
  const verifyStatus = await Notification.countDocuments({ type: 'delivery_status' });
  console.log(`\nVERIFY  meta.assignment=true: ${verify}`);
  console.log(`VERIFY  meta.unassigned=true: ${verifyUn}`);
  console.log(`VERIFY  type=delivery_assigned: ${verifyAssigned}`);
  console.log(`VERIFY  type=delivery_status:  ${verifyStatus}`);

  // The Notification model is only required for the verification query above.
  await mongoose.disconnect();
  console.log('\nDone. Every tab now matches on a real notification type.');
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERR', e.message);
    process.exit(1);
  });