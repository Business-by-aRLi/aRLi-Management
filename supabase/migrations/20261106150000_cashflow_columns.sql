-- Separate cash flow from profit & loss in the settlement: split "received" into client payments and transfers.
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
