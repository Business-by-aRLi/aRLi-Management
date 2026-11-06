-- Miri, 2026-11-06: back to general costs 50/50 (undo "cover business costs first"),
-- and keep the partner settlement separate from profits: it is about expenses only.

-- 1. Back to the previous profit math (general net 50/50).
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
  ), 0), 2) as expected_profit_share,
  round(coalesce((select sum(amount) from income i where i.received_by_partner_id = p.id), 0), 2) as received_from_clients,
  round(coalesce((select sum(amount) from settlements s where s.to_partner_id = p.id), 0)
      - coalesce((select sum(amount) from settlements s where s.from_partner_id = p.id), 0), 2) as transfers_net
from partners p
join partner_balances b on b.partner_id = p.id;

-- partner_profit_split is left in place but no longer used.

-- 2. Expense settlement, separate from profits: every expense is shared half-half.
--    balance > 0: she paid more than her half, so money is coming back to her.
create or replace view expense_settlement with (security_invoker = true) as
with t as (
  select coalesce(sum(amount), 0) as total, (select count(*)::numeric from partners) as n from expenses
)
select p.id as partner_id, p.name,
  round(coalesce((select sum(amount) from expenses e where e.paid_by_partner_id = p.id), 0), 2) as paid,
  round(t.total / t.n, 2) as her_half,
  round(coalesce((select sum(amount) from expenses e where e.paid_by_partner_id = p.id), 0) - t.total / t.n, 2) as balance
from partners p, t;

grant select on expense_settlement to authenticated;
