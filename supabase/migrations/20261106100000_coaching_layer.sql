-- Business coaching layer, stage 1: principle sentences shown on the home screen,
-- and a rhythm of rituals (weekly sync, monthly brief, quarterly goals, ...) that the
-- secretary bot reminds about. Reminders go through the existing `reminders` table,
-- so the bot's per-minute cron sends them (and keeps Shabbat quiet) with no bot change.

create table rituals (
  id          uuid primary key default gen_random_uuid(),
  key         text unique not null,
  title       text not null,
  description text,                       -- the short agenda, sent with the reminder
  cadence     text not null check (cadence in ('daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
  weekday     smallint check (weekday between 0 and 6), -- 0 = Sunday. daily: ignored (runs Sun-Thu)
  month       smallint check (month between 1 and 12),   -- yearly only
  at_time     time not null default '09:00',
  lead_days   smallint not null default 0 check (lead_days between 0 and 14), -- extra heads-up N days before
  duration    text,
  source      text,                       -- the framework behind it, shown in the app
  active      boolean not null default true,
  sort        smallint not null default 0,
  last_done_on        date,
  reminded_lead_for   date,               -- occurrence the heads-up was sent for
  reminded_day_for    date,               -- occurrence the same-day reminder was sent for
  created_at  timestamptz not null default now()
);

create table principles (
  id         uuid primary key default gen_random_uuid(),
  text       text not null,
  theme      text not null check (theme in ('goals', 'execution', 'growth', 'partnership')),
  why        text,                        -- one line on the foundation behind it
  ritual_key text references rituals (key) on update cascade on delete set null, -- shown more around that ritual
  favorite   boolean not null default false,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table rituals    enable row level security;
alter table principles enable row level security;
create policy partners_only on rituals    for all to authenticated using (is_partner()) with check (is_partner());
create policy partners_only on principles for all to authenticated using (is_partner()) with check (is_partner());

-- Does ritual r fall on day d?
create or replace function ritual_on(r rituals, d date) returns boolean
language sql immutable as $$
  select case r.cadence
    when 'daily'     then extract(dow from d) between 0 and 4
    when 'weekly'    then extract(dow from d) = r.weekday
    when 'monthly'   then extract(dow from d) = r.weekday and extract(day from d) <= 7
    when 'quarterly' then extract(dow from d) = r.weekday and extract(month from d) in (3, 6, 9, 12)
                          and extract(month from d + 7) <> extract(month from d)
    when 'yearly'    then extract(dow from d) = r.weekday and extract(month from d) = r.month and extract(day from d) between 8 and 14
  end;
$$;

-- The next day (from `from_day`, inclusive) the ritual falls on.
create or replace function ritual_next(r rituals, from_day date) returns date
language plpgsql immutable as $$
declare d date := from_day;
begin
  for i in 0..400 loop
    if ritual_on(r, d) then return d; end if;
    d := d + 1;
  end loop;
  return null;
end $$;

create view ritual_schedule with (security_invoker = true) as
  select r.*, ritual_next(r, (now() at time zone 'Asia/Jerusalem')::date) as next_on
  from rituals r;

-- Called by pg_cron. Queues the heads-up and the same-day reminder for each active ritual.
create or replace function queue_ritual_reminders() returns integer
language plpgsql security definer set search_path = public as $$
declare
  local_now timestamp := now() at time zone 'Asia/Jerusalem';
  today date := local_now::date;
  r rituals;
  nxt date;
  line text;
  n integer := 0;
  app constant text := 'https://management.arli.co.il';
begin
  for r in select * from rituals where active loop
    -- Same-day reminder, at the ritual's time.
    if ritual_on(r, today) and local_now::time >= r.at_time and r.reminded_day_for is distinct from today then
      select p.text into line from principles p
        where p.active and (p.ritual_key = r.key or p.ritual_key is null)
        order by (p.ritual_key = r.key) desc nulls last, random() limit 1;
      insert into reminders (partner_id, remind_at, message)
      values (null, now(),
        r.title || ' היום' || coalesce(' (' || r.duration || ')', '') || '.' ||
        coalesce(E'\n' || r.description, '') ||
        coalesce(E'\n\n«' || line || '»', '') ||
        E'\n' || app);
      update rituals set reminded_day_for = today where id = r.id;
      n := n + 1;
    end if;

    -- Heads-up a few days before, so there is time to set a date together.
    if r.lead_days > 0 then
      nxt := ritual_next(r, today + 1);
      if nxt = today + r.lead_days and local_now::time >= r.at_time and r.reminded_lead_for is distinct from nxt then
        insert into reminders (partner_id, remind_at, message)
        values (null, now(),
          r.title || ' בעוד ' || r.lead_days || ' ימים, ב-' ||
          to_char(nxt, 'DD/MM') || '. כדאי לשריין זמן ביומן.');
        update rituals set reminded_lead_for = nxt where id = r.id;
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end $$;

revoke execute on function queue_ritual_reminders() from public, anon, authenticated;

select cron.schedule('ritual-reminders', '*/5 * * * *', $$ select public.queue_ritual_reminders(); $$);

-- Seed: the rhythm agreed in the proposal. Daily focus is off until the partners turn it on.
insert into rituals (key, title, description, cadence, weekday, month, at_time, lead_days, duration, source, active, sort) values
  ('daily_focus', 'פוקוס יומי',
   'לבחור 3 משימות חשובות להיום. בערב: מה קידמתי היום?',
   'daily', null, null, '08:30', 0, '2 דקות', 'עקרון ההתקדמות (Amabile), מטריצת אייזנהאואר', false, 1),
  ('weekly_sync', 'סנכרון שבועי',
   'ניצחונות של השבוע שעבר · מצב היעדים (במסלול / לא במסלול) · עד 3 משימות פוקוס לכל אחת · נושא אחד לפתור',
   'weekly', 0, null, '09:00', 0, '30-45 דקות', 'EOS Level 10, 12 Week Year', true, 2),
  ('week_close', 'סגירת שבוע',
   'לרוקן את תיבת הרעיונות · לרשום שעות שחסרות · ירוק / צהוב / אדום לכל פרויקט פעיל',
   'weekly', 4, null, '14:00', 0, '10 דקות', 'GTD Weekly Review, בריאות לקוח', true, 3),
  ('monthly_brief', 'בריף חודשי',
   'המספרים של החודש (הכנסות, הוצאות, רווח, שעות) · מה הלך טוב, מה פחות, מה משנות · שיחת שותפות קצרה · 3 פוקוסים לחודש הבא',
   'monthly', 0, null, '10:00', 3, 'שעה-שעתיים', 'Monthly Business Review, Same Page Meeting (Rocket Fuel), תחקיר', true, 4),
  ('quarterly_goals', 'קביעת יעדים רבעונית',
   'ציון היעדים שנגמרו · תחקיר הרבעון · 1-3 מטרות חדשות עם תוצאות מדידות ובעלת בית · סקירת 80/20 של הלקוחות',
   'quarterly', 0, null, '10:00', 14, 'חצי יום', 'OKR, EOS Rocks', true, 5),
  ('annual_planning', 'תכנון שנתי',
   'סיכום השנה · עמוד החזון (ערכים, מיקוד, התמונה בעוד 3 שנים) · יעדי שנה · תקציב · עדכון הסכמות השותפות',
   'yearly', 0, 12, '10:00', 14, 'יום מלא', 'EOS V/TO, BHAG', true, 6);

insert into principles (text, theme, why, ritual_key) values
  ('יעד ברור ומאתגר עדיף על יעד נוח ומעורפל.', 'goals', 'תאוריית היעדים של Locke ו-Latham: כ-400 מחקרים.', 'quarterly_goals'),
  ('מה שלא נמדד הוא משאלה, לא יעד.', 'goals', 'OKR: כל מטרה נמדדת ב-2 עד 4 תוצאות.', 'quarterly_goals'),
  ('מעט עדיפויות שנגמרו שוות יותר מהרבה שהתחילו.', 'goals', 'EOS Rocks: מעט עדיפויות לרבעון.', 'weekly_sync'),
  ('לכל יעד בעלת בית אחת. שתיים אחראיות זה אף אחת.', 'goals', 'EOS: בעלות אחת לכל עדיפות.', 'quarterly_goals'),
  ('שתים עשרה שבועות זה מספיק ארוך כדי להשפיע, ומספיק קצר כדי להרגיש דחיפות.', 'goals', 'The 12 Week Year.', 'quarterly_goals'),
  ('יעד מאתגר שלא הושג במלואו הוא עדיין צמיחה.', 'goals', 'OKR: 70% ביעד שאפתני נחשב הצלחה.', 'quarterly_goals'),
  ('קודם מסיימות, אחר כך מתחילות.', 'execution', 'קנבן: פחות עבודה במקביל, יותר דברים שנגמרים.', 'week_close'),
  ('הדחוף צועק, החשוב מחכה בשקט. תקשיבו לשקט.', 'execution', 'מטריצת אייזנהאואר ו"אפקט הדחיפות".', 'daily_focus'),
  ('משימה בלי תאריך היא רק רעיון.', 'execution', 'Ariely: דדליינים ברורים משפרים ביצוע.', null),
  ('מחליטות מתי ואיפה, והעשייה נעשית קלה יותר.', 'execution', 'כוונות יישום (Gollwitzer): 94 ניסויים.', 'daily_focus'),
  ('מה שבראש לא במערכת. רושמות ומשחררות.', 'execution', 'Getting Things Done.', 'week_close'),
  ('זמן מרוכז צריך דלת סגורה, לא חלון שמקווים שייפתח.', 'execution', 'Deep Work ומחקר "שארית הקשב".', 'daily_focus'),
  ('"גמור" זה: עובד, אושר על ידי הלקוח, והופקה חשבונית.', 'execution', 'Agile: Definition of Done.', null),
  ('ניצחון קטן היום שווה יותר מתוכנית גדולה ליום אחד.', 'growth', 'עקרון ההתקדמות (Amabile): 12,000 יומנים.', 'daily_focus'),
  ('מומנטום נבנה מצעדים קטנים שחוזרים על עצמם.', 'growth', 'עקרון ההתקדמות.', 'weekly_sync'),
  ('פספוס אחד זה אנושי. פספוס שני כבר יוצר הרגל.', 'growth', 'מחקר ההרגלים של Lally.', null),
  ('זמן למידה הוא זמן שמשריינים מראש, לא מה שנשאר.', 'growth', '70/20/10, "להשחיז את המסור".', null),
  ('כל פרויקט מלמד אותנו משהו שניקח לבא אחריו.', 'growth', 'תחקיר: שיפור של כ-20% בביצוע.', 'monthly_brief'),
  ('מסכימות בפנים, מופיעות כאחת בחוץ.', 'partnership', 'Rocket Fuel: חמשת הכללים לשותפות.', 'monthly_brief'),
  ('קודם מפרישות רווח, ואז מנהלות את מה שנשאר.', 'partnership', 'Profit First.', 'monthly_brief'),
  ('המספרים פותחים את השיחה, לא מחליפים אותה.', 'partnership', 'Monthly Business Review.', 'monthly_brief'),
  ('מוצאות את ה-20% שמניבים את רוב התוצאה, ושומרות עליהם.', 'partnership', 'עקרון פארטו.', 'quarterly_goals'),
  ('בודקות את מצב הלקוח כשהכל ירוק. צהוב זה כבר זמן לפעול.', 'partnership', 'בריאות לקוח (Customer Success).', 'week_close'),
  ('חזון בלי קצב קבוע נשאר שקף יפה.', 'partnership', 'Scaling Up: מקצב פגישות קבוע.', 'annual_planning');
