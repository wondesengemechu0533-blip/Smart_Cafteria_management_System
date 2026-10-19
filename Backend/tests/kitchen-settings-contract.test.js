/**
 * Kitchen settings - the form and the API must agree on field NAMES.
 *
 * WHY this exists: settings.js collects the page as
 * stationName / generalNotificationSound / autoRefreshEnabled /
 * autoRefreshInterval, while KitchenSetting.js stores
 * station / notificationSound / autoRefresh / refreshInterval.
 *
 * The controller's old allow-list only knew the STORED names, so the four
 * mismatched keys were dropped without a word. The page then showed "Settings
 * saved successfully" while persisting nothing - type a station name, reload,
 * and "Station 1" is back. Silent data loss behind a success toast.
 *
 * Two directions are asserted, because either one alone is a weak test:
 *   1. the form's names must be saved (the bug)
 *   2. the stored names must keep working (no breaking older clients)
 * plus: an unknown field must be REPORTED, never quietly swallowed - that is
 * what let the original mismatch stay invisible.
 *
 * Run: node Backend/tests/kitchen-settings-contract.test.js
 */
const assert = require('assert');
const Module = require('module');

let pass = 0;
let fail = 0;
const pendingChecks = [];
function check(name, fn) {
  pendingChecks.push((async () => {
    try { await fn(); pass++; console.log('  PASS ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -- ' + e.message); }
  })());
}

/** A stand-in for the mongoose document: settable fields + save(). */
function makeDoc(existing) {
  const doc = Object.assign({
    station: 'Station 1',
    notificationSound: true,
    orderAlertSound: true,
    preparationTimerAlert: true,
    autoRefresh: true,
    refreshInterval: 30,
    showCompletedOrders: false,
  }, existing || {});
  doc.saved = false;
  doc.save = async function () { doc.saved = true; return doc; };
  return doc;
}

function loadController(doc) {
  const originalLoad = Module._load;
  const stubs = {
    '../models/KitchenSetting': {
      findOne: async () => doc,
      create: async () => doc,
    },
  };
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.apply(this, arguments);
  };
  const p = require.resolve('../src/controllers/kitchen-settings.controller.js');
  delete require.cache[p];
  let controller;
  try { controller = require(p); }
  finally { Module._load = originalLoad; }
  return controller;
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

/** Exactly what settings.js collectForm() builds. */
const FORM_PAYLOAD = {
  stationName: 'GRILL STATION 9',
  orderAlertSound: false,
  preparationTimerAlert: false,
  generalNotificationSound: false,
  autoRefreshEnabled: false,
  autoRefreshInterval: 60,
  showCompletedOrders: true,
};

(async () => {
  console.log('========== KITCHEN SETTINGS CONTRACT ==========');
  console.log('');

  /* --- the form's names must actually persist ------------------------------ */
  {
    const doc = makeDoc();
    const controller = loadController(doc);
    const res = fakeRes();
    await controller.updateKitchenSettings(
      { user: { id: 'u1' }, body: { ...FORM_PAYLOAD } }, res);

    check('the form payload is accepted', () => assert.strictEqual(res.statusCode, 200));

    [
      ['stationName -> station', doc.station, 'GRILL STATION 9'],
      ['generalNotificationSound -> notificationSound', doc.notificationSound, false],
      ['autoRefreshEnabled -> autoRefresh', doc.autoRefresh, false],
      ['autoRefreshInterval -> refreshInterval', doc.refreshInterval, 60],
      ['orderAlertSound', doc.orderAlertSound, false],
      ['preparationTimerAlert', doc.preparationTimerAlert, false],
      ['showCompletedOrders', doc.showCompletedOrders, true],
    ].forEach(([name, got, want]) => {
      check(name + ' is persisted', () =>
        assert.deepStrictEqual(got, want, `stored ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`));
    });

    check('the document is actually saved', () => assert.strictEqual(doc.saved, true));

    check('every renamed field is echoed in appliedFields', () => {
      const applied = res.body.appliedFields || [];
      ['stationName -> station', 'generalNotificationSound -> notificationSound',
        'autoRefreshEnabled -> autoRefresh', 'autoRefreshInterval -> refreshInterval']
        .forEach((m) => assert.ok(applied.includes(m), `missing "${m}" in ${JSON.stringify(applied)}`));
    });

    check('nothing is reported as ignored', () =>
      assert.ok(!res.body.ignoredFields || res.body.ignoredFields.length === 0,
        JSON.stringify(res.body.ignoredFields)));
  }

  /* --- the stored names must keep working ---------------------------------- */
  {
    const doc = makeDoc();
    const controller = loadController(doc);
    const res = fakeRes();
    await controller.updateKitchenSettings(
      { user: { id: 'u1' }, body: { station: 'LEGACY', refreshInterval: 45, autoRefresh: false } }, res);
    check('canonical field names still save', () => {
      assert.strictEqual(doc.station, 'LEGACY');
      assert.strictEqual(doc.refreshInterval, 45);
      assert.strictEqual(doc.autoRefresh, false);
    });
    check('a canonical name is not reported as renamed', () =>
      assert.deepStrictEqual(res.body.appliedFields || [], []));
  }

  /* --- unknown fields must be reported, never swallowed -------------------- */
  {
    const doc = makeDoc();
    const controller = loadController(doc);
    const res = fakeRes();
    await controller.updateKitchenSettings(
      { user: { id: 'u1' }, body: { station: 'X', totalNonsense: 1 } }, res);
    check('an unknown field is reported back to the client', () =>
      assert.ok((res.body.ignoredFields || []).includes('totalNonsense'),
        'an unrecognised key was silently dropped again'));
    check('a reported field is still not written', () => {
      assert.strictEqual(doc.totalNonsense, undefined);
      assert.strictEqual(doc.station, 'X', 'the known field alongside it was not saved');
    });
  }

  /* --- the GET side must return the stored names --------------------------- */
  {
    const doc = makeDoc({ station: 'GRILL STATION 9', refreshInterval: 60 });
    const controller = loadController(doc);
    const res = fakeRes();
    await controller.getKitchenSettings({ user: { id: 'u1' } }, res);
    check('GET returns the canonical stored names', () => {
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.settings.station, 'GRILL STATION 9');
      assert.strictEqual(res.body.settings.refreshInterval, 60);
    });
  }

  /* --- the alias table matches the page ------------------------------------- */
  check('every form field has a mapping or is already canonical', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'controllers', 'kitchen-settings.controller.js'), 'utf8');
    const aliasBlock = src.slice(src.indexOf('const FIELD_ALIASES'), src.indexOf('};', src.indexOf('const FIELD_ALIASES')));
    const aliases = [...aliasBlock.matchAll(/(\w+):\s*'(\w+)'/g)].reduce((a, m) => (a[m[1]] = m[2], a), {});
    // The keys the form sends.
    ['orderAlertSound', 'preparationTimerAlert', 'showCompletedOrders'].forEach((k) =>
      assert.ok(!aliases[k], `${k} should be canonical, not an alias`));
    ['stationName', 'generalNotificationSound', 'autoRefreshEnabled', 'autoRefreshInterval'].forEach((k) =>
      assert.ok(aliases[k], `${k} is sent by the form but has no alias mapping`));
  });

  await Promise.all(pendingChecks);

  console.log('');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });