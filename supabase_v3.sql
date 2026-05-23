-- ============================================================
-- AasPass v3 Schema — Run AFTER supabase_v2.sql
-- ============================================================

-- ── 1. expires_at on users (replaces cron time arithmetic) ───────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- ── 2. Partial unique index: only ONE pending request per sender ──────────────
--    Allows unlimited historical (completed/declined/expired) requests.
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request_per_user
  ON match_requests (from_user)
  WHERE status = 'pending';

-- ── 3. SELECT FOR UPDATE helper — atomic match acceptance ────────────────────
--    Called via supabase.rpc('accept_match_request', { p_request_id, p_to_user_id })
--    Returns { success, error? }
CREATE OR REPLACE FUNCTION accept_match_request(
  p_request_id  UUID,
  p_to_user_id  UUID
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_req  match_requests;
BEGIN
  -- Lock the row so no two concurrent accepts race
  SELECT * INTO v_req
  FROM match_requests
  WHERE request_id = p_request_id
    AND status     = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'request_gone');
  END IF;

  -- Mark accepted
  UPDATE match_requests
     SET status       = 'accepted',
         responded_at = NOW()
   WHERE request_id   = p_request_id;

  -- Mark both users as matched
  UPDATE users
     SET is_matched  = true,
         matched_with = v_req.from_user,
         state        = 'MATCHED',
         updated_at   = NOW()
   WHERE user_id = p_to_user_id;

  UPDATE users
     SET is_matched  = true,
         matched_with = p_to_user_id,
         state        = 'MATCHED',
         updated_at   = NOW()
   WHERE user_id = v_req.from_user;

  -- Log confirmed match
  INSERT INTO confirmed_matches (user_a, user_b, distance_km, confirmed_at)
  VALUES (v_req.from_user, p_to_user_id, v_req.distance_km, NOW())
  ON CONFLICT DO NOTHING;

  RETURN json_build_object('success', true);
END;
$$;
