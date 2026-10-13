function vt(key, fallback) {
  if (typeof window.tr === "function" && window.tr !== tr) return window.tr(key, fallback);
  if (typeof getText === "function") { const g = getText(key); if (g && g !== key) return g; }
  return fallback;
}
/**
 * ================================================================
 * SMART CAFETERIA ORDERING SYSTEM - VALIDATORS
 * ================================================================
 * Input validation utilities for forms and data.
 * ================================================================
 */

const PATTERNS = window.PATTERNS || {};

/**
 * Validation result object
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether validation passed
 * @property {string|null} error - Error message if invalid
 */

/**
 * Create validation result
 * @param {boolean} valid - Validation status
 * @param {string|null} error - Error message
 * @returns {ValidationResult}
 */
function result(valid, error = null) {
    return { valid, error };
}

// ===== 1. EMAIL VALIDATION =====
/**
 * Validate email address
 * @param {string} email - Email to validate
 * @returns {ValidationResult}
 */
export function validateEmail(email) {
    if (!email || email.trim() === '') {
        return result(false, 'Email is required');
    }
    if (!PATTERNS.email.test(email.trim())) {
        return result(false, vt('valid_email', 'Please enter a valid email address'));
    }
    return result(true);
}

// ===== 2. PASSWORD VALIDATION =====
/**
 * Validate password
 * @param {string} password - Password to validate
 * @param {number} minLength - Minimum length (default: 6)
 * @returns {ValidationResult}
 */
export function validatePassword(password, minLength = 6) {
    if (!password || password.trim() === '') {
        return result(false, 'Password is required');
    }
    if (password.length < minLength) {
        return result(false, `Password must be at least ${minLength} characters`);
    }
    return result(true);
}

/**
 * Validate password confirmation
 * @param {string} password - Original password
 * @param {string} confirmPassword - Confirmation password
 * @returns {ValidationResult}
 */
export function validatePasswordMatch(password, confirmPassword) {
    if (password !== confirmPassword) {
        return result(false, 'Passwords do not match');
    }
    return result(true);
}

// ===== 3. NAME VALIDATION =====
/**
 * Validate name (full name or username)
 * @param {string} name - Name to validate
 * @param {number} minLength - Minimum length (default: 2)
 * @param {number} maxLength - Maximum length (default: 50)
 * @returns {ValidationResult}
 */
export function validateName(name, minLength = 2, maxLength = 50) {
    if (!name || name.trim() === '') {
        return result(false, 'Name is required');
    }
    const trimmed = name.trim();
    if (trimmed.length < minLength) {
        return result(false, `Name must be at least ${minLength} characters`);
    }
    if (trimmed.length > maxLength) {
        return result(false, `Name must be at most ${maxLength} characters`);
    }
    if (!PATTERNS.name.test(trimmed)) {
        return result(false, 'Name contains invalid characters');
    }
    return result(true);
}

// ===== 4. PHONE VALIDATION =====
/**
 * Validate phone number
 * @param {string} phone - Phone number to validate
 * @returns {ValidationResult}
 */
export function validatePhone(phone) {
    if (!phone || phone.trim() === '') {
        return result(false, 'Phone number is required');
    }
    const trimmed = phone.trim();
    if (!PATTERNS.phone.test(trimmed)) {
        return result(false, vt('valid_phone', 'Please enter a valid phone number'));
    }
    return result(true);
}

// ===== 5. QUANTITY VALIDATION =====
/**
 * Validate quantity
 * @param {number} quantity - Quantity to validate
 * @param {number} min - Minimum value (default: 1)
 * @param {number} max - Maximum value (default: 99)
 * @returns {ValidationResult}
 */
export function validateQuantity(quantity, min = 1, max = 99) {
    if (quantity === undefined || quantity === null) {
        return result(false, 'Quantity is required');
    }
    const num = Number(quantity);
    if (isNaN(num) || !Number.isInteger(num)) {
        return result(false, 'Quantity must be a whole number');
    }
    if (num < min) {
        return result(false, `Quantity must be at least ${min}`);
    }
    if (num > max) {
        return result(false, `Quantity cannot exceed ${max}`);
    }
    return result(true);
}

// ===== 6. PRICE VALIDATION =====
/**
 * Validate price
 * @param {number} price - Price to validate
 * @param {number} min - Minimum value (default: 0)
 * @param {number} max - Maximum value (default: 10000)
 * @returns {ValidationResult}
 */
export function validatePrice(price, min = 0, max = 10000) {
    if (price === undefined || price === null) {
        return result(false, 'Price is required');
    }
    const num = Number(price);
    if (isNaN(num)) {
        return result(false, 'Price must be a number');
    }
    if (num < min) {
        return result(false, `Price cannot be less than ${min}`);
    }
    if (num > max) {
        return result(false, `Price cannot exceed ${max}`);
    }
    return result(true);
}

// ===== 7. REQUIRED FIELD =====
/**
 * Check if field is filled
 * @param {string} value - Value to check
 * @param {string} fieldName - Name for error message
 * @returns {ValidationResult}
 */
export function validateRequired(value, fieldName = 'Field') {
    if (value === undefined || value === null || value === '') {
        return result(false, `${fieldName} is required`);
    }
    if (typeof value === 'string' && value.trim() === '') {
        return result(false, `${fieldName} is required`);
    }
    return result(true);
}

// ===== 8. URL VALIDATION =====
/**
 * Validate URL
 * @param {string} url - URL to validate
 * @returns {ValidationResult}
 */
export function validateUrl(url) {
    if (!url || url.trim() === '') {
        return result(true); // URL is optional
    }
    try {
        new URL(url);
        return result(true);
    } catch {
        return result(false, vt('valid_url', 'Please enter a valid URL'));
    }
}

// ===== 9. DATE VALIDATION =====
/**
 * Validate date is not in the past
 * @param {string} date - Date string
 * @returns {ValidationResult}
 */
export function validateFutureDate(date) {
    if (!date) {
        return result(false, 'Date is required');
    }
    const selected = new Date(date);
    const now = new Date();
    if (selected < now) {
        return result(false, 'Date cannot be in the past');
    }
    return result(true);
}

// ===== 10. FORM VALIDATION HELPER =====
/**
 * Validate entire form
 * @param {Object} data - Form data object
 * @param {Object} rules - Validation rules { field: validator }
 * @returns {Object} { valid: boolean, errors: { field: string } }
 */
export function validateForm(data, rules) {
    const errors = {};
    let valid = true;

    for (const [field, validator] of Object.entries(rules)) {
        const value = data[field];
        const result = validator(value);
        if (!result.valid) {
            errors[field] = result.error;
            valid = false;
        }
    }

    return { valid, errors };
}

// ===== 11. EXPORT ALL =====
export default {
    validateEmail,
    validatePassword,
    validatePasswordMatch,
    validateName,
    validatePhone,
    validateQuantity,
    validatePrice,
    validateRequired,
    validateUrl,
    validateFutureDate,
    validateForm,
};