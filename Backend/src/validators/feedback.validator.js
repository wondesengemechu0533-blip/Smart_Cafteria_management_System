const { validateObjectId, validateQuantity } = require('./common.validator');

const validateFeedbackInput = (data) => {
  const errors = {};

  if (data.orderId) {
    const orderIdErr = validateObjectId(data.orderId, 'Order ID');
    if (orderIdErr) errors.orderId = orderIdErr;
  }

  const ratingErr = validateQuantity(data.rating, 'Rating', 1, 5);
  if (ratingErr) errors.rating = ratingErr;

  if (data.comment !== undefined) {
    if (typeof data.comment !== 'string') {
      errors.comment = 'Comment must be a string';
    } else if (data.comment.trim().length > 500) {
      errors.comment = 'Comment cannot exceed 500 characters';
    }
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

module.exports = {
  validateFeedbackInput,
};
