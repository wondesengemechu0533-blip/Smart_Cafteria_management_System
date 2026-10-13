/**
 * One-off diagnostic: inspect the live `notifications` collection before
 * letting Mongoose create the partial unique index, so we know for certain that
 * pre-existing rows cannot violate it and abort server start.
 */
const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log('DB:', db.databaseName);

  const cols = await db.listCollections().toArray();
  console.log('has notifications collection:', cols.some((c) => c.name === 'notifications'));

  const idx = await db.collection('notifications').indexes();
  console.log('EXISTING INDEXES:');
  console.log(JSON.stringify(idx, null, 1));

  const total = await db.collection('notifications').countDocuments();
  const withKey = await db.collection('notifications').countDocuments({ eventKey: { $type: 'string' } });
  const dupes = await db
    .collection('notifications')
    .aggregate([{ $match: { eventKey: { $type: 'string' } } }, { $group: { _id: '$eventKey', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
    .toArray();
  console.log('total notifications:', total, '| with eventKey:', withKey);
  console.log('duplicate eventKeys:', JSON.stringify(dupes));

  await mongoose.disconnect();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
