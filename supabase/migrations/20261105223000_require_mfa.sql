-- Require two-factor sign-in (aal2) for every read and write from the app.
-- The Telegram bot uses the service role and is not affected.
create or replace function is_partner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from partners where user_id = auth.uid());
$$;
