const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const MenuItem = require('../models/MenuItem');
const Cafeteria = require('../models/Cafeteria');
const Delivery = require('../models/Delivery');
const Notification = require('../models/Notification');
const Table = require('../models/Table');
const { ORDER_STATUS, PAYMENT_STATUS, PAYMENT_METHODS, MESSAGES, HTTP_STATUS } = require('../config/constants');
const { getSettingsMap } = require('../utils/settings');
const StockTransaction = require('../models/StockTransaction');
const OrderStatusHistory = require('../models/OrderStatusHistory');
const { getDefaultCafeteriaId, resolveCafeteriaScope } = require('../utils/cafeteria');
// Shared GPS/proximity helpers (Haversine + the GPS-on statuses). Imported at the
// top level - not lazily inside a handler - so the customer tracking payload
// (deliveryLocation / customerLocation / distanceToCustomerKm) is built from the
// same helpers the courier dashboard and the GPS endpoint use.
const deliveryService = require('../services/delivery.service');

// Coordinates are optional for delivery orders. Sanitize untrusted input: any
// non-finite or out-of-range value is stored as null (address-only fallback),
// so a bad coordinate can never reach the tracking map.
function sanitizeCoordinate(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * @desc    Create new order
 * @route   POST /api/orders
 * @access  Private
 *
 * Frontend: checkout.js → Place Order
 * Expected Body: { items, customerName, customerPhone, orderType, tableNumber, paymentMethod, totalAmount }
 * Response: { success, order }
 */
exports.createOrder = async (req, res) => {
  let reservations = [];
  try {
    const {
      items,
      customerName,
      customerPhone,
      orderType = 'dine-in',
      tableId = null,
      tableNumber = 'N/A',
      paymentMethod,
      totalAmount,
      notes,
      deliveryInfo,
    } = req.body;
    const normalizedPaymentMethod = String(paymentMethod || '').toUpperCase();

    // ✅ Validate required fields
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Order must have at least one item',
      });
    }

    if (!customerName || !customerPhone) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Customer name and phone are required',
      });
    }

    if (!Object.values(PAYMENT_METHODS).includes(normalizedPaymentMethod)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Payment method must be CHAPA',
      });
    }

    // ✅ Idempotency: a client-generated key lets the checkout retry (or the
    //    5s-deadline tracking page re-query) without ever creating a second
    //    order. Checked BEFORE any stock reservation or write.
    const clientOrderId = String(req.body.clientOrderId || '').trim().slice(0, 64) || null;
    if (clientOrderId) {
      const existing = await Order.findOne({ clientOrderId, userId: req.user.id });
      if (existing) {
        return res.status(HTTP_STATUS.OK).json({
          success: true,
          message: MESSAGES.ORDER_PLACED,
          order: existing.getSummary(),
          duplicate: true,
        });
      }
    }

    const normalizedTable = String(tableNumber || '').trim();
    const normalizedTableId = String(tableId || '').trim();
    const isDineIn = String(orderType).toLowerCase() === 'dine-in';
    const hasNATable = normalizedTable.toUpperCase() === 'N/A' || normalizedTable.toUpperCase().startsWith('N/A');
    let orderTableId = null;
    let orderTableNumber = 'N/A';

    if (isDineIn) {
      if (!normalizedTableId && (!normalizedTable || hasNATable)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: 'A table identifier is required for dine-in orders.',
        });
      }

      try {
        const table = await Table.findByIdentifier(normalizedTableId, normalizedTable);
        if (!table) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: normalizedTable
              ? `Table "${normalizedTable}" was not found.`
              : `Table "${normalizedTableId}" was not found.`,
          });
        }
        if (table.isActive === false) {
          return res.status(HTTP_STATUS.FORBIDDEN).json({
            success: false,
            error: `Table ${table.tableNumber} is not currently available.`,
          });
        }
        orderTableId = table._id;
        orderTableNumber = table.tableNumber;
      } catch (err) {
        return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
          success: false,
          error: 'Unable to validate the table. Please try again.',
        });
      }
    }

    // ✅ Validate items and calculate subtotal
    let subtotal = 0;
    let orderCafeteriaId = null;
    const validatedItems = [];

    for (const item of items) {
      let menuItem = null;

      if (item.id && mongoose.Types.ObjectId.isValid(item.id)) {
        menuItem = await MenuItem.findById(item.id);
      }

      if (!menuItem && item.name) {
        const cleanName = String(item.name).trim();
        menuItem = await MenuItem.findOne({
          $or: [
            { 'name.en': { $regex: new RegExp(`^${cleanName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, 'i') } },
            { 'name.am': cleanName },
          ],
        });
      }

      if (!menuItem) return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Food item not found' });
      if (!orderCafeteriaId && menuItem.cafeteriaId) orderCafeteriaId = menuItem.cafeteriaId;
      const quantity = parseInt(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1)
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'Quantity must be at least 1' });
      const reserved = await MenuItem.findOneAndUpdate(
        {
          _id: menuItem._id,
          isActive: true,
          availabilityStatus: 'AVAILABLE',
          availability: true,
          isAvailable: true,
          stockQuantity: { $gte: quantity },
        },
        { $inc: { stockQuantity: -quantity } },
        { new: false }
      );
      if (!reserved)
        return res
          .status(HTTP_STATUS.CONFLICT)
          .json({ success: false, error: `Only ${menuItem.stockQuantity || 0} items are currently available.` });
      reservations.push({ id: menuItem._id, quantity, previous: reserved.stockQuantity });
      const price = menuItem.price;
      const name = menuItem ? menuItem.name?.en || menuItem.name : item.name || 'Food Item';
      const itemTotal = price * quantity;
      subtotal += itemTotal;

      validatedItems.push({
        itemId: menuItem ? menuItem._id : new mongoose.Types.ObjectId(),
        name: name,
        quantity: quantity,
        price: price,
        notes: item.notes || '',
        foodNameSnapshot: name,
        foodDescriptionSnapshot: menuItem.description?.en || '',
        categoryNameSnapshot: menuItem.category || '',
        foodImageSnapshot: menuItem.image || null,
        subtotal: itemTotal,
      });
    }

    // ✅ Enforce system settings: maintenance mode, order availability, max order quantity
    const settings = await getSettingsMap();
    if (settings.maintenance_mode) {
      return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
        success: false,
        error: 'System is under maintenance. Please try again later.',
      });
    }
    if (settings.order_availability === false) {
      return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
        success: false,
        error: 'Online ordering is currently unavailable.',
      });
    }
    const maxQty = Number(settings.max_order_quantity) || 10;
    const totalQty = validatedItems.reduce((sum, i) => sum + i.quantity, 0);
    if (totalQty > maxQty) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Maximum order quantity is ${maxQty} items.`,
      });
    }

    // ✅ Calculate totals (VAT/tax, delivery fee, service fee & revenue
    //    sharing all come from configurable settings — never hard-coded).
    const { computeOrderCharges } = require('../services/finance.service');
    const { getDefaultCafeteriaId } = require('../utils/cafeteria');
    const isDelivery = String(orderType).toLowerCase() === 'delivery';

    // Resolve the owning cafeteria from trusted server-side data FIRST: the
    // ordered menu item's cafeteria, falling back to the default cafeteria.
    // The delivery fee is priced from it, so it must be known before charging.
    if (!orderCafeteriaId) {
      orderCafeteriaId = await getDefaultCafeteriaId();
    }

    // The delivery fee is recomputed server-side from the REAL destination the
    // customer just submitted, using the same function as the quote endpoint.
    // The client never sends a fee. Without this, a distance-priced quote at
    // checkout would still be charged at the flat rate.
    let deliveryFeeOverride = null;
    if (isDelivery) {
      try {
        const destLat = deliveryService.cleanCoordinate(deliveryInfo?.latitude, -90, 90);
        const destLng = deliveryService.cleanCoordinate(deliveryInfo?.longitude, -180, 180);
        const pickup = await deliveryService.resolvePickupLocation(orderCafeteriaId);
        const hasCoords = deliveryService.isUsableDeliveryCoordinate(destLat, destLng);
        const distanceKm = hasCoords
          ? deliveryService.haversineKm(pickup, { latitude: destLat, longitude: destLng })
          : null;
        const quote = deliveryService.calculateDeliveryFee({ distanceKm, subtotal, settings });

        // Development visibility into the range decision. Without these numbers a
        // false "beyond our 10 km delivery range" is indistinguishable from a
        // genuine out-of-range address, because the only signal was the message.
        console.log(
          `[delivery-range] cafeteria=(${pickup.latitude},${pickup.longitude}) ` +
          `customer=(${destLat},${destLng}) distanceKm=${distanceKm} ` +
          `maxDistanceKm=${quote.maxDistanceKm} withinRange=${quote.withinRange}`
        );

        // The client checks this too, but the server is the only trustworthy
        // authority: accepting an unreachable address here would create an
        // order that is guaranteed to fail delivery later.
        if (hasCoords && quote.withinRange === false) {
          console.warn(
            `[delivery-range] REJECTED order for cafeteria ${orderCafeteriaId}: ` +
            `${distanceKm} km exceeds ${quote.maxDistanceKm} km`
          );
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: `That address is beyond our ${quote.maxDistanceKm} km delivery range. Please choose a location within the delivery area.`,
            code: 'DELIVERY_OUT_OF_RANGE',
            maxDistanceKm: quote.maxDistanceKm,
            distanceKm: quote.distanceKm,
          });
        }

        deliveryFeeOverride = quote.fee;
      } catch (quoteError) {
        // Never block checkout on a pricing lookup; the flat configured fee is
        // the fallback that computeOrderCharges applies without an override.
        console.warn('Delivery pricing lookup failed, using the configured flat fee:', quoteError.message);
      }
    }

    // One authoritative calculation: the VAT base and the total are derived from
    // whichever delivery fee applies, so the quote and the charge cannot drift.
    const charges = await computeOrderCharges({
      subtotal,
      isDelivery,
      settings,
      deliveryFee: deliveryFeeOverride,
    });
    const serviceFee = charges.serviceFee;
    const deliveryFee = charges.deliveryFee;
    const vatAmount = charges.vatAmount;
    const total = charges.totalAmount;

    // ✅ Create order
    const order = await Order.create({
      userId: req.user.id,
      cafeteriaId: orderCafeteriaId,
      clientOrderId: clientOrderId,
      customerName: customerName.trim(),
      customerPhone: customerPhone,
      orderType: orderType,
      tableId: orderTableId,
      tableNumber: orderTableNumber,
      deliveryInfo: isDelivery
        ? {
            // Structured Ethiopian delivery location (any city - stored as
            // separate values, never one combined string, never hardcoded).
            city: deliveryInfo?.city !== undefined && deliveryInfo?.city !== null ? String(deliveryInfo.city).trim().slice(0, 120) : '',
            area: deliveryInfo?.area !== undefined && deliveryInfo?.area !== null ? String(deliveryInfo.area).trim().slice(0, 120) : '',
            kebele: deliveryInfo?.kebele !== undefined && deliveryInfo?.kebele !== null ? String(deliveryInfo.kebele).trim().slice(0, 120) : '',
            streetArea: deliveryInfo?.streetArea !== undefined && deliveryInfo?.streetArea !== null ? String(deliveryInfo.streetArea).trim().slice(0, 200) : '',
            landmark: deliveryInfo?.landmark !== undefined && deliveryInfo?.landmark !== null ? String(deliveryInfo.landmark).trim().slice(0, 200) : '',
            houseNumber: deliveryInfo?.houseNumber !== undefined && deliveryInfo?.houseNumber !== null ? String(deliveryInfo.houseNumber).trim().slice(0, 40) : '',
            subCity: deliveryInfo?.subCity || '',
            location: deliveryInfo?.location || '',
            deliveryAddress: deliveryInfo?.deliveryAddress || '',
            note: deliveryInfo?.note || '',
            phone: deliveryInfo?.phone || customerPhone || '',
            latitude:
              deliveryInfo?.latitude !== undefined &&
              deliveryInfo?.latitude !== null &&
              deliveryInfo?.latitude !== ''
                ? sanitizeCoordinate(deliveryInfo.latitude, -90, 90)
                : null,
            longitude:
              deliveryInfo?.longitude !== undefined &&
              deliveryInfo?.longitude !== null &&
              deliveryInfo?.longitude !== ''
                ? sanitizeCoordinate(deliveryInfo.longitude, -180, 180)
                : null,
          }
        : undefined,
      deliveryFee: deliveryFee,
      items: validatedItems,
      subtotal: subtotal,

      serviceFee: serviceFee,
      // --- Tax / VAT (configurable). Stored per order so reports are accurate. ---
      // vatAmount is recomputed above when the delivery fee came from the
      // distance quote, so it must reflect the real taxable amount charged.
      vatEnabled: charges.vatEnabled,
      vatRate: charges.vatRate,
      vatAmount: vatAmount,
      taxAmount: vatAmount,
      // --- Revenue sharing (configurable). ---
      platformFeeRate: charges.platformFeeRate,
      platformFee: charges.platformFee,
      cafeteriaShare: charges.cafeteriaShare,
      platformShare: charges.platformShare,
      totalAmount: total,
      paymentMethod: normalizedPaymentMethod,
      paymentStatus: PAYMENT_STATUS.PENDING,
      payment: {
        method: normalizedPaymentMethod,
        status: PAYMENT_STATUS.PENDING,
        amount: total,
        currency: charges.currency || 'ETB',
      },
      orderStatus: 'PENDING',
      status: ORDER_STATUS.PENDING,
      orderDate: new Date().toLocaleString(),
      notes: notes || '',
    });
    await OrderStatusHistory.create({
      orderId: order._id,
      previousStatus: 'NONE',
      newStatus: 'PENDING',
      changedBy: req.user.id,
      reason: 'Order placed',
    });
    for (const reservation of reservations) {
      const updated = await MenuItem.findById(reservation.id);
      if (updated) {
        updated.availabilityStatus = updated.stockQuantity === 0 ? 'OUT_OF_STOCK' : updated.availabilityStatus;
        await updated.save();
        await StockTransaction.create({
          foodId: updated._id,
          previousQuantity: reservation.previous,
          quantityChanged: -reservation.quantity,
          newQuantity: updated.stockQuantity,
          action: 'ORDER',
          performedBy: req.user.id,
          orderId: order._id,
        });
      }
    }

    // Create the first-class delivery record. Idempotent (unique index on
    // order), and best-effort so a delivery-side failure can never lose a paid
    // order. The Order stays the source of truth; this only adds dispatch state.
    let deliveryRecord = null;
    if (isDelivery) {
      try {
        const deliveryService = require('../services/delivery.service');
        // ensureDeliveryForOrder links Order.delivery itself and is idempotent.
        deliveryRecord = await deliveryService.ensureDeliveryForOrder(order, { actor: { id: req.user.id } });
      } catch (deliveryError) {
        console.error('Failed to create delivery record for order', order.orderId, deliveryError.message);
      }
    }

    // ✅ Emit socket events for the new order.
    //
    // The KITCHEN is deliberately not told here: per the order lifecycle
    // ("payment successful -> order = PENDING -> kitchen dashboard") an order
    // only enters the kitchen's work queue once its payment is confirmed, and
    // the board itself filters on paymentStatus: 'PAID'. The `order:new`
    // frame and the durable kitchen/management notification are therefore
    // emitted from services/order-queue.service.js when payment succeeds
    // (Chapa verification, simulated checkout or the cashier marking it paid).
    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = order.getSummary();
    emitSocketEvent(`order:${order.orderId}`, 'order:created', orderSummary);
    if (isDelivery) {
      emitSocketEvent('delivery', 'delivery:new', orderSummary);
      // The plain order summary carries no route, distance or fee, so couriers
      // and dispatch additionally get the full tracking payload.
      if (deliveryRecord) {
        const tracking = deliveryRecord.toTrackingPayload();
        emitSocketEvent('delivery', 'delivery:dispatch', tracking);
        emitSocketEvent('admin', 'delivery:dispatch', tracking);
        emitSocketEvent(`order:${tracking.orderId}`, 'delivery:dispatch', tracking);
      }
    }

    // Audit: record order creation (never logs credentials).
    const { logAction } = require('../utils/audit');
    await logAction({
      req,
      action: 'ORDER_CREATED',
      entityType: 'Order',
      entityId: String(order._id),
      description: `Order #${order.orderId} created for ${order.customerName} (${order.customerPhone}) - ${order.orderType} - total ${order.totalAmount}`,
      result: 'SUCCESS',
      metadata: {
        orderId: String(order._id),
        orderType: order.orderType,
        totalAmount: order.totalAmount,
        vatAmount: order.vatAmount,
      },
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      message: MESSAGES.ORDER_PLACED,
      order: orderSummary,
    });
  } catch (error) {
    console.error('❌ Create Order Error:', error);
    for (const reservation of reservations) {
      await MenuItem.findByIdAndUpdate(reservation.id, { $inc: { stockQuantity: reservation.quantity } }).catch(
        () => {}
      );
    }
    // Concurrent duplicate: two requests with the same clientOrderId raced
    // past the pre-check. The unique index rejected the second write, so
    // return the winner instead of an error (still no duplicate order).
    if (error && error.code === 11000 && req.body && req.body.clientOrderId) {
      try {
        const winner = await Order.findOne({
          clientOrderId: String(req.body.clientOrderId).trim().slice(0, 64),
          userId: req.user.id,
        });
        if (winner) {
          return res.status(HTTP_STATUS.OK).json({
            success: true,
            message: MESSAGES.ORDER_PLACED,
            order: winner.getSummary(),
            duplicate: true,
          });
        }
      } catch (_) {
        /* fall through to generic error */
      }
    }
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get all orders (Admin only)
 * @route   GET /api/orders
 * @access  Private/Admin
 *
 * Frontend: admin/orders.html → Load all orders
 * Query Params: status, paymentStatus, date
 * Response: { success, count, orders: [...] }
 */
exports.getAllOrders = async (
  req,

  res
) => {
  try {
    const { status, paymentStatus, date, limit = 50, page = 1 } = req.query;

    // ✅ Build filter
    let filter = {};
    if (status && status !== 'all') filter.status = status;
    if (paymentStatus && paymentStatus !== 'all') filter.paymentStatus = paymentStatus;
    if (date) filter.orderDate = { $regex: date };

    // ✅ Pagination

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // ✅ Execute query
    const orders = await Order.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(parseInt(limit));

    const total = await Order.countDocuments(filter);

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      total: total,

      orders: orders.map((order) => order.getSummary()),
    });
  } catch (error) {
    console.error('❌ Get All Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**

* @desc    Get user's orders
* @route   GET /api/orders/myorders
* @access  Private
*
* Frontend: order-history.js → Load user orders
* Response: { success, count, orders: [...] }
*/
exports.getMyOrders = async (req, res) => {
  try {
    // Completed orders are hidden from the customer dashboard, but an order that
    // is still moving MUST stay visible even when it started before midnight
    // (a late delivery, or a customer who checks just after 00:00). Filtering
    // on "created today" only made the Live Order Tracker unable to find an
    // active order that was genuinely still in progress.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const ACTIVE_STATUSES = [
      'pending',
      'preparing',
      'ready',
      'picked_up',
      'out_for_delivery',
      'arrived',
      'Received',
    ];
    const ACTIVE_ORDER_STATUSES = [
      'PENDING',
      'PREPARING',
      'READY',
      'PICKED_UP',
      'OUT_FOR_DELIVERY',
      'ARRIVED',
    ];

    const orders = await Order.find({
      userId: req.user.id,
      $or: [
        { createdAt: { $gte: todayStart } },
        { status: { $in: ACTIVE_STATUSES } },
        { orderStatus: { $in: ACTIVE_ORDER_STATUSES } },
      ],
    }).sort({ createdAt: -1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      count: orders.length,
      orders: orders.map((order) => order.getSummary()),
    });
  } catch (error) {
    console.error('❌ Get My Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get own order by client-generated idempotency key
 * @route   GET /api/orders/by-client/:clientOrderId
 * @access  Private
 *
 * Frontend: order-tracking pending mode → poll until the order created by the
 * 5s-deadline checkout appears. Scoped to the requesting user by design.
 * Response: { success, order }
 */
exports.getOrderByClientId = async (req, res) => {
  try {
    const clientOrderId = String(req.params.clientOrderId || '').trim().slice(0, 64);
    if (!clientOrderId) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({ success: false, error: 'A client order id is required.' });
    }
    const order = await Order.findOne({ clientOrderId, userId: req.user.id });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({ success: false, error: 'Order not found' });
    }
    res.status(HTTP_STATUS.OK).json({ success: true, order: order.getSummary() });
  } catch (error) {
    console.error('❌ Get Order By Client Id Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({ success: false, error: MESSAGES.SERVER_ERROR });
  }
};

/**
 * @desc    Get order by ID
 * @route   GET /api/orders/:id
 * @access  Private
 *
 * Frontend: order-status.js → Load order details
 * Response: { success, order }
 */
exports.getOrderById = async (req, res) => {
  try {
    // Populate the assigned courier: the customer tracking page shows the rider's
    // name, and without this the field is a bare ObjectId.
    const order = await Order.findOne({ orderId: req.params.id }).populate(
      'deliveryStaffAssigned',
      'name phone role photo avatar'
    );

    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // ✅ Check if user owns order or is admin / kitchen staff
    const viewerRole = String(req.user.role || '').toLowerCase();
    const isStaff = ['admin', 'staff', 'kitchen', 'kitchen_staff', 'foodmaker'].includes(viewerRole);
    if (order.userId.toString() !== req.user.id.toString() && !isStaff) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,

        error: 'Unauthorized to view this order',
      });
    }

    // Delivery tracking data: only resolved for delivery orders. The cafeteria
    // coordinate lets the tracking map show where the order originated even if
    // the destination is address-only.
    let caf = null;
    let delivery = null;
    if (order.orderType === 'delivery') {
      caf = order.cafeteriaId
        ? await Cafeteria.findById(order.cafeteriaId, 'name code latitude longitude address phone')
        : await Cafeteria.findOne({ code: 'MAIN' }, 'name code latitude longitude address phone');
      // The Delivery record owns the distance / ETA the tracking page shows, and
      // the canonical lifecycle state. Read-only here; this endpoint never moves
      // a delivery forward.
      delivery = await Delivery.findOne({ order: order._id }).lean();
    }

    const courier =
      order.deliveryStaffAssigned && order.deliveryStaffAssigned.name
        ? {
            id: String(order.deliveryStaffAssigned._id),
            name: order.deliveryStaffAssigned.name,
            phone: order.deliveryStaffAssigned.phone || '',
            photo: order.deliveryStaffAssigned.photo || order.deliveryStaffAssigned.avatar || null,
          }
        : null;

    // Canonical GPS pair for the customer tracking page. Same stored values as
    // `currentLocation` / `deliveryInfo` - nothing is duplicated in Mongo, the
    // fields are just given the names the tracking map and the dashboard read.
    // NOTE: `currentLocation` is a subdocument that defaults to a null-filled
    // object (truthy!), so a plain `||` would never fall through to the
    // Delivery record. Pick the first point that actually has coordinates.
    const hasCoords = (p) => Boolean(p) && p.latitude != null && p.longitude != null;
    const deliveryLocation =
      [order.currentLocation, delivery && delivery.currentLocation].find(hasCoords) || null;
    const destination =
      (delivery && delivery.destination) ||
      {
        latitude: order.deliveryInfo?.latitude ?? null,
        longitude: order.deliveryInfo?.longitude ?? null,
        address:
          order.deliveryInfo?.deliveryAddress ||
          [order.deliveryInfo?.subCity, order.deliveryInfo?.location].filter(Boolean).join(', ') ||
          '',
      };
    const customerLocation = {
      latitude: destination.latitude ?? null,
      longitude: destination.longitude ?? null,
      address: destination.address || '',
    };
    // Haversine on the server (never a lat/long subtraction) so the customer's
    // distance readout matches the courier's dashboard to the metre.
    const proximity = deliveryService.proximityToCustomer(deliveryLocation, customerLocation);
    const trackingActive = delivery
      ? deliveryService.isGpsAllowed(delivery.status)
      : ['picked_up', 'out_for_delivery', 'arrived'].includes(String(order.status || '').toLowerCase());

    res.status(HTTP_STATUS.OK).json({
      success: true,
      order: {
        ...order.getSummary(),
        items: order.items,
        orderDate: order.orderDate,
        orderTime: order.orderTime,
        readyTime: order.readyTime,
        completedTime: order.completedTime,
        cancellationReason: order.cancellationReason,
        notes: order.notes,
        orderStatus: order.orderStatus,
        currentLocation: deliveryLocation || order.currentLocation || null,
        // --- live GPS contract (see the comment above) ---
        deliveryLocation: deliveryLocation
          ? {
              latitude: deliveryLocation.latitude,
              longitude: deliveryLocation.longitude,
              accuracy: deliveryLocation.accuracy ?? null,
              heading: deliveryLocation.heading ?? null,
              speed: deliveryLocation.speed ?? null,
              updatedAt: deliveryLocation.timestamp || null,
            }
          : null,
        customerLocation,
        hasCustomerLocation: proximity.hasCustomerLocation,
        distanceToCustomerKm: proximity.distanceKm,
        nearCustomer: proximity.nearCustomer,
        trackingActive,
        // GPS runs only while the delivery is PICKED_UP / OUT_FOR_DELIVERY /
        // ARRIVED. Once it flips false the tracking page must stop expecting
        // `delivery:location` frames and show the last known fix instead.
        lastGpsUpdateAt: deliveryLocation ? deliveryLocation.timestamp || null : null,
        deliveryAddress:
          order.deliveryInfo?.deliveryAddress ||
          [order.deliveryInfo?.subCity, order.deliveryInfo?.location].filter(Boolean).join(', ') ||
          '',
        cafeteriaLocation: caf
          ? {
              name: caf.name,
              code: caf.code,
              latitude: caf.latitude,
              longitude: caf.longitude,
              address: caf.address,
            }
          : null,
        // --- customer tracking detail (distance / ETA / rider / state) ---
        // Derived from the Delivery record when it exists, and from the order
        // itself for legacy delivery orders that predate it.
        deliveryStatus: delivery ? delivery.status : null,
        deliveryStatusLabel: delivery ? delivery.status : null,
        deliveryCourier: courier,
        distanceKm: delivery ? delivery.distanceKm : null,
        etaMinutes: delivery ? delivery.etaMinutes : null,
        pickupLocation: delivery ? delivery.pickupLocation : null,
        destination: delivery ? delivery.destination : null,
        deliveredAt: delivery ? delivery.deliveredAt : order.deliveredAt || null,
        isDeliveryActive: delivery
          ? ['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED'].includes(delivery.status)
          : false,
      },
    });
  } catch (error) {
    console.error('❌ Get Order By ID Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Update order status (Kitchen/Admin)
 * @route   PATCH /api/orders/:id/status
 * @access  Private/Kitchen/Admin
 *
 * Frontend: kitchen/dashboard.html → Update status
 * Expected Body: { status }
 * Response: { success, order }
 */
exports.updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;

    // ✅ Validate status

    const validStatuses = ['pending', 'preparing', 'ready', 'arrived', 'out_for_delivery', 'delivered', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: 'Invalid status',
      });
    }

    const order = await Order.findOne({ orderId: req.params.id });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // A delivery order's final states are owned by the delivery state machine:
    // DELIVERED requires proof of delivery and COMPLETED is the assigned
    // courier's close-out. Letting this generic endpoint write them would let a
    // kitchen tap finish a delivery with no proof and no courier involved.
    if (order.orderType === 'delivery' && ['delivered', 'completed'].includes(status)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error:
          'Use the delivery endpoints to finish a delivery: /api/v1/deliveries/:id/delivered (proof of ' +
          'delivery required) and /api/v1/deliveries/:id/complete.',
      });
    }

    // ✅ Update status
    order.status = status;
    order.orderStatus = status.toUpperCase();

    // ✅ Set timestamps
    if (status === 'ready') {
      order.readyTime = new Date();
    }
    if (status === 'served') {
      order.completedTime = new Date();
    }
    if (status === 'out_for_delivery') {
      order.deliveryStartedAt = new Date();
    }
    if (status === 'delivered') {
      order.deliveredAt = new Date();
      order.completedTime = new Date();
    }

    await order.save();

    // ✅ Emit socket event for order status update
    const { emitSocketEvent } = require('../utils/socket');
    const orderSummary = order.getSummary();
    emitSocketEvent('kitchen', 'order:status', orderSummary);
    emitSocketEvent(`order:${order.orderId}`, 'order:status', orderSummary);
    if (order.orderType === 'delivery') {
      emitSocketEvent('delivery', 'order:status', orderSummary);

      // The kitchen drives READY (and legacy out_for_delivery / delivered).
      // Mirror that onto the delivery record so dispatch never shows a stale
      // state, but let the delivery state machine reject illegal jumps.
      try {
        const deliveryService = require('../services/delivery.service');
        const targetByKitchenStatus = {
          ready: null, // READY stays REQUESTED: the food is waiting for a courier
          out_for_delivery: deliveryService.DELIVERY_STATUS.OUT_FOR_DELIVERY,
          delivered: deliveryService.DELIVERY_STATUS.DELIVERED,
          completed: deliveryService.DELIVERY_STATUS.COMPLETED,
          cancelled: deliveryService.DELIVERY_STATUS.CANCELLED,
        };
        const target = targetByKitchenStatus[status];
        if (target) {
          const existing = await deliveryService.findDeliveryByReference(order, { populateOrder: false });
          if (existing && !deliveryService.isTerminal(existing.status)) {
            await deliveryService.applyDeliveryStatus({
              delivery: existing,
              status: target,
              actor: { id: req.user.id },
              reason: `Kitchen set the order to ${status}`,
              allowTerminal: true,
            });
          }
        }
      } catch (deliveryError) {
        console.warn(
          `Delivery status sync skipped for order ${order.orderId}:`,
          deliveryError.message
        );
      }
    }

    // Audit: record order status change (kitchen/admin).
    const { logAction } = require('../utils/audit');
    await logAction({
      req,
      action: 'ORDER_STATUS_CHANGED',
      entityType: 'Order',
      entityId: String(order._id),
      description: `Order #${order.orderId} status changed to ${status}`,
      result: 'SUCCESS',
      metadata: { previousStatus: order._previousStatus || 'NONE', newStatus: status },
    });

    // ✅ Create notification for customer
    const readyMsg = order.orderType === 'delivery' ? 'ready for delivery' : 'ready for pickup';
    const statusTitle = {
      ready: order.orderType === 'delivery' ? 'Order Ready for Delivery!' : 'Order Ready!',
      out_for_delivery: 'Order Out for Delivery!',
      delivered: 'Order Delivered!',
      preparing: 'Order Preparing',
      arrived: 'Order Arrived!',
      completed: 'Order Completed!',
    };
    const statusMessage = {
      ready: `Your order #${order.orderId} is ${readyMsg}!`,
      out_for_delivery: `Your order #${order.orderId} is out for delivery. Our delivery person is on the way!`,
      delivered: `Your order #${order.orderId} has been delivered. Enjoy your meal!`,
      preparing: `Your order #${order.orderId} is being prepared`,
      arrived: `Your order #${order.orderId} has arrived at the destination!`,
      completed: `Your order #${order.orderId} has been completed!`,
    };
    if (statusMessage[status]) {
      const notification = await Notification.create({
        userId: order.userId,
        title: statusTitle[status],
        message: statusMessage[status],
        type: status === 'ready' ? 'ready' : 'status_update',
        orderId: order.orderId,
        isRead: false,
      });

      // ✅ Send real-time notification to correct customer only (user room)
      emitSocketEvent(`user:${order.userId}`, 'notification:new', {
        id: notification._id,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        orderId: notification.orderId,
        link: notification.link || `/src/pages/customer/order-tracking.html?orderId=${order.orderId}`,
        isRead: notification.isRead,
        createdAt: notification.createdAt,
      });
    }

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order status updated to ${status}`,
      order: orderSummary,
    });
  } catch (error) {
    console.error('❌ Update Order Status Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
* @desc    Cancel order (Customer)
* @route   PATCH /api/orders/:id/cancel
* @access  Private
*
* Frontend: order-status.js → Cancel Order
* Expected Body: { reason }
* Response: { success, message }

*/
exports.cancelOrder = async (req, res) => {
  try {
    const { reason } = req.body;

    const order = await Order.findOne({ orderId: req.params.id });
    if (!order) {
      return res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: 'Order not found',
      });
    }

    // ✅ Check if user owns order
    if (String(order.userId) !== String(req.user.id)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: 'You can only cancel your own orders',
      });
    }

    // ✅ Check if order can be cancelled (use both status fields)
    const currentStatus = String(order.orderStatus || order.status || '').toUpperCase();
    if (['CANCELLED', 'COMPLETED', 'DELIVERED', 'SERVED'].includes(currentStatus)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order cannot be cancelled (status: ${currentStatus})`,
      });
    }

    // ✅ Only PENDING orders can be cancelled by customer
    if (currentStatus !== 'PENDING') {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: `Order can only be cancelled while pending (current status: ${currentStatus})`,
      });
    }

    // ✅ For PAID orders, route through the cancellation service which handles
    //    refund requests and admin notification (PENDING → CANCELLED → Admin Refund → REFUNDED)
    const paid = String(order.paymentStatus || '').toUpperCase() === 'PAID';
    if (paid) {
      const svc = require('../services/cancellation.service');
      const { cancellation } = await svc.createCancellation(order, req.user, {
        reason: reason || 'CUSTOMER_CHANGED_MIND',
        description: reason || 'Cancelled by customer',
        source: 'customer',
      });

      // Approve immediately (PENDING order is always cancellable)
      cancellation.status = 'APPROVED';
      cancellation.approvedAt = new Date();
      cancellation.processedBy = req.user.id;
      cancellation.adminNote = 'Auto-cancelled by customer (pending order)';
      cancellation.paymentStatus = order.paymentStatus || 'PENDING';
      await cancellation.save();

      await svc.cancelOrderForApproval({
        order,
        cancellation,
        actorId: req.user.id,
        adminNote: cancellation.adminNote,
        source: 'customer',
      });

      // Mark refund as requested — admin will process it
      cancellation.refundStatus = 'REFUND_REQUESTED';
      cancellation.refundAmount = order.totalAmount;
      await cancellation.save();

      order.refundStatus = 'REFUND_REQUESTED';
      order.refundAmount = order.totalAmount;
      await order.save();

      const Payment = require('../models/Payment');
      try {
        await Payment.findOneAndUpdate(
          { orderId: order._id },
          { status: 'PAID', refundStatus: 'PENDING', refundAmount: order.totalAmount }
        );
      } catch (_) {
        /* best effort */
      }

      const Notification = require('../models/Notification');
      await Notification.create({
        userId: order.userId,
        title: 'Order Cancelled',
        message: `Your order #${order.orderId} has been cancelled. Your refund of ${order.totalAmount} ETB will be processed shortly.`,
        type: 'order',
        orderId: order.orderId,
        isRead: false,
      });

      res.status(HTTP_STATUS.OK).json({
        success: true,
        message: `Order #${order.orderId} cancelled successfully. Your refund will be processed by an administrator.`,
      });
      return;
    }

    // ✅ For unpaid orders, cancel directly (no refund needed)
    order.status = 'cancelled';
    order.orderStatus = 'CANCELLED';
    order.cancellationReason = reason || 'Cancelled by customer';
    order.cancellationStatus = 'approved';
    order.cancellationProcessedAt = new Date();
    order.cancellationProcessedBy = req.user.id;
    await order.save();

    const { emitCancellationStatus, syncDeliveryCancellation } = require('../services/cancellation.service');
    // A cancelled delivery must not leave a live job on the courier's board.
    await syncDeliveryCancellation(order, {
      actorId: req.user.id,
      adminNote: order.cancellationReason,
      source: 'customer',
    });
    // Awaited so the kitchen's durable "Order Cancelled" record exists before
    // the customer sees their confirmation, and before the request can return.
    await emitCancellationStatus(order, 'customer', order.cancellationProcessedAt);

    const Notification = require('../models/Notification');
    await Notification.create({
      userId: order.userId,
      title: 'Order Cancelled',
      message: `Your order #${order.orderId} has been cancelled.`,
      type: 'order',
      orderId: order.orderId,
      isRead: false,
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      message: `Order #${order.orderId} cancelled successfully`,
    });
  } catch (error) {
    console.error('❌ Cancel Order Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
* @desc    Get order statistics

(Admin only)
* @route   GET /api/orders/stats
* @access  Private/Admin
*
* Frontend: admin/dashboard.html → Metrics
* Response: { totalOrders, pendingOrders, preparingOrders, completedOrders, totalRevenue }
*/
exports.getOrderStats = async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();
    const pendingOrders = await Order.countDocuments({ status: 'pending' });

    const preparingOrders = await Order.countDocuments({ status: 'preparing' });
    const readyOrders = await Order.countDocuments({ status: 'ready' });
    const completedOrders = await Order.countDocuments({ status: 'served' });
    const cancelledOrders = await Order.countDocuments({ status: 'cancelled' });

    // ✅ Calculate revenue (only completed orders)
    const completedOrdersData = await Order.find({ status: 'served' });
    const totalRevenue = completedOrdersData.reduce((sum, order) => sum + order.totalAmount, 0);

    // ✅ Today's orders
    const today = new Date().toISOString().split('T')[0];
    const todayOrders = await Order.countDocuments({
      orderDate: { $regex: today },
    });

    res.status(HTTP_STATUS.OK).json({
      success: true,
      stats: {
        totalOrders,
        pendingOrders,

        preparingOrders,
        readyOrders,
        completedOrders,
        cancelledOrders,
        totalRevenue,
        todayOrders,
      },
    });
  } catch (error) {
    console.error('❌ Get Order Stats Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};

/**
 * @desc    Get kitchen orders (For Kitchen Dashboard)
 * @route   GET /api/orders/kitchen
 * @access  Private/Kitchen
 *
 * Frontend: kitchen/dashboard.html → Live orders
 * Response: { success, orders: [...] }
 */
exports.getKitchenOrders = async (req, res) => {
  try {
    const { status } = req.query;

    // ✅ Only show orders created today (past orders are hidden from the board)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    let filter = { createdAt: { $gte: todayStart } };
    if (status && status !== 'all') {
      const normalizedStatus = String(status).toLowerCase();
      filter.$or = [
        { status: normalizedStatus },
        { status: normalizedStatus.toUpperCase() },
        { orderStatus: normalizedStatus.toUpperCase() },
      ];
    } else {
      filter.$or = [
        {
          status: {
            $in: [
              'pending',
              'preparing',
              'ready',
              'served',
              'cancelled',
              'PENDING',
              'PREPARING',
              'READY',
              'SERVED',
              'CANCELLED',
              'Received',
              'RECEIVED',
            ],
          },
        },
        { orderStatus: { $in: ['PENDING', 'PREPARING', 'READY', 'SERVED', 'RECEIVED', 'CANCELLED'] } },
      ];
    }

    const orders = await Order.find(filter).populate('userId', 'name phone').sort({ createdAt: -1 });

    res.status(HTTP_STATUS.OK).json({
      success: true,

      count: orders.length,
      orders: orders.map((o) => formatKitchenOrder(o)),
    });
  } catch (error) {
    console.error('❌ Get Kitchen Orders Error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: MESSAGES.SERVER_ERROR,
    });
  }
};
