// aRLi management Telegram bot.
// Routes:
//   POST (from Telegram, with secret header)  -> handle a message
//   GET  ?action=setup                         -> register the webhook and commands
//   POST ?action=cron (x-cron-secret header)   -> send due reminders
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GEMINI_MODELS = [Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest", "gemini-2.5-flash"];
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TZ = "Asia/Jerusalem";
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

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

async function send(chatId: number, text: string) {
  // Telegram limit is 4096 characters per message.
  for (let i = 0; i < text.length; i += 4000) {
    await tg("sendMessage", { chat_id: chatId, text: text.slice(i, i + 4000) });
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

async function notifyOthers(me: Partner, text: string) {
  for (const p of await partners()) {
    if (p.id !== me.id && p.telegram_chat_id) await send(p.telegram_chat_id, text);
  }
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
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
        attach_receipt: S("boolean", "לצרף את הקובץ שנשלח בהודעה הזו כקבלה"),
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
    description: "יצירת משימה.",
    parameters: S("object", undefined, {
      properties: {
        title: S("string"), description: S("string"), project_name: S("string"),
        assignee: PARTNER, due_on: S("string", "YYYY-MM-DD"),
        priority: S("integer", "1 גבוהה, 2 רגילה, 3 נמוכה"),
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
      },
      required: ["task_id"],
    }),
  },
  {
    name: "add_meeting",
    description: "קביעת פגישה ביומן המשותף. starts_at בפורמט ISO עם אזור הזמן של ישראל.",
    parameters: S("object", undefined, {
      properties: {
        title: S("string"), starts_at: S("string"), ends_at: S("string"),
        location: S("string"), project_name: S("string"), notes: S("string"),
      },
      required: ["title", "starts_at"],
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
    description: "עדכון פרויקט: סטטוס, מחיר מוסכם, או חלוקת רווח (אחוז של מירי, ריקי מקבלת את השאר).",
    parameters: S("object", undefined, {
      properties: {
        project_name: S("string"),
        status: S("string", undefined, { enum: ["active", "paused", "closed"] }),
        agreed_price: S("number"),
        miri_percent: S("number", "אחוז הרווח של מירי, 0 עד 100"),
      },
      required: ["project_name"],
    }),
  },
  { name: "get_balance", description: "המאזן בין השותפות: מי חייבת למי וכמה.", parameters: S("object", undefined, { properties: {} }) },
  {
    name: "list_projects", description: "רשימת פרויקטים עם הכנסות, הוצאות ורווח.",
    parameters: S("object", undefined, { properties: { status: S("string", undefined, { enum: ["active", "paused", "closed"] }) } }),
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

type Ctx = { me: Partner; receiptPath: string | null; today: string };

// deno-lint-ignore no-explicit-any
async function runTool(name: string, a: any, ctx: Ctx): Promise<unknown> {
  const { me } = ctx;
  switch (name) {
    case "add_expense": {
      const project = await projectByName(a.project_name);
      const payer = (await partnerByName(a.paid_by)) ?? me;
      const row = check(await db.from("expenses").insert({
        amount: a.amount, description: a.description, spent_on: a.spent_on ?? ctx.today,
        project_id: project?.id ?? null, paid_by_partner_id: payer.id, category: a.category ?? null,
        reference: a.reference ?? null,
        receipt_path: a.attach_receipt !== false ? ctx.receiptPath : null,
      }).select("id").single());
      await notifyOthers(me, `💸 ${me.name} רשמה הוצאה: ${fmtMoney(a.amount)} על ${a.description}` +
        `${project ? ` (${project.name})` : ""}, שולם על ידי ${payer.name}.`);
      return { ok: true, id: row.id, project: project?.name ?? "כללי לעסק", paid_by: payer.name, receipt_saved: !!(a.attach_receipt !== false && ctx.receiptPath) };
    }
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
      const assignee = await partnerByName(a.assignee);
      const row = check(await db.from("tasks").insert({
        title: a.title, description: a.description ?? null, project_id: project?.id ?? null,
        assignee_partner_id: assignee?.id ?? null, due_on: a.due_on ?? null, priority: a.priority ?? 2,
      }).select("id").single());
      if (assignee && assignee.id !== me.id && assignee.telegram_chat_id) {
        await send(assignee.telegram_chat_id, `📝 ${me.name} הוסיפה לך משימה: ${a.title}${a.due_on ? ` (עד ${a.due_on})` : ""}`);
      }
      return { ok: true, id: row.id };
    }
    case "update_task": {
      const patch: Record<string, unknown> = {};
      if (a.status) { patch.status = a.status; patch.completed_at = a.status === "done" ? new Date().toISOString() : null; }
      if (a.due_on) { patch.due_on = a.due_on; patch.reminded_on = null; }
      if (a.assignee) patch.assignee_partner_id = (await partnerByName(a.assignee))?.id ?? null;
      check(await db.from("tasks").update(patch).eq("id", a.task_id));
      return { ok: true };
    }
    case "add_meeting": {
      const project = await projectByName(a.project_name);
      const row = check(await db.from("meetings").insert({
        title: a.title, starts_at: a.starts_at, ends_at: a.ends_at ?? null, location: a.location ?? null,
        project_id: project?.id ?? null, notes: a.notes ?? null, created_by_partner_id: me.id,
      }).select("id,starts_at").single());
      await notifyOthers(me, `📅 ${me.name} קבעה פגישה: ${a.title}, ${fmtDateTime(row.starts_at)}${a.location ? `, ${a.location}` : ""}`);
      return { ok: true, id: row.id, starts_at_local: fmtDateTime(row.starts_at), note: "תזכורת תישלח שעה לפני" };
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
      if (a.status) { patch.status = a.status; if (a.status === "closed") patch.closed_on = ctx.today; }
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
      const rows = check(await db.from("partner_balances").select("*")) as { name: string; entitled: number; held: number; net_position: number }[];
      const owes = rows.find((r) => r.net_position > 0.005);
      const owed = rows.find((r) => r.net_position < -0.005);
      return {
        partners: rows,
        summary: owes && owed ? `${owes.name} חייבת ל${owed.name} ${fmtMoney(owes.net_position)}` : "אתן מאוזנות",
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
      let q = db.from("tasks").select("id,title,status,due_on,priority,projects(name),partners(name)");
      q = a.status ? q.eq("status", a.status) : q.neq("status", "done");
      if (a.assignee) q = q.eq("assignee_partner_id", (await partnerByName(a.assignee))?.id);
      if (a.project_name) q = q.eq("project_id", (await projectByName(a.project_name))!.id);
      return check(await q.order("due_on", { ascending: true, nullsFirst: false }).limit(50));
    }
    case "list_schedule": {
      const from = a.from ? `${a.from}T00:00:00${israelNow().offset}` : new Date().toISOString();
      const to = a.to ? `${a.to}T23:59:59${israelNow().offset}` : new Date(Date.now() + 7 * 864e5).toISOString();
      const meetings = check(await db.from("meetings").select("id,title,starts_at,location,projects(name)")
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
    case "delete_record": {
      check(await db.from(a.table).delete().eq("id", a.id));
      return { ok: true };
    }
  }
  throw new Error(`כלי לא מוכר: ${name}`);
}

// ---------- Gemini ----------
function systemPrompt(me: Partner) {
  const now = israelNow();
  return `את העוזרת החכמה של aRLi, העסק של השותפות מירי וריקי. את מדברת בעברית, בקצרה, בחום ובבהירות.
את כותבת כרגע עם ${me.name}.
עכשיו בישראל: ${now.weekday} ${now.date} ${now.time} (UTC${now.offset}). תאריכים יחסיים ("מחר", "ביום שלישי") מחשבים מכאן. זמנים שולחים לכלים בפורמט ISO עם ${now.offset}.

מה את עושה:
- רושמת הוצאות, הכנסות, העברות בין השותפות, משימות, פגישות, תזכורות ושעות, דרך הכלים.
- עונה על שאלות לגבי המאזן, פרויקטים, הוצאות, משימות ולו"ז, תמיד מתוך הכלים ולא מהזיכרון.
- כשמגיע צילום של חשבונית או קבלה: קראי את הסכום, התאריך, שם הספק ומספר החשבונית, ורשמי אותה כהוצאה עם attach_receipt=true. אם לא ברור לאיזה פרויקט היא שייכת, שאלי. אם שום דבר לא ברור, שאלי לפני שאת רושמת.
- כשמגיעה הודעה קולית: הביני מה נאמר ופעלי לפי זה, ובתשובה כתבי בקצרה מה הבנת.

כללים:
- הבעלות על הכסף: אין לעסק חשבון בנק. כל הוצאה שולמה מהחשבון הפרטי של אחת השותפות, וכל הכנסה התקבלה אצל אחת מהן.
- רווח של פרויקט = הכנסות פחות הוצאות, ומתחלק לפי האחוזים של הפרויקט. הוצאות שלא שייכות לפרויקט מתחלקות חצי-חצי.
- אחרי כל רישום, אשרי במשפט אחד מה נרשם (סכום, תאריך, פרויקט, מי שילמה).
- לפני מחיקה, בקשי אישור מפורש.
- אל תמציאי נתונים. אם חסר משהו חיוני, כמו סכום, שאלי.
- בלי Markdown: טקסט פשוט, אפשר אימוג'י במידה.`;
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
  for (let step = 0; step < 8; step++) {
    const res = await gemini({
      systemInstruction: { parts: [{ text: systemPrompt(me) }] },
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
      } catch (e) {
        result = { error: (e as Error).message };
      }
      responses.push({ functionResponse: { name: c.functionCall.name, response: { result } } });
    }
    contents.push({ role: "user", parts: responses });
  }
  if (!answer) answer = "בוצע.";

  await db.from("bot_messages").insert([
    { chat_id: chatId, role: "user", content: userText },
    { chat_id: chatId, role: "model", content: answer },
  ]);
  return answer;
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
        await send(chatId, `היי ${data.name}! 🎉 חיברתי אותך. מעכשיו אפשר לכתוב לי, לשלוח צילום חשבונית או הודעה קולית.\nלמשל: "שילמתי 120 ש״ח על דומיין לאתר של aRLi" או "מה המאזן בינינו?"`);
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
    if (text === "/start") { await send(chatId, `את כבר מחוברת, ${me.name} 🙂`); return; }
    parts.push({ text });
  } else {
    return;
  }

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const answer = await converse(me, chatId, parts, logText, ctx);
    await send(chatId, answer);
  } catch (e) {
    console.error(e);
    await send(chatId, "אופס, משהו השתבש אצלי. נסי שוב בעוד רגע.");
  }
}

// ---------- reminders (cron) ----------
async function runCron() {
  const all = await partners();
  const sendTo = async (partnerId: string | null, text: string) => {
    for (const p of all) {
      if ((partnerId === null || p.id === partnerId) && p.telegram_chat_id) await send(p.telegram_chat_id, text);
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

  // 2. meetings starting within the hour
  const inHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data: soon } = await db.from("meetings").select("id,title,starts_at,location")
    .is("reminded_at", null).gte("starts_at", nowIso).lte("starts_at", inHour);
  for (const m of soon ?? []) {
    await sendTo(null, `📅 בעוד פחות משעה: ${m.title}, ${fmtDateTime(m.starts_at)}${m.location ? `, ${m.location}` : ""}`);
    await db.from("meetings").update({ reminded_at: nowIso }).eq("id", m.id);
  }

  // 3. task deadlines, once a day from 08:00
  if (now.hour >= 8) {
    const { data: tasks } = await db.from("tasks").select("id,title,due_on,assignee_partner_id")
      .neq("status", "done").lte("due_on", now.date).or(`reminded_on.is.null,reminded_on.lt.${now.date}`);
    for (const t of tasks ?? []) {
      const late = t.due_on < now.date ? " (באיחור)" : " (היום)";
      await sendTo(t.assignee_partner_id, `📌 דדליין${late}: ${t.title}`);
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
      const bal = (await runTool("get_balance", {}, { me: all[0], receiptPath: null, today: now.date })) as { summary: string };
      await sendTo(null, `📊 סיכום שבועי\nהוצאות השבוע: ${fmtMoney(sum(exp))}\nהכנסות השבוע: ${fmtMoney(sum(inc))}\nמאזן: ${bal.summary}`);
      await db.from("app_config").upsert({ key: "weekly_summary_sent", value: now.date });
    }
  }
  return { ok: true };
}

// ---------- entry ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "setup") {
    const hook = await tg("setWebhook", {
      url: `${SUPABASE_URL}/functions/v1/telegram-bot`,
      secret_token: await webhookSecret(),
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
    await tg("setMyCommands", { commands: [{ command: "start", description: "התחברות לבוט" }] });
    const me = await tg("getMe", {});
    return Response.json({ webhook: hook, bot: me.result?.username });
  }

  if (action === "cron") {
    const { data } = await db.from("app_config").select("value").eq("key", "cron_secret").single();
    if (!data || req.headers.get("x-cron-secret") !== data.value) return new Response("forbidden", { status: 403 });
    return Response.json(await runCron());
  }

  if (req.headers.get("x-telegram-bot-api-secret-token") !== (await webhookSecret())) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await req.json();
  if (update.message) EdgeRuntime.waitUntil(handleMessage(update.message).catch(console.error));
  return new Response("ok");
});
