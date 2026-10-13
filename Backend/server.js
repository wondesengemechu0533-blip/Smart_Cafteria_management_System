require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const connectDatabase = require('./src/config/database');
const paymentRoutes = require('./src/routes/payment.routes');
const orderRoutes = require('./src/routes/order.routes');
const kitchenRoutes = require('./src/routes/kitchen.routes');
const kitchenStaffRoutes = require('./src/routes/kitchen-staff.routes');
const kitchenSettingsRoutes = require('./src/routes/kitchen-settings.routes');
const userRoutes = require('./src/routes/user.routes');
const menuRoutes = require('./src/routes/menu.routes');
const categoryRoutes = require('./src/routes/category.routes');
const reportRoutes = require('./src/routes/report.routes');
const feedbackRoutes = require('./src/routes/feedback.routes');
const cancellationRoutes = require('./src/routes/cancellation.routes');
const notificationRoutes = require('./src/routes/notification.routes');
const adminRoutes = require('./src/routes/admin.routes');
const adminCategoryRoutes = require('./src/routes/admin.category.routes');
const adminTableRoutes = require('./src/routes/admin.table.routes');
const adminMenuRoutes = require('./src/routes/admin.menu.routes');
const adminReportRoutes = require('./src/routes/admin.reports.routes');
const adminOrderRoutes = require('./src/routes/admin.order.routes');
const adminPaymentRoutes = require('./src/routes/admin.payments.routes');
const publicSettingsRoutes = require('./src/routes/public.settings.routes');
const authRoutes = require('./src/routes/auth.routes');
const deliveryRoutes = require('./src/routes/delivery.routes');
const deliveryTrackingRoutes = require('./src/routes/delivery-tracking.routes');
const deliveryIssueRoutes = require('./src/routes/deliveryIssue.routes');
const refundRoutes = require('./src/routes/refund.routes');
const cashierRoutes = require('./src/routes/cashier.routes');
const cafeteriaRoutes = require('./src/routes/cafeteria.routes');
const cafeteriaReportRoutes = require('./src/routes/cafeteria.reports.routes');
const issueReportRoutes = require('./src/routes/issueReport.routes');
const { ensureDefaultSettings } = require('./src/utils/settings');
const { ensureDefaultCategories } = require('./src/utils/categories');
const { ensureDefaultKitchenShifts } = require('./src/utils/kitchenShifts');
const { ensureDefaultCafeteria } = require('./src/utils/cafeteria');
const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');
const { setupSocketIO } = require('./src/socket');

const app = express();
const port = Number(process.env.PORT || 5000);

// Behind a reverse proxy (Render, nginx...) every request looks like it comes
// from the proxy's own IP unless Express trusts X-Forwarded-For. Without this,
// express-rate-limit buckets ALL users under one IP and the whole site is
// blocked with "Too many requests" as soon as that single bucket fills.
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

const allowedOrigins = (
  process.env.CORS_ORIGIN ||
  'http://localhost:5500,http://127.0.0.1:5500,http://localhost:5501,http://127.0.0.1:5501,http://localhost:5000,http://127.0.0.1:5000'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
});

setupSocketIO(io);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  })
);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_API_MAX) || 300,
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  // Never let the shared API bucket block authentication. Login has its own
  // dedicated limiter (loginLimiter) and every other /auth route is guarded by
  // authApiLimiter, so auth should only ever be limited by those.
  skip: (req) => {
    if (req.path.startsWith('/auth')) return true;

    // The delivery/notification UIs poll these read-only endpoints to show live
    // work; counting them against the global API cap quickly returns 429 for
    // normal usage and takes the rider offline even though the backend is up.
    const polled = new Set([
      '/deliveries/mine',
      '/deliveries/available',
      '/deliveries/my-history',
      '/notifications/unread',
      '/orders/my-orders',
      '/orders/active',
      '/orders/active-order',
      '/delivery-issues/meta/types',
    ]);
    return polled.has(req.path);
  },
});

// Brute-force guard for the login endpoint only. Keeping this on /auth/login
// alone means a handful of failed logins never blocks the rest of the account
// API (profile reads/saves, register, change-password, etc.).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_LOGIN_MAX) || 20,
  message: { success: false, error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Reasonable guard for the remaining auth routes so an active customer/admin is
// never locked out while browsing or saving their profile.
const authApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX) || 60,
  message: { success: false, error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/assets', express.static(path.join(__dirname, '../Frontend/public/assets')));

// In production, serve the frontend static files from the Backend root so
// one Render service hosts everything.  Requests that don't match an API
// route or a static file are sent to index.html (SPA-style fallback).
if (process.env.NODE_ENV === 'production') {
  const frontendPath = path.join(__dirname, '..', 'Frontend');
  app.use(express.static(frontendPath));

  // Redirect root to the login page
  app.get('/', (req, res) => {
    res.redirect('/Frontend/src/pages/common/login.html');
  });

  // Catch-all: serve the login page for any unmatched route so deep links
  // from the frontend work without a 404 from Express.
  app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(frontendPath, 'src', 'pages', 'common', 'login.html'));
  });
}

// Reports the database state too. Every authenticated route starts with a User
// lookup, so "the API is up but Mongo is not" is a real and very confusing state
// to be in - it looks like the whole API is broken. Surfacing readyState here
// makes the two situations distinguishable at a glance.
app.get('/health', (req, res) => {
  const mongoose = require('mongoose');
  const readyState = mongoose.connection.readyState; // 1 = connected
  const databaseUp = readyState === 1;
  res.status(databaseUp ? 200 : 503).json({
    success: databaseUp,
    service: 'smart-cafeteria-backend',
    database: databaseUp ? 'connected' : 'disconnected',
  });
});

app.use('/api/v1', apiLimiter);

// Login gets its own tight limiter; everything else under /auth is guarded by a
// more permissive limiter so legitimate profile/account calls aren't blocked.
// Guard OTP sending so an attacker cannot SMS-bomb a phone/email.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many verification code requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/v1/auth/login', loginLimiter);
app.post('/api/v1/auth/send-otp', otpLimiter);
app.use('/api/v1/auth', authApiLimiter, authRoutes);

app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/kitchen', kitchenRoutes);
app.use('/api/v1/kitchen/settings', kitchenSettingsRoutes);
app.use('/api/v1/kitchen-staff', kitchenStaffRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/admin/users', userRoutes);
app.use('/api/v1/menu', menuRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/feedback', feedbackRoutes);
app.use('/api/v1/cancellations', cancellationRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/admin/categories', adminCategoryRoutes);
app.use('/api/v1/admin/tables', adminTableRoutes);
app.use('/api/v1/admin/menu', adminMenuRoutes);
app.use('/api/v1/admin/orders', adminOrderRoutes);
app.use('/api/v1/admin/payments', adminPaymentRoutes);
app.use('/api/v1/admin/reports', adminReportRoutes);
app.use('/api/v1/deliveries', deliveryRoutes);
// Order-scoped alias of the delivery GPS endpoints
// (PUT /api/v1/delivery/orders/:orderId/location). Same handler, same auth.
app.use('/api/v1/delivery/orders', deliveryTrackingRoutes);
app.use('/api/v1/delivery-issues', deliveryIssueRoutes);
app.use('/api/v1/refunds', refundRoutes);
app.use('/api/v1/cashier', cashierRoutes);
app.use('/api/v1/cafeterias', cafeteriaRoutes);
app.use('/api/v1/cafeteria/reports', cafeteriaReportRoutes);
app.use('/api/v1/settings', publicSettingsRoutes);
app.use('/api/v1/issues', issueReportRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

const start = async () => {
  try {
    console.log('\n🚀 Starting Smart Cafeteria Backend...');
    console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);

    console.log('🔌 Connecting to MongoDB...');
    await connectDatabase();

    console.log('⚙️  Initializing settings...');
    await ensureDefaultSettings();
    await ensureDefaultCategories();
    await ensureDefaultKitchenShifts();
    await ensureDefaultCafeteria();

    // The backend MUST always run on the configured PORT (default 5000)
    // because the frontend API client is hardcoded to it. Do NOT fall
    // back to a different port, otherwise the frontend and Chapa
    // callback URL break silently.
    return new Promise((resolve, reject) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`\n✗ Port ${port} is already in use.`);
          console.error(`  The frontend expects the backend on http://localhost:${port}.`);
          console.error(`  Please free port ${port} (e.g. close the other process) and restart.\n`);
        }
        reject(err);
      });
      server.once('listening', () => {
        console.log(`✓ Backend listening on port ${port}`);
        console.log(`✓ Health check: http://localhost:${port}/health`);
        console.log(`✓ API base: http://localhost:${port}/api/v1`);
        console.log('✓ Backend ready in < 1 second!\n');
        resolve();
      });
      server.listen(port);
    });
  } catch (error) {
    console.error('\n✗ Backend startup failed:', error.message);
    process.exitCode = 1;
    throw error;
  }
};

if (require.main === module) {
  start().catch((error) => {
    process.exitCode = 1;
  });
}

// `server` and `io` are exported alongside `app` so integration tests can bind
// the REAL http server (with the real Socket.IO handler attached). Creating a
// bare `http.createServer(app)` bypasses the /socket.io/ endpoint, so realtime
// assertions against such a server would silently 404.
module.exports = { app, start, server, io };
