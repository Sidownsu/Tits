-- ═══════════════════════════════════════════════════════════════════════════
-- NIM TTS Bot — initial schema
--
-- Design notes:
--  • Discord snowflakes are stored as TEXT, not BIGINT. They exceed 2^53 and
--    round-trip through JavaScript incorrectly as numbers.
--  • The bot connects with the service_role key and is the only writer, so RLS
--    policies exist to lock out anon/authenticated clients (e.g. a future web
--    dashboard using the publishable key), not to gate the bot itself.
--  • Voice preferences are expressed on Magpie's real axes — locale, speaker,
--    emotion — because that is what the model actually supports.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Users ────────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id                  text primary key,              -- Discord user snowflake
  username            text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Voice preferences (Magpie axes)
  locale              text not null default 'en-US',
  speaker             text not null default 'Mia',
  emotion             text not null default 'Neutral',

  -- Playback shaping, applied in ffmpeg post-processing rather than by the
  -- model: Magpie exposes no rate/pitch controls of its own.
  speed               numeric(3,2) not null default 1.00 check (speed between 0.50 and 2.00),
  pitch_semitones     smallint     not null default 0   check (pitch_semitones between -12 and 12),
  volume              numeric(3,2) not null default 1.00 check (volume between 0.00 and 2.00),

  -- Behaviour toggles
  read_urls           boolean not null default false,
  read_emoji          boolean not null default true,
  nsfw_filter         boolean not null default true,
  auto_join           boolean not null default false,

  -- Nickname the bot uses when announcing this user, if the guild enables it.
  spoken_name         text
);

comment on column public.users.speed is
  'Playback rate applied post-synthesis via ffmpeg atempo, not a model parameter.';

-- ─── Guilds ───────────────────────────────────────────────────────────────────
create table if not exists public.guilds (
  id                    text primary key,            -- Discord guild snowflake
  name                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Text channel the bot reads from, and whether it reads all messages there.
  tts_channel_id        text,
  read_all_messages     boolean not null default true,
  -- When read_all_messages is false, only /tts and /speak produce audio.

  announce_speaker      boolean not null default false,  -- "Alice says: …"
  max_message_chars     integer not null default 500 check (max_message_chars between 1 and 5000),
  user_cooldown_ms      integer not null default 2000 check (user_cooldown_ms >= 0),
  auto_leave_seconds    integer not null default 300 check (auto_leave_seconds >= 0),

  -- Default voice for users who have not set one.
  default_locale        text not null default 'en-US',
  default_speaker       text not null default 'Mia',
  default_emotion       text not null default 'Neutral',

  is_premium            boolean not null default false
);

-- Ignore lists. One row per ignored entity keeps this queryable and indexable,
-- which an array column would not be.
create table if not exists public.guild_ignores (
  guild_id    text not null references public.guilds(id) on delete cascade,
  entity_type text not null check (entity_type in ('channel', 'role', 'user')),
  entity_id   text not null,
  created_at  timestamptz not null default now(),
  primary key (guild_id, entity_type, entity_id)
);

-- ─── Saved voice profiles ─────────────────────────────────────────────────────
-- A user can keep several named presets and switch between them.
create table if not exists public.voice_profiles (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null references public.users(id) on delete cascade,
  name        text not null,
  locale      text not null,
  speaker     text not null,
  emotion     text not null,
  speed       numeric(3,2) not null default 1.00,
  pitch_semitones smallint not null default 0,
  volume      numeric(3,2) not null default 1.00,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- ─── Favourites ───────────────────────────────────────────────────────────────
create table if not exists public.favorites (
  user_id    text not null references public.users(id) on delete cascade,
  voice_name text not null,                          -- full Riva voice name
  created_at timestamptz not null default now(),
  primary key (user_id, voice_name)
);

-- ─── History ──────────────────────────────────────────────────────────────────
create table if not exists public.voice_history (
  id          bigserial primary key,
  user_id     text not null references public.users(id) on delete cascade,
  guild_id    text references public.guilds(id) on delete set null,
  text        text not null,
  voice_name  text not null,
  cached      boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ─── Pronunciation overrides ──────────────────────────────────────────────────
-- scope_type distinguishes a user's personal dictionary from a guild-wide one.
create table if not exists public.pronunciations (
  id          uuid primary key default gen_random_uuid(),
  scope_type  text not null check (scope_type in ('user', 'guild')),
  scope_id    text not null,
  from_text   text not null,
  to_text     text not null,
  created_at  timestamptz not null default now(),
  unique (scope_type, scope_id, from_text)
);

-- ─── Usage + API telemetry ────────────────────────────────────────────────────
create table if not exists public.usage_logs (
  id            bigserial primary key,
  user_id       text,
  guild_id      text,
  voice_name    text,
  char_count    integer not null default 0,
  chunk_count   integer not null default 1,
  cache_hit     boolean not null default false,
  latency_ms    integer,
  success       boolean not null default true,
  error_kind    text,
  created_at    timestamptz not null default now()
);

-- Per-key request accounting, aggregated hourly by the stats job.
create table if not exists public.api_usage (
  id             bigserial primary key,
  key_id         text not null,                      -- 'key-1' … never the secret
  bucket_start   timestamptz not null,               -- hour bucket
  requests       integer not null default 0,
  successes      integer not null default 0,
  failures       integer not null default 0,
  rate_limited   integer not null default 0,
  avg_latency_ms integer,
  unique (key_id, bucket_start)
);

-- ─── Premium ──────────────────────────────────────────────────────────────────
create table if not exists public.premium (
  subject_type text not null check (subject_type in ('user', 'guild')),
  subject_id   text not null,
  tier         text not null default 'plus' check (tier in ('plus', 'pro')),
  granted_at   timestamptz not null default now(),
  expires_at   timestamptz,
  note         text,
  primary key (subject_type, subject_id)
);

-- ─── Blacklist ────────────────────────────────────────────────────────────────
create table if not exists public.blacklist (
  subject_type text not null check (subject_type in ('user', 'guild')),
  subject_id   text not null,
  reason       text,
  created_at   timestamptz not null default now(),
  primary key (subject_type, subject_id)
);

-- ─── Daily analytics rollup ───────────────────────────────────────────────────
create table if not exists public.analytics_daily (
  day             date not null,
  guild_id        text not null default 'global',
  requests        integer not null default 0,
  cache_hits      integer not null default 0,
  failures        integer not null default 0,
  chars_spoken    bigint  not null default 0,
  unique_users    integer not null default 0,
  avg_latency_ms  integer,
  primary key (day, guild_id)
);

-- ─── Voice sessions ───────────────────────────────────────────────────────────
create table if not exists public.sessions (
  id                uuid primary key default gen_random_uuid(),
  guild_id          text not null,
  voice_channel_id  text not null,
  text_channel_id   text,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  messages_spoken   integer not null default 0
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════════════════════════════════
create index if not exists idx_voice_history_user_created
  on public.voice_history (user_id, created_at desc);
create index if not exists idx_voice_history_guild_created
  on public.voice_history (guild_id, created_at desc);

create index if not exists idx_usage_logs_created
  on public.usage_logs (created_at desc);
create index if not exists idx_usage_logs_guild_created
  on public.usage_logs (guild_id, created_at desc);
create index if not exists idx_usage_logs_voice
  on public.usage_logs (voice_name);

create index if not exists idx_api_usage_bucket
  on public.api_usage (bucket_start desc);

create index if not exists idx_guild_ignores_lookup
  on public.guild_ignores (guild_id, entity_type);

create index if not exists idx_pronunciations_scope
  on public.pronunciations (scope_type, scope_id);

create index if not exists idx_sessions_guild_active
  on public.sessions (guild_id) where ended_at is null;

create index if not exists idx_premium_expiry
  on public.premium (expires_at) where expires_at is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- updated_at maintenance
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_touch_updated_at on public.users;
create trigger users_touch_updated_at
  before update on public.users
  for each row execute function public.touch_updated_at();

drop trigger if exists guilds_touch_updated_at on public.guilds;
create trigger guilds_touch_updated_at
  before update on public.guilds
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security
--
-- The bot uses the service_role key, which bypasses RLS entirely. Enabling RLS
-- with no permissive policy therefore means: the bot works, and anon /
-- authenticated clients (a future dashboard, a leaked publishable key) can read
-- and write nothing. Add scoped policies here when the dashboard exists.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.users            enable row level security;
alter table public.guilds           enable row level security;
alter table public.guild_ignores    enable row level security;
alter table public.voice_profiles   enable row level security;
alter table public.favorites        enable row level security;
alter table public.voice_history    enable row level security;
alter table public.pronunciations   enable row level security;
alter table public.usage_logs       enable row level security;
alter table public.api_usage        enable row level security;
alter table public.premium          enable row level security;
alter table public.blacklist        enable row level security;
alter table public.analytics_daily  enable row level security;
alter table public.sessions         enable row level security;
