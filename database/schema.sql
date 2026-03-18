-- ============================================================
-- CareX Platform — Supabase Database Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ============================================================

-- ─── Extensions ──────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ─── PROVIDERS ───────────────────────────────────────────────
create table providers (
  id                    uuid primary key default uuid_generate_v4(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Identity
  name                  text not null,
  email                 text not null unique,
  phone                 text,
  npi_number            text unique,          -- National Provider Identifier
  specialty_type        text not null default 'primary_care',
  location_zip          text,
  location_lat          numeric(9,6),
  location_lng          numeric(9,6),

  -- Capacity config
  daily_patient_max     int  not null default 15,
  slot_duration_mins    int  not null default 30,
  buffer_mins           int  not null default 10,
  working_hours_start   int  not null default 8,   -- 8am
  working_hours_end     int  not null default 18,  -- 6pm
  working_days          int[] not null default '{1,2,3,4,5}', -- Mon–Fri

  -- Agent config
  agent_status          text not null default 'inactive'
                        check (agent_status in ('inactive','running','paused')),
  watch_mode            text not null default 'suggest'
                        check (watch_mode in ('off','suggest','auto_with_veto','full_auto')),
  veto_window_secs      int  not null default 90,
  enabled_sources       text[] not null default '{"calendar_google"}',
  max_marketplace_slots int  not null default 3,
  min_lead_time_hours   int  not null default 1,

  -- Calendar OAuth (tokens stored encrypted)
  calendar_type         text check (calendar_type in ('google','microsoft','none')),
  calendar_connected_at timestamptz,
  calendar_token_enc    text,                 -- AES-256 encrypted token JSON
  calendar_scopes       text[],

  -- Insurance
  insurance_accepted    text[] not null default '{"all"}',

  -- Status
  is_active             boolean not null default true,
  is_marketplace_visible boolean not null default false,
  marketplace_slots_today int not null default 0,
  last_signal_at        timestamptz,
  signal_count          int not null default 0,

  -- BAA
  baa_signed_at         timestamptz,
  baa_version           text
);

-- ─── PROVIDER STANDING RULES ─────────────────────────────────
create table provider_standing_rules (
  id                       uuid primary key default uuid_generate_v4(),
  provider_id              uuid not null references providers(id) on delete cascade,
  updated_at               timestamptz not null default now(),

  automation_level         text not null default 'suggest'
                           check (automation_level in ('off','suggest','auto_with_veto','full_auto')),
  auto_open_unused_slots   boolean not null default false,
  open_slots_after_hours   int     not null default 2,
  max_marketplace_slots_day int    not null default 3,
  min_lead_time_hours      int     not null default 1,

  accept_new_patients      boolean not null default true,
  accept_follow_ups        boolean not null default true,
  accept_urgent_same_day   boolean not null default true,
  insurance_filter         text    not null default 'all',

  notify_on_gap            boolean not null default true,
  notify_threshold_pct     int     not null default 30,
  notify_via_push          boolean not null default true,
  notify_via_sms           boolean not null default false,

  unique (provider_id)
);

-- ─── PATIENTS ────────────────────────────────────────────────
-- PHI stored encrypted. Linked to anonymous tokens used by engines.
create table patients (
  id                uuid primary key default uuid_generate_v4(),
  created_at        timestamptz not null default now(),

  -- PHI fields (encrypted at rest via Supabase Vault in production)
  name_enc          text,           -- Encrypted
  email_enc         text,           -- Encrypted
  phone_enc         text,           -- Encrypted
  dob_enc           text,           -- Encrypted
  address_enc       text,           -- Encrypted

  -- Safe non-PHI fields (used for matching)
  patient_token     text not null unique,   -- Anonymous token used by AI engines
  zip_code          text,
  insurance_type    text,
  insurance_member_id_hash text,            -- Hashed — not raw
  location_lat      numeric(9,6),
  location_lng      numeric(9,6),

  -- Preferences
  specialty_needed  text,
  urgency_score     numeric(3,2) default 0.50,
  is_new_patient    boolean default true,
  preferred_days    int[],
  preferred_times   text[],

  -- Status
  is_active         boolean not null default true,
  waitlist_since    timestamptz,
  last_booking_at   timestamptz
);

-- ─── SLOTS ───────────────────────────────────────────────────
create table slots (
  id                uuid primary key default uuid_generate_v4(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  provider_id       uuid not null references providers(id) on delete cascade,
  external_event_id text,                -- Google/Microsoft calendar event ID

  slot_start        timestamptz not null,
  slot_end          timestamptz not null,

  status            text not null default 'available'
                    check (status in (
                      'available',      -- Open, no patient
                      'marketplace',    -- Listed in marketplace
                      'reserved',       -- Soft-reserved (5 min TTL)
                      'booked',         -- Confirmed booking
                      'cancelled',      -- Cancelled by patient
                      'no_show',        -- Patient no-showed
                      'completed',      -- Visit completed
                      'blocked'         -- Provider blocked
                    )),

  -- Source of this slot opening
  source            text,   -- 'calendar_webhook' | 'email_agent' | 'sms_agent' | 'capacity_engine' | 'manual'

  -- Classification
  classification_type        text,    -- 'cancellation' | 'no_show' | 'new_opening' etc
  classification_confidence  numeric(4,3),
  classification_method      text,    -- 'rules' | 'ai'

  -- No-show prediction
  no_show_probability  numeric(4,3),
  no_show_risk_tier    text,

  -- Veto window
  veto_window_secs     int,
  veto_expires_at      timestamptz,
  vetoed_at            timestamptz,
  vetoed_by            uuid references providers(id),

  -- Assignment
  patient_token        text,          -- Anonymous token — no PHI
  auto_assigned        boolean default false,
  assigned_at          timestamptz,
  booked_at            timestamptz,

  -- Marketplace
  marketplace_opened_at  timestamptz,
  marketplace_match_score numeric(4,3),

  -- Revenue
  revenue_estimate       numeric(8,2)
);

-- ─── WAITLIST ────────────────────────────────────────────────
create table waitlist (
  id               uuid primary key default uuid_generate_v4(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  patient_token    text not null,
  provider_id      uuid references providers(id),   -- null = any provider
  specialty_needed text,
  insurance_type   text,
  zip_code         text,
  urgency_score    numeric(3,2) not null default 0.50,

  -- Match criteria
  max_distance_miles int default 25,
  preferred_days     int[],
  preferred_times    text[],
  is_new_patient     boolean default true,

  -- Status
  status           text not null default 'waiting'
                   check (status in ('waiting','matched','booked','expired','withdrawn')),
  matched_slot_id  uuid references slots(id),
  matched_at       timestamptz,
  notified_at      timestamptz,
  expires_at       timestamptz default (now() + interval '30 days'),

  -- Position tracking
  position         int,
  wait_days        int generated always as (
    extract(day from (now() - created_at))::int
  ) stored
);

-- ─── BOOKINGS ────────────────────────────────────────────────
create table bookings (
  id               uuid primary key default uuid_generate_v4(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  slot_id          uuid not null references slots(id),
  provider_id      uuid not null references providers(id),
  patient_token    text not null,           -- No raw PHI stored here

  status           text not null default 'confirmed'
                   check (status in ('confirmed','cancelled','completed','no_show')),

  -- How it was booked
  booking_source   text,    -- 'auto_assign' | 'patient_self' | 'provider_manual'
  auto_assigned    boolean  default false,

  -- Confirmation
  confirmed_at     timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  completed_at     timestamptz,
  no_show_at       timestamptz,

  -- Revenue
  revenue_amount   numeric(8,2),
  insurance_type   text,

  -- Notifications sent
  patient_notified_at  timestamptz,
  provider_notified_at timestamptz
);

-- ─── CAPACITY REPORTS ────────────────────────────────────────
create table capacity_reports (
  id                  uuid primary key default uuid_generate_v4(),
  created_at          timestamptz not null default now(),

  provider_id         uuid not null references providers(id) on delete cascade,
  report_date         date not null,

  declared_daily_max  int,
  total_slots         int,
  booked_count        int,
  unused_count        int,
  future_gap_count    int,
  utilization_pct     int,
  gap_pct             int,
  gap_type            text,

  -- Revenue opportunity
  revenue_per_slot    numeric(8,2),
  revenue_total       numeric(10,2),
  revenue_monthly     numeric(12,2),

  -- Rules decision
  rules_action        text,
  slots_opened        int default 0,

  unique (provider_id, report_date)
);

-- ─── AUDIT LOG ───────────────────────────────────────────────
-- Append-only HIPAA audit trail — never update or delete rows
create table audit_log (
  id            bigint generated always as identity primary key,
  entry_id      text not null unique,
  created_at    timestamptz not null default now(),

  action        text not null,
  actor_id      text,
  actor_type    text,   -- 'provider' | 'patient' | 'agent' | 'system'
  resource_id   text,
  resource_type text,
  details       jsonb,
  outcome       text default 'success',
  reason        text,
  hash          text,   -- Tamper-evident hash of entry
  env           text
);

-- ─── PROVIDER NOTIFICATIONS ──────────────────────────────────
create table provider_notifications (
  id            uuid primary key default uuid_generate_v4(),
  created_at    timestamptz not null default now(),

  provider_id   uuid not null references providers(id) on delete cascade,
  type          text not null,    -- 'VETO_WINDOW_OPEN' | 'AUTO_CONFIRMED' | 'CAPACITY_GAP' etc
  message       text not null,
  payload       jsonb,

  -- Status
  sent_via      text[],           -- ['push', 'sms']
  read_at       timestamptz,
  acted_at      timestamptz,
  action_taken  text              -- 'vetoed' | 'confirmed' | 'ignored'
);

-- ─── INDEXES ─────────────────────────────────────────────────
-- Slots — most queried table
create index idx_slots_provider_status   on slots(provider_id, status);
create index idx_slots_start             on slots(slot_start);
create index idx_slots_marketplace       on slots(status, slot_start) where status = 'marketplace';
create index idx_slots_veto_expires      on slots(veto_expires_at)    where veto_expires_at is not null;
create index idx_slots_patient_token     on slots(patient_token)      where patient_token is not null;

-- Waitlist — matched frequently
create index idx_waitlist_status         on waitlist(status, created_at) where status = 'waiting';
create index idx_waitlist_patient        on waitlist(patient_token);
create index idx_waitlist_specialty      on waitlist(specialty_needed, insurance_type);

-- Bookings
create index idx_bookings_provider       on bookings(provider_id, created_at);
create index idx_bookings_patient        on bookings(patient_token);

-- Capacity reports
create index idx_capacity_provider_date  on capacity_reports(provider_id, report_date);

-- Audit log
create index idx_audit_actor             on audit_log(actor_id, created_at);
create index idx_audit_action            on audit_log(action, created_at);
create index idx_audit_resource          on audit_log(resource_id)     where resource_id is not null;

-- Notifications
create index idx_notifications_provider  on provider_notifications(provider_id, created_at);
create index idx_notifications_unread    on provider_notifications(provider_id, read_at) where read_at is null;

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────
-- Providers can only see their own data
alter table providers                enable row level security;
alter table provider_standing_rules  enable row level security;
alter table slots                    enable row level security;
alter table bookings                 enable row level security;
alter table capacity_reports         enable row level security;
alter table provider_notifications   enable row level security;

-- Provider policies (JWT sub = provider id)
create policy "providers_own_data" on providers
  for all using (auth.uid() = id);

create policy "providers_own_rules" on provider_standing_rules
  for all using (
    provider_id = auth.uid()
  );

create policy "providers_own_slots" on slots
  for all using (provider_id = auth.uid());

create policy "providers_own_bookings" on bookings
  for all using (provider_id = auth.uid());

create policy "providers_own_capacity" on capacity_reports
  for all using (provider_id = auth.uid());

create policy "providers_own_notifications" on provider_notifications
  for all using (provider_id = auth.uid());

-- Audit log: read-only for providers (their own records only)
alter table audit_log enable row level security;
create policy "audit_read_own" on audit_log
  for select using (actor_id = auth.uid()::text);

-- ─── UPDATED_AT TRIGGER ──────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_providers_updated
  before update on providers
  for each row execute function update_updated_at();

create trigger trg_slots_updated
  before update on slots
  for each row execute function update_updated_at();

create trigger trg_bookings_updated
  before update on bookings
  for each row execute function update_updated_at();

create trigger trg_waitlist_updated
  before update on waitlist
  for each row execute function update_updated_at();

-- ─── REALTIME ────────────────────────────────────────────────
-- Enable Supabase Realtime on tables the frontend needs live
alter publication supabase_realtime add table slots;
alter publication supabase_realtime add table provider_notifications;
alter publication supabase_realtime add table bookings;

-- ─── DAILY COUNTER RESET ─────────────────────────────────────
-- Resets marketplace_slots_today to 0 at midnight UTC
create or replace function reset_daily_counters()
returns void language plpgsql as $$
begin
  update providers set marketplace_slots_today = 0;
end;
$$;

-- Schedule via pg_cron (enable in Supabase Dashboard → Extensions)
-- select cron.schedule('reset-daily-counters', '0 0 * * *', 'select reset_daily_counters()');
