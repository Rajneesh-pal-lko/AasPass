require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();

// Parse JSON for most routes
app.use(express.json());

// Serve static files (admin UI)
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware
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

// Routes
const webhookRouter  = require('./src/routes/webhook');
const razorpayRouter = require('./src/routes/razorpay');
const adminRouter    = require('./src/routes/admin');

app.use('/webhook',  webhookRouter);
app.use('/razorpay', razorpayRouter);
app.use('/admin',    adminRouter);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'AasPass' }));

// Start background jobs
const { startCleanupJob } = require('./src/services/cleanup');
startCleanupJob();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AasPass server running on port ${PORT} ✈️`);
});
