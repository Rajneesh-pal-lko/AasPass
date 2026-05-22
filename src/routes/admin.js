const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const path = require('path');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'aaspass_admin_2024';

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.admin) return next();
  res.redirect('/admin/login');
}

// ── Login page ─────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '../../public/admin/login.html'));
});

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ── Main dashboard ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/admin/index.html'));
});

// ── API — conversation list ────────────────────────────────────────────────────
router.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    // Get latest message per phone number
    const { data, error } = await supabase
      .from('message_logs')
      .select('phone, message_text, direction, created_at, message_type')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Group by phone — get last message and unread count
    const convMap = {};
    for (const msg of data) {
      if (!convMap[msg.phone]) {
        convMap[msg.phone] = {
          phone: msg.phone,
          lastMessage: msg.message_text,
          lastMessageType: msg.message_type,
          lastDirection: msg.direction,
          lastTime: msg.created_at,
          messageCount: 0,
        };
      }
      convMap[msg.phone].messageCount++;
    }

    // Get user profiles for names
    const phones = Object.keys(convMap);
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('phone, wa_name')
      .in('phone', phones);

    const profileMap = {};
    for (const p of (profiles || [])) profileMap[p.phone] = p.wa_name;

    // Get user states
    const { data: users } = await supabase
      .from('users')
      .select('phone, state, flight_number, is_active, is_matched')
      .in('phone', phones);

    const userMap = {};
    for (const u of (users || [])) userMap[u.phone] = u;

    const conversations = Object.values(convMap).map(c => ({
      ...c,
      name: profileMap[c.phone] || null,
      state: userMap[c.phone]?.state || 'IDLE',
      flightNumber: userMap[c.phone]?.flight_number || null,
      isActive: userMap[c.phone]?.is_active || false,
    })).sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));

    res.json(conversations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API — messages for a phone number ─────────────────────────────────────────
router.get('/api/messages/:phone', requireAuth, async (req, res) => {
  try {
    const { phone } = req.params;
    const { data, error } = await supabase
      .from('message_logs')
      .select('*')
      .eq('phone', phone)
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API — user details ─────────────────────────────────────────────────────────
router.get('/api/user/:phone', requireAuth, async (req, res) => {
  try {
    const { phone } = req.params;

    const [{ data: user }, { data: profile }, { data: matches }] = await Promise.all([
      supabase.from('users').select('*').eq('phone', phone).single(),
      supabase.from('user_profiles').select('*').eq('phone', phone).single(),
      supabase.from('match_requests')
        .select('*')
        .or(`from_user.eq.${user?.user_id || 'x'},to_user.eq.${user?.user_id || 'x'}`)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    res.json({ user, profile, matches: matches || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API — stats ────────────────────────────────────────────────────────────────
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
    ]);

    res.json({ totalUsers, activeUsers, totalMatches, completedMatches, totalMessages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API — clear old messages ───────────────────────────────────────────────────
router.delete('/api/clear-messages', requireAuth, async (req, res) => {
  try {
    const { months = 6 } = req.query;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - parseInt(months));

    const { error } = await supabase
      .from('message_logs')
      .delete()
      .lt('created_at', cutoff.toISOString());

    if (error) throw error;
    res.json({ success: true, clearedBefore: cutoff.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
