const bcrypt = require('bcryptjs');
const Order = require('../models/Order');
const User = require('../models/User');
const Payment = require('../models/Payment');
const MenuItem = require('../models/MenuItem');
const Category = require('../models/Category');
const Feedback = require('../models/Feedback');
const Setting = require('../models/Setting');
const ActivityLog = require('../models/ActivityLog');
const { HTTP_STATUS, MESSAGES, FEEDBACK_STATUS } = require('../config/constants');
const { normalizeRole } = require('../config/roles');
const { coerceValue, validateSettingValue, getSettingsMap, DEFAULT_SETTINGS } = require('../utils/settings');
// The audit trail is written for every settings change. This import was
// MISSING before, so `logAction` threw a ReferenceError INSIDE the try
// block of updateSetting: the setting was written to MongoDB, the audit call
// threw, and the endpoint answered 500 "Server error" - which looked to the
// frontend like the save had failed even though it had succeeded.
const { logAction } = require('../utils/audit');
const settingPermissions = require('../config/setting-permissions');

/**
 * @desc    Get admin dashboard aggregate stats (real MongoDB data)
 * @route   GET /api/v1/admin/dashboard
 * @access  Private/Admin
 * Frontend: admin/dashboard.html
 */
exports.getDashboardStats = async (req, res) => {
  try {
    // Chart window: the dashboard's 7D/30D/90D (and Custom) buttons send
    // ?days=N or ?startDate=...&endDate=... Bounded to 1..90 so a bogus value can never request an
    // unbounded scan; anything outside that falls back to the 7-day default.
    const requestedDays = parseInt(req.query.days, 10);
    const { startDate, endDate } = req.query;
    
    let days;
    let rangeStart;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (startDate && endDate) {
      // Custom date range
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
        // Fall back to 7 days if invalid
        days = 7;
        rangeStart = new Date(today);
        rangeStart.setDate(rangeStart.getDate() - (days - 1));
      } else {
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        rangeStart = start;
        // Count the CALENDAR days the range covers, inclusive of both ends.
        // `end` is already pushed to the last millisecond of its day, so the
        // span is (days - 1) whole days plus a sliver; floor() counts the
        // whole days and +1 adds the final day. ceil() would add a phantom
        // day for every custom range (a 3-day range reported 5 buckets).
        days = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;
        days = Math.min(Math.max(days, 1), 90); // Cap at 90 days
      }
    } else {
      days = Number.isInteger(requestedDays) && requestedDays >= 1 && requestedDays <= 90 ? requestedDays : 7;
      rangeStart = new Date(today);
      rangeStart.setDate(rangeStart.getDate() - (days - 1));
    }

    const FLOW = ['PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED'];

    // The stored feedback status values are 'PENDING' / 'RESOLVED' / 'ARCHIVED'.
    //
    // WHY the $in list and not FEEDBACK_STATUS.RESOLVED:
    // FEEDBACK_STATUS (config/constants.js) is keyed by the legacy approval
    // vocabulary - { PENDING: 'PENDING', APPROVED: 'RESOLVED', REJECTED:
    // 'ARCHIVED' } - so FEEDBACK_STATUS.RESOLVED is undefined. Querying with
    // it produced the filter { status: undefined }, which matched nothing and
    // reported "0 resolved" while the collection actually held 17 RESOLVED
    // documents. Matching the constant's VALUE and the literal token keeps
    // the count correct even if the constant's key is renamed later.
    const RESOLVED_FEEDBACK_STATUSES = [FEEDBACK_STATUS.APPROVED, 'RESOLVED'].filter(Boolean);
    const PENDING_FEEDBACK_STATUSES = [FEEDBACK_STATUS.PENDING, 'PENDING'].filter(Boolean);

    // Mirrors admin.order.controller's effectiveStatus so dashboard counts match
    // the admin orders table regardless of whether status is stored in the legacy
    // lowercase `status` field or the uppercase `orderStatus` field.
    function effectiveStatus(order) {
      const up = String(order.orderStatus || '').toUpperCase();
      const low = String(order.status || '').toUpperCase();
      if (up === 'CANCELLED' || low === 'CANCELLED') return 'CANCELLED';
      const ui = FLOW.indexOf(up);
      const li = FLOW.indexOf(low);
      if (ui === -1 && li === -1) return up || low || 'PENDING';
      if (ui === -1) return low;
      if (li === -1) return up;
      return ui >= li ? up : low;
    }

    const [
      totalUsers,
      customers,
      kitchenStaff,
      admins,
      cashiers,
      deliveries,
      totalMenu,
      availableMenu,
      unavailableMenu,
      successfulPayments,
      pendingPayments,
      failedPayments,
      pendingCancellations,
      // Feedback stats
      totalFeedback,
      pendingFeedback,
      resolvedFeedback,
      avgRating,
      ratingDistribution,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: 'customer' }),
      User.countDocuments({ role: 'kitchen' }),
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ role: 'cashier' }),
      User.countDocuments({ role: { $in: ['delivery'] } }),
      MenuItem.countDocuments(),
      MenuItem.countDocuments({ availability: true, isAvailable: true, stockQuantity: { $gt: 0 } }),
      MenuItem.countDocuments({ $or: [{ availability: false }, { isAvailable: false }, { stockQuantity: { $lte: 0 } }] }),
      Payment.countDocuments({ status: 'PAID' }),
      Payment.countDocuments({ status: 'PENDING' }),
      Payment.countDocuments({ status: 'FAILED' }),
      Order.countDocuments({ cancellationRequested: true, cancellationStatus: 'pending' }),
      Feedback.countDocuments(),
      Feedback.countDocuments({ status: { $in: PENDING_FEEDBACK_STATUSES } }),
      Feedback.countDocuments({ status: { $in: RESOLVED_FEEDBACK_STATUSES } }),
      (async () => {
        const result = await Feedback.aggregate([
          { $match: { rating: { $gte: 1, $lte: 5 } } },
          { $group: { _id: null, avg: { $avg: '$rating' } } },
        ]);
        return result.length > 0 ? Math.round(result[0].avg * 10) / 10 : 0;
      })(),
      Feedback.aggregate([
        { $match: { rating: { $gte: 1, $lte: 5 } } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
      ]),
    ]);

    const orders = await Order.find({}).select('status orderStatus paymentStatus totalAmount createdAt').lean();

    const totalOrders = orders.length;
    const pendingOrders = orders.filter((o) => effectiveStatus(o) === 'PENDING').length;
    const preparingOrders = orders.filter((o) => effectiveStatus(o) === 'PREPARING').length;
    const readyOrders = orders.filter((o) => effectiveStatus(o) === 'READY').length;
    const servedOrders = orders.filter((o) => effectiveStatus(o) === 'SERVED').length;
    const completedOrders = orders.filter((o) => effectiveStatus(o) === 'COMPLETED').length;
    const cancelledOrders = orders.filter((o) => effectiveStatus(o) === 'CANCELLED').length;

    // Order Status Overview doughnut: scoped to the selected 7D/30D/90D window
    // so the buttons on that card actually change what it shows.
    const rangeStartMs = rangeStart.getTime();
    const rangeEndMs = new Date(rangeStart).setDate(rangeStart.getDate() + days);
    const inRange = orders.filter((o) => o.createdAt && new Date(o.createdAt).getTime() >= rangeStartMs && new Date(o.createdAt).getTime() < rangeEndMs);
    const countStatus = (list, status) => list.filter((o) => effectiveStatus(o) === status).length;
    const ordersInRange = {
      total: inRange.length,
      pending: countStatus(inRange, 'PENDING'),
      preparing: countStatus(inRange, 'PREPARING'),
      ready: countStatus(inRange, 'READY'),
      served: countStatus(inRange, 'SERVED'),
      completed: countStatus(inRange, 'COMPLETED'),
      cancelled: countStatus(inRange, 'CANCELLED'),
    };

    const sum = (list) => list.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0);
    const paidOrders = orders.filter((o) => o.paymentStatus === 'PAID');
    const totalRevenue = sum(paidOrders);
    const todayRevenue = sum(
      paidOrders.filter((o) => o.createdAt && new Date(o.createdAt).getTime() >= today.getTime())
    );

    const series = { orders: {}, revenue: {} };
    // Bucket by LOCAL calendar day. toISOString() would key a local-midnight
    // date by its UTC day, which in a positive-offset timezone (e.g. UTC+3)
    // shifts every bucket back a day AND leaves today's orders homeless -
    // their UTC key matches no bucket, so they vanish from the chart.
    const dayKey = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    orders.forEach((o) => {
      const t = o.createdAt ? new Date(o.createdAt) : null;
      if (!t) return;
      const key = dayKey(t);
      series.orders[key] = (series.orders[key] || 0) + 1;
      if (o.paymentStatus === 'PAID') {
        series.revenue[key] = (series.revenue[key] || 0) + (Number(o.totalAmount) || 0);
      }
    });

    // One bucket per day across the requested window (7, 30 or 90 days).
    const chartSeries = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + i);
      const key = dayKey(d);
      chartSeries.push({
        date: key,
        orders: series.orders[key] || 0,
        revenue: series.revenue[key] || 0,
      });
    }
    // Backward compat: manager-dashboard.js renders chart.last7Days.
    const last7Days = days === 7 ? chartSeries : chartSeries.slice(-7);

    // Format rating distribution for chart
    const ratingDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    ratingDistribution.forEach((r) => {
      if (r._id >= 1 && r._id <= 5) ratingDist[r._id] = r.count;
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          customers,
          kitchenStaff,
          admins,
          cashiers,
          deliveries,
          managers: 0,
          taxAuthority: 0,
        },
        menu: { total: totalMenu, available: availableMenu, unavailable: unavailableMenu },
        orders: {
          total: totalOrders,
          pending: pendingOrders,
          preparing: preparingOrders,
          ready: readyOrders,
          served: servedOrders,
          completed: completedOrders,
          cancelled: cancelledOrders,
        },
        payments: { successful: successfulPayments, pending: pendingPayments, failed: failedPayments },
        revenue: { today: todayRevenue, total: totalRevenue },
        chart: { days, series: chartSeries, last7Days, ordersInRange },
        cancellations: { pending: pendingCancellations },
        feedback: {
          total: totalFeedback,
          pending: pendingFeedback,
          resolved: resolvedFeedback,
          averageRating: avgRating,
          ratingDistribution: ratingDist,
        },
        dateRange: {
          days,
          // Local calendar days, via the SAME dayKey() the chart buckets use.
          // toISOString() would render a local-midnight start as the PREVIOUS
          // day in a positive-offset timezone (UTC+3), so the range echoed back
          // to the UI disagreed with the range the charts were drawn from.
          startDate: dayKey(rangeStart),
          endDate: chartSeries.length ? chartSeries[chartSeries.length - 1].date : dayKey(rangeStart),
        },
      },
    });
  } catch (error) {
    console.error('❌ Get Dashboard Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get recent orders for dashboard
 * @route   GET /api/admin/dashboard/recent-orders
 * @access  Private/Admin
 */
exports.getRecentOrders = async (req, res) => {
  try {
    const { limit = 10, startDate, endDate } = req.query;
    const filter = {};
    
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        filter.createdAt.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) || 10)
      .populate('userId', 'name email');
    res.status(HTTP_STATUS.OK).json({
      success: true,
      orders: orders.map((o) => ({
        _id: o._id,
        orderId: o.orderId,
        customerName: o.customerName,
        customer: o.userId ? { name: o.userId.name, email: o.userId.email } : null,
        status: o.status,
        orderStatus: o.orderStatus,
        paymentStatus: o.paymentStatus,
        totalAmount: o.totalAmount,
        createdAt: o.createdAt,
        items: (o.items || []).map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
      })),
    });
  } catch (error) {
    console.error('❌ Get Recent Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get recent payments for dashboard
 * @route   GET /api/v1/admin/dashboard/recent-payments
 * @access  Private/Admin
 */
exports.getRecentPayments = async (req, res) => {
  try {
    const payments = await Payment.find()
      .sort({ createdAt: -1 })
      .limit(parseInt(req.query.limit) || 8)
      .populate('userId', 'name email')
      .populate('orderId', 'orderId customerName totalAmount');
    res.status(HTTP_STATUS.OK).json({
      success: true,
      payments: payments.map((p) => ({
        _id: p._id,
        transactionId: p.transactionId,
        orderId: p.orderId
          ? { id: p.orderId._id, orderId: p.orderId.orderId, totalAmount: p.orderId.totalAmount }
          : null,
        customer: p.userId ? { id: p.userId._id, name: p.userId.name, email: p.userId.email } : null,
        provider: p.provider,
        method: p.method,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        phone: p.phone,
        paidAt: p.paidAt,
        createdAt: p.createdAt,
      })),
    });
  } catch (error) {
    console.error('❌ Get Recent Payments Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get settings (grouped) + the caller's permission map
 * @route   GET /api/admin/settings
 * @access  Private/Admin
 *
 * The permission map tells the frontend which fields this role may change.
 * The backend is still the authority - see `updateSetting`.
 */
exports.getSettings = async (req, res) => {
  try {
    const [settings, settingsMap] = await Promise.all([
      Setting.find().sort({ group: 1, key: 1 }),
      getSettingsMap(),
    ]);
    const permissions = settingPermissions.describeSettingPermissions({
      role: req.user.role,
      settingsMap,
    });
    res.status(HTTP_STATUS.OK).json({
      success: true,
      settings: settings.map((s) => ({
        key: s.key,
        value: s.value,
        type: s.type,
        group: s.group,
        label: s.label,
        editable: permissions.editable[s.key] !== false,
      })),
      permissions,
    });
  } catch (error) {
    console.error('❌ Get Settings Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Update setting by key
 * @route   PUT /api/admin/settings/:key
 * @access  Private/Admin
 *
 * Authorization is enforced HERE, on the backend, for every key:
 *   - System Admin: may configure and override everything.
 *   - Cafeteria Manager: may change the cafeteria's own operating settings
 *     (opening hours, order flow, delivery operations) and - only when the
 *     System Admin authorized it - the delivery fee and the service fee.
 *   - Everything else (global currency, global order limits, tax policy,
 *     system-wide security & access) answers 403.
 */
exports.updateSetting = async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Value is required' });
    }

    const settingsMap = await getSettingsMap();
    const verdict = settingPermissions.evaluateSettingUpdate({
      key,
      role: req.user.role,
      settingsMap,
    });

    if (!verdict.allowed) {
      console.warn(
        `⛔ 403 setting update — role="${normalizeRole(req.user.role)}" key="${key}" ` +
          `(${verdict.reason}) (user=${req.user.email || req.user.id})`
      );
      return res.status(HTTP_STATUS.FORBIDDEN).json({ success: false, error: verdict.reason });
    }

    const def = DEFAULT_SETTINGS.find((s) => s.key === key);
    const validation = validateSettingValue(key, value);
    if (!validation.valid) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: validation.error });
    }
    const coerced = validation.value !== undefined ? validation.value : coerceValue(key, value);

    const update = { value: coerced };
    if (def) {
      update.type = def.type;
      update.group = def.group;
      update.label = def.label;
    }

    const setting = await Setting.findOneAndUpdate({ key }, update, { new: true, upsert: true });
    await logAction({
      req,
      action: 'settings.update',
      entityType: 'Setting',
      entityId: key,
      description: `Updated setting ${key} to ${typeof coerced === 'object' ? JSON.stringify(coerced) : coerced}`,
      result: 'SUCCESS',
      metadata: { key, type: def ? def.type : 'unknown', scope: verdict.scope },
    });
    res.status(HTTP_STATUS.OK).json({ success: true, setting });
  } catch (error) {
    console.error('❌ Update Setting Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get activity logs
 * @route   GET /api/admin/activity-logs
 * @access  Private/Admin
 */
exports.getActivityLogs = async (req, res) => {
  try {
    const { limit = 50, page = 1, action, entity, entityType, search, startDate, endDate, role, result } = req.query;

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const skip = (pageNum - 1) * limitNum;

    const filter = {};

    if (action && action !== 'all') filter.action = action;

    if (role && role !== 'all') {
      const roles = String(role)
        .split(',')
        .map((r) => normalizeRole(r.trim()))
        .filter(Boolean);
      if (roles.length === 1) {
        filter.actorRole = { $regex: new RegExp(`^${roles[0]}$`, 'i') };
      } else if (roles.length > 1) {
        filter.actorRole = { $in: roles.map((r) => new RegExp(`^${r}$`, 'i')) };
      }
    }

    if (result && result !== 'all') filter.result = result;

    const entityValue = entityType || entity;
    if (entityValue && entityValue !== 'all') filter.entity = entityValue;

    if (startDate || endDate) {
      const dateRange = {};
      if (startDate) {
        const start = new Date(startDate);
        if (isNaN(start.getTime())) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'startDate must be a valid date' });
        }
        start.setHours(0, 0, 0, 0);
        dateRange.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        if (isNaN(end.getTime())) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'endDate must be a valid date' });
        }
        end.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() + 1);
        dateRange.$lt = end;
      }
      filter.createdAt = dateRange;
    }

    if (search && search.trim()) {
      const term = String(search).trim();
      filter.$or = [
        { actorName: { $regex: term, $options: 'i' } },
        { actorRole: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
        { entityId: { $regex: term, $options: 'i' } },
        { entity: { $regex: term, $options: 'i' } },
      ];
    }

    const [logs, total] = await Promise.all([
      ActivityLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('actorId', 'name email role')
        .lean(),
      ActivityLog.countDocuments(filter),
    ]);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      count: logs.length,
      availableActions: [
        'ADMIN_LOGIN',
        'LOGIN',
        'LOGIN_FAILED',
        'LOGOUT',
        'REGISTRATION',
        'PASSWORD_RESET',
        'PASSWORD_CHANGED',
        'USER_CREATED',
        'USER_UPDATED',
        'USER_DELETED',
        'USER_ACTIVATED',
        'USER_DEACTIVATED',
        'USER_SUSPENDED',
        'ROLE_CHANGED',
        'FOOD_CREATED',
        'FOOD_UPDATED',
        'FOOD_AVAILABILITY_CHANGED',
        'FOOD_DELETED',
        'MENU_CREATED',
        'MENU_UPDATED',
        'MENU_DELETED',
        'CATEGORY_CREATED',
        'CATEGORY_UPDATED',
        'CATEGORY_STATUS_CHANGED',
        'CATEGORY_DELETED',
        'ORDER_CREATED',
        'ORDER_STATUS_CHANGED',
        'ORDER_STATUS_UPDATED',
        'ORDER_CANCELLED',
        'ORDER_REFUNDED',
        'CANCELLATION_REQUESTED',
        'CANCELLATION_AUTO_FULFILLED',
        'CANCELLATION_APPROVED',
        'CANCELLATION_REJECTED',
        'PAYMENT_CREATED',
        'PAYMENT_VERIFIED',
        'PAYMENT_FAILED',
        'PAYMENT_REFUND_INITIATED',
        'CASHIER_PAYMENT_CONFIRMED',
        'CASHIER_RECEIPT_GENERATED',
        'REFUND_REQUESTED',
        'REFUND_APPROVED',
        'REFUND_REJECTED',
        'REFUND_COMPLETED',
        'REFUND_CONFIRMED',
        'REFUND_FAILED',
        'DELIVERY_ASSIGNED',
        'DELIVERY_ACCEPTED',
        'DELIVERY_PICKED_UP',
        'DELIVERY_OUT_FOR_DELIVERY',
        'DELIVERY_DELIVERED',
        'FEEDBACK_SUBMITTED',
        'FEEDBACK_UPDATED',
        'TAX_REPORT_ACCESSED',
        'SETTINGS_UPDATED',
        'settings.update',
      ],
      logs: logs.map((log) => ({
        id: log._id,
        adminId: log.actorId ? log.actorId._id : null,
        adminName: log.actorId && log.actorId.name ? log.actorId.name : log.actorName || 'System',
        adminEmail: log.actorId ? log.actorId.email : '',
        adminRole: (log.actorId && log.actorId.role) || log.actorRole || '',
        actorRole: log.actorRole || (log.actorId ? log.actorId.role : 'system'),
        action: log.action,
        entityType: log.entity,
        entityId: log.entityId,
        description: log.description,
        result: log.result,
        metadata: log.metadata,
        ip: log.ip,
        timestamp: log.createdAt,
      })),
    });
  } catch (error) {
    console.error('❌ Get Activity Logs Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Change admin password
 * @route   PUT /api/admin/password
 * @access  Private/Admin
 */
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'All password fields are required' });
    }
    if (newPassword !== confirmPassword) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json({ success: false, error: 'New password and confirmation do not match' });
    }
    const user = await User.findById(req.user.id);
    if (!user || !user.password) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'User not found' });
    }
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Current password is incorrect' });
    }
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    await logAction({
      req,
      action: 'PASSWORD_CHANGED',
      entityType: 'User',
      entityId: String(user._id),
      description: 'Admin changed their password',
      result: 'SUCCESS',
    });
    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('❌ Change Password Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

exports.getSystemAnalytics = async (req, res) => {
  try {
    const requestedDays = parseInt(req.query.days, 10);
    const days = Number.isInteger(requestedDays) && requestedDays >= 1 && requestedDays <= 90 ? requestedDays : 7;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rangeStart = new Date(today);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));
    const rangeEnd = new Date(today);
    rangeEnd.setDate(rangeEnd.getDate() + 1);

    const dayKey = (d) => {
      const dt = new Date(d);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const day = String(dt.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    };

    const [totalUsers, activeUsers] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ status: 'ACTIVE', isActive: true }),
    ]);
    const inactiveUsers = Math.max(0, totalUsers - activeUsers);

    const totalOrders = await Order.countDocuments();

    const allPaid = await Payment.aggregate([
      { $match: { status: 'PAID' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const totalRevenue = allPaid[0] ? allPaid[0].total : 0;

    const paymentAgg = await Payment.aggregate([
      { $match: { paymentDate: { $gte: rangeStart, $lt: rangeEnd } } },
      { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' }, refundAmount: { $sum: '$refundAmount' } } },
    ]);
    const byStatus = (s) => paymentAgg.find((r) => String(r._id).toUpperCase() === s) || { count: 0, amount: 0, refundAmount: 0 };
    const paidRow = byStatus('PAID');
    const failedRow = byStatus('FAILED');
    const refundedRow = byStatus('REFUNDED');
    const pendingRow = byStatus('PENDING');
    const cancelledRow = byStatus('CANCELLED');
    const rangeRevenue = paidRow.amount || 0;
    const refundedAmount = refundedRow.refundAmount || 0;
    const netRevenue = rangeRevenue - refundedAmount;

    const userGrowthAgg = await User.aggregate([
      { $match: { createdAt: { $gte: rangeStart, $lt: rangeEnd } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
    ]);
    const userGrowthMap = {};
    userGrowthAgg.forEach((r) => { userGrowthMap[r._id] = r.count; });

    const orderTrendAgg = await Order.aggregate([
      { $match: { createdAt: { $gte: rangeStart, $lt: rangeEnd } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
    ]);
    const orderTrendMap = {};
    orderTrendAgg.forEach((r) => { orderTrendMap[r._id] = r.count; });

    const revenueTrendAgg = await Payment.aggregate([
      { $match: { status: 'PAID', paymentDate: { $gte: rangeStart, $lt: rangeEnd } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$paymentDate' } }, revenue: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    const revenueTrendMap = {};
    revenueTrendAgg.forEach((r) => { revenueTrendMap[r._id] = r; });

    const trend = [];
    const userGrowth = [];
    const orderTrend = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + i);
      const key = dayKey(d);
      const rt = revenueTrendMap[key] || {};
      trend.push({ date: key, revenue: rt.revenue || 0, orders: rt.count || 0 });
      userGrowth.push({ date: key, count: userGrowthMap[key] || 0 });
      orderTrend.push({ date: key, count: orderTrendMap[key] || 0 });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      data: {
        revenue: {
          total: totalRevenue,
          range: rangeRevenue,
          refunded: refundedAmount,
          net: netRevenue,
          successfulPayments: paidRow.count || 0,
          trend,
        },
        users: {
          total: totalUsers,
          active: activeUsers,
          inactive: inactiveUsers,
          growth: userGrowth,
        },
        orders: {
          total: totalOrders,
          trend: orderTrend,
        },
        payments: {
          successful: paidRow.count || 0,
          failed: failedRow.count || 0,
          refunded: refundedRow.count || 0,
          pending: pendingRow.count || 0,
          cancelled: cancelledRow.count || 0,
          total: paymentAgg.reduce((s, r) => s + r.count, 0),
        },
      },
    });
  } catch (error) {
    console.error('Get System Analytics Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};