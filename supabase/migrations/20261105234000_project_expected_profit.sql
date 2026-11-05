-- Per-project expected numbers, from the agreed price (not only what has arrived).
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
left join (select project_id, sum(amount) total from income group by project_id) i on i.project_id = p.id
left join (select project_id, sum(amount) total from expenses group by project_id) e on e.project_id = p.id
left join (select project_id, sum(percent) total_percent from project_profit_shares group by project_id) s on s.project_id = p.id;
