/**
 * CAPTCHA service - simple arithmetic captcha.
 *
 * Uses an in-memory Map (single-instance backend) keyed by a random id. The
 * answer is stored only as a salted SHA-256 hash so a leaked store cannot be
 * trivially replayed. Entries expire automatically.
 */

const crypto = require('crypto');

const store = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cleanUp() {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt < now) store.delete(id);
  }
}

/**
 * Create a new arithmetic captcha ("7 + 11 = ?").
 * @returns {{id: string, question: string, image: string}}
 */
function createCaptcha() {
  cleanUp();

  const a = crypto.randomInt(3, 15);
  const b = crypto.randomInt(3, 15);
  const answer = a + b;

  const salt = crypto.randomBytes(8).toString('hex');
  const id = crypto.randomBytes(9).toString('hex');
  const expiresAt = Date.now() + DEFAULT_TTL_MS;
  const secretPepper = process.env.CAPTCHA_PEPPER || 'smart-cafeteria-captcha';

  store.set(id, {
    hash: sha256(`${secretPepper}|${salt}|${answer}`),
    salt,
    expiresAt,
    attempts: 0,
  });

  // Render a simple, dependency-free SVG so no canvas lib is required.
  const image =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="44">' +
        '<rect width="140" height="44" fill="#eef1f5" rx="6"/>' +
        '<text x="20" y="30" font-size="22" font-family="monospace" fill="#1f2937">' +
        `${a} + ${b} = ?` +
        '</text>' +
        '</svg>'
    );

  return { id, image, question: `${a} + ${b}`, expiresAt };
}

/**
 * Verify the user's answer against a captcha id. A captcha is single-use.
 * @param {string} id
 * @param {string|number} answer
 * @returns {boolean}
 */
function verifyCaptcha(id, answer) {
  if (!id || answer === undefined || answer === null || answer === '') return false;

  const entry = store.get(id);
  if (!entry) return false;

  // Expired
  if (entry.expiresAt < Date.now()) {
    store.delete(id);
    return false;
  }

  // Attempt limiting (5 tries per captcha id)
  entry.attempts += 1;
  if (entry.attempts > 5) {
    store.delete(id);
    return false;
  }

  const secretPepper = process.env.CAPTCHA_PEPPER || 'smart-cafeteria-captcha';
  const ok = sha256(`${secretPepper}|${entry.salt}|${answer}`) === entry.hash;
  if (ok) store.delete(id); // single use
  return ok;
}

module.exports = { createCaptcha, verifyCaptcha };
