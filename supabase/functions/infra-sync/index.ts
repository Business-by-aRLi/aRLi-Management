// Pulls infrastructure costs from the providers and files them under the project they belong to.
//   POST  (x-cron-secret header)        -> daily run from pg_cron
//   POST  (signed-in partner's JWT)     -> "sync now" button in the web app
//   POST  { action: "resources", provider } (partner JWT) -> test the connection and list the
//         provider's projects/workspaces, so the app can offer them in a dropdown
//   POST  { action: "supabase_invoice", path } (partner JWT) -> read an uploaded Supabase invoice PDF
//         (receipts bucket) and file each project's amount
// The daily run also looks in the partners' connected Gmail for new Supabase invoices.
// Deploy with verify_jwt = false: the function checks the caller itself (cron secret or partner JWT).
//
// Keys come from the app's Connections screen (infra_connectors, encrypted in Vault), with the
// Edge Function secrets below as a fallback.
// Mapping: every row in infra_services has a provider and a resource_ref (the id at the provider).
//   vercel    -> Vercel project id or name          (VERCEL_TOKEN, team id in extra.team_id / VERCEL_TEAM_ID)
//   anthropic -> Claude Console workspace id         (ANTHROPIC_ADMIN_KEY)
//   openai    -> OpenAI project id (proj_...)        (OPENAI_ADMIN_KEY)
//   supabase  -> Supabase project ref (usage only)   (SUPABASE_MGMT_TOKEN)
// A provider without a key is skipped. The daily run rewrites this month and last month (last month's
// numbers settle after it ends). A full run ({ full: true }, "sync now", or a service with no costs yet)
// goes back 12 months, Vercel's limit. One row per service and month, source = provider.
// Supabase has no per-project cost API, so it only refreshes the usage note on the service.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { answerText, b64, gemini, S } from "../_shared/gemini.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const env = (k: string) => Deno.env.get(k) ?? "";

const ENV_KEY: Record<string, string> = {
  vercel: "VERCEL_TOKEN", anthropic: "ANTHROPIC_ADMIN_KEY", openai: "OPENAI_ADMIN_KEY", supabase: "SUPABASE_MGMT_TOKEN",
};
// Key and settings for a provider: the connection saved in the app first, then the function's env secret.
const keys: Record<string, { key: string; extra: Record<string, string> }> = {};
async function loadKeys() {
  const { data: rows } = await db.from("infra_connectors").select("provider,extra");
  for (const p of Object.keys(ENV_KEY)) {
    const row = (rows ?? []).find((r) => r.provider === p);
    let key = "";
    if (row) key = ((await db.rpc("connector_key", { p_provider: p })).data as string | null) ?? "";
    keys[p] = { key: key || env(ENV_KEY[p]), extra: (row?.extra ?? {}) as Record<string, string> };
  }
}
const keyOf = (p: string) => keys[p]?.key ?? "";
let detectedTeam = "";
const vercelTeam = () => keys.vercel?.extra?.team_id || env("VERCEL_TEAM_ID") || detectedTeam;
// Billing is per team. Without a team id set, use the account's team when it has exactly one.
async function detectVercelTeam() {
  if (vercelTeam() || !keyOf("vercel")) return;
  try {
    const r = await fetch("https://api.vercel.com/v2/teams?limit=20", { headers: { Authorization: `Bearer ${keyOf("vercel")}` } });
    if (!r.ok) return;
    const teams = (await r.json()).teams ?? [];
    if (teams.length === 1) detectedTeam = teams[0].id;
  } catch { /* personal account */ }
}
async function markCheck(provider: string, ok: boolean, message: string) {
  await db.from("infra_connectors").update({ checked_at: new Date().toISOString(), check_ok: ok, check_message: message.slice(0, 300) })
    .eq("provider", provider);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Service = { id: string; provider: string; resource_ref: string | null };
// month (YYYY-MM-01) -> resource key (lower case) -> USD
type Costs = Map<string, Map<string, number>>;

const monthOf = (iso: string) => iso.slice(0, 7) + "-01";

// What was used, per line item: stored as infra_costs.breakdown so the card can show it.
type Item = { item: string; qty: number; unit: string; cost: number };
// month -> resource key (lower case) -> item name -> totals. Filled by the pullers that report usage.
const usage = new Map<string, Map<string, Map<string, Item>>>();
const addUsage = (month: string, key: string, item: string, qty: number, unit: string, cost: number) => {
  if (!item) return;
  const byKey = usage.get(month) ?? new Map<string, Map<string, Item>>();
  const items = byKey.get(key.toLowerCase()) ?? new Map<string, Item>();
  const it = items.get(item) ?? { item, qty: 0, unit, cost: 0 };
  it.qty += Number.isFinite(qty) ? qty : 0;
  it.cost += Number.isFinite(cost) ? cost : 0;
  items.set(item, it);
  byKey.set(key.toLowerCase(), items);
  usage.set(month, byKey);
};
const breakdownOf = (month: string, key: string) => {
  const items = usage.get(month)?.get(key.toLowerCase());
  if (!items?.size) return null;
  return [...items.values()]
    .map((i) => ({ ...i, qty: Math.round(i.qty * 1000) / 1000, cost: Math.round(i.cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost || b.qty - a.qty);
};
const add = (c: Costs, month: string, key: string, usd: number) => {
  if (!key || !Number.isFinite(usd)) return;
  const m = c.get(month) ?? new Map<string, number>();
  m.set(key.toLowerCase(), (m.get(key.toLowerCase()) ?? 0) + usd);
  c.set(month, m);
};

function period(monthsBack: number) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { from, to };
}

async function getJson(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Vercel: FOCUS billing charges, JSONL, BilledCost in USD. Tags carry the Vercel project id and name.
// The file lists every charge per day for the whole team, so it is fetched one month at a time and
// read line by line to stay inside the function's memory.
async function vercel(from: Date, to: Date): Promise<Costs> {
  const out: Costs = new Map();
  for (let start = new Date(from); start < to;) {
    const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const end = next < to ? next : to;
    const qs = new URLSearchParams({ from: start.toISOString(), to: end.toISOString() });
    if (vercelTeam()) qs.set("teamId", vercelTeam());
    const r = await fetch(`https://api.vercel.com/v1/billing/charges?${qs}`, { headers: { Authorization: `Bearer ${keyOf("vercel")}` } });
    // A month with no billing data (before the team was on a paid plan) answers 404 costs_not_found.
    if (r.status === 404) { await r.body?.cancel(); start = next; continue; }
    if (!r.ok) throw new Error(`vercel ${r.status}: ${(await r.text()).slice(0, 200)}`);
    let buf = "";
    const take = (line: string) => {
      if (!line.trim()) return;
      const c = JSON.parse(line);
      const usd = Number(c.BilledCost ?? 0);
      const qty = Number(c.ConsumedQuantity ?? c.PricingQuantity ?? 0);
      // Usage inside the plan's included amount costs 0 but is still usage worth showing.
      if (!usd && !qty) return;
      const tags: Record<string, string> = typeof c.Tags === "object" && c.Tags ? c.Tags : {};
      const month = monthOf(String(c.ChargePeriodStart));
      // Count the charge once under each identifier, so a service can be mapped by project id or by name.
      const keys = new Set(Object.entries(tags).filter(([k]) => /project/i.test(k)).map(([, v]) => String(v)));
      if (!keys.size) keys.add("*"); // team-level charge (plan, seats): resource_ref "*" collects it
      const item = String(c.ServiceName ?? c.ChargeDescription ?? c.SkuId ?? "");
      const unit = String(c.ConsumedUnit ?? c.PricingUnit ?? "");
      for (const k of keys) {
        if (usd) add(out, month, k, usd);
        addUsage(month, k, item, qty, unit, usd);
      }
    };
    for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    take(buf);
    start = next;
  }
  return out;
}

const ANTHROPIC_HEADERS = () => ({ "x-api-key": keyOf("anthropic"), "anthropic-version": "2023-06-01" });

// Anthropic: cost report grouped by workspace. amount is a decimal string in cents.
async function anthropic(from: Date, to: Date): Promise<Costs> {
  const out: Costs = new Map();
  let page = "";
  do {
    const qs = new URLSearchParams({ starting_at: from.toISOString(), ending_at: to.toISOString(), bucket_width: "1d", limit: "31" });
    qs.append("group_by[]", "workspace_id");
    if (page) qs.set("page", page);
    const j = await getJson(`https://api.anthropic.com/v1/organizations/cost_report?${qs}`,
      ANTHROPIC_HEADERS());
    for (const b of j.data ?? []) for (const r of b.results ?? []) {
      add(out, monthOf(b.starting_at), r.workspace_id ?? "default", Number(r.amount) / 100);
    }
    page = j.has_more ? j.next_page : "";
  } while (page);
  return out;
}

// OpenAI: organization costs grouped by project. amount.value is in dollars.
async function openai(from: Date, to: Date): Promise<Costs> {
  const out: Costs = new Map();
  let page = "";
  do {
    const qs = new URLSearchParams({
      start_time: String(Math.floor(from.getTime() / 1000)), end_time: String(Math.floor(to.getTime() / 1000)),
      bucket_width: "1d", limit: "180",
    });
    qs.append("group_by", "project_id");
    if (page) qs.set("page", page);
    const j = await getJson(`https://api.openai.com/v1/organization/costs?${qs}`, { Authorization: `Bearer ${keyOf("openai")}` });
    for (const b of j.data ?? []) for (const r of b.results ?? []) {
      add(out, monthOf(new Date(b.start_time * 1000).toISOString()), r.project_id ?? "default", Number(r.amount?.value ?? 0));
    }
    page = j.has_more ? j.next_page : "";
  } while (page);
  return out;
}

// Supabase: no cost API per project, so only a usage note (API requests in the last 7 days).
async function supabaseUsage(services: Service[]) {
  const errors: string[] = [];
  for (const s of services) {
    if (!s.resource_ref) continue;
    try {
      const j = await getJson(
        `https://api.supabase.com/v1/projects/${encodeURIComponent(s.resource_ref)}/analytics/endpoints/usage.api-counts?interval=7day`,
        { Authorization: `Bearer ${keyOf("supabase")}` });
      const kinds: [string, string][] = [["REST (מסד נתונים)", "total_rest_requests"], ["Auth (התחברות)", "total_auth_requests"],
        ["Storage (קבצים)", "total_storage_requests"], ["Realtime", "total_realtime_requests"]];
      // deno-lint-ignore no-explicit-any
      const sum = (k: string) => (j.result ?? []).reduce((n: number, r: any) => n + Number(r[k] ?? 0), 0);
      const items = kinds.map(([item, k]) => ({ item, qty: sum(k), unit: "בקשות" })).filter((i) => i.qty > 0);
      const total = items.reduce((n, i) => n + i.qty, 0);
      await db.from("infra_services").update({
        usage_note: `${total.toLocaleString("en-US")} בקשות API ב־7 הימים האחרונים`, usage: items, usage_synced_at: new Date().toISOString(),
      }).eq("id", s.id);
    } catch (e) { errors.push(`supabase ${s.resource_ref}: ${(e as Error).message}`); }
  }
  return errors;
}

// The provider's projects / workspaces, for the dropdown in the app. Also proves the key works.
type Resource = { id: string; name: string };
async function resources(provider: string): Promise<Resource[]> {
  // deno-lint-ignore no-explicit-any
  const map = (list: any[], id: string, name: string) => list.map((x) => ({ id: String(x[id]), name: String(x[name] ?? x[id]) }));
  if (provider === "vercel") {
    const qs = new URLSearchParams({ limit: "100" });
    if (vercelTeam()) qs.set("teamId", vercelTeam());
    const j = await getJson(`https://api.vercel.com/v9/projects?${qs}`, { Authorization: `Bearer ${keyOf("vercel")}` });
    return [{ id: "*", name: "עלות התוכנית של הצוות" }, ...map(j.projects ?? [], "id", "name")];
  }
  if (provider === "anthropic") {
    const j = await getJson("https://api.anthropic.com/v1/organizations/workspaces?limit=100", ANTHROPIC_HEADERS());
    return [{ id: "default", name: "Default workspace" }, ...map(j.data ?? [], "id", "name")];
  }
  if (provider === "openai") {
    const j = await getJson("https://api.openai.com/v1/organization/projects?limit=100", { Authorization: `Bearer ${keyOf("openai")}` });
    return map(j.data ?? [], "id", "name");
  }
  if (provider === "supabase") {
    const j = await getJson("https://api.supabase.com/v1/projects", { Authorization: `Bearer ${keyOf("supabase")}` });
    return [{ id: "*", name: "עלות התוכנית של הארגון" }, ...map(Array.isArray(j) ? j : [], "id", "name")];
  }
  return [];
}

// ---------- Supabase invoice (PDF) -> cost per project ----------
const NOT_INVOICE = "זו לא נראית חשבונית Supabase עם פירוט לפי פרויקט";
const invoiceSchema = S("object", undefined, {
  properties: {
    is_supabase_invoice: S("boolean", "Is this a Supabase invoice or receipt with line items"),
    period_month: S("string", "The billing period month the charges are for, YYYY-MM (usage period, not the issue date)"),
    currency: S("string", "USD, EUR..."),
    total: S("number", "Invoice total"),
    projects: S("array", "One entry per Supabase project that appears in the line items", {
      items: S("object", undefined, {
        properties: {
          name: S("string", "Project name as written in the invoice"),
          ref: S("string", "Project ref/id if written (20 lowercase letters), else empty"),
          amount: S("number", "Sum of all this project's line items (compute, disk, egress, add-ons...) after discounts"),
          items: S("array", "This project's line items as written in the invoice", {
            items: S("object", undefined, {
              properties: {
                description: S("string", "Line item, e.g. Compute Hours Micro, Disk Size GB-Hours, Egress"),
                quantity: S("number", "Quantity billed, if written"),
                unit: S("string", "Unit of the quantity: hours, GB, GB-Hrs, MAU..."),
                amount: S("number", "Amount for this line after discounts"),
              },
              required: ["description", "amount"],
            }),
          }),
        },
        required: ["name", "amount"],
      }),
    }),
    organization_amount: S("number", "Charges not tied to one project: plan subscription, seats, minus organization-wide credits/discounts"),
  },
  required: ["is_supabase_invoice"],
});

type Parsed = { is_supabase_invoice: boolean; period_month?: string; currency?: string; total?: number;
  projects?: { name: string; ref?: string; amount: number; items?: { description: string; quantity?: number; unit?: string; amount: number }[] }[];
  organization_amount?: number };

async function parseInvoice(bytes: Uint8Array, mime: string): Promise<Parsed> {
  const res = await gemini({
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: mime, data: b64(bytes) } },
      { text: "This should be a Supabase invoice. Extract the billing month and the amount per project, plus organization-level charges. For each project also list its line items (compute hours, disk, egress...) with quantity and unit where the invoice shows them." },
    ] }],
    // Reading a table needs no reasoning; without thinking a 15-project invoice takes seconds, not minutes.
    generationConfig: { responseMimeType: "application/json", responseSchema: invoiceSchema, thinkingConfig: { thinkingBudget: 0 } },
  });
  return JSON.parse(answerText(res));
}

type Line = { name: string; ref: string; amount: number; items?: Item[] };
// Raise to read stored invoices again (an invoice whose result.v is lower is read once more).
// Re-reading for line items was tried (v2): each read took about a minute and the model returned
// the project totals without items, so stored invoices are not read again.
const INVOICE_VERSION = 1;

// Files an invoice's amounts on the Supabase services they belong to (by ref, else by project name).
async function applyInvoice(sourceKey: string, parsed: Parsed) {
  if (!parsed.is_supabase_invoice || !/^\d{4}-\d{2}$/.test(parsed.period_month ?? "")) {
    throw new Error(NOT_INVOICE);
  }
  const month = `${parsed.period_month}-01`;
  // Names of the Supabase projects, to match an invoice line that shows only a name.
  let names = new Map<string, string>(); // lower name -> ref
  if (keyOf("supabase")) {
    try { names = new Map((await resources("supabase")).map((r) => [r.name.toLowerCase(), r.id])); } catch { /* match by ref only */ }
  }
  const lines: Line[] = (parsed.projects ?? []).map((p) => ({
    name: p.name, ref: p.ref || names.get(p.name.toLowerCase()) || "", amount: Number(p.amount) || 0,
    items: (p.items ?? []).map((i) => ({ item: i.description, qty: Number(i.quantity ?? 0), unit: i.unit ?? "", cost: Number(i.amount) || 0 })),
  }));
  if (parsed.organization_amount) lines.push({ name: "ארגון (תוכנית)", ref: "*", amount: Number(parsed.organization_amount) });
  const result = await fileLines(month, lines);
  await db.from("infra_invoice_imports").upsert({
    source_key: sourceKey, provider: "supabase", month, total: parsed.total ?? null, currency: parsed.currency ?? null, result: { ...result, v: INVOICE_VERSION },
  });
  return result;
}

// Invoices already read are matched again on every run, so a Supabase service added to a project
// later picks up its past months without reading the PDF again.
async function reapplyInvoices() {
  const { data } = await db.from("infra_invoice_imports").select("source_key,month,result").eq("provider", "supabase").not("month", "is", null);
  for (const imp of data ?? []) {
    const lines = (imp.result?.lines ?? []) as Line[];
    if (!lines.length) continue;
    const result = await fileLines(imp.month, lines);
    await db.from("infra_invoice_imports").update({ result: { ...result, v: imp.result?.v ?? 1 } }).eq("source_key", imp.source_key);
  }
}

async function fileLines(month: string, lines: Line[]) {
  const { data: rows } = await db.from("infra_services").select("id,resource_ref,name").eq("provider", "supabase");
  const services = (rows ?? []) as { id: string; resource_ref: string | null; name: string }[];
  const byRef = new Map<string, number>();
  const items = new Map<string, Item[]>();
  const unmatched: { name: string; amount: number }[] = [];
  for (const l of lines) {
    const key = (l.ref || l.name).toLowerCase();
    const hit = services.filter((s) => (s.resource_ref ?? "").toLowerCase() === key || (!s.resource_ref && s.name.toLowerCase() === l.name.toLowerCase()));
    if (!hit.length) { unmatched.push({ name: l.name, amount: l.amount }); continue; }
    for (const s of hit) {
      byRef.set(s.id, (byRef.get(s.id) ?? 0) + l.amount);
      items.set(s.id, [...(items.get(s.id) ?? []), ...(l.items ?? [])]);
    }
  }
  const upserts = [...byRef].map(([service_id, amount]) => ({
    service_id, month, amount: Math.round(amount * 100) / 100, source: "supabase_invoice",
    usage_note: "מחשבונית Supabase", breakdown: items.get(service_id)?.length ? items.get(service_id) : null, synced_at: new Date().toISOString(),
  }));
  if (upserts.length) {
    const w = await db.from("infra_costs").upsert(upserts, { onConflict: "service_id,month,source" });
    if (w.error) throw new Error(w.error.message);
  }
  return { month, matched: upserts.length, unmatched, lines };
}

// Gmail: Supabase invoices from the last 45 days in each connected mailbox, each read once.
function fromB64Url(data: string): Uint8Array {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function googleToken(refresh: string) {
  const tok = await (await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refresh, client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), grant_type: "refresh_token" }),
  })).json();
  if (!tok.access_token) throw new Error(`Google: ${tok.error ?? "no token"}`);
  return tok.access_token as string;
}
async function gmailInvoices(full: boolean) {
  const report: string[] = [], errors: string[] = [];
  const { data: accounts } = await db.from("gmail_accounts").select("partner_id,email,refresh_token");
  for (const acc of accounts ?? []) {
    try {
      const token = await googleToken(acc.refresh_token);
      const g = (path: string, params: Record<string, string> = {}) =>
        getJson(`https://gmail.googleapis.com/gmail/v1/users/me/${path}?${new URLSearchParams(params)}`, { Authorization: `Bearer ${token}` });
      const list = await g("messages", { q: `from:supabase has:attachment newer_than:${full ? 400 : 45}d (invoice OR receipt)`, maxResults: full ? "13" : "5" });
      const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);
      if (!ids.length) continue;
      const { data: seen } = await db.from("infra_invoice_imports").select("source_key,month,result").in("source_key", ids.map((i) => `gmail:${i}`));
      // Skipped mails stay skipped; invoices read before line items were kept are read again.
      const done = new Set((seen ?? []).filter((r) => !r.month || (r.result?.v ?? 1) >= INVOICE_VERSION).map((r) => r.source_key));
      // Each invoice takes a model call of 30-70 seconds and the function is stopped after 150, so a run
      // reads at most 3 and starts none after 40 seconds; the next run continues.
      let budget = 3;
      for (const id of ids) {
        if (done.has(`gmail:${id}`)) continue;
        if (budget-- <= 0 || Date.now() - started > 40_000) { report.push("ממשיך בסנכרון הבא"); break; }
        const m = await g(`messages/${id}`, { format: "full" });
        // deno-lint-ignore no-explicit-any
        const pdfs: any[] = [];
        // deno-lint-ignore no-explicit-any
        const walk = (p: any) => { if (!p) return; if (/\.pdf$/i.test(p.filename ?? "") || p.mimeType === "application/pdf") pdfs.push(p); (p.parts ?? []).forEach(walk); };
        walk(m.payload);
        // Stripe mails carry an invoice and a receipt: the invoice holds the line items.
        const pdf = pdfs.find((p) => /invoice/i.test(p.filename)) ?? pdfs[0];
        if (!pdf) continue;
        const data = pdf.body?.data ?? (await g(`messages/${id}/attachments/${pdf.body.attachmentId}`)).data;
        try {
          console.log(`invoice ${id}: reading (${Math.round((Date.now() - started) / 1000)}s, ${data.length} b64 chars)`);
          const parsed = await parseInvoice(fromB64Url(data), "application/pdf");
          console.log(`invoice ${id}: parsed ${parsed.period_month} (${Math.round((Date.now() - started) / 1000)}s)`);
          const r = await applyInvoice(`gmail:${id}`, parsed);
          report.push(`חשבונית ${r.month.slice(0, 7)}: ${r.matched} שירותים`);
        } catch (e) {
          const msg = (e as Error).message;
          // Not an invoice with project lines (e.g. a plain receipt): remember it so it is not read again.
          if (msg.startsWith(NOT_INVOICE)) await db.from("infra_invoice_imports").upsert({ source_key: `gmail:${id}`, result: { skipped: msg } });
          else errors.push(`Gmail ${acc.email}: ${msg}`);
        }
      }
    } catch (e) { errors.push(`Gmail ${acc.email}: ${(e as Error).message}`); }
  }
  return { report, errors };
}

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

const PULLERS: Record<string, { run: (from: Date, to: Date) => Promise<Costs> }> = {
  vercel: { run: vercel }, anthropic: { run: anthropic }, openai: { run: openai },
};

let started = 0;
Deno.serve(async (req) => {
  started = Date.now();
  usage.clear(); // a warm worker serves several requests: start each with empty usage totals
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!(await authorized(req))) return json({ error: "אין הרשאה" }, 403);
  // deno-lint-ignore no-explicit-any
  const body: any = await req.json().catch(() => ({}));
  await loadKeys();
  await detectVercelTeam();

  if (body.action === "supabase_invoice") {
    const path = String(body.path ?? "");
    const file = await db.storage.from("receipts").download(path);
    if (file.error || !file.data) return json({ ok: false, error: "לא מצאתי את הקובץ" });
    try {
      const bytes = new Uint8Array(await file.data.arrayBuffer());
      const mime = /\.pdf$/i.test(path) ? "application/pdf" : (file.data.type || "image/jpeg");
      return json({ ok: true, ...(await applyInvoice(`upload:${path}`, await parseInvoice(bytes, mime))) });
    } catch (e) { return json({ ok: false, error: (e as Error).message }); }
  }

  if (body.action === "resources") {
    const provider = String(body.provider ?? "");
    if (!ENV_KEY[provider]) return json({ error: "ספק לא מוכר" }, 400);
    if (!keyOf(provider)) return json({ ok: false, error: "הספק לא מחובר" });
    try {
      const list = await resources(provider);
      await markCheck(provider, true, `מחובר · ${list.length} פריטים`);
      return json({ ok: true, resources: list });
    } catch (e) {
      const msg = (e as Error).message;
      await markCheck(provider, false, msg);
      return json({ ok: false, error: msg });
    }
  }

  const { data: rows, error } = await db.from("infra_services").select("id,provider,resource_ref").eq("active", true);
  if (error) return json({ error: error.message }, 500);
  const services = (rows ?? []) as Service[];
  // History: a full run on request, or when a mapped service has no cost rows yet (just added).
  const { data: have } = await db.from("infra_costs").select("service_id").neq("source", "manual");
  const withCosts = new Set((have ?? []).map((r) => r.service_id));
  const needsHistory = (list: Service[]) => !!body.full || list.some((s) => !withCosts.has(s.id));
  const report: Record<string, string> = {};
  const errors: string[] = [];

  for (const [provider, p] of Object.entries(PULLERS)) {
    const mine = services.filter((s) => s.provider === provider && s.resource_ref);
    if (!mine.length) continue;
    if (!keyOf(provider)) { report[provider] = `${provider} לא מחובר`; continue; }
    try {
      const { from, to } = period(needsHistory(mine) ? 11 : 1);
      const costs = await p.run(from, to);
      const upserts = [];
      const months: string[] = [];
      for (let d = new Date(from); d < to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(monthOf(d.toISOString()));
      for (const month of months) {
        const byKey = costs.get(month) ?? new Map();
        for (const s of mine) {
          const amount = Math.round((byKey.get(s.resource_ref!.toLowerCase()) ?? 0) * 100) / 100;
          upserts.push({ service_id: s.id, month, amount, source: provider, breakdown: breakdownOf(month, s.resource_ref!), synced_at: new Date().toISOString() });
        }
      }
      const w = await db.from("infra_costs").upsert(upserts, { onConflict: "service_id,month,source" });
      if (w.error) throw new Error(w.error.message);
      report[provider] = `עודכנו ${mine.length} שירותים`;
      await markCheck(provider, true, "סנכרון הצליח");
    } catch (e) {
      errors.push(`${provider}: ${(e as Error).message}`);
      await markCheck(provider, false, (e as Error).message);
    }
  }

  const sb = services.filter((s) => s.provider === "supabase" && s.resource_ref);
  if (sb.length) {
    if (!keyOf("supabase")) report.supabase = "supabase לא מחובר";
    else { errors.push(...await supabaseUsage(sb)); report.supabase = `עודכן שימוש ל־${sb.length} פרויקטים`; }
  }

  try { await reapplyInvoices(); } catch (e) { errors.push(`invoices: ${(e as Error).message}`); }

  // Supabase invoices from Gmail (daily run, and "sync now" from the Connections screen).
  if (body.gmail ?? !!req.headers.get("x-cron-secret")) {
    // history: look back a year for invoices without re-pulling 12 months of provider costs first,
    // which alone can take most of the time limit.
    const g = await gmailInvoices(!!body.full || !!body.history);
    if (g.report.length) report.supabase_invoice = g.report.join(" · ");
    errors.push(...g.errors);
  }

  await db.from("app_config").upsert({ key: "infra_sync_last", value: JSON.stringify({ at: new Date().toISOString(), report, errors }) });
  return json({ ok: errors.length === 0, report, errors });
});
