const supabase = require('../config/supabase');

async function logMessage({ phone, direction, messageType, messageText, rawPayload, userState }) {
  try {
    await supabase.from('message_logs').insert({
      phone,
      direction,
      message_type: messageType || 'text',
      message_text: messageText || '',
      raw_payload: rawPayload || {},
      user_state: userState || null,
      created_at: new Date().toISOString(),
    });

    // Update user profile
    await supabase.from('user_profiles').upsert({
      phone,
      last_seen_at: new Date().toISOString(),
      message_count: supabase.rpc ? undefined : undefined,
    }, { onConflict: 'phone', ignoreDuplicates: false });

    // Increment message count separately
    await supabase.rpc('increment_message_count', { user_phone: phone }).catch(() => {
      // RPC may not exist yet — ignore silently
    });

  } catch (err) {
    // Never crash the bot due to logging failure
    console.error('Message log error:', err.message);
  }
}

async function updateProfile(phone, waName) {
  try {
    await supabase.from('user_profiles').upsert({
      phone,
      wa_name: waName || null,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'phone' });
  } catch (err) {
    console.error('Profile update error:', err.message);
  }
}

module.exports = { logMessage, updateProfile };
