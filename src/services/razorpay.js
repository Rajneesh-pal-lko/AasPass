/**
 * Razorpay integration for AasPass.
 *
 * Payment model: one-time ₹1 profile verification per phone number.
 * After payment, payment_verified = true forever — user never pays again
 * on subsequent searches.
 */

const Razorpay = require('razorpay');
const crypto   = require('crypto');

let _rzp = null;
function getRzp() {
  if (!_rzp) {
    _rzp = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _rzp;
}

/**
 * Create a ₹1 profile-verification payment link for the given user.
 * Notes carry user_id + payment_type so the webhook knows what to do.
 */
async function createVerificationPaymentLink(user) {
  const serverUrl = process.env.SERVER_URL || 'https://your-app.railway.app';
  const link = await getRzp().paymentLink.create({
    amount:          100,   // ₹1 in paise
    currency:        'INR',
    accept_partial:  false,
    description:     'AasPass – Profile Verification (₹1)',
    customer:        { contact: `+${user.phone}` },
    notify:          { sms: false, email: false },
    reminder_enable: false,
    notes: {
      user_id:      user.user_id,
      payment_type: 'profile_verification',
    },
    callback_url:    `${serverUrl}/razorpay/callback`,
    callback_method: 'get',
  });
  return link.short_url;
}

function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

module.exports = { createVerificationPaymentLink, verifyWebhookSignature };
