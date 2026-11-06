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
async function vercel(from: Date, to: Date): Promise<Costs> {
  const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (vercelTeam()) qs.set("teamId", vercelTeam());
  const r = await fetch(`https://api.vercel.com/v1/billing/charges?${qs}`, { headers: { Authorization: `Bearer ${keyOf("vercel")}` } });
  if (!r.ok) throw new Error(`vercel ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const out: Costs = new Map();
  for (const line of (await r.text()).split("\n")) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    const usd = Number(c.BilledCost ?? 0);
    if (!usd) continue;
    const tags: Record<string, string> = typeof c.Tags === "object" && c.Tags ? c.Tags : {};
    const month = monthOf(String(c.ChargePeriodStart));
    // Count the charge once under each identifier, so a service can be mapped by project id or by name.
    const keys = new Set(Object.entries(tags).filter(([k]) => /project/i.test(k)).map(([, v]) => String(v)));
    if (!keys.size) keys.add("*"); // team-level charge (plan, seats): resource_ref "*" collects it
    for (const k of keys) add(out, month, k, usd);
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
      // deno-lint-ignore no-explicit-any
      const total = (j.result ?? []).reduce((n: number, r: any) =>
        n + (r.total_rest_requests ?? 0) + (r.total_auth_requests ?? 0) + (r.total_storage_requests ?? 0) + (r.total_realtime_requests ?? 0), 0);
      await db.from("infra_services").update({
        usage_note: `${total.toLocaleString("en-US")} בקשות API ב־7 הימים האחרונים`, usage_synced_at: new Date().toISOString(),
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
        },
        required: ["name", "amount"],
      }),
    }),
    organization_amount: S("number", "Charges not tied to one project: plan subscription, seats, minus organization-wide credits/discounts"),
  },
  required: ["is_supabase_invoice"],
});

type Parsed = { is_supabase_invoice: boolean; period_month?: string; currency?: string; total?: number;
  projects?: { name: string; ref?: string; amount: number }[]; organization_amount?: number };

async function parseInvoice(bytes: Uint8Array, mime: string): Promise<Parsed> {
  const res = await gemini({
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: mime, data: b64(bytes) } },
      { text: "This should be a Supabase invoice. Extract the billing month and the amount per project, plus organization-level charges." },
    ] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: invoiceSchema },
  });
  return JSON.parse(answerText(res));
}

// Files an invoice's amounts on the Supabase services they belong to (by ref, else by project name).
async function applyInvoice(sourceKey: string, parsed: Parsed) {
  if (!parsed.is_supabase_invoice || !/^\d{4}-\d{2}$/.test(parsed.period_month ?? "")) {
    throw new Error(NOT_INVOICE);
  }
  const month = `${parsed.period_month}-01`;
  const { data: rows } = await db.from("infra_services").select("id,resource_ref,name").eq("provider", "supabase");
  const services = (rows ?? []) as { id: string; resource_ref: string | null; name: string }[];
  // Names of the Supabase projects, to match an invoice line that shows only a name.
  let names = new Map<string, string>(); // lower name -> ref
  if (keyOf("supabase")) {
    try { names = new Map((await resources("supabase")).map((r) => [r.name.toLowerCase(), r.id])); } catch { /* match by ref only */ }
  }
  const byRef = new Map<string, number>();
  const unmatched: { name: string; amount: number }[] = [];
  const lines = [...(parsed.projects ?? []).map((p) => ({ name: p.name, ref: p.ref || names.get(p.name.toLowerCase()) || "", amount: Number(p.amount) || 0 }))];
  if (parsed.organization_amount) lines.push({ name: "ארגון (תוכנית)", ref: "*", amount: Number(parsed.organization_amount) });
  for (const l of lines) {
    const key = (l.ref || l.name).toLowerCase();
    const hit = services.filter((s) => (s.resource_ref ?? "").toLowerCase() === key || (!s.resource_ref && s.name.toLowerCase() === l.name.toLowerCase()));
    if (!hit.length) { unmatched.push({ name: l.name, amount: l.amount }); continue; }
    for (const s of hit) byRef.set(s.id, (byRef.get(s.id) ?? 0) + l.amount);
  }
  const upserts = [...byRef].map(([service_id, amount]) => ({
    service_id, month, amount: Math.round(amount * 100) / 100, source: "supabase_invoice",
    usage_note: "מחשבונית Supabase", synced_at: new Date().toISOString(),
  }));
  if (upserts.length) {
    const w = await db.from("infra_costs").upsert(upserts, { onConflict: "service_id,month,source" });
    if (w.error) throw new Error(w.error.message);
  }
  const result = { month, matched: upserts.length, unmatched, lines };
  await db.from("infra_invoice_imports").upsert({
    source_key: sourceKey, provider: "supabase", month, total: parsed.total ?? null, currency: parsed.currency ?? null, result,
  });
  return result;
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
      const list = await g("messages", { q: `from:supabase has:attachment newer_than:${full ? 400 : 45}d (invoice OR receipt)`, maxResults: full ? "20" : "10" });
      const ids: string[] = (list.messages ?? []).map((m: { id: string }) => m.id);
      if (!ids.length) continue;
      const { data: seen } = await db.from("infra_invoice_imports").select("source_key").in("source_key", ids.map((i) => `gmail:${i}`));
      const done = new Set((seen ?? []).map((r) => r.source_key));
      for (const id of ids) {
        if (done.has(`gmail:${id}`)) continue;
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
          const r = await applyInvoice(`gmail:${id}`, await parseInvoice(fromB64Url(data), "application/pdf"));
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

Deno.serve(async (req) => {
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
          upserts.push({ service_id: s.id, month, amount, source: provider, synced_at: new Date().toISOString() });
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

  // Supabase invoices from Gmail (only on the daily run, not on "sync now").
  if (req.headers.get("x-cron-secret") || body.gmail) {
    const g = await gmailInvoices(!!body.full);
    if (g.report.length) report.supabase_invoice = g.report.join(" · ");
    errors.push(...g.errors);
  }

  await db.from("app_config").upsert({ key: "infra_sync_last", value: JSON.stringify({ at: new Date().toISOString(), report, errors }) });
  return json({ ok: errors.length === 0, report, errors });
});
