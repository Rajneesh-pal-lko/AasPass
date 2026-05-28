/**
 * AasPass — Message Processor
 *
 * Handles every incoming WhatsApp message with:
 *   1. Duplicate detection        — skip messages already processed
 *   2. Per-user processing lock   — one message at a time per user
 *   3. Pending message queue      — queue messages when user is locked
 *   4. FIFO drain after unlock    — process queued messages in order
 *
 * This prevents race conditions from:
 *   - WhatsApp webhook retries (Meta may deliver same event multiple times)
 *   - Rapid user messages (multiple in-flight requests per user)
 *   - State corruption from concurrent FSM execution
 */

const crypto    = require('crypto');
const supabase  = require('../config/supabase');
const { handleMessage } = require('../handlers/conversation');

const LOCK_TTL_SECONDS = 30; // Crash recovery: release stale locks older than this

// ── Duplicate detection ───────────────────────────────────────────────────────

async function isDuplicate(messageId) {
  const { data } = await supabase
    .from('processed_webhooks')
    .select('message_id')
    .eq('message_id', messageId)
    .maybeSingle();
  return !!data;
}

async function markProcessed(messageId, phone) {
  await supabase
    .from('processed_webhooks')
    .upsert({ message_id: messageId, phone, processed_at: new Date().toISOString() },
             { onConflict: 'message_id', ignoreDuplicates: true });
}

// ── Per-user processing lock ──────────────────────────────────────────────────
// Atomic conditional UPDATE: only succeeds if user is unlocked OR lock is stale.
// PostgreSQL row-level locking ensures only one caller wins the race.

async function tryAcquireLock(phone) {
  const lockToken = crypto.randomUUID();
  const staleCutoff = new Date(Date.now() - LOCK_TTL_SECONDS * 1000).toISOString();

  // Ensure a user row exists before trying to acquire the lock.
  // New users have no row yet — the UPDATE below would match 0 rows and always fail.
  // ignoreDuplicates: true means this is a no-op for existing rows.
  await supabase
    .from('users')
    .upsert({ phone, is_processing: false }, { onConflict: 'phone', ignoreDuplicates: true });

  const { data } = await supabase
    .from('users')
    .update({
      is_processing:    true,
      lock_token:       lockToken,
      lock_acquired_at: new Date().toISOString(),
    })
    .eq('phone', phone)
    // Auto-recover stale locks: unlock if is_processing is false, OR if
    // lock_acquired_at is NULL (crashed before it was set), OR if it's older than TTL.
    .or(`is_processing.eq.false,lock_acquired_at.is.null,lock_acquired_at.lt.${staleCutoff}`)
    .select('lock_token')
    .maybeSingle();

  // data is non-null only if our UPDATE matched a row (we won the race)
  return data?.lock_token === lockToken ? lockToken : null;
}

async function releaseLock(phone, lockToken) {
  await supabase
    .from('users')
    .update({ is_processing: false, lock_token: null, lock_acquired_at: null })
    .eq('phone', phone)
    .eq('lock_token', lockToken); // token-based ownership: never release someone else's lock
}

// ── Pending message queue ─────────────────────────────────────────────────────

async function enqueue(phone, messageId, waName, rawPayload) {
  await supabase.from('pending_messages').insert({
    phone,
    message_id:  messageId,
    wa_name:     waName,
    raw_payload: rawPayload,
    arrived_at:  new Date().toISOString(),
    status:      'pending',
  });
  console.log(`📥 Queued message ${messageId} for ${phone}`);
}

async function dequeueNext(phone) {
  // Mark 'done' atomically before processing — prevents double-processing on crash
  const { data: pending } = await supabase
    .from('pending_messages')
    .select('*')
    .eq('phone', phone)
    .eq('status', 'pending')
    .order('arrived_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!pending) return null;

  await supabase
    .from('pending_messages')
    .update({ status: 'done' })
    .eq('id', pending.id);

  return pending;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Process a single WhatsApp message with full safety guarantees.
 * Called from webhook.js after 200 OK is already sent to Meta.
 *
 * @param {object} msg     - parsed WhatsApp message object
 * @param {string} waName  - WhatsApp display name (may be null)
 */
async function processMessage(msg, waName) {
  const phone     = msg.from;
  const messageId = msg.id;

  // ── Step 1: Deduplicate ──
  if (await isDuplicate(messageId)) {
    console.log(`⚡ Duplicate message ${messageId} from ${phone} — skipped`);
    return;
  }
  await markProcessed(messageId, phone);

  // ── Step 2: Try to acquire per-user lock ──
  const lockToken = await tryAcquireLock(phone);
  if (!lockToken) {
    // Another request is actively processing this user — queue for later
    console.log(`🔒 ${phone} already processing — queuing ${messageId}`);
    await enqueue(phone, messageId, waName, msg);
    return;
  }

  // ── Step 3: Process current message + drain pending queue ──
  try {
    console.log(`▶ Processing ${messageId} for ${phone}`);
    await handleMessage(msg, waName);

    // Drain the queue FIFO until empty
    let queued;
    while ((queued = await dequeueNext(phone))) {
      console.log(`▶ Processing queued ${queued.message_id} for ${phone}`);
      await handleMessage(queued.raw_payload, queued.wa_name).catch(err =>
        console.error(`❌ Queued message error [${queued.message_id}]:`, err.message)
      );
    }
  } catch (err) {
    console.error(`❌ Processor error for ${phone} [${messageId}]:`, err.message, err.stack);
  } finally {
    // ── Step 4: Always release lock (even on crash) ──
    await releaseLock(phone, lockToken);
    console.log(`🔓 Lock released for ${phone}`);
  }
}

module.exports = { processMessage, isDuplicate, markProcessed };
