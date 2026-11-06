-- Profit split by a fixed amount, not only by percent (Miri, 2026-11-06).
-- A partner with fixed_amount gets that amount first, out of the project's profit (never more than the
-- profit that exists). What's left goes to the partners without a fixed amount, by their percent.
alter table project_profit_shares add column if not exists fixed_amount numeric(12,2) check (fixed_amount >= 0);

create or replace view project_partner_shares with (security_invoker = true) as
with base as (
  select ps.project_id, ps.partner_id, ps.percent, ps.fixed_amount, pf.profit, pf.expected_profit,
         coalesce(sum(ps.fixed_amount) over w, 0)                                  as fixed_total,
         coalesce(sum(ps.percent) filter (where ps.fixed_amount is null) over w, 0) as free_pct,
         coalesce(sum(ps.percent) over w, 0)                                       as all_pct
  from project_profit_shares ps
  join project_financials pf on pf.project_id = ps.project_id
  window w as (partition by ps.project_id)
), calc as (
  select *,
         -- the fixed part that can actually be paid now / when everything arrives
         least(fixed_total, greatest(profit, 0))          as fixed_paid,
         least(fixed_total, greatest(expected_profit, 0)) as fixed_paid_expected
  from base
)
select project_id, partner_id, percent, fixed_amount,
  round(case
    when fixed_amount is not null then case when fixed_total = 0 then 0 else fixed_paid * fixed_amount / fixed_total end
    when free_pct > 0 then (profit - fixed_paid) * percent / free_pct
    else 0 end
  + case when free_pct = 0 and all_pct > 0 then (profit - fixed_paid) * percent / all_pct else 0 end, 2) as amount,
  round(case
    when fixed_amount is not null then case when fixed_total = 0 then 0 else fixed_paid_expected * fixed_amount / fixed_total end
    when free_pct > 0 then (expected_profit - fixed_paid_expected) * percent / free_pct
    else 0 end
  + case when free_pct = 0 and all_pct > 0 then (expected_profit - fixed_paid_expected) * percent / all_pct else 0 end, 2) as expected_amount
from calc;

create or replace view partner_balances with (security_invoker = true) as
with partner_count as (select count(*)::numeric n from partners),
entitled as (
  select partner_id, sum(amount) amount from project_partner_shares group by partner_id
  union all
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

create or replace view partner_summary with (security_invoker = true) as
select
  p.id as partner_id,
  p.name,
  round(coalesce((select sum(amount) from expenses e where e.paid_by_partner_id = p.id), 0), 2) as invested,
  b.entitled as profit_share,
  round(coalesce((select sum(amount) from expenses e where e.paid_by_partner_id = p.id), 0) + b.entitled, 2) as due,
  round(
      coalesce((select sum(amount) from income i      where i.received_by_partner_id = p.id), 0)
    + coalesce((select sum(amount) from settlements s where s.to_partner_id = p.id), 0)
    - coalesce((select sum(amount) from settlements s where s.from_partner_id = p.id), 0), 2) as received,
  -b.net_position as balance,
  round(b.entitled + coalesce((
    select sum(s.expected_amount - s.amount) from project_partner_shares s where s.partner_id = p.id
  ), 0), 2) as expected_profit_share
from partners p
join partner_balances b on b.partner_id = p.id;

grant select on project_partner_shares to authenticated;
