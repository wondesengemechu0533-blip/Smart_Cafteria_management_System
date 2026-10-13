const mongoose = require('mongoose');
const dns = require('dns');

// ----------------------------------------------------------------------------
// DNS hardening
// ----------------------------------------------------------------------------
// Atlas `mongodb+srv://` URIs start with an SRV lookup of the cluster domain.
// On Windows, Node's bundled DNS resolver (c-ares) can intermittently return
// querySrv ETIMEOUT / ECONNREFUSED even when the OS resolver works fine (VPN,
// IPv6 preference, or a stale adapter in the OS DNS list are common triggers).
//   * Prefer IPv4 address resolution universally.
//   * Pin the SRV lookups to reliable public resolvers (overridable via env).
// IMPORTANT: many networks (ISPs, corporate/campus firewalls, some regions)
// BLOCK port 53 to public resolvers like 1.1.1.1 / 8.8.8.8. Pinning to them
// then turns every SRV lookup into querySrv ETIMEOUT even though the machine's
// own DNS works fine. Capture the OS resolver list BEFORE pinning so we can
// fall back to it automatically the moment the pinned servers fail.
let osDnsServers = [];
let dnsPinActive = false;

try {
  dns.setDefaultResultOrder('ipv4first');

  if (!process.env.MONGO_DISABLE_DNS_PIN) {
    const servers = (process.env.MONGO_DNS_SERVERS || '1.1.1.1,8.8.8.8,8.8.4.4')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (servers.length) {
      osDnsServers = dns.getServers();
      dns.setServers(servers);
      dnsPinActive = true;
    }
  }
} catch (err) {
  // Fall back to OS DNS if pinning is unavailable — non-fatal.
}

/**
 * Switch DNS back to the machine's own resolvers (the ones captured before
 * pinning). Returns true when the fallback actually happened.
 */
const restoreOsDns = () => {
  if (!dnsPinActive) return false;
  try {
    if (osDnsServers.length) dns.setServers(osDnsServers);
    dnsPinActive = false;
    console.warn(
      `⚠️  Pinned DNS resolvers (${(process.env.MONGO_DNS_SERVERS || '1.1.1.1,8.8.8.8,8.8.4.4')}) are unreachable from this network — falling back to OS DNS (${osDnsServers.join(', ') || 'default'})…`
    );
    return true;
  } catch (err) {
    return false;
  }
};

const extractSrvHost = (uri) => {
  const match = /^mongodb\+srv:\/\/(?:[^@/?#]+@)?([^/@?#]+)/i.exec(uri || '');
  return match ? match[1] : null;
};

/**
 * Preflight the pinned resolvers before mongoose ever touches them.
 *
 * When a network silently drops UDP/53 to 1.1.1.1 / 8.8.8.8, the SRV query
 * does NOT fail fast — it hangs for over a minute (c-ares retransmits against
 * firewalled servers). Racing one lookup against a short timeout detects that
 * in ~2s and lets us fall back to the OS resolvers before the first connect
 * attempt, instead of after a 60s+ stall.
 */
const probePinnedDns = async (host, timeoutMs = 2000) => {
  let timer = null;
  try {
    await Promise.race([
      dns.promises.resolveSrv(host),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS probe timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const DNS_INDICATORS = ['querySrv', 'enotfound', 'eai_again', 'getaddrinfo'];
const AUTH_INDICATORS = ['authentication failed', 'auth failed', 'bad auth', 'not authorized'];

const isDnsFailure = (message = '') => {
  const m = message.toLowerCase();
  return DNS_INDICATORS.some((key) => m.includes(key));
};

const isAuthFailure = (message = '') => {
  const m = message.toLowerCase();
  return AUTH_INDICATORS.some((key) => m.includes(key));
};

const printDnsHints = () => {
  console.error(
    '\n⚠️  This is a DNS lookup failure — the MongoDB host could NOT be resolved. This is NOT an IP whitelist problem.'
  );
  console.error('   1. Check your internet connection / WiFi.');
  console.error('   2. If a VPN or proxy is active, try disconnecting it.');
  console.error('   3. Verify the cluster name in MONGODB_URI is correct.');
  console.error('      Tip: nslookup _mongodb._tcp.cluster0.5ijixco.mongodb.net should return SRV records.');
  console.error('   4. Transient DNS blips usually clear on retry — restart the server.\n');
};

const printAuthHints = () => {
  console.error('\n⚠️  MongoDB rejected your credentials or your IP is not whitelisted:');
  console.error('   1. Go to: https://cloud.mongodb.com/v2');
  console.error('   2. Select your project "Cluster0"');
  console.error('   3. Click "Database Access" → edit the user, and confirm the username/password match MONGODB_URI.');
  console.error('   4. Click "Network Access" → "Add IP Address" → "Allow Access from Anywhere" (0.0.0.0/0).');
  console.error('   5. Restart the server.\n');
};

const printConnectionHints = (message) => {
  console.error(`\n⚠️  Could not reach the MongoDB server (${message || 'unknown error'}):`);
  console.error('   1. Confirm the cluster is not paused (Free-tier M0 clusters pause after ~60 days of inactivity).');
  console.error('   2. Resume it from https://cloud.mongodb.com/v2, then restart the server.');
  console.error('   3. If it is running, this may be a momentary network blip — retry the server.\n');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----------------------------------------------------------------------------
// Direct-connection fallback
// ----------------------------------------------------------------------------
// Resolves the Atlas SRV records ourselves and builds a plain `mongodb://`
// URI using the concrete shard hostnames + ports. This bypasses the flaky
// c-ares SRV query entirely (the driver only needs ordinary A lookups for the
// resulting hosts). A plain `mongodb://` URI does NOT imply TLS like
// `mongodb+srv://` does, and Atlas users authenticate against `admin`, so we
// inject `ssl=true` and `authSource=admin` explicitly.
const buildDirectUriFromSrv = async (srvUri) => {
  const match = /^mongodb\+srv:\/\/(?:[^@/?#]+@)?([^/@?#]+)/i.exec(srvUri);
  if (!match) return null;

  const host = match[1];
  let records = null;
  try {
    records = await dns.promises.resolveSrv(host);
  } catch (err) {
    // Pinned resolvers may be the problem — retry once against OS DNS.
    if (restoreOsDns()) {
      try {
        records = await dns.promises.resolveSrv(host);
      } catch (err2) {
        return null;
      }
    } else {
      return null;
    }
  }
  if (!records || records.length === 0) return null;

  try {
    const hosts = records
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 3)
      .map((r) => `${r.name}:${r.port}`)
      .join(',');

    const parsed = new URL(srvUri);
    const db = parsed.pathname.replace(/^\//, '');
    const auth = parsed.username
      ? `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password)}@`
      : '';

    const params = new URLSearchParams(parsed.searchParams);
    if (!params.has('ssl')) params.set('ssl', 'true');
    if (!params.has('authSource')) params.set('authSource', 'admin');
    if (!params.has('retryWrites')) params.set('retryWrites', 'true');
    if (!params.has('w')) params.set('w', 'majority');

    return `mongodb://${auth}${hosts}${db ? '/' + db : ''}?${params.toString()}`;
  } catch (err) {
    return null;
  }
};

/**
 * Connection lifecycle logging.
 *
 * When an Atlas link drops, mongoose keeps buffering queries and every one of
 * them eventually fails. Nothing logged that, so the only visible symptom was a
 * burst of unrelated 500s on the dashboards that poll the API. Surfacing the
 * transition makes the cause obvious in the server log the moment it happens.
 */
const attachConnectionLogging = () => {
  const conn = mongoose.connection;
  // Guard against double-registration if connectDatabase is ever called twice.
  if (conn.__scosLoggingAttached) return;
  conn.__scosLoggingAttached = true;

  let wasConnected = false;

  conn.on('connected', () => {
    wasConnected = true;
    console.log(`✓ MongoDB connection ready: ${conn.name}`);
  });

  conn.on('reconnected', () => {
    console.log('✓ MongoDB reconnected');
  });

  conn.on('disconnected', () => {
    // A clean shutdown also fires this; only warn about a link we expected to hold.
    if (wasConnected) console.warn('⚠️  MongoDB connection lost - retrying in the background...');
  });

  conn.on('error', (err) => {
    console.error('✗ MongoDB connection error:', err.message || err);
  });
};

const connectDatabase = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured');

  const options = {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    family: 4,
    retryWrites: true,
    // Reads are equally safe to retry and are the ones the dashboards lean on
    // hardest (every panel polls several read endpoints at once). Without this
    // a single dropped socket turns each in-flight read into a hard failure.
    retryReads: true,
    w: 'majority',
    // A dashboard page fires several reads at once and Socket.IO holds its own
    // connections. At 10 the pool is trivially exhausted, and an exhausted pool
    // surfaces as a failed query - which the controllers can only report as a
    // 500. 25 stays comfortably inside the Atlas free-tier connection cap.
    maxPoolSize: 25,
    minPoolSize: 2,
    // Fail fast instead of hanging a request for the full buffer window: a
    // request that cannot reach Mongo in this long is better answered with a
    // retryable error than left to occupy an HTTP socket.
    waitQueueTimeoutMS: 10000,
    // Must stay above serverSelectionTimeoutMS. Keeping it small means a brief
    // Atlas blip surfaces as a retryable error quickly, rather than the default
    // 10s buffer silently expiring and turning every dashboard poll into a 500.
    bufferTimeoutMS: 12000,
    heartbeatFrequencyMS: 10000,

    // The Atlas route from this machine is BANDWIDTH-bound: measured ~8 KB/s at
    // a ~450 ms round trip, while plain HTTPS on the same box does ~267 KB/s.
    // Every dashboard poll ships a payload made almost entirely of repeated keys
    // and timestamps, so zlib on the wire is close to free and measured ~1.8x on
    // the dashboard query phase (19.7s -> 11.0s).
    //
    // Level 6 is zlib's default and the ratio that measurement was taken at.
    // This trades a little CPU - which the server is not short of - for the one
    // resource the link has almost none of.
    compressors: ['zlib'],
    zlibCompressionLevel: 6,
  };

  let attempts = 3;
  let isDns = false;
  let lastError = null;

  // If public resolvers are firewalled on this network, drop the pin BEFORE
  // the first connect attempt (a pinned SRV lookup would otherwise hang for
  // over a minute). No-op when pinning is disabled or DNS is healthy.
  if (dnsPinActive) {
    const srvHost = extractSrvHost(uri);
    if (srvHost && !(await probePinnedDns(srvHost))) restoreOsDns();
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      attachConnectionLogging();
      await mongoose.connect(uri, options);
      console.log(`✓ MongoDB connected: ${mongoose.connection.name}`);
      return true;
    } catch (error) {
      lastError = error;
      const message = error.message || 'Unknown connection error';
      isDns = isDnsFailure(message);

      // DNS blips are usually transient — give them more chances.
      if (isDns && attempts < 6) {
        attempts = 6;
        // If the pinned public resolvers are blocked by this network, every
        // retry would fail the same way. Switch back to the OS resolvers
        // (verified working) so the very next attempt can succeed.
        restoreOsDns();
        if (attempt === attempts) {
          console.error('✗ MongoDB connection failed (final attempt):', message);
          break;
        }
        console.warn(`⏳ MongoDB connection attempt ${attempt}/${attempts} failed (DNS): ${message}`);
        await sleep(1500 * attempt);
        continue;
      }

      if (attempt === attempts) {
        console.error('✗ MongoDB connection failed (final attempt):', message);
      } else {
        // Harmless one-shot: if the error came from anywhere else in the
        // resolver stack, switching to OS DNS still gives retries the best
        // chance (no-op once the pin has already been dropped).
        restoreOsDns();
        console.warn(`⏳ MongoDB connection attempt ${attempt}/${attempts} failed: ${message}`);
        await sleep(1500 * attempt);
      }
    }
  }

  if (mongoose.connection.readyState === 1) return true;

  // Fallback only applies to DNS-class failures.
  if (isDns) {
    const directUri = await buildDirectUriFromSrv(uri);
    if (directUri) {
      console.log('⚙️  SRV lookup flaky — retrying via directly-resolved MongoDB hosts…');
      try {
        await mongoose.connect(directUri, options);
        console.log(`✓ MongoDB connected (direct): ${mongoose.connection.name}`);
        return true;
      } catch (error) {
        console.error('✗ MongoDB connection failed (direct fallback):', error.message || error);
        lastError = error;
      }
    }
  }

  const message = lastError && lastError.message ? lastError.message : 'MongoDB connection failed';
  if (isDns) printDnsHints();
  else if (isAuthFailure(message)) printAuthHints();
  else printConnectionHints(message);

  throw lastError || new Error(message);
};

/**
 * Is this failure the database being briefly unreachable, as opposed to a bug
 * in the request or the code?
 *
 * This distinction matters because the two must not be reported the same way.
 * Every authenticated route resolves the caller with a single User lookup in
 * the auth middleware, so a dropped Atlas link or an exhausted pool fails ALL
 * of them at once - which is exactly how a connectivity blip showed up as a
 * wall of unrelated 500s on the dashboards. Reporting these as 503 + retryable
 * tells the client (and the operator) that the request was never bad and that
 * simply asking again is the right move.
 *
 * Never returns true for CastError / ValidationError / duplicate-key: those are
 * real problems with the request and must keep their own status codes.
 */
const TRANSIENT_DB_MARKERS = [
  // Mongoose gave up buffering a query because the connection was not ready.
  'buffering timed out',
  'buffered operations',
  // The driver could not pick a reachable server, or lost the one it had.
  'server selection',
  'failed to connect',
  'connection closed',
  'connection was closed',
  'connection pool',
  'pool is closed',
  'topology is closed',
  'topology was destroyed',
  'not connected',
  // Raised when an operation is attempted on a client that is down - the
  // immediate symptom of a dropped link, before any timeout can elapse.
  'must be connected before running operations',
  'no primary found',
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'etimedout',
  'socket hang up',
  'network',
  'timed out',
  'serverselection',
  'mongosdown',
];

/**
 * Driver errors that always mean "the connection is unusable right now".
 *
 * Matching on the error name as well as the message matters: a dropped socket
 * surfaces as `MongoNotConnectedError` whose text varies between driver
 * versions, and classifying by name is what keeps it from being mistaken for a
 * fault in the endpoint. `MongoServerError` is deliberately absent - it is the
 * base class for genuine server complaints such as a duplicate key, which must
 * keep their real status.
 */
const TRANSIENT_DB_ERROR_NAMES = new Set([
  'MongoNotConnectedError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoPoolClearedError',
  'MongoTopologyClosedError',
  'MongoTopologyDestroyedError',
  'MongoExpiredSessionError',
  'MongoClientClosedError',
]);

const isTransientDbError = (error) => {
  if (!error) return false;
  if (TRANSIENT_DB_ERROR_NAMES.has(error.name)) return true;
  // These are definitively request/data problems, so they are never transient
  // regardless of how their message happens to be worded.
  if (
    error.name === 'CastError' ||
    error.name === 'ValidationError' ||
    error.name === 'MongoServerError' ||
    error.code === 11000
  ) {
    return false;
  }
  const message = String(error.message || '').toLowerCase();
  return TRANSIENT_DB_MARKERS.some((marker) => message.includes(marker));
};

module.exports = connectDatabase;
module.exports.isTransientDbError = isTransientDbError;
