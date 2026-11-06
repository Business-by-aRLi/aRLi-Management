-- Profit is split only after the business's general costs are covered (Miri, 2026-11-06).
-- General net (general income - general expenses) is taken out of the pooled project profit first.
-- Each partner then keeps her part of what's left, in proportion to her project-profit share.
-- Fallback (no positive project profit, or a partner with a negative project share): general net 50/50.

create or replace view partner_profit_split with (security_invoker = true) as
with proj as (
  select p.id as partner_id,
         coalesce((select sum(amount)          from project_partner_shares s where s.partner_id = p.id), 0) as project_share,
         coalesce((select sum(expected_amount) from project_partner_shares s where s.partner_id = p.id), 0) as expected_project_share
  from partners p
),
g as (
  select coalesce((select sum(amount) from income   where project_id is null), 0)
       - coalesce((select sum(amount) from expenses where project_id is null), 0) as general_net,
         (select count(*)::numeric from partners) as n
),
tot as (
  select sum(project_share) as ps, min(project_share) as ps_min,
         sum(expected_project_share) as es, min(expected_project_share) as es_min
  from proj
)
select proj.partner_id, proj.project_share, proj.expected_project_share,
  round(proj.project_share + case
    when tot.ps > 0 and tot.ps_min >= 0 then g.general_net * proj.project_share / tot.ps
    else g.general_net / g.n end, 2) as profit_share,
  round(proj.expected_project_share + case
    when tot.es > 0 and tot.es_min >= 0 then g.general_net * proj.expected_project_share / tot.es
    else g.general_net / g.n end, 2) as expected_profit_share
from proj, g, tot;

create or replace view partner_balances with (security_invoker = true) as
with held as (
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
       coalesce(s.profit_share, 0) as entitled,
       round(coalesce((select sum(amount) from held h where h.partner_id = p.id), 0), 2) as held,
       round(coalesce((select sum(amount) from held h where h.partner_id = p.id), 0) - coalesce(s.profit_share, 0), 2) as net_position
from partners p
left join partner_profit_split s on s.partner_id = p.id;

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
  coalesce((select expected_profit_share from partner_profit_split x where x.partner_id = p.id), 0) as expected_profit_share,
  round(coalesce((select sum(amount) from income i where i.received_by_partner_id = p.id), 0), 2) as received_from_clients,
  round(coalesce((select sum(amount) from settlements s where s.to_partner_id = p.id), 0)
      - coalesce((select sum(amount) from settlements s where s.from_partner_id = p.id), 0), 2) as transfers_net
from partners p
join partner_balances b on b.partner_id = p.id;

grant select on partner_profit_split to authenticated;
