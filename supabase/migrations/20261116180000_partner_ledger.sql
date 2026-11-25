-- Partner ledger (כרטסת שותפות), Miri 2026-11-16.
-- New split rules, from ledger_settings.new_split_from (2026-11-16) on:
--   * Every expense is shared by the business share: Miri 62.5%, Riki 37.5% (partners.business_share).
--     Income not tied to a project is shared the same way.
--   * Project income is shared by that project's own split (project_profit_shares).
-- Before that date everything stays as it was: expenses and income without a project 50/50, and project income by
-- the split each project had on 2026-11-16 (frozen in project_profit_shares_before).
--   * Some income belongs to one partner only (income.for_partner_id), at any date.
--   * Shares use the amounts before VAT; cash rows use the full amount that really moved.
-- The business now has a bank account and a credit card. A row with no partner (paid_by / received_by / from / to
-- is null) is the business account. Each event becomes one row per partner:
--   credit (זכות) = she paid for the business, deposited money in it, or is entitled to part of an income;
--   debit  (חובה) = her share of an expense, or business money that reached her (a client paid her, a withdrawal).
-- balance > 0: the business (or the other partner) owes her.

-- ---------- settings ----------
create table if not exists ledger_settings (
  id             boolean primary key default true check (id),
  new_split_from date not null default date '2026-11-16'
);
insert into ledger_settings (id) values (true) on conflict (id) do nothing;
alter table ledger_settings enable row level security;
drop policy if exists partners_only on ledger_settings;
create policy partners_only on ledger_settings for all to authenticated using (is_partner()) with check (is_partner());

alter table partners add column if not exists business_share numeric(5,2) check (business_share between 0 and 100);
update partners set business_share = 62.5 where business_share is null and lower(email) = 'miri9443@gmail.com';
update partners set business_share = 37.5 where business_share is null and lower(email) = 'rikiplus@gmail.com';

alter table income add column if not exists for_partner_id uuid references partners (id);
comment on column income.for_partner_id is 'Income that belongs to this partner only (100%). Null = by the split.';

-- Each project's split as it was before the new rules. Income received before new_split_from keeps using it,
-- so changing a project's split now only affects payments from now on.
create table if not exists project_profit_shares_before (
  project_id uuid not null references projects (id) on delete cascade,
  partner_id uuid not null references partners (id) on delete cascade,
  percent    numeric(5,2) not null,
  primary key (project_id, partner_id)
);
insert into project_profit_shares_before (project_id, partner_id, percent)
select project_id, partner_id, percent from project_profit_shares
on conflict do nothing;
alter table project_profit_shares_before enable row level security;
drop policy if exists partners_only on project_profit_shares_before;
create policy partners_only on project_profit_shares_before for all to authenticated using (is_partner()) with check (is_partner());

-- New projects start with the business share instead of an equal split.
create or replace function default_profit_shares() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int; t numeric;
begin
  select count(*), coalesce(sum(business_share), 0) into n, t from partners;
  if n > 0 then
    insert into project_profit_shares (project_id, partner_id, percent)
    select new.id, p.id, case when t > 0 then round(coalesce(p.business_share, 0) * 100 / t, 2) else round(100.0 / n, 2) end
    from partners p;
  end if;
  return new;
end;
$$;

-- ---------- who carries what part of each row ----------
-- A partner's share of the business: the new share (normalised to 100) and the old equal share.
create or replace view partner_business_share with (security_invoker = true) as
select p.id as partner_id,
  case when sum(coalesce(p.business_share, 0)) over () > 0
       then coalesce(p.business_share, 0) / sum(coalesce(p.business_share, 0)) over ()
       else 1.0 / count(*) over () end as share,
  1.0 / count(*) over () as old_share
from partners p;

create or replace view expense_split with (security_invoker = true) as
select e.id as expense_id, bs.partner_id,
  case when e.spent_on < s.new_split_from then bs.old_share else bs.share end as share
from expenses e
cross join partner_business_share bs
cross join ledger_settings s;

create or replace view income_split with (security_invoker = true) as
with i as (
  select i.*, (i.received_on < s.new_split_from) as old from income i cross join ledger_settings s
)
select i.id as income_id, bs.partner_id,
  case
    when i.for_partner_id is not null then case when bs.partner_id = i.for_partner_id then 1 else 0 end
    when i.project_id is not null and i.old and coalesce(ot.total, 0) > 0 then coalesce(os.percent, 0) / ot.total
    when i.project_id is not null and not i.old and coalesce(pt.total, 0) > 0 then coalesce(ps.percent, 0) / pt.total
    when i.old then bs.old_share
    else bs.share
  end as share
from i
cross join partner_business_share bs
left join project_profit_shares ps on ps.project_id = i.project_id and ps.partner_id = bs.partner_id
left join (select project_id, sum(percent) as total from project_profit_shares group by project_id) pt on pt.project_id = i.project_id
left join project_profit_shares_before os on os.project_id = i.project_id and os.partner_id = bs.partner_id
left join (select project_id, sum(percent) as total from project_profit_shares_before group by project_id) ot on ot.project_id = i.project_id;

-- ---------- the partner ledger ----------
create or replace view partner_ledger with (security_invoker = true) as
with rows as (
  -- Expenses: whoever paid gets credit for the full amount (nobody, if the business card paid);
  -- each partner owes her share of the cost before VAT.
  select s.partner_id, e.spent_on as on_date, e.created_at, 'expense'::text as kind, e.id as ref_id,
    coalesce(nullif(e.vendor, '') || ' · ', '') || e.description as description,
    e.project_id, e.amount as total, e.paid_by_partner_id as actor_id,
    case when e.paid_by_partner_id = s.partner_id then e.amount else 0 end as credit,
    e.net_cost * s.share as debit,
    round(s.share * 100, 2) as share_pct
  from expenses e join expense_split s on s.expense_id = e.id
  union all
  -- Income: whoever received it holds the full amount (debit; nobody, if it reached the business account);
  -- each partner is entitled to her share before VAT.
  select s.partner_id, i.received_on, i.created_at, 'income', i.id,
    coalesce(pr.name, c.name, i.customer_name, 'הכנסה') || coalesce(' · ' || i.reference, ''),
    i.project_id, i.amount, i.received_by_partner_id,
    i.net_amount * s.share,
    case when i.received_by_partner_id = s.partner_id then i.amount else 0 end,
    round(s.share * 100, 2)
  from income i
  join income_split s on s.income_id = i.id
  left join projects pr on pr.id = i.project_id
  left join clients c on c.id = i.client_id
  union all
  -- Transfers: between the partners, a withdrawal from the business (from null) or a deposit into it (to null).
  select p.id, t.settled_on, t.created_at,
    case when t.from_partner_id is null then 'withdrawal' when t.to_partner_id is null then 'deposit' else 'transfer' end,
    t.id, coalesce(t.notes, ''),
    null, t.amount, t.from_partner_id,
    case when t.from_partner_id = p.id then t.amount else 0 end,
    case when t.to_partner_id = p.id then t.amount else 0 end,
    null
  from settlements t join partners p on p.id in (t.from_partner_id, t.to_partner_id)
  union all
  -- VAT paid to the tax authority from a partner's own pocket (from the business account it isn't hers).
  select p.id, coalesce(t.paid_on, t.period_start), t.created_at, 'vat', t.id, coalesce(t.notes, 'תשלום מע״מ'),
    null, t.amount, t.paid_by_partner_id,
    t.amount, 0, null
  from tax_payments t join partners p on p.id = t.paid_by_partner_id
  where t.kind = 'vat'
)
select r.*, pa.name as partner_name, pr.name as project_name, coalesce(a.name, 'חשבון העסק') as actor_name,
  round(sum(r.credit - r.debit) over (partition by r.partner_id order by r.on_date, r.created_at, r.ref_id
                                      rows between unbounded preceding and current row), 2) as balance
from rows r
join partners pa on pa.id = r.partner_id
left join projects pr on pr.id = r.project_id
left join partners a on a.id = r.actor_id
where r.credit <> 0 or r.debit <> 0;

-- The business account itself: money in and out, with a running balance.
create or replace view business_account_ledger with (security_invoker = true) as
with rows as (
  select received_on as on_date, created_at, 'income'::text as kind, id as ref_id,
    coalesce((select name from projects where id = income.project_id), customer_name, 'הכנסה') || coalesce(' · ' || reference, '') as description,
    amount as amount_in, 0::numeric as amount_out
  from income where received_by_partner_id is null
  union all
  select spent_on, created_at, 'expense', id, coalesce(nullif(vendor, '') || ' · ', '') || description, 0, amount
  from expenses where paid_by_partner_id is null
  union all
  select settled_on, created_at, case when from_partner_id is null then 'withdrawal' else 'deposit' end, id,
    coalesce((select name from partners where id = coalesce(settlements.to_partner_id, settlements.from_partner_id)), '') || coalesce(' · ' || notes, ''),
    case when to_partner_id is null then amount else 0 end,
    case when from_partner_id is null then amount else 0 end
  from settlements where from_partner_id is null or to_partner_id is null
  union all
  select coalesce(paid_on, period_start), created_at, 'tax', id, coalesce(notes, case kind when 'vat' then 'מע״מ' when 'income_tax_advance' then 'מקדמת מס' else 'ביטוח לאומי' end), 0, amount
  from tax_payments where paid_by_partner_id is null and paid_on is not null
)
select r.*, round(sum(r.amount_in - r.amount_out) over (order by r.on_date, r.created_at, r.ref_id
                                                          rows between unbounded preceding and current row), 2) as balance
from rows r;

grant select on partner_business_share, expense_split, income_split, partner_ledger, business_account_ledger to authenticated;
grant select, insert, update, delete on ledger_settings, project_profit_shares_before to authenticated;

-- ---------- the older views follow the same rules, so the home screen and the ledger agree ----------
create or replace view expense_settlement with (security_invoker = true) as
select p.id as partner_id, p.name,
  round(coalesce((select sum(amount) from expenses e where e.paid_by_partner_id = p.id), 0), 2) as paid,
  round(coalesce((select sum(e.net_cost * s.share) from expenses e join expense_split s on s.expense_id = e.id and s.partner_id = p.id), 0), 2) as her_half,
  round(coalesce((select sum(amount) from expenses e where e.paid_by_partner_id = p.id), 0)
      - coalesce((select sum(e.net_cost * s.share) from expenses e join expense_split s on s.expense_id = e.id and s.partner_id = p.id), 0), 2) as balance
from partners p;

create or replace view partner_balances with (security_invoker = true) as
select p.id as partner_id, p.name,
  round(coalesce(sum(l.credit) filter (where l.kind = 'income'), 0)
      - coalesce(sum(l.debit) filter (where l.kind = 'expense'), 0), 2) as entitled,
  round(coalesce(sum(l.debit) filter (where l.kind in ('income', 'transfer', 'withdrawal', 'deposit')), 0)
      - coalesce(sum(l.credit) filter (where l.kind in ('expense', 'transfer', 'withdrawal', 'deposit', 'vat')), 0), 2) as held,
  round(-coalesce(sum(l.credit - l.debit), 0), 2) as net_position
from partners p left join partner_ledger l on l.partner_id = p.id
group by p.id, p.name;
