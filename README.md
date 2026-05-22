# AasPass ✈️🚕

**WhatsApp-native proximity-based cab splitting platform for airport passengers**

Stop paying solo cab prices! AasPass matches you with fellow passengers on your flight to split the ride and save money — all through WhatsApp, no app needed.

---

## 🎯 What It Does

1. **Land at the airport** → Open WhatsApp
2. **Share your flight & drop location** → AasPass finds nearby matches on your flight
3. **Request a match** → They accept, you pay ₹1 verification
4. **Get each other's numbers** → Meet at Arrivals, split an Uber 50/50
5. **Save money** → Everyone wins! 💰

---

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- Supabase account (free tier works)
- Meta Developer account (for WhatsApp Cloud API)
- Razorpay account (for payment links)
- Railway account (or any Node.js hosting)

### Setup

1. **Clone the repo**
   ```bash
   git clone <your-repo-url>
   cd AasPass
   npm install
   ```

2. **Set up Supabase database**
   - Create a new Supabase project
   - Go to SQL Editor and run `supabase_schema.sql`
   - Copy your project URL and service role key

3. **Configure WhatsApp Cloud API**
   - Go to [Meta Developer Console](https://developers.facebook.com/)
   - Create a new app → Add WhatsApp product
   - Get your Phone Number ID and Access Token
   - Generate a custom webhook verify token (any random string)

4. **Set up Razorpay**
   - Sign up at [Razorpay](https://razorpay.com/)
   - Get your Key ID and Key Secret
   - Go to Settings → Webhooks → Add webhook secret

5. **Create `.env` file**
   ```bash
   cp .env.example .env
   ```
   Fill in all the values (see `.env.example` for required fields)

6. **Run locally**
   ```bash
   npm run dev
   ```
   Server starts on `http://localhost:3000`

7. **Expose webhook for testing** (use ngrok or similar)
   ```bash
   ngrok http 3000
   ```
   Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

8. **Configure webhooks**
   - **WhatsApp**: Meta Developer Console → Webhooks → Callback URL: `https://abc123.ngrok.io/webhook`, Verify Token: (your `WEBHOOK_VERIFY_TOKEN`)
   - **Razorpay**: Dashboard → Settings → Webhooks → URL: `https://abc123.ngrok.io/razorpay/webhook`

---

## 📦 Deployment (Railway)

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

2. **Deploy to Railway**
   - Go to [Railway](https://railway.app/)
   - Create new project → Deploy from GitHub
   - Select your repo
   - Add all environment variables from `.env`
   - Railway auto-deploys on push

3. **Update webhook URLs**
   - Copy your Railway public URL (e.g., `https://aaspass-production.up.railway.app`)
   - Update WhatsApp webhook URL
   - Update Razorpay webhook URL
   - Set `SERVER_URL` env var in Railway to your public URL

---

## 🏗️ Architecture

```
┌─────────────┐
│   WhatsApp  │ ← Users interact here
│   Business  │
│   Account   │
└──────┬──────┘
       │ Webhooks
       ↓
┌─────────────────────────────────────┐
│         Express Server              │
│                                     │
│  ┌─────────────────────────────┐  │
│  │  Webhook Routes             │  │
│  │  - /webhook (WhatsApp)      │  │
│  │  - /razorpay/webhook        │  │
│  └─────────────────────────────┘  │
│                                     │
│  ┌─────────────────────────────┐  │
│  │  Conversation Handler       │  │
│  │  - State machine            │  │
│  │  - Message routing          │  │
│  └─────────────────────────────┘  │
│                                     │
│  ┌─────────────────────────────┐  │
│  │  Services                   │  │
│  │  - WhatsApp API wrapper     │  │
│  │  - Matching algorithm       │  │
│  │  - Razorpay integration     │  │
│  │  - Cleanup cron job         │  │
│  └─────────────────────────────┘  │
└────────────┬────────────────────────┘
             │
             ↓
      ┌────────────┐
      │  Supabase  │ ← PostgreSQL database
      │  Postgres  │
      └────────────┘
```

---

## 📊 User Journey

### Onboarding Flow
```
User sends "hi"
  ↓
Choose city (Hyderabad/Bangalore/Delhi)
  ↓
Share current location → Airport detected
  ↓
Enter flight number (e.g., 6E-204)
  ↓
Enter arrival time (e.g., 16:45)
  ↓
Share drop-off location (pin on map)
  ↓
Review summary → Confirm
  ↓
WAITING state (active in match pool)
```

### Matching Flow
```
User A in WAITING → Views matches → Sends request to User B
  ↓
User B receives match request (Accept/Decline)
  ↓
If ACCEPT:
  - User A gets payment link (₹1)
  - User A pays
  - Both users get each other's WhatsApp numbers
  - MATCHED state
  ↓
Users meet at airport, split cab
  ↓
Send "DONE" → COMPLETED state
```

---

## 🗂️ Project Structure

```
AasPass/
├── index.js                    # Entry point
├── package.json                # Dependencies
├── railway.toml                # Railway deployment config
├── supabase_schema.sql         # Database schema
├── .env.example                # Environment template
│
└── src/
    ├── config/
    │   └── supabase.js         # Database client
    │
    ├── routes/
    │   ├── webhook.js          # WhatsApp webhook handler
    │   └── razorpay.js         # Payment webhook handler
    │
    ├── handlers/
    │   └── conversation.js     # Main state machine & logic
    │
    ├── services/
    │   ├── whatsapp.js         # WhatsApp API wrapper
    │   ├── matching.js         # Match-finding algorithm
    │   ├── razorpay.js         # Payment link creation
    │   └── cleanup.js          # Cron job (expire old users)
    │
    └── utils/
        └── haversine.js        # Distance calculations
```

---

## 🔧 Key Features

### 1. **Smart Matching**
- Matches users on the **same flight number**
- Within **5km** of each other's drop location
- Sorted by proximity (closest first)
- Real-time notifications when new matches appear

### 2. **Location-Based Airport Detection**
- Automatically detects which airport you're at (within 2km radius)
- Supports: Hyderabad (HYD), Bangalore (BLR), Delhi (DEL)
- Prevents matches from wrong locations

### 3. **Auto-Expiry**
- Match requests expire after **10 minutes** if not responded
- User spots expire after **2 hours** in waiting state
- Keeps the pool fresh and active

### 4. **Payment Verification**
- ₹1 payment via Razorpay to verify identity
- Unlocks contact details only after payment
- Prevents spam and fake accounts

### 5. **Interactive WhatsApp UI**
- Buttons for quick actions (Accept/Decline)
- Lists for browsing matches
- Location sharing for drop-off
- URL buttons for payment links

---

## 💻 Available Commands

Users can type these in WhatsApp at any time:

| Command | Description |
|---------|-------------|
| `hi` / `start` | Begin onboarding or restart |
| `MATCHES` | View available matches (when in WAITING) |
| `CANCEL` | Cancel pending request or match |
| `DONE` | Mark trip as completed |
| `ISSUE` | Report a problem |
| `STATUS` | Check current state & trip details |
| `RESTART` | Start fresh onboarding |
| `STOP` | Unsubscribe from AasPass |
| `HELP` | Show command list |

---

## 🗄️ Database Schema

### **users**
Primary user table storing profiles and session state.

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | UUID | Primary key |
| `phone` | text | WhatsApp number (unique) |
| `flight_number` | text | Flight code (e.g., 6E-204) |
| `arrival_time` | text | Landing time (HH:MM) |
| `departure_airport` | text | Airport code (HYD/BLR/DEL) |
| `departure_lat/lon` | float | Current location coords |
| `drop_lat/lon` | float | Drop-off coords |
| `drop_zone` | text | Formatted drop location |
| `state` | text | Conversation state |
| `is_active` | boolean | Currently in pool? |
| `is_matched` | boolean | Has a confirmed match? |
| `payment_verified` | boolean | Paid ₹1 verification? |
| `matched_with` | UUID | FK to matched user |

### **match_requests**
Tracks all match requests and their status.

| Column | Type | Description |
|--------|------|-------------|
| `request_id` | UUID | Primary key |
| `from_user` | UUID | Sender |
| `to_user` | UUID | Receiver |
| `distance_km` | float | Distance between drop zones |
| `status` | text | pending/accepted/declined/expired/completed |
| `responded_at` | timestamptz | When receiver responded |

### **confirmed_matches**
Permanent record of successful matches (for analytics).

### **support_queue**
Issue reports from users.

---

## 🛠️ Development

### Run in dev mode (with auto-reload)
```bash
npm run dev
```

### Run in production
```bash
npm start
```

### Test health check
```bash
curl http://localhost:3000/health
```

### View logs
```bash
# Railway
railway logs

# Local
npm run dev  # stdout
```

---

## 🐛 Troubleshooting

### WhatsApp messages not sending
- Check `WHATSAPP_TOKEN` is valid (tokens expire after 60 days in dev mode)
- Verify `WHATSAPP_PHONE_NUMBER_ID` matches your test number
- Check Railway logs for `❌ WhatsApp send error`

### Webhook verification fails
- Ensure `WEBHOOK_VERIFY_TOKEN` matches Meta Developer Console exactly
- Check Railway logs for `Webhook verified ❌`

### Payment webhook fails
- Verify `RAZORPAY_WEBHOOK_SECRET` matches Razorpay Dashboard
- Check Razorpay webhook logs for failed deliveries
- Ensure `express.raw()` middleware is applied (see `razorpay.js`)

### No matches found
- Verify both users have the **exact same** flight number (case-sensitive)
- Check both users have `is_active = true` and `is_matched = false`
- Ensure drop locations are within 5km of each other
- Query Supabase directly: `SELECT * FROM users WHERE flight_number = '6E-204' AND is_active = true`

### Database connection errors
- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are correct
- Check Supabase project is active (free tier pauses after 1 week inactivity)

---

## 📈 Monitoring

### Key Metrics to Track
1. **Active users in WAITING state** (check hourly)
2. **Match request acceptance rate** (accepted / total requests)
3. **Payment completion rate** (paid / matched)
4. **Trip completion rate** (DONE / matched)
5. **Average time to match** (WAITING → MATCHED)

### Supabase Queries
```sql
-- Active users by state
SELECT state, COUNT(*) FROM users WHERE is_active = true GROUP BY state;

-- Today's matches
SELECT COUNT(*) FROM confirmed_matches WHERE DATE(confirmed_at) = CURRENT_DATE;

-- Pending requests older than 5 minutes
SELECT * FROM match_requests WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes';

-- Users waiting longer than 30 minutes
SELECT phone, flight_number, updated_at FROM users WHERE state = 'WAITING' AND updated_at < NOW() - INTERVAL '30 minutes';
```

---

## 🔐 Security Considerations

1. **Webhook Signature Verification**
   - Always verify Razorpay webhook signatures
   - WhatsApp webhooks use verify token (less secure, consider adding signature verification)

2. **Phone Number Privacy**
   - Numbers only shared after ₹1 payment verification
   - No public directory of users

3. **Rate Limiting**
   - Consider adding rate limits on `/webhook` endpoint
   - Prevent spam match requests (e.g., max 10 requests per hour)

4. **Environment Variables**
   - Never commit `.env` file
   - Use Railway's built-in secrets management

5. **Database Access**
   - Using Supabase service role key (bypasses RLS)
   - Consider implementing Row Level Security for production

---

## 🚧 Known Limitations

1. **No Multi-Airport Filtering**: Matching is only by flight number. Same flight at different airports could cross-match.
2. **No Refund Flow**: If match cancels after payment, manual intervention required.
3. **Single Active Trip**: One trip per phone number at a time.
4. **No Real-Time Polling**: Relies entirely on WhatsApp webhook delivery.
5. **No i18n Support**: All messages in English only.

---

## 🗺️ Roadmap

- [ ] Add support for more cities (Mumbai, Chennai, Kolkata)
- [ ] Multi-language support (Hindi, Kannada, Telugu)
- [ ] Group splits (3-4 person matches for larger vehicles)
- [ ] Flight API integration (auto-populate arrival time)
- [ ] Admin dashboard for monitoring and support
- [ ] In-app Uber/Ola booking integration
- [ ] Post-trip rating system
- [ ] Referral rewards

---

## 📄 License

[Add your license here]

---

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📞 Support

- **Issues**: [GitHub Issues](your-repo-url/issues)
- **Email**: [your-email@example.com]
- **WhatsApp**: [your-support-number]

---

## 👥 Authors

[Add your name and contributors here]

---

## 🙏 Acknowledgments

- WhatsApp Cloud API for messaging infrastructure
- Supabase for backend-as-a-service
- Razorpay for payment processing
- Railway for hosting

---

**Built with ❤️ for travelers who want to save money and meet cool people** ✈️🚕
