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
