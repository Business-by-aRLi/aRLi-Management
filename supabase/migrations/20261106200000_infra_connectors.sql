-- Provider connections managed from the app (Miri, 2026-11-06): like the "connectors" screen of any SaaS.
-- A partner pastes a key once in the web app; it is stored encrypted in Supabase Vault and never sent
-- back to the browser. The app sees only the status and the last 4 characters.
create extension if not exists supabase_vault;

create table if not exists infra_connectors (
  provider      text primary key check (provider in ('vercel','anthropic','openai','supabase')),
  secret_id     uuid not null,            -- vault.secrets id
  key_hint      text,                     -- "…a1b2"
  extra         jsonb not null default '{}'::jsonb, -- e.g. {"team_id": "team_..."} for Vercel
  connected_by  uuid references partners (id),
  connected_at  timestamptz not null default now(),
  checked_at    timestamptz,
  check_ok      boolean,
  check_message text
);
alter table infra_connectors enable row level security;
drop policy if exists partners_read on infra_connectors;
create policy partners_read on infra_connectors for select to authenticated using (is_partner());
-- No insert/update/delete policies: writes go through the functions below.

-- Save or replace a provider key.
create or replace function connector_save(p_provider text, p_key text, p_extra jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid; v_partner uuid;
begin
  if not is_partner() then raise exception 'not allowed'; end if;
  if coalesce(length(trim(p_key)), 0) < 8 then raise exception 'המפתח קצר מדי'; end if;
  select id into v_partner from partners where user_id = auth.uid();
  select secret_id into v_id from infra_connectors where provider = p_provider;
  if v_id is null then
    v_id := vault.create_secret(trim(p_key), 'infra_' || p_provider, 'aRLi infra cost connector');
  else
    perform vault.update_secret(v_id, trim(p_key));
  end if;
  insert into infra_connectors (provider, secret_id, key_hint, extra, connected_by, connected_at, checked_at, check_ok, check_message)
  values (p_provider, v_id, '…' || right(trim(p_key), 4), coalesce(p_extra, '{}'::jsonb), v_partner, now(), null, null, null)
  on conflict (provider) do update set secret_id = excluded.secret_id, key_hint = excluded.key_hint, extra = excluded.extra,
    connected_by = excluded.connected_by, connected_at = now(), checked_at = null, check_ok = null, check_message = null;
end $$;

-- Disconnect: delete the key from the vault.
create or replace function connector_remove(p_provider text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  if not is_partner() then raise exception 'not allowed'; end if;
  delete from infra_connectors where provider = p_provider returning secret_id into v_id;
  if v_id is not null then delete from vault.secrets where id = v_id; end if;
end $$;

-- Only the sync function (service role) can read a key.
create or replace function connector_key(p_provider text)
returns text language sql stable security definer set search_path = public, vault as $$
  select d.decrypted_secret from infra_connectors c join vault.decrypted_secrets d on d.id = c.secret_id
  where c.provider = p_provider;
$$;

revoke all on function connector_save(text, text, jsonb), connector_remove(text), connector_key(text) from public, anon;
grant execute on function connector_save(text, text, jsonb), connector_remove(text) to authenticated;
revoke execute on function connector_key(text) from authenticated;
grant execute on function connector_key(text) to service_role;
