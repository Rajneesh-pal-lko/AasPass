/**
 * Short-lived signed tokens for the Mappls web map picker.
 * Stateless — no DB storage. HMAC-SHA256 with a 30-minute expiry.
 *
 * Token format (base64url): phone|expiresAt|hmac[:16]
 */

const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || 'aaspass_picker_secret_2024';

function generatePickerToken(phone) {
  const expires = Date.now() + 30 * 60 * 1000; // 30 minutes
  const payload = `${phone}|${expires}`;
  const sig     = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 16);
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function verifyPickerToken(token) {
  try {
    const decoded        = Buffer.from(token, 'base64url').toString();
    const [phone, expires, sig] = decoded.split('|');
    if (!phone || !expires || !sig) return null;
    if (Date.now() > parseInt(expires))  return null; // expired

    const expected = crypto.createHmac('sha256', SECRET)
      .update(`${phone}|${expires}`)
      .digest('hex')
      .slice(0, 16);

    // Timing-safe comparison prevents timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return phone;
  } catch {
    return null;
  }
}

module.exports = { generatePickerToken, verifyPickerToken };
