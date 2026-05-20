const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { verifyWebhookSignature } = require('../services/razorpay');
const { sendText } = require('../services/whatsapp');

// Razorpay webhook — raw body needed for signature verification
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body;

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn('Invalid Razorpay signature ❌');
    return res.sendStatus(400);
  }

  res.sendStatus(200); // ack immediately

  const event = JSON.parse(rawBody.toString());
  if (event.event !== 'payment_link.paid') return;

  const notes = event.payload?.payment_link?.entity?.notes || {};
  const { user_id, match_id } = notes;

  if (!user_id || !match_id) return;

  // Mark payment verified
  await supabase.from('users').update({ payment_verified: true }).eq('user_id', user_id);

  // Get both users
  const { data: userA } = await supabase.from('users').select('*').eq('user_id', user_id).single();
  const { data: req_ } = await supabase.from('match_requests').select('*').eq('request_id', match_id).single();
  if (!userA || !req_) return;

  const otherUserId = req_.from_user === user_id ? req_.to_user : req_.from_user;
  const { data: userB } = await supabase.from('users').select('*').eq('user_id', otherUserId).single();
  if (!userB) return;

  // Share contact details
  const msg = (them, you) =>
    `🎉 Your cab split partner's details:\n\n` +
    `📱 WhatsApp: wa.me/${them.phone}\n` +
    `📍 Drop zone: ${them.drop_zone}\n\n` +
    `Meet at *Arrivals* gate and split an Uber 50/50. Safe travels! ✈️`;

  await sendText(userA.phone, msg(userB, userA));
  await sendText(userB.phone, msg(userA, userB));

  // Send trip confirmation buttons to both
  const { sendButtons } = require('../services/whatsapp');
  const confirmMsg = `Did your cab split work out? Let us know!`;
  const buttons = [
    { id: 'TRIP_DONE',  title: '✅ Yes, Done!' },
    { id: 'TRIP_ISSUE', title: '❌ Issue' },
  ];
  await sendButtons(userA.phone, confirmMsg, buttons);
  await sendButtons(userB.phone, confirmMsg, buttons);
});

// Razorpay redirect callback (GET — after payment)
router.get('/callback', (req, res) => {
  res.send('<h2>Payment received! Return to WhatsApp to continue. ✈️</h2>');
});

module.exports = router;
