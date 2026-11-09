-- A synced receipt that a partner deletes stays deleted (Miri, 2026-11-09): the sync skips it from then on.
create table if not exists income_dismissed (
  source       text not null,
  external_id  text not null,
  dismissed_at timestamptz not null default now(),
  primary key (source, external_id)
);
alter table income_dismissed enable row level security;
drop policy if exists partners_only on income_dismissed;
create policy partners_only on income_dismissed for all to authenticated using (is_partner()) with check (is_partner());

create or replace function income_remember_dismissed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.external_id is not null then
    insert into income_dismissed (source, external_id) values (old.source, old.external_id) on conflict do nothing;
  end if;
  return old;
end $$;
drop trigger if exists income_remember_dismissed on income;
create trigger income_remember_dismissed after delete on income
  for each row execute function income_remember_dismissed();
