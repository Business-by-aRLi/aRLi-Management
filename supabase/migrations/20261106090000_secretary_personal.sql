-- The secretary takes over from agent-miri (Miri's older personal agent):
-- private personal tasks, a fact memory per partner, follow-up on missed tasks,
-- quiet on Shabbat and holidays, and notes on projects.

-- ---------- private tasks ----------
-- A private task belongs to its assignee alone: the other partner never sees it, in the app or in the bot.
alter table tasks add column is_private boolean not null default false;
alter table tasks add column snooze_count integer not null default 0;
alter table tasks add constraint private_task_has_owner check (not is_private or assignee_partner_id is not null);

create or replace function my_partner_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from partners where user_id = auth.uid();
$$;
revoke execute on function my_partner_id() from public, anon;
grant execute on function my_partner_id() to authenticated;

drop policy partners_only on tasks;
create policy partners_see_shared_and_own_private on tasks for all to authenticated
  using (is_partner() and (not is_private or assignee_partner_id = my_partner_id()))
  with check (is_partner() and (not is_private or assignee_partner_id = my_partner_id()));

-- ---------- fact memory ----------
-- What the bot should remember across conversations ("תזכרי ש...").
-- partner_id null = a shared business fact both partners can use.
create table bot_memories (
  id         uuid primary key default gen_random_uuid(),
  partner_id uuid references partners (id) on delete cascade,
  content    text not null,
  kind       text not null default 'fact' check (kind in ('fact', 'preference', 'person', 'project', 'decision')),
  source     text not null default 'bot',
  created_at timestamptz not null default now()
);
create index on bot_memories (partner_id, created_at desc);
alter table bot_memories enable row level security;
create policy partners_see_shared_and_own on bot_memories for all to authenticated
  using (is_partner() and (partner_id is null or partner_id = my_partner_id()))
  with check (is_partner() and (partner_id is null or partner_id = my_partner_id()));

-- ---------- project notes ----------
-- Decisions and context gathered on a project over time (agent-miri's project dossiers land here too).
create table project_notes (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  partner_id uuid references partners (id) on delete set null,
  content    text not null,
  source     text not null default 'bot',
  created_at timestamptz not null default now()
);
create index on project_notes (project_id, created_at desc);
alter table project_notes enable row level security;
create policy partners_only on project_notes for all to authenticated using (is_partner()) with check (is_partner());

-- ---------- Shabbat and holidays ----------
-- Candle lighting to havdalah windows from Hebcal, cached. The bot sends nothing inside a window;
-- whatever came due waits for the end of Shabbat. Service role only.
create table quiet_windows (
  start_at   timestamptz primary key,
  end_at     timestamptz not null,
  fetched_at timestamptz not null default now()
);
alter table quiet_windows enable row level security;
