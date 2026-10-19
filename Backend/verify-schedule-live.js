require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('./src/models/User');

function api(path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: Number(process.env.PORT || 5000), path, method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        let json; try { json = JSON.parse(d); } catch (e) { json = { raw: d }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const cook = await User.findOne({ name: /abebe/i, role: 'kitchen' }).lean()
    || await User.findOne({ role: 'kitchen', status: 'ACTIVE' }).lean();
  if (!cook) throw new Error('no kitchen user found');
  const token = jwt.sign({ id: String(cook._id), role: cook.role, name: cook.name, email: cook.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  console.log(`cook=${cook.name} role=${cook.role}`);

  const list = await api('/api/v1/kitchen-staff/shifts', token);
  const shifts = (list.body && list.body.shifts) || [];
  const own = shifts.filter(s => String(s.staffId && s.staffId._id || s.staffId) === String(cook._id));
  console.log(`GET /shifts -> HTTP ${list.status}, total=${shifts.length}, own=${own.length}`);
  const byStatus = {};
  shifts.forEach(s => { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
  console.log('status breakdown:', JSON.stringify(byStatus));

  const cur = await api('/api/v1/kitchen-staff/shifts/current', token);
  const day = (cur.body && cur.body.dayShifts) || [];
  console.log(`GET /shifts/current -> HTTP ${cur.status}, dayShifts=${day.length}, reason=${cur.body && cur.body.reason}`);
  day.forEach(s => console.log(`  ${s.shiftType} ${new Date(s.startTime).toISOString()} -> ${s.status}`));

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
