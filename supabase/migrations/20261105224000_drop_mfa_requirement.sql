-- Miri chose email + strong password with "remember me" instead of an authenticator app.
create or replace function is_partner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from partners where user_id = auth.uid());
$$;
