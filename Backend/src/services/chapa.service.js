const CHAPA_API_URL = 'https://api.chapa.co/v1';
// Fail fast (10s) so a hung Chapa API never leaves checkout waiting: the
// frontend falls back to simulated payment once this throws.
const CHAPA_TIMEOUT_MS = Number(process.env.CHAPA_TIMEOUT_MS) || 10000;

const chapaRequest = async (path, options = {}) => {
  if (!process.env.CHAPA_SECRET_KEY) {
    const error = new Error('CHAPA_SECRET_KEY is not configured');
    error.statusCode = 500;
    throw error;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHAPA_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${CHAPA_API_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error('Chapa request timed out');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  const data = await response.json();

  if (!response.ok || data.status !== 'success') {
    const error = new Error(data.message || 'Chapa request failed');
    error.statusCode = response.status || 502;
    throw error;
  }

  return data;
};

exports.initialize = (payload) =>
  chapaRequest('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

exports.verify = (txRef) => chapaRequest(`/transaction/verify/${encodeURIComponent(txRef)}`);

exports.initializeTelebirr = (payload) =>
  chapaRequest('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({ ...payload, payment_method: 'telebirr' }),
  });
