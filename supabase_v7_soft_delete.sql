-- ─────────────────────────────────────────────────────────────────────────────
-- AasPass — Soft Delete Migration (v7)
-- Run in Supabase SQL Editor on BOTH staging and production before deploying
-- ─────────────────────────────────────────────────────────────────────────────

-- Tracks when a user requested account deletion.
-- NULL = active. Timestamp = deactivated (data preserved, account soft-deleted).
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ── Done ─────────────────────────────────────────────────────────────────────
-- After running, verify:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'users' AND column_name = 'deleted_at';
-- Should return 1 row.
