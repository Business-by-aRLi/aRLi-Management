// Google Calendar two-way sync for the team calendar.
//
// One shared Google calendar named "aRLi" is created in the account of the first partner who connects
// Calendar, and shared with the other partner as a writer. Every event of the app lives there:
//   app / bot -> Google: rows marked needs_push (by a DB trigger) are inserted or patched; deleted rows go
//                        through calendar_outbox.
//   Google -> app:       events changed in Google since the last pull are upserted; cancelled ones deleted.
// Each partner's personal calendars come into partner_busy: with titles for her own eyes, "busy" for the other.
// Private events (meetings.is_private) sync with their owner's own Google calendar only, never the shared one.
// runCalendarSync() is called by the bot's cron every minute; busy times refresh every 10 minutes.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const TZ = "Asia/Jerusalem";
const API = "https://www.googleapis.com/calendar/v3";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const APP_URL = "https://management.arli.co.il/calendar";
const COLOR: Record<string, string> = { meeting: "4", focus: "9", away: "8" }; // flamingo, blueberry, graphite

type Db = SupabaseClient;
type Account = { partner_id: string; email: string; scopes: string };
// deno-lint-ignore no-explicit-any
type Json = any;

// ---------- tokens ----------
const tokens = new Map<string, { token: string; exp: number }>();

export async function googleToken(db: Db, partnerId: string, what = "Google"): Promise<string> {
  const cached = tokens.get(partnerId);
  if (cached && cached.exp > Date.now()) return cached.token;
  const { data: acc } = await db.from("gmail_accounts").select("refresh_token").eq("partner_id", partnerId).maybeSingle();
  if (!acc) throw new Error(`ה-${what} של השותפה עוד לא מחובר. אפשר לחבר עם connect_google.`);
  const tok = await (await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: acc.refresh_token, client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "", grant_type: "refresh_token",
    }),
  })).json();
  if (!tok.access_token) {
    if (tok.error === "invalid_grant") {
      await db.from("gmail_accounts").delete().eq("partner_id", partnerId);
      throw new Error(`ההרשאה ל-${what} פגה או בוטלה. צריך לחבר מחדש עם connect_google.`);
    }
    throw new Error(`שגיאה בחיבור ל-${what}: ${tok.error ?? "unknown"}`);
  }
  tokens.set(partnerId, { token: tok.access_token, exp: Date.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000 });
  return tok.access_token;
}

class GoogleError extends Error {
  constructor(public status: number, body: string) { super(`Calendar ${status}: ${body.slice(0, 300)}`); }
}

async function gcal(db: Db, partnerId: string, path: string, init: { method?: string; params?: Record<string, string>; body?: unknown } = {}): Promise<Json> {
  const token = await googleToken(db, partnerId, "Google Calendar");
  const qs = init.params ? `?${new URLSearchParams(init.params)}` : "";
  const r = await fetch(`${API}/${path}${qs}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new GoogleError(r.status, await r.text());
  return r.json();
}

// ---------- config ----------
async function cfg(db: Db, key: string): Promise<string | null> {
  const { data } = await db.from("app_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function setCfg(db: Db, key: string, value: string) {
  await db.from("app_config").upsert({ key, value });
}

async function calendarAccounts(db: Db): Promise<Account[]> {
  const { data } = await db.from("gmail_accounts").select("partner_id,email,scopes");
  return ((data ?? []) as Account[]).filter((a) => a.scopes?.includes(CALENDAR_SCOPE));
}

// The shared calendar: create it once, share it with every partner who connected Calendar,
// and add it to her calendar list so it shows in her Google Calendar.
async function ensureCalendar(db: Db, accounts: Account[]): Promise<{ id: string; owner: string } | null> {
  if (!accounts.length) return null;
  let id = await cfg(db, "gcal_calendar_id");
  let owner = await cfg(db, "gcal_owner_partner_id");
  if (id && !accounts.some((a) => a.partner_id === owner)) {
    // The owner disconnected: keep the calendar through a partner it is already shared with.
    const shared = [];
    for (const a of accounts) if (await cfg(db, `gcal_shared_${a.partner_id}`)) shared.push(a);
    owner = shared[0]?.partner_id ?? null;
    if (!owner) id = null;
  }
  if (!id) {
    owner = accounts[0].partner_id;
    const cal = await gcal(db, owner, "calendars", {
      method: "POST", body: { summary: "aRLi", description: "היומן המשותף של aRLi. מסונכרן עם מערכת הניהול והבוט.", timeZone: TZ },
    });
    id = cal.id as string;
    await setCfg(db, "gcal_calendar_id", id);
    await gcal(db, owner, `users/me/calendarList/${encodeURIComponent(id)}`, { method: "PATCH", body: { colorId: "4" } }).catch(() => {});
    // A new calendar: everything goes up again, and nobody counts as shared yet.
    await db.from("app_config").delete().like("key", "gcal_shared_%");
    await db.from("app_config").delete().eq("key", "gcal_last_pull");
    await db.from("meetings").update({ google_event_id: null, google_calendar_id: null }).eq("is_private", false).not("google_event_id", "is", null);
  }
  await setCfg(db, "gcal_owner_partner_id", owner!);
  for (const a of accounts) {
    if (a.partner_id === owner || (await cfg(db, `gcal_shared_${a.partner_id}`))) continue;
    if (a.email) {
      await gcal(db, owner!, `calendars/${encodeURIComponent(id!)}/acl`, {
        method: "POST", params: { sendNotifications: "false" }, body: { role: "writer", scope: { type: "user", value: a.email } },
      });
    }
    await gcal(db, a.partner_id, "users/me/calendarList", { method: "POST", body: { id, colorId: "4" } }).catch((e) => {
      if (!(e instanceof GoogleError && e.status === 409)) throw e;
    });
    await setCfg(db, `gcal_shared_${a.partner_id}`, new Date().toISOString());
  }
  return { id: id!, owner: owner! };
}

// ---------- app -> Google ----------
const localDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));
const addDay = (date: string, n = 1) => {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};

type Row = {
  id: string; title: string; starts_at: string; ends_at: string | null; location: string | null; notes: string | null;
  kind: string; partner_ids: string[]; all_day: boolean; want_meet: boolean; meet_link: string | null;
  google_event_id: string | null; project_id: string | null; task_id: string | null; projects?: { name: string } | null;
  is_private: boolean; created_by_partner_id: string | null; google_calendar_id: string | null; google_partner_id: string | null;
};

function toEvent(m: Row, names: Map<string, string>) {
  const end = m.ends_at ?? new Date(new Date(m.starts_at).getTime() + 3600e3).toISOString();
  const who = m.partner_ids?.length ? m.partner_ids.map((id) => names.get(id)).filter(Boolean).join(", ") : "";
  const kindLabel = m.kind === "focus" ? "בלוק עבודה" : m.kind === "away" ? "לא זמינה" : "";
  const lines = [
    m.notes ?? "",
    [kindLabel, who && `משתתפות: ${who}`, m.projects?.name && `פרויקט: ${m.projects.name}`].filter(Boolean).join(" · "),
    `נוצר במערכת של aRLi: ${APP_URL}`,
  ].filter(Boolean);
  return {
    summary: m.title,
    status: "confirmed",
    location: m.location ?? undefined,
    description: lines.join("\n\n"),
    colorId: COLOR[m.kind] ?? undefined,
    transparency: "opaque",
    start: m.all_day ? { date: localDate(m.starts_at) } : { dateTime: m.starts_at, timeZone: TZ },
    end: m.all_day ? { date: addDay(localDate(m.ends_at ?? m.starts_at)) } : { dateTime: end, timeZone: TZ },
    extendedProperties: {
      private: {
        arli_id: m.id, arli_kind: m.kind, arli_partners: (m.partner_ids ?? []).join(","),
        arli_project: m.project_id ?? "", arli_task: m.task_id ?? "",
      },
    },
    reminders: { useDefault: m.kind === "meeting" },
    ...(m.want_meet && !m.meet_link
      ? { conferenceData: { createRequest: { requestId: `arli-${m.id}-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      : {}),
  };
}

async function deleteEvent(db: Db, partnerId: string, calendarId: string, eventId: string) {
  try {
    await gcal(db, partnerId, `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE", params: { sendUpdates: "none" },
    });
  } catch (e) {
    if (!(e instanceof GoogleError && (e.status === 404 || e.status === 410))) throw e;
  }
}

// Shared events go to the shared "aRLi" calendar. A private event goes only to its owner's own Google calendar,
// and only when she connected Calendar; otherwise it stays in the system.
async function push(db: Db, cal: { id: string; owner: string }, accounts: Account[]) {
  const connected = accounts.map((a) => a.partner_id);
  const { data: rows } = await db.from("meetings")
    .select("id,title,starts_at,ends_at,location,notes,kind,partner_ids,all_day,want_meet,meet_link,google_event_id,project_id,task_id,is_private,created_by_partner_id,google_calendar_id,google_partner_id,projects(name)")
    .eq("needs_push", true).or(`is_private.eq.false,created_by_partner_id.in.(${connected.join(",")})`)
    .order("starts_at").limit(25);
  if (!rows?.length) return 0;
  const { data: ps } = await db.from("partners").select("id,name");
  const names = new Map((ps ?? []).map((p) => [p.id as string, p.name as string]));
  let n = 0;
  for (const m of rows as unknown as Row[]) {
    const target = m.is_private ? { id: "primary", partner: m.created_by_partner_id! } : { id: cal.id, partner: cal.owner };
    let eventId = m.google_event_id;
    // The event moved between the shared calendar and a private one: remove it from where it was.
    const wasIn = m.google_calendar_id ?? cal.id;
    if (eventId && (wasIn !== target.id || (m.is_private && m.google_partner_id && m.google_partner_id !== target.partner))) {
      await deleteEvent(db, m.google_partner_id ?? cal.owner, wasIn, eventId).catch(console.error);
      eventId = null;
    }
    const body = toEvent(m, names);
    const params = { conferenceDataVersion: "1", sendUpdates: "none" };
    const base = `calendars/${encodeURIComponent(target.id)}/events`;
    // New events get an id derived from the row, so two sync runs at once can never create a duplicate:
    // the second insert gets 409 and becomes a patch.
    const ownId = `arli${m.id.replaceAll("-", "")}`;
    const patch = (id: string) => gcal(db, target.partner, `${base}/${encodeURIComponent(id)}`, { method: "PATCH", params, body });
    const insert = async () => {
      try {
        return await gcal(db, target.partner, base, { method: "POST", params, body: { ...body, id: ownId } });
      } catch (e) {
        if (e instanceof GoogleError && e.status === 409) return await patch(ownId);
        throw e;
      }
    };
    let ev: Json;
    try {
      ev = eventId ? await patch(eventId) : await insert();
    } catch (e) {
      // The event was removed in Google (or lives in another calendar): create it again.
      if (e instanceof GoogleError && (e.status === 404 || e.status === 410) && eventId) ev = await insert();
      else throw e;
    }
    const meet = ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find((p: Json) => p.entryPointType === "video")?.uri ?? m.meet_link;
    await db.from("meetings").update({
      google_event_id: ev.id, google_calendar_id: target.id, google_partner_id: target.partner,
      meet_link: meet ?? null, want_meet: false,
      google_synced_at: new Date().toISOString(), needs_push: false,
    }).eq("id", m.id);
    n++;
  }
  return n;
}

async function pushDeletes(db: Db, cal: { id: string; owner: string }) {
  const { data: rows } = await db.from("calendar_outbox").select("id,google_event_id,calendar_id,partner_id").order("id").limit(25);
  for (const r of rows ?? []) {
    await deleteEvent(db, r.partner_id ?? cal.owner, r.calendar_id ?? cal.id, r.google_event_id);
    await db.from("calendar_outbox").delete().eq("id", r.id);
  }
  return rows?.length ?? 0;
}

// ---------- Google -> app ----------
function fromEvent(ev: Json) {
  const p = ev.extendedProperties?.private ?? {};
  const allDay = !!ev.start?.date;
  // All-day events are stored at noon Israel time of their first and last day.
  const startIso = allDay ? new Date(`${ev.start.date}T12:00:00${offsetOf(ev.start.date)}`).toISOString() : new Date(ev.start.dateTime).toISOString();
  const endIso = allDay
    ? new Date(`${addDay(ev.end.date, -1)}T12:00:00${offsetOf(ev.end.date)}`).toISOString()
    : ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : null;
  const kind = ["meeting", "focus", "away"].includes(p.arli_kind) ? p.arli_kind : "meeting";
  const notes = String(ev.description ?? "").split(/\n\n/).filter((l) => !l.includes("נוצר במערכת של aRLi") && !/^(בלוק עבודה|לא זמינה|משתתפות:|פרויקט:)/.test(l)).join("\n\n").trim();
  return {
    title: ev.summary || "(בלי כותרת)",
    starts_at: startIso, ends_at: endIso, all_day: allDay,
    location: ev.location ?? null,
    notes: notes || null,
    kind,
    partner_ids: p.arli_partners ? String(p.arli_partners).split(",").filter(Boolean) : [],
    project_id: p.arli_project || null,
    task_id: p.arli_task || null,
    meet_link: ev.hangoutLink ?? null,
  };
}

function offsetOf(date: string) {
  return new Intl.DateTimeFormat("en", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${date}T12:00:00Z`)).find((x) => x.type === "timeZoneName")?.value.replace("GMT", "") || "+02:00";
}

async function pull(db: Db, cal: { id: string; owner: string }) {
  const started = new Date();
  const last = await cfg(db, "gcal_last_pull");
  const params: Record<string, string> = {
    singleEvents: "true", showDeleted: "true", maxResults: "250",
    timeMin: new Date(Date.now() - 60 * 864e5).toISOString(),
    timeMax: new Date(Date.now() + 400 * 864e5).toISOString(),
  };
  if (last) params.updatedMin = new Date(new Date(last).getTime() - 2 * 60e3).toISOString();
  const items: Json[] = [];
  let page: string | undefined;
  do {
    const res = await gcal(db, cal.owner, `calendars/${encodeURIComponent(cal.id)}/events`, { params: { ...params, ...(page ? { pageToken: page } : {}) } });
    items.push(...(res.items ?? []));
    page = res.nextPageToken;
  } while (page && items.length < 2000);

  const ids = items.map((e) => e.id as string);
  const known: { id: string; google_event_id: string; google_synced_at: string | null; needs_push: boolean }[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await db.from("meetings").select("id,google_event_id,google_synced_at,needs_push").eq("is_private", false).in("google_event_id", ids.slice(i, i + 100));
    known.push(...(data ?? []));
  }
  const byEvent = new Map(known.map((k) => [k.google_event_id, k]));
  const gone: string[] = [];
  let changed = 0;
  for (const ev of items) {
    const row = byEvent.get(ev.id);
    if (ev.status === "cancelled") { if (row) gone.push(ev.id); continue; }
    if (row?.needs_push) continue; // a local change is waiting; it wins and goes up on the next push
    // Our own push: Google's "updated" is not after our last write.
    if (row?.google_synced_at && new Date(ev.updated).getTime() <= new Date(row.google_synced_at).getTime() + 5000) continue;
    const values = { ...fromEvent(ev), google_event_id: ev.id, google_calendar_id: cal.id, google_partner_id: cal.owner, google_synced_at: new Date().toISOString(), needs_push: false };
    // An event first created by the app but not yet linked (crash between insert and update).
    const appId = ev.extendedProperties?.private?.arli_id;
    if (row) {
      await db.from("meetings").update(values).eq("id", row.id);
    } else if (appId && (await db.from("meetings").select("id").eq("id", appId).is("google_event_id", null).maybeSingle()).data) {
      await db.from("meetings").update(values).eq("id", appId);
    } else {
      const { error } = await db.from("meetings").insert(values);
      if (error) { // the project or task it pointed to is gone
        await db.from("meetings").insert({ ...values, project_id: null, task_id: null });
      }
    }
    changed++;
  }
  if (gone.length) await db.rpc("calendar_delete_synced", { event_ids: gone });
  await setCfg(db, "gcal_last_pull", started.toISOString());
  return { changed, deleted: gone.length };
}

// ---------- each partner's personal Google calendars ----------
// Her personal events come in with titles (only she can read them in the app; the other partner sees "busy").
// Calendars she can only see as free/busy come in without titles. Her private system events, which live in her
// own Google calendar, are synced back both ways here. Nothing here ever goes to the other partner.
const READABLE = new Set(["owner", "writer", "reader"]);

function spanOf(ev: Json) {
  if (ev.start?.date) {
    return {
      starts_at: new Date(`${ev.start.date}T00:00:00${offsetOf(ev.start.date)}`).toISOString(),
      ends_at: new Date(`${ev.end.date}T00:00:00${offsetOf(ev.end.date)}`).toISOString(), all_day: true,
    };
  }
  return { starts_at: new Date(ev.start.dateTime).toISOString(), ends_at: new Date(ev.end?.dateTime ?? ev.start.dateTime).toISOString(), all_day: false };
}

async function refreshPersonal(db: Db, accounts: Account[], sharedId: string | null) {
  const timeMin = new Date(Date.now() - 864e5).toISOString();
  const timeMax = new Date(Date.now() + 45 * 864e5).toISOString();
  for (const a of accounts) {
    const list = await gcal(db, a.partner_id, "users/me/calendarList", { params: { minAccessRole: "freeBusyReader", maxResults: "100" } });
    const cals = (list.items ?? []).filter((c: Json) => c.id !== sharedId && (c.selected || c.primary) &&
      !String(c.id).includes("#holiday") && !String(c.id).includes("#contacts"));
    const blocks = new Map<string, { starts_at: string; ends_at: string; all_day: boolean; title: string | null }>();
    const mine: Json[] = []; // events of her private system events, from her own calendar

    for (const c of cals.filter((c: Json) => READABLE.has(c.accessRole)).slice(0, 25)) {
      let page: string | undefined, count = 0;
      do {
        const res = await gcal(db, a.partner_id, `calendars/${encodeURIComponent(c.id)}/events`, {
          params: { timeMin, timeMax, singleEvents: "true", showDeleted: "true", maxResults: "250", ...(page ? { pageToken: page } : {}) },
        });
        for (const ev of res.items ?? []) {
          if (ev.extendedProperties?.private?.arli_id) { if (c.primary) mine.push(ev); continue; }
          if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
          if ((ev.attendees ?? []).some((x: Json) => x.self && x.responseStatus === "declined")) continue;
          const sp = spanOf(ev);
          blocks.set(`${sp.starts_at}|${sp.ends_at}|${ev.summary ?? ""}`, { ...sp, title: ev.summary || "(ללא כותרת)" });
        }
        page = res.nextPageToken; count += (res.items ?? []).length;
      } while (page && count < 1000);
    }
    const fbOnly = cals.filter((c: Json) => !READABLE.has(c.accessRole)).map((c: Json) => ({ id: c.id }));
    if (fbOnly.length) {
      const fb = await gcal(db, a.partner_id, "freeBusy", { method: "POST", body: { timeMin, timeMax, timeZone: TZ, items: fbOnly.slice(0, 50) } });
      for (const c of Object.values(fb.calendars ?? {}) as Json[]) {
        for (const b of c.busy ?? []) {
          const s = new Date(b.start).toISOString(), e = new Date(b.end).toISOString();
          blocks.set(`${s}|${e}|`, { starts_at: s, ends_at: e, all_day: false, title: null });
        }
      }
    }
    await db.from("partner_busy").delete().eq("partner_id", a.partner_id);
    if (blocks.size) await db.from("partner_busy").insert([...blocks.values()].map((b) => ({ ...b, partner_id: a.partner_id })));

    // Changes she made in Google to her private events come back to the system.
    const ids = mine.map((e) => e.id as string);
    if (!ids.length) continue;
    const { data: rows } = await db.from("meetings").select("id,google_event_id,google_synced_at,needs_push")
      .eq("is_private", true).eq("created_by_partner_id", a.partner_id).in("google_event_id", ids.slice(0, 200));
    const byEvent = new Map((rows ?? []).map((r) => [r.google_event_id as string, r]));
    const gone: string[] = [];
    for (const ev of mine) {
      const row = byEvent.get(ev.id);
      if (!row || row.needs_push) continue;
      if (ev.status === "cancelled") { gone.push(ev.id); continue; }
      if (row.google_synced_at && new Date(ev.updated).getTime() <= new Date(row.google_synced_at).getTime() + 5000) continue;
      const { partner_ids: _p, ...values } = fromEvent(ev);
      await db.from("meetings").update({ ...values, google_synced_at: new Date().toISOString(), needs_push: false }).eq("id", row.id);
    }
    if (gone.length) await db.rpc("calendar_delete_synced", { event_ids: gone });
  }
}

// ---------- entry ----------
export async function runCalendarSync(db: Db, opts: { busy?: boolean } = {}) {
  const accounts = await calendarAccounts(db);
  if (!accounts.length) return { ok: true, connected: false };
  try {
    const cal = await ensureCalendar(db, accounts);
    if (!cal) return { ok: true, connected: false };
    const deleted = await pushDeletes(db, cal);
    const pushed = await push(db, cal, accounts);
    const pulled = await pull(db, cal);
    const lastBusy = await cfg(db, "gcal_last_busy");
    if (opts.busy || !lastBusy || Date.now() - new Date(lastBusy).getTime() > 10 * 60e3) {
      await refreshPersonal(db, accounts, cal.id);
      await setCfg(db, "gcal_last_busy", new Date().toISOString());
    }
    await db.from("app_config").delete().eq("key", "gcal_last_error");
    return { ok: true, pushed, removed: deleted, ...pulled };
  } catch (e) {
    console.error("calendar sync", e);
    await setCfg(db, "gcal_last_error", `${new Date().toISOString()} ${(e as Error).message}`.slice(0, 500));
    return { ok: false, error: (e as Error).message };
  }
}
