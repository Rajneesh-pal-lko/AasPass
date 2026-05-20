const Razorpay = require('razorpay');
const crypto = require('crypto');

let _rzp = null;
function getRzp() {
  if (!_rzp) {
    _rzp = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _rzp;
}

async function createVerificationPaymentLink(user, matchId) {
  const link = await getRzp().paymentLink.create({
    amount: 100, // ₹1 in paise
    currency: 'INR',
    accept_partial: false,
    description: 'AasPass – Cab Split Verification',
    customer: { contact: `+${user.phone}` },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: {
      user_id: user.user_id,
      match_id: matchId,
    },
    callback_url: `${process.env.SERVER_URL || 'https://your-railway-url.railway.app'}/razorpay/callback`,
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
