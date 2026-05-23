const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sendText, sendButtons } = require('./whatsapp');

const SEARCH_TIMEOUT_MIN  = 10;   // Ask to extend after 10 minutes
const RETRY_TIMEOUT_MIN   = 5;    // Force-expire 5 minutes after extension
const RETRY_PROMPT_MIN    = 12;   // Give 2-min buffer before treating as expired in WAITING_RETRY
const SAFETY_EXPIRE_HRS   = 2;    // Absolute safety cap: expire anything over 2 hours

function startCleanupJob() {
  // Runs every 2 minutes — smart retry checks need finer granularity than 10 min
  cron.schedule('*/2 * * * *', async () => {
    const now = Date.now();

    await checkWaitingUsers(now);
    await checkRetryUsers(now);
    await safetyExpire(now);
  });

  console.log('Cleanup cron started (runs every 2 min) 🧹');
}

// ── 1. WAITING users who've been searching ≥ 10 min → ask to extend ──────────

async function checkWaitingUsers(now) {
  const tenMinAgo = new Date(now - SEARCH_TIMEOUT_MIN * 60 * 1000).toISOString();

  const { data: users } = await supabase
    .from('users')
    .select('*')
    .eq('state', 'WAITING')
    .eq('is_active', true)
    .lt('search_started_at', tenMinAgo);   // search_started_at > 10 min ago

  if (!users?.length) return;

  for (const user of users) {
    try {
      // Transition to WAITING_RETRY so we don't spam them again
      await supabase.from('users').update({
        state:      'WAITING_RETRY',
        updated_at: new Date().toISOString(),
      }).eq('user_id', user.user_id);

      await sendButtons(
        user.phone,
        `⏰ It's been 10 minutes and no match yet.\n\nWould you like to keep searching for 5 more minutes?`,
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

// ── 2. WAITING_RETRY users who haven't responded within 5 min → expire ────────

async function checkRetryUsers(now) {
  const fiveMinAgo = new Date(now - RETRY_PROMPT_MIN * 60 * 1000).toISOString();

  // These users entered WAITING_RETRY state > RETRY_PROMPT_MIN ago and still haven't replied
  const { data: users } = await supabase
    .from('users')
    .select('*')
    .eq('state', 'WAITING_RETRY')
    .eq('is_active', true)
    .lt('updated_at', fiveMinAgo);

  if (!users?.length) return;

  for (const user of users) {
    try {
      await supabase.from('users').update({
        state:      'IDLE',
        is_active:  false,
        updated_at: new Date().toISOString(),
      }).eq('user_id', user.user_id);

      await sendText(
        user.phone,
        `Your search has ended — no match found nearby this time. 😔\n\nSend *hi* whenever you're ready to try again! ✈️`
      );
    } catch (e) {
      console.error(`Expire retry error for ${user.phone}:`, e.message);
    }
  }

  if (users.length) console.log(`Cleanup: expired ${users.length} retry user(s)`);
}

// ── 3. Safety net: expire anything stuck > 2 hours in any active state ────────

async function safetyExpire(now) {
  const cutoff = new Date(now - SAFETY_EXPIRE_HRS * 60 * 60 * 1000).toISOString();

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
        updated_at: new Date().toISOString(),
      }).eq('user_id', user.user_id);

      await sendText(
        user.phone,
        `Your AasPass session expired after 2 hours. Send *hi* to start fresh! ✈️`
      ).catch(() => {});
    } catch (e) {
      console.error(`Safety expire error for ${user.phone}:`, e.message);
    }
  }

  if (stale.length) console.log(`Cleanup: safety-expired ${stale.length} stale user(s)`);
}

module.exports = { startCleanupJob };
