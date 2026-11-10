-- Mini bookkeeping for an עוסק מורשה (Miri, 2026-11-10). The business moved from עוסק פטור to עוסק מורשה.
--   * tax_profile      one row: since when the business is מורשה, VAT rate, monthly / bimonthly reporting,
--                      the מקדמות rate from the tax authority, the accountant's details.
--   * sales_documents  every money document issued in Yesh Invoice (tax invoice 8, tax invoice-receipt 9,
--                      receipt 6), with its VAT. This is the "עסקאות" side of the VAT report.
--                      Income (cash in) stays in income, as before: 6 and 9 only.
--   * expenses         + VAT fields: the "תשומות" side (input VAT on tax invoices in the business's name).
--   * tax_payments     VAT reports paid, income-tax advances (מקדמות) and National Insurance, per period.
-- The app (/books) adds them up per period. The end of this file moves profit and the profit split to amounts before VAT.

create table if not exists tax_profile (
  id               boolean primary key default true check (id),
  vat_status       text not null default 'licensed' check (vat_status in ('exempt', 'licensed')),
  licensed_from    date not null default '2026-11-01',   -- the first day as עוסק מורשה
  vat_rate         numeric(5,2) not null default 18,
  vat_period       text not null default 'bimonthly' check (vat_period in ('monthly', 'bimonthly')),
  advance_rate     numeric(5,2),                          -- % of turnover for income-tax מקדמות (from the tax authority)
  owner_partner_id uuid references partners(id),          -- whose עוסק file this is
  vat_file_number  text,                                  -- מספר עוסק
  accountant_name  text,
  accountant_email text,
  notes            text,
  updated_at       timestamptz not null default now()
);
insert into tax_profile (id, owner_partner_id)
  select true, (select id from partners where email = 'miri9443@gmail.com' limit 1)
  on conflict (id) do nothing;
alter table tax_profile enable row level security;
drop policy if exists partners_only on tax_profile;
create policy partners_only on tax_profile for all to authenticated using (is_partner()) with check (is_partner());

create table if not exists sales_documents (
  id            uuid primary key default gen_random_uuid(),
  source        text not null default 'yeshinvoice',
  external_id   text not null,                 -- '<doc type>-<doc number>', the same key income uses
  doc_type      int not null,                  -- 6 receipt, 8 tax invoice, 9 tax invoice-receipt
  doc_number    text not null,
  issued_on     date not null,
  customer_name text,
  customer_ref  text,
  client_id     uuid references clients(id) on delete set null,
  total         numeric(12,2) not null,        -- the document's total, VAT included
  vat           numeric(12,2) not null default 0,
  net           numeric(12,2) generated always as (total - vat) stored,
  vat_manual    boolean not null default false, -- corrected by a partner: the sync keeps her number
  title         text,
  pdf_url       text,
  status_id     int,
  raw           jsonb,                          -- the document as Yesh Invoice sent it, for later checks
  synced_at     timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists sales_documents_issued on sales_documents (issued_on);
alter table sales_documents enable row level security;
drop policy if exists partners_only on sales_documents;
create policy partners_only on sales_documents for all to authenticated using (is_partner()) with check (is_partner());

-- Input VAT on expenses. vat_doc null = not checked yet (shown as "לבדיקה" in the books).
alter table expenses add column if not exists vat_doc          text check (vat_doc in ('tax_invoice', 'no_vat'));
alter table expenses add column if not exists vat_amount       numeric(12,2);   -- the VAT printed on the invoice
alter table expenses add column if not exists vat_claim_pct    numeric(5,2) not null default 100; -- 66.67 phone / car, 25 mixed car
alter table expenses add column if not exists is_asset         boolean not null default false;     -- equipment: its own line in the report
alter table expenses add column if not exists allocation_number text;            -- מספר הקצאה (invoices above the threshold)
alter table expenses add column if not exists supplier_tax_id  text;             -- ע.מ / ח.פ of the supplier
alter table expenses add column if not exists vat_period_start date;             -- claim in a later period (up to 6 months)

-- Everything before the move to מורשה had no VAT to claim.
update expenses set vat_doc = 'no_vat', vat_amount = 0
  where vat_doc is null and spent_on < (select licensed_from from tax_profile);

create table if not exists tax_payments (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('vat', 'income_tax_advance', 'national_insurance')),
  period_start       date not null,            -- first day of the reported month / two months
  amount             numeric(12,2) not null,   -- negative = a VAT refund
  paid_on            date,
  paid_by_partner_id uuid references partners(id),
  reference          text,                     -- confirmation number
  notes              text,
  created_at         timestamptz not null default now()
);
alter table tax_payments enable row level security;
drop policy if exists partners_only on tax_payments;
create policy partners_only on tax_payments for all to authenticated using (is_partner()) with check (is_partner());

-- The sync now asks Yesh Invoice for tax invoices too (8). Only 6 and 9 still become income.
update infra_connectors set extra = extra - 'doc_types' where provider = 'yeshinvoice' and extra ? 'doc_types';

-- ---------------------------------------------------------------------------------------------------------
-- Profit without VAT (Miri, 2026-11-10). VAT collected from clients belongs to the tax authority, and input VAT
-- claimed back is not a cost. So profit and the profit split use the amounts before VAT:
--   income.net_amount  = amount - vat_amount
--   expenses.net_cost  = amount - the VAT claimed back (tax invoice × recognised share)
-- Cash stays as it really moved: what each partner received or paid is still the full amount, and a VAT payment
-- (tax_payments kind 'vat') counts as money the paying partner paid out. Expense sharing (expense_settlement)
-- stays on the full amounts each partner paid. Before the move to מורשה nothing changes (no VAT on those rows).
alter table income   add column if not exists net_amount numeric(12,2)
  generated always as (amount - coalesce(vat_amount, 0)) stored;
alter table expenses add column if not exists net_cost numeric(12,2)
  generated always as (amount - case when vat_doc = 'tax_invoice' then coalesce(vat_amount, 0) * vat_claim_pct / 100 else 0 end) stored;

create or replace view project_financials with (security_invoker = true) as
select p.id as project_id, p.name, p.type, p.status,
  coalesce(i.total, 0) as income,
  coalesce(e.total, 0) as expenses,
  coalesce(i.total, 0) - coalesce(e.total, 0) as profit,
  coalesce(s.total_percent, 0) as shares_percent_total,
  p.agreed_price,
  greatest(coalesce(p.agreed_price, 0) - coalesce(i.total, 0), 0) as outstanding,
  greatest(coalesce(p.agreed_price, 0), coalesce(i.total, 0)) as expected_income,
  greatest(coalesce(p.agreed_price, 0), coalesce(i.total, 0)) - coalesce(e.total, 0) as expected_profit
from projects p
left join (select project_id, sum(net_amount) as total from income group by project_id) i on i.project_id = p.id
left join (select project_id, sum(net_cost) as total from expenses group by project_id) e on e.project_id = p.id
left join (select project_id, sum(percent) as total_percent from project_profit_shares group by project_id) s on s.project_id = p.id;

create or replace view business_summary with (security_invoker = true) as
with gaps as (
  select pf.project_id, greatest(coalesce(p.agreed_price, 0) - pf.income, 0) as outstanding
  from project_financials pf join projects p on p.id = pf.project_id
)
select
  coalesce((select sum(net_amount) from income), 0) as income,
  coalesce((select sum(net_cost) from expenses where project_id is not null), 0) as project_expenses,
  coalesce((select sum(net_cost) from expenses where project_id is null), 0) as general_expenses,
  coalesce((select sum(net_amount) from income), 0) - coalesce((select sum(net_cost) from expenses), 0) as profit,
  coalesce((select sum(agreed_price) from projects), 0) as agreed_total,
  coalesce((select sum(outstanding) from gaps), 0) as outstanding,
  coalesce((select sum(net_amount) from income), 0) - coalesce((select sum(net_cost) from expenses), 0)
    + coalesce((select sum(outstanding) from gaps), 0) as expected_profit;

create or replace view partner_balances with (security_invoker = true) as
with partner_count as (select count(*)::numeric as n from partners),
entitled as (
  select partner_id, sum(amount) as amount from project_partner_shares group by partner_id
  union all
  select p.id, (coalesce((select sum(net_amount) from income where project_id is null), 0)
              - coalesce((select sum(net_cost) from expenses where project_id is null), 0)) / (select n from partner_count)
  from partners p
),
held as (
  select received_by_partner_id as partner_id, sum(amount) as amount from income where received_by_partner_id is not null group by 1
  union all
  select paid_by_partner_id, -sum(amount) from expenses where paid_by_partner_id is not null group by 1
  union all
  select paid_by_partner_id, -sum(amount) from tax_payments where kind = 'vat' and paid_by_partner_id is not null group by 1
  union all
  select to_partner_id, sum(amount) from settlements where to_partner_id is not null group by 1
  union all
  select from_partner_id, -sum(amount) from settlements where from_partner_id is not null group by 1
)
select p.id as partner_id, p.name,
  round(coalesce((select sum(e.amount) from entitled e where e.partner_id = p.id), 0), 2) as entitled,
  round(coalesce((select sum(h.amount) from held h where h.partner_id = p.id), 0), 2) as held,
  round(coalesce((select sum(h.amount) from held h where h.partner_id = p.id), 0)
      - coalesce((select sum(e.amount) from entitled e where e.partner_id = p.id), 0), 2) as net_position
from partners p;
