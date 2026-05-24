/**
 * Razorpay routes for AasPass.
 *
 * POST /razorpay/webhook  — Razorpay event sink (signature-verified)
 * GET  /razorpay/callback — Browser redirect after payment; tells user to return to WhatsApp
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { verifyWebhookSignature }  = require('../services/razorpay');
const { sendText, sendLocationRequest } = require('../services/whatsapp');
const { findMatches, sendMatchResults } = require('../services/matching');
const { logError }                = require('../utils/errorLogger');

const SEARCH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes — must match conversation.js

// ── POST /razorpay/webhook ─────────────────────────────────────────────────────
// raw body required for signature verification — DO NOT add json() middleware here

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody   = req.body;

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn('Razorpay: invalid signature ❌');
    return res.sendStatus(400);
  }

  res.sendStatus(200); // ack immediately before any async work

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (e) {
    logError({ severity: 'ERROR', type: 'PAYMENT', operation: 'webhook_parse', message: e.message, error: e }).catch(() => {});
    return;
  }

  if (event.event !== 'payment_link.paid') return; // ignore other events

  const notes        = event.payload?.payment_link?.entity?.notes || {};
  const { user_id, payment_type } = notes;

  if (!user_id) return;

  try {
    await handleProfileVerificationPayment(user_id, event);
  } catch (e) {
    logError({ severity: 'CRITICAL', type: 'PAYMENT', operation: 'handleProfileVerificationPayment', message: e.message, context: { user_id, payment_type }, error: e }).catch(() => {});
  }
});

// ── Profile verification payment handler ──────────────────────────────────────

async function handleProfileVerificationPayment(user_id, event) {
  // Activate 3-month subscription — idempotent, safe to call multiple times
  const subscriptionEnd = new Date();
  subscriptionEnd.setMonth(subscriptionEnd.getMonth() + 3);
  const formattedEnd = subscriptionEnd.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });

  await supabase.from('users').update({
    payment_verified:      true,
    subscribed:            true,
    subscription_end_date: subscriptionEnd.toISOString(),
  }).eq('user_id', user_id);

  const { data: user } = await supabase.from('users').select('*').eq('user_id', user_id).single();
  if (!user) {
    console.warn(`Razorpay webhook: user ${user_id} not found after payment`);
    return;
  }

  // Only proceed if user is still in PAYMENT_PENDING — guard against duplicate webhooks
  if (user.state !== 'PAYMENT_PENDING') {
    console.log(`Razorpay webhook: user ${user.phone} already in state ${user.state}, skipping`);
    return;
  }

  // Move user to pickup phase — they haven't entered trip locations yet
  await supabase.from('users').update({
    state:      'ONBOARDING_PICKUP',
    updated_at: new Date().toISOString(),
  }).eq('user_id', user_id);

  await sendText(
    user.phone,
    `✅ *Payment confirmed!* Your AasPass profile is active until *${formattedEnd}* 🎉\n\nNow let's set up your trip!`
  );

  await sendLocationRequest(
    user.phone,
    `*Step 1 of 2* — Share your *pickup location* 📍\n\nTap the button below, or paste coordinates from Google Maps.`
  );
}

// ── GET /razorpay/callback ─────────────────────────────────────────────────────
// Razorpay redirects the browser here after payment. Tell the user to return to WhatsApp.

router.get('/callback', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AasPass – Payment Confirmed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f0f4f8; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px;
            text-align: center; max-width: 360px; box-shadow: 0 4px 24px rgba(0,0,0,0.10); }
    h1 { color: #25D366; font-size: 28px; margin: 0 0 8px }
    p  { color: #555; font-size: 16px; line-height: 1.5; margin: 0 0 24px }
    a  { display: inline-block; background: #25D366; color: #fff;
         padding: 14px 28px; border-radius: 10px; text-decoration: none;
         font-weight: 700; font-size: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>✅ Payment Done!</h1>
    <p>Your ₹1 verification is confirmed.<br>Go back to WhatsApp — the bot will continue automatically.</p>
    <a href="https://wa.me/${process.env.WHATSAPP_PHONE_NUMBER_ID ? '' : ''}">↩ Back to WhatsApp</a>
  </div>
</body>
</html>`);
});

module.exports = router;
