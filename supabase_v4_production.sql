-- ─────────────────────────────────────────────────────────────────────────────
-- AasPass — Production Hardening Migration (v4)
-- Run in Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Processing lock + confirmation fields on users ─────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_processing     boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lock_token        text,
  ADD COLUMN IF NOT EXISTS lock_acquired_at  timestamptz,
  ADD COLUMN IF NOT EXISTS pending_llm_action text;  -- stores action awaiting confirmation

-- ── 2. Duplicate webhook detection ───────────────────────────────────────────
-- Stores every processed WhatsApp message_id.
-- Prevents Meta retry duplicates from re-running business logic.
CREATE TABLE IF NOT EXISTS processed_webhooks (
  message_id   text        PRIMARY KEY,
  phone        text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_processed_webhooks_time ON processed_webhooks(processed_at);

-- ── 3. Pending message queue ──────────────────────────────────────────────────
-- When a user is locked (already being processed), incoming messages are queued
-- here instead of being dropped. Processed FIFO after the active lock releases.
CREATE TABLE IF NOT EXISTS pending_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text        NOT NULL,
  message_id  text        NOT NULL UNIQUE,
  wa_name     text,
  raw_payload jsonb       NOT NULL,
  arrived_at  timestamptz NOT NULL DEFAULT now(),
  status      text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'done', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_pending_messages_queue
  ON pending_messages(phone, status, arrived_at)
  WHERE status = 'pending';

-- ── 4. Persistent geocode cache ───────────────────────────────────────────────
-- Survives container restarts (unlike in-memory Map).
-- Keyed by normalised query string.
CREATE TABLE IF NOT EXISTS geocode_cache (
  query_key  text        PRIMARY KEY,   -- normalised lowercase trimmed query
  results    jsonb       NOT NULL,      -- array of {lat, lon, label}
  cached_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_geocode_cache_time ON geocode_cache(cached_at);

-- ── 5. Stale lock recovery function ──────────────────────────────────────────
-- Called by the cleanup cron to unstick crashed processors.
CREATE OR REPLACE FUNCTION reset_stale_locks(max_age_seconds integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE released integer;
BEGIN
  UPDATE users
  SET is_processing    = false,
      lock_token       = null,
      lock_acquired_at = null
  WHERE is_processing = true
    AND lock_acquired_at < now() - (max_age_seconds || ' seconds')::interval;
  GET DIAGNOSTICS released = ROW_COUNT;
  RETURN released;
END;
$$;

-- ── 6. Cleanup old processed_webhooks (keep 24 hours) ────────────────────────
CREATE OR REPLACE FUNCTION cleanup_old_webhooks()
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE deleted integer;
BEGIN
  DELETE FROM processed_webhooks
  WHERE processed_at < now() - interval '24 hours';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- ── 7. Cleanup stale pending_messages (keep 2 hours) ─────────────────────────
CREATE OR REPLACE FUNCTION cleanup_pending_messages()
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE deleted integer;
BEGIN
  UPDATE pending_messages
  SET status = 'failed'
  WHERE status = 'pending'
    AND arrived_at < now() - interval '2 hours';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
