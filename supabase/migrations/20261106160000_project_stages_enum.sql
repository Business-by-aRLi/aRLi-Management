-- Project lifecycle stages (Miri, 2026-11-06): בתכנון, בהקמה, בהטמעה, פעיל, ארכיון.
-- New enum values must be committed before they can be used, so this runs on its own,
-- before 20261106160100_project_stages.sql. The old values 'paused' and 'closed' stay in the
-- type (Postgres cannot drop enum values) but are no longer used.
alter type project_status add value if not exists 'planning'       before 'active';
alter type project_status add value if not exists 'setup'          before 'active';
alter type project_status add value if not exists 'implementation' before 'active';
alter type project_status add value if not exists 'archived';
