-- ─────────────────────────────────────────────────────────────────────────────
-- AasPass — Referral & Reward System Migration (v6)
-- Run in Supabase SQL Editor on BOTH staging and production before deploying
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Referral + reward columns on users ────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code        text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by          text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reward_claimed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reward_upi           text;

CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by   ON users(referred_by);

-- ── 2. Daily reward cap tracker ──────────────────────────────────────────────
-- One row per calendar day. airport_claims increments each time a claim is
-- approved. Cap is enforced in app code (default 10/day).
CREATE TABLE IF NOT EXISTS daily_reward_claims (
  claim_date     date        PRIMARY KEY,
  airport_claims int         NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Reward claims log ─────────────────────────────────────────────────────
-- Immutable record of every ₹100 airport reward and ₹50 referral bonus.
-- Admin uses this table to process UPI payouts.
CREATE TABLE IF NOT EXISTS reward_claims (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          text        NOT NULL,
  referred_by    text,                          -- phone of the person who triggered referral bonus
  claim_type     text        NOT NULL CHECK (claim_type IN ('airport_reward', 'referral_bonus')),
  amount         int         NOT NULL,
  upi_id         text,
  ticket_received boolean    NOT NULL DEFAULT false,
  status         text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'rejected')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_reward_claims_phone  ON reward_claims(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_claims_status ON reward_claims(status, created_at DESC);

-- ── Done ─────────────────────────────────────────────────────────────────────
-- After running, verify:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'users'
--   AND column_name IN ('referral_code','referred_by','last_reward_claimed_at','reward_upi');
-- Should return 4 rows.
