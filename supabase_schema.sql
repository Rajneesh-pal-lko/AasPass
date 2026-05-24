-- Run this in the Supabase SQL Editor

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ── users ────────────────────────────────────────────────────────────────────
create table if not exists users (
  user_id          uuid primary key default gen_random_uuid(),
  phone            text unique not null,
  flight_number    text,
  arrival_time     text,
  departure_airport text,
  departure_lat    float,
  departure_long   float,
  drop_zone        text,
  drop_lat         float,
  drop_long        float,
  city_preference  text,
  state            text not null default 'IDLE',
  is_matched       boolean not null default false,
  is_active        boolean not null default false,
  payment_verified boolean not null default false,
  matched_with     uuid references users(user_id),
  pending_request_id uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_users_phone         on users(phone);
create index if not exists idx_users_flight_active on users(flight_number, is_active, is_matched);

-- ── match_requests ────────────────────────────────────────────────────────────
create table if not exists match_requests (
  request_id      uuid primary key default gen_random_uuid(),
  from_user       uuid not null references users(user_id),
  to_user         uuid not null references users(user_id),
  distance_km     float,
  status          text not null default 'pending'
                  check (status in (
                    'pending','accepted','declined',
                    'cancelled_by_sender','cancelled_by_receiver',
                    'cancelled_after_accept','expired','completed'
                  )),
  cancelled_by    uuid references users(user_id),
  cancelled_at    timestamptz,
  confirmed_by    uuid references users(user_id),
  confirmed_at    timestamptz,
  issue_reported  boolean default false,
  issue_type      text,
  created_at      timestamptz not null default now(),
  responded_at    timestamptz
);

create index if not exists idx_match_requests_from on match_requests(from_user, status);
create index if not exists idx_match_requests_to   on match_requests(to_user, status);

-- ── confirmed_matches ─────────────────────────────────────────────────────────
create table if not exists confirmed_matches (
  match_id        uuid primary key default gen_random_uuid(),
  user_a          uuid not null references users(user_id),
  user_b          uuid not null references users(user_id),
  flight_number   text,
  distance_km     float,
  confirmed_at    timestamptz not null default now()
);

-- ── support_queue ─────────────────────────────────────────────────────────────
create table if not exists support_queue (
  issue_id        uuid primary key default gen_random_uuid(),
  user_id         uuid references users(user_id),
  match_id        uuid references match_requests(request_id),
  issue_type      text,
  description     text,
  created_at      timestamptz not null default now(),
  resolved        boolean not null default false
);

-- ── message_buffer ────────────────────────────────────────────────────────────
-- Debounce buffer: aggregates rapid text messages before FSM processing.
-- One row per phone. Interactive/location messages bypass this table entirely.
create table if not exists message_buffer (
  phone            text primary key,
  buffer_text      text    not null default '',
  wa_name          text,
  first_message_at timestamptz not null default now(),
  last_message_at  timestamptz not null default now(),
  flush_after      timestamptz not null default now(),
  status           text    not null default 'BUFFERING'
                   check (status in ('BUFFERING', 'PROCESSING'))
);

-- Partial index: worker only scans BUFFERING rows — keeps polling virtually free
create index if not exists idx_message_buffer_flush
  on message_buffer (flush_after)
  where status = 'BUFFERING';

-- ── RPC: buffer_incoming_message ──────────────────────────────────────────────
-- Append-UPSERT a text message. On conflict resets flush window and re-buffers,
-- even if a worker had claimed the row (status reset to BUFFERING is safe because
-- the worker's DELETE uses WHERE status = 'PROCESSING' — it won't clobber new data).
create or replace function buffer_incoming_message(
  p_phone    text,
  p_text     text,
  p_wa_name  text,
  p_flush_ms int default 1500
)
returns void
language plpgsql
as $$
begin
  insert into message_buffer (phone, buffer_text, wa_name, flush_after)
  values (
    p_phone,
    p_text,
    p_wa_name,
    now() + (p_flush_ms || ' milliseconds')::interval
  )
  on conflict (phone) do update set
    buffer_text     = case
                        when message_buffer.buffer_text = '' then excluded.buffer_text
                        else message_buffer.buffer_text || E'\n' || excluded.buffer_text
                      end,
    wa_name         = excluded.wa_name,
    last_message_at = now(),
    flush_after     = now() + (p_flush_ms || ' milliseconds')::interval,
    status          = 'BUFFERING';
end;
$$;

-- ── RPC: claim_ready_buffer_row ───────────────────────────────────────────────
-- Atomically claims one BUFFERING row whose flush window has elapsed.
-- FOR UPDATE SKIP LOCKED prevents convoy: concurrent workers skip each other.
create or replace function claim_ready_buffer_row()
returns setof message_buffer
language plpgsql
as $$
begin
  return query
    update message_buffer
    set status = 'PROCESSING'
    where phone = (
      select phone
      from   message_buffer
      where  status = 'BUFFERING'
        and  flush_after <= now()
      order  by flush_after
      limit  1
      for update skip locked
    )
    returning *;
end;
$$;

-- ── RPC: cleanup_stale_buffer_rows ───────────────────────────────────────────
-- Crash recovery: delete PROCESSING rows older than max_age_seconds.
-- Called by the 10-minute cron. A row stuck in PROCESSING means the worker
-- crashed mid-flight before the finally block could delete it.
create or replace function cleanup_stale_buffer_rows(max_age_seconds int default 60)
returns int
language plpgsql
as $$
declare
  deleted_count int;
begin
  delete from message_buffer
  where  status = 'PROCESSING'
    and  last_message_at < now() - (max_age_seconds || ' seconds')::interval;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
