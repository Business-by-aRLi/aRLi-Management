-- Paused and closed projects move to the archive.
update projects set status = 'archived', closed_on = coalesce(closed_on, current_date)
where status in ('paused', 'closed');

-- New projects start in planning.
alter table projects alter column status set default 'planning';
