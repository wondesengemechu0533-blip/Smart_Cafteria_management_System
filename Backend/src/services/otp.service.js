/**
 * OTP (one-time-password) service.
 *
 * Codes havehed (SHA-256 + salt) before storage, expire after a configurable
 * window and are single-use with a bounded number of attempts.
 *
 * Sending: no SMS/email provider is configured, so the code is written to the
 * server console and - in non-production environments - returned to the
 * frontend for simulation. Set OTP_SIMULATED_MODE=false (default in prod) to
 * force a real delivery integration before the code is usable end-to-end.
 */

const crypto = require('crypto');
const OtpVerification = require('../models/OtpVerification');

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * Generate a 6-digit OTP and persist a hashed copy.
 * @param {{email?: string, phone?: string, purpose?: string}} opts
 * @returns {Promise<{ok: boolean, code?: string, recordedFor?: string, error?: string}>}
 */
async function generateOtp({ email = '', phone = '', purpose = 'REGISTER' } = {}) {
  try {
    const contact = email || phone;
    if (!email && !phone) return { ok: false, error: 'Email or phone is required' };

    // Invalidate any previous unverified codes for the same contact+purpose.
    await OtpVerification.updateMany(
      { purpose, consumed: false, verified: false, $or: [{ email }, { phone }] },
      { $set: { consumed: true } }
    );

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const salt = crypto.randomBytes(8).toString('hex');
    const expiresInMin = Number(process.env.OTP_EXPIRY_MINUTES) || 10;
    const expiresAt = new Date(Date.now() + expiresInMin * 60 * 1000);

    await OtpVerification.create({
      email: email ? String(email).toLowerCase() : '',
      phone: phone || '',
      codeHash: sha256(`${salt}${code}`),
      salt,
      purpose,
      expiresAt,
      maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS) || 5,
    });

    // Honest "send": log it; in dev, expose the code so the flow is testable.
    console.log(`[OTP] ${purpose} code for ${contact}: ${code} (expires in ${expiresInMin} min)`);

    const simulated = process.env.OTP_SIMULATED_MODE !== 'false' && process.env.NODE_ENV !== 'production';
    if (simulated) {
      return { ok: true, code, recordedFor: contact, simulated: true };
    }
    return { ok: true, recordedFor: contact, simulated: false };
  } catch (error) {
    console.error('❌ OTP Generate Error:', error);
    return { ok: false, error: 'Could not generate the verification code' };
  }
}

/**
 * Verify a submitted OTP against the stored hashed code.
 * @param {{email?: string, phone?: string, purpose?: string, code: string}} opts
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function verifyOtp({ email = '', phone = '', purpose = 'REGISTER', code = '' } = {}) {
  try {
    if (!email && !phone) return { ok: false, error: 'Email or phone is required' };
    if (!code) return { ok: false, error: 'Verification code is required' };

    const contactFilter = email ? { email: String(email).toLowerCase() } : { phone };
    const record = await OtpVerification.findOne({
      ...contactFilter,
      purpose,
      consumed: false,
      verified: false,
    }).sort({ createdAt: -1 });

    if (!record) return { ok: false, error: 'No active verification code found for this contact' };
    if (record.expiresAt < new Date()) {
      await OtpVerification.updateOne({ _id: record._id }, { $set: { consumed: true } });
      return { ok: false, error: 'Verification code has expired. Request a new one.' };
    }
    if (record.attempts >= record.maxAttempts) {
      await OtpVerification.updateOne({ _id: record._id }, { $set: { consumed: true } });
      return { ok: false, error: 'Too many wrong attempts. Request a new code.' };
    }

    const ok = record.codeHash === sha256(`${record.salt}${String(code).trim()}`);
    if (!ok) {
      await OtpVerification.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
      return { ok: false, error: 'Invalid verification code' };
    }

    await OtpVerification.updateOne(
      { _id: record._id },
      { $set: { verified: true, verifiedAt: new Date(), consumed: true } }
    );
    return { ok: true };
  } catch (error) {
    console.error('❌ OTP Verify Error:', error);
    return { ok: false, error: 'Could not verify the code' };
  }
}

module.exports = { generateOtp, verifyOtp };
