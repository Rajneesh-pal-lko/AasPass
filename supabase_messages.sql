-- Run this in Supabase SQL Editor (separate from main schema)

-- ── message_logs ──────────────────────────────────────────────────────────────
create table if not exists message_logs (
  id              uuid primary key default gen_random_uuid(),
  phone           text not null,
  direction       text not null check (direction in ('incoming', 'outgoing')),
  message_type    text,
  message_text    text,
  raw_payload     jsonb,
  user_state      text,
  created_at      timestamptz not null default now()
);

create index if not exists idx_message_logs_phone      on message_logs(phone);
create index if not exists idx_message_logs_created_at on message_logs(created_at desc);

-- ── user_profiles ─────────────────────────────────────────────────────────────
create table if not exists user_profiles (
  phone           text primary key,
  wa_name         text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  message_count   int default 0,
  raw_profile     jsonb
);

-- Auto-clear message_logs older than 6 months (run manually or via pg_cron)
-- delete from message_logs where created_at < now() - interval '6 months';
