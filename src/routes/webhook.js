const express = require('express');
const router = express.Router();
const { handleMessage } = require('../handlers/conversation');
const { logMessage, updateProfile } = require('../services/messageLogger');

// Meta webhook verification (GET)
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified ✅');
    return res.status(200).send(challenge);
  }
  console.warn('Webhook verification failed ❌');
  return res.sendStatus(403);
});

// Incoming WhatsApp messages (POST)
router.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    if (!value?.messages?.length) return;

    // Extract contact name if Meta provides it
    const contacts = value?.contacts || [];

    for (const msg of value.messages) {
      const contact = contacts.find(c => c.wa_id === msg.from);
      const waName  = contact?.profile?.name || null;

      // Save/update profile with WhatsApp display name
      if (waName) await updateProfile(msg.from, waName);

      // Determine readable text for logging
      let messageText = '';
      if (msg.type === 'text') messageText = msg.text?.body || '';
      else if (msg.type === 'interactive') {
        messageText = msg.interactive?.button_reply?.title
          || msg.interactive?.list_reply?.title
          || '[interactive]';
      } else if (msg.type === 'location') {
        messageText = `📍 ${msg.location?.latitude}, ${msg.location?.longitude}`;
      } else {
        messageText = `[${msg.type}]`;
      }

      console.log(`📨 From ${msg.from} (${waName || 'unknown'}) | ${msg.type} | ${messageText}`);

      // Log incoming message
      await logMessage({
        phone: msg.from,
        direction: 'incoming',
        messageType: msg.type,
        messageText,
        rawPayload: msg,
        userState: null, // will be enriched by conversation handler
      });

      await handleMessage(msg).catch((err) =>
        console.error(`❌ Error handling message from ${msg.from}:`, err.message, err.stack)
      );
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

module.exports = router;
