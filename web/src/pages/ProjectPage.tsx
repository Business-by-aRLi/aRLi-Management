import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  useExpenses, useFinancials, useIncome, usePartners, useProjects, useSave, useSaveShares, useShares, useTasks, useTime,
} from "../lib/data";
import { date, hours, money, PROJECT_STATUS, PROJECT_TYPE, TASK_STATUS } from "../lib/format";
import { Button, Card, Eyebrow, Field, Input, Loading, Num, Select, Textarea } from "../components/ui";

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
  if (projects.isLoading) return <Loading />;
  if (!p) return <p className="text-mute">הפרויקט לא נמצא.</p>;

  const exp = expenses.data?.filter((e) => e.project_id === id) ?? [];
  const inc = income.data?.filter((i) => i.project_id === id) ?? [];
  const tsk = tasks.data?.filter((t) => t.project_id === id && t.status !== "done") ?? [];
  const minutes = (time.data ?? []).filter((t) => t.projects?.name === p.name).reduce((s, t) => s + t.minutes, 0);
  const remaining = p.agreed_price != null ? Number(p.agreed_price) - Number(f?.income ?? 0) : null;

  return (
    <div className="space-y-10">
      <header>
        <Link to="/projects" className="text-[15px] text-mute hover:text-bone">→ פרויקטים</Link>
        <Eyebrow>{PROJECT_TYPE[p.type]}{p.clients?.name ? ` · ${p.clients.name}` : ""}</Eyebrow>
        <h1 className="mt-1 text-[clamp(34px,5.2vw,80px)] font-semibold leading-[1.05] tracking-[-0.02em]">{p.name}</h1>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="רווח" value={money(f?.profit)} />
        <Stat label="הכנסות" value={money(f?.income)} />
        <Stat label="הוצאות" value={money(f?.expenses)} />
        <Stat label={remaining != null ? "נשאר לגבות" : "שעות"} value={remaining != null ? money(remaining) : hours(minutes)} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <SplitCard projectId={p.id} profit={Number(f?.profit ?? 0)} partners={partners.data ?? []} />
        <DetailsCard project={p} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-[22px] font-semibold">הוצאות</h2>
          {!exp.length && <p className="text-mute">אין הוצאות בפרויקט.</p>}
          {exp.map((e) => (
            <div key={e.id} className="row-line flex justify-between gap-3 py-2.5">
              <span>{e.description} <span className="text-mute">· {e.partners?.name} · <Num>{date(e.spent_on)}</Num></span></span>
              <Num>{money(e.amount)}</Num>
            </div>
          ))}
        </Card>
        <Card>
          <h2 className="mb-3 text-[22px] font-semibold">הכנסות</h2>
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
        <h2 className="mb-3 text-[22px] font-semibold">משימות פתוחות</h2>
        {!tsk.length && <p className="text-mute">אין משימות פתוחות.</p>}
        {tsk.map((t) => (
          <div key={t.id} className="row-line flex justify-between gap-3 py-2.5">
            <span>{t.title} <span className="text-mute">· {TASK_STATUS[t.status]}{t.partners?.name ? ` · ${t.partners.name}` : ""}</span></span>
            {t.due_on && <span className="text-mute"><Num>{date(t.due_on)}</Num></span>}
          </div>
        ))}
      </Card>
    </div>
  );
}

// Profit split per project. One slider: Miri's share, Riki gets the rest.
function SplitCard({ projectId, profit, partners }: { projectId: string; profit: number; partners: { id: string; name: string }[] }) {
  const shares = useShares();
  const save = useSaveShares();
  const mine = shares.data?.filter((s) => s.project_id === projectId) ?? [];
  const [first, second] = partners;
  const current = Number(mine.find((s) => s.partner_id === first?.id)?.percent ?? 50);
  const [pct, setPct] = useState(current);
  useEffect(() => setPct(current), [current]);
  if (!first || !second) return null;
  const dirty = pct !== current;

  return (
    <Card>
      <h2 className="text-[22px] font-semibold">חלוקת הרווח</h2>
      <p className="mb-5 text-[15px] text-mute">אחרי קיזוז ההוצאות של הפרויקט.</p>
      <div className="mb-3 flex justify-between text-[18px]">
        <span>{first.name} <span className="text-pink"><Num>{pct}%</Num></span></span>
        <span>{second.name} <span className="text-pink"><Num>{100 - pct}%</Num></span></span>
      </div>
      <input type="range" min={0} max={100} step={5} value={pct} onChange={(e) => setPct(Number(e.target.value))} className="w-full accent-[var(--pink)]" />
      <div className="mt-2 flex justify-between text-[14px] text-mute">
        <Num>{money((profit * pct) / 100)}</Num><Num>{money((profit * (100 - pct)) / 100)}</Num>
      </div>
      {dirty && (
        <div className="mt-5 flex gap-3">
          <Button arrow className="group" disabled={save.isPending} onClick={() => save.mutate([
            { project_id: projectId, partner_id: first.id, percent: pct },
            { project_id: projectId, partner_id: second.id, percent: 100 - pct },
          ])}>שמירת החלוקה</Button>
          <Button variant="quiet" onClick={() => setPct(current)}>ביטול</Button>
        </div>
      )}
    </Card>
  );
}

function DetailsCard({ project }: { project: { id: string; status: string; agreed_price: number | null; notes: string | null } }) {
  const save = useSave("projects");
  const [f, setF] = useState({ status: project.status, agreed_price: project.agreed_price?.toString() ?? "", notes: project.notes ?? "" });
  return (
    <Card>
      <h2 className="mb-5 text-[22px] font-semibold">פרטים</h2>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ id: project.id, values: {
          status: f.status, agreed_price: f.agreed_price ? Number(f.agreed_price) : null, notes: f.notes || null,
          ...(f.status === "closed" && project.status !== "closed" ? { closed_on: new Date().toISOString().slice(0, 10) } : {}),
        } });
      }}>
        <Field label="סטטוס">
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="מחיר מוסכם (₪)"><Input type="number" value={f.agreed_price} onChange={(e) => setF({ ...f, agreed_price: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="הערות"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></div>
        <div className="sm:col-span-2"><Button variant="ghost" disabled={save.isPending}>{save.isSuccess ? "נשמר" : "שמירה"}</Button></div>
      </form>
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
