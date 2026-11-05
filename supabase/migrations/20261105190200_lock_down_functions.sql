-- Trigger helpers must not be callable through the API; is_partner() is needed by RLS for signed-in users only.
revoke execute on function public.default_profit_shares() from public, anon, authenticated;
revoke execute on function public.link_partner_on_signup() from public, anon, authenticated;
revoke execute on function public.is_partner() from public, anon;
grant execute on function public.is_partner() to authenticated;
