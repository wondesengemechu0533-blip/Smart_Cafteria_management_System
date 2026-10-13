const validateRefundInput = (body) => {
  const errors = {};
  if (!body.orderId || !String(body.orderId).trim()) {
    errors.orderId = 'Order is required';
  }
  if (!body.reason || !String(body.reason).trim()) {
    errors.reason = 'Refund reason is required';
  } else if (String(body.reason).trim().length > 500) {
    errors.reason = 'Reason cannot exceed 500 characters';
  }
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    const num = Number(body.amount);
    if (!Number.isFinite(num) || num <= 0) errors.amount = 'Amount must be a positive number';
  }
  return { isValid: Object.keys(errors).length === 0, errors };
};

const validateRefundDecision = (body) => {
  const errors = {};
  if (body.adminNote !== undefined && String(body.adminNote).length > 500) {
    errors.adminNote = 'Note cannot exceed 500 characters';
  }
  return { isValid: Object.keys(errors).length === 0, errors };
};

module.exports = { validateRefundInput, validateRefundDecision };
