-- ─────────────────────────────────────────────────────────────────────────────
-- AasPass — Admin Dashboard Migration (v5)
-- Run in Supabase SQL Editor on BOTH staging and production before deploying
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. pre_feedback_state column on users ────────────────────────────────────
-- Required for FEEDBACK command to restore user state after collecting feedback.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pre_feedback_state text;

-- ── 2. admin_audit_log table ──────────────────────────────────────────────────
-- Immutable log of all admin actions (deactivate, reset, broadcast, etc.)
-- Also used as a broadcast cooldown guard (checked before each broadcast).
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action       text        NOT NULL,
  target_phone text,
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
  ON admin_audit_log(action, created_at DESC);

-- ── 3. admin_analytics RPC ───────────────────────────────────────────────────
-- Single DB call for the Analytics tab. All aggregations done in PostgreSQL.
-- Usage: SELECT admin_analytics(30);
CREATE OR REPLACE FUNCTION admin_analytics(days int DEFAULT 30)
RETURNS json LANGUAGE plpgsql AS $$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'signups', (
      SELECT json_agg(row_to_json(t))
      FROM (
        SELECT DATE(created_at) AS date, COUNT(*)::int AS count
        FROM users
        WHERE created_at >= NOW() - (days || ' days')::interval
        GROUP BY DATE(created_at)
        ORDER BY date
      ) t
    ),
    'stateDistrib', (
      SELECT json_agg(row_to_json(t))
      FROM (
        SELECT state, COUNT(*)::int AS count
        FROM users
        GROUP BY state
        ORDER BY count DESC
      ) t
    ),
    'topDropZones', (
      SELECT json_agg(row_to_json(t))
      FROM (
        SELECT drop_zone AS zone, COUNT(*)::int AS count
        FROM users
        WHERE drop_zone IS NOT NULL
        GROUP BY drop_zone
        ORDER BY count DESC
        LIMIT 10
      ) t
    ),
    'funnel', json_build_object(
      'waiting',   (SELECT COUNT(*)::int FROM users WHERE state = 'WAITING' AND is_active = true),
      'requested', (SELECT COUNT(*)::int FROM match_requests WHERE status IN ('pending', 'accepted', 'completed')),
      'accepted',  (SELECT COUNT(*)::int FROM match_requests WHERE status IN ('accepted', 'completed')),
      'completed', (SELECT COUNT(*)::int FROM match_requests WHERE status = 'completed')
    )
  ) INTO result;
  RETURN result;
END;
$$;

-- ── Done ─────────────────────────────────────────────────────────────────────
-- After running this, also verify:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'users' AND column_name = 'pre_feedback_state';
-- Should return 1 row.
