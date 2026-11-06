-- Team calendar: event kinds, who takes part, tasks blocked into time, Google Calendar two-way sync,
-- and each partner's busy times read from her personal Google calendars.

-- 1. Richer events.
alter table meetings
  add column kind             text not null default 'meeting'
    check (kind in ('meeting', 'focus', 'away')),      -- meeting / work block / not available
  add column partner_ids      uuid[] not null default '{}', -- who takes part; empty = both of us
  add column task_id          uuid references tasks (id) on delete set null, -- a task blocked into time
  add column all_day          boolean not null default false,
  add column meet_link        text,
  add column want_meet        boolean not null default false, -- ask Google for a Meet link on the next push
  add column followed_up_at   timestamptz,                  -- the bot asked "how did it go?"
  add column google_synced_at timestamptz,                  -- set only by the sync itself
  add column needs_push       boolean not null default true;
create unique index meetings_google_event_id_key on meetings (google_event_id) where google_event_id is not null;
create index on meetings (needs_push) where needs_push;

-- Any change made by a person (app or bot) marks the row for push to Google.
-- The sync marks its own writes by changing google_synced_at, so they never bounce back.
create or replace function meetings_mark_dirty() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.needs_push := new.google_synced_at is null;
  elsif new.google_synced_at is not distinct from old.google_synced_at then
    new.needs_push := true;
  end if;
  return new;
end $$;
create trigger meetings_mark_dirty before insert or update on meetings
  for each row execute function meetings_mark_dirty();

-- Deleting an event here deletes it in Google too (picked up by the next sync run).
create table calendar_outbox (
  id              bigint generated always as identity primary key,
  google_event_id text not null,
  created_at      timestamptz not null default now()
);
create or replace function meetings_queue_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.google_event_id is not null and current_setting('arli.sync_delete', true) is distinct from 'on' then
    insert into calendar_outbox (google_event_id) values (old.google_event_id);
  end if;
  return old;
end $$;
create trigger meetings_queue_delete after delete on meetings
  for each row execute function meetings_queue_delete();

-- The sync removes events that were deleted in Google without queueing them back.
create or replace function calendar_delete_synced(event_ids text[]) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform set_config('arli.sync_delete', 'on', true);
  delete from meetings where google_event_id = any (event_ids);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function calendar_delete_synced(text[]) from public, anon, authenticated;

-- 2. Busy blocks from each partner's personal Google calendars (times only, never titles).
create table partner_busy (
  partner_id uuid not null references partners (id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  primary key (partner_id, starts_at, ends_at)
);
create index on partner_busy (starts_at);

-- 3. Google connection: remember which permissions each partner granted.
alter table gmail_accounts add column scopes text not null default 'https://www.googleapis.com/auth/gmail.readonly';

-- What the app may show about the connection (no tokens).
create view google_connections with (security_invoker = false) as
  select g.partner_id, g.email, g.connected_at,
         g.scopes like '%auth/calendar%' as calendar
  from gmail_accounts g
  where is_partner();
grant select on google_connections to authenticated;

create view calendar_sync_status with (security_invoker = false) as
  select max(value) filter (where key = 'gcal_calendar_id')  as calendar_id,
         max(value) filter (where key = 'gcal_last_pull')    as last_pull,
         max(value) filter (where key = 'gcal_last_error')   as last_error,
         (select count(*) from meetings where needs_push)      as pending
  from app_config
  where is_partner() and key like 'gcal_%';
grant select on calendar_sync_status to authenticated;

alter table calendar_outbox enable row level security;
alter table partner_busy    enable row level security;
create policy partners_only on partner_busy for all to authenticated using (is_partner()) with check (is_partner());

-- Existing events go to Google on the first sync.
update meetings set needs_push = true;

-- 4. Joint free time.
-- The time an event really takes: all-day events cover whole Israel days.
create or replace function meeting_span(m meetings) returns tstzrange
language sql immutable set search_path = public as $$
  select case when m.all_day then
    tstzrange(((m.starts_at at time zone 'Asia/Jerusalem')::date)::timestamp at time zone 'Asia/Jerusalem',
              (((coalesce(m.ends_at, m.starts_at) at time zone 'Asia/Jerusalem')::date + 1))::timestamp at time zone 'Asia/Jerusalem')
  else tstzrange(m.starts_at, greatest(coalesce(m.ends_at, m.starts_at + interval '1 hour'), m.starts_at + interval '1 minute')) end
$$;

-- Work hours are Sunday to Thursday, 09:00 to 18:00 Israel time
-- (Friday until 13:00, never Shabbat). A slot is free when none of the given partners has an
-- event here (meeting, work block or "not available") or a busy block in her Google calendars.
-- p_partners empty = both of us. At most two suggestions per day, the first ten overall.
create or replace function find_free_slots(p_from date default null, p_days integer default 7,
                                           p_minutes integer default 60, p_partners uuid[] default '{}')
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  who uuid[] := case when coalesce(cardinality(p_partners), 0) = 0 then (select array_agg(id) from partners) else p_partners end;
  d date := coalesce(p_from, (now() at time zone 'Asia/Jerusalem')::date);
  last_day date := d + greatest(1, least(coalesce(p_days, 7), 30));
  len interval := make_interval(mins => greatest(15, coalesce(p_minutes, 60)));
  s timestamptz; e timestamptz; day_end timestamptz;
  per_day integer; total integer := 0;
begin
  if not (is_partner() or auth.role() = 'service_role') then return; end if;
  while d < last_day and total < 10 loop
    if extract(dow from d) <> 6 then
      s := (d + time '09:00') at time zone 'Asia/Jerusalem';
      day_end := (d + case when extract(dow from d) = 5 then time '13:00' else time '18:00' end) at time zone 'Asia/Jerusalem';
      per_day := 0;
      while s + len <= day_end and per_day < 2 and total < 10 loop
        e := s + len;
        if s > now() and not exists (
             select 1 from meetings m, meeting_span(m) sp
             where (m.partner_ids = '{}' or m.partner_ids && who) and sp && tstzrange(s, e))
           and not exists (
             select 1 from partner_busy b where b.partner_id = any (who) and tstzrange(b.starts_at, b.ends_at) && tstzrange(s, e)) then
          starts_at := s; ends_at := e; return next;
          per_day := per_day + 1; total := total + 1;
          s := e + interval '90 minutes';  -- spread the suggestions over the day
        else
          s := s + interval '30 minutes';
        end if;
      end loop;
    end if;
    d := d + 1;
  end loop;
end $$;
revoke all on function find_free_slots(date, integer, integer, uuid[]) from public, anon;
grant execute on function find_free_slots(date, integer, integer, uuid[]) to authenticated;
