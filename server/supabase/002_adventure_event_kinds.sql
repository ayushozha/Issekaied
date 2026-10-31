-- Extend canonical event kinds without removing any history or changing RLS.
begin; alter table public.game_events drop constraint if exists game_events_kind_check; alter table public.game_events add constraint game_events_kind_check check (kind in ('cast','hit','banish','return','whisper','death','power','quest','portal')); commit;
