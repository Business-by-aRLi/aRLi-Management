// Pulls the receipts Miri issues in Yesh Invoice (יש חשבונית) into income.
//   POST (x-cron-secret header)    -> every 3 hours from pg_cron (last 45 days)
//   POST (signed-in partner's JWT) -> "sync now" in the app; { full: true } goes back 3 years
//   POST { action: "test" }        -> checks the key and reports how many customers the account has
// Deploy with verify_jwt = false: the function checks the caller itself (cron secret or partner JWT).
//
// The key is saved from the Connections screen (infra_connectors, provider 'yeshinvoice', in Vault) as
// "<userkey>:<secret>". Fallback: Edge Function secrets YESH_USERKEY + YESH_SECRET.
// Yesh Invoice takes the key as a JSON object in the Authorization header: {"secret":"…","userkey":"…"}.
//
// Only documents that record money received become income (receipt, tax invoice-receipt). Each
// document is inserted once (source + external_id); rows already in the app are never overwritten,
// so a client or project assigned by hand stays.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const env = (k: string) => Deno.env.get(k) ?? "";

const API = "https://api.yeshinvoice.co.il/api/v1/";
const DOCS_PATH = "getInvoices";        // Documents - View › View Documents
const CUSTOMERS_PATH = "getAllCustomers"; // Customers › View
// Document types that mean money came in: 6 receipt, 9 tax invoice/receipt. Not 2 order, 5 proforma or
// 8 tax invoice (an invoice alone is a demand; when it is paid, a receipt is issued for it).
// Overridable from the connector's extra.doc_types ("6,9").
const MONEY_IN_TYPES = [6, 9];
const TYPE_NAME: Record<number, string> = { 6: "קבלה", 9: "חשבונית מס קבלה" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function authorized(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  if (secret) {
    const { data } = await db.from("app_config").select("value").eq("key", "cron_secret").single();
    return !!data && secret === data.value;
  }
  const auth = req.headers.get("Authorization");
  if (!auth) return false;
  const user = createClient(SUPABASE_URL, env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await user.rpc("is_partner");
  return data === true;
}

type Conn = { userkey: string; secret: string; partnerId: string | null; types: number[] };
async function connection(): Promise<Conn | null> {
  const { data: row } = await db.from("infra_connectors").select("connected_by,extra").eq("provider", "yeshinvoice").maybeSingle();
  let userkey = env("YESH_USERKEY"), secret = env("YESH_SECRET");
  if (row) {
    const key = ((await db.rpc("connector_key", { p_provider: "yeshinvoice" })).data as string | null) ?? "";
    const at = key.indexOf(":");
    if (at > 0) { userkey = key.slice(0, at).trim(); secret = key.slice(at + 1).trim(); }
  }
  if (!userkey || !secret) return null;
  const extra = (row?.extra ?? {}) as Record<string, string>;
  const types = (extra.doc_types ?? "").split(",").map(Number).filter((n) => n > 0);
  return { userkey, secret, partnerId: extra.partner_id || row?.connected_by || null, types: types.length ? types : MONEY_IN_TYPES };
}

async function markCheck(ok: boolean, message: string) {
  await db.from("infra_connectors").update({ checked_at: new Date().toISOString(), check_ok: ok, check_message: message.slice(0, 300) })
    .eq("provider", "yeshinvoice");
}

// deno-lint-ignore no-explicit-any
async function call(c: Conn, path: string, body: unknown): Promise<any> {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: JSON.stringify({ secret: c.secret, userkey: c.userkey }) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  // deno-lint-ignore no-explicit-any
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`יש חשבונית ענתה ${r.status}: ${text.slice(0, 160)}`); }
  if (!r.ok || data?.Success === false) throw new Error(data?.ErrorMessage || `יש חשבונית ענתה ${r.status}`);
  return data;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
// "07-02-2023" (dd-MM-yyyy) or ISO -> "2023-02-07"
function isoDate(s: string): string | null {
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s ?? "");
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? "");
  return iso ? iso[0] : null;
}
const norm = (s: string | null | undefined) => (s ?? "").replace(/["'״׳`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

// deno-lint-ignore no-explicit-any
type Doc = Record<string, any>;
async function documents(c: Conn, from: Date, to: Date): Promise<Doc[]> {
  const out: Doc[] = [];
  for (let page = 1; page <= 50; page++) {
    const data = await call(c, DOCS_PATH, {
      CustomerID: -1, PageSize: 100, PageNumber: page, docTypes: c.types, Search: "", from: stamp(from), to: stamp(to),
    });
    const list: Doc[] = data.ReturnValue ?? [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!(await authorized(req))) return json({ error: "אין הרשאה" }, 403);
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));
  const c = await connection();
  if (!c) return json({ ok: false, error: "יש חשבונית לא מחוברת" });

  if (body.action === "test") {
    try {
      const data = await call(c, CUSTOMERS_PATH, { PageSize: 100, PageNumber: 1, Search: "", PortfolioID: 0 });
      const n = (data.ReturnValue ?? []).length;
      await markCheck(true, `מחובר · ${n >= 100 ? "100+" : n} לקוחות`);
      return json({ ok: true, customers: n });
    } catch (e) {
      await markCheck(false, (e as Error).message);
      return json({ ok: false, error: (e as Error).message });
    }
  }

  try {
    // History on request or on the first run; otherwise the last 45 days (late or back-dated receipts).
    const { count } = await db.from("income").select("id", { count: "exact", head: true }).eq("source", "yeshinvoice");
    const years = body.full || !count ? 3 : 0;
    const to = new Date(Date.now() + 24 * 3600 * 1000);
    const from = years ? new Date(Date.UTC(to.getUTCFullYear() - years, 0, 1)) : new Date(Date.now() - 45 * 24 * 3600 * 1000);
    const docs = (await documents(c, from, to)).filter((d) => c.types.includes(Number(d.DocumentType)));

    const ids = docs.map((d) => `${d.DocumentType}-${d.DocumentNumber}`);
    const { data: have } = await db.from("income").select("external_id").eq("source", "yeshinvoice").in("external_id", ids.length ? ids : ["-"]);
    const known = new Set((have ?? []).map((r) => r.external_id));

    const { data: clients } = await db.from("clients").select("id,name,yesh_customer_id");
    const { data: projects } = await db.from("projects").select("id,client_id,status");
    const byRef = new Map((clients ?? []).filter((k) => k.yesh_customer_id).map((k) => [String(k.yesh_customer_id), k.id]));
    const byName = new Map((clients ?? []).map((k) => [norm(k.name), k.id]));
    const onlyProject = (clientId: string | null) => {
      const open = (projects ?? []).filter((p) => p.client_id === clientId && p.status !== "closed");
      return clientId && open.length === 1 ? open[0].id : null;
    };

    const rows = [];
    const learned: { id: string; ref: string }[] = [];
    let skipped = 0;
    for (const d of docs) {
      const external_id = `${d.DocumentType}-${d.DocumentNumber}`;
      if (known.has(external_id)) continue;
      const amount = Math.round(Number(d.TotalPrice ?? 0) * 100) / 100;
      const received_on = isoDate(String(d.Date ?? ""));
      if (!(amount > 0) || !received_on) { skipped++; continue; }
      const ref = d.CustomerID != null && Number(d.CustomerID) > 0 ? String(d.CustomerID) : null;
      const client_id = (ref && byRef.get(ref)) || byName.get(norm(d.CustomerName)) || null;
      // matched by name: remember the Yesh customer id on the client, unless it already has one
      const hasRef = (clients ?? []).some((k) => k.id === client_id && k.yesh_customer_id);
      if (client_id && ref && !byRef.has(ref) && !hasRef) { learned.push({ id: client_id, ref }); byRef.set(ref, client_id); }
      const type = Number(d.DocumentType);
      rows.push({
        source: "yeshinvoice", external_id, doc_type: type, amount, received_on, client_id, project_id: onlyProject(client_id),
        received_by_partner_id: c.partnerId, reference: `${TYPE_NAME[type] ?? "מסמך"} ${d.DocumentNumber}`,
        customer_name: d.CustomerName ?? null, customer_ref: ref, pdf_url: d.pdfUrl || null,
        notes: d.Title ? String(d.Title).slice(0, 300) : null,
      });
    }
    for (const l of learned) await db.from("clients").update({ yesh_customer_id: l.ref }).eq("id", l.id).is("yesh_customer_id", null);
    if (rows.length) {
      const w = await db.from("income").insert(rows);
      if (w.error) throw new Error(w.error.message);
    }
    const unmatched = rows.filter((r) => !r.client_id).length;
    const report = `נמצאו ${docs.length} קבלות, ${rows.length} חדשות` + (unmatched ? `, ${unmatched} מחכות לשיוך` : "") + (skipped ? `, ${skipped} דולגו` : "");
    await markCheck(true, report);
    await db.from("app_config").upsert({ key: "invoice_sync_last", value: JSON.stringify({ at: new Date().toISOString(), report }) });
    return json({ ok: true, found: docs.length, added: rows.length, unmatched, report });
  } catch (e) {
    await markCheck(false, (e as Error).message);
    return json({ ok: false, error: (e as Error).message });
  }
});
