const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sendText, sendButtons } = require('./whatsapp');

// All timing is driven by the expires_at column set on the user row.
// No more time arithmetic in code — just compare expires_at < NOW().

function startCleanupJob() {
  // Runs every 2 minutes — handles user session expiry
  cron.schedule('*/2 * * * *', async () => {
    const now = new Date().toISOString();
    await promoteToRetry(now);
    await expireRetryUsers(now);
    await safetyExpire(now);
  });

  // Runs every 10 minutes — infrastructure housekeeping
  cron.schedule('*/10 * * * *', async () => {
    await resetStaleLocks();
    await purgeOldWebhooks();
    await expirePendingMessages();
  });

  console.log('Cleanup cron started (every 2 min + every 10 min) 🧹');
}

// ── 1. WAITING users whose expires_at passed → ask to extend ─────────────────

async function promoteToRetry(now) {
  const { data: users } = await supabase
    .from('users')
    .select('*')
    .eq('state', 'WAITING')
    .eq('is_active', true)
    .lt('expires_at', now);

  if (!users?.length) return;

  for (const user of users) {
    try {
      // Give them 5 minutes to respond before hard-expiring
      const retryExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      await supabase.from('users').update({
        state:      'WAITING_RETRY',
        expires_at: retryExpiry,
        updated_at: now,
      }).eq('user_id', user.user_id);

      await sendButtons(
        user.phone,
        `⏰ No match found yet.\n\nWould you like to keep searching for 5 more minutes?`,
        [
          { id: 'RETRY_YES', title: '🔄 Keep Searching' },
          { id: 'RETRY_NO',  title: '❌ Stop Looking'   },
        ]
      );
    } catch (e) {
      console.error(`Retry prompt error for ${user.phone}:`, e.message);
    }
  }

  if (users.length) console.log(`Cleanup: sent retry prompt to ${users.length} user(s)`);
}

// ── 2. WAITING_RETRY users whose expires_at passed → expire ──────────────────

async function expireRetryUsers(now) {
  const { data: users } = await supabase
    .from('users')
    .select('*')
    .eq('state', 'WAITING_RETRY')
    .eq('is_active', true)
    .lt('expires_at', now);

  if (!users?.length) return;

  for (const user of users) {
    try {
      await supabase.from('users').update({
        state:      'IDLE',
        is_active:  false,
        expires_at: null,
        updated_at: now,
      }).eq('user_id', user.user_id);

      await sendText(
        user.phone,
        `No match found this time. 😔\n\nSend *hi* whenever you're ready to search again! ✈️`
      );
    } catch (e) {
      console.error(`Expire retry error for ${user.phone}:`, e.message);
    }
  }

  if (users.length) console.log(`Cleanup: expired ${users.length} retry user(s)`);
}

// ── 3. Safety net: anything stuck active for > 2 hours ───────────────────────

async function safetyExpire(now) {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: stale } = await supabase
    .from('users')
    .select('*')
    .in('state', ['WAITING', 'WAITING_RETRY', 'MATCH_SENT', 'MATCH_RECEIVED', 'MATCHED'])
    .eq('is_active', true)
    .lt('updated_at', cutoff);

  if (!stale?.length) return;

  for (const user of stale) {
    try {
      await supabase.from('users').update({
        state:      'IDLE',
        is_active:  false,
        is_matched: false,
        expires_at: null,
        updated_at: now,
      }).eq('user_id', user.user_id);

      await sendText(user.phone,
        `Your AasPass session expired after 2 hours. Send *hi* to start fresh! ✈️`
      ).catch(() => {});
    } catch (e) {
      console.error(`Safety expire error for ${user.phone}:`, e.message);
    }
  }

  if (stale.length) console.log(`Cleanup: safety-expired ${stale.length} stale user(s)`);
}

// ── Infrastructure: stale lock recovery ───────────────────────────────────────
// If a Node.js process crashed while holding a user lock, the user would be
// permanently stuck. This frees locks older than 30 seconds.

async function resetStaleLocks() {
  const { data, error } = await supabase.rpc('reset_stale_locks', { max_age_seconds: 30 });
  if (!error && data > 0) console.log(`Cleanup: reset ${data} stale processing lock(s)`);
}

// ── Infrastructure: purge old processed_webhooks ──────────────────────────────
// Keeps the dedup table lean — only need 24h of history.

async function purgeOldWebhooks() {
  const { data, error } = await supabase.rpc('cleanup_old_webhooks');
  if (!error && data > 0) console.log(`Cleanup: purged ${data} old webhook record(s)`);
}

// ── Infrastructure: expire stale pending messages ─────────────────────────────
// Messages sitting in the queue for > 2 hours are no longer relevant.

async function expirePendingMessages() {
  const { data, error } = await supabase.rpc('cleanup_pending_messages');
  if (!error && data > 0) console.log(`Cleanup: expired ${data} stale pending message(s)`);
}

module.exports = { startCleanupJob };
