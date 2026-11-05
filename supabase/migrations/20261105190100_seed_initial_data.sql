-- Initial data, as confirmed by Miri on 2026-11-05.
-- Partners first, so every project below gets a default 50/50 split.
insert into partners (name) values ('מירי'), ('ריקי');

insert into clients (name, contact_name) values
  ('מוסדות הרב גרוסמן', 'מיכאל לייבוביץ'),
  ('עקיבא גולדבלום', null),
  ('ישראל ליבוביץ', null),
  ('מכנובקא', null);

insert into projects (name, type, status, client_id, notes) values
  ('Migdalor',                 'client',   'active', (select id from clients where name = 'מוסדות הרב גרוסמן'), null),
  ('Kiddush Times Management', 'client',   'active', (select id from clients where name = 'עקיבא גולדבלום'), null),
  ('high-five-vacations',      'client',   'active', (select id from clients where name = 'ישראל ליבוביץ'), null),
  ('Kupat MB',                 'client',   'active', (select id from clients where name = 'מכנובקא'), null),
  ('aRLi Website',             'business', 'active', null, null),
  ('agent-miri',               'learning', 'active', null, null),
  ('Health agent',             'learning', 'active', null, null),
  ('Kids.Mags',                'learning', 'active', null, 'פרויקט פרטי של ריקי להתנסות'),
  ('musagim',                  'learning', 'paused', null, 'לא פעיל, נועד להתנסות'),
  ('WigPro',                   'learning', 'closed', null, 'בדיקה, נעצר');
