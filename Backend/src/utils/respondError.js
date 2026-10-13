/**
 * The one place a controller turns a thrown error into an HTTP response.
 *
 * Every controller wraps its work in try/catch and answers from the catch,
 * which means the global error handler never sees these failures. That is fine
 * for real bugs, but it used to hide the most common one: the database being
 * briefly unreachable. Every authenticated request starts with a User lookup
 * and the dashboards poll several reads at once, so a momentary Atlas blip made
 * a dozen unrelated endpoints answer 500 at the same moment - each looking like
 * its own separate defect.
 *
 * Classifying here keeps the distinction honest:
 *   - transient database/network failure -> 503 + `retryable`, because the
 *     request and the endpoint are both fine and asking again is correct
 *   - a deliberate status on the error (400/403/404...) -> honoured as-is
 *   - anything else -> 500, still a real bug worth investigating
 *
 * Logging is deliberately left to the caller: every call site already logs the
 * error with its own contextual label, and logging twice would only bury the
 * real cause in noise.
 */
const { HTTP_STATUS } = require('../config/constants');
const { isTransientDbError } = require('../config/database');

const TRANSIENT_MESSAGE = 'Database temporarily unavailable, please retry';

/**
 * @param {object}  res
 * @param {Error}   error
 * @param {string}  fallbackMessage  used when the error carries no message
 * @param {object}  [options]
 * @param {boolean} [options.exposeMessage=true]  when false the client only
 *   ever sees `fallbackMessage`, so an internal error string is never leaked.
 *   Handlers that already answered with a generic message should pass false.
 */
const respondWithError = (res, error, fallbackMessage, options = {}) => {
  const { exposeMessage = true } = options;

  if (isTransientDbError(error)) {
    return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      success: false,
      error: TRANSIENT_MESSAGE,
      retryable: true,
    });
  }

  const status = (error && (error.statusCode || error.status)) || HTTP_STATUS.INTERNAL_SERVER_ERROR;
  const message =
    exposeMessage && error && error.message ? error.message : fallbackMessage;
  const payload = { success: false, error: message };
  // `code` is preserved so a client can branch on the specific condition
  // (PROOF_REQUIRED, OTP_EXPIRED, EMERGENCY_EXISTS, ...) instead of matching on
  // human-readable text.
  if (error && error.code) payload.code = error.code;
  return res.status(status).json(payload);
};

module.exports = { respondWithError, TRANSIENT_MESSAGE };