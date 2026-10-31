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
  kind       text not null check (kind in ('cast','hit','banish','return','whisper','death','power','quest','portal','join','session')),
  from_id    text not null,
  to_id      text,
  power      text check (power is null or power in ('ganesha','hanuman','shiva','vishnu')),
  position   jsonb,
  text       text,
  duration_ms bigint check (duration_ms is null or duration_ms between 0 and 86400000),
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

-- Idempotent stats extension, also available as a standalone migration.
-- Additive, idempotent gameplay statistics. Only the backend may read this view.
begin;
alter table public.game_events add column if not exists duration_ms bigint
  check (duration_ms is null or duration_ms between 0 and 86400000);
alter table public.game_events drop constraint if exists game_events_kind_check;
alter table public.game_events add constraint game_events_kind_check
  check (kind in ('cast','hit','banish','return','whisper','death','power','quest','portal','join','session'));

create or replace view public.player_leaderboard with (security_invoker = true) as
select p.id, p.name,
  coalesce(s.kills, 0)::bigint as kills,
  coalesce(s.deaths, 0)::bigint as deaths,
  coalesce(s.joins, 0)::bigint as joins,
  floor(coalesce(s.play_ms, 0) / 1000.0)::bigint as time_seconds
from public.players p
left join (
  select from_id,
    count(*) filter (where kind = 'banish') as kills,
    count(*) filter (where kind = 'death') as deaths,
    count(*) filter (where kind = 'join') as joins,
    sum(duration_ms) filter (where kind = 'session') as play_ms
  from public.game_events group by from_id
) s on s.from_id = p.id;
revoke all on public.player_leaderboard from public, anon, authenticated;
grant select on public.player_leaderboard to service_role;
commit;
