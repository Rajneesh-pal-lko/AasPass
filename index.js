require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();

// Parse JSON for most routes
app.use(express.json());

// Session MUST come before express.static so req.session exists on all requests
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'aaspass_session_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Block unauthenticated direct static access to admin dashboard.
// express.static would otherwise serve public/admin/index.html to anyone,
// bypassing the requireAuth middleware in adminRouter.
app.use((req, res, next) => {
  const p = req.path;
  const isAdminDashboard = p === '/admin' || p === '/admin/' || p === '/admin/index.html';
  if (isAdminDashboard && !req.session?.admin) {
    return res.redirect('/admin/login');
  }
  next();
});

// Static files (landing page, login page assets, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Routes
const webhookRouter  = require('./src/routes/webhook');
const razorpayRouter = require('./src/routes/razorpay');
const adminRouter    = require('./src/routes/admin');
const pickerRouter   = require('./src/routes/picker');

app.use('/webhook',  webhookRouter);
app.use('/razorpay', razorpayRouter);
app.use('/admin',    adminRouter);
app.use('/pick',     pickerRouter);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'AasPass' }));

// Privacy policy
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public/privacy.html')));

// Public stats API — used by landing page for live user count
app.get('/api/stats', async (req, res) => {
  try {
    const supabase = require('./src/config/supabase')

    const [totalRes, activeRes, matchesRes] = await Promise.all([
      supabase.from('users').select('user_id', { count: 'exact', head: true }),
      supabase.from('users').select('user_id', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('confirmed_matches').select('match_id', { count: 'exact', head: true }),
    ])

    res.json({
      totalUsers:   totalRes.count   ?? 0,
      activeNow:    activeRes.count  ?? 0,
      totalMatches: matchesRes.count ?? 0,
    })
  } catch (err) {
    res.json({ totalUsers: 0, activeNow: 0, totalMatches: 0 })
  }
})

// Start background jobs
const { startCleanupJob }    = require('./src/services/cleanup');
const { startDebounceWorker } = require('./src/services/debounceWorker');
startCleanupJob();
startDebounceWorker();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AasPass server running on port ${PORT} ✈️`);
});
