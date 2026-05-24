const express = require('express');
const router  = express.Router();

const supabase  = require('../config/supabase');
const { processMessage, isDuplicate, markProcessed } = require('../services/processor');
const { logMessage, updateProfile } = require('../services/messageLogger');

// ── Meta webhook verification (GET) ──────────────────────────────────────────
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

// ── Incoming WhatsApp messages (POST) ─────────────────────────────────────────
// IMPORTANT: 200 OK is sent immediately before any processing.
// Meta will retry if we don't respond fast enough — we must never block here.
router.post('/', (req, res) => {
  // ── Acknowledge immediately ──
  res.sendStatus(200);

  // ── Parse and dispatch asynchronously (non-blocking) ──
  setImmediate(async () => {
    try {
      const entry   = req.body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value   = changes?.value;

      if (!value?.messages?.length) return;

      const contacts = value?.contacts || [];

      for (const msg of value.messages) {
        const contact = contacts.find(c => c.wa_id === msg.from);
        const waName  = contact?.profile?.name || null;

        // Update WhatsApp display name in profile
        if (waName) await updateProfile(msg.from, waName).catch(() => {});

        // Build readable text for logging
        let messageText = '';
        if (msg.type === 'text') {
          messageText = msg.text?.body || '';
        } else if (msg.type === 'interactive') {
          messageText = msg.interactive?.button_reply?.title
                     || msg.interactive?.list_reply?.title
                     || '[interactive]';
        } else if (msg.type === 'location') {
          messageText = `📍 ${msg.location?.latitude}, ${msg.location?.longitude}`;
        } else {
          messageText = `[${msg.type}]`;
        }

        console.log(`📨 ${msg.from} (${waName || 'unknown'}) | ${msg.type} | ${messageText} | id:${msg.id}`);

        // Log inbound message (fire-and-forget — never block processing)
        logMessage({
          phone:       msg.from,
          direction:   'incoming',
          messageType: msg.type,
          messageText,
          rawPayload:  msg,
          userState:   null,
        }).catch(() => {});

        // ── Route: text vs. interactive / location ────────────────────────────
        if (msg.type === 'text') {
          // Text messages are debounced: aggregate rapid inputs before FSM fires.
          // Dedup here (before buffering) so Meta retries don't double-append.
          if (await isDuplicate(msg.id)) {
            console.log(`⚡ Duplicate text ${msg.id} from ${msg.from} — skipped`);
            continue;
          }
          await markProcessed(msg.id, msg.from);

          await supabase
            .rpc('buffer_incoming_message', {
              p_phone:   msg.from,
              p_text:    msg.text?.body || '',
              p_wa_name: waName,
            })
            .then(({ error }) => {
              if (error) console.error(`❌ Buffer UPSERT error for ${msg.from}:`, error.message);
              else       console.log(`📥 Buffered text for ${msg.from}`);
            });

        } else {
          // Interactive (button/list) and location messages are definitive actions —
          // they must be processed immediately, bypassing the debounce buffer.
          //
          // Order-inversion fix: if the user texted "cancel" (still buffering) and
          // then tapped [Accept Match], the Accept wins. Discard the pending text.
          const { error: delErr } = await supabase
            .from('message_buffer')
            .delete()
            .eq('phone', msg.from)
            .eq('status', 'BUFFERING');

          if (delErr) console.error(`❌ Buffer clear error for ${msg.from}:`, delErr.message);

          // processMessage handles its own dedup, locking, and queue drain
          await processMessage(msg, waName).catch(err =>
            console.error(`❌ processMessage error from ${msg.from}:`, err.message)
          );
        }
      }
    } catch (err) {
      console.error('Webhook dispatch error:', err.message);
    }
  });
});

module.exports = router;
