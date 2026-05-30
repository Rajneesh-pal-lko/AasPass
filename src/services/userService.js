const supabase = require('../config/supabase')
const { sendText } = require('./whatsapp')

/**
 * Force-deactivate a user from admin panel.
 * Handles partner notification and request cancellation atomically.
 */
async function adminDeactivateUser(phone) {
  const { data: user, error } = await supabase
    .from('users').select('*').eq('phone', phone).single()
  if (error || !user) throw new Error('User not found')

  // If matched, notify partner and return them to WAITING
  if (user.is_matched && user.matched_with) {
    const { data: partner } = await supabase
      .from('users').select('phone').eq('user_id', user.matched_with).single()
    if (partner) {
      await sendText(partner.phone,
        `Your cab-split partner is no longer available. You've been returned to the match pool. Type *MATCHES* to find a new partner.`)
      await supabase.from('users').update({
        is_matched: false,
        matched_with: null,
        pending_request_id: null,
        state: 'WAITING',
        updated_at: new Date().toISOString(),
      }).eq('user_id', user.matched_with)
    }
  }

  // Cancel any pending match request
  if (user.pending_request_id) {
    await supabase.from('match_requests')
      .update({ status: 'cancelled_by_sender', cancelled_at: new Date().toISOString() })
      .eq('request_id', user.pending_request_id)
  }

  // Deactivate the user
  await supabase.from('users').update({
    is_active: false,
    is_matched: false,
    matched_with: null,
    pending_request_id: null,
    state: 'IDLE',
    updated_at: new Date().toISOString(),
  }).eq('phone', phone)
}

/**
 * Soft-reset a user's state to IDLE without fully deactivating them.
 * Also notifies partner if user was matched.
 */
async function adminResetUserState(phone) {
  const { data: user, error } = await supabase
    .from('users').select('*').eq('phone', phone).single()
  if (error || !user) throw new Error('User not found')

  if (user.is_matched && user.matched_with) {
    const { data: partner } = await supabase
      .from('users').select('phone').eq('user_id', user.matched_with).single()
    if (partner) {
      await sendText(partner.phone,
        `Your cab-split partner's session was reset by support. You've been returned to the match pool. Type *MATCHES* to find a new partner.`)
      await supabase.from('users').update({
        is_matched: false,
        matched_with: null,
        pending_request_id: null,
        state: 'WAITING',
        updated_at: new Date().toISOString(),
      }).eq('user_id', user.matched_with)
    }
  }

  if (user.pending_request_id) {
    await supabase.from('match_requests')
      .update({ status: 'cancelled_by_sender', cancelled_at: new Date().toISOString() })
      .eq('request_id', user.pending_request_id)
  }

  await supabase.from('users').update({
    state: 'IDLE',
    is_matched: false,
    matched_with: null,
    pending_request_id: null,
    updated_at: new Date().toISOString(),
  }).eq('phone', phone)
}

module.exports = { adminDeactivateUser, adminResetUserState }
