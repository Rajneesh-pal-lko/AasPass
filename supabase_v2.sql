-- ============================================================
-- AasPass v2 Schema Additions
-- Run this in Supabase SQL Editor AFTER supabase_schema.sql
-- and supabase_messages.sql have been applied.
-- ============================================================

-- ── 1. New columns on users ───────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS name              TEXT,
  ADD COLUMN IF NOT EXISTS gender            TEXT,          -- 'M' | 'F' | 'NB'
  ADD COLUMN IF NOT EXISTS preferred_gender  TEXT,          -- 'M' | 'F' | 'ANY'
  ADD COLUMN IF NOT EXISTS pickup_label      TEXT,          -- geocoded pickup name
  ADD COLUMN IF NOT EXISTS drop_label        TEXT,          -- geocoded drop name
  ADD COLUMN IF NOT EXISTS search_started_at TIMESTAMPTZ,  -- when WAITING began
  ADD COLUMN IF NOT EXISTS pending_rating    SMALLINT;      -- temp: rating being submitted

-- ── 2. New columns on match_requests ─────────────────────────────────────────

ALTER TABLE match_requests
  ADD COLUMN IF NOT EXISTS a_shared_contact BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS b_shared_contact BOOLEAN DEFAULT FALSE;

-- ── 3. New columns on user_profiles ──────────────────────────────────────────

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS name            TEXT,
  ADD COLUMN IF NOT EXISTS gender          TEXT,
  ADD COLUMN IF NOT EXISTS preferred_gender TEXT,
  ADD COLUMN IF NOT EXISTS avg_rating      NUMERIC(3,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_ratings   INTEGER DEFAULT 0;

-- ── 4. blocked_users table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blocked_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  blocked_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker ON blocked_users(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked ON blocked_users(blocked_id);

-- ── 5. reviews table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reviews (
  review_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reviewee_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  match_id     UUID REFERENCES match_requests(request_id) ON DELETE SET NULL,
  rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  feedback     TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(reviewer_id, match_id)  -- one review per match per reviewer
);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);

-- ── 6. Helper function: update avg_rating on user_profiles ───────────────────

CREATE OR REPLACE FUNCTION update_avg_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE user_profiles
  SET
    avg_rating    = (SELECT ROUND(AVG(rating)::NUMERIC, 2) FROM reviews WHERE reviewee_id = NEW.reviewee_id),
    total_ratings = (SELECT COUNT(*) FROM reviews WHERE reviewee_id = NEW.reviewee_id)
  WHERE phone = (SELECT phone FROM users WHERE user_id = NEW.reviewee_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_avg_rating ON reviews;
CREATE TRIGGER trg_update_avg_rating
  AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_avg_rating();

-- ── 7. Index for faster gender-filtered matching ──────────────────────────────

CREATE INDEX IF NOT EXISTS idx_users_matching
  ON users(is_active, is_matched, state, gender, preferred_gender);
