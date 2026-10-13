const KitchenShift = require('../models/KitchenShift');
const User = require('../models/User');

/**
 * Auto-seed default weekly shifts for active kitchen staff
 * so the Preparation Schedule page displays data immediately.
 * Runs once at backend startup; idempotent — will not re-seed if any
 * shifts already exist in the database.
 */
async function ensureDefaultKitchenShifts() {
  const existing = await KitchenShift.countDocuments();
  if (existing > 0) return; // already seeded

  // Collect all active users whose role normalises to 'kitchen'.
  // We query for the common raw role strings that map to 'kitchen'.
  const activeStaff = await User.find({
    role: { $regex: '^kitchen', $options: 'i' },
    status: 'ACTIVE',
    isActive: { $ne: false },
  }).select('_id name');

  if (!activeStaff.length) return;

  const now = new Date();
  const created = [];

  // For each staff member, create 3 daily shifts (morning/afternoon/evening)
  // for the next 7 days so the schedule page always has data.
  for (const member of activeStaff) {
    for (let day = 0; day < 7; day++) {
      const dayBase = new Date(now);
      dayBase.setDate(now.getDate() + day);
      dayBase.setHours(0, 0, 0, 0);

      // Morning shift: 08:00 – 12:00
      created.push({
        staffId: member._id,
        shiftType: 'morning',
        startTime: new Date(dayBase.setHours(8, 0, 0, 0)),
        endTime: new Date(dayBase.setHours(12, 0, 0, 0)),
        status: 'scheduled',
      });

      // Afternoon shift: 12:00 – 16:00
      created.push({
        staffId: member._id,
        shiftType: 'afternoon',
        startTime: new Date(dayBase.setHours(12, 0, 0, 0)),
        endTime: new Date(dayBase.setHours(16, 0, 0, 0)),
        status: 'scheduled',
      });

      // Evening shift: 16:00 – 20:00
      created.push({
        staffId: member._id,
        shiftType: 'evening',
        startTime: new Date(dayBase.setHours(16, 0, 0, 0)),
        endTime: new Date(dayBase.setHours(20, 0, 0, 0)),
        status: 'scheduled',
      });
    }
  }

  if (created.length > 0) {
    await KitchenShift.insertMany(created);
  }
}

module.exports = { ensureDefaultKitchenShifts };
