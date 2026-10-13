const { HTTP_STATUS } = require('../config/constants');
const {
  validateObjectId,
  validatePaymentStatus,
  validateEnum,
  validatePhone,
  validateName,
} = require('./common.validator');

const validatePaymentInput = (data) => {
  const errors = {};

  if (!data.orderId || typeof data.orderId !== 'string' || data.orderId.trim().length === 0) {
    errors.orderId = 'Order ID is required';
  }

  const methodErr = validateEnum(data.method, ['CHAPA'], 'Payment method');
  if (methodErr) errors.method = methodErr;

  return { isValid: Object.keys(errors).length === 0, errors };
};

const validatePaymentVerification = (data) => {
  const errors = {};

  if (data.txRef) {
    if (typeof data.txRef !== 'string' || data.txRef.trim().length === 0) {
      errors.txRef = 'Transaction reference must be a non-empty string';
    }
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

const validateAdminPaymentFilter = (data) => {
  const errors = {};
  if (!data) return { isValid: true, errors };

  if (data.method) {
    const methodErr = validateEnum(data.method, ['CHAPA'], 'Payment method');
    if (methodErr) errors.method = methodErr;
  }

  if (data.status) {
    const statusErr = validatePaymentStatus(data.status);
    if (statusErr) errors.status = statusErr;
  }

  if (data.startDate) {
    const dateErr = validateDate(data.startDate, 'Start date');
    if (dateErr) errors.startDate = dateErr;
  }

  if (data.endDate) {
    const dateErr = validateDate(data.endDate, 'End date');
    if (dateErr) errors.endDate = dateErr;
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

module.exports = {
  validatePaymentInput,
  validatePaymentVerification,
  validateAdminPaymentFilter,
};
