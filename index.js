require('dotenv').config();
const express = require('express');
const app = express();

// Parse JSON for most routes
app.use(express.json());

// Routes
const webhookRouter  = require('./src/routes/webhook');
const razorpayRouter = require('./src/routes/razorpay');

app.use('/webhook',  webhookRouter);
app.use('/razorpay', razorpayRouter);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'AasPass' }));

// Start background jobs
const { startCleanupJob } = require('./src/services/cleanup');
startCleanupJob();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AasPass server running on port ${PORT} ✈️`);
});
