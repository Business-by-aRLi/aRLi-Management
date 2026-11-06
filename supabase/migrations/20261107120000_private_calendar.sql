-- Private events: each partner's own events show in the system calendar, but never reach the other partner.
--
-- * A private event made in the app or the bot (meetings.is_private) is seen only by the partner who made it.
--   It syncs both ways with HER OWN Google calendar (primary), never with the shared "aRLi" calendar.
-- * Events from each partner's personal Google calendars come in with their titles (partner_busy.title),
--   readable only by her. Nothing is ever copied to the other partner's Google calendar.
-- * The other partner sees both only as "busy" (time, no title), so joint free time still works.

-- 1. Private events in the system.
alter table meetings
  add column is_private        boolean not null default false,
  add column google_calendar_id text,  -- the Google calendar the event lives in (shared "aRLi" or the owner's primary)
  add column google_partner_id  uuid references partners (id) on delete set null; -- whose Google account it was written with
alter table meetings add constraint private_meeting_has_owner
  check (not is_private or created_by_partner_id is not null);

-- Existing synced events live in the shared calendar. Marked as a sync write, so nothing is pushed again.
update meetings set google_calendar_id = (select value from app_config where key = 'gcal_calendar_id'),
                    google_partner_id  = (select value::uuid from app_config where key = 'gcal_owner_partner_id'),
                    google_synced_at   = coalesce(google_synced_at, now()) + interval '1 millisecond'
 where google_event_id is not null;

drop policy if exists partners_only on meetings;
create policy partners_see_shared_and_own_private on meetings for all to authenticated
  using (is_partner() and (not is_private or created_by_partner_id = my_partner_id()))
  with check (is_partner() and (not is_private or created_by_partner_id = my_partner_id()));

-- A private event always belongs to the partner who made it, and only to her.
create or replace function meetings_private_owner() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.is_private then new.partner_ids := array[new.created_by_partner_id]; end if;
  return new;
end $$;
create trigger meetings_private_owner before insert or update on meetings
  for each row execute function meetings_private_owner();

-- Deletes remember which Google calendar (and account) the event was in.
alter table calendar_outbox
  add column calendar_id text,
  add column partner_id  uuid references partners (id) on delete cascade;
create or replace function meetings_queue_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.google_event_id is not null and current_setting('arli.sync_delete', true) is distinct from 'on' then
    insert into calendar_outbox (google_event_id, calendar_id, partner_id)
    values (old.google_event_id, old.google_calendar_id, old.google_partner_id);
  end if;
  return old;
end $$;

-- 2. Personal Google events: with their titles, for their owner only.
alter table partner_busy drop constraint partner_busy_pkey;
alter table partner_busy
  add column id      bigint generated always as identity primary key,
  add column title   text,                          -- null when the calendar shares free/busy only
  add column all_day boolean not null default false;

drop policy partners_only on partner_busy;
create policy own_rows_only on partner_busy for all to authenticated
  using (is_partner() and partner_id = my_partner_id())
  with check (is_partner() and partner_id = my_partner_id());

-- What the calendar screen shows: my personal events with titles, the other partner's personal events and
-- private system events as "busy" only.
create or replace view calendar_busy with (security_invoker = false) as
  select b.partner_id, b.starts_at, b.ends_at, b.all_day,
         case when b.partner_id = my_partner_id() then b.title end as title,
         'google'::text as source
    from partner_busy b
   where is_partner()
  union all
  select m.created_by_partner_id, m.starts_at,
         coalesce(m.ends_at, m.starts_at + interval '1 hour'), m.all_day, null, 'private'
    from meetings m
   where is_partner() and m.is_private and m.created_by_partner_id is distinct from my_partner_id();
grant select on calendar_busy to authenticated;
