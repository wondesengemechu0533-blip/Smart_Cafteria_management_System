require('dotenv').config();
const mongoose = require('mongoose');
const { ensureDefaultKitchenShifts } = require('./src/utils/kitchenShifts');
const KitchenShift = require('./src/models/KitchenShift');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  await ensureDefaultKitchenShifts();

  const counts = await KitchenShift.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  console.log('Status counts:', JSON.stringify(counts));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDay = new Date(today);
  endDay.setDate(endDay.getDate() + 1);
  const todayCount = await KitchenShift.countDocuments({ startTime: { $gte: today, $lt: endDay } });
  console.log('Shifts starting today:', todayCount);

  const sample = await KitchenShift.find({ startTime: { $gte: today, $lt: endDay } })
    .sort({ startTime: 1 }).limit(6).select('shiftType startTime status').lean();
  console.log('Today sample:', sample.map(s => `${s.shiftType} ${s.startTime.toISOString()} ${s.status}`).join(' | '));

  const upcoming = await KitchenShift.countDocuments({
    status: 'scheduled',
    startTime: { $gte: new Date() },
  });
  console.log('Upcoming scheduled (now+):', upcoming);

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
