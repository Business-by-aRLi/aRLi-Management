-- Settlement in plain terms, between three parties: the business, Miri and Riki.
-- Nobody "holds" money. For each partner:
--   invested     = expenses she paid from her own pocket (general costs are an investment in the business)
--   profit_share = her share of the business profit (per-project split; general costs 50/50)
--   due          = invested + profit_share  (what the business owes her in total)
--   received     = money that reached her: client payments to her + transfers from her partner - transfers she sent
--   balance      = due - received  (> 0: still coming to her, < 0: she got more than her part)

create view business_summary with (security_invoker = true) as
select
  coalesce((select sum(amount) from income), 0)                                   as income,
  coalesce((select sum(amount) from expenses where project_id is not null), 0)    as project_expenses,
  coalesce((select sum(amount) from expenses where project_id is null), 0)        as general_expenses,
  coalesce((select sum(amount) from income), 0)
    - coalesce((select sum(amount) from expenses), 0)                             as profit;

create view partner_summary with (security_invoker = true) as
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
  -b.net_position as balance
from partners p
join partner_balances b on b.partner_id = p.id;

grant select on business_summary, partner_summary to authenticated;
