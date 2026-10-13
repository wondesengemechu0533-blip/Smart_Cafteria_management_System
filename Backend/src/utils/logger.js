// utils/logger.js

const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

const formatMessage = (level, message) => {
  const timestamp = new Date().toISOString();

  return `[${timestamp}] [${level}]: ${message}`;
};

const formatMeta = (meta) => {
  if (!meta) {
    return '';
  }

  if (meta instanceof Error) {
    return meta.stack || meta.message;
  }

  try {
    return JSON.stringify(meta);
  } catch {
    return '[Unable to serialize log metadata]';
  }
};

const logger = {
  info: (message, meta = null) => {
    console.log(formatMessage(LOG_LEVELS.INFO, message), formatMeta(meta));
  },

  warn: (message, meta = null) => {
    console.warn(formatMessage(LOG_LEVELS.WARN, message), formatMeta(meta));
  },

  error: (message, errorDetails = null) => {
    console.error(formatMessage(LOG_LEVELS.ERROR, message), formatMeta(errorDetails));
  },
};

module.exports = { logger };
