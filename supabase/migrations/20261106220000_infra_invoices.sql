-- Supabase monthly invoice -> cost per project (Miri, 2026-11-06). Supabase has no cost API per
-- project, but its invoice lists each project. infra-sync reads it from Gmail (daily, partners who
-- connected Google) or from a PDF uploaded in the app, and files each project's amount.
create table if not exists infra_invoice_imports (
  source_key   text primary key,          -- "gmail:<message id>" or "upload:<storage path>"
  provider     text not null default 'supabase',
  month        date,
  total        numeric(12,2),
  currency     text,
  result       jsonb,                      -- matched / unmatched lines, for the app to show
  imported_at  timestamptz not null default now()
);
alter table infra_invoice_imports enable row level security;
drop policy if exists partners_read on infra_invoice_imports;
create policy partners_read on infra_invoice_imports for select to authenticated using (is_partner());
