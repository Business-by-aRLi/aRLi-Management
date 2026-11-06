-- Paused and closed projects move to the archive.
update projects set status = 'archived', closed_on = coalesce(closed_on, current_date)
where status in ('paused', 'closed');

-- New projects start in planning.
alter table projects alter column status set default 'planning';

-- Automatic stage moves (Miri, 2026-11-06): a quote sent moves the project to 'setup',
-- delivery to the client moves it to 'implementation'. Callers (the quotes system, the bot)
-- use this function: it only ever moves a project forward, and never touches an archived one,
-- so a late or repeated event can't drag a project back.
create or replace function advance_project_stage(p_project_id uuid, p_stage project_status)
returns project_status
language plpgsql security invoker set search_path = public as $$
declare
  flow constant text[] := array['planning', 'setup', 'implementation', 'active'];
  cur project_status;
begin
  select status into cur from projects where id = p_project_id for update;
  if cur is null then raise exception 'project % not found', p_project_id; end if;
  if cur::text in ('archived', 'closed', 'paused') then return cur; end if;
  if array_position(flow, p_stage::text) > coalesce(array_position(flow, cur::text), 0) then
    update projects set status = p_stage where id = p_project_id;
    return p_stage;
  end if;
  return cur;
end $$;
grant execute on function advance_project_stage(uuid, project_status) to authenticated;
