const { HTTP_STATUS } = require('../config/constants');
const { validateEnum, validateDateRange } = require('./common.validator');

const PERIODS = ['today', 'yesterday', 'last7', 'last30', 'month', 'custom'];

const validateReportQuery = (query) => {
  const errors = {};

  if (query.period) {
    const periodErr = validateEnum(query.period, PERIODS, 'Period');
    if (periodErr) errors.period = periodErr;
  }

  if (query.period === 'custom') {
    const rangeErr = validateDateRange(query.startDate, query.endDate);
    if (rangeErr) errors.dateRange = rangeErr;
  }

  return { isValid: Object.keys(errors).length === 0, errors };
};

module.exports = {
  validateReportQuery,
};
