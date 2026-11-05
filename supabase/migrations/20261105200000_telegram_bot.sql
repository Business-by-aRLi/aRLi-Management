-- Telegram bot: identity linking, meetings, reminders, chat memory, cron.

alter table partners
  add column telegram_chat_id   bigint unique,
  add column telegram_link_code text unique;

-- One-time codes the partners send to the bot to link their Telegram account.
update partners set telegram_link_code = upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8))
where telegram_link_code is null;

create table meetings (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null,
  starts_at             timestamptz not null,
  ends_at               timestamptz,
  location              text,
  project_id            uuid references projects (id) on delete set null,
  notes                 text,
  created_by_partner_id uuid references partners (id),
  google_event_id       text,
  reminded_at           timestamptz,
  created_at            timestamptz not null default now()
);
create index on meetings (starts_at);

create table reminders (
  id         uuid primary key default gen_random_uuid(),
  partner_id uuid references partners (id), -- null = both partners
  remind_at  timestamptz not null,
  message    text not null,
  sent_at    timestamptz,
  created_by_partner_id uuid references partners (id),
  created_at timestamptz not null default now()
);
create index on reminders (remind_at) where sent_at is null;

alter table tasks add column reminded_on date;

-- Short conversation memory for the bot.
create table bot_messages (
  id         bigint generated always as identity primary key,
  chat_id    bigint not null,
  role       text not null check (role in ('user', 'model')),
  content    text not null,
  created_at timestamptz not null default now()
);
create index on bot_messages (chat_id, id desc);

-- Internal settings. RLS on with no policies: only the service role can read it.
create table app_config (
  key   text primary key,
  value text not null
);
insert into app_config (key, value) values ('cron_secret', encode(gen_random_bytes(24), 'hex'));

do $$
declare t text;
begin
  foreach t in array array['meetings','reminders']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy partners_only on %I for all to authenticated using (is_partner()) with check (is_partner())', t);
  end loop;
end $$;
alter table bot_messages enable row level security;
alter table app_config   enable row level security;

-- Run the bot's reminder loop every minute.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule('telegram-bot-reminders', '* * * * *', $$
  select net.http_post(
    url     := 'https://yeapgpdxflrcttjxfrgl.supabase.co/functions/v1/telegram-bot?action=cron',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from public.app_config where key = 'cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$$);
