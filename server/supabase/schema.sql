-- Issekaied canonical gameplay store. Apply once to the isolated Supabase project (coordinator-owned).
-- The game server writes with the project's secret/service key; no anon policies exist, so browsers
-- cannot read these tables directly. Movement packets are never stored, only gameplay events.

create table if not exists players (
  id         text primary key,                 -- sha256(guest key) prefix; the guest key itself never leaves the server
  name       text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create table if not exists game_events (
  event_id   text primary key,                 -- unique per event; duplicate deliveries are ignored on conflict
  room_id    text not null,
  tick       integer not null,
  kind       text not null check (kind in ('cast','hit','banish','return','whisper','death','power','quest','portal')),
  from_id    text not null,
  to_id      text,
  power      text check (power is null or power in ('ganesha','hanuman','shiva','vishnu')),
  position   jsonb,
  text       text,
  created_at timestamptz not null default now()
);
create index if not exists game_events_from_idx on game_events (from_id, created_at desc);
create index if not exists game_events_to_idx   on game_events (to_id, created_at desc);
create index if not exists game_events_room_idx on game_events (room_id, created_at desc);

create table if not exists lore (
  id         uuid primary key default gen_random_uuid(),
  room_id    text not null,
  subject_id text not null,                    -- ghost or deity the entry is about
  title      text not null,
  body       text not null,
  event_ids  text[] not null default '{}',     -- game events the lore is grounded in
  created_at timestamptz not null default now(),
  fts        tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored
);
create index if not exists lore_fts_idx on lore using gin (fts);
create index if not exists lore_subject_idx on lore (subject_id, created_at desc);

alter table players     enable row level security;
alter table game_events enable row level security;
alter table lore        enable row level security;
