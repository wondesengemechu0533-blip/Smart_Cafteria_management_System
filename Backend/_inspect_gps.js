/* Inspect recent delivery orders + Delivery docs for GPS fields. */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: undefined });
  const db = mongoose.connection.db;
  const orders = db.collection('orders');
  const dels = db.collection('deliveries');

  const list = await orders
    .find({ orderType: 'delivery' })
    .sort({ createdAt: -1 })
    .limit(8)
    .project({ orderId: 1, status: 1, createdAt: 1, deliveryInfo: 1, currentLocation: 1, deliveryStaffAssigned: 1, cafeteriaId: 1 })
    .toArray();

  console.log('=== recent delivery orders ===');
  for (const o of list) {
    const di = o.deliveryInfo || {};
    console.log(JSON.stringify({
      orderId: o.orderId,
      status: o.status,
      createdAt: o.createdAt,
      di_lat: di.latitude, di_lng: di.longitude,
      di_addr: di.deliveryAddress || di.location,
      currentLocation: o.currentLocation || null,
      staff: o.deliveryStaffAssigned ? String(o.deliveryStaffAssigned) : null,
    }));
  }

  const dl = await dels.find({}).sort({ createdAt: -1 }).limit(8).toArray();
  console.log('=== recent deliveries ===');
  for (const d of dl) {
    console.log(JSON.stringify({
      orderId: d.orderId || null,
      order: d.order ? String(d.order) : null,
      status: d.status,
      dest: d.destination || null,
      currentLocation: d.currentLocation || null,
      staff: d.deliveryStaffId || d.deliveryPerson || d.staff || null,
      createdAt: d.createdAt,
    }));
  }

  // Also check DeliveryLocation history count
  const locs = db.collection('deliverylocations');
  const cnt = await locs.countDocuments();
  const latest = await locs.find({}).sort({ timestamp: -1 }).limit(5).toArray();
  console.log('=== deliverylocations total=' + cnt + ' ===');
  latest.forEach(l => console.log(JSON.stringify({ delivery: String(l.delivery), lat: l.latitude, lng: l.longitude, ts: l.timestamp })));

  await mongoose.disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
