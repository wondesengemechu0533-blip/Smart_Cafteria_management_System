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
const kitchenReportsRoutes = require('./src/routes/kitchen-reports.routes');
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
const adminMenuRoutes = require('./src/routes/admin.menu.routes');
const adminOrderRoutes = require('./src/routes/admin.order.routes');
const adminPaymentRoutes = require('./src/routes/admin.payments.routes');
const adminReportRoutes = require('./src/routes/admin.reports.routes');
const publicSettingsRoutes = require('./src/routes/public.settings.routes');
const authRoutes = require('./src/routes/auth.routes');
const deliveryRoutes = require('./src/routes/delivery.routes');
const { ensureDefaultSettings } = require('./src/utils/settings');
const { ensureDefaultCategories } = require('./src/utils/categories');
const { errorHandler, notFoundHandler } = require('./src/middleware/errorHandler');
const { setupSocketIO } = require('./src/socket');

const app = express();
const port = Number(process.env.PORT || 5000);

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5500,http://127.0.0.1:5500,http://localhost:5501,http://127.0.0.1:5501,http://localhost:5000,http://127.0.0.1:5000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization']
    }
});

setupSocketIO(io);

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { success: false, error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Brute-force guard for the login endpoint only. Keeping this on /auth/login
// alone means a handful of failed logins never blocks the rest of the account
// API (profile reads/saves, register, change-password, etc.).
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, error: 'Too many login attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
});

// Reasonable guard for the remaining auth routes so an active customer/admin is
// never locked out while browsing or saving their profile.
const authApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { success: false, error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false
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

app.get('/health', (req, res) => res.json({ success: true, service: 'smart-cafeteria-backend' }));

app.use('/api/v1', apiLimiter);

// Login gets its own tight limiter; everything else under /auth is guarded by a
// more permissive limiter so legitimate profile/account calls aren't blocked.
app.post('/api/v1/auth/login', loginLimiter);
app.use('/api/v1/auth', authApiLimiter, authRoutes);

app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/kitchen', kitchenRoutes);
app.use('/api/v1/kitchen/settings', kitchenSettingsRoutes);
app.use('/api/v1/kitchen-staff', kitchenStaffRoutes);
app.use('/api/v1/kitchen', kitchenReportsRoutes);
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
app.use('/api/v1/admin/menu', adminMenuRoutes);
app.use('/api/v1/admin/orders', adminOrderRoutes);
app.use('/api/v1/admin/payments', adminPaymentRoutes);
app.use('/api/v1/admin/reports', adminReportRoutes);
app.use('/api/v1/deliveries', deliveryRoutes);
app.use('/api/v1/settings', publicSettingsRoutes);

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

        // Auto-fix: repair any menu items stuck with stock=0 or stale availabilityStatus
        const MenuItem = require('./src/models/MenuItem');
        const fixResult = await MenuItem.updateMany(
          { isActive: true, availability: true, isAvailable: true, $or: [{ stockQuantity: 0 }, { availabilityStatus: { $ne: 'AVAILABLE' } }] },
          { $set: { stockQuantity: 50, availabilityStatus: 'AVAILABLE' } }
        );
        if (fixResult.modifiedCount > 0) {
          console.log(`🔧 Auto-fixed ${fixResult.modifiedCount} menu item(s) — stock set to 50, status AVAILABLE`);
        }

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

module.exports = { app, start };