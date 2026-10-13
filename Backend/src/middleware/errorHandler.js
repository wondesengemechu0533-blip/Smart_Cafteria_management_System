const { MESSAGES, HTTP_STATUS } = require('../config/constants');
const { isTransientDbError } = require('../config/database');

const isDevelopment = process.env.NODE_ENV === 'development';

function sanitizeError(error) {
  if (!error) return { message: 'Unknown error' };

  if (error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((e) => e.message);
    return { message: 'Validation failed', errors: messages };
  }

  if (error.name === 'CastError') {
    return { message: 'Invalid ID format' };
  }

  if (error.code === 11000) {
    const field = Object.keys(error.keyValue)[0];
    return { message: `${field} already exists` };
  }

  if (error.name === 'JsonWebTokenError') {
    return { message: 'Invalid token' };
  }

  if (error.name === 'TokenExpiredError') {
    return { message: 'Token expired' };
  }

  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    return { message: 'Invalid JSON payload' };
  }

  return { message: error.message || MESSAGES.SERVER_ERROR };
}

function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  if (res.headersSent) {
    return next(err);
  }

  const sanitized = sanitizeError(err);
  const transient = isTransientDbError(err);
  // A database that is briefly unreachable is a dependency outage, not a fault
  // in this service or in the caller's request. 503 + `retryable` says exactly
  // that; reporting it as 500 made a momentary Atlas blip look like a broken
  // endpoint on every screen that happened to be polling at the time.
  const status = transient
    ? HTTP_STATUS.SERVICE_UNAVAILABLE
    : err.status || err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;

  const response = {
    success: false,
    error: transient ? 'Database temporarily unavailable, please retry' : sanitized.message,
  };

  if (transient) {
    response.retryable = true;
  }

  if (sanitized.errors) {
    response.errors = sanitized.errors;
  }

  if (isDevelopment && err.stack) {
    response.stack = err.stack;
  }

  res.status(status).json(response);
}

function notFoundHandler(req, res) {
  res.status(HTTP_STATUS.NOT_FOUND).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found`,
  });
}

module.exports = { errorHandler, notFoundHandler, sanitizeError };
