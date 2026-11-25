-- The business's own account (bank account + business credit card), Miri 2026-11-25.
-- Runs after 20261116180000_partner_ledger.sql. A null payer / receiver / from / to is the business account.
-- From business_account_from (the day the account was opened), new expenses and income default to the business,
-- in the app, in the Telegram bot and in the YeshInvoice sync. A partner is the payer only when it says so.

alter table ledger_settings add column if not exists business_account_from date not null default date '2026-11-16';
comment on column ledger_settings.business_account_from is 'The business bank account and credit card exist from this date; new rows default to the business.';

-- A short summary of the business account, for the home screen and the bot.
create or replace view business_account_summary with (security_invoker = true) as
select
  round(coalesce(sum(amount_in - amount_out), 0), 2) as balance,
  round(coalesce(sum(amount_in) filter (where kind = 'income'), 0), 2) as client_income,
  round(coalesce(sum(amount_out) filter (where kind = 'expense'), 0), 2) as card_expenses,
  round(coalesce(sum(amount_out) filter (where kind = 'tax'), 0), 2) as taxes,
  round(coalesce(sum(amount_out) filter (where kind = 'withdrawal'), 0), 2) as withdrawals,
  round(coalesce(sum(amount_in) filter (where kind = 'deposit'), 0), 2) as deposits,
  round(coalesce(sum(amount_in) filter (where kind = 'income' and on_date >= date_trunc('month', current_date)), 0), 2) as month_in,
  round(coalesce(sum(amount_out) filter (where on_date >= date_trunc('month', current_date)), 0), 2) as month_out,
  max(on_date) as last_on
from business_account_ledger;

grant select on business_account_summary to authenticated;
