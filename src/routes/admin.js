const express = require('express')
const router  = express.Router()
const supabase = require('../config/supabase')
const path     = require('path')
const { sendText } = require('../services/whatsapp')
const { adminDeactivateUser, adminResetUserState } = require('../services/userService')

const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || 'aaspass_admin_2024'
// If set, the login page is only reachable at /admin/login?key=<ADMIN_ACCESS_KEY>
// Without the correct key, the login page returns 404 — hides it from strangers.
// Set ADMIN_ACCESS_KEY to a random string in your Railway env vars.
const ADMIN_ACCESS_KEY = process.env.ADMIN_ACCESS_KEY || ''

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.admin) return next()
  // Preserve the access key in the redirect so the login page stays accessible
  const keyParam = ADMIN_ACCESS_KEY ? `?key=${ADMIN_ACCESS_KEY}` : ''
  res.redirect(`/admin/login${keyParam}`)
}

// Disable HTTP caching on all admin API responses — browsers were returning 304s
// and rendering stale data (new messages never appeared).
router.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Pragma', 'no-cache')
  next()
})

// ── Audit logger (fire-and-forget) ────────────────────────────────────────────
async function auditLog(action, targetPhone, details = {}) {
  try {
    await supabase.from('admin_audit_log').insert({
      action,
      target_phone: targetPhone,
      details,
      created_at: new Date().toISOString(),
    })
  } catch (_) { /* non-blocking */ }
}

// ── Login / logout ─────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.admin) return res.redirect('/admin')
  // If ADMIN_ACCESS_KEY is set, require it in the URL — strangers get 404
  if (ADMIN_ACCESS_KEY && req.query.key !== ADMIN_ACCESS_KEY) {
    return res.status(404).send('Not found')
  }
  res.sendFile(path.join(__dirname, '../../public/admin/login.html'))
})

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.admin = true
    return res.redirect('/admin')
  }
  const keyParam = ADMIN_ACCESS_KEY ? `?key=${ADMIN_ACCESS_KEY}` : ''
  res.redirect(`/admin/login${keyParam}&error=1`)
})

router.get('/logout', (req, res) => {
  req.session.destroy()
  const keyParam = ADMIN_ACCESS_KEY ? `?key=${ADMIN_ACCESS_KEY}` : ''
  res.redirect(`/admin/login${keyParam}`)
})

// ── Main dashboard ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/admin/index.html'))
})

// ════════════════════════════════════════════════════════════════════════════════
// EXISTING ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════════

router.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    // Source of truth: all registered users (not just those with message_logs entries)
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('phone, name, state, is_active, is_matched, flight_number, updated_at, created_at')
      .order('updated_at', { ascending: false })
      .limit(500)
    if (usersError) throw usersError

    if (!users?.length) return res.json([])

    const phones = users.map(u => u.phone)

    // Fetch recent messages and wa_names in parallel
    const [logsResult, profilesResult] = await Promise.all([
      supabase
        .from('message_logs')
        .select('phone, message_text, direction, created_at, message_type')
        .in('phone', phones)
        .order('created_at', { ascending: false })
        .limit(2000),
      supabase.from('user_profiles').select('phone, wa_name').in('phone', phones),
    ])

    // Build last-message summary per phone from logs
    const msgMap = {}
    for (const msg of (logsResult.data || [])) {
      if (!msgMap[msg.phone]) {
        msgMap[msg.phone] = {
          lastMessage:     msg.message_text,
          lastMessageType: msg.message_type || null,
          lastDirection:   msg.direction,
          lastTime:        msg.created_at,
          messageCount:    0,
        }
      }
      msgMap[msg.phone].messageCount++
    }

    const profileMap = {}
    for (const p of (profilesResult.data || [])) profileMap[p.phone] = p.wa_name

    const conversations = users.map(u => ({
      phone:           u.phone,
      name:            profileMap[u.phone] || u.name || null,
      state:           u.state || 'IDLE',
      flightNumber:    u.flight_number || null,
      isActive:        u.is_active || false,
      lastMessage:     msgMap[u.phone]?.lastMessage     || '',
      lastMessageType: msgMap[u.phone]?.lastMessageType || null,
      lastDirection:   msgMap[u.phone]?.lastDirection   || 'incoming',
      lastTime:        msgMap[u.phone]?.lastTime        || u.updated_at || u.created_at,
      messageCount:    msgMap[u.phone]?.messageCount    || 0,
    })).sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime))

    res.json(conversations)
  } catch (err) {
    console.error('[admin] conversations error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.get('/api/messages/:phone', requireAuth, async (req, res) => {
  try {
    // Fetch the NEWEST 500 messages, then reverse for chronological display.
    // Previously this used ascending+limit which hid recent messages for
    // any phone with > 500 historical messages.
    const { data, error } = await supabase
      .from('message_logs').select('*').eq('phone', req.params.phone)
      .order('created_at', { ascending: false }).limit(500)
    if (error) throw error
    res.json((data || []).reverse())
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/api/user/:phone', requireAuth, async (req, res) => {
  try {
    const { phone } = req.params
    const { data: user }    = await supabase.from('users').select('*').eq('phone', phone).single()
    const { data: profile } = await supabase.from('user_profiles').select('*').eq('phone', phone).single()
    const { data: matches } = await supabase.from('match_requests')
      .select('*')
      .or(`from_user.eq.${user?.user_id || 'x'},to_user.eq.${user?.user_id || 'x'}`)
      .order('created_at', { ascending: false }).limit(10)
    res.json({ user, profile, matches: matches || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const [
      { count: totalUsers },
      { count: activeUsers },
      { count: totalMatches },
      { count: completedMatches },
      { count: totalMessages },
    ] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('match_requests').select('*', { count: 'exact', head: true }),
      supabase.from('match_requests').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
      supabase.from('message_logs').select('*', { count: 'exact', head: true }),
    ])
    res.json({ totalUsers, activeUsers, totalMatches, completedMatches, totalMessages })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.delete('/api/clear-messages', requireAuth, async (req, res) => {
  try {
    const { months = 6 } = req.query
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - parseInt(months))
    const { error } = await supabase.from('message_logs').delete().lt('created_at', cutoff.toISOString())
    if (error) throw error
    await auditLog('clear_messages', null, { months, cutoff: cutoff.toISOString() })
    res.json({ success: true, clearedBefore: cutoff.toISOString() })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ════════════════════════════════════════════════════════════════════════════════
// LIVE OPS
// ════════════════════════════════════════════════════════════════════════════════

router.get('/api/live/waiting-pool', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('phone, name, departure_airport, drop_zone, arrival_time, updated_at, gender')
      .eq('state', 'WAITING')
      .eq('is_active', true)
      .order('updated_at', { ascending: true })
    if (error) throw error
    res.json({ users: data || [], count: data?.length || 0 })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/api/live/pending-requests', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('match_requests')
      .select(`
        request_id, distance_km, created_at,
        from_user:users!from_user(phone, name),
        to_user:users!to_user(phone, name)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
    if (error) throw error
    res.json({ requests: data || [] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.get('/api/live/today-summary', requireAuth, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const todayIso = today.toISOString()

    const [s, m, w, p] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }).gte('created_at', todayIso),
      supabase.from('match_requests').select('*', { count: 'exact', head: true }).eq('status', 'completed').gte('created_at', todayIso),
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('state', 'WAITING').eq('is_active', true),
      supabase.from('match_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    ])

    res.json({
      signupsToday:    s.count ?? 0,
      matchesToday:    m.count ?? 0,
      waitingNow:      w.count ?? 0,
      pendingRequests: p.count ?? 0,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ════════════════════════════════════════════════════════════════════════════════
// SUPPORT QUEUE
// ════════════════════════════════════════════════════════════════════════════════

router.get('/api/support', requireAuth, async (req, res) => {
  try {
    const { resolved = 'false', page = 0 } = req.query
    const offset = parseInt(page) * 50
    let q = supabase
      .from('support_queue')
      .select('*, user:users!user_id(phone, name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + 49)

    if (resolved !== 'all') q = q.eq('resolved', resolved === 'true')

    const { data, count, error } = await q
    if (error) throw error
    res.json({ items: data || [], total: count })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.patch('/api/support/:issueId/resolve', requireAuth, async (req, res) => {
  try {
    const { issueId } = req.params
    const { error } = await supabase.from('support_queue').update({ resolved: true }).eq('issue_id', issueId)
    if (error) throw error
    await auditLog('support_resolve', null, { issueId })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/api/support/:issueId/reply', requireAuth, async (req, res) => {
  try {
    const { issueId } = req.params
    const { message } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' })

    const { data: issue, error } = await supabase
      .from('support_queue')
      .select('user:users!user_id(phone)')
      .eq('issue_id', issueId)
      .single()
    if (error || !issue?.user?.phone) throw new Error('Issue or user not found')

    const phone = issue.user.phone
    await sendText(phone, message.trim())
    await auditLog('support_reply', phone, { issueId, message })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ════════════════════════════════════════════════════════════════════════════════
// ERROR LOGS
// ════════════════════════════════════════════════════════════════════════════════

router.get('/api/errors', requireAuth, async (req, res) => {
  try {
    const { severity = 'all', resolved = 'false', errorType = '', page = 0 } = req.query
    const offset = parseInt(page) * 100

    let q = supabase.from('error_logs').select('*', { count: 'exact' })
    if (severity !== 'all') q = q.eq('severity', severity)
    if (resolved !== 'all') q = q.eq('resolved', resolved === 'true')
    if (errorType) q = q.ilike('error_type', `%${errorType}%`)
    q = q.order('created_at', { ascending: false }).range(offset, offset + 99)

    const { data, count, error } = await q
    if (error) throw error

    const criticalCount = (data || []).filter(e => e.severity === 'CRITICAL').length
    const errorCount    = (data || []).filter(e => e.severity === 'ERROR').length
    res.json({ logs: data || [], total: count, criticalCount, errorCount })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.patch('/api/errors/:id/resolve', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const { error } = await supabase.from('error_logs')
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error
    await auditLog('error_resolve', null, { errorId: id })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Bulk resolve by criteria (not by ID array — avoids payload bloat)
router.post('/api/errors/resolve-bulk', requireAuth, async (req, res) => {
  try {
    const { severity, before_date } = req.body
    if (!severity && !before_date) return res.status(400).json({ error: 'Provide severity or before_date' })

    const now = new Date().toISOString()
    let q = supabase.from('error_logs').update({ resolved: true, resolved_at: now }).eq('resolved', false)
    if (severity) q = q.eq('severity', severity)
    if (before_date) q = q.lt('created_at', before_date)

    const { error } = await q
    if (error) throw error
    await auditLog('error_bulk_resolve', null, { severity, before_date })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ════════════════════════════════════════════════════════════════════════════════
// ANALYTICS (single RPC call — all aggregations in PostgreSQL)
// ════════════════════════════════════════════════════════════════════════════════

router.get('/api/analytics', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30
    const { data, error } = await supabase.rpc('admin_analytics', { days })
    if (error) throw error
    res.json(data)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ════════════════════════════════════════════════════════════════════════════════
// FEEDBACK INBOX
// ════════════════════════════════════════════════════════════════════════════════

router.get('/api/feedback', requireAuth, async (req, res) => {
  try {
    const offset = parseInt(req.query.page || 0) * 50

    // Feedback is stored in support_queue with issue_type = 'USER_FEEDBACK'
    const { data: items, count, error } = await supabase
      .from('support_queue')
      .select('*, user:users!user_id(phone, name)', { count: 'exact' })
      .eq('issue_type', 'USER_FEEDBACK')
      .order('created_at', { ascending: false })
      .range(offset, offset + 49)
    if (error) throw error

    if (!items?.length) return res.json({ feedback: [], total: 0 })

    // Fetch profile names (wa_name) for each user phone
    const phones = [...new Set(items.map(i => i.user?.phone).filter(Boolean))]
    const { data: profiles } = await supabase
      .from('user_profiles').select('phone, wa_name').in('phone', phones)
    const nameMap = {}; for (const p of (profiles || [])) nameMap[p.phone] = p.wa_name

    // Group by phone so multiple feedback messages from same user appear together
    const grouped = {}
    for (const item of items) {
      const phone = item.user?.phone
      if (!phone) continue
      if (!grouped[phone]) {
        grouped[phone] = {
          phone,
          name: nameMap[phone] || item.user?.name || null,
          messages: [],
          latestAt: item.created_at,
        }
      }
      grouped[phone].messages.push({ text: item.description, createdAt: item.created_at })
    }

    res.json({ feedback: Object.values(grouped), total: count })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ════════════════════════════════════════════════════════════════════════════════
// USER ACTIONS
// ════════════════════════════════════════════════════════════════════════════════

router.post('/api/user/:phone/deactivate', requireAuth, async (req, res) => {
  try {
    const { phone } = req.params
    await adminDeactivateUser(phone)
    await auditLog('user_deactivate', phone)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/api/user/:phone/reset-state', requireAuth, async (req, res) => {
  try {
    const { phone } = req.params
    await adminResetUserState(phone)
    await auditLog('user_reset_state', phone)
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/api/user/:phone/send-message', requireAuth, async (req, res) => {
  try {
    const { phone } = req.params
    const { message } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' })

    // Meta 24h window check
    const { data: profile } = await supabase
      .from('user_profiles').select('last_seen_at').eq('phone', phone).single()
    const hoursSince = profile?.last_seen_at
      ? (Date.now() - new Date(profile.last_seen_at)) / 3600000
      : 999
    if (hoursSince > 24) {
      return res.status(400).json({
        error: `User last active ${Math.round(hoursSince)}h ago. WhatsApp only allows free-form messages within the 24h conversation window.`
      })
    }

    await sendText(phone, message.trim())
    await auditLog('send_message', phone, { message })
    res.json({ success: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ════════════════════════════════════════════════════════════════════════════════
// BROADCAST
// ════════════════════════════════════════════════════════════════════════════════

router.get('/api/broadcast/preview', requireAuth, async (req, res) => {
  try {
    const { target = 'active' } = req.query
    const since24h = new Date(Date.now() - 86400000).toISOString()

    // Count users reachable within 24h window
    const { count: reachableCount } = await supabase
      .from('user_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('last_seen_at', since24h)

    // Total target count (may exceed reachable due to 24h limit)
    let totalQ = supabase.from('users').select('*', { count: 'exact', head: true })
    if (target === 'active') totalQ = totalQ.eq('is_active', true)
    const { count: totalCount } = await totalQ

    res.json({ totalCount, reachableCount, target })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/api/broadcast/send', requireAuth, async (req, res) => {
  try {
    const { message, target = 'active' } = req.body
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' })

    // DB-level cooldown guard — works across restarts and multiple instances
    const { data: lastBroadcast } = await supabase
      .from('admin_audit_log')
      .select('created_at').eq('action', 'broadcast')
      .order('created_at', { ascending: false }).limit(1).single()

    if (lastBroadcast) {
      const msSince = Date.now() - new Date(lastBroadcast.created_at)
      if (msSince < 10 * 60 * 1000) {
        const remaining = Math.ceil((10 * 60 * 1000 - msSince) / 60000)
        return res.status(429).json({ error: `Broadcast cooldown active. Try again in ${remaining} min.` })
      }
    }

    // Only send to users active in the last 24h (Meta policy)
    const since24h = new Date(Date.now() - 86400000).toISOString()
    let profileQ = supabase.from('user_profiles').select('phone').gte('last_seen_at', since24h)

    if (target === 'active') {
      // Filter to only is_active users
      const { data: activeUsers } = await supabase.from('users').select('phone').eq('is_active', true)
      const activeSet = new Set((activeUsers || []).map(u => u.phone))
      const { data: recentProfiles } = await profileQ
      const targets = (recentProfiles || []).filter(p => activeSet.has(p.phone))

      // Log the broadcast intent before firing (so cooldown is enforced even if process dies)
      await auditLog('broadcast', null, { target, message: message.trim(), count: targets.length, status: 'queued' })

      // Return immediately — non-blocking
      res.status(202).json({ queued: targets.length, message: 'Broadcast started. Check audit log for results.' })

      // Fire-and-forget in background
      setImmediate(async () => {
        let sent = 0, failed = 0
        const BATCH = 10
        for (let i = 0; i < targets.length; i += BATCH) {
          await Promise.allSettled(
            targets.slice(i, i + BATCH).map(u =>
              sendText(u.phone, message.trim()).then(() => sent++).catch(() => failed++)
            )
          )
          if (i + BATCH < targets.length) await new Promise(r => setTimeout(r, 500))
        }
        // Update the audit log entry with final results
        await supabase.from('admin_audit_log')
          .update({ details: { target, message: message.trim(), count: targets.length, sent, failed, status: 'done' } })
          .eq('action', 'broadcast')
          .order('created_at', { ascending: false })
          .limit(1)
      })
    } else {
      // target = 'all' within 24h window
      const { data: targets } = await profileQ
      await auditLog('broadcast', null, { target, message: message.trim(), count: targets?.length || 0, status: 'queued' })
      res.status(202).json({ queued: targets?.length || 0, message: 'Broadcast started. Check audit log for results.' })

      setImmediate(async () => {
        let sent = 0, failed = 0
        const BATCH = 10
        for (let i = 0; i < (targets || []).length; i += BATCH) {
          await Promise.allSettled(
            targets.slice(i, i + BATCH).map(u =>
              sendText(u.phone, message.trim()).then(() => sent++).catch(() => failed++)
            )
          )
          if (i + BATCH < targets.length) await new Promise(r => setTimeout(r, 500))
        }
        await supabase.from('admin_audit_log')
          .update({ details: { target, message: message.trim(), count: targets.length, sent, failed, status: 'done' } })
          .eq('action', 'broadcast')
          .order('created_at', { ascending: false })
          .limit(1)
      })
    }
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
