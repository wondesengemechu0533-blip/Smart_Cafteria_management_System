const { HTTP_STATUS } = require('../config/constants');
const {
  validateObjectId,
  validateOrderStatus,
  validateQuantity,
  validateEnum,
  validateName,
  validatePhone,
} = require('./common.validator');

const validateCreateOrder = (data) => {
  const errors = {};

  if (!Array.isArray(data.items) || data.items.length === 0) {
    errors.items = 'Cart cannot be empty';
  } else {
    data.items.forEach((item, index) => {
      const itemId = item.itemId || item.id;
      if (!itemId || String(itemId).trim() === '') {
        errors[`items.${index}.itemId`] = 'Menu item ID is required';
      }
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        errors[`items.${index}.quantity`] = 'Quantity must be a positive integer';
      }
    });
  }

  const nameErr = validateName(data.customerName, 'Customer name', 2, 100);
  if (nameErr) errors.customerName = nameErr;

  const phoneErr = validatePhone(data.customerPhone);
  if (phoneErr) errors.customerPhone = phoneErr;

  if (data.orderType) {
    const typeErr = validateEnum(data.orderType, ['dine-in', 'takeaway', 'delivery'], 'Order type');
    if (typeErr) errors.orderType = typeErr;
  }

  if (String(data.orderType || '').toLowerCase() === 'delivery') {
    const info = data.deliveryInfo || {};
    // Structured Ethiopian address (any city): the street may arrive as the
    // legacy `location` or as the separate `streetArea`; the area may arrive
    // as the legacy `subCity` or as the separate `area`. Either shape passes
    // so old and new checkouts both validate. No city is ever hardcoded here.
    const street = info.streetArea !== undefined && info.streetArea !== null && String(info.streetArea).trim() !== ''
      ? String(info.streetArea)
      : info.location;
    const area = info.area !== undefined && info.area !== null && String(info.area).trim() !== ''
      ? String(info.area)
      : info.subCity;
    if (!street || String(street).trim() === '') {
      errors['deliveryInfo.location'] = 'Delivery location is required';
    }
    if (!area || String(area).trim() === '') {
      errors['deliveryInfo.subCity'] = 'Delivery sub-city is required';
    }
  }

  if (data.tableId !== undefined && data.tableId !== null && typeof data.tableId !== 'string') {
    errors.tableId = 'Table ID must be a string';
  }

  if (data.tableNumber !== undefined) {
    if (typeof data.tableNumber !== 'string' && typeof data.tableNumber !== 'number') {
      errors.tableNumber = 'Table number must be a string or number';
    }
  }

  const methodErr = validateEnum(data.paymentMethod, ['CHAPA'], 'Payment method');
  if (methodErr) errors.paymentMethod = methodErr;

  if (data.totalAmount !== undefined) {
    const amount = Number(data.totalAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      errors.totalAmount = 'Total amount must be a positive number';
    }
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

const validateUpdateOrderStatus = (data) => {
  const errors = {};
  const statusErr = validateOrderStatus(data.status);
  if (statusErr) errors.status = statusErr;
  return { isValid: Object.keys(errors).length === 0, errors };
};

const validateCancelOrder = (data) => {
  const errors = {};
  if (data.reason && typeof data.reason !== 'string') {
    errors.reason = 'Reason must be a string';
  }
  if (data.adminNote && typeof data.adminNote !== 'string') {
    errors.adminNote = 'Admin note must be a string';
  }
  return { isValid: Object.keys(errors).length === 0, errors };
};

module.exports = {
  validateCreateOrder,
  validateUpdateOrderStatus,
  validateCancelOrder,
};
