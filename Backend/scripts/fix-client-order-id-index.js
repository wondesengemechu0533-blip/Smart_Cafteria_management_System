/**
 * One-off migration: `clientOrderId` was declared with `unique: true, sparse: true`
 * as *path* options. Mongoose only honours `unique` there - `sparse` is an INDEX
 * option and is silently dropped - so the database ended up with a NON-sparse
 * unique index on `clientOrderId`.
 *
 * Every order created outside the idempotent checkout flow stores
 * `clientOrderId: null`, so the second such order in the collection was rejected
 * with `E11000 duplicate key error ... index: clientOrderId_1 dup key:
 * { clientOrderId: null }` - the customer could not place a second order.
 *
 * `sparse: true` alone is NOT enough: a sparse index still contains documents
 * whose field is an explicit null. Only a partial index restricted to string
 * values lets keyless orders coexist while still rejecting a replayed checkout
 * key. This mirrors the shape used by fix-notification-event-index.js.
 *
 * Safe to re-run: it drops whichever old shape exists and recreates the target.
 *
 * Run: node Backend/scripts/fix-client-order-id-index.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const TARGET = 'clientOrderId_1_partial';
const LEGACY_NAMES = ['clientOrderId_1', 'clientOrderId_1_sparse'];
const TARGET_SPEC = {
  unique: true,
  name: TARGET,
  partialFilterExpression: { clientOrderId: { $type: 'string' } },
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.db.collection('orders');

  const show = (label) =>
    col
      .indexes()
      .then((list) => {
        const hits = list.filter((i) => i.key && i.key.clientOrderId !== undefined);
        console.log(`${label}:`);
        if (!hits.length) console.log('  (no clientOrderId index)');
        hits.forEach((i) => console.log(' ', JSON.stringify(i)));
        return hits;
      });

  const before = await show('BEFORE');

  const alreadyCorrect = before.some((i) => i.name === TARGET && i.unique && i.partialFilterExpression);
  const stale = before.filter((i) => i.key && i.key.clientOrderId !== undefined && i.name !== TARGET);

  for (const idx of stale) {
    await col.dropIndex(idx.name);
    console.log(`dropped the unusable index "${idx.name}"`);
  }

  if (alreadyCorrect) {
    console.log('\nthe partial unique index is already in place - nothing to do.');
  } else {
    await col.createIndex({ clientOrderId: 1 }, TARGET_SPEC);
    console.log(`created partial unique index "${TARGET}"`);
  }

  await show('AFTER');

  // Clear any probe rows an earlier aborted run may have left behind.
  await col.deleteMany({ orderId: { $regex: '^__idx_probe_' } });

  // Prove the actual bug is gone: two keyless orders must now coexist...
  const probeA = await col.insertOne({ orderId: '__idx_probe_a__', clientOrderId: null, __probe: true });
  const probeB = await col.insertOne({ orderId: '__idx_probe_b__', clientOrderId: null, __probe: true });
  console.log('\nverified: two orders with clientOrderId=null can now be stored');

  // ...and the idempotency guarantee must survive the change.
  const idem = new mongoose.Types.ObjectId().toString();
  await col.insertOne({ orderId: '__idx_probe_c__', clientOrderId: idem, __probe: true });
  try {
    await col.insertOne({ orderId: '__idx_probe_d__', clientOrderId: idem, __probe: true });
    console.log('verified: FAILED - a replayed checkout key was accepted (idempotency broken)');
  } catch (e) {
    console.log('verified: a replayed checkout key is still rejected (idempotency intact)');
  }
  await col.deleteMany({ __probe: true });

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});