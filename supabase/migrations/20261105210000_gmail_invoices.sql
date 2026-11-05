-- Gmail connection for the Telegram bot: each partner can connect her own mailbox (read-only)
-- so the bot can search it for invoices on request.

-- OAuth tokens. RLS on with no policies: only the service role (the bot) can read them.
create table gmail_accounts (
  partner_id    uuid primary key references partners (id) on delete cascade,
  email         text not null,
  refresh_token text not null,
  connected_at  timestamptz not null default now()
);

-- Short-lived values that tie a Google sign-in back to the partner who asked for it.
create table gmail_oauth_states (
  state      text primary key,
  partner_id uuid not null references partners (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table gmail_accounts     enable row level security;
alter table gmail_oauth_states enable row level security;

-- Remember which email an expense came from, so the same invoice is never entered twice.
alter table expenses add column gmail_message_id text;
create unique index expenses_gmail_message_id_key on expenses (gmail_message_id) where gmail_message_id is not null;
