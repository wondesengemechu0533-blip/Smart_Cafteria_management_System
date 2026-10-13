require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./src/models/User');
  const d1 = await User.deleteMany({ email: { $regex: '^debug-(rider|cust)-' } });
  const d2 = await User.deleteMany({ email: { $regex: '^gps-e2e-' } });
  console.log('deleted debug', d1.deletedCount, 'gps-e2e', d2.deletedCount);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
