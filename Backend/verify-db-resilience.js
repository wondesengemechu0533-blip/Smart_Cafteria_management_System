/**
 * Resilience of the shared database path.
 *
 * Every authenticated route resolves the caller with a single User lookup in
 * the auth middleware, so anything that makes that lookup fail takes down every
 * endpoint at once. That is precisely how a brief Atlas blip turned into a wall
 * of unrelated 500s across the dashboards. These checks pin down that such a
 * failure is now reported as a retryable 503, while genuine bugs and bad
 * requests keep their own status codes.
 *
 * Run: node verify-db-resilience.js
 */

process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scs_db_resilience_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'db-resilience-secret';

const assert = require('assert');
const mongoose = require('mongoose');
const { isTransientDbError } = require('./src/config/database');
const { errorHandler } = require('./src/middleware/errorHandler');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

/** Minimal stand-in for an Express response. */
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function runErrorHandler(err) {
  const res = fakeRes();
  let passedThrough = false;
  // The real handler logs every error. Silence it here so an expected failure
  // does not bury the check output in stack traces.
  const realError = console.error;
  console.error = () => {};
  try {
    errorHandler(err, { url: '/test' }, res, () => {
      passedThrough = true;
    });
  } finally {
    console.error = realError;
  }
  assert.ok(!passedThrough, 'errorHandler must handle the error itself, not delegate');
  return res;
}

const mkErr = (name, message) => {
  const e = new Error(message);
  e.name = name;
  return e;
};

(async () => {
  console.log('\nTransient-error classification');

  await check('a buffering timeout is transient', () => {
    assert.strictEqual(
      isTransientDbError(mkErr('MongooseError', 'Operation `users.findOne()` buffering timed out after 10000ms')),
      true
    );
  });

  await check('server selection failure is transient', () => {
    assert.strictEqual(
      isTransientDbError(mkErr('MongoServerSelectionError', 'Server selection timed out after 5000 ms')),
      true
    );
  });

  await check('a closed pool is transient', () => {
    assert.strictEqual(
      isTransientDbError(mkErr('MongoPoolClearedError', 'Connection pool was closed')),
      true
    );
  });

  await check('a network reset is transient', () => {
    assert.strictEqual(isTransientDbError(mkErr('MongoNetworkError', 'read ECONNRESET')), true);
  });

  await check('a dropped client is transient, matched by driver error name', () => {
    // This is the exact error a real Atlas blip produces, and its wording has
    // changed between driver versions - so the name has to be enough.
    assert.strictEqual(
      isTransientDbError(mkErr('MongoNotConnectedError', 'Client must be connected before running operations')),
      true
    );
  });

  await check('a pool-cleared error is transient, matched by driver error name', () => {
    assert.strictEqual(isTransientDbError(mkErr('MongoPoolClearedError', 'Pool was cleared')), true);
  });

  await check('a CastError is NOT transient (bad id is a real problem)', () => {
    assert.strictEqual(
      isTransientDbError(mkErr('CastError', 'Cast to ObjectId failed for value "not-an-id"')),
      false
    );
  });

  await check('a ValidationError is NOT transient', () => {
    assert.strictEqual(isTransientDbError(mkErr('ValidationError', 'Path `name` is required.')), false);
  });

  await check('a duplicate key is NOT transient', () => {
    const e = mkErr('MongoServerError', 'E11000 duplicate key error');
    e.code = 11000;
    assert.strictEqual(isTransientDbError(e), false);
  });

  await check('an ordinary bug is NOT transient', () => {
    assert.strictEqual(
      isTransientDbError(mkErr('TypeError', "Cannot read properties of undefined (reading 'toLowerCase')")),
      false
    );
  });

  console.log('\nError handler mapping');

  await check('a transient database failure answers 503 + retryable', () => {
    const res = runErrorHandler(
      mkErr('MongooseError', 'Operation `users.findOne()` buffering timed out after 12000ms')
    );
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.retryable, true);
  });

  await check('a genuine bug still answers 500', () => {
    const res = runErrorHandler(mkErr('TypeError', 'x is not a function'));
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.retryable, undefined);
  });

  await check('an explicit statusCode is still honoured', () => {
    const e = mkErr('Error', 'A problem can only be reported while the delivery is in progress');
    e.statusCode = 400;
    const res = runErrorHandler(e);
    assert.strictEqual(res.statusCode, 400);
  });

  await check('a bad CastError keeps its "Invalid ID format" message', () => {
    const res = runErrorHandler(mkErr('CastError', 'Cast to ObjectId failed'));
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error, 'Invalid ID format');
  });

  console.log('\nAuth middleware: the lookup shared by every route');

  // Load the real middleware with the real models; only the User lookup is
  // stubbed, because provoking a real Atlas outage is not something a unit
  // check should do.
  const User = require('./src/models/User');
  const { protect } = require('./src/middleware/auth');
  const jwt = require('jsonwebtoken');
  const originalFindById = User.findById;

  const withLookupError = async (err) => {
    User.findById = () => ({ select: () => ({ then: (_res, rej) => rej(err) }) });
    const req = {
      // A genuinely valid token, so the failure under test is the database
      // lookup itself rather than signature verification.
      headers: {
        authorization: `Bearer ${jwt.sign({ id: new mongoose.Types.ObjectId(), role: 'manager' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`,
      },
    };
    const res = fakeRes();
    const realError = console.error;
    console.error = () => {};
    try {
      await protect(req, res, () => {});
    } finally {
      console.error = realError;
    }
    return res;
  };

  await check('a transient lookup failure answers 503 + retryable', async () => {
    const res = await withLookupError(
      mkErr('MongooseError', 'Operation `users.findOne()` buffering timed out after 12000ms')
    );
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.retryable, true);
  });

  await check('a malformed id in the token answers 401, not 500', async () => {
    const res = await withLookupError(mkErr('CastError', 'Cast to ObjectId failed for value "nope"'));
    assert.strictEqual(res.statusCode, 401);
  });

  await check('any other lookup failure answers 500', async () => {
    const res = await withLookupError(mkErr('TypeError', 'boom'));
    assert.strictEqual(res.statusCode, 500);
  });

  await check('a bad signature still answers 401', async () => {
    const req = { headers: { authorization: 'Bearer not.a.jwt' } };
    const res = fakeRes();
    await protect(req, res, () => {});
    assert.strictEqual(res.statusCode, 401);
  });

  User.findById = originalFindById;

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failed: ' + failures.join(', '));
    process.exit(1);
  }
  console.log('Database-path resilience verified.');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});