// aRLi management Telegram bot.
// Routes:
//   POST (from Telegram, with secret header)  -> handle a message
//   GET  ?action=setup                         -> register the webhook and commands
//   POST ?action=cron (x-cron-secret header)   -> send due reminders
//   GET  .../telegram-bot/gmail/callback       -> Google sign-in redirect (connects a partner's Gmail + Calendar)
//   POST ?action=calendar_sync (x-cron-secret)  -> run the Google Calendar sync now
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { CALENDAR_SCOPE, GMAIL_SCOPE, googleToken, runCalendarSync } from "./gcal.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_MODELS = [Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest", "gemini-2.5-flash"];
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TZ = "Asia/Jerusalem";
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const BOT_USERNAME = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "aRLi_Management_bot";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
const GMAIL_REDIRECT_URI = `${SUPABASE_URL}/functions/v1/telegram-bot/gmail/callback`;

type Partner = { id: string; name: string; telegram_chat_id: number | null };

// ---------- helpers ----------
async function webhookSecret(): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function tg(method: string, body: unknown) {
  const r = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function send(chatId: number, text: string, replyMarkup?: unknown) {
  // Telegram limit is 4096 characters per message. Buttons go on the last chunk.
  for (let i = 0; i < text.length; i += 4000) {
    const last = i + 4000 >= text.length;
    await tg("sendMessage", {
      chat_id: chatId, text: text.slice(i, i + 4000),
      ...(last && replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

function israelNow() {
  const d = new Date();
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long",
  }).formatToParts(d);
  const get = (t: string) => local.find((p) => p.type === t)?.value ?? "";
  const offset = new Intl.DateTimeFormat("en", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") || "+02:00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    hour: Number(get("hour")),
    weekday: get("weekday"),
    offset,
  };
}

const fmtMoney = (n: number) => `${Number(n).toLocaleString("he-IL", { maximumFractionDigits: 2 })} ₪`;
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("he-IL", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });

async function partners(): Promise<Partner[]> {
  const { data } = await db.from("partners").select("id,name,telegram_chat_id");
  return data ?? [];
}

async function partnerByName(name?: string): Promise<Partner | null> {
  if (!name) return null;
  const all = await partners();
  return all.find((p) => name.includes(p.name) || p.name.includes(name)) ?? null;
}

async function projectByName(name?: string): Promise<{ id: string; name: string; client_id: string | null } | null> {
  if (!name) return null;
  const { data } = await db.from("projects").select("id,name,client_id").ilike("name", `%${name}%`).limit(2);
  if (!data?.length) throw new Error(`לא נמצא פרויקט בשם "${name}". אפשר לבקש רשימת פרויקטים.`);
  if (data.length > 1) {
    const exact = data.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
    throw new Error(`יש יותר מפרויקט אחד שמתאים ל-"${name}": ${data.map((p) => p.name).join(", ")}`);
  }
  return data[0];
}

// "מירי" / "ריקי" -> her id; "שתינו" or nothing -> [] (both), unless a default partner is given.
async function whoToIds(who: string | undefined, fallback: Partner | null): Promise<string[]> {
  if (who === "שתינו") return [];
  const p = who ? await partnerByName(who) : fallback;
  return p ? [p.id] : [];
}

// Events and Google busy blocks that overlap a time, for the people taking part.
async function findConflicts(startsAt: string, endsAt: string, partnerIds: string[]) {
  const all = await partners();
  const ids = partnerIds.length ? partnerIds : all.map((p) => p.id);
  const end = endsAt > startsAt ? endsAt : new Date(new Date(startsAt).getTime() + 3600e3).toISOString();
  const { data: evs } = await db.from("meetings").select("id,title,starts_at,ends_at,partner_ids,all_day")
    .lt("starts_at", end).gte("starts_at", new Date(new Date(startsAt).getTime() - 864e5).toISOString());
  const out: { id?: string; title: string; local: string; who?: string }[] = [];
  for (const m of evs ?? []) {
    const mEnd = m.ends_at ?? new Date(new Date(m.starts_at).getTime() + 3600e3).toISOString();
    if (m.all_day || mEnd <= startsAt) continue;
    if (m.partner_ids?.length && !m.partner_ids.some((x: string) => ids.includes(x))) continue;
    out.push({ id: m.id, title: m.title, local: fmtDateTime(m.starts_at) });
  }
  const { data: busy } = await db.from("partner_busy").select("partner_id,starts_at,ends_at")
    .in("partner_id", ids).lt("starts_at", end).gt("ends_at", startsAt);
  for (const b of busy ?? []) {
    out.push({ title: "תפוסה ביומן האישי", local: fmtDateTime(b.starts_at), who: all.find((p) => p.id === b.partner_id)?.name });
  }
  return out.slice(0, 6);
}

async function googleSynced(): Promise<boolean> {
  const { data } = await db.from("app_config").select("value").eq("key", "gcal_calendar_id").maybeSingle();
  return !!data;
}

async function notifyOthers(me: Partner, text: string) {
  for (const p of await partners()) {
    if (p.id !== me.id && p.telegram_chat_id) await send(p.telegram_chat_id, text);
  }
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

// Shared tasks plus this partner's own private ones. The other partner's private tasks never reach the bot.
const visibleTasks = (me: Partner) => `is_private.eq.false,assignee_partner_id.eq.${me.id}`;

// Passwords, API keys and card numbers never go into memory.
const looksSecret = (t: string) =>
  /(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b|סיסמ|password)/i.test(t);

async function memoriesFor(me: Partner) {
  return check(await db.from("bot_memories").select("id,content,kind,partner_id")
    .or(`partner_id.is.null,partner_id.eq.${me.id}`).order("created_at", { ascending: false }).limit(80)) as
    { id: string; content: string; kind: string; partner_id: string | null }[];
}

// ---------- tools the model can call ----------
const S = (type: string, description?: string, extra: Record<string, unknown> = {}) => ({ type, description, ...extra });
const PARTNER = S("string", "שם השותפה", { enum: ["מירי", "ריקי"] });

const toolDeclarations = [
  {
    name: "add_expense",
    description: "רישום הוצאה. אם לא נאמר אחרת, מי ששילמה היא השותפה שכותבת. בלי פרויקט = הוצאה כללית של העסק.",
    parameters: S("object", undefined, {
      properties: {
        amount: S("number", "סכום בשקלים"),
        description: S("string", "על מה ההוצאה"),
        spent_on: S("string", "תאריך YYYY-MM-DD"),
        project_name: S("string"),
        paid_by: PARTNER,
        category: S("string", "קטגוריה, למשל תוכנה, ציוד, נסיעות, פרסום"),
        reference: S("string", "מספר חשבונית או אסמכתה"),
        notes: S("string", "הערה, למשל הסכום המקורי במטבע זר"),
        attach_receipt: S("boolean", "לצרף את הקובץ שנשלח בהודעה הזו כקבלה"),
        gmail_message_id: S("string", "כשההוצאה היא חשבונית מ-Gmail: message_id מתוך read_gmail_invoice"),
        receipt_path: S("string", "כשההוצאה היא חשבונית מ-Gmail: receipt_path מתוך read_gmail_invoice"),
      },
      required: ["amount", "description"],
    }),
  },
  {
    name: "add_income",
    description: "רישום הכנסה מלקוח. אם לא נאמר אחרת, מי שקיבלה היא השותפה שכותבת.",
    parameters: S("object", undefined, {
      properties: {
        amount: S("number"), received_on: S("string", "YYYY-MM-DD"), project_name: S("string"),
        received_by: PARTNER, method: S("string", "העברה, ביט, צ'ק, מזומן"), notes: S("string"),
      },
      required: ["amount"],
    }),
  },
  {
    name: "add_settlement",
    description: "רישום העברת כסף בין השותפות (התחשבנות).",
    parameters: S("object", undefined, {
      properties: { amount: S("number"), from: PARTNER, to: PARTNER, settled_on: S("string"), notes: S("string") },
      required: ["amount", "from", "to"],
    }),
  },
  {
    name: "add_task",
    description: "יצירת משימה. ברירת המחדל היא משימה כללית שגלויה לשתי השותפות. משימה אישית רק כשהשותפה אומרת במפורש שהיא אישית.",
    parameters: S("object", undefined, {
      properties: {
        title: S("string"), description: S("string"), project_name: S("string"),
        assignee: PARTNER, due_on: S("string", "YYYY-MM-DD"),
        priority: S("integer", "1 גבוהה, 2 רגילה, 3 נמוכה"),
        private: S("boolean", "true רק כשהשותפה אמרה במפורש \"אישי\", \"אישית\" או \"פרטי\". המשימה תהיה של השותפה שכותבת, והשותפה השנייה לא תראה אותה."),
      },
      required: ["title"],
    }),
  },
  {
    name: "update_task",
    description: "שינוי סטטוס או תאריך של משימה קיימת. id מתוך list_tasks.",
    parameters: S("object", undefined, {
      properties: {
        task_id: S("string"), status: S("string", undefined, { enum: ["todo", "in_progress", "done"] }),
        due_on: S("string"), assignee: PARTNER,
        private: S("boolean", "להפוך לאישית (true, של השותפה שכותבת) או לכללית (false)"),
      },
      required: ["task_id"],
    }),
  },
  {
    name: "add_meeting",
    description: "קביעת אירוע ביומן המשותף (מסונכרן ל-Google Calendar). starts_at בפורמט ISO עם אזור הזמן של ישראל. " +
      "kind: meeting לפגישה, focus לבלוק עבודה (זמן חסום לעבודה על פרויקט או משימה), away ל\"לא זמינה\" (חופש, רופא, פרטי). " +
      "הכלי מחזיר התנגשויות אם יש; אם יש, ספרי עליהן ושאלי אם להשאיר או להזיז.",
    parameters: S("object", undefined, {
      properties: {
        title: S("string"), starts_at: S("string"), ends_at: S("string", "ברירת מחדל: שעה אחרי ההתחלה"),
        all_day: S("boolean", "אירוע של יום שלם (למשל חופש)"),
        kind: S("string", undefined, { enum: ["meeting", "focus", "away"] }),
        who: S("string", "מי משתתפת: מירי, ריקי או שתינו (ברירת מחדל: שתינו בפגישה, הכותבת בבלוק עבודה ובלא זמינה)", { enum: ["מירי", "ריקי", "שתינו"] }),
        location: S("string"), project_name: S("string"), notes: S("string", "אג'נדה או הערות"),
        task_id: S("string", "כשחוסמים זמן למשימה קיימת: ה-id שלה מ-list_tasks"),
        meet: S("boolean", "ליצור קישור Google Meet (ברירת מחדל: כן לפגישה אונליין בלי מקום פיזי)"),
      },
      required: ["title", "starts_at"],
    }),
  },
  {
    name: "update_meeting",
    description: "הזזה, שינוי או ביטול של אירוע ביומן. קודם מוצאים אותו עם list_schedule (שם מופיע ה-id). cancel=true מוחק אותו (גם מגוגל), רק אחרי אישור.",
    parameters: S("object", undefined, {
      properties: {
        id: S("string"), title: S("string"), starts_at: S("string"), ends_at: S("string"),
        location: S("string"), notes: S("string"), who: S("string", undefined, { enum: ["מירי", "ריקי", "שתינו"] }),
        kind: S("string", undefined, { enum: ["meeting", "focus", "away"] }),
        meet: S("boolean", "להוסיף קישור Google Meet"), cancel: S("boolean"),
      },
      required: ["id"],
    }),
  },
  {
    name: "find_free_time",
    description: "מציאת חלונות זמן פנויים (ימים א-ה 9:00-18:00, ו׳ עד 13:00), לפי היומן המשותף ולפי התפוס/פנוי ביומני הגוגל האישיים. " +
      "לשאלות כמו \"מתי שתינו פנויות השבוע?\" או \"מתי אפשר לקבוע עם עקיבא?\". הציעי 3-4 אפשרויות ושאלי מה לקבוע.",
    parameters: S("object", undefined, {
      properties: {
        from: S("string", "תאריך התחלה YYYY-MM-DD, ברירת מחדל היום"), days: S("integer", "כמה ימים קדימה, ברירת מחדל 7"),
        minutes: S("integer", "אורך בדקות, ברירת מחדל 60"), who: S("string", undefined, { enum: ["מירי", "ריקי", "שתינו"] }),
      },
    }),
  },
  {
    name: "add_reminder",
    description: "תזכורת שהבוט ישלח בזמן מסוים. remind_at בפורמט ISO עם אזור הזמן של ישראל.",
    parameters: S("object", undefined, {
      properties: {
        message: S("string"), remind_at: S("string"),
        for_whom: S("string", "למי לשלוח", { enum: ["מירי", "ריקי", "שתינו"] }),
      },
      required: ["message", "remind_at"],
    }),
  },
  {
    name: "log_time",
    description: "דיווח זמן עבודה או למידה. אם לא נאמר אחרת, על השותפה שכותבת.",
    parameters: S("object", undefined, {
      properties: {
        minutes: S("integer"), project_name: S("string"),
        kind: S("string", undefined, { enum: ["work", "learning"] }),
        work_date: S("string"), description: S("string"), partner: PARTNER,
      },
      required: ["minutes"],
    }),
  },
  {
    name: "add_project",
    description: "פרויקט חדש. סוג: business עסקי, learning למידה, client לקוח.",
    parameters: S("object", undefined, {
      properties: {
        name: S("string"), type: S("string", undefined, { enum: ["business", "learning", "client"] }),
        client_name: S("string"), agreed_price: S("number"), notes: S("string"),
      },
      required: ["name", "type"],
    }),
  },
  {
    name: "update_project",
    description: "עדכון פרויקט: שלב (בתכנון, בהקמה, בהטמעה, פעיל, ארכיון), מחיר מוסכם, או חלוקת רווח (אחוז של מירי, ריקי מקבלת את השאר).",
    parameters: S("object", undefined, {
      properties: {
        project_name: S("string"),
        status: S("string", "שלב: planning=בתכנון, setup=בהקמה, implementation=בהטמעה, active=פעיל, archived=ארכיון", { enum: ["planning", "setup", "implementation", "active", "archived"] }),
        agreed_price: S("number"),
        miri_percent: S("number", "אחוז הרווח של מירי, 0 עד 100"),
      },
      required: ["project_name"],
    }),
  },
  { name: "get_balance", description: "ההתחשבנות בין שלושה צדדים: העסק, מירי וריקי. כמה כל אחת השקיעה, מה הרווח של העסק, כמה כל אחת קיבלה, ומי מעבירה למי כדי להתאזן.", parameters: S("object", undefined, { properties: {} }) },
  {
    name: "list_projects", description: "רשימת פרויקטים עם הכנסות, הוצאות ורווח.",
    parameters: S("object", undefined, { properties: { status: S("string", "שלב: planning=בתכנון, setup=בהקמה, implementation=בהטמעה, active=פעיל, archived=ארכיון", { enum: ["planning", "setup", "implementation", "active", "archived"] }) } }),
  },
  {
    name: "list_transactions",
    description: "רשימת הוצאות או הכנסות עם סינון.",
    parameters: S("object", undefined, {
      properties: {
        kind: S("string", undefined, { enum: ["expenses", "income"] }),
        from: S("string", "YYYY-MM-DD"), to: S("string", "YYYY-MM-DD"),
        project_name: S("string"), partner: PARTNER, limit: S("integer"),
      },
      required: ["kind"],
    }),
  },
  {
    name: "list_tasks", description: "רשימת משימות פתוחות (או לפי סטטוס).",
    parameters: S("object", undefined, {
      properties: { status: S("string", undefined, { enum: ["todo", "in_progress", "done"] }), assignee: PARTNER, project_name: S("string") },
    }),
  },
  {
    name: "list_schedule", description: "פגישות ותזכורות בטווח תאריכים.",
    parameters: S("object", undefined, { properties: { from: S("string"), to: S("string") } }),
  },
  {
    name: "time_report", description: "סיכום שעות לפי פרויקט ולפי עבודה/למידה בטווח תאריכים.",
    parameters: S("object", undefined, { properties: { from: S("string"), to: S("string"), partner: PARTNER } }),
  },
  {
    name: "connect_google",
    description: "שולח לשותפה כפתור לחיבור חשבון ה-Google שלה: Gmail (קריאה בלבד, לחשבוניות) ו-Google Calendar (סנכרון היומן המשותף ותפוס/פנוי). להשתמש כשהיא מבקשת לחבר את הג'ימייל או היומן, או כשכלי מחזיר שאין חיבור.",
    parameters: S("object", undefined, { properties: {} }),
  },
  {
    name: "disconnect_gmail",
    description: "ניתוק תיבת ה-Gmail של השותפה מהבוט ומחיקת ההרשאה.",
    parameters: S("object", undefined, { properties: {} }),
  },
  {
    name: "search_gmail_invoices",
    description: "חיפוש מיילים בתיבת ה-Gmail של השותפה שכותבת, לפי תחביר החיפוש של Gmail. מחזיר רשימת מיילים עם קבצים מצורפים, ומסמן מה כבר נרשם במערכת.",
    parameters: S("object", undefined, {
      properties: {
        query: S("string", "שאילתת Gmail, למשל: from:vercel after:2026/10/01 before:2026/11/01 (invoice OR receipt OR חשבונית OR קבלה)"),
        max_results: S("integer", "עד 20, ברירת מחדל 10"),
      },
      required: ["query"],
    }),
  },
  {
    name: "read_gmail_invoice",
    description: "קורא מייל אחד מתוך search_gmail_invoices: שומר את החשבונית המצורפת כקבלה ומחלץ ממנה ספק, סכום, מטבע, תאריך ומספר חשבונית. לא רושם כלום במערכת.",
    parameters: S("object", undefined, {
      properties: {
        message_id: S("string"),
        attachment_name: S("string", "אם יש כמה קבצים מצורפים, איזה מהם לקרוא"),
      },
      required: ["message_id"],
    }),
  },
  {
    name: "remember_fact",
    description: "שמירת עובדה לטווח ארוך, כשהשותפה אומרת \"תזכרי ש...\" או מספרת משהו קבוע שיעזור בהמשך (העדפה, איש קשר, החלטה). לא לשמור סיסמאות, מפתחות או מספרי כרטיס.",
    parameters: S("object", undefined, {
      properties: {
        content: S("string", "העובדה במשפט אחד ברור, בגוף שלישי"),
        kind: S("string", undefined, { enum: ["fact", "preference", "person", "project", "decision"] }),
        shared: S("boolean", "true כשזו עובדה על העסק ששתי השותפות צריכות. ברירת מחדל: אישית לשותפה שכותבת."),
      },
      required: ["content"],
    }),
  },
  {
    name: "forget_fact",
    description: "מחיקת עובדה מהזיכרון, כשהשותפה מבקשת לשכוח משהו או מתקנת עובדה שגויה. id מתוך רשימת הזיכרון בהנחיות.",
    parameters: S("object", undefined, { properties: { id: S("string") }, required: ["id"] }),
  },
  {
    name: "add_project_note",
    description: "הערה על פרויקט: החלטה, מה סוכם עם הלקוח, מה נבנה, מה הצעד הבא.",
    parameters: S("object", undefined, {
      properties: { project_name: S("string"), content: S("string") },
      required: ["project_name", "content"],
    }),
  },
  {
    name: "get_project_notes",
    description: "כל מה שידוע על פרויקט: פרטים, מצב כספי, משימות פתוחות והערות. להשתמש לפני הצעת מחיר, סיכום או תשובה על \"מה המצב ב...\".",
    parameters: S("object", undefined, { properties: { project_name: S("string") }, required: ["project_name"] }),
  },
  {
    name: "delete_record",
    description: "מחיקת רשומה שנרשמה בטעות. רק אחרי שהשותפה אישרה במפורש.",
    parameters: S("object", undefined, {
      properties: {
        table: S("string", undefined, { enum: ["expenses", "income", "settlements", "tasks", "meetings", "reminders", "time_entries"] }),
        id: S("string"),
      },
      required: ["table", "id"],
    }),
  },
];

type Created = { table: string; id: string; label: string };
type Ctx = { me: Partner; receiptPath: string | null; today: string; created?: Created[] };

// Records the bot creates, so it can offer an undo button after it answers.
const UNDOABLE: Record<string, { table: string; label: string }> = {
  add_expense: { table: "expenses", label: "הוצאה" },
  add_income: { table: "income", label: "הכנסה" },
  add_settlement: { table: "settlements", label: "העברה" },
  add_task: { table: "tasks", label: "משימה" },
  remember_fact: { table: "bot_memories", label: "זיכרון" },
  add_project_note: { table: "project_notes", label: "הערה" },
  add_meeting: { table: "meetings", label: "פגישה" },
  add_reminder: { table: "reminders", label: "תזכורת" },
  log_time: { table: "time_entries", label: "דיווח שעות" },
};

// deno-lint-ignore no-explicit-any
async function runTool(name: string, a: any, ctx: Ctx): Promise<unknown> {
  const { me } = ctx;
  switch (name) {
    case "add_expense": {
      const project = await projectByName(a.project_name);
      const payer = (await partnerByName(a.paid_by)) ?? me;
      if (a.gmail_message_id) {
        const dup = check(await db.from("expenses").select("id,spent_on,amount").eq("gmail_message_id", a.gmail_message_id).maybeSingle());
        if (dup) return { ok: false, error: "החשבונית מהמייל הזה כבר רשומה", existing: dup };
      }
      const receiptPath = typeof a.receipt_path === "string" && a.receipt_path.startsWith("gmail/")
        ? a.receipt_path
        : (a.attach_receipt !== false ? ctx.receiptPath : null);
      const row = check(await db.from("expenses").insert({
        amount: a.amount, description: a.description, spent_on: a.spent_on ?? ctx.today,
        project_id: project?.id ?? null, paid_by_partner_id: payer.id, category: a.category ?? null,
        reference: a.reference ?? null, notes: a.notes ?? null,
        receipt_path: receiptPath, gmail_message_id: a.gmail_message_id ?? null,
      }).select("id").single());
      await notifyOthers(me, `💸 ${me.name} רשמה הוצאה: ${fmtMoney(a.amount)} על ${a.description}` +
        `${project ? ` (${project.name})` : ""}, שולם על ידי ${payer.name}.`);
      return { ok: true, id: row.id, project: project?.name ?? "כללי לעסק", paid_by: payer.name, receipt_saved: !!receiptPath };
    }
    case "connect_gmail":
    case "connect_google": {
      if (!me.telegram_chat_id) throw new Error("אין צ'אט מחובר");
      const link = await gmailAuthUrl(me);
      await tg("sendMessage", {
        chat_id: me.telegram_chat_id,
        text: "כדי לחבר את חשבון ה-Google שלך (Gmail לחשבוניות, ויומן Google לסנכרון היומן המשותף), לחצי על הכפתור ואשרי. הקישור תקף ל-15 דקות.\n" +
          "סמני את כל ההרשאות שמופיעות. אם Google מציגה \"האפליקציה לא אומתה\", לחצי על \"מתקדם\" ואז \"מעבר אל aRLi\". זה תקין, זה הכלי הפנימי שלכן.",
        reply_markup: { inline_keyboard: [[{ text: "🔗 חיבור Google", url: link }]] },
      });
      return { ok: true, note: "הכפתור נשלח בהודעה נפרדת. אל תכתבי את הקישור בעצמך." };
    }
    case "disconnect_gmail": {
      const { data: acc } = await db.from("gmail_accounts").select("refresh_token").eq("partner_id", me.id).maybeSingle();
      if (!acc) return { ok: true, note: "לא היה חיבור" };
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(acc.refresh_token)}`, { method: "POST" }).catch(() => {});
      check(await db.from("gmail_accounts").delete().eq("partner_id", me.id));
      return { ok: true };
    }
    case "search_gmail_invoices": {
      const max = Math.min(Math.max(Number(a.max_results) || 10, 1), 20);
      // deno-lint-ignore no-explicit-any
      const list: any = await gmailApi(me.id, "messages", { q: a.query, maxResults: String(max) });
      const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);
      if (!ids.length) return { messages: [], note: "לא נמצאו מיילים. אפשר לנסות שאילתה רחבה יותר." };
      const recorded = check(await db.from("expenses").select("gmail_message_id").in("gmail_message_id", ids)) as { gmail_message_id: string }[];
      const done = new Set(recorded.map((r) => r.gmail_message_id));
      const messages = await Promise.all(ids.map(async (id) => {
        // deno-lint-ignore no-explicit-any
        const m: any = await gmailApi(me.id, `messages/${id}`, { format: "full" });
        const h = headers(m);
        return {
          message_id: id, date: h.date, from: h.from, subject: h.subject,
          snippet: (m.snippet ?? "").slice(0, 160),
          attachments: collectParts(m.payload).attachments.map((p) => p.filename),
          already_recorded: done.has(id),
        };
      }));
      return { messages };
    }
    case "read_gmail_invoice":
      return await readGmailInvoice(me, a.message_id, a.attachment_name);
    case "add_income": {
      const project = await projectByName(a.project_name);
      const receiver = (await partnerByName(a.received_by)) ?? me;
      const row = check(await db.from("income").insert({
        amount: a.amount, received_on: a.received_on ?? ctx.today, project_id: project?.id ?? null,
        client_id: project?.client_id ?? null, received_by_partner_id: receiver.id,
        method: a.method ?? null, notes: a.notes ?? null,
      }).select("id").single());
      await notifyOthers(me, `💰 ${me.name} רשמה הכנסה: ${fmtMoney(a.amount)}${project ? ` מ-${project.name}` : ""}, התקבל אצל ${receiver.name}.`);
      return { ok: true, id: row.id, received_by: receiver.name };
    }
    case "add_settlement": {
      const from = await partnerByName(a.from), to = await partnerByName(a.to);
      if (!from || !to) throw new Error("צריך לציין ממי ולמי.");
      const row = check(await db.from("settlements").insert({
        amount: a.amount, from_partner_id: from.id, to_partner_id: to.id,
        settled_on: a.settled_on ?? ctx.today, notes: a.notes ?? null,
      }).select("id").single());
      await notifyOthers(me, `🔁 נרשמה העברה: ${fmtMoney(a.amount)} מ${from.name} ל${to.name}.`);
      return { ok: true, id: row.id };
    }
    case "add_task": {
      const project = await projectByName(a.project_name);
      const isPrivate = a.private === true;
      // A private task always belongs to the partner who wrote it.
      const assignee = isPrivate ? me : await partnerByName(a.assignee);
      const row = check(await db.from("tasks").insert({
        title: a.title, description: a.description ?? null, project_id: project?.id ?? null,
        assignee_partner_id: assignee?.id ?? null, due_on: a.due_on ?? null, priority: a.priority ?? 2,
        is_private: isPrivate,
      }).select("id").single());
      if (assignee && assignee.id !== me.id && assignee.telegram_chat_id) {
        await send(assignee.telegram_chat_id, `📝 ${me.name} הוסיפה לך משימה: ${a.title}${a.due_on ? ` (עד ${a.due_on})` : ""}`);
      }
      return { ok: true, id: row.id, private: isPrivate };
    }
    case "update_task": {
      const patch: Record<string, unknown> = {};
      if (a.status) { patch.status = a.status; patch.completed_at = a.status === "done" ? new Date().toISOString() : null; }
      if (a.due_on) { patch.due_on = a.due_on; patch.reminded_on = null; }
      if (a.assignee) patch.assignee_partner_id = (await partnerByName(a.assignee))?.id ?? null;
      if (a.private === true) { patch.is_private = true; patch.assignee_partner_id = me.id; }
      if (a.private === false) patch.is_private = false;
      const done = check(await db.from("tasks").update(patch).eq("id", a.task_id).or(visibleTasks(me)).select("id"));
      if (!done?.length) throw new Error("המשימה לא נמצאה");
      return { ok: true };
    }
    case "add_meeting": {
      const project = await projectByName(a.project_name);
      const kind = ["meeting", "focus", "away"].includes(a.kind) ? a.kind : "meeting";
      const partnerIds = await whoToIds(a.who, kind === "meeting" ? null : me);
      const startsAt = new Date(a.starts_at).toISOString();
      const endsAt = a.ends_at ? new Date(a.ends_at).toISOString() : a.all_day ? startsAt : new Date(new Date(startsAt).getTime() + 3600e3).toISOString();
      const conflicts = await findConflicts(startsAt, endsAt, partnerIds);
      const row = check(await db.from("meetings").insert({
        title: a.title, starts_at: startsAt, ends_at: endsAt, all_day: !!a.all_day, kind, partner_ids: partnerIds,
        location: a.location ?? null, project_id: project?.id ?? null, notes: a.notes ?? null, created_by_partner_id: me.id,
        task_id: a.task_id ?? null, want_meet: a.meet ?? (kind === "meeting" && !a.location),
      }).select("id,starts_at").single()) as { id: string; starts_at: string };
      const label = kind === "focus" ? "חסמה זמן לעבודה" : kind === "away" ? "סימנה שהיא לא זמינה" : "קבעה פגישה";
      await notifyOthers(me, `📅 ${me.name} ${label}: ${a.title}, ${fmtDateTime(row.starts_at)}${a.location ? `, ${a.location}` : ""}`);
      EdgeRuntime.waitUntil(runCalendarSync(db).catch(console.error));
      return {
        ok: true, id: row.id, starts_at_local: fmtDateTime(row.starts_at), conflicts,
        note: (await googleSynced()) ? "נכנס גם ליומן Google המשותף" + (kind === "meeting" ? ", ותזכורת תישלח שעה לפני" : "") : "תזכורת תישלח שעה לפני",
      };
    }
    case "update_meeting": {
      const { data: old } = await db.from("meetings").select("id,title,starts_at,ends_at,partner_ids").eq("id", a.id).maybeSingle();
      if (!old) throw new Error("האירוע לא נמצא");
      if (a.cancel) {
        check(await db.from("meetings").delete().eq("id", a.id));
        await notifyOthers(me, `🗑 ${me.name} ביטלה: ${old.title}, ${fmtDateTime(old.starts_at)}`);
        EdgeRuntime.waitUntil(runCalendarSync(db).catch(console.error));
        return { ok: true, cancelled: true };
      }
      const patch: Record<string, unknown> = { reminded_at: null, followed_up_at: null };
      for (const k of ["title", "location", "notes"]) if (a[k] !== undefined) patch[k] = a[k];
      if (a.kind) patch.kind = a.kind;
      if (a.who) patch.partner_ids = await whoToIds(a.who, null);
      if (a.meet) patch.want_meet = true;
      if (a.starts_at) {
        patch.starts_at = new Date(a.starts_at).toISOString();
        // Moving keeps the length unless a new end was given.
        const len = old.ends_at ? new Date(old.ends_at).getTime() - new Date(old.starts_at).getTime() : 3600e3;
        patch.ends_at = a.ends_at ? new Date(a.ends_at).toISOString() : new Date(new Date(a.starts_at).getTime() + len).toISOString();
      } else if (a.ends_at) patch.ends_at = new Date(a.ends_at).toISOString();
      check(await db.from("meetings").update(patch).eq("id", a.id));
      const s = (patch.starts_at as string) ?? old.starts_at, e = (patch.ends_at as string) ?? old.ends_at ?? s;
      const conflicts = (await findConflicts(s, e, (patch.partner_ids as string[]) ?? old.partner_ids)).filter((c) => c.id !== a.id);
      if (a.starts_at) await notifyOthers(me, `🔁 ${me.name} הזיזה: ${old.title} ל-${fmtDateTime(s)}`);
      EdgeRuntime.waitUntil(runCalendarSync(db).catch(console.error));
      return { ok: true, starts_at_local: fmtDateTime(s), conflicts };
    }
    case "find_free_time": {
      const slots = check(await db.rpc("find_free_slots", {
        p_from: a.from ?? null, p_days: a.days ?? 7, p_minutes: a.minutes ?? 60, p_partners: await whoToIds(a.who, null),
      })) as { starts_at: string; ends_at: string }[];
      const busyKnown = (await db.from("partner_busy").select("partner_id").limit(1)).data?.length;
      return {
        slots: slots.map((x) => ({ starts_at: x.starts_at, local: `${fmtDateTime(x.starts_at)}-${new Date(x.ends_at).toLocaleTimeString("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" })}` })),
        note: busyKnown ? "כולל תפוס/פנוי מיומני הגוגל האישיים" : "לפי היומן המשותף בלבד (יומני גוגל אישיים עוד לא מחוברים)",
      };
    }
    case "add_reminder": {
      const target = a.for_whom === "שתינו" ? null : ((await partnerByName(a.for_whom)) ?? me);
      const row = check(await db.from("reminders").insert({
        message: a.message, remind_at: a.remind_at, partner_id: target?.id ?? null, created_by_partner_id: me.id,
      }).select("id,remind_at").single());
      return { ok: true, id: row.id, at_local: fmtDateTime(row.remind_at), for: target?.name ?? "שתיכן" };
    }
    case "log_time": {
      const project = await projectByName(a.project_name);
      const who = (await partnerByName(a.partner)) ?? me;
      const row = check(await db.from("time_entries").insert({
        partner_id: who.id, project_id: project?.id ?? null, minutes: a.minutes,
        kind: a.kind ?? "work", work_date: a.work_date ?? ctx.today, description: a.description ?? null,
      }).select("id").single());
      return { ok: true, id: row.id };
    }
    case "add_project": {
      let clientId: string | null = null;
      if (a.client_name) {
        const existing = check(await db.from("clients").select("id").ilike("name", a.client_name).maybeSingle());
        clientId = existing?.id ?? check(await db.from("clients").insert({ name: a.client_name }).select("id").single()).id;
      }
      const row = check(await db.from("projects").insert({
        name: a.name, type: a.type, client_id: clientId, agreed_price: a.agreed_price ?? null, notes: a.notes ?? null,
        started_on: ctx.today,
      }).select("id").single());
      return { ok: true, id: row.id, profit_split: "חצי-חצי (אפשר לשנות)" };
    }
    case "update_project": {
      const project = await projectByName(a.project_name);
      if (!project) throw new Error("חסר שם פרויקט");
      const patch: Record<string, unknown> = {};
      if (a.status) { patch.status = a.status; patch.closed_on = a.status === "archived" ? ctx.today : null; }
      if (a.agreed_price != null) patch.agreed_price = a.agreed_price;
      if (Object.keys(patch).length) check(await db.from("projects").update(patch).eq("id", project.id));
      if (a.miri_percent != null) {
        if (a.miri_percent < 0 || a.miri_percent > 100) throw new Error("האחוז חייב להיות בין 0 ל-100");
        for (const p of await partners()) {
          const percent = p.name === "מירי" ? a.miri_percent : 100 - a.miri_percent;
          check(await db.from("project_profit_shares").upsert({ project_id: project.id, partner_id: p.id, percent }));
        }
      }
      return { ok: true, project: project.name };
    }
    case "get_balance": {
      // Three parties: the business, Miri and Riki. Nobody "holds" money.
      const rows = check(await db.from("partner_summary").select("name,invested,profit_share,expected_profit_share,received,balance")) as { name: string; invested: number; profit_share: number; expected_profit_share: number; received: number; balance: number }[];
      const business = check(await db.from("business_summary").select("*").single());
      const gets = rows.find((r) => r.balance > 0.005);
      const gives = rows.find((r) => r.balance < -0.005);
      return {
        business,
        partners: rows,
        explain: "invested = expenses she paid (general costs are an investment, split 50/50); profit_share = her share of the business profit; received = money that reached her; balance > 0 = still coming to her. Never say a partner 'holds' money.",
        summary: gets && gives ? `כדי להתאזן, ${gives.name} מעבירה ל${gets.name} ${fmtMoney(gets.balance)}` : "אתן מאוזנות",
      };
    }
    case "list_projects": {
      let q = db.from("project_financials").select("name,type,status,income,expenses,profit");
      if (a.status) q = q.eq("status", a.status);
      return check(await q.order("name"));
    }
    case "list_transactions": {
      const isExp = a.kind === "expenses";
      const dateCol = isExp ? "spent_on" : "received_on";
      const partnerCol = isExp ? "paid_by_partner_id" : "received_by_partner_id";
      let q = db.from(a.kind).select(
        isExp ? "id,spent_on,amount,description,category,reference,receipt_path,projects(name),partners(name)"
              : "id,received_on,amount,method,notes,projects(name),partners(name)",
      );
      if (a.from) q = q.gte(dateCol, a.from);
      if (a.to) q = q.lte(dateCol, a.to);
      if (a.project_name) q = q.eq("project_id", (await projectByName(a.project_name))!.id);
      if (a.partner) q = q.eq(partnerCol, (await partnerByName(a.partner))?.id);
      const rows = check(await q.order(dateCol, { ascending: false }).limit(a.limit ?? 30)) as { amount: number }[];
      return { rows, total: rows.reduce((s, r) => s + Number(r.amount), 0) };
    }
    case "list_tasks": {
      let q = db.from("tasks").select("id,title,status,due_on,priority,is_private,snooze_count,projects(name),partners(name)").or(visibleTasks(me));
      q = a.status ? q.eq("status", a.status) : q.neq("status", "done");
      if (a.assignee) q = q.eq("assignee_partner_id", (await partnerByName(a.assignee))?.id);
      if (a.project_name) q = q.eq("project_id", (await projectByName(a.project_name))!.id);
      return check(await q.order("due_on", { ascending: true, nullsFirst: false }).limit(50));
    }
    case "list_schedule": {
      const from = a.from ? `${a.from}T00:00:00${israelNow().offset}` : new Date().toISOString();
      const to = a.to ? `${a.to}T23:59:59${israelNow().offset}` : new Date(Date.now() + 7 * 864e5).toISOString();
      const meetings = check(await db.from("meetings").select("id,title,starts_at,ends_at,all_day,kind,partner_ids,location,meet_link,notes,projects(name)")
        .gte("starts_at", from).lte("starts_at", to).order("starts_at")) as { starts_at: string }[];
      const reminders = check(await db.from("reminders").select("id,message,remind_at,sent_at")
        .gte("remind_at", from).lte("remind_at", to).order("remind_at")) as { remind_at: string }[];
      return {
        meetings: meetings.map((m) => ({ ...m, local: fmtDateTime(m.starts_at) })),
        reminders: reminders.map((r) => ({ ...r, local: fmtDateTime(r.remind_at) })),
      };
    }
    case "time_report": {
      let q = db.from("time_entries").select("minutes,kind,work_date,projects(name),partners(name)");
      if (a.from) q = q.gte("work_date", a.from);
      if (a.to) q = q.lte("work_date", a.to);
      if (a.partner) q = q.eq("partner_id", (await partnerByName(a.partner))?.id);
      // deno-lint-ignore no-explicit-any
      const rows = check(await q) as any[];
      const byKey: Record<string, number> = {};
      for (const r of rows) {
        const k = `${r.partners?.name} · ${r.projects?.name ?? "כללי"} · ${r.kind === "learning" ? "למידה" : "עבודה"}`;
        byKey[k] = (byKey[k] ?? 0) + r.minutes;
      }
      return Object.entries(byKey).map(([k, m]) => ({ group: k, hours: Math.round((m / 60) * 10) / 10 }));
    }
    case "remember_fact": {
      if (looksSecret(a.content)) throw new Error("זה נראה כמו סיסמה או מפתח. דברים כאלה אני לא שומרת.");
      const row = check(await db.from("bot_memories").insert({
        content: a.content, kind: a.kind ?? "fact", partner_id: a.shared ? null : me.id,
      }).select("id").single());
      return { ok: true, id: row.id, shared: !!a.shared };
    }
    case "forget_fact": {
      const gone = check(await db.from("bot_memories").delete().eq("id", a.id)
        .or(`partner_id.is.null,partner_id.eq.${me.id}`).select("content"));
      if (!gone?.length) throw new Error("לא מצאתי את העובדה הזו בזיכרון");
      return { ok: true, forgotten: gone[0].content };
    }
    case "add_project_note": {
      const project = await projectByName(a.project_name);
      if (!project) throw new Error("חסר שם פרויקט");
      const row = check(await db.from("project_notes").insert({
        project_id: project.id, partner_id: me.id, content: a.content,
      }).select("id").single());
      return { ok: true, id: row.id, project: project.name };
    }
    case "get_project_notes": {
      const project = await projectByName(a.project_name);
      if (!project) throw new Error("חסר שם פרויקט");
      const [info, money, notes, tasks] = await Promise.all([
        db.from("projects").select("name,type,status,agreed_price,notes,started_on,closed_on,clients(name)").eq("id", project.id).single(),
        db.from("project_financials").select("income,expenses,profit,outstanding,expected_profit").eq("project_id", project.id).maybeSingle(),
        db.from("project_notes").select("content,source,created_at,partners(name)").eq("project_id", project.id).order("created_at", { ascending: false }).limit(40),
        db.from("tasks").select("title,status,due_on,partners(name)").eq("project_id", project.id).neq("status", "done").or(visibleTasks(me)),
      ]);
      return { project: check(info), money: check(money), open_tasks: check(tasks), notes: check(notes) };
    }
    case "delete_record": {
      check(await db.from(a.table).delete().eq("id", a.id));
      return { ok: true };
    }
  }
  throw new Error(`כלי לא מוכר: ${name}`);
}

// ---------- Gmail ----------
async function gmailAuthUrl(me: Partner): Promise<string> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("החיבור ל-Gmail עוד לא הוגדר: חסרים GOOGLE_CLIENT_ID ו-GOOGLE_CLIENT_SECRET בסיקרטים של Supabase.");
  }
  await db.from("gmail_oauth_states").delete().lt("created_at", new Date(Date.now() - 15 * 60e3).toISOString());
  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  check(await db.from("gmail_oauth_states").insert({ state, partner_id: me.id }));
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GMAIL_REDIRECT_URI, response_type: "code",
    scope: `${GMAIL_SCOPE} ${CALENDAR_SCOPE}`,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

const plain = (text: string, status = 200) =>
  new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

async function gmailCallback(url: URL): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state) return plain("missing state", 400);
  const { data: st } = await db.from("gmail_oauth_states").delete().eq("state", state)
    .select("partner_id,created_at").maybeSingle();
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60e3) {
    return plain("הקישור פג תוקף. בקשי מהבוט קישור חדש.", 400);
  }
  const partner = (await partners()).find((p) => p.id === st.partner_id);
  const tell = async (text: string) => { if (partner?.telegram_chat_id) await send(partner.telegram_chat_id, text); };
  const backToBot = Response.redirect(`https://t.me/${BOT_USERNAME}`, 302);
  if (!code) {
    await tell("החיבור ל-Gmail בוטל. אפשר לנסות שוב מתי שתרצי.");
    return backToBot;
  }
  const tok = await (await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: GOOGLE_CLIENT_ID!, client_secret: GOOGLE_CLIENT_SECRET!,
      redirect_uri: GMAIL_REDIRECT_URI, grant_type: "authorization_code",
    }),
  })).json();
  if (!tok.refresh_token) {
    console.error("gmail token exchange failed", tok.error, tok.error_description);
    await tell("לא הצלחתי להשלים את החיבור ל-Gmail. נסי שוב, ואם זה חוזר ספרי לי.");
    return backToBot;
  }
  const profile = await (await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  })).json();
  check(await db.from("gmail_accounts").upsert({
    partner_id: st.partner_id, email: profile.emailAddress ?? "", refresh_token: tok.refresh_token,
    connected_at: new Date().toISOString(), scopes: String(tok.scope ?? GMAIL_SCOPE),
  }));
  const calendar = String(tok.scope ?? "").includes(CALENDAR_SCOPE);
  await tell(`✅ חיברתי את חשבון ה-Google שלך (${profile.emailAddress ?? ""}).\n` +
    `📧 Gmail: קריאה בלבד, לחשבוניות. למשל: "תמצאי את החשבוניות של Vercel מאוקטובר".\n` +
    (calendar
      ? `🗓 יומן: היומן המשותף "aRLi" יופיע אצלך ב-Google Calendar תוך דקה. מה שנקבע כאן או באפליקציה נכנס אליו, ומה שתוסיפי בו נכנס למערכת. מהיומנים האישיים שלך אני רואה רק תפוס/פנוי.`
      : `🗓 היומן לא חובר, כי ההרשאה ליומן לא סומנה. אפשר לחבר שוב עם /google ולסמן את כל ההרשאות.`));
  if (calendar) EdgeRuntime.waitUntil(runCalendarSync(db, { busy: true }).catch(console.error));
  return backToBot;
}

const gmailToken = (partnerId: string) => googleToken(db, partnerId, "Gmail");

async function gmailApi(partnerId: string, path: string, params: Record<string, string> = {}): Promise<unknown> {
  const token = await gmailToken(partnerId);
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function fromB64Url(data: string): Uint8Array {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// deno-lint-ignore no-explicit-any
function headers(m: any) {
  const list: { name: string; value: string }[] = m.payload?.headers ?? [];
  const get = (n: string) => list.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  return { from: get("from"), subject: get("subject"), date: get("date") };
}

type MailPart = { filename: string; mimeType: string; body: { data?: string; attachmentId?: string; size?: number } };

// deno-lint-ignore no-explicit-any
function collectParts(payload: any) {
  const attachments: MailPart[] = [], texts: MailPart[] = [], htmls: MailPart[] = [];
  const walk = (p: MailPart & { parts?: MailPart[] }) => {
    if (!p) return;
    const isDoc = /^(application\/pdf|image\/)/.test(p.mimeType ?? "") || /\.(pdf|png|jpe?g|webp|heic)$/i.test(p.filename ?? "");
    if (p.filename && isDoc && (p.body?.attachmentId || p.body?.data)) attachments.push(p);
    else if (p.mimeType === "text/plain" && p.body?.data) texts.push(p);
    else if (p.mimeType === "text/html" && p.body?.data) htmls.push(p);
    for (const c of p.parts ?? []) walk(c as MailPart & { parts?: MailPart[] });
  };
  walk(payload);
  return { attachments, texts, htmls };
}

function mimeOf(p: MailPart): string {
  if (/^(application\/pdf|image\/)/.test(p.mimeType)) return p.mimeType;
  if (/\.pdf$/i.test(p.filename)) return "application/pdf";
  if (/\.png$/i.test(p.filename)) return "image/png";
  if (/\.webp$/i.test(p.filename)) return "image/webp";
  return "image/jpeg";
}

const invoiceSchema = S("object", undefined, {
  properties: {
    is_invoice: S("boolean", "האם זו באמת חשבונית, קבלה או אישור תשלום"),
    vendor: S("string", "שם הספק"),
    amount: S("number", "הסכום הכולל לתשלום, כולל מע\"מ"),
    currency: S("string", "קוד מטבע: ILS, USD, EUR וכו'"),
    date: S("string", "תאריך החשבונית YYYY-MM-DD"),
    invoice_number: S("string"),
    description: S("string", "על מה החיוב, בקצרה ובעברית"),
  },
  required: ["is_invoice"],
});

async function readGmailInvoice(me: Partner, messageId: string, attachmentName?: string) {
  // deno-lint-ignore no-explicit-any
  const m: any = await gmailApi(me.id, `messages/${messageId}`, { format: "full" });
  const h = headers(m);
  const { attachments, texts, htmls } = collectParts(m.payload);
  const dup = check(await db.from("expenses").select("id,spent_on,amount").eq("gmail_message_id", messageId).maybeSingle());
  const month = new Date(Number(m.internalDate) || Date.now()).toISOString().slice(0, 7);

  // deno-lint-ignore no-explicit-any
  const parts: any[] = [];
  let receiptPath: string | null = null;
  let source = "";
  const att = (attachmentName && attachments.find((p) => p.filename.includes(attachmentName))) ||
    attachments.find((p) => mimeOf(p) === "application/pdf") || attachments[0];

  if (att) {
    const data = att.body.data ??
      // deno-lint-ignore no-explicit-any
      ((await gmailApi(me.id, `messages/${messageId}/attachments/${att.body.attachmentId}`)) as any).data;
    const bytes = fromB64Url(data);
    if (bytes.length > 15 * 1024 * 1024) throw new Error("הקובץ המצורף גדול מדי לקריאה (מעל 15MB).");
    const mime = mimeOf(att);
    const safe = att.filename.replace(/[^\w.\-]+/g, "_").slice(-80) || "invoice";
    const path = `gmail/${month}/${messageId}-${safe}`;
    const up = await db.storage.from("receipts").upload(path, bytes, { contentType: mime, upsert: true });
    if (!up.error) receiptPath = path;
    parts.push({ inlineData: { mimeType: mime, data: b64(bytes) } });
    source = `attachment: ${att.filename}`;
  } else {
    // No attached file: many receipts arrive as the email body itself.
    const html = htmls[0] ? new TextDecoder().decode(fromB64Url(htmls[0].body.data!)) : "";
    const txt = texts[0] ? new TextDecoder().decode(fromB64Url(texts[0].body.data!)) : "";
    const body = (txt || html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "))
      .replace(/\s+/g, " ").trim().slice(0, 20000);
    if (!body) throw new Error("במייל הזה אין קובץ מצורף ואין טקסט לקריאה.");
    const path = `gmail/${month}/${messageId}.html`;
    const file = html || `<pre>${txt.replace(/</g, "&lt;")}</pre>`;
    const up = await db.storage.from("receipts").upload(path, new TextEncoder().encode(file), { contentType: "text/html", upsert: true });
    if (!up.error) receiptPath = path;
    parts.push({ text: `גוף המייל:\n${body}` });
    source = "email body";
  }
  parts.push({ text: `מייל מ: ${h.from}\nנושא: ${h.subject}\nתאריך: ${h.date}\nחלצי את פרטי החשבונית.` });

  const res = await gemini({
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: invoiceSchema },
  });
  // deno-lint-ignore no-explicit-any
  const raw = (res.candidates?.[0]?.content?.parts ?? []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("");
  let extracted: unknown = null;
  try { extracted = JSON.parse(raw); } catch { extracted = { error: "לא הצלחתי לחלץ את הפרטים", raw: raw.slice(0, 500) }; }

  return {
    message_id: messageId, from: h.from, subject: h.subject, email_date: h.date, source,
    other_attachments: attachments.filter((p) => p !== att).map((p) => p.filename),
    receipt_path: receiptPath, extracted,
    already_recorded: dup ?? false,
  };
}

// ---------- Gemini ----------
function systemPrompt(me: Partner, memories: { id: string; content: string; partner_id: string | null }[] = []) {
  const now = israelNow();
  const memo = memories.length
    ? memories.map((m) => `- [${m.id}] ${m.partner_id ? "" : "(משותף) "}${m.content}`).join("\n")
    : "(עוד אין)";
  return `את העוזרת החכמה של aRLi, העסק של השותפות מירי וריקי. את מדברת בעברית, בקצרה, בחום ובבהירות.
את כותבת כרגע עם ${me.name}.
עכשיו בישראל: ${now.weekday} ${now.date} ${now.time} (UTC${now.offset}). תאריכים יחסיים ("מחר", "ביום שלישי") מחשבים מכאן. זמנים שולחים לכלים בפורמט ISO עם ${now.offset}.

מה את עושה:
- רושמת הוצאות, הכנסות, העברות בין השותפות, משימות, פגישות, תזכורות ושעות, דרך הכלים.
- עונה על שאלות לגבי המאזן, פרויקטים, הוצאות, משימות ולו"ז, תמיד מתוך הכלים ולא מהזיכרון.
- כשמגיע צילום של חשבונית או קבלה: קראי את הסכום, התאריך, שם הספק ומספר החשבונית, ורשמי אותה כהוצאה עם attach_receipt=true. אם לא ברור לאיזה פרויקט היא שייכת, שאלי. אם שום דבר לא ברור, שאלי לפני שאת רושמת.
- כשמגיעה הודעה קולית: הביני מה נאמר ופעלי לפי זה, ובתשובה כתבי בקצרה מה הבנת.
- חשבוניות מ-Gmail: כשמבקשים למצוא חשבוניות במייל, חפשי עם search_gmail_invoices (בנו שאילתת Gmail עם ספק, טווח תאריכים after:/before: בפורמט YYYY/MM/DD, ומילים כמו invoice, receipt, חשבונית, קבלה). קראי כל מייל רלוונטי שעוד לא נרשם עם read_gmail_invoice. אחר כך הציגי רשימה קצרה: ספק, תאריך, סכום ומטבע, ופרויקט משוער. רשמי עם add_expense רק אחרי שהשותפה אישרה, ותמיד העבירי gmail_message_id ו-receipt_path. אם הסכום לא בשקלים, שאלי מה הסכום בשקלים (למשל מהחיוב בכרטיס), ורשמי את הסכום המקורי ב-notes. אם הכלי אומר שה-Gmail לא מחובר, הפעילי connect_gmail.
- משימות אישיות: כל משימה נרשמת ככללית (גלויה לשתיכן), אלא אם ${me.name} אמרה במפורש שהיא אישית ("משימה אישית", "אישי", "פרטי"). אז רשמי עם private=true, ורק היא תראה אותה. אם משימה נשמעת אישית אבל לא נאמר כך, רשמי ככללית ושאלי בסוף התשובה אם להפוך אותה לאישית.
- אפשר להפוך משימה קיימת לאישית או לכללית עם update_task (private).
- זיכרון: כשמספרים לך משהו קבוע ("תזכרי ש...", העדפה, איש קשר, החלטה), שמרי עם remember_fact. כשמבקשים לשכוח או מתקנים עובדה, מחקי עם forget_fact (ואם זה תיקון, שמרי את הגרסה הנכונה). אל תשמרי כל פרט מהשיחה, רק מה שיעזור גם בעוד חודש.
- יומן: היומן המשותף מסונכרן ל-Google Calendar (יומן בשם aRLi). יש בו שלושה סוגים: פגישה (meeting), בלוק עבודה (focus) ולא זמינה (away). "אני עובדת על X מחר 9-12" = בלוק עבודה. "אני בחופש ביום שלישי" = לא זמינה, all_day. לפני שקובעים פגישה לשתיהן בלי שעה ברורה, הציעי זמנים עם find_free_time. כש-add_meeting או update_meeting מחזירים conflicts, ספרי עליהם בקצרה ושאלי אם להשאיר. להזזה ולביטול: list_schedule ואז update_meeting. כשמבקשים לחסום זמן למשימה, מצאי אותה עם list_tasks והעבירי task_id. אם החיבור ליומן Google לא קיים והשותפה שואלת עליו, הפעילי connect_google.
- סיכום פגישה: כשמספרים מה היה בפגישה, שמרי את עיקרי הדברים עם add_project_note (אם יש פרויקט), פתחי משימות לצעדים הבאים, ושאלי אם לרשום שעות.
- פרויקטים: החלטה או סיכום חשוב על פרויקט נשמרים עם add_project_note. לשאלה "מה המצב ב..." או לפני הצעת מחיר, קראי get_project_notes.
- ההיסטוריה עשויה לכלול שורות "[מידע פנימי: ...]" עם תוצאות כלים מתורות קודמות. השתמשי בהן (למשל ב-message_id וב-receipt_path), אבל לעולם אל תכתבי אותן בתשובה.

כללים:
- הבעלות על הכסף: אין לעסק חשבון בנק. כל הוצאה שולמה מהחשבון הפרטי של אחת השותפות, וכל הכנסה התקבלה אצל אחת מהן.
- ההתחשבנות היא בין שלושה צדדים: העסק, מירי וריקי. הוצאה ששותפה שילמה היא השקעה שלה בעסק. הוצאות כלליות (בלי פרויקט) הן השקעה בעסק ומתחלקות חצי-חצי. רווח של פרויקט = הכנסות פחות הוצאות, ומתחלק לפי האחוזים של הפרויקט.
- כשמסבירים התחשבנות: כמה כל אחת השקיעה, כמה העסק הרוויח, מה חלקה ברווח, כמה קיבלה, ומי מעבירה למי. אף פעם לא לומר שמישהי "מחזיקה" כסף.
- אחרי כל רישום, אשרי במשפט אחד מה נרשם (סכום, תאריך, פרויקט, מי שילמה).
- לפני מחיקה, בקשי אישור מפורש.
- אל תמציאי נתונים. אם חסר משהו חיוני, כמו סכום, שאלי.
- בלי Markdown: טקסט פשוט, אפשר אימוג'י במידה.

מה את זוכרת (${me.name} ועובדות משותפות של העסק). השתמשי בזה בטבעיות, בלי לצטט מספרי id:
${memo}`;
}

// deno-lint-ignore no-explicit-any
async function gemini(body: any): Promise<any> {
  let lastErr = "";
  for (const model of GEMINI_MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    lastErr = `${model}: ${r.status} ${await r.text()}`;
    if (r.status !== 404) break;
  }
  throw new Error(lastErr);
}

// deno-lint-ignore no-explicit-any
async function converse(me: Partner, chatId: number, userParts: any[], userText: string, ctx: Ctx) {
  const { data: history } = await db.from("bot_messages").select("role,content")
    .eq("chat_id", chatId).order("id", { ascending: false }).limit(16);
  // deno-lint-ignore no-explicit-any
  const contents: any[] = (history ?? []).reverse().map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
  contents.push({ role: "user", parts: userParts });

  let answer = "";
  const toolLog: string[] = [];
  const memories = await memoriesFor(me).catch(() => []);
  for (let step = 0; step < 10; step++) {
    const res = await gemini({
      systemInstruction: { parts: [{ text: systemPrompt(me, memories) }] },
      contents,
      tools: [{ functionDeclarations: toolDeclarations }],
    });
    const content = res.candidates?.[0]?.content;
    if (!content?.parts?.length) { answer = "לא הצלחתי להבין, אפשר לנסח שוב?"; break; }
    contents.push(content); // keep parts verbatim (incl. thought signatures)
    // deno-lint-ignore no-explicit-any
    const calls = content.parts.filter((p: any) => p.functionCall);
    if (!calls.length) {
      // deno-lint-ignore no-explicit-any
      answer = content.parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("").trim();
      break;
    }
    // deno-lint-ignore no-explicit-any
    const responses: any[] = [];
    for (const c of calls) {
      let result: unknown;
      try {
        result = await runTool(c.functionCall.name, c.functionCall.args ?? {}, ctx);
        const undo = UNDOABLE[c.functionCall.name];
        const r = result as { ok?: boolean; id?: string };
        if (undo && r?.ok && r.id) (ctx.created ??= []).push({ table: undo.table, id: r.id, label: undo.label });
      } catch (e) {
        result = { error: (e as Error).message };
      }
      responses.push({ functionResponse: { name: c.functionCall.name, response: { result } } });
      toolLog.push(`${c.functionCall.name}: ${JSON.stringify(result).slice(0, 1500)}`);
    }
    contents.push({ role: "user", parts: responses });
  }
  if (!answer) answer = "בוצע.";

  await db.from("bot_messages").insert([
    { chat_id: chatId, role: "user", content: userText },
    {
      chat_id: chatId, role: "model",
      content: toolLog.length ? `${answer}\n\n[מידע פנימי: ${toolLog.join(" | ").slice(0, 8000)}]` : answer,
    },
  ]);
  return answer;
}

// ---------- menu, commands and buttons ----------
const COMMANDS = [
  { command: "menu", description: "תפריט כפתורים ראשי" },
  { command: "today", description: "מה יש לי היום" },
  { command: "tasks", description: "המשימות הפתוחות שלי" },
  { command: "balance", description: "ההתחשבנות בינינו" },
  { command: "expense", description: "הוצאה חדשה" },
  { command: "income", description: "הכנסה חדשה" },
  { command: "meeting", description: "פגישה חדשה" },
  { command: "time", description: "דיווח שעות" },
  { command: "invoices", description: "חשבוניות מה-Gmail של החודש" },
  { command: "week", description: "השבוע שלנו ביומן" },
  { command: "free", description: "מתי שתינו פנויות" },
  { command: "google", description: "חיבור Google (Gmail + יומן)" },
  { command: "memory", description: "מה את זוכרת עליי" },
  { command: "help", description: "מה אפשר לעשות" },
];

// Bottom keyboard: each label maps to a command.
const KEY_LABELS: Record<string, string> = {
  "📅 היום": "today", "📋 משימות": "tasks", "⚖️ התחשבנות": "balance", "⚖️ מאזן": "balance",
  "💸 הוצאה": "expense", "🗓 פגישה": "meeting", "⏱ שעות": "time",
};
const MAIN_KEYBOARD = {
  keyboard: [["📅 היום", "📋 משימות", "⚖️ התחשבנות"], ["💸 הוצאה", "🗓 פגישה", "⏱ שעות"]].map((row) => row.map((text) => ({ text }))),
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "כתבי, הקליטי או שלחי חשבונית",
};

const HELP_TEXT = `מה אפשר לעשות איתי:
💸 הוצאה: "שילמתי 120 ש״ח על דומיין לאתר של aRLi", או פשוט שלחי צילום חשבונית
💰 הכנסה: "קיבלתי 3000 מ-Migdalor בהעברה"
📝 משימה: "תוסיפי לריקי משימה לסיים את העיצוב עד יום חמישי"
🗓 פגישה: "פגישה עם עקיבא מחר ב-10" (נכנסת גם ליומן Google, עם קישור Meet אם אין מקום)
🎯 בלוק עבודה: "תחסמי לי מחר 9-12 לעבודה על Migdalor"
🌴 לא זמינה: "אני בחופש ביום שלישי"
🔍 זמן פנוי: "מתי שתינו פנויות השבוע לשעתיים?" או /free
🔁 הזזה: "תזיזי את הפגישה עם עקיבא ליום ראשון ב-11"
⏱ שעות: "עבדתי שעתיים על Kupat MB"
⏰ תזכורת: "תזכירי לי ביום ראשון ב-9 לשלם על השרת"
🔒 משימה אישית: "משימה אישית: להחזיר את הספרים לספרייה עד יום חמישי". רק את רואה אותה, וכל השאר נרשם ככללי
🧠 זיכרון: "תזכרי שעקיבא מעדיף וואטסאפ". /memory מראה מה אני זוכרת
📧 חשבוניות: "תמצאי לי את החשבוניות מ-Vercel של החודש"
🎙 אפשר גם הודעה קולית, אני אבין.

הכפתורים למטה ותפריט הפקודות (Menu) הם קיצורי דרך.`;

// What to ask for when a quick-action button opens a new entry.
const PROMPTS: Record<string, string> = {
  expense: "💸 הוצאה חדשה. כתבי סכום, על מה ואיזה פרויקט (אם יש), או פשוט שלחי צילום או PDF של החשבונית.\nלמשל: 120 על דומיין ל-aRLi Website",
  income: "💰 הכנסה חדשה. כמה, מאיזה פרויקט, ואיך התקבל?\nלמשל: 3000 מ-Migdalor בהעברה",
  meeting: "🗓 פגישה חדשה. מה, מתי ואיפה?\nלמשל: פגישה עם עקיבא מחר ב-10 בזום",
  time: "⏱ דיווח שעות. כמה זמן, על איזה פרויקט, והאם זו עבודה או למידה?\nלמשל: שעתיים על Kupat MB, או שעה למידה על agent-miri",
};

function parseCommand(text: string): string | null {
  const t = text.trim();
  if (KEY_LABELS[t]) return KEY_LABELS[t];
  const m = t.match(/^\/([a-z_]+)(?:@\w+)?$/i);
  return m ? m[1].toLowerCase() : null;
}

// Saves a short exchange in the chat history, so the model knows what the next message answers.
async function remember(chatId: number, userText: string, botText: string) {
  await db.from("bot_messages").insert([
    { chat_id: chatId, role: "user", content: userText },
    { chat_id: chatId, role: "model", content: botText },
  ]);
}

// deno-lint-ignore no-explicit-any
function taskLine(t: any, today: string) {
  const due = t.due_on ? (t.due_on < today ? ` (באיחור, ${t.due_on})` : t.due_on === today ? " (היום)" : ` (עד ${t.due_on})`) : "";
  return `${t.priority === 1 ? "🔴" : "▫️"} ${t.is_private ? "🔒 " : ""}${t.title}${t.projects?.name ? ` · ${t.projects.name}` : ""}${due}`;
}

// deno-lint-ignore no-explicit-any
function doneButtons(tasks: any[]) {
  return {
    inline_keyboard: tasks.slice(0, 12).map((t) => [{
      text: `✅ ${t.title.length > 30 ? t.title.slice(0, 30) + "…" : t.title}`, callback_data: `done:${t.id}`,
    }]),
  };
}

async function myOpenTasks(me: Partner) {
  return check(await db.from("tasks").select("id,title,status,due_on,priority,is_private,projects(name)")
    .neq("status", "done").or(`assignee_partner_id.eq.${me.id},assignee_partner_id.is.null`)
    // deno-lint-ignore no-explicit-any
    .order("due_on", { ascending: true, nullsFirst: false }).order("priority").limit(30)) as any[];
}

async function showToday(me: Partner, chatId: number) {
  const now = israelNow();
  const tasks = (await myOpenTasks(me)).filter((t) => t.due_on && t.due_on <= now.date);
  const from = `${now.date}T00:00:00${now.offset}`, to = `${now.date}T23:59:59${now.offset}`;
  const meetings = (check(await db.from("meetings").select("title,starts_at,location,kind,all_day,partner_ids,meet_link")
    .gte("starts_at", from).lte("starts_at", to).order("starts_at")) as
    { title: string; starts_at: string; location: string | null; kind: string; all_day: boolean; partner_ids: string[]; meet_link: string | null }[])
    .filter((m) => !m.partner_ids?.length || m.partner_ids.includes(me.id));
  const reminders = check(await db.from("reminders").select("message,remind_at").is("sent_at", null)
    .or(`partner_id.eq.${me.id},partner_id.is.null`).gte("remind_at", from).lte("remind_at", to).order("remind_at")) as { message: string; remind_at: string }[];
  const time = (iso: string) => new Date(iso).toLocaleTimeString("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

  const lines = [`☀️ היום, ${now.date}`];
  lines.push("", "🗓 ביומן:", ...(meetings.length
    ? meetings.map((m) => `${KIND_ICON[m.kind] ?? "•"} ${m.all_day ? "כל היום" : time(m.starts_at)} ${m.title}${m.location ? `, ${m.location}` : ""}${m.meet_link ? `\n   ${m.meet_link}` : ""}`)
    : ["יום פתוח, בלי פגישות"]));
  if (reminders.length) lines.push("", "⏰ תזכורות:", ...reminders.map((r) => `• ${time(r.remind_at)} ${r.message}`));
  lines.push("", "📌 משימות להיום ובאיחור:", ...(tasks.length ? tasks.map((t) => taskLine(t, now.date)) : ["אין, כל הכבוד! 🎉"]));
  if (tasks.length) lines.push("", "סיימת משהו? לחצי עליו:");
  await send(chatId, lines.join("\n"), tasks.length ? doneButtons(tasks) : undefined);
}

async function showTasks(me: Partner, chatId: number) {
  const today = israelNow().date;
  const tasks = await myOpenTasks(me);
  if (!tasks.length) { await send(chatId, "אין לך משימות פתוחות 🎉\nכדי להוסיף, כתבי למשל: משימה לשלוח הצעת מחיר עד יום ראשון"); return; }
  await send(chatId, `📋 המשימות הפתוחות שלך (${tasks.length}):\n${tasks.map((t) => taskLine(t, today)).join("\n")}\n\nסיימת משהו? לחצי עליו:`, doneButtons(tasks));
}

const KIND_ICON: Record<string, string> = { meeting: "🗓", focus: "🎯", away: "🌴" };

async function showWeek(me: Partner, chatId: number) {
  const now = israelNow();
  const end = addDays(now.date, 7);
  const all = await partners();
  const { data: evs } = await db.from("meetings").select("title,starts_at,all_day,kind,partner_ids,location,meet_link")
    .gte("starts_at", `${now.date}T00:00:00${now.offset}`).lt("starts_at", `${end}T00:00:00${now.offset}`).order("starts_at");
  const { data: tasks } = await db.from("tasks").select("title,due_on").neq("status", "done").or(visibleTasks(me))
    .gte("due_on", now.date).lt("due_on", end).order("due_on");
  const day = (iso: string) => new Date(iso).toLocaleDateString("he-IL", { timeZone: TZ, weekday: "long", day: "numeric", month: "numeric" });
  const hm = (iso: string) => new Date(iso).toLocaleTimeString("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const groups = new Map<string, string[]>();
  for (const m of evs ?? []) {
    const who = m.partner_ids?.length ? ` (${m.partner_ids.map((id: string) => all.find((p) => p.id === id)?.name).join(", ")})` : "";
    const line = `${KIND_ICON[m.kind] ?? "🗓"} ${m.all_day ? "כל היום" : hm(m.starts_at)} ${m.title}${who}${m.location ? `, ${m.location}` : ""}`;
    const k = day(m.starts_at); groups.set(k, [...(groups.get(k) ?? []), line]);
  }
  for (const t of tasks ?? []) {
    const k = day(`${t.due_on}T12:00:00${now.offset}`); groups.set(k, [...(groups.get(k) ?? []), `📌 דדליין: ${t.title}`]);
  }
  const lines = ["🗓 השבוע שלנו", ""];
  if (!groups.size) lines.push("שבוע פתוח לגמרי. זמן מצוין לחסום בלוקי עבודה על מה שמקדם 🙂");
  for (const [k, ls] of groups) lines.push(k, ...ls, "");
  lines.push("🔍 /free מוצא זמן פנוי משותף");
  await send(chatId, lines.join("\n"));
}

async function showBalance(me: Partner, chatId: number) {
  const bal = (await runTool("get_balance", {}, { me, receiptPath: null, today: israelNow().date })) as {
    summary: string;
    // deno-lint-ignore no-explicit-any
    business: any;
    partners: { name: string; invested: number; profit_share: number; expected_profit_share: number; balance: number }[];
  };
  const b = bal.business ?? {};
  const lines = ["⚖️ התחשבנות", ""];
  lines.push(`🏢 העסק: רווח ${fmtMoney(b.profit ?? 0)} (הכנסות ${fmtMoney(b.income ?? 0)}, הוצאות פרויקטים ${fmtMoney(b.project_expenses ?? 0)}, השקעות כלליות ${fmtMoney(b.general_expenses ?? 0)})`);
  const pending = Number(b.outstanding ?? 0) > 0.005;
  if (pending) lines.push(`🔮 רווח צפוי ${fmtMoney(b.expected_profit ?? 0)} · פער: עוד ${fmtMoney(b.outstanding)} מלקוחות`);
  lines.push("");
  for (const p of bal.partners) {
    lines.push(`${p.name}: השקיעה ${fmtMoney(p.invested)} · חלקה ברווח ${fmtMoney(p.profit_share)}` +
      `${pending ? ` · חלקה ברווח הצפוי ${fmtMoney(p.expected_profit_share ?? 0)}` : ""} · סה"כ יתרה ${fmtMoney(p.balance)}`);
  }
  await send(chatId, lines.join("\n"));
}

// Returns true when the text was a command or a keyboard button and has been handled.
async function handleCommand(me: Partner, chatId: number, text: string, ctx: Ctx): Promise<boolean> {
  // Deep links from the app: t.me/<bot>?start=google
  const deep = text.trim().match(/^\/start (google|calendar|week)$/i)?.[1].toLowerCase();
  const cmd = deep === "calendar" ? "google" : deep ?? parseCommand(text);
  if (!cmd) return false;
  switch (cmd) {
    case "start":
      await send(chatId, `היי ${me.name} 🙂 מה נעשה היום? בחרי כפתור למטה, או פשוט כתבי לי.`, MAIN_KEYBOARD);
      return true;
    case "menu":
      await send(chatId, "התפריט למטה 👇 אפשר גם לכתוב לי חופשי או לשלוח הודעה קולית.", MAIN_KEYBOARD);
      return true;
    case "help":
      await send(chatId, HELP_TEXT, MAIN_KEYBOARD);
      return true;
    case "today": await showToday(me, chatId); return true;
    case "tasks": await showTasks(me, chatId); return true;
    case "balance": await showBalance(me, chatId); return true;
    case "gmail":
    case "google": {
      const { data: acc } = await db.from("gmail_accounts").select("email,scopes").eq("partner_id", me.id).maybeSingle();
      if (acc?.scopes?.includes(CALENDAR_SCOPE)) {
        await send(chatId, `חשבון ה-Google שלך מחובר ✅ (${acc.email})\n📧 Gmail לחשבוניות: /invoices\n🗓 היומן המשותף "aRLi" מסונכרן בשני הכיוונים, ומהיומנים האישיים אני רואה רק תפוס/פנוי.\nכדי לנתק, כתבי: תנתקי את חשבון הגוגל שלי`);
      } else {
        if (acc) await send(chatId, "ה-Gmail שלך מחובר, אבל היומן עוד לא. צריך לאשר פעם אחת גם את הרשאת היומן:");
        await runTool("connect_google", {}, ctx);
      }
      return true;
    }
    case "week": await showWeek(me, chatId); return true;
    case "free": {
      const r = (await runTool("find_free_time", { days: 7, minutes: 60 }, ctx)) as { slots: { local: string }[]; note: string };
      await send(chatId, r.slots.length
        ? `🔍 חלונות פנויים לשתיכן השבוע (שעה):\n${r.slots.slice(0, 6).map((x) => `• ${x.local}`).join("\n")}\n\n${r.note}.\nלקבוע? כתבי למשל: "תקבעי לנו ישיבת תכנון ב${r.slots[0].local}"`
        : "לא מצאתי חלון פנוי משותף השבוע בשעות העבודה. אפשר לבקש לשבוע הבא או לזמן קצר יותר.");
      await remember(chatId, "/free", `הצעתי חלונות פנויים: ${r.slots.map((x) => x.local).join(", ")}`);
      return true;
    }
    case "memory": {
      const mems = await memoriesFor(me);
      const mine = mems.filter((m) => m.partner_id), shared = mems.filter((m) => !m.partner_id);
      const lines = ["🧠 מה אני זוכרת", ""];
      lines.push("עלייך:", ...(mine.length ? mine.map((m) => `• ${m.content}`) : ["עוד כלום"]));
      if (shared.length) lines.push("", "על העסק (משותף):", ...shared.map((m) => `• ${m.content}`));
      lines.push("", "כדי שאשכח משהו, כתבי למשל: תשכחי את מה שאמרתי על...");
      await send(chatId, lines.join("\n"));
      return true;
    }
    case "invoices":
      return false; // handled by the model, with a ready-made request (see handleMessage)
  }
  if (PROMPTS[cmd]) {
    await send(chatId, PROMPTS[cmd]);
    await remember(chatId, `/${cmd}`, PROMPTS[cmd]);
    return true;
  }
  await send(chatId, "לא מכירה את הפקודה הזו. /help יראה לך מה אפשר.");
  return true;
}

// deno-lint-ignore no-explicit-any
async function handleCallback(q: any) {
  const chatId: number | undefined = q.message?.chat?.id;
  const me = (await partners()).find((p) => p.telegram_chat_id === chatId);
  const answer = (text: string) => tg("answerCallbackQuery", { callback_query_id: q.id, text });
  if (!me || !chatId) { await answer("אין הרשאה"); return; }
  const [kind, a, b] = String(q.data ?? "").split(":");

  if (kind === "done" && a) {
    const { data: task } = await db.from("tasks").update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", a).select("title").maybeSingle();
    await answer(task ? `✅ ${task.title}` : "המשימה לא נמצאה");
    // Drop the button of the task that was just finished.
    // deno-lint-ignore no-explicit-any
    const rows = (q.message.reply_markup?.inline_keyboard ?? []).filter((r: any[]) => r[0]?.callback_data !== q.data);
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: rows } });
    if (task) await remember(chatId, `סימנתי כבוצעה: ${task.title}`, "מעולה, סימנתי ✅");
    return;
  }

  if (kind === "snz" && a && b) {
    const { data: task } = await db.from("tasks").select("title,snooze_count").eq("id", a).maybeSingle();
    if (!task) { await answer("המשימה לא נמצאה"); return; }
    const days = Number(b) === 7 ? 7 : 1;
    const due = addDays(israelNow().date, days);
    await db.from("tasks").update({ due_on: due, reminded_on: null, snooze_count: (task.snooze_count ?? 0) + 1 }).eq("id", a);
    await answer(days === 1 ? "נדחה למחר" : "נדחה לשבוע הבא");
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    await send(chatId, `⏭ ${task.title}: עבר ל-${due}.`);
    await remember(chatId, `דחיתי את המשימה "${task.title}" ל-${due}`, "נדחה ✅");
    return;
  }

  if (kind === "fu" && a) {
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
    if (b === "log") {
      const { data: m } = await db.from("meetings").select("title,starts_at,ends_at,project_id,kind,projects(name)").eq("id", a).maybeSingle();
      if (!m?.project_id) { await answer("לא נמצא פרויקט"); return; }
      const minutes = Math.max(15, Math.round((new Date(m.ends_at).getTime() - new Date(m.starts_at).getTime()) / 60e3 / 15) * 15);
      const { data: row } = await db.from("time_entries").insert({
        partner_id: me.id, project_id: m.project_id, minutes, kind: "work",
        work_date: new Date(m.starts_at).toLocaleDateString("en-CA", { timeZone: TZ }), description: m.title,
      }).select("id").single();
      await answer("נרשם ✅");
      // deno-lint-ignore no-explicit-any
      const proj = (m as any).projects?.name;
      await send(chatId, `⏱ רשמתי ${minutes / 60} שעות ל-${proj}: ${m.title}`,
        row ? { inline_keyboard: [[{ text: "↩️ ביטול דיווח שעות", callback_data: `undo:time_entries:${row.id}` }]] } : undefined);
      await remember(chatId, `רשמתי שעות על "${m.title}"`, `נרשמו ${minutes / 60} שעות ל-${proj}`);
    } else {
      await answer("👍");
    }
    return;
  }

  if (kind === "undo" && a && b && Object.values(UNDOABLE).some((u) => u.table === a)) {
    let receipt: string | null = null;
    if (a === "expenses") {
      const { data } = await db.from("expenses").select("receipt_path").eq("id", b).maybeSingle();
      receipt = data?.receipt_path ?? null;
    }
    const { data: gone } = await db.from(a).delete().eq("id", b).select("id");
    if (receipt) await db.storage.from("receipts").remove([receipt]);
    const label = Object.values(UNDOABLE).find((u) => u.table === a)!.label;
    await answer(gone?.length ? `בוטל: ${label}` : "כבר נמחק");
    // deno-lint-ignore no-explicit-any
    const rows = (q.message.reply_markup?.inline_keyboard ?? []).filter((r: any[]) => r[0]?.callback_data !== q.data);
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: rows } });
    if (gone?.length) {
      await send(chatId, `↩️ ביטלתי את ה${label}.`);
      await remember(chatId, `ביטלתי את ה${label} שנרשמה (${a} ${b})`, "בוטל, הרשומה נמחקה.");
      if (["expenses", "income", "settlements", "meetings"].includes(a)) await notifyOthers(me, `↩️ ${me.name} ביטלה ${label} שנרשמה קודם.`);
    }
    return;
  }
  await answer("");
}

// ---------- Telegram message handling ----------
async function downloadTelegramFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
  const info = await tg("getFile", { file_id: fileId });
  const path = info.result.file_path as string;
  const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${path}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), path };
}

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// deno-lint-ignore no-explicit-any
async function handleMessage(msg: any) {
  const chatId: number = msg.chat.id;
  const text: string = msg.text ?? msg.caption ?? "";
  const all = await partners();
  let me = all.find((p) => p.telegram_chat_id === chatId) ?? null;

  if (!me) {
    const code = text.replace("/start", "").trim().toUpperCase();
    if (code) {
      const { data } = await db.from("partners").update({ telegram_chat_id: chatId, telegram_link_code: null })
        .eq("telegram_link_code", code).select("id,name,telegram_chat_id").maybeSingle();
      if (data) {
        await send(chatId, `היי ${data.name}! 🎉 חיברתי אותך. מעכשיו אפשר לכתוב לי, לשלוח צילום חשבונית או הודעה קולית.\nלמשל: "שילמתי 120 ש״ח על דומיין לאתר של aRLi" או "מה המאזן בינינו?"\nהכפתורים למטה הם קיצורי דרך, ו-/help מראה הכל.`, MAIN_KEYBOARD);
        return;
      }
    }
    await send(chatId, "היי! אני הבוט של aRLi. כדי להתחבר, שלחי לי את קוד החיבור האישי שלך.");
    return;
  }

  const today = israelNow().date;
  const ctx: Ctx = { me, receiptPath: null, today };
  // deno-lint-ignore no-explicit-any
  const parts: any[] = [];
  let logText = text;

  if (msg.photo?.length || (msg.document && /^(image\/|application\/pdf)/.test(msg.document.mime_type ?? ""))) {
    const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    const mime = msg.photo?.length ? "image/jpeg" : msg.document.mime_type;
    const { bytes, path } = await downloadTelegramFile(fileId);
    const ext = path.split(".").pop() ?? (mime === "application/pdf" ? "pdf" : "jpg");
    const storagePath = `${today.slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
    const up = await db.storage.from("receipts").upload(storagePath, bytes, { contentType: mime });
    if (!up.error) ctx.receiptPath = storagePath;
    parts.push({ inlineData: { mimeType: mime, data: b64(bytes) } });
    parts.push({ text: text || "זו חשבונית או קבלה. רשמי אותה כהוצאה." });
    logText = `[נשלח קובץ חשבונית] ${text}`;
  } else if (msg.voice || msg.audio) {
    const f = msg.voice ?? msg.audio;
    const { bytes } = await downloadTelegramFile(f.file_id);
    parts.push({ inlineData: { mimeType: f.mime_type ?? "audio/ogg", data: b64(bytes) } });
    parts.push({ text: "זו הודעה קולית ממני. הביני ובצעי." });
    logText = "[הודעה קולית]";
  } else if (text) {
    if (await handleCommand(me, chatId, text, ctx)) return;
    if (parseCommand(text) === "invoices") {
      const req = `תמצאי לי חשבוניות וקבלות ב-Gmail מתחילת החודש (${today.slice(0, 7)}-01) עד היום`;
      parts.push({ text: req });
      logText = req;
    } else {
      parts.push({ text });
    }
  } else {
    return;
  }

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const answer = await converse(me, chatId, parts, logText, ctx);
    const undo = (ctx.created ?? []).slice(0, 4).map((c) => [{ text: `↩️ ביטול ${c.label}`, callback_data: `undo:${c.table}:${c.id}` }]);
    await send(chatId, answer, undo.length ? { inline_keyboard: undo } : undefined);
  } catch (e) {
    console.error(e);
    await send(chatId, "אופס, משהו השתבש אצלי. נסי שוב בעוד רגע.");
  }
}

// ---------- Shabbat and holidays ----------
// Candle lighting to havdalah from Hebcal, for Ramat Gan, cached in quiet_windows.
// Quiet starts 30 minutes before candle lighting and ends 10 minutes after havdalah.
const HEBCAL_LOCATION = { latitude: "32.0823", longitude: "34.8106", tzid: TZ };

async function quietWindows(): Promise<{ start: number; end: number }[]> {
  const now = Date.now();
  const { data } = await db.from("quiet_windows").select("start_at,end_at")
    .gt("end_at", new Date(now - 864e5).toISOString()).order("start_at");
  const rows = (data ?? []).map((w) => ({ start: Date.parse(w.start_at), end: Date.parse(w.end_at) }));
  // Refresh about once a month, when fewer than 30 days are left in the cache.
  if (rows.length && rows[rows.length - 1].end > now + 30 * 864e5) return rows;
  try {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const url = new URL("https://www.hebcal.com/hebcal");
    for (const [k, v] of Object.entries({
      v: "1", cfg: "json", maj: "on", c: "on", i: "on", geo: "pos", ...HEBCAL_LOCATION,
      start: day(now - 2 * 864e5), end: day(now + 120 * 864e5),
    })) url.searchParams.set(k, v);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Hebcal ${res.status}`);
    const { items } = await res.json() as { items: { category: string; date: string }[] };
    const events = items.filter((e) => e.category === "candles" || e.category === "havdalah")
      .map((e) => ({ kind: e.category, at: Date.parse(e.date) })).sort((a, b) => a.at - b.at);
    const windows: { start: number; end: number }[] = [];
    let open: number | null = null;
    for (const e of events) {
      if (e.kind === "candles" && open === null) open = e.at;
      else if (e.kind === "havdalah" && open !== null) {
        windows.push({ start: open - 30 * 60e3, end: e.at + 10 * 60e3 });
        open = null;
      }
    }
    if (!windows.length) throw new Error("Hebcal returned no windows");
    await db.from("quiet_windows").upsert(windows.map((w) => ({
      start_at: new Date(w.start).toISOString(), end_at: new Date(w.end).toISOString(), fetched_at: new Date().toISOString(),
    })), { onConflict: "start_at" });
    return windows;
  } catch (e) {
    // Hebcal down: carry on with what is cached rather than stop every reminder. Retries next minute.
    console.error("hebcal refresh failed", e);
    return rows;
  }
}

const isQuiet = (windows: { start: number; end: number }[], at = Date.now()) => windows.some((w) => at >= w.start && at < w.end);

function addDays(isoDate: string, n: number) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Buttons on a deadline message: done, or push it to tomorrow or next week.
const followupButtons = (taskId: string) => ({
  inline_keyboard: [[
    { text: "✅ בוצע", callback_data: `done:${taskId}` },
    { text: "מחר", callback_data: `snz:${taskId}:1` },
    { text: "שבוע הבא", callback_data: `snz:${taskId}:7` },
  ]],
});

// ---------- reminders (cron) ----------
async function runCron() {
  // Nothing goes out on Shabbat or a holiday. What came due waits, and goes out once it ends.
  if (isQuiet(await quietWindows())) return { ok: true, quiet: true };

  const all = await partners();
  const sendTo = async (partnerId: string | null, text: string, markup?: unknown) => {
    for (const p of all) {
      if ((partnerId === null || p.id === partnerId) && p.telegram_chat_id) await send(p.telegram_chat_id, text, markup);
    }
  };
  const nowIso = new Date().toISOString();
  const now = israelNow();

  // 1. scheduled reminders
  const { data: due } = await db.from("reminders").select("id,partner_id,message").is("sent_at", null).lte("remind_at", nowIso);
  for (const r of due ?? []) {
    await sendTo(r.partner_id, `⏰ תזכורת: ${r.message}`);
    await db.from("reminders").update({ sent_at: nowIso }).eq("id", r.id);
  }

  // 2. meetings starting within the hour, to the people taking part (work blocks: 10 minutes before)
  const inHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: soon } = await db.from("meetings").select("id,title,starts_at,location,kind,partner_ids,meet_link,notes")
    .is("reminded_at", null).eq("all_day", false).in("kind", ["meeting", "focus"]).gte("starts_at", nowIso).lte("starts_at", inHour);
  const sendToMany = async (ids: string[], text: string, markup?: unknown) => {
    if (!ids?.length) return sendTo(null, text, markup);
    for (const id of ids) await sendTo(id, text, markup);
  };
  for (const m of soon ?? []) {
    if (m.kind === "focus" && new Date(m.starts_at).getTime() - Date.now() > 10 * 60e3) continue;
    const text = m.kind === "focus"
      ? `🎯 בעוד כמה דקות מתחיל בלוק העבודה: ${m.title}. זמן לסגור הסחות ולהתמקד 💪`
      : `📅 בעוד פחות משעה: ${m.title}, ${fmtDateTime(m.starts_at)}${m.location ? `, ${m.location}` : ""}` +
        `${m.notes ? `\n📝 ${m.notes.slice(0, 300)}` : ""}`;
    const markup = m.meet_link ? { inline_keyboard: [[{ text: "🎥 כניסה ל-Meet", url: m.meet_link }]] } : undefined;
    await sendToMany(m.partner_ids, text, markup);
    await db.from("meetings").update({ reminded_at: nowIso }).eq("id", m.id);
  }

  // 2b. after a meeting or work block ends: how did it go, and log the hours to the project
  const { data: ended } = await db.from("meetings").select("id,title,starts_at,ends_at,kind,partner_ids,project_id,projects(name)")
    .is("followed_up_at", null).eq("all_day", false).in("kind", ["meeting", "focus"])
    .lte("ends_at", nowIso).gte("ends_at", new Date(Date.now() - 3 * 3600e3).toISOString());
  for (const m of ended ?? []) {
    if (now.hour >= 7 && now.hour < 23) {
      const hours = Math.max(0.25, Math.round(((new Date(m.ends_at).getTime() - new Date(m.starts_at).getTime()) / 3600e3) * 4) / 4);
      // deno-lint-ignore no-explicit-any
      const proj = (m as any).projects?.name as string | undefined;
      const buttons = [
        ...(proj ? [[{ text: `⏱ לרשום ${hours} שעות ל-${proj}`, callback_data: `fu:${m.id}:log` }]] : []),
        [{ text: "👍 הכל טוב", callback_data: `fu:${m.id}:ok` }],
      ];
      const text = m.kind === "focus"
        ? `🎯 בלוק העבודה "${m.title}" הסתיים. איך הלך? אפשר לכתוב לי מה התקדם ומה הצעד הבא.`
        : `🤝 הפגישה "${m.title}" הסתיימה. מה סוכם? כתבי או הקליטי לי, ואשמור סיכום${proj ? ` בפרויקט ${proj}` : ""} ואפתח משימות לצעדים הבאים.`;
      await sendToMany(m.partner_ids, text, { inline_keyboard: buttons });
      for (const p of all) {
        if (p.telegram_chat_id && (!m.partner_ids?.length || m.partner_ids.includes(p.id))) {
          await remember(p.telegram_chat_id, `[היומן: "${m.title}" (${m.kind}, id ${m.id}${proj ? `, פרויקט ${proj}` : ""}) הסתיים]`, text);
        }
      }
    }
    await db.from("meetings").update({ followed_up_at: nowIso }).eq("id", m.id);
  }

  // 3. task deadlines, once a day from 08:00
  if (now.hour >= 8) {
    const { data: tasks } = await db.from("tasks").select("id,title,due_on,assignee_partner_id,snooze_count")
      .neq("status", "done").lte("due_on", now.date).or(`reminded_on.is.null,reminded_on.lt.${now.date}`);
    for (const t of tasks ?? []) {
      const late = t.due_on < now.date ? " (באיחור)" : " (היום)";
      // After three pushes, ask what is really going on instead of nagging again.
      const stuck = t.snooze_count >= 3
        ? `\nנדחתה כבר ${t.snooze_count} פעמים. אולי לפרק אותה לצעד קטן אחד, להעביר, או לוותר עליה? אפשר לכתוב לי.`
        : "";
      await sendTo(t.assignee_partner_id, `📌 דדליין${late}: ${t.title}${stuck}`, followupButtons(t.id));
      await db.from("tasks").update({ reminded_on: now.date }).eq("id", t.id);
    }
  }

  // 4. weekly money summary, Sunday from 09:00
  if (now.weekday === "Sunday" && now.hour >= 9) {
    const { data: last } = await db.from("app_config").select("value").eq("key", "weekly_summary_sent").maybeSingle();
    if (last?.value !== now.date) {
      const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
      const { data: exp } = await db.from("expenses").select("amount").gte("spent_on", weekAgo);
      const { data: inc } = await db.from("income").select("amount").gte("received_on", weekAgo);
      const sum = (rows: { amount: number }[] | null) => (rows ?? []).reduce((s, r) => s + Number(r.amount), 0);
      const { count: ahead } = await db.from("meetings").select("id", { count: "exact", head: true })
        .eq("kind", "meeting").gte("starts_at", nowIso).lt("starts_at", new Date(Date.now() + 7 * 864e5).toISOString());
      await sendTo(null, `📊 סיכום שבועי\nהוצאות השבוע: ${fmtMoney(sum(exp))}\nהכנסות השבוע: ${fmtMoney(sum(inc))}\n` +
        `🗓 השבוע הקרוב: ${ahead ?? 0} פגישות. /week מראה הכל, ו-/free מוצא זמן משותף לבלוקי עבודה.`);
      await db.from("app_config").upsert({ key: "weekly_summary_sent", value: now.date });
    }
  }
  return { ok: true };
}

// ---------- entry ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (url.pathname.endsWith("/gmail/callback")) return await gmailCallback(url);

  if (action === "setup") {
    const hook = await tg("setWebhook", {
      url: `${SUPABASE_URL}/functions/v1/telegram-bot`,
      secret_token: await webhookSecret(),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    const commands = await tg("setMyCommands", { commands: COMMANDS });
    await tg("setChatMenuButton", { menu_button: { type: "commands" } });
    const me = await tg("getMe", {});
    return Response.json({ webhook: hook, commands, bot: me.result?.username });
  }

  if (action === "calendar_sync") {
    const { data } = await db.from("app_config").select("value").eq("key", "cron_secret").single();
    if (!data || req.headers.get("x-cron-secret") !== data.value) return new Response("forbidden", { status: 403 });
    return Response.json(await runCalendarSync(db, { busy: true }));
  }

  if (action === "cron") {
    const { data } = await db.from("app_config").select("value").eq("key", "cron_secret").single();
    if (!data || req.headers.get("x-cron-secret") !== data.value) return new Response("forbidden", { status: 403 });
    const [cron, calendar] = await Promise.all([runCron(), runCalendarSync(db).catch((e) => ({ ok: false, error: String(e) }))]);
    return Response.json({ ...cron, calendar });
  }

  if (req.headers.get("x-telegram-bot-api-secret-token") !== (await webhookSecret())) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await req.json();
  if (update.message) EdgeRuntime.waitUntil(handleMessage(update.message).catch(console.error));
  if (update.callback_query) EdgeRuntime.waitUntil(handleCallback(update.callback_query).catch(console.error));
  return new Response("ok");
});
