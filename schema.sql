-- ChitRagupt v2 : Neon Postgres schema
-- How to run: Neon console -> SQL Editor -> paste this whole file -> Run.
-- Safe to run more than once (uses IF NOT EXISTS).

-- 1. Businesses (one row per shop / account)
create table if not exists businesses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  owner_name    text,
  login_id      text not null,
  password_hash text not null,          -- bcrypt hash only, never plain text
  created_at    timestamptz not null default now()
);
-- login ids are case-insensitive and unique
create unique index if not exists businesses_login_id_uidx
  on businesses (lower(login_id));

-- 2. Business data: one JSON document per data key
--    keys: products, sales, expenses, customers, suppliers, payments,
--    supplierPayments, purchases, returns, held, gstAdjust, ledger, audit,
--    counters, settings, businessName, gstNumber, address, bizPhone
create table if not exists business_data (
  business_id uuid not null references businesses(id) on delete cascade,
  key         text not null,
  value       jsonb not null,
  version     integer not null default 1,   -- optimistic concurrency
  updated_at  timestamptz not null default now(),
  primary key (business_id, key)
);

-- 3. Translation cache (Google Translation API results)
create table if not exists translation_cache (
  hash        text not null,            -- sha256 of source text
  target_lang text not null,            -- e.g. hi, mr, gu
  source_text text not null,
  translated  text not null,
  created_at  timestamptz not null default now(),
  primary key (hash, target_lang)
);

-- 4. Monthly translation usage (hard cap to stay inside the free quota)
create table if not exists usage_counter (
  month text primary key,               -- e.g. 2026-11
  chars integer not null default 0
);

-- 5. Login rate limiting
create table if not exists login_attempts (
  id       bigserial primary key,
  login_id text not null,
  ip       text,
  at       timestamptz not null default now()
);
create index if not exists login_attempts_lookup_idx
  on login_attempts (lower(login_id), at desc);

-- Optional housekeeping (run now and then, or from a cron):
-- delete from login_attempts where at < now() - interval '1 day';
