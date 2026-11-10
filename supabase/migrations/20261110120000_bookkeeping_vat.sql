-- Mini bookkeeping for an עוסק מורשה (Miri, 2026-11-10). The business moved from עוסק פטור to עוסק מורשה.
--   * tax_profile      one row: since when the business is מורשה, VAT rate, monthly / bimonthly reporting,
--                      the מקדמות rate from the tax authority, the accountant's details.
--   * sales_documents  every money document issued in Yesh Invoice (tax invoice 8, tax invoice-receipt 9,
--                      receipt 6), with its VAT. This is the "עסקאות" side of the VAT report.
--                      Income (cash in) stays in income, as before: 6 and 9 only.
--   * expenses         + VAT fields: the "תשומות" side (input VAT on tax invoices in the business's name).
--   * tax_payments     VAT reports paid, income-tax advances (מקדמות) and National Insurance, per period.
-- The app (/books) adds them up per period; nothing here changes the partner balances or profit views.

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
