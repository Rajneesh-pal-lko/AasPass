const cron = require('node-cron');
const supabase = require('../config/supabase');
const { sendText } = require('./whatsapp');

// Expire user spots after 2 hours in WAITING state
function startCleanupJob() {
  cron.schedule('*/10 * * * *', async () => {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    const { data: stale } = await supabase
      .from('users')
      .select('*')
      .eq('state', 'WAITING')
      .eq('is_active', true)
      .lt('updated_at', cutoff);

    if (!stale?.length) return;

    for (const user of stale) {
      await supabase
        .from('users')
        .update({ is_active: false, state: 'IDLE', updated_at: new Date().toISOString() })
        .eq('user_id', user.user_id);

      await sendText(
        user.phone,
        `Your AasPass spot has expired after 2 hours. Send "hi" whenever you land next time! ✈️`
      ).catch(() => {});
    }

    console.log(`Cleanup: expired ${stale.length} stale waiting users`);
  });

  console.log('Cleanup cron job started (runs every 10 min)');
}

module.exports = { startCleanupJob };
