-- Receipts from Yesh Invoice (יש חשבונית), Miri, 2026-11-09.
-- Miri issues client receipts in Yesh Invoice. The invoice-sync function pulls every receipt into income,
-- once on connect and then every 3 hours, so income per client and "who received the money" fill themselves.
-- The key is connected from the Connections screen like the infra providers (encrypted in Vault).
--   * One income row per document: source = 'yeshinvoice', external_id = '<doc type>-<doc number>'.
--   * Received by: the partner who connected the account (the business owner of that Yesh Invoice account).
--   * Client: by the Yesh customer id saved on the client, else by the same name. Project: the client's only
--     open project. Anything not matched stays "to assign"; assigning one row teaches the customer for the rest.
--   * VAT: amount is the full sum received. Once the business is עוסק מורשה, vat_amount holds the VAT part.

alter table infra_connectors drop constraint if exists infra_connectors_provider_check;
alter table infra_connectors add constraint infra_connectors_provider_check
  check (provider in ('vercel','anthropic','openai','supabase','yeshinvoice'));

alter table income add column if not exists source        text not null default 'manual';
alter table income add column if not exists external_id   text;
alter table income add column if not exists doc_type      int;
alter table income add column if not exists customer_name text;   -- the name on the receipt, for unmatched rows
alter table income add column if not exists customer_ref  text;   -- the customer id in Yesh Invoice
alter table income add column if not exists pdf_url       text;   -- the receipt's PDF in Yesh Invoice
alter table income add column if not exists vat_amount    numeric(12,2);
create unique index if not exists income_source_external on income (source, external_id) where external_id is not null;

alter table clients add column if not exists yesh_customer_id text unique;

-- Assigning a synced receipt to a client (or a project, which brings its client) remembers that customer:
-- the client gets the Yesh customer id, and the customer's other unassigned receipts follow.
create or replace function income_learn_customer() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_project uuid;
begin
  if new.customer_ref is null or new.client_id is null or new.client_id is not distinct from old.client_id then
    return new;
  end if;
  update clients set yesh_customer_id = new.customer_ref
    where id = new.client_id and yesh_customer_id is null
      and not exists (select 1 from clients c where c.yesh_customer_id = new.customer_ref);
  -- the project too, when the client has exactly one project that is not closed
  select case when count(*) = 1 then min(id::text)::uuid end into v_project
    from projects where client_id = new.client_id and status <> 'closed';
  update income set client_id = new.client_id, project_id = coalesce(project_id, v_project)
    where source = new.source and customer_ref = new.customer_ref and client_id is null and id <> new.id;
  return new;
end $$;
drop trigger if exists income_learn_customer on income;
create trigger income_learn_customer after update of client_id on income
  for each row when (pg_trigger_depth() = 0) execute function income_learn_customer();

-- Every 3 hours, from 07:00 to 22:00 Israel time.
select cron.unschedule('invoice-sync') where exists (select 1 from cron.job where jobname = 'invoice-sync');
select cron.schedule('invoice-sync', '5 4-20/3 * * *', $$
  select net.http_post(
    url     := 'https://yeapgpdxflrcttjxfrgl.supabase.co/functions/v1/invoice-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from public.app_config where key = 'cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
