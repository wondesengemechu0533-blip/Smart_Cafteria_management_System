require('dotenv').config();
const mongoose = require('mongoose');
const connectDatabase = require('../src/config/database');
const User = require('../src/models/User');

const RECORDS = [
  { email: 'e2e-admin@test.local', phone: '0900000001', name: 'E2E Admin', password: 'E2eAdmin@12345', role: 'admin', status: 'ACTIVE', isActive: true, balance: 5000 },
  { email: 'e2e-customer@test.local', phone: '0900000002', name: 'E2E Customer', password: 'E2eCust@12345', role: 'customer', status: 'ACTIVE', isActive: true, balance: 10000 },
  { email: 'e2e-rider@test.local', phone: '0900000003', name: 'E2E Rider', password: 'E2eRider@12345', role: 'delivery', status: 'ACTIVE', isActive: true, balance: 0 }
];

(async () => {
  try {
    await connectDatabase();
    for (const r of RECORDS) {
      let u = await User.findOne({ email: r.email });
      if (u) {
        u.password = r.password; u.role = r.role; u.status = 'ACTIVE'; u.isActive = true; u.phone = r.phone; u.name = r.name;
        await u.save();
        console.log('updated', r.email, u.role);
      } else {
        u = await User.create(r);
        console.log('created', r.email, u.role);
      }
    }
    const admin = await User.findOne({ email: 'e2e-admin@test.local' }).select('+password');
    console.log('admin pw match:', await admin.matchPassword('E2eAdmin@12345'));
    mongoose.disconnect();
    process.exit(0);
  } catch (e) { console.error(e); process.exit(1); }
})();