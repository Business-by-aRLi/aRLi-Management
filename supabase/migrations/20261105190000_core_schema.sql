-- aRLi Management: core schema
-- Today the business has no bank account: every payment goes through a partner's private account.
-- Money convention: a NULL partner on income/expenses/settlements means the shared business account.

create extension if not exists pgcrypto;

-- ---------- enums ----------
create type project_type   as enum ('business', 'learning', 'client');
create type project_status as enum ('active', 'paused', 'closed');
create type time_kind      as enum ('work', 'learning');
create type task_status    as enum ('todo', 'in_progress', 'done');
create type cost_frequency as enum ('monthly', 'yearly');

-- ---------- partners ----------
create table partners (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  email      text unique,
  user_id    uuid unique references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Only signed-in users linked to a partner can see or change anything.
create or replace function is_partner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from partners where user_id = auth.uid());
$$;

-- When someone signs up with a partner's email, link the account to that partner.
create or replace function link_partner_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update partners set user_id = new.id
  where lower(email) = lower(new.email) and user_id is null;
  return new;
end;
$$;

create trigger on_auth_user_created_link_partner
  after insert on auth.users
  for each row execute function link_partner_on_signup();

-- ---------- clients & projects ----------
create table clients (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  contact_name text,
  phone        text,
  email        text,
  notes        text,
  created_at   timestamptz not null default now()
);

create table projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  type         project_type not null,
  status       project_status not null default 'active',
  client_id    uuid references clients (id) on delete set null,
  agreed_price numeric(12,2) check (agreed_price >= 0),
  started_on   date,
  closed_on    date,
  notes        text,
  created_at   timestamptz not null default now()
);

-- Each project has its own profit split. New projects start at an equal split.
create table project_profit_shares (
  project_id uuid not null references projects (id) on delete cascade,
  partner_id uuid not null references partners (id) on delete cascade,
  percent    numeric(5,2) not null check (percent between 0 and 100),
  primary key (project_id, partner_id)
);

create or replace function default_profit_shares() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from partners;
  if n > 0 then
    insert into project_profit_shares (project_id, partner_id, percent)
    select new.id, p.id, round(100.0 / n, 2) from partners p;
  end if;
  return new;
end;
$$;

create trigger projects_default_shares
  after insert on projects
  for each row execute function default_profit_shares();

-- ---------- money ----------
create table recurring_costs (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  amount             numeric(12,2) not null check (amount >= 0),
  frequency          cost_frequency not null default 'monthly',
  project_id         uuid references projects (id) on delete set null, -- null = whole business
  paid_by_partner_id uuid references partners (id),                    -- null = business account
  active             boolean not null default true,
  started_on         date,
  ended_on           date,
  notes              text,
  created_at         timestamptz not null default now()
);

create table income (
  id                     uuid primary key default gen_random_uuid(),
  received_on            date not null default current_date,
  amount                 numeric(12,2) not null check (amount > 0),
  project_id             uuid references projects (id) on delete restrict, -- null = not tied to a project
  client_id              uuid references clients (id) on delete set null,
  received_by_partner_id uuid references partners (id),                    -- null = business account
  method                 text,
  notes                  text,
  created_at             timestamptz not null default now()
);

create table expenses (
  id                 uuid primary key default gen_random_uuid(),
  spent_on           date not null default current_date,
  amount             numeric(12,2) not null check (amount > 0),
  description        text not null,
  category           text,
  project_id         uuid references projects (id) on delete restrict, -- null = whole business (split 50/50)
  paid_by_partner_id uuid references partners (id),                    -- null = business account
  recurring_cost_id  uuid references recurring_costs (id) on delete set null,
  reference          text, -- receipt / invoice number (אסמכתה)
  receipt_path       text, -- file in the private "receipts" storage bucket
  notes              text,
  created_at         timestamptz not null default now()
);

-- Transfers between partners, or between a partner and the business account.
create table settlements (
  id              uuid primary key default gen_random_uuid(),
  settled_on      date not null default current_date,
  amount          numeric(12,2) not null check (amount > 0),
  from_partner_id uuid references partners (id), -- null = business account
  to_partner_id   uuid references partners (id), -- null = business account
  notes           text,
  created_at      timestamptz not null default now(),
  check (from_partner_id is distinct from to_partner_id)
);

-- ---------- time, plans, tasks ----------
create table time_entries (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references partners (id),
  project_id  uuid references projects (id) on delete set null,
  work_date   date not null default current_date,
  minutes     int not null check (minutes > 0),
  kind        time_kind not null default 'work',
  description text,
  created_at  timestamptz not null default now()
);

create table work_plans (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  period_start date,
  period_end   date,
  goals        text,
  created_at   timestamptz not null default now()
);

create table tasks (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,
  description         text,
  project_id          uuid references projects (id) on delete set null,
  work_plan_id        uuid references work_plans (id) on delete set null,
  assignee_partner_id uuid references partners (id),
  due_on              date,
  status              task_status not null default 'todo',
  priority            smallint not null default 2 check (priority between 1 and 3),
  completed_at        timestamptz,
  created_at          timestamptz not null default now()
);

create index on income (project_id);
create index on expenses (project_id);
create index on time_entries (project_id);
create index on time_entries (partner_id, work_date);
create index on tasks (status, due_on);

-- ---------- row level security ----------
do $$
declare t text;
begin
  foreach t in array array['partners','clients','projects','project_profit_shares','recurring_costs',
                           'income','expenses','settlements','time_entries','work_plans','tasks']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy partners_only on %I for all to authenticated using (is_partner()) with check (is_partner())', t);
  end loop;
end $$;

-- ---------- reporting views ----------
-- Profit per project.
create view project_financials with (security_invoker = true) as
select p.id as project_id, p.name, p.type, p.status,
       coalesce(i.total, 0) as income,
       coalesce(e.total, 0) as expenses,
       coalesce(i.total, 0) - coalesce(e.total, 0) as profit,
       coalesce(s.total_percent, 0) as shares_percent_total
from projects p
left join (select project_id, sum(amount) total from income   group by project_id) i on i.project_id = p.id
left join (select project_id, sum(amount) total from expenses group by project_id) e on e.project_id = p.id
left join (select project_id, sum(percent) total_percent from project_profit_shares group by project_id) s on s.project_id = p.id;

-- What each partner is entitled to, what she actually holds, and the difference.
-- net_position > 0: she holds more than her share (owes); < 0: she is owed.
create view partner_balances with (security_invoker = true) as
with partner_count as (select count(*)::numeric n from partners),
entitled as (
  -- project profit by the project's own split
  select ps.partner_id, sum(pf.profit * ps.percent / 100) amount
  from project_financials pf join project_profit_shares ps on ps.project_id = pf.project_id
  group by ps.partner_id
  union all
  -- money not tied to a project is always split equally
  select p.id, (
      coalesce((select sum(amount) from income   where project_id is null), 0)
    - coalesce((select sum(amount) from expenses where project_id is null), 0)
  ) / (select n from partner_count)
  from partners p
),
held as (
  select received_by_partner_id partner_id, sum(amount) amount from income
    where received_by_partner_id is not null group by 1
  union all
  select paid_by_partner_id, -sum(amount) from expenses
    where paid_by_partner_id is not null group by 1
  union all
  select to_partner_id, sum(amount) from settlements where to_partner_id is not null group by 1
  union all
  select from_partner_id, -sum(amount) from settlements where from_partner_id is not null group by 1
)
select p.id as partner_id, p.name,
       round(coalesce((select sum(amount) from entitled e where e.partner_id = p.id), 0), 2) as entitled,
       round(coalesce((select sum(amount) from held h where h.partner_id = p.id), 0), 2)     as held,
       round(coalesce((select sum(amount) from held h where h.partner_id = p.id), 0)
           - coalesce((select sum(amount) from entitled e where e.partner_id = p.id), 0), 2) as net_position
from partners p;

-- Money currently sitting in the shared business account.
create view business_account_balance with (security_invoker = true) as
select
    coalesce((select sum(amount) from income      where received_by_partner_id is null), 0)
  - coalesce((select sum(amount) from expenses    where paid_by_partner_id is null), 0)
  + coalesce((select sum(amount) from settlements where to_partner_id is null), 0)
  - coalesce((select sum(amount) from settlements where from_partner_id is null), 0) as balance;

-- ---------- receipts storage ----------
-- Private bucket for receipt files (images / PDF). Only partners can read or upload.
insert into storage.buckets (id, name, public) values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy receipts_partners_only on storage.objects for all to authenticated
  using (bucket_id = 'receipts' and is_partner())
  with check (bucket_id = 'receipts' and is_partner());
