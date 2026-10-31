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
