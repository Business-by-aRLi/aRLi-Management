// Infrastructure costs of one project: hosting, database, API usage. Separate from the money ledger,
// so nothing here changes profit, the split or the partners' balance.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  useConnectors, useProviderResources, useInfraCosts, useInfraMonthly, useInfraServices, useInfraSync, useInfraSyncLast, useRemove, useSave,
  type InfraCost, type InfraService,
} from "../lib/data";
import { date, dateTime, today } from "../lib/format";
import { must, supabase } from "../lib/supabase";
import { Button, Card, Field, Input, Modal, Num, Pill, Select, Textarea, useConfirm } from "./ui";
import { SectionAdd } from "./ContextAdd";

export const PROVIDERS: Record<string, { label: string; ref: string; auto: boolean }> = {
  vercel:    { label: "Vercel",        ref: "מזהה או שם הפרויקט ב־Vercel (או * לעלות התוכנית של הצוות)", auto: true },
  supabase:  { label: "Supabase",      ref: "ה־ref של הפרויקט ב־Supabase (מושך נתוני שימוש)", auto: true },
  anthropic: { label: "Claude API",    ref: "מזהה ה־Workspace ב־Claude Console (wrkspc_...)", auto: true },
  openai:    { label: "OpenAI",        ref: "מזהה הפרויקט ב־OpenAI (proj_...)", auto: true },
  google:    { label: "Google / Gemini", ref: "מזהה הפרויקט ב־Google Cloud (לעיון בלבד)", auto: false },
  domain:    { label: "דומיין",        ref: "שם הדומיין", auto: false },
  other:     { label: "אחר",           ref: "מזהה אצל הספק (לא חובה)", auto: false },
};

export const cur = (n: number | string | null | undefined, c: string) => {
  const v = Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return c === "ILS" ? `${v} ₪` : `$${v}`;
};
const monthStart = (d = today()) => d.slice(0, 7) + "-01";
const monthLabel = (m: string) => new Date(`${m}T12:00:00`).toLocaleDateString("he-IL", { month: "short" });

// How a service's cost for the current month is estimated:
//   daily  - the provider reports cost as it accrues (Vercel, Claude API, OpenAI): month to date, projected to month end
//   invoice - billed once a month after it ends (Supabase): the last invoice is the estimate
//   fixed  - a fixed monthly price typed in
const DAILY = new Set(["vercel", "anthropic", "openai"]);
type Estimate = { mtd: number | null; estimate: number | null; basis: string; lastMonth: number | null; lastLabel: string };

function daysIn(month: string) {
  const d = new Date(`${month}T12:00:00`);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}
const fmtQty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 });

function estimateOf(s: InfraService, rows: InfraCost[], thisMonth: string): Estimate {
  const share = Number(s.share_percent) / 100;
  const byMonth = new Map<string, number>();
  for (const c of rows) byMonth.set(c.month, (byMonth.get(c.month) ?? 0) + Number(c.amount));
  const past = [...byMonth.keys()].filter((m) => m < thisMonth).sort();
  const lastM = past.at(-1);
  const lastMonth = lastM ? byMonth.get(lastM)! * share : null;
  const lastLabel = lastM ? monthLabel(lastM) : "";
  const fixed = Number(s.monthly_cost) * share;
  if (DAILY.has(s.provider) && s.resource_ref && byMonth.has(thisMonth)) {
    const mtd = byMonth.get(thisMonth)! * share;
    const day = Math.max(1, Number(today().slice(8, 10)));
    const days = daysIn(thisMonth);
    // In the first days of the month the pace says little: lean on last month.
    const projected = (mtd / day) * days;
    const estimate = day < 5 && lastMonth != null ? Math.max(mtd, (projected + lastMonth) / 2) : projected;
    return { mtd, estimate: estimate + fixed, basis: `לפי קצב השימוש ב־${day} הימים הראשונים${fixed ? " ועוד המחיר הקבוע" : ""}`, lastMonth, lastLabel };
  }
  if (s.provider === "supabase" && lastM) {
    return { mtd: null, estimate: lastMonth, basis: `לפי החשבונית האחרונה (${lastLabel}). Supabase מחייבת אחרי סוף החודש`, lastMonth, lastLabel };
  }
  if (byMonth.has(thisMonth)) {
    const v = byMonth.get(thisMonth)! * share;
    return { mtd: v, estimate: v, basis: "לפי מה שנרשם החודש", lastMonth, lastLabel };
  }
  if (fixed) return { mtd: null, estimate: fixed, basis: "מחיר קבוע לחודש", lastMonth, lastLabel };
  return { mtd: null, estimate: lastMonth, basis: lastM ? `לפי ${lastLabel}` : "", lastMonth, lastLabel };
}

export function InfraCard({ projectId }: { projectId: string }) {
  const services = useInfraServices();
  const costs = useInfraCosts();
  const monthly = useInfraMonthly();
  const last = useInfraSyncLast();
  const sync = useInfraSync();
  const [edit, setEdit] = useState<InfraService | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const mine = (services.data ?? []).filter((s) => s.project_id === projectId);
  const rows = (monthly.data ?? []).filter((m) => m.project_id === projectId);
  const thisMonth = monthStart();
  const currencies = [...new Set(mine.map((s) => s.currency))];
  const main = currencies.includes("USD") || !currencies.length ? "USD" : "ILS";
  const series = rows.filter((r) => r.currency === main).slice(-6);
  const peak = Math.max(1, ...series.map((r) => Number(r.amount)));
  const costsOf = (s: InfraService) => (costs.data ?? []).filter((c) => c.service_id === s.id);
  const est = new Map(mine.map((s) => [s.id, estimateOf(s, costsOf(s), thisMonth)]));
  const sumBy = (c: string, k: "mtd" | "estimate") =>
    mine.filter((s) => s.active && s.currency === c).reduce((n, s) => n + (est.get(s.id)![k] ?? 0), 0);

  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[22px] font-semibold">תשתיות</h2>
        <div className="flex items-center gap-2">
          {mine.some((s) => PROVIDERS[s.provider]?.auto) && (
            <Button variant="quiet" disabled={sync.isPending} onClick={() => sync.mutate({ full: true })}>{sync.isPending ? "מסנכרנת…" : "סנכרון עכשיו"}</Button>
          )}
          <SectionAdd label="שירות" onClick={() => setEdit("new")} />
        </div>
      </div>
      <p className="mb-4 text-[15px] text-mute">אחסון, מסד נתונים ו־API. מעקב בלבד, לא נכנס להתחשבנות. <Link to="/connections" className="text-pink hover:text-pink-soft">חיבורים לספקים</Link></p>

      {!mine.length && <p className="text-mute">עוד לא נרשמו שירותים. אפשר להוסיף Vercel, Supabase, מפתח API או דומיין.</p>}

      {!!mine.length && (
        <div className="mb-5 grid gap-5 sm:grid-cols-[auto_auto_1fr] sm:items-end">
          <div>
            <div className="text-[clamp(26px,2.4vw,36px)] font-light text-pink">
              {currencies.map((c, i) => <span key={c}>{i > 0 && " + "}<Num>~{cur(sumBy(c, "estimate"), c)}</Num></span>)}
            </div>
            <div className="text-mute">צפי לחודש הזה</div>
          </div>
          <div>
            <div className="text-[clamp(20px,1.8vw,26px)] font-light">
              {currencies.map((c, i) => <span key={c}>{i > 0 && " + "}<Num>{cur(sumBy(c, "mtd"), c)}</Num></span>)}
            </div>
            <div className="text-mute">נצבר עד היום</div>
          </div>
          {series.length > 1 && (
            <div className="flex h-16 items-end gap-2" aria-label="עלות בחצי השנה האחרונה">
              {series.map((r) => (
                <div key={r.month} className="flex flex-1 flex-col items-center gap-1">
                  <div title={cur(r.amount, r.currency)} className={`w-full rounded-t ${r.month === thisMonth ? "bg-pink" : "bg-[var(--line)]"}`}
                    style={{ height: `${Math.max(3, (Number(r.amount) / peak) * 48)}px` }} />
                  <span className="text-[12px] text-mute">{monthLabel(r.month)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {mine.map((s) => {
        const p = PROVIDERS[s.provider] ?? PROVIDERS.other;
        const e = est.get(s.id)!;
        const isOpen = open === s.id;
        return (
          <div key={s.id} className={`row-line ${s.active ? "" : "opacity-50"}`}>
            <button type="button" onClick={() => setOpen(isOpen ? null : s.id)} aria-expanded={isOpen}
              className="flex w-full items-start justify-between gap-3 py-2.5 text-start hover:text-bone">
              <span>
                {s.name} <span className="text-mute">{s.name === p.label ? "" : `· ${p.label}`}{s.plan ? ` · ${s.plan}` : ""}{s.share_percent < 100 ? ` · ${Number(s.share_percent)}% מהעלות` : ""}</span>
                {s.usage_note && <span className="block text-[13px] text-mute">{s.usage_note}</span>}
              </span>
              <span className="flex shrink-0 flex-col items-end">
                {e.estimate != null
                  ? <span><Num>~{cur(e.estimate, s.currency)}</Num> <span className="text-[13px] text-mute">החודש</span></span>
                  : <span className="text-mute">{p.auto && s.resource_ref ? "ממתין לסנכרון" : /free|hobby|חינ/i.test(s.plan ?? "") ? "חינמי" : "ללא מחיר"}</span>}
                {e.mtd != null && e.mtd !== e.estimate && <span className="text-[13px] text-mute">עד היום <Num>{cur(e.mtd, s.currency)}</Num></span>}
              </span>
            </button>
            {isOpen && <ServiceDetail s={s} rows={costsOf(s)} e={e} thisMonth={thisMonth} onEdit={() => setEdit(s)} />}
          </div>
        );
      })}

      {(sync.data || last.data) && (
        <div className="mt-4 border-t border-[var(--line)] pt-3 text-[13px] text-mute">
          {last.data?.at && <>סנכרון אחרון: {dateTime(last.data.at)}. </>}
          {Object.values((sync.data ?? last.data)?.report ?? {}).join(" · ")}
          {!!(sync.data ?? last.data)?.errors?.length && <span className="block text-error">{(sync.data ?? last.data)!.errors.join(" · ")}</span>}
        </div>
      )}
      {sync.error && <p className="mt-2 text-[14px] text-error">{(sync.error as Error).message}</p>}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === "new" ? "שירות חדש" : "שירות"}>
        {edit && <ServiceForm key={edit === "new" ? "new" : edit.id} projectId={projectId} service={edit === "new" ? null : edit} onDone={() => setEdit(null)} />}
      </Modal>
    </Card>
  );
}

// Everything the connection knows about one service: the estimate and what it rests on, the usage
// behind the latest month that has detail, and the monthly history.
function ServiceDetail({ s, rows, e, thisMonth, onEdit }: { s: InfraService; rows: InfraCost[]; e: Estimate; thisMonth: string; onEdit: () => void }) {
  const share = Number(s.share_percent) / 100;
  const detailed = rows.filter((c) => c.breakdown?.length).sort((a, b) => b.month.localeCompare(a.month));
  const [month, setMonth] = useState(detailed[0]?.month ?? "");
  const shown = detailed.find((c) => c.month === month) ?? detailed[0];
  const items = (shown?.breakdown ?? []).filter((i) => i.qty || i.cost);
  const history = [...new Map(rows.map((c) => [c.month, 0])).keys()].sort().reverse()
    .map((m) => ({ m, v: rows.filter((c) => c.month === m).reduce((n, c) => n + Number(c.amount), 0) * share }))
    .filter((h) => h.v > 0 || h.m === thisMonth).slice(0, 12);
  const synced = rows.map((c) => c.synced_at).filter(Boolean).sort().at(-1);

  return (
    <div className="mb-3 space-y-4 rounded-lg bg-[var(--hover-veil)] p-4 text-[14px]">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="צפי לחודש הזה" value={e.estimate != null ? `~${cur(e.estimate, s.currency)}` : "אין עדיין נתונים"} note={e.basis} />
        <Stat label="נצבר עד היום" value={e.mtd != null ? cur(e.mtd, s.currency) : "יתברר בחשבונית"} />
        <Stat label={e.lastLabel ? `חודש קודם (${e.lastLabel})` : "חודש קודם"} value={e.lastMonth != null ? cur(e.lastMonth, s.currency) : "אין"} />
      </div>

      {!!items.length && (
        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">שימוש {shown && `ב־${monthLabel(shown.month)} ${shown.month.slice(0, 4)}`}</h3>
            {detailed.length > 1 && (
              <select value={shown?.month} onChange={(ev) => setMonth(ev.target.value)} aria-label="חודש"
                className="rounded border border-[var(--line)] bg-transparent px-2 py-1 text-[13px]">
                {detailed.map((c) => <option key={c.month} value={c.month}>{monthLabel(c.month)} {c.month.slice(0, 4)}</option>)}
              </select>
            )}
          </div>
          <table className="w-full text-start">
            <thead className="text-[12px] text-mute"><tr><th className="py-1 text-start font-normal">פריט</th><th className="font-normal text-start">כמות</th><th className="font-normal text-end">עלות</th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.item} className="border-t border-[var(--line)]">
                  <td className="py-1.5" dir="auto">{i.item}</td>
                  <td><Num>{i.qty ? `${fmtQty(i.qty)} ${i.unit}` : "–"}</Num></td>
                  <td className="text-end"><Num>{i.cost ? cur(i.cost * share, s.currency) : "כלול"}</Num></td>
                </tr>
              ))}
            </tbody>
          </table>
          {share < 1 && <p className="mt-1 text-[12px] text-mute">העלויות מוצגות לפי {Number(s.share_percent)}% של הפרויקט.</p>}
        </div>
      )}

      {!!s.usage?.length && (
        <div>
          <h3 className="mb-1 font-semibold">שימוש ב־7 הימים האחרונים</h3>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {s.usage.map((u) => <span key={u.item}>{u.item}: <Num>{fmtQty(u.qty)}</Num> {u.unit}</span>)}
          </div>
        </div>
      )}

      {!items.length && !s.usage?.length && (
        <p className="text-mute">{PROVIDERS[s.provider]?.auto && s.resource_ref ? "פירוט השימוש יופיע אחרי הסנכרון הבא." : "לשירות הזה אין חיבור שמביא נתוני שימוש."}</p>
      )}

      {history.length > 1 && (
        <div>
          <h3 className="mb-1 font-semibold">לפי חודש</h3>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {history.map((h) => <span key={h.m}><span className="text-mute">{monthLabel(h.m)}</span> <Num>{cur(h.v, s.currency)}</Num></span>)}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-mute">
        <span>
          {s.renews_on && <>חידוש <Num>{date(s.renews_on)}</Num> · </>}
          {synced && <>עודכן {dateTime(synced)}</>}
        </span>
        <Button variant="quiet" onClick={onEdit}>עריכת השירות</Button>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="text-[12px] text-mute">{label}</div>
      <div className="text-[18px]"><Num>{value}</Num></div>
      {note && <div className="text-[12px] text-mute">{note}</div>}
    </div>
  );
}

function ServiceForm({ projectId, service, onDone }: { projectId: string; service: InfraService | null; onDone: () => void }) {
  const save = useSave("infra_services");
  const remove = useRemove("infra_services");
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [f, setF] = useState({
    provider: service?.provider ?? "vercel", name: service?.name ?? "", plan: service?.plan ?? "",
    resource_ref: service?.resource_ref ?? "", monthly_cost: service ? String(Number(service.monthly_cost)) : "0",
    currency: service?.currency ?? "USD", share_percent: service ? String(Number(service.share_percent)) : "100",
    renews_on: service?.renews_on ?? "", active: service?.active ?? true, notes: service?.notes ?? "",
  });
  const [actual, setActual] = useState({ month: monthStart().slice(0, 7), amount: "" });
  const p = PROVIDERS[f.provider] ?? PROVIDERS.other;
  const connectors = useConnectors();
  const connected = p.auto && (connectors.data ?? []).some((c) => c.provider === f.provider);
  const list = useProviderResources(f.provider, connected);
  const [typed, setTyped] = useState(false);
  const inList = !!list.data?.some((r) => r.id === f.resource_ref);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await save.mutateAsync({ id: service?.id, values: {
        project_id: projectId, provider: f.provider, name: f.name.trim() || p.label, plan: f.plan || null,
        resource_ref: f.resource_ref.trim() || null, monthly_cost: Number(f.monthly_cost || 0), currency: f.currency,
        share_percent: Number(f.share_percent || 100), renews_on: f.renews_on || null, active: f.active, notes: f.notes || null,
      } });
      onDone();
    } catch (err) { setError((err as Error).message); }
  }

  async function saveActual() {
    if (!service || actual.amount === "") return;
    setError("");
    try {
      must(await supabase.from("infra_costs").upsert(
        { service_id: service.id, month: `${actual.month}-01`, amount: Number(actual.amount), source: "manual" },
        { onConflict: "service_id,month,source" }));
      await qc.invalidateQueries({ queryKey: ["infra"] });
      setActual({ ...actual, amount: "" });
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <Field label="ספק">
        <Select value={f.provider} onChange={set("provider")}>
          {Object.entries(PROVIDERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </Select>
      </Field>
      <Field label="שם"><Input value={f.name} onChange={set("name")} placeholder={p.label} /></Field>
      <div className="sm:col-span-2">
        {connected && list.data && !typed && (!f.resource_ref || inList) ? (
          <Field label={`הפרויקט ב־${p.label}`} hint="העלות שלו תימשך אוטומטית כל בוקר.">
            <Select value={f.resource_ref} onChange={(e) => e.target.value === "__typed" ? setTyped(true) : setF({ ...f, resource_ref: e.target.value })}>
              <option value="">בחירה…</option>
              {list.data.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              <option value="__typed">אחר (הקלדת מזהה)</option>
            </Select>
          </Field>
        ) : (
          <Field label="מזהה אצל הספק" hint={p.ref + (p.auto ? ". עם מזהה, העלות נמשכת אוטומטית כל בוקר." : "")}>
            <Input dir="ltr" value={f.resource_ref} onChange={set("resource_ref")} />
          </Field>
        )}
        {p.auto && connectors.data && !connected && (
          <p className="mt-1 text-[13px] text-mute">{p.label} עוד לא מחובר. <Link to="/connections" className="text-pink hover:text-pink-soft">לחיבור</Link> ואז אפשר לבחור מרשימה.</p>
        )}
        {connected && list.isFetching && <p className="mt-1 text-[13px] text-mute">טוענת פרויקטים מ־{p.label}…</p>}
        {connected && list.error && <p className="mt-1 text-[13px] text-error">{(list.error as Error).message}</p>}
      </div>
      <Field label="תוכנית"><Input value={f.plan} onChange={set("plan")} placeholder="Free / Pro / לפי שימוש" /></Field>
      <Field label="מחיר קבוע לחודש">
        <div className="flex gap-2">
          <Input type="number" inputMode="decimal" min={0} step="0.01" value={f.monthly_cost} onChange={set("monthly_cost")} />
          <Select value={f.currency} onChange={set("currency")} className="w-24"><option value="USD">$</option><option value="ILS">₪</option></Select>
        </div>
      </Field>
      <Field label="חלק הפרויקט בעלות (%)" hint="לשירות שמשותף לכמה פרויקטים">
        <Input type="number" min={1} max={100} value={f.share_percent} onChange={set("share_percent")} />
      </Field>
      <Field label="תאריך חידוש"><Input type="date" value={f.renews_on} onChange={set("renews_on")} /></Field>
      <div className="sm:col-span-2"><Field label="הערות"><Textarea value={f.notes} onChange={set("notes")} /></Field></div>
      <label className="flex items-center gap-2 text-[15px] sm:col-span-2">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} className="accent-[var(--pink)]" />
        פעיל
      </label>

      {service && (
        <div className="grid gap-3 border-t border-[var(--line)] pt-4 sm:col-span-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="עלות בפועל לחודש"><Input type="month" value={actual.month} onChange={(e) => setActual({ ...actual, month: e.target.value })} /></Field>
          <Field label={`סכום (${f.currency === "ILS" ? "₪" : "$"})`}>
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={actual.amount} onChange={(e) => setActual({ ...actual, amount: e.target.value })} />
          </Field>
          <Button type="button" variant="ghost" disabled={actual.amount === ""} onClick={saveActual}>רישום</Button>
        </div>
      )}

      {error && <p className="text-[14px] text-error sm:col-span-2">{error}</p>}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button disabled={save.isPending}>שמירה</Button>
        <Button type="button" variant="quiet" onClick={onDone}>ביטול</Button>
        {service && (
          <button type="button" className="ms-auto text-[14px] text-mute hover:text-error" onClick={async () => {
            if (!(await confirm({ title: `למחוק את ${service.name}?`, body: "גם העלויות שנרשמו לשירות יימחקו.", yes: "כן, למחוק" }))) return;
            await remove.mutateAsync(service.id);
            onDone();
          }}>מחיקה</button>
        )}
      </div>
    </form>
  );
}
