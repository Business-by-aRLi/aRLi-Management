-- Usage detail behind each infra cost, so the project's Infrastructure card can show what was used.
-- infra_costs.breakdown: one month of one service, per provider line item:
--   [{ "item": "Fast Data Transfer", "qty": 12.3, "unit": "GB", "cost": 0.41 }]
-- infra_services.usage: the latest usage snapshot that has no cost (Supabase API requests, last 7 days):
--   [{ "item": "REST", "qty": 1234, "unit": "בקשות" }]
alter table public.infra_costs add column if not exists breakdown jsonb;
alter table public.infra_services add column if not exists usage jsonb;
