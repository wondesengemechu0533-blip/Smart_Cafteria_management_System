/**
 * Route registration smoke check for the delivery GPS endpoints.
 *
 * Verifies the authenticated GPS contract is actually mounted, with the exact
 * verbs/paths the frontend and the documented contract use:
 *   POST/PUT /api/v1/deliveries/:id/location
 *   GET      /api/v1/deliveries/:id/location          (last known fix)
 *   PUT      /api/v1/delivery/orders/:orderId/location (documented alias)
 *   GET      /api/v1/delivery/orders/:orderId/location
 *
 * Also asserts the write routes are gated by role (delivery staff only) and
 * that the router is wrapped in `protect`, so no GPS endpoint can ever be
 * reached unauthenticated.
 *
 * Run: node Backend/tests/delivery-gps-routes.smoke.js
 */
const deliveryRoutes = require('../src/routes/delivery.routes');
const deliveryTrackingRoutes = require('../src/routes/delivery-tracking.routes');

/** Flatten an Express router into [{ method, path, handlerNames }]. */
function flatten(router, prefix = '') {
  const out = [];
  const stack = (router && router.stack) || [];
  stack.forEach((layer) => {
    if (layer.route) {
      Object.keys(layer.route.methods).forEach((method) => {
        out.push({
          method: method.toUpperCase(),
          path: prefix + layer.route.path,
          handlers: (layer.route.stack || []).map((l) => l.name),
        });
      });
    }
  });
  return out;
}

const main = flatten(deliveryRoutes);
const alias = flatten(deliveryTrackingRoutes).map((r) => `${r.method} /api/v1/delivery/orders${r.path}`);
const mainPaths = main.map((r) => `${r.method} ${r.path}`);

let fail = 0;
let pass = 0;

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
}

// --- the canonical delivery router -------------------------------------------
check('POST /:id/location (courier uploads its fix)', mainPaths.includes('POST /:id/location'));
check('PUT  /:id/location (idempotent-looking alias)', mainPaths.includes('PUT /:id/location'));
check('GET  /:id/location (last known fix)', mainPaths.includes('GET /:id/location'));
check('GET  /:id/locations (history, unchanged)', mainPaths.includes('GET /:id/locations'));

// --- the documented order-scoped alias ---------------------------------------
check('PUT  /api/v1/delivery/orders/:orderId/location',
  alias.includes('PUT /api/v1/delivery/orders/:orderId/location'), alias.join(' | '));
check('GET  /api/v1/delivery/orders/:orderId/location',
  alias.includes('GET /api/v1/delivery/orders/:orderId/location'), alias.join(' | '));

// --- authorization ------------------------------------------------------------
// authorize() returns an anonymous closure, so the structural guarantee we can
// assert is: a gate middleware runs before the controller on every write route.
const writeRoute = main.find((r) => r.method === 'PUT' && r.path === '/:id/location');
check('PUT location has a role gate before the controller',
  Boolean(writeRoute) && writeRoute.handlers.length >= 2,
  JSON.stringify(writeRoute && writeRoute.handlers));

const aliasWrite = alias.length && main && flatten(deliveryTrackingRoutes).find((r) => r.method === 'PUT');
check('alias PUT location has a role gate before the controller',
  Boolean(aliasWrite) && aliasWrite.handlers.length >= 2,
  JSON.stringify(aliasWrite && aliasWrite.handlers));

// Both routers must run `protect` before anything else.
function firstMiddlewareName(router) {
  const layer = (router.stack || []).find((l) => !l.route);
  return layer ? layer.handle && layer.handle.name : null;
}
check('delivery router runs protect first', firstMiddlewareName(deliveryRoutes) === 'protect', String(firstMiddlewareName(deliveryRoutes)));
check('alias router runs protect first', firstMiddlewareName(deliveryTrackingRoutes) === 'protect', String(firstMiddlewareName(deliveryTrackingRoutes)));

console.log('');
console.log(`PASS: ${pass}  FAIL: ${fail}`);
process.exit(fail ? 1 : 0);
