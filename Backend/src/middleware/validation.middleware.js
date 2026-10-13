// middleware/validation.middleware.js

const validateBody = (validatorFunction) => {
  return (req, res, next) => {
    if (typeof validatorFunction !== 'function') {
      return res.status(500).json({
        success: false,
        message: 'Validation configuration error',
      });
    }

    const validationResult = validatorFunction(req.body);

    if (!validationResult || !validationResult.isValid) {
      const errors = validationResult?.errors || {};
      const firstError = Object.values(errors)[0] || 'Validation failed';
      return res.status(400).json({
        success: false,
        error: firstError,
        message: firstError,
        errors,
      });
    }

    next();
  };
};

const validateQuery = (validatorFunction) => {
  return (req, res, next) => {
    if (typeof validatorFunction !== 'function') {
      return res.status(500).json({
        success: false,
        message: 'Validation configuration error',
      });
    }

    const validationResult = validatorFunction(req.query);

    if (!validationResult || !validationResult.isValid) {
      const errors = validationResult?.errors || {};
      const firstError = Object.values(errors)[0] || 'Validation failed';
      return res.status(400).json({
        success: false,
        error: firstError,
        message: firstError,
        errors,
      });
    }

    next();
  };
};

module.exports = { validateBody, validateQuery };
