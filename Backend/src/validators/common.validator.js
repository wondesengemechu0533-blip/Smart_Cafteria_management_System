const { ORDER_STATUS, PAYMENT_STATUS } = require('../config/constants');
const { ROLES, normalizeRole } = require('../config/roles');

const VALID_ORDER_STATUSES = [
  'PENDING',
  'PREPARING',
  'READY',
  'READY_FOR_DELIVERY',
  'PICKED_UP',
  'ARRIVED',
  'SERVED',
  'COMPLETED',
  'CANCELLED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'pending',
  'preparing',
  'ready',
  'ready_for_delivery',
  'picked_up',
  'arrived',
  'served',
  'completed',
  'cancelled',
  'out_for_delivery',
  'delivered',
];

const VALID_PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAILED', 'CANCELLED'];

const isValidObjectId = (id) => {
  if (!id || typeof id !== 'string') return false;
  return /^[0-9a-fA-F]{24}$/.test(id);
};

const isValidDate = (date) => {
  if (!date) return false;
  const d = new Date(date);
  return d instanceof Date && !isNaN(d.getTime());
};

const validateRole = (role) => {
  const normalized = normalizeRole(role);
  if (!normalized) return 'Role is required';

  if (!ROLES.includes(normalized)) {
    return `Invalid role. Allowed: ${ROLES.join(', ')}`;
  }
  return null;
};

const validateOrderStatus = (status) => {
  if (!status) return 'Status is required';
  if (!VALID_ORDER_STATUSES.includes(status)) {
    return `Invalid order status. Allowed: ${VALID_ORDER_STATUSES.join(', ')}`;
  }
  return null;
};

const validatePaymentStatus = (status) => {
  if (!status) return 'Payment status is required';
  if (!VALID_PAYMENT_STATUSES.includes(status)) {
    return `Invalid payment status. Allowed: ${VALID_PAYMENT_STATUSES.join(', ')}`;
  }
  return null;
};

const validateObjectId = (id, fieldName = 'ID') => {
  if (!id) return `${fieldName} is required`;
  if (!isValidObjectId(id)) return `Invalid ${fieldName} format`;
  return null;
};

const validateDate = (date, fieldName = 'Date') => {
  if (!date) return `${fieldName} is required`;
  if (!isValidDate(date)) return `Invalid ${fieldName} format (use ISO 8601)`;
  return null;
};

const validateDateRange = (startDate, endDate) => {
  if (!startDate || !endDate) return 'Both start and end dates are required';
  if (!isValidDate(startDate)) return 'Invalid start date format';
  if (!isValidDate(endDate)) return 'Invalid end date format';
  if (new Date(startDate) > new Date(endDate)) return 'Start date must be before end date';
  return null;
};

const validateEmail = (email) => {
  if (!email) return 'Email is required';
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) return 'Invalid email format';
  return null;
};

const validatePassword = (password, minLength = 8) => {
  if (!password) return 'Password is required';
  if (password.length < minLength) return `Password must be at least ${minLength} characters`;
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password))
    return 'Password must contain at least one special character';
  return null;
};

const validateName = (name, fieldName = 'Name', min = 2, max = 100) => {
  if (!name) return `${fieldName} is required`;
  const trimmed = name.trim();
  if (trimmed.length < min) return `${fieldName} must be at least ${min} characters`;
  if (trimmed.length > max) return `${fieldName} cannot exceed ${max} characters`;
  return null;
};

const validatePhone = (phone) => {
  if (!phone) return 'Phone number is required';
  const phoneRegex = /^(\+251[0-9]{9}|(09|07)[0-9]{8})$/;
  if (!phoneRegex.test(phone)) return 'Enter a valid Ethiopian phone number (e.g. 09XXXXXXXX or +2519XXXXXXXX)';
  return null;
};

const validateFullName = (name) => {
  if (!name) return 'Full name is required';
  const trimmed = name.trim();
  if (trimmed.length < 2) return 'Full name must be at least 2 characters';
  if (trimmed.length > 100) return 'Full name cannot exceed 100 characters';
  if (!/^[a-zA-Z\s]+$/.test(trimmed)) return 'Full name can only contain letters and spaces';
  return null;
};

const validateUsername = (username) => {
  if (!username || username.trim() === '') return null;
  const trimmed = username.trim();
  if (trimmed.length < 3) return 'Username must be at least 3 characters';
  if (trimmed.length > 30) return 'Username cannot exceed 30 characters';
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) return 'Username can only contain letters, numbers, and underscores';
  return null;
};

const validateAddress = (address) => {
  if (!address || address.trim() === '') return null;
  if (address.trim().length > 255) return 'Address cannot exceed 255 characters';
  return null;
};

const validatePrice = (price) => {
  if (price === undefined || price === null || price === '') return 'Price is required';
  const num = Number(price);
  if (!Number.isFinite(num) || num <= 0) return 'Price must be a number greater than 0';
  return null;
};

const validateCategory = (category) => {
  if (!category) return 'Category is required';
  const VALID_CATEGORIES = ['breakfast', 'main-meals', 'fasting', 'beverages', 'snacks'];
  if (!VALID_CATEGORIES.includes(category)) {
    return `Invalid category. Allowed: ${VALID_CATEGORIES.join(', ')}`;
  }
  return null;
};

const validateQuantity = (quantity, fieldName = 'Quantity', min = 1, max = 100) => {
  if (quantity === undefined || quantity === null || quantity === '') return `${fieldName} is required`;
  const num = Number(quantity);
  if (!Number.isInteger(num) || num < min || num > max) {
    return `${fieldName} must be an integer between ${min} and ${max}`;
  }
  return null;
};

const validateBoolean = (value, fieldName) => {
  if (value === undefined || value === null) return `${fieldName} is required`;
  if (typeof value !== 'boolean') return `${fieldName} must be a boolean`;
  return null;
};

const validateEnum = (value, allowedValues, fieldName) => {
  if (!value) return `${fieldName} is required`;
  if (!allowedValues.includes(value)) {
    return `Invalid ${fieldName}. Allowed: ${allowedValues.join(', ')}`;
  }
  return null;
};

module.exports = {
  validateRole,
  validateOrderStatus,
  validatePaymentStatus,
  validateObjectId,
  validateDate,
  validateDateRange,
  validateEmail,
  validatePassword,
  validateName,
  validateFullName,
  validateUsername,
  validateAddress,
  validatePhone,
  validatePrice,
  validateCategory,
  validateQuantity,
  validateBoolean,
  validateEnum,
  normalizeRole,
  ROLES,
  VALID_ROLES: ROLES,
  VALID_ORDER_STATUSES,
  VALID_PAYMENT_STATUSES,
  isValidObjectId,
  isValidDate,
};
