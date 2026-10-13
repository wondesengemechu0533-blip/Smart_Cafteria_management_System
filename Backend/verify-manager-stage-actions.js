/**
 * The manager delivery actions must match the delivery state machine exactly.
 *
 * This is a cross-boundary contract: admin-deliveries.js decides which button a
 * cafeteria manager may click, and delivery.service.js decides which status
 * changes are legal. They are two files in two layers that never talk to each
 * other, so they drift silently - and the symptom is a button that is always
 * rejected by the server.
 *
 * That is not hypothetical. "Mark Delivered" used to be offered at
 * OUT_FOR_DELIVERY, skipping ARRIVED, so it could only ever fail with
 * "Out for delivery cannot move to Delivered". Markers get no transition
 * bypass: assertTransition() throws for a manager too, it only returns a
 * friendlier message.
 *
 * Rather than re-describe the rules, this extracts the REAL actionButtons()
 * source out of the page script and runs it, then checks every offered button
 * against the REAL DELIVERY_TRANSITIONS table and the REAL route table.
 *
 * Run: node verify-manager-stage-actions.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const adminDeliveries = fs.readFileSync(
  path.join(ROOT, 'Frontend', 'src', 'js', 'admin-deliveries.js'),
  'utf8'
);
const service = fs.readFileSync(path.join(__dirname, 'src', 'services', 'delivery.service.js'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, 'src', 'routes', 'delivery.routes.js'), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
  }
}

/** Slice a named function out of a source file, brace-balanced. */
function sliceFunction(src, name) {
  const at = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  assert.ok(at >= 0, `${name}() not found in admin-deliveries.js`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error('could not balance braces for ' + name);
}

// --- the real backend transition table -------------------------------------
const tableSrc = sliceFunction(service, 'assertTransition'); // just to prove the file parses
assert.ok(tableSrc);
const transitionsBlock = /const DELIVERY_TRANSITIONS = \{([\s\S]*?)\n\};/.exec(service);
assert.ok(transitionsBlock, 'DELIVERY_TRANSITIONS not found in delivery.service.js');
const TRANSITIONS = {};
for (const line of transitionsBlock[1].split('\n')) {
  const m = /^\s*([A-Z_]+):\s*\[([^\]]*)\]/.exec(line);
  if (!m) continue;
  TRANSITIONS[m[1]] = m[2]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

// --- the real frontend button renderer --------------------------------------
const actionSrc = sliceFunction(adminDeliveries, 'actionButtons');
const normalizeSrc = sliceFunction(adminDeliveries, 'normalizeStatus');

// Run the page's own code, with only its two helpers injected.
const actionButtons = new Function(
  'normalizeStatus',
  'window',
  'tr',
  normalizeSrc + '\n' + actionSrc + '\nreturn actionButtons;'
)(
  new Function('return ' + normalizeSrc)(),
  { esc: (s) => String(s) },
  (k, f) => f
);

console.log('\nManager actions follow the delivery state machine');

check('every offered action is a transition the server actually allows', () => {
  // Button label -> the status the backend ends up in.
  const TARGET = {
    'Out for Delivery': 'OUT_FOR_DELIVERY',
    'Mark Arrived': 'ARRIVED',
    'Mark Delivered': 'DELIVERED',
    'Mark Completed': 'COMPLETED',
  };
  for (const from of Object.keys(TRANSITIONS)) {
    const order = { status: from };
    const html = actionButtons(order);
    const label = (html.match(/>([^<>]+)<\/button>/) || [])[1];
    if (!label) continue; // no button offered from this state
    const to = TARGET[label];
    assert.ok(to, `unknown action button "${label}" offered from ${from}`);
    assert.ok(
      (TRANSITIONS[from] || []).includes(to),
      `"${label}" (${from} -> ${to}) is not allowed; the server allows ${from} -> ${(TRANSITIONS[from] || []).join(', ')}`
    );
  }
});

check('the manager chain is reachable from PICKED_UP onwards', () => {
  // Not every state offers an action button, and that is correct:
  //   REQUESTED / ASSIGNED / ACCEPTED -> the manager assigns a courier through
  //     the staff dropdown (its own column); accepting and picking up are the
  //     courier's own transitions, which this page must not offer to fake.
  //   PICKED_UP onwards -> the manager advances the delivery itself.
  const chain = ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED'];
  const missing = chain.filter((s) => !/<button/.test(actionButtons({ status: s })));
  assert.deepStrictEqual(missing, [], 'no action offered from: ' + missing.join(', '));
});

check('the pre-pickup states deliberately offer no action button', () => {
  // A manager must not be able to fake a courier's accept/pickup.
  for (const s of ['REQUESTED', 'ASSIGNED', 'ACCEPTED']) {
    assert.ok(!/<button/.test(actionButtons({ status: s })), `${s} must not offer an action`);
  }
});

check('those states are covered by the assignment control instead', () => {
  const staffSrc = sliceFunction(adminDeliveries, 'staffSelectHtml');
  assert.ok(/delivery-staff-select/.test(staffSrc), 'the assignment select is gone');
  assert.ok(
    adminDeliveries.includes('staffSelectHtml(order)'),
    'the assignment select is no longer rendered in the deliveries row'
  );
});

check('ARRIVED is offered its own action (this is what was missing)', () => {
  const html = actionButtons({ status: 'ARRIVED' });
  assert.ok(/arrived-action/.test(html) === false, 'ARRIVED must not offer Mark Arrived');
  assert.ok(/delivered-action/.test(html), 'ARRIVED must offer Mark Delivered');
});

check('Mark Delivered is NOT offered at OUT_FOR_DELIVERY (it skips ARRIVED)', () => {
  const html = actionButtons({ status: 'OUT_FOR_DELIVERY' });
  assert.ok(!/delivered-action/.test(html), 'offering Delivered here would always be rejected');
  assert.ok(/arrived-action/.test(html), 'OUT_FOR_DELIVERY must offer Mark Arrived');
});

check('a terminal delivery offers nothing', () => {
  for (const s of TERMINAL) {
    const html = actionButtons({ status: s });
    assert.ok(!/<button/.test(html), `${s} must not offer any action`);
  }
});

check('a fully delivered order can still be completed', () => {
  // DELIVERED used to be treated as terminal by the button list, which is why
  // COMPLETED was unreachable from the manager page.
  const html = actionButtons({ status: 'DELIVERED' });
  assert.ok(/completed-action/.test(html), 'DELIVERED must offer Mark Completed');
});

console.log('\nEvery button reaches a real endpoint');

check('each action class is wired to a click handler', () => {
  const handlerSrc = adminDeliveries.slice(adminDeliveries.indexOf('document.addEventListener("click"'));
  const CLASSES = ['out-delivery-action', 'arrived-action', 'delivered-action', 'completed-action'];
  for (const c of CLASSES) {
    assert.ok(new RegExp('closest\\("\\.' + c + '"\\)').test(handlerSrc), `${c} has no click handler`);
  }
});

check('each handler calls an endpoint that exists in the route table', () => {
  const CALLED = {
    markOutForDelivery: 'out-for-delivery',
    markArrived: 'arrived',
    markDelivered: 'delivered',
    markCompleted: 'complete',
  };
  for (const [fn, suffix] of Object.entries(CALLED)) {
    const body = sliceFunction(adminDeliveries, fn);
    assert.ok(
      body.includes('/' + suffix + '"'),
      `${fn}() does not call the /${suffix} endpoint`
    );
    assert.ok(
      new RegExp("router\\.patch\\('/:\\w+/" + suffix + "'").test(routes),
      `no PATCH route for /:${suffix} in delivery.routes.js`
    );
  }
});

check('markDelivered sends a manager override with a non-empty reason', () => {
  // The server refuses a handover with no proof unless the manager overrides,
  // and an override with a blank reason is rejected outright
  // (OVERRIDE_REASON_REQUIRED). A button that sent {} could never succeed.
  const body = sliceFunction(adminDeliveries, 'markDelivered');
  assert.ok(/isManagerOverride:\s*true/.test(body), 'must send isManagerOverride: true');
  assert.ok(/overrideReason:/.test(body), 'must send overrideReason');
  assert.ok(
    /prompt\(/.test(body),
    'must collect the reason from the manager instead of letting the server reject the click'
  );
  assert.ok(
    !/"\/deliveries\/"\s*\+\s*encodeURIComponent\(orderId\)\s*\+\s*"\/delivered",\s*\{\s*\}/.test(body),
    'must not send an empty body'
  );
});

check('every route the buttons use is manager-authorised', () => {
  for (const suffix of ['arrived', 'delivered', 'complete']) {
    const re = new RegExp("router\\.patch\\('/:\\w+/" + suffix + "', authorize\\(([^)]*)\\)");
    const m = re.exec(routes);
    assert.ok(m, `${suffix} route is not role-restricted`);
    assert.ok(
      /STAFF_OR_MANAGEMENT/.test(m[1]),
      `${suffix} must be open to STAFF_OR_MANAGEMENT (which includes managers)`
    );
  }
});

check('the strings this change introduces exist in both locales', () => {
  const NEW_KEYS = [
    'admin_confirm_arrived',
    'admin_arrived_done',
    'admin_confirm_completed',
    'admin_completed_done',
    'admin_delivered_reason_prompt',
    'admin_delivered_reason_required',
  ];
  const locales = ['en', 'am'].map((lang) => ({
    lang,
    raw: fs.readFileSync(path.join(ROOT, 'Frontend', 'src', 'locales', lang + '.json'), 'utf8'),
  })).map(({ lang, raw }) => ({ lang, raw, json: JSON.parse(raw) }));

  for (const { lang, json } of locales) {
    for (const k of NEW_KEYS) {
      assert.ok(typeof json[k] === 'string' && json[k].trim(), `${k} missing from ${lang}.json`);
      assert.ok(
        !json[k].includes('\uFFFD'),
        `${k} in ${lang}.json contains a destroyed character (U+FFFD)`
      );
    }
  }
  const am = locales[1].json;
  for (const k of NEW_KEYS) {
    assert.ok(
      /[\u1200-\u137F]/.test(am[k]),
      `${k} has no Amharic text in am.json (looks untranslated)`
    );
  }
});

check('no NEW encoding damage in the locale files', () => {
  // A U+FFFD is always a character destroyed by a bad write; it can never be
  // intentional, and it renders as a black diamond.
  //
  // There is one PRE-EXISTING casualty, in `login_required_cart`, whose correct
  // Amharic cannot be reconstructed from the surrounding text without guessing.
  // It is pinned here rather than silently ignored, so any NEW damage - or a
  // fix for this one - is caught.
  const KNOWN_DAMAGED = { 'am.json': ['login_required_cart'] };
  for (const { lang, raw, json } of ['en', 'am'].map((l) => {
    const r = fs.readFileSync(path.join(ROOT, 'Frontend', 'src', 'locales', l + '.json'), 'utf8');
    return { lang: l, raw: r, json: JSON.parse(r) };
  })) {
    const damaged = Object.entries(json)
      .filter(([, v]) => typeof v === 'string' && v.includes('\uFFFD'))
      .map(([k]) => k);
    const expected = KNOWN_DAMAGED[lang + '.json'] || [];
    assert.deepStrictEqual(
      damaged.sort(),
      expected.slice().sort(),
      `encoding damage changed in ${lang}.json (now: ${damaged.join(', ') || 'none'})`
    );
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('Failed: ' + failures.join(', '));
process.exit(failures.length ? 1 : 0);