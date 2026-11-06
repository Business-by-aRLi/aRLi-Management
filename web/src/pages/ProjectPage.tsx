import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useExpenses, useFinancials, useIncome, usePartners, useProjects, useQuotes, useSave, useSaveShares, usePartnerShares, useShares, useTasks, useTime,
} from "../lib/data";
import { date, hours, isArchived, money, PROJECT_TAG, QUOTE_STATUS, quoteState, TASK_STATUS, today } from "../lib/format";
import { Icon } from "../components/icons";
import { Button, Card, Field, Input, Loading, Modal, Num, Select, Tag, Textarea, useConfirm } from "../components/ui";
import { StageStepper } from "../components/Stage";
import { must, supabase } from "../lib/supabase";
import { useQueryClient } from "@tanstack/react-query";
import { ClientPicker, resolveClient, type ClientChoice } from "../components/ClientPicker";
import type { Project } from "../lib/data";
import { AddChips, SectionAdd, useContextAdd } from "../components/ContextAdd";

export default function ProjectPage() {
  const { id } = useParams();
  const projects = useProjects();
  const fin = useFinancials();
  const partners = usePartners();
  const expenses = useExpenses();
  const income = useIncome();
  const tasks = useTasks();
  const time = useTime();
  const p = projects.data?.find((x) => x.id === id);
  const f = fin.data?.find((x) => x.project_id === id);
  const add = useContextAdd({ projectId: p?.id, name: p?.name ?? "" });
  if (projects.isLoading) return <Loading />;
  if (!p) return <p className="text-mute">הפרויקט לא נמצא.</p>;

  const exp = expenses.data?.filter((e) => e.project_id === id) ?? [];
  const inc = income.data?.filter((i) => i.project_id === id) ?? [];
  const tsk = tasks.data?.filter((t) => t.project_id === id && t.status !== "done") ?? [];
  const minutes = (time.data ?? []).filter((t) => t.project_id === p.id).reduce((s, t) => s + t.minutes, 0);
  const remaining = p.agreed_price != null ? Number(p.agreed_price) - Number(f?.income ?? 0) : null;

  return (
    <div className="space-y-10">
      <header>
        <Link to="/projects" className="text-[15px] text-mute hover:text-bone">→ פרויקטים</Link>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Tag type={p.type} label={PROJECT_TAG[p.type] ?? p.type} />
          {p.client_id && p.clients?.name && <Link to={`/clients/${p.client_id}`} className="text-[15px] text-pink hover:text-pink-soft">{p.clients.name}</Link>}
        </div>
        <h1 className="mt-1 text-[clamp(34px,5.2vw,80px)] font-semibold leading-[1.05] tracking-[-0.02em]">{p.name}</h1>
        <div className="mt-6 max-w-[760px]"><StageCard project={p} /><Delivery project={p} /></div>
        <div className="mt-5"><AddChips kinds={["expense", "income", "document", "task", "time", "meeting"]} onAdd={add.open} /></div>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="רווח" value={money(f?.profit)} />
        <Stat label="הכנסות" value={money(f?.income)} />
        <Stat label="הוצאות" value={money(f?.expenses)} />
        <Stat label={remaining != null ? "נשאר לגבות" : "שעות"} value={remaining != null ? money(remaining) : hours(minutes)} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <SplitCard projectId={p.id} profit={Number(f?.profit ?? 0)} expected={f?.outstanding ? Number(f.expected_profit) : null} partners={partners.data ?? []} />
        <DetailsCard key={p.id} project={p} moneyRows={exp.length + inc.length} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-[22px] font-semibold">הוצאות</h2><SectionAdd label="הוצאה" onClick={() => add.open("expense")} /></div>
          {!exp.length && <p className="text-mute">אין הוצאות בפרויקט.</p>}
          {exp.map((e) => (
            <div key={e.id} className="row-line flex justify-between gap-3 py-2.5">
              <span>{e.description} <span className="text-mute">· {e.partners?.name} · <Num>{date(e.spent_on)}</Num></span></span>
              <Num>{money(e.amount)}</Num>
            </div>
          ))}
        </Card>
        <Card>
          <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-[22px] font-semibold">הכנסות</h2><SectionAdd label="תשלום" onClick={() => add.open("income")} /></div>
          {!inc.length && <p className="text-mute">אין הכנסות בפרויקט.</p>}
          {inc.map((i) => (
            <div key={i.id} className="row-line flex justify-between gap-3 py-2.5">
              <span>{i.method ?? "תשלום"} <span className="text-mute">· אצל {i.partners?.name} · <Num>{date(i.received_on)}</Num></span></span>
              <Num>{money(i.amount)}</Num>
            </div>
          ))}
        </Card>
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-[22px] font-semibold">משימות פתוחות</h2><SectionAdd label="משימה" onClick={() => add.open("task")} /></div>
        {!tsk.length && <p className="text-mute">אין משימות פתוחות.</p>}
        {tsk.map((t) => (
          <div key={t.id} className="row-line flex justify-between gap-3 py-2.5">
            <span>{t.title} <span className="text-mute">· {TASK_STATUS[t.status]}{t.partners?.name ? ` · ${t.partners.name}` : ""}</span></span>
            {t.due_on && <span className="text-mute"><Num>{date(t.due_on)}</Num></span>}
          </div>
        ))}
      </Card>
      {add.modal}
    </div>
  );
}

// Profit split per project: by percent (one slider, Riki gets the rest), or a fixed amount for one partner
// with the rest of the profit going to the other. The amounts shown come from the DB view.
function SplitCard({ projectId, expected, partners }: { projectId: string; profit: number; expected: number | null; partners: { id: string; name: string }[] }) {
  const shares = useShares();
  const amounts = usePartnerShares();
  const save = useSaveShares();
  const mine = shares.data?.filter((s) => s.project_id === projectId) ?? [];
  const [first, second] = partners;
  const fixedRow = mine.find((s) => s.fixed_amount != null);
  const curMode: "pct" | "fixed" = fixedRow ? "fixed" : "pct";
  const curPct = Number(mine.find((s) => s.partner_id === first?.id)?.percent ?? 50);
  const curWho = fixedRow?.partner_id ?? second?.id ?? "";
  const curAmount = fixedRow?.fixed_amount != null ? String(Number(fixedRow.fixed_amount)) : "";
  const [mode, setMode] = useState(curMode);
  const [pct, setPct] = useState(curPct);
  const [who, setWho] = useState(curWho);
  const [amount, setAmount] = useState(curAmount);
  const reset = () => { setMode(curMode); setPct(curPct); setWho(curWho); setAmount(curAmount); };
  useEffect(reset, [curMode, curPct, curWho, curAmount]);
  if (!first || !second) return null;
  const dirty = mode !== curMode || (mode === "pct" ? pct !== curPct : who !== curWho || amount !== curAmount);
  const other = who === first.id ? second : first;
  const amt = (id: string) => amounts.data?.find((s) => s.project_id === projectId && s.partner_id === id);

  function submit() {
    if (mode === "pct") {
      save.mutate([
        { project_id: projectId, partner_id: first.id, percent: pct, fixed_amount: null },
        { project_id: projectId, partner_id: second.id, percent: 100 - pct, fixed_amount: null },
      ]);
    } else {
      const n = Number(amount);
      if (!(n >= 0) || amount === "") return;
      save.mutate([
        { project_id: projectId, partner_id: who, percent: 0, fixed_amount: n },
        { project_id: projectId, partner_id: other.id, percent: 100, fixed_amount: null },
      ]);
    }
  }

  const tab = (m: "pct" | "fixed", label: string) => (
    <button type="button" onClick={() => setMode(m)}
      className={`rounded-full px-3.5 py-1.5 text-[14px] transition-colors ${mode === m ? "bg-pink text-ink" : "text-mute hover:text-bone"}`}>{label}</button>
  );

  return (
    <Card>
      <h2 className="text-[22px] font-semibold">חלוקת הרווח</h2>
      <p className="mb-4 text-[15px] text-mute">אחרי קיזוז ההוצאות של הפרויקט.</p>
      <div className="mb-5 inline-flex gap-1 rounded-full border border-[var(--line)] p-1">
        {tab("pct", "לפי אחוזים")}{tab("fixed", "סכום קבוע")}
      </div>

      {mode === "pct" ? (
        <>
          <div className="mb-3 flex justify-between text-[18px]">
            <span>{first.name} <span className="text-pink"><Num>{pct}%</Num></span></span>
            <span>{second.name} <span className="text-pink"><Num>{100 - pct}%</Num></span></span>
          </div>
          <input type="range" min={0} max={100} step={5} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="w-full accent-[var(--pink)]" />
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="מי מקבלת סכום קבוע">
            <Select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value={first.id}>{first.name}</option><option value={second.id}>{second.name}</option>
            </Select>
          </Field>
          <Field label="סכום (₪)">
            <Input type="number" inputMode="decimal" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="למשל 2000" />
          </Field>
          <p className="text-[13px] text-mute sm:col-span-2">{other.name} מקבלת את כל השאר. הסכום הקבוע משולם מתוך הרווח, ולא יותר ממה שיש.</p>
        </div>
      )}

      {!dirty && (
        <div className="mt-4 space-y-2 border-t border-[var(--line)] pt-3 text-[15px]">
          <div className="flex justify-between"><span className="text-mute">כרגע</span>
            <span className="flex gap-6"><span>{first.name} <Num>{money(amt(first.id)?.amount)}</Num></span><span>{second.name} <Num>{money(amt(second.id)?.amount)}</Num></span></span></div>
          {expected != null && (
            <div className="flex justify-between"><span className="text-mute">לפי הצפי (<Num>{money(expected)}</Num>)</span>
              <span className="flex gap-6"><span>{first.name} <Num>{money(amt(first.id)?.expected_amount)}</Num></span><span>{second.name} <Num>{money(amt(second.id)?.expected_amount)}</Num></span></span></div>
          )}
        </div>
      )}
      {dirty && (
        <div className="mt-5 flex gap-3">
          <Button arrow className="group" disabled={save.isPending || (mode === "fixed" && amount === "")} onClick={submit}>שמירת החלוקה</Button>
          <Button variant="quiet" onClick={reset}>ביטול</Button>
        </div>
      )}
    </Card>
  );
}

// "Delivered to the client" is a moment of its own: it stamps the date, and the database moves the project to implementation.
function Delivery({ project }: { project: Project }) {
  const save = useSave("projects");
  const quotes = useQuotes();
  const confirm = useConfirm();
  const mine = (quotes.data ?? []).filter((q) => q.project_id === project.id && q.status !== "cancelled");
  if (isArchived(project.status)) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[15px]">
      {project.delivered_on ? <span className="text-mute">נמסר ללקוח ב-{date(project.delivered_on)}</span> : (
        <Button variant="ghost" className="!px-4 !py-1.5 text-[14px]" disabled={save.isPending} onClick={async () => {
          if (await confirm({ title: "המערכת נמסרה ללקוח?", body: "נרשום את תאריך המסירה, והפרויקט יעבור לשלב הטמעה.", yes: "כן, נמסר" }))
            await save.mutateAsync({ id: project.id, values: { delivered_on: today() } });
        }}><Icon name="check" size={16} />נמסר ללקוח</Button>
      )}
      {mine.map((q) => (
        <Link key={q.id} to={`/quotes/${q.id}`} className="inline-flex items-center gap-1.5 text-mute hover:text-bone">
          <Icon name={q.kind === "portal" ? "link" : "quote"} size={15} />הצעה <Num>{q.number}</Num> · {QUOTE_STATUS[quoteState(q)]}
        </Link>
      ))}
    </div>
  );
}

// Moving a project between stages saves right away. Archiving stamps closed_on; bringing it back clears it.
function StageCard({ project }: { project: Project }) {
  const save = useSave("projects");
  const [error, setError] = useState("");
  return (
    <div>
      <StageStepper status={project.status} disabled={save.isPending} onChange={async (status) => {
        if (status === project.status) return;
        setError("");
        try {
          await save.mutateAsync({ id: project.id, values: { status, closed_on: status === "archived" ? today() : null } });
        } catch (err) { setError((err as Error).message); }
      }} />
      {error && <p className="mt-2 text-[14px] text-error">{error}</p>}
    </div>
  );
}

function DetailsCard({ project, moneyRows }: { project: Project; moneyRows: number }) {
  const save = useSave("projects");
  const nav = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const del = async () => {
    // Money rows keep the books (and the partners' balance) true, so a project with money is archived, not deleted.
    if (moneyRows > 0) return setBlocked(true);
    const ok = await confirm({
      title: `למחוק את ${project.name}?`,
      body: "המשימות ושעות העבודה של הפרויקט יימחקו איתו. פגישות נשארות ביומן, בלי שיוך לפרויקט. אי אפשר לבטל את זה.",
      yes: "כן, למחוק",
    });
    if (!ok) return;
    setDeleting(true);
    setError("");
    try {
      must(await supabase.from("tasks").delete().eq("project_id", project.id));
      must(await supabase.from("time_entries").delete().eq("project_id", project.id));
      must(await supabase.from("projects").delete().eq("id", project.id));
      await qc.invalidateQueries();
      nav("/projects");
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };
  const [f, setF] = useState({
    name: project.name, type: project.type,
    agreed_price: project.agreed_price?.toString() ?? "", notes: project.notes ?? "",
  });
  const [client, setClient] = useState<ClientChoice>({ id: project.client_id ?? "", newName: "" });
  return (
    <Card>
      <h2 className="mb-5 text-[22px] font-semibold">פרטים</h2>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          const client_id = await resolveClient(client);
          await save.mutateAsync({ id: project.id, values: {
            name: f.name.trim(), type: f.type, client_id,
            agreed_price: f.agreed_price ? Number(f.agreed_price) : null, notes: f.notes || null,
          } });
          if (client.id === "new") setClient({ id: client_id ?? "", newName: "" });
        } catch (err) { setError((err as Error).message); }
      }}>
        <div className="sm:col-span-2"><Field label="שם"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
        <Field label="תגית">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {Object.entries(PROJECT_TAG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="לקוח"><ClientPicker value={client} onChange={setClient} /></Field>
        <Field label="מחיר מוסכם (₪)"><Input type="number" inputMode="decimal" value={f.agreed_price} onChange={(e) => setF({ ...f, agreed_price: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="הערות"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></div>
        {error && <p className="sm:col-span-2 text-[14px] text-error">{error}</p>}
        <div className="sm:col-span-2"><Button variant="ghost" disabled={save.isPending}>{save.isSuccess ? "נשמר" : "שמירה"}</Button></div>
      </form>
      <button type="button" className="mt-6 text-[14px] text-mute hover:text-error disabled:opacity-50" disabled={deleting} onClick={del}>
        {deleting ? "מוחקת…" : "מחיקת הפרויקט"}
      </button>
      <Modal open={blocked} onClose={() => setBlocked(false)} title="יש בפרויקט הכנסות או הוצאות">
        <p className="mb-6 text-mute">
          כדי שההתחשבנות בין העסק, מירי וריקי תישאר נכונה, אי אפשר למחוק פרויקט שרשומות בו {moneyRows} תנועות כסף.
          {" "}אפשר להעביר אותו לארכיון, או קודם להעביר את התנועות לפרויקט אחר במסך הכספים ואז למחוק.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={async () => {
            setBlocked(false);
            try { await save.mutateAsync({ id: project.id, values: { status: "archived", closed_on: today() } }); }
            catch (err) { setError((err as Error).message); }
          }} disabled={isArchived(project.status)}>{isArchived(project.status) ? "כבר בארכיון" : "להעביר לארכיון"}</Button>
          <Button variant="ghost" onClick={() => setBlocked(false)}>סגירה</Button>
        </div>
      </Modal>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-[clamp(26px,2.4vw,36px)] font-light text-pink"><Num>{value}</Num></div>
      <div className="text-mute">{label}</div>
    </Card>
  );
}
