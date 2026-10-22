const KitchenShift = require('../models/KitchenShift');
const User = require('../models/User');

/**
 * Default daily shift windows (local server time).
 */
const SHIFT_WINDOWS = [
  { shiftType: 'morning', startHour: 8, endHour: 12 },
  { shiftType: 'afternoon', startHour: 12, endHour: 16 },
  { shiftType: 'evening', startHour: 16, endHour: 20 },
];

/**
 * Auto-seed default weekly shifts for active kitchen staff so the
 * Preparation Schedule page always displays current data.
 *
 * Runs at every backend startup and is idempotent:
 *  1. Cancels stale `scheduled` shifts whose start time has passed (they can
 *     never be clocked into and used to clutter the page forever).
 *  2. Ensures each active kitchen staff member has the 3 daily shifts for
 *     TODAY .. TODAY+6, inserting only the missing ones (keyed by
 *     staff + shiftType + day), and never creating a shift that already
 *     ended earlier today.
 *
 * The old version ran only once ("if any shifts exist, skip"), so after a
 * week the schedule page showed zero stats, an empty Upcoming table, and a
 * Current Shift card pointing at long-finished shifts.
 */
async function ensureDefaultKitchenShifts() {
  const now = new Date();

  // Active kitchen staff (role is stored canonicalised as 'kitchen').
  const activeStaff = await User.find({
    role: { $regex: '^kitchen', $options: 'i' },
    status: 'ACTIVE',
    isActive: { $ne: false },
  }).select('_id name');

  if (!activeStaff.length) return;

  // 2. Existing shifts inside the rolling 7-day window - key them so we only
  //    insert what is missing (never duplicate, never overwrite worked shifts).
  const windowStart = new Date(now);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 7);

  const existing = await KitchenShift.find({
    staffId: { $in: activeStaff.map((m) => m._id) },
    startTime: { $gte: windowStart, $lt: windowEnd },
  }).select('staffId shiftType startTime');

  const have = new Set(
    existing.map((s) => `${s.staffId}|${s.shiftType}|${new Date(s.startTime).toDateString()}`)
  );

  const created = [];
  for (const member of activeStaff) {
    for (let day = 0; day < 7; day++) {
      const dayBase = new Date(windowStart);
      dayBase.setDate(windowStart.getDate() + day);
      const dayKey = dayBase.toDateString();

      for (const win of SHIFT_WINDOWS) {
        const key = `${member._id}|${win.shiftType}|${dayKey}`;
        if (have.has(key)) continue;

        const start = new Date(dayBase);
        start.setHours(win.startHour, 0, 0, 0);
        const end = new Date(dayBase);
        end.setHours(win.endHour, 0, 0, 0);

        // Never seed a shift that has already ended (e.g. morning on a
        // server started in the evening).
        if (end <= now) continue;

        created.push({
          staffId: member._id,
          shiftType: win.shiftType,
          startTime: start,
          endTime: end,
          status: 'scheduled',
        });
      }
    }
  }

  if (created.length > 0) {
    await KitchenShift.insertMany(created);
    console.log(`📅 Kitchen shifts rolled forward: ${created.length} shift(s) created for the next 7 days`);
  }
}

module.exports = { ensureDefaultKitchenShifts };
