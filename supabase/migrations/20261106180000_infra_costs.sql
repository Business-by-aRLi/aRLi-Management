-- Infrastructure cost tracking per project (Miri, 2026-11-06): hosting, database, API usage.
-- Kept apart from the money ledger: these rows never touch profit, splits or the partners' balance.
-- If a partner actually paid an invoice, she still records it as an expense as usual.

-- A service the project runs on (Vercel project, Supabase project, Gemini key, domain...).
create table if not exists infra_services (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects (id) on delete cascade,
  provider      text not null,                 -- vercel | supabase | anthropic | openai | google | domain | other
  name          text not null,                 -- e.g. "Vercel – web", "Supabase Pro"
  plan          text,                          -- free / pro / pay-as-you-go
  resource_ref  text,                          -- the id at the provider, used later to map auto-synced costs
  monthly_cost  numeric(12,2) not null default 0 check (monthly_cost >= 0), -- expected fixed monthly price
  currency      text not null default 'USD' check (currency in ('USD','ILS')),
  share_percent numeric(5,2) not null default 100 check (share_percent > 0 and share_percent <= 100), -- for a resource shared by projects
  renews_on     date,                          -- for yearly items like a domain
  active        boolean not null default true,
  notes         text,
  usage_note    text,                          -- filled by the sync, e.g. Supabase API requests this week
  usage_synced_at timestamptz,
  created_at    timestamptz not null default now()
);

-- Actual cost of a service in one month: typed by hand or pulled from the provider's API.
create table if not exists infra_costs (
  id          uuid primary key default gen_random_uuid(),
  service_id  uuid not null references infra_services (id) on delete cascade,
  month       date not null check (extract(day from month) = 1), -- first day of the month
  amount      numeric(12,2) not null check (amount >= 0), -- in the service's currency
  source      text not null default 'manual',   -- manual | vercel | anthropic | openai | ...
  usage_note  text,                              -- e.g. "1.2M tokens", "DB 340MB"
  synced_at   timestamptz,
  created_at  timestamptz not null default now(),
  unique (service_id, month, source)
);

create index if not exists infra_services_project on infra_services (project_id);
create index if not exists infra_costs_month on infra_costs (month);

alter table infra_services enable row level security;
alter table infra_costs    enable row level security;
drop policy if exists partners_only on infra_services;
drop policy if exists partners_only on infra_costs;
create policy partners_only on infra_services for all to authenticated using (is_partner()) with check (is_partner());
create policy partners_only on infra_costs    for all to authenticated using (is_partner()) with check (is_partner());

-- Per project and month: the actual cost where one was recorded, otherwise the service's fixed price.
-- Amounts already include the project's share of a shared service.
create or replace view project_infra_monthly with (security_invoker = true) as
with months as (
  select generate_series(date_trunc('month', current_date) - interval '11 months',
                         date_trunc('month', current_date), interval '1 month')::date as month
)
select s.project_id, m.month, s.currency,
       sum(case when c.service_id is not null then c.amount
                when s.active and s.created_at < m.month + interval '1 month' then s.monthly_cost else 0 end
           * s.share_percent / 100)::numeric(12,2) as amount,
       bool_or(c.service_id is not null) as has_actual
from infra_services s
cross join months m
left join (select service_id, month, sum(amount) amount from infra_costs group by service_id, month) c
  on c.service_id = s.id and c.month = m.month
group by s.project_id, m.month, s.currency;

-- When the sync last ran and what it said (app_config itself is closed to the app).
create or replace function infra_sync_last() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when is_partner() then (select value::jsonb from app_config where key = 'infra_sync_last') end;
$$;
grant execute on function infra_sync_last() to authenticated;

-- Daily sync from the providers at 05:15 Israel time (02:15/03:15 UTC).
select cron.unschedule('infra-sync') where exists (select 1 from cron.job where jobname = 'infra-sync');
select cron.schedule('infra-sync', '15 3 * * *', $$
  select net.http_post(
    url     := 'https://yeapgpdxflrcttjxfrgl.supabase.co/functions/v1/infra-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from public.app_config where key = 'cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
