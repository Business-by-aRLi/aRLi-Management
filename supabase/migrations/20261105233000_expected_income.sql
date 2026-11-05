-- Expected payment: a project's agreed price, not only what has arrived.
-- outstanding = agreed price minus what was received so far (never below 0).
-- expected_profit = profit + outstanding. Each partner's expected share follows the project's split.

create or replace view business_summary with (security_invoker = true) as
with gaps as (
  select pf.project_id, greatest(coalesce(p.agreed_price, 0) - pf.income, 0) as outstanding
  from project_financials pf join projects p on p.id = pf.project_id
)
select
  coalesce((select sum(amount) from income), 0)                                   as income,
  coalesce((select sum(amount) from expenses where project_id is not null), 0)    as project_expenses,
  coalesce((select sum(amount) from expenses where project_id is null), 0)        as general_expenses,
  coalesce((select sum(amount) from income), 0)
    - coalesce((select sum(amount) from expenses), 0)                             as profit,
  coalesce((select sum(agreed_price) from projects), 0)                           as agreed_total,
  coalesce((select sum(outstanding) from gaps), 0)                                as outstanding,
  coalesce((select sum(amount) from income), 0)
    - coalesce((select sum(amount) from expenses), 0)
    + coalesce((select sum(outstanding) from gaps), 0)                            as expected_profit;

create or replace view partner_summary with (security_invoker = true) as
with gaps as (
  select pf.project_id, greatest(coalesce(p.agreed_price, 0) - pf.income, 0) as outstanding
  from project_financials pf join projects p on p.id = pf.project_id
)
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
    select sum(g.outstanding * ps.percent / 100)
    from gaps g join project_profit_shares ps on ps.project_id = g.project_id and ps.partner_id = p.id
  ), 0), 2) as expected_profit_share
from partners p
join partner_balances b on b.partner_id = p.id;
