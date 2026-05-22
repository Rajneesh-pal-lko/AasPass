# AasPass — Project Context for AI Assistants

## Project Overview

AasPass is a **WhatsApp-native proximity-based cab splitting platform** for airport passengers. It matches passengers arriving on the same flight who want to share a cab to nearby drop locations, enabling them to split fares and reduce costs.

**Core Philosophy**: Zero-friction UX — no app downloads, no complex forms. Everything happens through WhatsApp conversations using interactive messages.

---

## Architecture

### Tech Stack
- **Runtime**: Node.js 20+
- **Framework**: Express.js 5.x
- **Database**: Supabase (PostgreSQL)
- **Messaging**: WhatsApp Cloud API (Meta Graph API v19.0)
- **Payments**: Razorpay
- **Background Jobs**: node-cron
- **Deployment**: Railway (configured via `railway.toml`)

### Project Structure

```
AasPass/
├── index.js                    # Entry point, route mounting, health check
├── src/
│   ├── config/
│   │   └── supabase.js        # Supabase client singleton with lazy init
│   ├── handlers/
│   │   └── conversation.js    # Main state machine & message dispatcher
│   ├── routes/
│   │   ├── webhook.js         # WhatsApp webhook (GET verification, POST messages)
│   │   └── razorpay.js        # Razorpay webhook + payment callback
│   ├── services/
│   │   ├── whatsapp.js        # WhatsApp API wrapper (sendText, sendButtons, etc.)
│   │   ├── matching.js        # Match-finding algorithm & result sending
│   │   ├── razorpay.js        # Payment link creation & webhook verification
│   │   └── cleanup.js         # Cron job: expire stale WAITING users (2hr)
│   └── utils/
│       └── haversine.js       # Distance calculation & airport detection
├── supabase_schema.sql        # Database schema (run in Supabase SQL Editor)
├── .env.example               # Template for environment variables
└── railway.toml               # Railway deployment config
```

---

## Core Concepts

### State Machine

Users progress through states stored in the `users.state` column:

**Onboarding Flow**:
1. `IDLE` → User starts fresh or restarts
2. `ONBOARDING_CITY` → Choosing city (HYD/BLR/DEL)
3. `ONBOARDING_LOCATION` → Sharing current location (confirms airport)
4. `ONBOARDING_FLIGHT` → Entering flight number
5. `ONBOARDING_ARRIVAL` → Entering arrival time (HH:MM)
6. `ONBOARDING_DROP` → Sharing drop-off location (pin on map)
7. `ONBOARDING_CONFIRM` → Reviewing trip summary

**Matching Flow**:
8. `WAITING` → Active in match pool, can view/send match requests
9. `MATCH_SENT` → Sent a request, waiting for response
10. `MATCH_RECEIVED` → Received a request, must Accept/Decline
11. `MATCHED` → Successfully paired, awaiting payment or trip completion
12. `COMPLETED` → Trip done, user goes idle

**Important**: State transitions are handled by `setState()` in `conversation.js`, which also updates `updated_at` timestamp.

### Matching Algorithm

**File**: `src/services/matching.js`

**Logic**:
1. Find all users with:
   - Same `flight_number`
   - `is_active = true`
   - `is_matched = false`
   - Different `user_id`
2. Calculate haversine distance between drop locations
3. Filter by `MATCH_RADIUS_KM = 5km`
4. Sort by distance (closest first)
5. Return top 10 matches

**Key Function**: `findMatches(user)` returns ranked array of candidates.

### Payment Flow

**File**: `src/services/razorpay.js`, `src/routes/razorpay.js`

1. When User A's match request is accepted by User B:
   - System sends Razorpay payment link (₹1) to User A via WhatsApp CTA button
   - Link includes `notes: { user_id, match_id }` for tracking
2. User A completes payment
3. Razorpay webhook (`POST /razorpay/webhook`) fires with `payment_link.paid` event
4. System verifies signature, marks `payment_verified = true`
5. **Both users receive each other's**:
   - WhatsApp number (`wa.me/[phone]`)
   - Drop zone coordinates
   - Confirmation buttons (DONE/ISSUE)

**Security**: Webhook signature verification using HMAC-SHA256.

### Location & Airport Detection

**File**: `src/utils/haversine.js`

**Airport Database**:
```javascript
AIRPORTS = {
  HYD: { name: 'Hyderabad (RGIA)', lat: 17.2403, lon: 78.4294 },
  BLR: { name: 'Bangalore (KIA)',  lat: 13.1986, lon: 77.7066 },
  DEL: { name: 'Delhi (IGI)',      lat: 28.5562, lon: 77.1000 },
}
```

**Detection**: `detectAirport(lat, lon, radiusKm = 2)` checks if user is within 2km of any airport.

**Distance Calculation**: Standard haversine formula (Earth radius = 6371km).

### Cleanup Job

**File**: `src/services/cleanup.js`

- **Runs**: Every 10 minutes (cron: `*/10 * * * *`)
- **Logic**: Find users in `WAITING` state with `updated_at` older than 2 hours
- **Action**: Set `is_active = false`, `state = IDLE`, send expiry message
- **Reason**: Prevents stale matches from cluttering the pool

---

## Database Schema

### `users` Table
Primary user profiles and session state.

**Key Columns**:
- `user_id` (PK, UUID)
- `phone` (unique, text) — WhatsApp number (no `+` prefix in storage)
- `flight_number`, `arrival_time`, `departure_airport` — Trip details
- `departure_lat/lon`, `drop_lat/lon` — Coordinates for matching
- `city_preference` — HYD/BLR/DEL (user-selected city)
- `state` — Current conversation state (see State Machine above)
- `is_active`, `is_matched`, `payment_verified` — Boolean flags
- `matched_with` (FK to `users.user_id`) — UUID of matched partner
- `pending_request_id` (FK to `match_requests.request_id`) — Active request UUID

**Indexes**:
- `idx_users_phone` on `phone`
- `idx_users_flight_active` on `(flight_number, is_active, is_matched)`

### `match_requests` Table
Tracks all match requests (pending, accepted, declined, expired, completed).

**Key Columns**:
- `request_id` (PK, UUID)
- `from_user`, `to_user` (FKs to `users.user_id`)
- `distance_km` — Calculated at request time
- `status` — One of: `pending`, `accepted`, `declined`, `cancelled_by_sender`, `cancelled_by_receiver`, `cancelled_after_accept`, `expired`, `completed`
- `cancelled_by`, `confirmed_by` (FKs to `users.user_id`)
- `cancelled_at`, `confirmed_at`, `responded_at` — Timestamps

**Indexes**:
- `idx_match_requests_from` on `(from_user, status)`
- `idx_match_requests_to` on `(to_user, status)`

### `confirmed_matches` Table
Permanent record of successful matches (analytics/history).

### `support_queue` Table
Issue reports from users (type ISSUE command).

---

## WhatsApp API Wrapper

**File**: `src/services/whatsapp.js`

**Base URL**: `https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages`

**Functions**:
1. **`sendText(to, text)`** — Plain text message
2. **`sendButtons(to, bodyText, buttons)`** — Interactive buttons (max 3)
   - Example: `[{ id: 'YES', title: '✅ Yes' }]`
3. **`sendList(to, bodyText, buttonLabel, sections)`** — List picker (max 10 rows)
   - Example: `[{ title: 'Matches', rows: [{id: 'match_123', title: '2.5km away'}] }]`
4. **`sendCTAButton(to, bodyText, buttonText, url)`** — URL button (e.g., payment link)
5. **`sendLocationRequest(to, bodyText)`** — Prompts user to share location

**Error Handling**: Logs full error response from Meta API.

---

## Message Handling Flow

**File**: `src/handlers/conversation.js`

**Entry Point**: `handleMessage(msg)` receives parsed WhatsApp message object.

**Message Parsing**:
```javascript
msg = {
  from: '919876543210',        // phone number
  type: 'text' | 'interactive' | 'location',
  text?: { body: 'user message' },
  interactive?: {
    type: 'button_reply' | 'list_reply',
    button_reply?: { id: 'YES' },
    list_reply?: { id: 'match_abc123' }
  },
  location?: { latitude: 17.24, longitude: 78.42 }
}
```

**Global Commands** (work from any state):
- `STOP` → Unsubscribe (`is_active = false`)
- `HELP` → Show command list
- `STATUS` → Show current user state/trip details
- `RESTART` / `HI` / `START` → Restart onboarding

**State-Specific Logic**: Big switch statement handles each state's expected inputs.

---

## Critical Implementation Details

### 1. Match Request Expiry
**File**: `conversation.js:268`

When a match request is sent, a 10-minute timeout is set:
```javascript
setTimeout(() => expireRequest(req.request_id, fromUser, toUser), 10 * 60 * 1000);
```

If still `pending` after 10 minutes:
- Status → `expired`
- Both users → `WAITING`
- From-user gets next match shown

### 2. Notify Waiting Users
**File**: `conversation.js:418`

When a **new user** joins the pool, notify existing waiting users on the same flight that a new match appeared. This keeps users engaged without manual polling.

### 3. Payment Verification
**File**: `razorpay.js` route handler

After payment:
- Contact details are shared via `wa.me/[phone]` link
- Both users get confirmation buttons (DONE/ISSUE)
- NO automatic state transition — users must manually confirm trip completion

### 4. Location Sharing
WhatsApp location messages include `latitude` and `longitude` in decimal degrees. These are stored directly in `departure_lat/lon` and `drop_lat/lon`.

### 5. Phone Number Format
**Stored WITHOUT `+` prefix** in the database (e.g., `919876543210`).
**Sent WITH `+` prefix** to Razorpay (`+919876543210`).
**WhatsApp message recipient** uses raw format (no `+`).

---

## Environment Variables

Required in `.env`:

```bash
# WhatsApp Cloud API
WHATSAPP_TOKEN=               # Access token from Meta Developer Console
WHATSAPP_PHONE_NUMBER_ID=     # Phone number ID from Meta
WEBHOOK_VERIFY_TOKEN=         # Custom secret for webhook verification

# Supabase
SUPABASE_URL=                 # Project URL
SUPABASE_SERVICE_KEY=         # Service role key (bypasses RLS)

# Razorpay
RAZORPAY_KEY_ID=              # API key ID
RAZORPAY_KEY_SECRET=          # API key secret
RAZORPAY_WEBHOOK_SECRET=      # Webhook signing secret

# Server
PORT=3000                     # Optional, defaults to 3000
NODE_ENV=development          # development | production
SERVER_URL=                   # Public URL for Razorpay callbacks
```

---

## Common Operations

### Adding a New City
1. Add entry to `AIRPORTS` in `src/utils/haversine.js`
2. Add button in `sendWelcome()` in `conversation.js:33`

### Changing Match Radius
Update `MATCH_RADIUS_KM` constant in `src/services/matching.js:5`

### Adjusting Cleanup Time Window
Change `2 * 60 * 60 * 1000` (2 hours) in `src/services/cleanup.js:8`

### Debugging Webhook Issues
- Check Railway logs for `❌ WhatsApp send error` or `Webhook processing error`
- Verify `WEBHOOK_VERIFY_TOKEN` matches Meta Developer Console
- Use `ngrok` for local testing: `ngrok http 3000`

---

## Testing Checklist

When making changes, manually test:

1. **Onboarding Flow** (IDLE → WAITING)
   - City selection
   - Location sharing (within 2km of airport)
   - Flight number input
   - Arrival time (HH:MM validation)
   - Drop location sharing
   - Confirmation

2. **Matching Flow**
   - No matches: "You are the first one" message
   - Multiple matches: List shows sorted by distance
   - Match request: Both users transition states correctly
   - Accept: Payment link sent, contact details after payment
   - Decline: Both back to WAITING

3. **Edge Cases**
   - Location outside airport radius → Error message
   - Invalid time format → Validation error
   - Request expiry after 10 minutes
   - Cleanup job removes 2hr-old WAITING users
   - CANCEL commands at each stage

4. **Payment Flow**
   - Payment link opens in browser
   - Webhook signature verification passes
   - Contact details sent after successful payment
   - DONE button completes trip

---

## Known Limitations

1. **No Multi-Airport Filtering**: Users can select city preference, but matching is only by flight number. If the same flight number exists at multiple airports, matches could cross airports. (Airport code from location detection is stored but not used in matching.)

2. **No User Authentication**: Phone number is the only identifier. Malicious users could spoof numbers (mitigated by ₹1 payment barrier).

3. **No Refund Flow**: If a match cancels after payment, no automatic refund. Users must contact support.

4. **Single Active Session**: One trip per phone number at a time. Users can't book multiple future trips.

5. **No Real-Time Notifications**: Match notifications rely on webhook delivery. If Meta's webhooks fail, users won't be notified. (No polling fallback.)

6. **Hardcoded Message Templates**: All user-facing text is in code. No CMS or i18n support.

---

## Troubleshooting

### "Webhook verified ❌" on Railway
- Ensure `WEBHOOK_VERIFY_TOKEN` matches Meta Developer Console
- Check Railway logs: `POST /webhook` should receive `hub.mode=subscribe`

### "Invalid Razorpay signature"
- Verify `RAZORPAY_WEBHOOK_SECRET` matches Razorpay Dashboard → Settings → Webhooks
- Ensure `express.raw()` middleware is applied BEFORE parsing (see `razorpay.js:8`)

### Users Not Receiving Messages
- Check Meta Developer Console → WhatsApp → Message Templates (may need approval for production)
- Verify `WHATSAPP_TOKEN` hasn't expired
- Check Railway logs for `❌ WhatsApp send error`

### Matches Not Appearing
- Verify `flight_number` is stored identically for both users (case-sensitive)
- Check `is_active = true` and `is_matched = false` in Supabase
- Ensure drop locations are within `MATCH_RADIUS_KM = 5km`

---

## Deployment (Railway)

1. Connect GitHub repo to Railway project
2. Add environment variables in Railway dashboard
3. Railway auto-detects Node.js via `package.json`
4. `railway.toml` configures:
   - Start command: `node index.js`
   - Health check: `GET /health`
   - Restart policy: on failure, max 3 retries

**Post-Deploy**:
- Copy Railway public URL
- Set as `SERVER_URL` env var in Railway
- Configure WhatsApp webhook URL: `https://your-app.railway.app/webhook`
- Configure Razorpay webhook URL: `https://your-app.railway.app/razorpay/webhook`

---

## Code Style Preferences

- **No trailing semicolons** (enforced in existing code)
- **Async/await over promises** (no `.then()` chains)
- **Early returns** over nested conditionals
- **Concise variable names** in short functions (`req`, `msg`, `dist`)
- **Descriptive names** in long functions (`freshMatches`, `activeUser`)
- **Comments only for WHY, not WHAT** (e.g., "// Auto-expire in 10 minutes")

---

## Future Enhancement Ideas

1. **Multi-Language Support**: Detect user language from WhatsApp profile or initial message
2. **Flight API Integration**: Auto-populate arrival time from flight tracking APIs
3. **Admin Dashboard**: View active matches, support queue, analytics
4. **Referral System**: Reward users for inviting friends
5. **Dynamic Pricing**: Variable verification fee based on demand/supply
6. **Group Splits**: Support 3-4 person matches for larger vehicles
7. **In-App Ride Booking**: Integrate Uber/Ola API to book on behalf of users
8. **Post-Trip Rating**: Let users rate their split experience

---

This document should give you full context to understand, debug, and extend AasPass. When in doubt, read the code — it's intentionally kept simple and linear.
