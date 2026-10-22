// Authenticated end-to-end probe against the user's LIVE :5000 server using
// its own .env (JWT secret + Mongo URI): upsert a disposable cafeteria_admin,
// mint a token exactly like the server does, then run the browser's exact
// request sequence. Cleans up afterwards.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Load the live server's env BEFORE anything else reads process.env.
const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const API = `http://127.0.0.1:${process.env.PORT || 5000}/api/v1`;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const User = require('./src/models/User');
  const email = `daterangeprobe${Date.now()}@probe.test`;
  const user = await User.create({
    name: 'DateRange Probe', email, phone: '09' + String(Date.now()).slice(-8),
    password: 'probe-not-used-via-api', role: 'cafeteria_admin', status: 'ACTIVE', isActive: true,
  });
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  console.log(`  probe admin created (${email})`);

  let failed = 0;
  const check = (name, cond, detail) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!cond) failed++;
  };

  // The browser's exact sequence: initial 7d load (Promise.all of 4), then
  // clicking 30D and 90D (single dashboard re-fetch each).
  const h = { Authorization: `Bearer ${token}` };
  const load = async (days) => {
    const [dash, orders, payments, feedback] = await Promise.all([
      fetch(`${API}/admin/dashboard?days=${days}`, { headers: h }),
      fetch(`${API}/admin/dashboard/recent-orders?limit=6`, { headers: h }),
      fetch(`${API}/admin/dashboard/recent-payments?limit=6`, { headers: h }),
      fetch(`${API}/feedback/stats`, { headers: h }),
    ]);
    const body = await dash.json().catch(() => ({}));
    return { statuses: [dash.status, orders.status, payments.status, feedback.status], body };
  };

  for (const days of [7, 30, 90]) {
    const { statuses, body } = await load(days);
    check(`browser load cycle at days=${days} -> all four endpoints HTTP 200`, statuses.every((s) => s === 200), `statuses=${statuses.join(',')}`);
    if (days === 7) {
      const chart = body.data && body.data.chart;
      check('response carries chart.days=7 + 7 series buckets', !!chart && chart.days === 7 && Array.isArray(chart.series) && chart.series.length === 7, JSON.stringify(chart && { days: chart.days, buckets: chart.series && chart.series.length }));
      check('doughnut counts are range-scoped (ordersInRange present)', !!(chart && chart.ordersInRange), chart && Object.keys(chart.ordersInRange || {}).join(','));
    }
    if (days === 30) {
      const chart = body.data && body.data.chart;
      check('clicking 30D returns chart.days=30 + 30 buckets', !!chart && chart.days === 30 && chart.series.length === 30);
    }
  }

  // No 429 even under rapid repetition (the failure mode the user hit).
  const codes = [];
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${API}/admin/dashboard?days=7`, { headers: h });
    codes.push(r.status);
    await r.text();
  }
  check('40 rapid dashboard calls: zero 429s', codes.every((c) => c === 200), `codes=${[...new Set(codes)].join(',')}`);

  await User.deleteOne({ _id: user._id });
  await mongoose.disconnect();
  console.log(`\n${failed === 0 ? 'ALL OK - Date Range works end-to-end on the live server' : failed + ' FAILED'}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
