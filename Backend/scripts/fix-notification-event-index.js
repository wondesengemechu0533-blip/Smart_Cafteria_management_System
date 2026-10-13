/**
 * One-off migration: the `notification_event_key_unique` index was originally
 * created on `eventKey` alone, which made a kitchen order event storable only
 * ONCE in the whole collection (first recipient wins, everyone else hit
 * E11000). It must be `userId + eventKey` so every recipient gets their own
 * copy. Drop the old shape and build the corrected one.
 */
const mongoose = require('mongoose');
require('dotenv').config();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.db.collection('notifications');

  const before = await col.indexes();
  console.log('BEFORE:');
  before.filter((i) => i.name === 'notification_event_key_unique').forEach((i) => console.log(' ', JSON.stringify(i)));

  if (before.some((i) => i.name === 'notification_event_key_unique')) {
    await col.dropIndex('notification_event_key_unique');
    console.log('dropped the eventKey-only index');
  }

  await col.createIndex(
    { userId: 1, eventKey: 1 },
    {
      unique: true,
      name: 'notification_event_key_unique',
      partialFilterExpression: { eventKey: { $type: 'string' } },
    }
  );
  console.log('created compound { userId, eventKey } unique index');

  const after = await col.indexes();
  console.log('AFTER:');
  after.filter((i) => i.name === 'notification_event_key_unique').forEach((i) => console.log(' ', JSON.stringify(i)));

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
