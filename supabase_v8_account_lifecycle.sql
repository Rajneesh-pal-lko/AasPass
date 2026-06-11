-- ─────────────────────────────────────────────────────────────────────────────
-- AasPass — Account Lifecycle Migration (v8)
-- Run in Supabase SQL Editor on BOTH staging and production before deploying
-- ─────────────────────────────────────────────────────────────────────────────

-- Tracks when a user explicitly unsubscribed (deactivated account).
ALTER TABLE users ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;

-- Tracks when a user requested permanent data deletion (30-day hold).
-- After 30 days a cron job anonymises the row. NULL = no deletion requested.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_users_deletion_requested
  ON users(deletion_requested_at)
  WHERE deletion_requested_at IS NOT NULL;

-- ── Done ─────────────────────────────────────────────────────────────────────
-- Verify:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'users'
--   AND column_name IN ('unsubscribed_at', 'deletion_requested_at');
-- Should return 2 rows.
