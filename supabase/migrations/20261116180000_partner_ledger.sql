-- Partner ledger (כרטסת שותפות), Miri 2026-11-16.
--   * Every expense is shared by a fixed business share: Miri 62.5%, Riki 37.5% (partners.business_share).
--     Income not tied to a project is shared the same way.
--   * Project income is shared by that project's own split (project_profit_shares, mostly 62.5/37.5, some 50/50).
--   * Some income belongs to one partner only (income.for_partner_id).
--   * Shares use the amounts before VAT; cash rows use the full amount that really moved.
-- Each event becomes one row per partner: credit (זכות) = she paid / transferred out / is entitled to,
-- debit (חובה) = she received money / owes her share. balance > 0: the other partner owes her.

alter table partners add column if not exists business_share numeric(5,2) check (business_share between 0 and 100);
update partners set business_share = 62.5 where business_share is null and lower(email) = 'miri9443@gmail.com';
update partners set business_share = 37.5 where business_share is null and lower(email) = 'rikiplus@gmail.com';

alter table income add column if not exists for_partner_id uuid references partners (id);
comment on column income.for_partner_id is 'Income that belongs to this partner only (100%). Null = by the project split.';

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

-- A partner's share of the business (normalised to 100 even if the two numbers don't add up).
create or replace view partner_business_share with (security_invoker = true) as
select p.id as partner_id,
  case when sum(coalesce(p.business_share, 0)) over () > 0
       then coalesce(p.business_share, 0) / sum(coalesce(p.business_share, 0)) over ()
       else 1.0 / count(*) over () end as share
from partners p;

-- Who is entitled to what part of one income row.
create or replace view income_split with (security_invoker = true) as
select i.id as income_id, p.id as partner_id,
  case
    when i.for_partner_id is not null then case when p.id = i.for_partner_id then 1 else 0 end
    when i.project_id is not null and coalesce(pt.total, 0) > 0 then coalesce(ps.percent, 0) / pt.total
    else bs.share
  end as share
from income i
cross join partners p
join partner_business_share bs on bs.partner_id = p.id
left join project_profit_shares ps on ps.project_id = i.project_id and ps.partner_id = p.id
left join (select project_id, sum(percent) as total from project_profit_shares group by project_id) pt on pt.project_id = i.project_id;

create or replace view partner_ledger with (security_invoker = true) as
with rows as (
  -- Expenses: the payer gets credit for the full amount; each partner owes her share of the cost before VAT.
  select p.id as partner_id, e.spent_on as on_date, e.created_at, 'expense'::text as kind, e.id as ref_id,
    coalesce(nullif(e.vendor, '') || ' · ', '') || e.description as description,
    e.project_id, e.amount as total, e.paid_by_partner_id as actor_id,
    case when e.paid_by_partner_id = p.id then e.amount else 0 end as credit,
    e.net_cost * bs.share as debit,
    round(bs.share * 100, 2) as share_pct
  from expenses e cross join partners p join partner_business_share bs on bs.partner_id = p.id
  union all
  -- Income: whoever received it holds the full amount (debit); each partner is entitled to her share before VAT.
  select p.id, i.received_on, i.created_at, 'income', i.id,
    coalesce(pr.name, c.name, i.customer_name, 'הכנסה') || coalesce(' · ' || i.reference, ''),
    i.project_id, i.amount, i.received_by_partner_id,
    i.net_amount * s.share,
    case when i.received_by_partner_id = p.id then i.amount else 0 end,
    round(s.share * 100, 2)
  from income i cross join partners p
  join income_split s on s.income_id = i.id and s.partner_id = p.id
  left join projects pr on pr.id = i.project_id
  left join clients c on c.id = i.client_id
  union all
  -- Transfers between the partners.
  select p.id, s.settled_on, s.created_at, 'transfer', s.id, coalesce(s.notes, 'העברה'),
    null, s.amount, s.from_partner_id,
    case when s.from_partner_id = p.id then s.amount else 0 end,
    case when s.to_partner_id = p.id then s.amount else 0 end,
    null
  from settlements s join partners p on p.id in (s.from_partner_id, s.to_partner_id)
  union all
  -- VAT paid to the tax authority from a partner's pocket.
  select p.id, coalesce(t.paid_on, t.period_start), t.created_at, 'vat', t.id, coalesce(t.notes, 'תשלום מע״מ'),
    null, t.amount, t.paid_by_partner_id,
    t.amount, 0, null
  from tax_payments t join partners p on p.id = t.paid_by_partner_id
  where t.kind = 'vat'
)
select r.*, pa.name as partner_name, pr.name as project_name, a.name as actor_name,
  round(sum(r.credit - r.debit) over (partition by r.partner_id order by r.on_date, r.created_at, r.ref_id
                                      rows between unbounded preceding and current row), 2) as balance
from rows r
join partners pa on pa.id = r.partner_id
left join projects pr on pr.id = r.project_id
left join partners a on a.id = r.actor_id
where r.credit <> 0 or r.debit <> 0;

grant select on partner_business_share, income_split, partner_ledger to authenticated;

-- The older views follow the same rules, so the home screen and the ledger agree.
create or replace view expense_settlement with (security_invoker = true) as
select p.id as partner_id, p.name,
  round(coalesce((select sum(amount) from expenses e where e.paid_by_partner_id = p.id), 0), 2) as paid,
  round(coalesce((select sum(net_cost) from expenses), 0) * bs.share, 2) as her_half,
  round(coalesce((select sum(amount) from expenses e where e.paid_by_partner_id = p.id), 0)
      - coalesce((select sum(net_cost) from expenses), 0) * bs.share, 2) as balance
from partners p join partner_business_share bs on bs.partner_id = p.id;

create or replace view partner_balances with (security_invoker = true) as
select p.id as partner_id, p.name,
  round(coalesce(sum(l.credit) filter (where l.kind = 'income'), 0)
      - coalesce(sum(l.debit) filter (where l.kind = 'expense'), 0), 2) as entitled,
  round(coalesce(sum(l.debit) filter (where l.kind in ('income', 'transfer')), 0)
      - coalesce(sum(l.credit) filter (where l.kind in ('expense', 'transfer', 'vat')), 0), 2) as held,
  round(-coalesce(sum(l.credit - l.debit), 0), 2) as net_position
from partners p left join partner_ledger l on l.partner_id = p.id
group by p.id, p.name;
