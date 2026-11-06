-- Quotes and a leads CRM (Miri, 2026-11-06).
-- A quote goes to the client in one of two forms, chosen per quote:
--   document: aRLi's branded quote page with items, VAT and discount; the client approves on it (/q/<token>)
--   portal:   the interactive proposal portal (repo arli-proposal-luxury-tours, served at /proposal/<token>);
--             its links, sessions and click events now live here, tied to the quote and the lead.
-- Automatic moves:
--   quote sent      -> lead "נשלחה הצעה", its project to "בהקמה" (advance_project_stage)
--   quote approved  -> lead "נסגר", the lead becomes a client, a project is opened or updated
--   project delivered (delivered_on set) -> "בהטמעה"
-- Follow-up dates and client responses reach the partners through the bot's reminders table.

-- ---------- leads ----------
create table leads (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,            -- the person
  company            text,                     -- business / organisation, if any
  phone              text,
  email              text,
  source             text,                     -- המלצה, אתר, פייסבוק, נטוורקינג...
  stage              text not null default 'new'
                     check (stage in ('new', 'contacted', 'meeting', 'quote_sent', 'won', 'lost')),
  estimated_value    numeric(12,2) check (estimated_value >= 0),
  next_follow_up_on  date,
  follow_up_note     text,
  owner_partner_id   uuid references partners (id) on delete set null, -- who follows up; null = both
  client_id          uuid references clients (id) on delete set null,  -- once the lead is a client
  project_id         uuid references projects (id) on delete set null,
  lost_reason        text,
  notes              text,
  stage_changed_at   timestamptz not null default now(),
  follow_up_reminder_id uuid, -- the pending bot reminder for the follow-up (no FK: the trigger replaces it in place)
  created_at         timestamptz not null default now()
);
create index on leads (stage);
create index on leads (next_follow_up_on) where stage not in ('won', 'lost');

-- What happened with a lead: calls, messages, notes, and automatic entries (stage moves, quote events).
create table lead_activities (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references leads (id) on delete cascade,
  kind       text not null default 'note'
             check (kind in ('note', 'call', 'whatsapp', 'email', 'meeting', 'stage', 'quote')),
  body       text not null,
  partner_id uuid references partners (id) on delete set null,
  created_at timestamptz not null default now()
);
create index on lead_activities (lead_id, created_at desc);

-- ---------- quotes ----------
create table quotes (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null default 'document' check (kind in ('document', 'portal')),
  portal_template text,                       -- portal only: which bespoke experience (luxury-tours, tillis, ...)
  year            int  not null default extract(year from now())::int,
  seq             int  not null,
  number          text generated always as (year::text || '-' || lpad(seq::text, 3, '0')) stored,
  lead_id         uuid references leads (id) on delete set null,
  client_id       uuid references clients (id) on delete set null,
  project_id      uuid references projects (id) on delete set null,
  recipient_name  text,                       -- "עבור": who the quote is addressed to
  title           text not null,              -- the headline of the quote
  intro           text,                       -- one paragraph under the headline
  sections        jsonb not null default '[]'::jsonb, -- [{ "title": "איך זה עובד", "body": "..." }]
  status          text not null default 'draft'
                  check (status in ('draft', 'sent', 'viewed', 'approved', 'rejected', 'cancelled')),
  issued_on       date not null default current_date,
  valid_until     date not null default (current_date + 30),
  discount_type   text not null default 'amount' check (discount_type in ('amount', 'percent')),
  discount_value  numeric(12,2) not null default 0 check (discount_value >= 0),
  include_vat     boolean not null default true,
  vat_rate        numeric(5,2) not null default 18,
  subtotal        numeric(12,2) not null default 0, -- kept by trigger from the items
  total           numeric(12,2) not null default 0, -- after discount and VAT
  payment_terms   text default '50% באישור ההצעה, 50% במסירה.',
  timeline        text,
  notes           text,                        -- internal, never shown to the client
  public_token    text not null unique default encode(gen_random_bytes(18), 'hex'),
  sent_at         timestamptz,
  sent_via        text,                        -- whatsapp / email / link
  viewed_at       timestamptz,
  view_count      int not null default 0,
  responded_at    timestamptz,
  submitted_at    timestamptz,                 -- portal: the client sent the summary at the end
  meeting_id      uuid references meetings (id) on delete set null, -- portal: the meeting the client booked
  signer_name     text,                        -- the name the client typed when approving
  response_note   text,                        -- what the client wrote back
  created_by_partner_id uuid references partners (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (year, seq)
);
create index on quotes (lead_id);
create index on quotes (project_id);
create index on quotes (client_id);

create table quote_items (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references quotes (id) on delete cascade,
  description text not null,
  details     text,
  quantity    numeric(12,2) not null default 1 check (quantity >= 0),
  unit_price  numeric(12,2) not null default 0,
  recurring   boolean not null default false, -- a monthly fee, shown apart and not counted in the one-time total
  sort_order  int not null default 0
);
create index on quote_items (quote_id, sort_order);

alter table projects add column if not exists delivered_on date;

-- ---------- RLS: partners only (the client reaches a quote only through the functions below) ----------
do $$
declare t text;
begin
  foreach t in array array['leads', 'lead_activities', 'quotes', 'quote_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy partners_only on %I for all to authenticated using (is_partner()) with check (is_partner())', t);
  end loop;
end $$;

-- ---------- numbering and totals ----------
create or replace function quote_number_next() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.seq is null then
    perform pg_advisory_xact_lock(hashtext('quote_seq'));
    select coalesce(max(seq), 0) + 1 into new.seq from quotes where year = new.year;
  end if;
  return new;
end $$;
create trigger quotes_number before insert on quotes for each row execute function quote_number_next();

-- subtotal = one-time items; total = after discount, plus VAT when it applies.
create or replace function quote_recalc(p_quote_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s numeric; q quotes;
begin
  select coalesce(sum(quantity * unit_price), 0) into s from quote_items where quote_id = p_quote_id and not recurring;
  select * into q from quotes where id = p_quote_id;
  if not found then return; end if;
  update quotes set
    subtotal = round(s, 2),
    total = round(greatest(0, s - case when q.discount_type = 'percent' then s * q.discount_value / 100 else q.discount_value end)
                  * case when q.include_vat then 1 + q.vat_rate / 100 else 1 end, 2)
  where id = p_quote_id;
end $$;

create or replace function quote_items_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform quote_recalc(coalesce(new.quote_id, old.quote_id));
  return null;
end $$;
create trigger quote_items_recalc after insert or update or delete on quote_items
  for each row execute function quote_items_changed();

create or replace function quote_terms_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform quote_recalc(new.id);
  return null;
end $$;
create trigger quotes_recalc after update of discount_type, discount_value, include_vat, vat_rate on quotes
  for each row execute function quote_terms_changed();

-- ---------- notifications through the bot ----------
-- A reminders row with remind_at = now() goes out on the bot's next minute tick.
create or replace function notify_partners(p_partner_id uuid, p_message text, p_at timestamptz default now())
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  insert into reminders (partner_id, remind_at, message) values (p_partner_id, p_at, p_message) returning id into rid;
  return rid;
end $$;

-- ---------- lead automation ----------
-- Stage moves are logged; a follow-up date becomes a 09:00 reminder for whoever follows the lead.
create or replace function leads_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  end if;
  -- Closed leads need no more follow-ups.
  if new.stage in ('won', 'lost') then new.next_follow_up_on := null; end if;
  if tg_op = 'INSERT' or new.next_follow_up_on is distinct from old.next_follow_up_on
     or new.follow_up_note is distinct from old.follow_up_note or new.owner_partner_id is distinct from old.owner_partner_id then
    if new.follow_up_reminder_id is not null then
      delete from reminders where id = new.follow_up_reminder_id and sent_at is null;
      new.follow_up_reminder_id := null;
    end if;
    if new.next_follow_up_on is not null and new.next_follow_up_on >= (now() at time zone 'Asia/Jerusalem')::date then
      new.follow_up_reminder_id := notify_partners(
        new.owner_partner_id,
        'פולואפ היום: ' || new.name || coalesce(' (' || new.company || ')', '') || coalesce(' · ' || new.follow_up_note, ''),
        (new.next_follow_up_on + time '09:00') at time zone 'Asia/Jerusalem');
    end if;
  end if;
  return new;
end $$;
create trigger leads_before before insert or update on leads for each row execute function leads_before_write();

create or replace function leads_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare labels constant jsonb := '{"new":"חדש","contacted":"בשיחה","meeting":"פגישה","quote_sent":"נשלחה הצעה","won":"נסגר","lost":"לא רלוונטי"}';
begin
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    insert into lead_activities (lead_id, kind, body, partner_id)
    values (new.id, 'stage', 'עבר לשלב: ' || (labels ->> new.stage),
            (select id from partners where user_id = auth.uid()));
  end if;
  return null;
end $$;
create trigger leads_after after update on leads for each row execute function leads_after_write();

-- ---------- quote automation ----------
create or replace function quotes_after_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  l leads;
  cid uuid;
  pid uuid;
  pname text;
  who text;
begin
  if new.status is not distinct from old.status then return null; end if;
  if new.lead_id is not null then select * into l from leads where id = new.lead_id; end if;
  who := coalesce(nullif(l.company, ''), l.name, new.recipient_name, 'הלקוח');

  if new.status = 'sent' then
    if new.project_id is not null then perform advance_project_stage(new.project_id, 'setup'); end if;
    if l.id is not null then
      if l.stage in ('new', 'contacted', 'meeting') then update leads set stage = 'quote_sent' where id = l.id; end if;
      insert into lead_activities (lead_id, kind, body) values (l.id, 'quote', 'הצעה ' || new.number || ' נשלחה');
    end if;

  elsif new.status = 'viewed' then
    if l.id is not null then
      insert into lead_activities (lead_id, kind, body) values (l.id, 'quote', 'הלקוח פתח את הצעה ' || new.number);
    end if;
    perform notify_partners(null, who || ' פתח/ה עכשיו את הצעת המחיר ' || new.number || ' (' || new.title || ').');

  elsif new.status = 'approved' then
    -- The lead becomes a client.
    cid := coalesce(new.client_id, l.client_id);
    if cid is null and l.id is not null then
      select id into cid from clients where lower(name) = lower(who);
      if cid is null then
        insert into clients (name, contact_name, phone, email)
        values (who, case when l.company is not null then l.name end, l.phone, l.email)
        returning id into cid;
      end if;
    end if;
    -- The project: the quote's own, the lead's, or a new one named after the quote.
    pid := coalesce(new.project_id, l.project_id);
    if pid is null then
      pname := new.title;
      if exists (select 1 from projects where name = pname) then pname := pname || ' · ' || new.number; end if;
      insert into projects (name, type, status, client_id, agreed_price, started_on)
      values (pname, 'client', 'setup', cid, new.total, current_date) returning id into pid;
    else
      update projects set agreed_price = coalesce(agreed_price, new.total), client_id = coalesce(client_id, cid) where id = pid;
      perform advance_project_stage(pid, 'setup');
    end if;
    update quotes set client_id = cid, project_id = pid where id = new.id;
    if l.id is not null then
      update leads set stage = 'won', client_id = cid, project_id = pid where id = l.id;
      insert into lead_activities (lead_id, kind, body)
      values (l.id, 'quote', 'הצעה ' || new.number || ' אושרה' || coalesce(' על ידי ' || new.signer_name, '') || coalesce(': ' || new.response_note, ''));
    end if;
    perform notify_partners(null, 'יש! ' || who || ' אישר/ה את הצעת המחיר ' || new.number || ' על ' || to_char(new.total, 'FM999,999,990') || ' ₪. הפרויקט עבר לשלב הקמה.');

  elsif new.status = 'rejected' then
    if l.id is not null then
      insert into lead_activities (lead_id, kind, body)
      values (l.id, 'quote', 'הצעה ' || new.number || ' נדחתה' || coalesce(': ' || new.response_note, ''));
    end if;
    perform notify_partners(null, who || ' דחה/תה את הצעת המחיר ' || new.number || coalesce('. כתב/ה: ' || new.response_note, '.'));
  end if;
  return null;
end $$;
create trigger quotes_status after update of status on quotes for each row execute function quotes_after_status();

-- Delivery to the client moves the project to implementation (forward only, never from the archive).
create or replace function projects_delivered() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.delivered_on is not null and old.delivered_on is null
     and new.status::text in ('planning', 'setup') then
    new.status := 'implementation';
  end if;
  return new;
end $$;
create trigger projects_delivered before update of delivered_on on projects
  for each row execute function projects_delivered();

-- ---------- what the client sees ----------
-- The public page reads one quote by its token. Drafts and cancelled quotes are never shown.
-- The first open marks the quote as viewed (only when a client opens it, not a partner previewing).
create or replace function get_public_quote(p_token text, p_track boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q quotes;
begin
  select * into q from quotes where public_token = p_token and kind = 'document' and status not in ('draft', 'cancelled');
  if not found then return null; end if;
  if p_track and not is_partner() then
    update quotes set view_count = view_count + 1,
      viewed_at = coalesce(viewed_at, now()),
      status = case when status = 'sent' then 'viewed' else status end
    where id = q.id returning * into q;
  end if;
  return jsonb_build_object(
    'number', q.number, 'recipient_name', q.recipient_name, 'title', q.title, 'intro', q.intro,
    'sections', q.sections, 'status', q.status, 'issued_on', q.issued_on, 'valid_until', q.valid_until,
    'expired', q.valid_until < (now() at time zone 'Asia/Jerusalem')::date,
    'discount_type', q.discount_type, 'discount_value', q.discount_value, 'include_vat', q.include_vat,
    'vat_rate', q.vat_rate, 'subtotal', q.subtotal, 'total', q.total, 'payment_terms', q.payment_terms,
    'timeline', q.timeline, 'signer_name', q.signer_name, 'responded_at', q.responded_at,
    'items', coalesce((select jsonb_agg(jsonb_build_object('description', description, 'details', details,
        'quantity', quantity, 'unit_price', unit_price, 'recurring', recurring) order by sort_order)
      from quote_items where quote_id = q.id), '[]'::jsonb));
end $$;

create or replace function respond_to_quote(p_token text, p_approve boolean, p_name text, p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare q quotes;
begin
  select * into q from quotes where public_token = p_token and kind = 'document' for update;
  if not found or q.status in ('draft', 'cancelled') then raise exception 'not_found'; end if;
  if q.status in ('approved', 'rejected') then return q.status; end if;
  if q.valid_until < (now() at time zone 'Asia/Jerusalem')::date then raise exception 'expired'; end if;
  if p_approve and coalesce(trim(p_name), '') = '' then raise exception 'name_required'; end if;
  update quotes set status = case when p_approve then 'approved' else 'rejected' end,
    responded_at = now(), signer_name = nullif(trim(p_name), ''), response_note = nullif(trim(p_note), '')
  where id = q.id;
  return case when p_approve then 'approved' else 'rejected' end;
end $$;

-- Trigger helpers are not API calls.
revoke execute on function quote_number_next(), quote_items_changed(), quote_terms_changed(), leads_before_write(),
  leads_after_write(), quotes_after_status(), projects_delivered() from public, anon, authenticated;
revoke execute on function quote_recalc(uuid), notify_partners(uuid, text, timestamptz) from public, anon, authenticated;
-- The two public functions are the only way in for someone who is not signed in.
grant execute on function get_public_quote(text, boolean), respond_to_quote(text, boolean, text, text) to anon, authenticated;

-- ---------- the interactive proposal portal ----------
-- Same shape as the portal's tables in the old aRLi CRM project, plus quote_id / template.
-- The portal writes with the service role (it bypasses RLS); partners read everything here.
create table proposal_links (
  id          uuid primary key default gen_random_uuid(),
  token       text unique not null default encode(gen_random_bytes(12), 'hex'), -- the client's link
  client_name text not null,
  template    text,                               -- which renderer the portal uses
  quote_id    uuid unique references quotes (id) on delete cascade,
  lead_id     uuid references leads (id) on delete set null,
  is_active   boolean not null default true,
  expires_at  timestamptz,
  admin_key   text unique not null default encode(gen_random_bytes(16), 'hex'), -- the portal's own intel page
  created_at  timestamptz not null default now()
);

create table proposal_sessions (
  id                uuid primary key default gen_random_uuid(),
  link_id           uuid not null references proposal_links (id) on delete cascade,
  started_at        timestamptz not null default now(),
  last_seen_at      timestamptz,
  locale            text,
  user_agent        text,
  completed_at      timestamptz,
  recommended_track text
);
create index on proposal_sessions (link_id);

create table proposal_events (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references proposal_sessions (id) on delete cascade,
  type            text not null,  -- view / step_view / answer / chapter_view / lang_toggle / whatsapp_click / submit ...
  payload         jsonb,
  client_event_id text,
  created_at      timestamptz not null default now(),
  unique (session_id, client_event_id)
);
create index on proposal_events (session_id, created_at);

do $$
declare t text;
begin
  foreach t in array array['proposal_links', 'proposal_sessions', 'proposal_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy partners_only on %I for all to authenticated using (is_partner()) with check (is_partner())', t);
  end loop;
end $$;

-- A portal quote gets its link as it is created.
create or replace function quotes_portal_link() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'portal' then
    insert into proposal_links (client_name, template, quote_id, lead_id, token)
    values (coalesce(new.recipient_name, new.title), new.portal_template, new.id, new.lead_id, new.public_token)
    on conflict (quote_id) do nothing;
  end if;
  return null;
end $$;
create trigger quotes_portal_link after insert or update of kind on quotes
  for each row execute function quotes_portal_link();

-- The client opened the portal: the quote reads as viewed (a draft is a partner testing, so it is left alone).
create or replace function proposal_session_opened() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update quotes set view_count = view_count + 1, viewed_at = coalesce(viewed_at, now()),
    status = case when status = 'sent' then 'viewed' else status end
  where id = (select quote_id from proposal_links where id = new.link_id) and status <> 'draft';
  return null;
end $$;
create trigger proposal_session_opened after insert on proposal_sessions
  for each row execute function proposal_session_opened();

-- The client sent the summary at the end of the portal. A chosen slot goes straight into the team calendar.
create or replace function proposal_submitted() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  q quotes; l leads; who text; slot_at timestamptz; mid uuid; slot_text text;
begin
  if new.type <> 'submit' then return null; end if;
  select qq.* into q from quotes qq
    join proposal_links pl on pl.quote_id = qq.id
    join proposal_sessions ps on ps.link_id = pl.id
  where ps.id = new.session_id;
  if q.id is null or q.status = 'draft' then return null; end if;
  if q.lead_id is not null then select * into l from leads where id = q.lead_id; end if;
  who := coalesce(nullif(l.company, ''), l.name, q.recipient_name, 'הלקוח');
  slot_text := new.payload -> 'slot' ->> 'display';
  begin
    slot_at := ((new.payload -> 'slot' ->> 'iso')::timestamp) at time zone 'Asia/Jerusalem';
  exception when others then slot_at := null;
  end;
  if slot_at is not null and q.meeting_id is null then
    insert into meetings (title, starts_at, ends_at, kind, project_id, notes)
    values ('פגישת אפיון · ' || who, slot_at, slot_at + interval '1 hour', 'meeting', q.project_id,
            'נקבעה מתוך פורטל ההצעה ' || q.number)
    returning id into mid;
  end if;
  update quotes set submitted_at = coalesce(submitted_at, now()), meeting_id = coalesce(meeting_id, mid) where id = q.id;
  if l.id is not null then
    insert into lead_activities (lead_id, kind, body)
    values (l.id, 'quote', 'שלח/ה סיכום מפורטל ההצעה ' || q.number || coalesce(' וקבע/ה פגישה: ' || slot_text, ''));
  end if;
  perform notify_partners(null, who || ' סיים/ה את פורטל ההצעה ' || q.number || ' ושלח/ה סיכום'
    || coalesce('. נקבעה פגישה: ' || slot_text || ' (כבר ביומן)', '. לא נבחר מועד לפגישה, כדאי לחזור אליו/ה.'));
  return null;
end $$;
create trigger proposal_submitted after insert on proposal_events
  for each row execute function proposal_submitted();

revoke execute on function quotes_portal_link(), proposal_session_opened(), proposal_submitted() from public, anon, authenticated;
