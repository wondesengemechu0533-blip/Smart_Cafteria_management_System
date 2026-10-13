const { validateName, validateEnum } = require('./common.validator');

const VALID_CATEGORIES = ['breakfast', 'mains', 'main-meals', 'fasting', 'beverages', 'snacks', 'Lunch', 'Dinner'];

const validateCreateCategory = (data) => {
  const errors = {};

  const nameErr = validateName(data.name, 'Category name', 2, 50);
  if (nameErr) errors.name = nameErr;

  const catErr = validateEnum(data.category, VALID_CATEGORIES, 'Category');
  if (catErr) errors.category = catErr;

  if (data.description !== undefined) {
    if (typeof data.description !== 'string') {
      errors.description = 'Description must be a string';
    } else if (data.description.trim().length > 500) {
      errors.description = 'Description cannot exceed 500 characters';
    }
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

const validateUpdateCategory = (data) => {
  const errors = {};

  if (data.name !== undefined) {
    const nameErr = validateName(data.name, 'Category name', 2, 50);
    if (nameErr) errors.name = nameErr;
  }

  if (data.category !== undefined) {
    const catErr = validateEnum(data.category, VALID_CATEGORIES, 'Category');
    if (catErr) errors.category = catErr;
  }

  if (data.description !== undefined) {
    if (typeof data.description !== 'string') {
      errors.description = 'Description must be a string';
    } else if (data.description.trim().length > 500) {
      errors.description = 'Description cannot exceed 500 characters';
    }
  }

  if (data.isActive !== undefined) {
    if (typeof data.isActive !== 'boolean') {
      errors.isActive = 'isActive must be a boolean';
    }
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

module.exports = {
  validateCreateCategory,
  validateUpdateCategory,
};
