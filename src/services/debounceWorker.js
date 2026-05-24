/**
 * AasPass — Debounce Worker
 *
 * Aggregates rapid text messages (e.g. "Hitec City" → "Hyderabad") into a
 * single FSM input before any business logic fires.
 *
 * Flow:
 *   webhook (text msg) → UPSERT into message_buffer (phone-keyed, append text)
 *   this worker polls every 500ms → claims rows whose flush window elapsed
 *   → builds synthetic WhatsApp msg → hands off to processMessage (full pipeline)
 *
 * Interactive messages (buttons, list taps) and location pins bypass the buffer
 * entirely and are processed immediately by the webhook handler.
 *
 * Race-condition safety:
 *   claim_ready_buffer_row() uses FOR UPDATE SKIP LOCKED — two Railway instances
 *   polling simultaneously will each claim a different row, never the same one.
 *   The DELETE in the finally block uses WHERE status = 'PROCESSING' so a new
 *   BUFFERING row (user sent a message mid-processing) is never accidentally deleted.
 */

const supabase      = require('../config/supabase');
const { processMessage } = require('./processor');
const { sendText }  = require('./whatsapp');

const POLL_INTERVAL_MS = 500;

// ── Start ─────────────────────────────────────────────────────────────────────

function startDebounceWorker() {
  setInterval(flushReady, POLL_INTERVAL_MS);
  console.log('Debounce worker started (500ms poll) 📨');
}

// ── Core flush loop ───────────────────────────────────────────────────────────

async function flushReady() {
  // Claim one BUFFERING row atomically — returns empty array if nothing is ready
  let row;
  try {
    const { data, error } = await supabase.rpc('claim_ready_buffer_row');
    if (error) { console.error('debounceWorker: claim RPC error:', error.message); return; }
    if (!data?.length) return;
    row = data[0];
  } catch (e) {
    console.error('debounceWorker: claim threw:', e.message);
    return;
  }

  console.log(`📨 Flushing buffer for ${row.phone}: "${row.buffer_text.slice(0, 80).replace(/\n/g, ' | ')}"`);

  // Build a synthetic WhatsApp text message from the aggregated buffer
  const syntheticMsg = {
    id:   `buf_${row.phone}_${row.last_message_at}`, // stable & unique for this flush
    from: row.phone,
    type: 'text',
    text: { body: row.buffer_text },
  };

  try {
    // processMessage handles dedup, FSM lock, queue drain — full pipeline
    await processMessage(syntheticMsg, row.wa_name);
  } catch (e) {
    // processMessage has its own internal try/finally, so a throw here means
    // it crashed before acquiring the lock (e.g. dedup DB call failed).
    // Belt-and-suspenders: attempt to clear the lock and notify the user.
    console.error(`debounceWorker: processMessage threw for ${row.phone}:`, e.message);

    try {
      await supabase
        .from('users')
        .update({ is_processing: false, lock_token: null, lock_acquired_at: null })
        .eq('phone', row.phone);
    } catch {}

    await sendText(
      row.phone,
      "Something went wrong processing your message. Please try again 🙏"
    ).catch(() => {});
  } finally {
    // Delete the claimed row — but ONLY if it's still PROCESSING.
    // If the user sent a new message while we were processing, that UPSERT reset
    // the row to BUFFERING. Leaving it lets the next poll pick it up correctly.
    try {
      await supabase
        .from('message_buffer')
        .delete()
        .eq('phone', row.phone)
        .eq('status', 'PROCESSING');
    } catch (e) {
      console.error('debounceWorker: delete buffer error:', e.message);
    }
  }
}

module.exports = { startDebounceWorker };
