const Order = require('../models/Order');
const Payment = require('../models/Payment');
const MenuItem = require('../models/MenuItem');
const User = require('../models/User');
const Report = require('../models/Report');
const { MESSAGES, HTTP_STATUS } = require('../config/constants');

/**
 * @desc    Generate daily orders report
 * @route   GET /api/reports/daily
 * @access  Private/Admin
 * Query Params: date (YYYY-MM-DD)
 */
exports.getDailyOrdersReport = async (req, res) => {
  try {
    const { date } = req.query;
    const reportDate = date || new Date().toISOString().split('T')[0];

    const orders = await Order.find({ orderDate: { $regex: reportDate } });

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, order) => sum + order.totalAmount, 0);
    const pendingOrders = orders.filter((o) => o.status === 'pending').length;
    const completedOrders = orders.filter((o) => o.status === 'served').length;
    const cancelledOrders = orders.filter((o) => o.status === 'cancelled').length;

    const payments = await Payment.find({ paymentDate: { $regex: reportDate } });
    const paymentMethods = {
      chapa: payments.filter((p) => p.method === 'CHAPA' || p.method === 'chapa').length,
      cash: payments.filter((p) => p.method === 'cash').length,
    };

    const itemCounts = {};
    orders.forEach((order) => {
      order.items.forEach((item) => {
        const name = item.name;
        itemCounts[name] = (itemCounts[name] || 0) + item.quantity;
      });
    });

    const popularItems = Object.entries(itemCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const report = {
      date: reportDate,
      totalOrders,
      totalRevenue,
      pendingOrders,
      completedOrders,
      cancelledOrders,
      paymentMethods,
      popularItems,
      averageOrderValue: totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : 0,
    };

    await Report.create({
      reportType: 'daily_orders',
      date: reportDate,
      fromDate: new Date(reportDate),
      toDate: new Date(reportDate),
      data: report,
      summary: { totalOrders, totalSales: totalRevenue, topItems: popularItems.slice(0, 5) },
      generatedBy: req.user.id,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, report });
  } catch (error) {
    console.error('❌ Get Daily Orders Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Generate sales report
 * @route   GET /api/reports/sales
 * @access  Private/Admin
 * Query Params: fromDate, toDate
 */
exports.getSalesReport = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    if (!fromDate || !toDate) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'From date and to date are required' });
    }

    const orders = await Order.find({
      createdAt: { $gte: new Date(fromDate), $lte: new Date(toDate) },
      status: { $in: ['served', 'ready'] },
    });

    const totalSales = orders.reduce((sum, order) => sum + order.totalAmount, 0);
    const totalOrders = orders.length;

    const dailyBreakdown = {};
    orders.forEach((order) => {
      const date = order.orderDate?.split(',')[0] || order.createdAt.toISOString().split('T')[0];
      if (!dailyBreakdown[date]) dailyBreakdown[date] = { orders: 0, revenue: 0 };
      dailyBreakdown[date].orders++;
      dailyBreakdown[date].revenue += order.totalAmount;
    });

    const payments = await Payment.find({
      paymentDate: { $gte: new Date(fromDate), $lte: new Date(toDate) },
      status: 'PAID',
    });
    const paymentBreakdown = {
      chapa: payments.filter((p) => p.method === 'CHAPA' || p.method === 'chapa').reduce((sum, p) => sum + p.amount, 0),
      cash: payments.filter((p) => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0),
    };

    const report = {
      fromDate,
      toDate,
      totalSales,
      totalOrders,
      averageOrderValue: totalOrders > 0 ? (totalSales / totalOrders).toFixed(2) : 0,
      dailyBreakdown,
      paymentBreakdown,
    };

    await Report.create({
      reportType: 'sales',
      date: `${fromDate} to ${toDate}`,
      fromDate: new Date(fromDate),
      toDate: new Date(toDate),
      data: report,
      summary: { totalOrders, totalSales },
      generatedBy: req.user.id,
    });

    res.status(HTTP_STATUS.OK).json({ success: true, report });
  } catch (error) {
    console.error('❌ Get Sales Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get popular items report
 * @route   GET /api/reports/popular
 * @access  Private/Admin
 * Query Params: fromDate, toDate, limit
 */
exports.getPopularItemsReport = async (req, res) => {
  try {
    const { fromDate, toDate, limit = 10 } = req.query;
    let filter = {};
    if (fromDate && toDate) {
      filter.createdAt = { $gte: new Date(fromDate), $lte: new Date(toDate) };
    }

    const orders = await Order.find(filter);
    const itemCounts = {};
    orders.forEach((order) => {
      order.items.forEach((item) => {
        const key = item.name;
        if (!itemCounts[key]) {
          itemCounts[key] = { name: item.name, totalQuantity: 0, totalRevenue: 0 };
        }
        itemCounts[key].totalQuantity += item.quantity;
        itemCounts[key].totalRevenue += item.price * item.quantity;
      });
    });

    const popularItems = Object.values(itemCounts)
      .sort((a, b) => b.totalQuantity - a.totalQuantity)
      .slice(0, parseInt(limit));

    const totalItems = popularItems.reduce((sum, item) => sum + item.totalQuantity, 0);
    const totalRevenue = popularItems.reduce((sum, item) => sum + item.totalRevenue, 0);

    const report = {
      fromDate: fromDate || 'All time',
      toDate: toDate || 'All time',
      items: popularItems,
      totalItems,
      totalRevenue,
    };

    res.status(HTTP_STATUS.OK).json({ success: true, report });
  } catch (error) {
    console.error('❌ Get Popular Items Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get payments report
 * @route   GET /api/reports/payments
 * @access  Private/Admin
 * Query Params: fromDate, toDate
 */
exports.getPaymentsReport = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    let filter = {};
    if (fromDate && toDate) {
      filter.paymentDate = { $gte: new Date(fromDate), $lte: new Date(toDate) };
    }

    const payments = await Payment.find(filter).populate('userId', 'name email');

    const totalPayments = payments.length;
    const totalAmount = payments.reduce((sum, p) => sum + p.amount, 0);
    const successful = payments.filter((p) => p.status === 'PAID').length;
    const failed = payments.filter((p) => p.status === 'FAILED').length;
    const pending = payments.filter((p) => p.status === 'PENDING').length;

    const methodBreakdown = {
      chapa: payments.filter((p) => p.method === 'CHAPA' || p.method === 'chapa').length,
      cash: payments.filter((p) => p.method === 'cash').length,
    };

    const report = {
      fromDate: fromDate || 'All time',
      toDate: toDate || 'All time',
      totalPayments,
      totalAmount,
      successful,
      failed,
      pending,
      methodBreakdown,
      averageAmount: totalPayments > 0 ? (totalAmount / totalPayments).toFixed(2) : 0,
    };

    res.status(HTTP_STATUS.OK).json({ success: true, report });
  } catch (error) {
    console.error('❌ Get Payments Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Revenue & Tax report (VAT + revenue sharing breakdown)
 * @route   GET /api/reports/revenue
 * @access  Private/Admin/Cafeteria/Manager/TaxAuthority
 * Query Params: fromDate, toDate
 */
exports.getRevenueReport = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const filter = {};

    if (fromDate && toDate) {
      const f = fromDate.split('-');
      const t = toDate.split('-');
      const start = new Date(Number(f[0]), Number(f[1]) - 1, Number(f[2]), 0, 0, 0, 0);
      const end = new Date(Number(t[0]), Number(t[1]) - 1, Number(t[2]), 23, 59, 59, 999);
      filter.createdAt = { $gte: start, $lte: end };
    }

    const orders = await Order.find(filter).lean();

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    const agg = orders.reduce(
      (acc, o) => {
        const vatRate = Number(o.vatRate) || 0;
        const vatEnabled = o.vatEnabled !== false;
        const effectiveVatRate = vatRate || (vatEnabled ? 15 : 0);
        const effectiveVatAmount =
          o.vatAmount ||
          o.taxAmount ||
          0 ||
          (effectiveVatRate ? round2((o.totalAmount * effectiveVatRate) / (100 + effectiveVatRate)) : 0);
        acc.orderCount++;
        acc.gross = acc.gross + (o.totalAmount || 0);
        acc.subtotal = acc.subtotal + (o.subtotal || 0);
        acc.vat = acc.vat + effectiveVatAmount;
        acc.serviceFees = acc.serviceFees + (o.serviceFee || 0);
        acc.deliveryFees = acc.deliveryFees + (o.deliveryFee || 0);
        acc.platformFees = acc.platformFees + (o.platformFee || 0);
        acc.cafeteriaShare = acc.cafeteriaShare + (o.cafeteriaShare ?? (o.subtotal || 0));
        acc.platformShare = acc.platformShare + (o.platformShare || 0);
        return acc;
      },
      {
        orderCount: 0,
        gross: 0,
        subtotal: 0,
        vat: 0,
        serviceFees: 0,
        deliveryFees: 0,
        platformFees: 0,
        cafeteriaShare: 0,
        platformShare: 0,
      }
    );

    for (const k of [
      'gross',
      'subtotal',
      'vat',
      'serviceFees',
      'deliveryFees',
      'platformFees',
      'cafeteriaShare',
      'platformShare',
    ]) {
      agg[k] = round2(agg[k]);
    }

    const daily = {};
    orders.forEach((o) => {
      const d = o.createdAt ? o.createdAt : new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!daily[date]) daily[date] = { orders: 0, gross: 0, vat: 0, subtotal: 0, serviceFees: 0, deliveryFees: 0 };
      const vatRate = Number(o.vatRate) || 0;
      const vatEnabled = o.vatEnabled !== false;
      const effectiveVatRate = vatRate || (vatEnabled ? 15 : 0);
      const effectiveVatAmount =
        o.vatAmount ||
        o.taxAmount ||
        0 ||
        (effectiveVatRate ? round2((o.totalAmount * effectiveVatRate) / (100 + effectiveVatRate)) : 0);
      daily[date].orders++;
      daily[date].gross += o.totalAmount || 0;
      daily[date].vat += effectiveVatAmount;
      daily[date].subtotal += o.subtotal || 0;
      daily[date].serviceFees += o.serviceFee || 0;
      daily[date].deliveryFees += o.deliveryFee || 0;
    });
    const dailyBreakdown = Object.entries(daily)
      .map(([date, v]) => ({
        date,
        orders: v.orders,
        gross: round2(v.gross),
        subtotal: round2(v.subtotal),
        vat: round2(v.vat),
        serviceFees: round2(v.serviceFees),
        deliveryFees: round2(v.deliveryFees),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const report = {
      fromDate: fromDate || 'All time',
      toDate: toDate || 'All time',
      summary: agg,
      netCafeteriaIncome: round2(agg.cafeteriaShare),
      totalTaxRemitted: agg.vat,
      averageOrderValue: agg.orderCount > 0 ? round2(agg.gross / agg.orderCount) : 0,
      dailyBreakdown,
    };

    res.status(HTTP_STATUS.OK).json({ success: true, report });
  } catch (error) {
    console.error('❌ Get Revenue Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Tax compliance report (restricted - government / tax authority only)
 * @route   GET /api/reports/tax-compliance
 * @access  Private/TaxAuthority + system & cafeteria admins
 *
 * Exposes ONLY aggregate VAT figures (no order/customer PII). Every access is
 * audit-logged with the actor role.
 * Query Params: fromDate, toDate, year
 */
exports.getTaxComplianceReport = async (req, res) => {
  try {
    const { fromDate, toDate, year } = req.query;
    const filter = { paymentStatus: 'PAID' };

    if (year) {
      const y = parseInt(year) || new Date().getFullYear();
      const start = new Date(y, 0, 1, 0, 0, 0, 0);
      const end = new Date(y, 11, 31, 23, 59, 59, 999);
      filter.createdAt = { $gte: start, $lte: end };
    } else if (fromDate && toDate) {
      const f = fromDate.split('-');
      const t = toDate.split('-');
      const start = new Date(Number(f[0]), Number(f[1]) - 1, Number(f[2]), 0, 0, 0, 0);
      const end = new Date(Number(t[0]), Number(t[1]) - 1, Number(t[2]), 23, 59, 59, 999);
      filter.createdAt = { $gte: start, $lte: end };
    }

    const orders = await Order.find(filter)
      .select('totalAmount vatAmount taxAmount vatRate vatEnabled createdAt orderId')
      .lean();

    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    const totals = orders.reduce(
      (acc, o) => {
        const vatRate = Number(o.vatRate) || 0;
        const vatEnabled = o.vatEnabled !== false;
        const effectiveVatRate = vatRate || (vatEnabled ? 15 : 0);
        const effectiveVatAmount =
          o.vatAmount ||
          o.taxAmount ||
          0 ||
          (effectiveVatRate ? round2((o.totalAmount * effectiveVatRate) / (100 + effectiveVatRate)) : 0);
        acc.grossSales = acc.grossSales + (o.totalAmount || 0);
        acc.vatCollected = acc.vatCollected + effectiveVatAmount;
        acc.taxableBase = acc.taxableBase + (o.totalAmount || 0) - effectiveVatAmount;
        if (vatEnabled) acc.vatInclusiveOrders++;
        else acc.vatExemptOrders++;
        return acc;
      },
      { grossSales: 0, vatCollected: 0, taxableBase: 0, vatInclusiveOrders: 0, vatExemptOrders: 0 }
    );

    const months = {};
    orders.forEach((o) => {
      const d = o.createdAt ? o.createdAt : new Date();
      const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!months[m]) months[m] = { grossSales: 0, vatCollected: 0 };
      const vatRate = Number(o.vatRate) || 0;
      const vatEnabled = o.vatEnabled !== false;
      const effectiveVatRate = vatRate || (vatEnabled ? 15 : 0);
      const effectiveVatAmount =
        o.vatAmount ||
        o.taxAmount ||
        0 ||
        (effectiveVatRate ? round2((o.totalAmount * effectiveVatRate) / (100 + effectiveVatRate)) : 0);
      months[m].grossSales += o.totalAmount || 0;
      months[m].vatCollected += effectiveVatAmount;
    });

    const monthlyBreakdown = Object.entries(months)
      .map(([month, v]) => ({ month, grossSales: round2(v.grossSales), vatCollected: round2(v.vatCollected) }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const { logAction } = require('../utils/audit');
    await logAction({
      req,
      action: 'TAX_REPORT_ACCESSED',
      entityType: 'Report',
      entityId: '',
      description: `${req.user.name || req.user.email} (${req.user.role}) accessed the VAT/tax compliance report`,
      result: 'SUCCESS',
      metadata: { fromDate: fromDate || 'all', toDate: toDate || 'all', year: year || null, orderCount: orders.length },
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      report: {
        period: year ? `Year ${year}` : `${fromDate || 'All time'} - ${toDate || 'All time'}`,
        transactionCount: orders.length,
        grossSales: round2(totals.grossSales),
        taxableBase: round2(totals.taxableBase),
        vatCollected: round2(totals.vatCollected),
        vatInclusiveOrders: totals.vatInclusiveOrders,
        vatExemptOrders: totals.vatExemptOrders,
        monthlyBreakdown,
      },
    });
  } catch (error) {
    console.error('❌ Get Tax Compliance Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get all saved reports (Admin only)
 * @route   GET /api/reports
 * @access  Private/Admin
 */
exports.getAllReports = async (req, res) => {
  try {
    const reports = await Report.find().populate('generatedBy', 'name email').sort({ createdAt: -1 });
    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: reports.length,
      reports: reports.map((report) => ({
        id: report._id,
        reportType: report.reportType,
        date: report.date,
        summary: report.summary,
        generatedBy: report.generatedBy?.name || 'System',
        createdAt: report.createdAt,
      })),
    });
  } catch (error) {
    console.error('❌ Get All Reports Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get report by ID (Admin only)
 * @route   GET /api/reports/:id
 * @access  Private/Admin
 */
exports.getReportById = async (req, res) => {
  try {
    const report = await Report.findById(req.params.id).populate('generatedBy', 'name email');
    if (!report) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Report not found' });
    }
    res.status(HTTP_STATUS.OK).json({
      success: true,
      report: {
        id: report._id,
        reportType: report.reportType,
        date: report.date,
        data: report.data,
        summary: report.summary,
        generatedBy: report.generatedBy?.name || 'System',
        createdAt: report.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Get Report By ID Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Delete report (Admin only)
 * @route   DELETE /api/reports/:id
 * @access  Private/Admin
 */
exports.deleteReport = async (req, res) => {
  try {
    const report = await Report.findByIdAndDelete(req.params.id);
    if (!report) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Report not found' });
    }
    res.status(HTTP_STATUS.OK).json({ success: true, message: 'Report deleted successfully' });
  } catch (error) {
    console.error('❌ Delete Report Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};
