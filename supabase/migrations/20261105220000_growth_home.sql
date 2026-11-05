-- Growth home: tasks get a start date for the monthly Gantt, and an ideas board for initiatives.
alter table tasks add column start_on date;

create type idea_status as enum ('idea', 'exploring', 'go', 'parked');

create table ideas (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null,
  description           text,
  status                idea_status not null default 'idea',
  created_by_partner_id uuid references partners (id),
  project_id            uuid references projects (id) on delete set null, -- set when an idea becomes a project
  created_at            timestamptz not null default now()
);

alter table ideas enable row level security;
create policy partners_only on ideas for all to authenticated using (is_partner()) with check (is_partner());
