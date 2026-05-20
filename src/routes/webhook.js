const express = require('express');
const router = express.Router();
const { handleMessage } = require('../handlers/conversation');

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
  // Acknowledge immediately so Meta doesn't retry
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return; // status updates, not messages

    for (const msg of value.messages) {
      await handleMessage(msg).catch((err) =>
        console.error(`Error handling message from ${msg.from}:`, err.message)
      );
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

module.exports = router;
