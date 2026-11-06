// Infrastructure costs of one project: hosting, database, API usage. Separate from the money ledger,
// so nothing here changes profit, the split or the partners' balance.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useInfraCosts, useInfraMonthly, useInfraServices, useInfraSync, useInfraSyncLast, useRemove, useSave, type InfraService,
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

export function InfraCard({ projectId }: { projectId: string }) {
  const services = useInfraServices();
  const costs = useInfraCosts();
  const monthly = useInfraMonthly();
  const last = useInfraSyncLast();
  const sync = useInfraSync();
  const [edit, setEdit] = useState<InfraService | "new" | null>(null);

  const mine = (services.data ?? []).filter((s) => s.project_id === projectId);
  const rows = (monthly.data ?? []).filter((m) => m.project_id === projectId);
  const thisMonth = monthStart();
  const currencies = [...new Set(mine.map((s) => s.currency))];
  const main = currencies.includes("USD") || !currencies.length ? "USD" : "ILS";
  const series = rows.filter((r) => r.currency === main).slice(-6);
  const peak = Math.max(1, ...series.map((r) => Number(r.amount)));
  // Shown as the project's part of the cost, like the totals above.
  const part = (s: InfraService, n: number) => (n * Number(s.share_percent)) / 100;
  const actualOf = (s: InfraService) => part(s, (costs.data ?? []).filter((c) => c.service_id === s.id && c.month === thisMonth)
    .reduce((n, c) => n + Number(c.amount), 0));
  const hasActual = (s: InfraService) => (costs.data ?? []).some((c) => c.service_id === s.id && c.month === thisMonth);

  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[22px] font-semibold">תשתיות</h2>
        <div className="flex items-center gap-2">
          {mine.some((s) => PROVIDERS[s.provider]?.auto) && (
            <Button variant="quiet" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? "מסנכרנת…" : "סנכרון עכשיו"}</Button>
          )}
          <SectionAdd label="שירות" onClick={() => setEdit("new")} />
        </div>
      </div>
      <p className="mb-4 text-[15px] text-mute">אחסון, מסד נתונים ו־API. מעקב בלבד, לא נכנס להתחשבנות.</p>

      {!mine.length && <p className="text-mute">עוד לא נרשמו שירותים. אפשר להוסיף Vercel, Supabase, מפתח API או דומיין.</p>}

      {!!mine.length && (
        <div className="mb-5 grid gap-5 sm:grid-cols-[auto_1fr] sm:items-end">
          <div>
            <div className="text-[clamp(26px,2.4vw,36px)] font-light text-pink">
              {currencies.map((c, i) => (
                <span key={c}>{i > 0 && " + "}<Num>{cur(rows.find((r) => r.month === thisMonth && r.currency === c)?.amount, c)}</Num></span>
              ))}
            </div>
            <div className="text-mute">החודש</div>
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
        const actual = hasActual(s);
        return (
          <button key={s.id} type="button" onClick={() => setEdit(s)}
            className={`row-line flex w-full items-start justify-between gap-3 py-2.5 text-start hover:text-bone ${s.active ? "" : "opacity-50"}`}>
            <span>
              {s.name} <span className="text-mute">{s.name === p.label ? "" : `· ${p.label}`}{s.plan ? ` · ${s.plan}` : ""}{s.share_percent < 100 ? ` · ${Number(s.share_percent)}% מהעלות` : ""}</span>
              {s.usage_note && <span className="block text-[13px] text-mute">{s.usage_note}</span>}
              {s.renews_on && <span className="block text-[13px] text-mute">חידוש <Num>{date(s.renews_on)}</Num></span>}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {actual && <Pill tone="pink">{p.auto && s.resource_ref ? "אוטומטי" : "בפועל"}</Pill>}
              {actual ? <Num>{cur(actualOf(s), s.currency)}</Num>
                : Number(s.monthly_cost) === 0 ? <span className="text-mute">חינמי</span>
                : <span><Num>{cur(part(s, Number(s.monthly_cost)), s.currency)}</Num> לחודש</span>}
            </span>
          </button>
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
        <Field label="מזהה אצל הספק" hint={p.ref + (p.auto ? ". עם מזהה, העלות נמשכת אוטומטית כל בוקר." : "")}>
          <Input dir="ltr" value={f.resource_ref} onChange={set("resource_ref")} />
        </Field>
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
