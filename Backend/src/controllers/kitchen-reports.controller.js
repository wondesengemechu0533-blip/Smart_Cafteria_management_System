const Order = require('../models/Order');
const MenuItem = require('../models/MenuItem');
const KitchenShift = require('../models/KitchenShift');
const KitchenReport = require('../models/KitchenReport');
const StockAlert = require('../models/StockAlert');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');

// ============================================================
// KITCHEN REPORTS & ANALYTICS
// ============================================================

/**
 * @desc    Get kitchen performance report for a date range
 * @route   GET /api/kitchen/reports
 * @access  Private/Kitchen or Admin
 *
 * Query Params: startDate, endDate, reportType (daily/weekly/monthly)
 * Response: { success, report }
 */
exports.getKitchenReport = async (req, res) => {
  try {
    const { startDate, endDate, reportType } = req.query;

    let filter = {};
    if (startDate && endDate) {
      filter.reportDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }
    if (reportType) filter.reportType = reportType;

    const report = await KitchenReport.find(filter).populate('staffId', 'name').sort({ reportDate: -1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: report.length,
      reports: report,
    });
  } catch (error) {
    console.error('❌ Get Kitchen Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Generate today's kitchen performance report
 * @route   POST /api/kitchen/reports/generate
 * @access  Private/Admin
 *
 * Response: { success, message, report }
 */
exports.generateDailyReport = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Get all orders completed today
    const ordersReceived = await Order.countDocuments({
      createdAt: { $gte: today, $lt: tomorrow },
    });

    const ordersCompleted = await Order.countDocuments({
      status: 'served',
      completedTime: { $gte: today, $lt: tomorrow },
    });

    const ordersCancelled = await Order.countDocuments({
      status: 'cancelled',
      createdAt: { $gte: today, $lt: tomorrow },
    });

    // Get completed orders for analysis
    const completedOrders = await Order.find({
      status: 'served',
      completedTime: { $gte: today, $lt: tomorrow },
    }).populate('items.itemId');

    // Calculate average preparation time
    let totalPrepTime = 0;
    let totalItems = 0;
    const itemCount = {};

    completedOrders.forEach((order) => {
      const prepTime = (order.completedTime - order.orderTime) / 60000; // minutes
      totalPrepTime += prepTime;
      order.items.forEach((item) => {
        totalItems++;
        itemCount[item.name] = (itemCount[item.name] || 0) + item.quantity;
      });
    });

    const avgPrepTime = ordersCompleted > 0 ? Math.round(totalPrepTime / ordersCompleted) : 0;
    const fulfillmentRate = ordersReceived > 0 ? Math.round((ordersCompleted / ordersReceived) * 100) : 0;

    // Find most prepared items
    const sortedItems = Object.entries(itemCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({
        itemName: name,
        count: count,
      }));

    // Get staff performance
    const staffShifts = await KitchenShift.find({
      status: 'completed',
      clockOutTime: { $gte: today, $lt: tomorrow },
    }).populate('staffId', 'name');

    const staffPerformance = staffShifts.map((shift) => ({
      staffId: shift.staffId._id,
      staffName: shift.staffId.name,
      ordersCompleted: shift.ordersCompleted,
      averageTime: shift.averagePreparationTime,
      efficiency: shift.ordersCompleted > 0 ? Math.round((shift.ordersCompleted / 8) * 100) : 0, // assuming 8-hour shift
    }));

    // Get stock issues
    const stockIssues = await StockAlert.countDocuments({
      status: 'active',
      createdAt: { $gte: today, $lt: tomorrow },
    });

    // Create report
    const report = await KitchenReport.create({
      reportDate: today,
      reportType: 'daily',
      totalOrdersReceived: ordersReceived,
      totalOrdersCompleted: ordersCompleted,
      totalOrdersCancelled: ordersCancelled,
      orderFulfillmentRate: fulfillmentRate,
      averagePreparationTime: avgPrepTime,
      totalItemsPrepared: totalItems,
      mostPreparedItems: sortedItems,
      staffPerformance: staffPerformance,
      stockIssuesReported: stockIssues,
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: 'Daily report generated successfully',
      report: report,
    });
  } catch (error) {
    console.error('❌ Generate Daily Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get kitchen dashboard stats with real-time metrics
 * @route   GET /api/kitchen/stats/detailed
 * @access  Private/Kitchen or Admin
 *
 * Response: { success, stats }
 */
exports.getDetailedKitchenStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Orders by status
    const pending = await Order.countDocuments({ status: 'pending' });
    const preparing = await Order.countDocuments({ status: 'preparing' });
    const ready = await Order.countDocuments({ status: 'ready' });
    const served = await Order.countDocuments({
      status: 'served',
      completedTime: { $gte: today },
    });

    // Calculate average preparation time for active orders
    const activeOrders = await Order.find({
      status: { $in: ['pending', 'preparing'] },
    });

    let avgPrepTime = 0;
    if (activeOrders.length > 0) {
      const totalTime = activeOrders.reduce((sum, order) => {
        return sum + (Date.now() - new Date(order.createdAt).getTime());
      }, 0);
      avgPrepTime = Math.round(totalTime / activeOrders.length / 60000); // convert to minutes
    }

    // Get most ordered items today
    const topItems = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: today },
        },
      },
      {
        $unwind: '$items',
      },
      {
        $group: {
          _id: '$items.name',
          count: { $sum: '$items.quantity' },
        },
      },
      {
        $sort: { count: -1 },
      },
      {
        $limit: 5,
      },
    ]);

    // Get stock alerts
    const stockAlerts = await StockAlert.countDocuments({
      status: { $in: ['active', 'acknowledged'] },
    });

    // Get active staff
    const activeStaff = await KitchenShift.countDocuments({
      status: 'active',
    });

    // Get peak hour (hour with most orders)
    const ordersByHour = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: today },
        },
      },
      {
        $group: {
          _id: {
            $hour: '$createdAt',
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { count: -1 },
      },
      {
        $limit: 1,
      },
    ]);

    const peakHour = ordersByHour.length > 0 ? `${ordersByHour[0]._id}:00` : 'N/A';

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        ordersStatus: {
          pending,
          preparing,
          ready,
          served,
          totalActive: pending + preparing,
        },
        performance: {
          averagePreparationTime: avgPrepTime,
          totalOrdersToday: pending + preparing + ready + served,
          completionRate: served,
        },
        topItems: topItems,
        staffing: {
          activeStaffMembers: activeStaff,
          stockAlerts: stockAlerts,
        },
        peakHour: peakHour,
        timestamp: new Date(),
      },
    });
  } catch (error) {
    console.error('❌ Get Detailed Kitchen Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get individual staff performance metrics
 * @route   GET /api/kitchen/staff/:staffId/performance
 * @access  Private/Admin or Kitchen
 *
 * Query Params: startDate, endDate
 * Response: { success, performance }
 */
exports.getStaffPerformance = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { startDate, endDate } = req.query;

    let filter = { staffId: staffId };

    if (startDate && endDate) {
      filter.clockOutTime = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else {
      // Default to last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      filter.clockOutTime = { $gte: thirtyDaysAgo };
    }

    // Get shift data
    const shifts = await KitchenShift.find(filter).populate('staffId', 'name email phone');

    // Calculate metrics
    const totalShifts = shifts.length;
    const totalOrdersCompleted = shifts.reduce((sum, shift) => sum + shift.ordersCompleted, 0);
    const avgPrepTime =
      totalOrdersCompleted > 0
        ? Math.round(shifts.reduce((sum, shift) => sum + shift.averagePreparationTime, 0) / shifts.length)
        : 0;

    // Calculate active hours
    let totalHours = 0;
    let totalBreakTime = 0;

    shifts.forEach((shift) => {
      if (shift.clockInTime && shift.clockOutTime) {
        const shiftDuration = (shift.clockOutTime - shift.clockInTime) / (1000 * 60 * 60); // hours
        totalHours += shiftDuration;

        // Calculate break time
        shift.breaksStarted.forEach((breakRecord) => {
          if (breakRecord.endTime) {
            const breakDuration = (breakRecord.endTime - breakRecord.startTime) / (1000 * 60); // minutes
            totalBreakTime += breakDuration;
          }
        });
      }
    });

    const avgOrdersPerHour = totalHours > 0 ? (totalOrdersCompleted / totalHours).toFixed(2) : 0;
    const avgBreaksPerShift = totalShifts > 0 ? Math.round(totalBreakTime / totalShifts) : 0;

    res.status(HTTP_STATUS.OK).json({
      success: true,
      performance: {
        staffId: staffId,
        totalShifts: totalShifts,
        totalOrdersCompleted: totalOrdersCompleted,
        averagePreparationTime: avgPrepTime,
        totalActiveHours: Math.round(totalHours * 10) / 10,
        averageOrdersPerHour: avgOrdersPerHour,
        averageBreakTimePerShift: avgBreaksPerShift,
        efficiency: Math.round((totalOrdersCompleted / (totalHours * 10)) * 100), // orders per 10 hours
      },
    });
  } catch (error) {
    console.error('❌ Get Staff Performance Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get order preparation history/report
 * @route   GET /api/kitchen/reports/orders
 * @access  Private/Kitchen or Admin
 *
 * Query Params: startDate, endDate, status
 * Response: { success, count, orders: [...] }
 */
exports.getOrderPreparationReport = async (req, res) => {
  try {
    const { startDate, endDate, status } = req.query;

    let filter = {};

    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    if (status) {
      filter.status = status;
    } else {
      filter.status = { $in: ['served', 'cancelled'] };
    }

    const orders = await Order.find(filter).populate('userId', 'name phone').sort({ completedTime: -1 });

    // Enrich with metrics
    const enrichedOrders = orders.map((order) => {
      const prepTime = order.completedTime ? (order.completedTime - order.orderTime) / 60000 : null;

      return {
        orderId: order.orderId,
        customerName: order.customerName,
        itemCount: order.items.length,
        status: order.status,
        preparationTime: prepTime ? Math.round(prepTime) : null,
        createdAt: order.orderTime,
        completedAt: order.completedTime,
        preparationDelayReason: order.preparationDelayReason,
      };
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: enrichedOrders.length,
      orders: enrichedOrders,
    });
  } catch (error) {
    console.error('❌ Get Order Preparation Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

module.exports = exports;
