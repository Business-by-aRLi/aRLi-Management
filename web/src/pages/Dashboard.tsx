// Home: a place for growth. Momentum first, then the month's plan, goals and ideas.
// The partner balance lives in one calm module, not in the headline.
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useBalances, useExpenses, useIdeas, useIncome, useMeetings, useProjects, useRemove, useSave, useTasks, useTime, useWorkPlans,
  type Idea, type WorkPlan,
} from "../lib/data";
import { dateTime, money, today } from "../lib/format";
import { Button, Card, Eyebrow, Input, Modal, Num, Pill } from "../components/ui";
import { PlanForm, SettlementForm, useMe } from "../components/forms";
import Gantt from "../components/Gantt";

const LINES = [
  "כל משימה שנסגרת היום היא לקוח מרוצה מחר.",
  "רעיון אחד טוב בשבוע מספיק כדי לשנות רבעון.",
  "בונים את aRLi צעד אחרי צעד, ביחד.",
  "מה הדבר האחד שיקדם אותנו הכי הרבה השבוע?",
];

export default function Dashboard() {
  const me = useMe();
  const tasks = useTasks();
  const projects = useProjects();
  const income = useIncome();
  const time = useTime();
  const ideas = useIdeas();
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });

  const m = today().slice(0, 7);
  const monthTasks = (tasks.data ?? []).filter((t) => (t.due_on ?? t.start_on ?? "").startsWith(m) || (t.completed_at ?? "").startsWith(m));
  const doneThisMonth = (tasks.data ?? []).filter((t) => t.status === "done" && (t.completed_at ?? "").startsWith(m)).length;
  const openThisMonth = monthTasks.filter((t) => t.status !== "done").length;
  const monthIncome = (income.data ?? []).filter((i) => i.received_on.startsWith(m)).reduce((s, i) => s + Number(i.amount), 0);
  const createMinutes = (time.data ?? []).filter((t) => t.work_date.startsWith(m)).reduce((s, t) => s + t.minutes, 0);
  const liveIdeas = (ideas.data ?? []).filter((i) => i.status !== "parked").length;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "בוקר טוב" : hour < 17 ? "צהריים טובים" : hour < 21 ? "ערב טוב" : "לילה טוב";
  const line = LINES[new Date().getDate() % LINES.length];

  return (
    <div className="space-y-12">
      <section>
        <Eyebrow>{new Date().toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })}</Eyebrow>
        <h1 className="mt-2 text-[clamp(38px,5.6vw,92px)] font-semibold leading-[1.04] tracking-[-0.025em]">
          {greeting}{me ? `, ${me.name}` : ""}. <span className="text-pink">בונים הלאה.</span>
        </h1>
        <p className="mt-4 max-w-[46ch] text-[clamp(18px,1.5vw,22px)] font-light text-mute">{line}</p>
      </section>

      {/* Momentum */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Momentum value={String(doneThisMonth)} label="משימות שסגרנו החודש" ring={monthTasks.length ? doneThisMonth / Math.max(1, doneThisMonth + openThisMonth) : 0} />
        <Momentum value={String(openThisMonth)} label="משימות בדרך החודש" />
        <Momentum value={money(monthIncome)} label="נכנס החודש" />
        <Momentum value={`${Math.round(createMinutes / 60)}`} suffix="ש׳" label={`שעות יצירה · ${liveIdeas} יוזמות חיות`} />
      </section>

      {/* The month's plan */}
      <Card>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-[clamp(24px,2.2vw,32px)] font-semibold">התוכנית של החודש</h2>
          <Link to="/tasks" className="text-[15px] text-pink">לוח משימות ←</Link>
        </div>
        <Gantt tasks={tasks.data ?? []} projects={projects.data ?? []} month={month} onMonth={setMonth} />
      </Card>

      <section className="grid gap-6 lg:grid-cols-2">
        <Goals />
        <IdeasBoard ideas={ideas.data ?? []} meId={me?.id} />
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <BalanceModule />
        <Upcoming />
      </section>
    </div>
  );
}

function Momentum({ value, label, ring, suffix }: { value: string; label: string; ring?: number; suffix?: string }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[clamp(28px,2.8vw,42px)] font-light leading-none text-pink"><Num>{value}</Num>{suffix && <span className="ms-1 text-[0.5em]">{suffix}</span>}</div>
          <div className="mt-2 text-[15px] text-mute">{label}</div>
        </div>
        {ring !== undefined && (
          <svg viewBox="0 0 36 36" className="size-12 shrink-0 -rotate-90" aria-hidden>
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--line-2)" strokeWidth="3" />
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--pink)" strokeWidth="3" strokeLinecap="round"
              strokeDasharray={`${ring * 97.4} 97.4`} style={{ transition: "stroke-dasharray .8s var(--ease)" }} />
          </svg>
        )}
      </div>
    </Card>
  );
}

// Goals = work plans. Progress is the share of linked tasks that are done.
function Goals() {
  const plans = useWorkPlans();
  const tasks = useTasks();
  const [modal, setModal] = useState<null | { row?: WorkPlan }>(null);
  const t = today();
  const current = (plans.data ?? []).filter((p) => !p.period_end || p.period_end >= t);

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[24px] font-semibold">היעדים שלנו</h2>
        <Button variant="quiet" className="text-pink" onClick={() => setModal({})}>+ יעד</Button>
      </div>
      {!current.length && (
        <div className="py-6">
          <p className="text-mute">לאן רוצות להגיע ברבעון הזה?</p>
          <Button variant="ghost" className="mt-4" onClick={() => setModal({})}>להגדיר יעד ראשון</Button>
        </div>
      )}
      {current.map((p) => {
        const linked = (tasks.data ?? []).filter((x) => x.work_plan_id === p.id);
        const done = linked.filter((x) => x.status === "done").length;
        const pct = linked.length ? Math.round((done / linked.length) * 100) : 0;
        return (
          <button key={p.id} onClick={() => setModal({ row: p })} className="row-line block w-full py-4 text-start">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[18px] font-medium">{p.title}</span>
              <span className="text-[14px] text-mute"><Num>{pct}%</Num></span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-[var(--ink-3)]">
              <div className="h-full rounded-full bg-pink transition-[width] duration-700" style={{ width: `${Math.max(pct, 2)}%` }} />
            </div>
            <div className="mt-1.5 text-[13px] text-mute-2">
              <Num>{done}/{linked.length}</Num> משימות{p.period_end && <> · עד <Num>{new Date(p.period_end).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" })}</Num></>}
            </div>
          </button>
        );
      })}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.row ? "עריכת יעד" : "יעד חדש"}>
        <PlanForm row={modal?.row} onDone={() => setModal(null)} />
      </Modal>
    </Card>
  );
}

const IDEA_STATUS: Record<string, string> = { idea: "רעיון", exploring: "בודקות", go: "יוצאות לדרך", parked: "בהמתנה" };
const IDEA_NEXT: Record<string, string> = { idea: "exploring", exploring: "go", go: "parked", parked: "idea" };

function IdeasBoard({ ideas, meId }: { ideas: Idea[]; meId?: string }) {
  const save = useSave("ideas");
  const remove = useRemove("ideas");
  const [title, setTitle] = useState("");
  const visible = ideas.filter((i) => i.status !== "parked").slice(0, 8);

  return (
    <Card>
      <h2 className="text-[24px] font-semibold">יוזמות ורעיונות</h2>
      <p className="mb-4 text-[15px] text-mute">כל רעיון נכנס לכאן, גם אם הוא רק התחלה.</p>
      <form className="mb-4 flex gap-2" onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        await save.mutateAsync({ values: { title: title.trim(), created_by_partner_id: meId ?? null } });
        setTitle("");
      }}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="רעיון חדש…" />
        <Button disabled={save.isPending} className="shrink-0">הוספה</Button>
      </form>
      {!visible.length && <p className="py-4 text-mute-2">עוד אין רעיונות. מה היה כיף לבנות?</p>}
      {visible.map((i) => (
        <div key={i.id} className="row-line flex items-center justify-between gap-3 py-3">
          <span>{i.title}{i.partners?.name && <span className="text-mute-2"> · {i.partners.name}</span>}</span>
          <span className="flex shrink-0 items-center gap-1">
            <button onClick={() => save.mutate({ id: i.id, values: { status: IDEA_NEXT[i.status] } })} title="לשלב הבא">
              <Pill tone={i.status === "go" ? "pink" : "mute"}>{IDEA_STATUS[i.status]}</Pill>
            </button>
            <button className="px-2 text-mute-2 hover:text-bone" onClick={() => confirm("למחוק את הרעיון?") && remove.mutate(i.id)} aria-label="מחיקה">×</button>
          </span>
        </div>
      ))}
    </Card>
  );
}

// The partner balance: calm, with the numbers behind it.
export function BalanceModule() {
  const balances = useBalances();
  const expenses = useExpenses();
  const income = useIncome();
  const [settle, setSettle] = useState(false);
  const rows = balances.data ?? [];
  const owes = rows.find((b) => b.net_position > 0.005);
  const owed = rows.find((b) => b.net_position < -0.005);
  const m = today().slice(0, 7);
  const monthExp = (expenses.data ?? []).filter((e) => e.spent_on.startsWith(m)).reduce((s, e) => s + Number(e.amount), 0);
  const monthInc = (income.data ?? []).filter((e) => e.received_on.startsWith(m)).reduce((s, e) => s + Number(e.amount), 0);
  const max = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.entitled), Math.abs(r.held)]));
  // General business expenses (not tied to a project) are split equally. Show it so the math is visible.
  const general = (expenses.data ?? []).filter((e) => !e.project_id);
  const generalTotal = general.reduce((s, e) => s + Number(e.amount), 0);
  const generalBy = (id: string) => general.filter((e) => e.paid_by_partner_id === id).reduce((s, e) => s + Number(e.amount), 0);

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[24px] font-semibold">התחשבנות</h2>
        <Link to="/money" className="text-[15px] text-pink">לכספים ←</Link>
      </div>
      <p className="mb-5 text-[15px] text-mute">
        {owes && owed ? <>כדי להתאזן, {owes.name} מעבירה ל{owed.name} <span className="text-bone"><Num>{money(owes.net_position)}</Num></span>.</> : "אתן מאוזנות. 👌"}
      </p>
      {rows.map((r) => (
        <div key={r.partner_id} className="mb-4">
          <div className="mb-1.5 flex justify-between text-[15px]"><span className="font-medium">{r.name}</span>
            <span className="text-mute">מגיע <Num>{money(r.entitled)}</Num> · מחזיקה <Num>{money(r.held)}</Num></span></div>
          <div className="space-y-1">
            <div className="h-1.5 rounded-full bg-[var(--ink-3)]"><div className="h-full rounded-full bg-pink" style={{ width: `${(Math.max(0, r.entitled) / max) * 100}%` }} /></div>
            <div className="h-1.5 rounded-full bg-[var(--ink-3)]"><div className="h-full rounded-full bg-bone/40" style={{ width: `${(Math.max(0, r.held) / max) * 100}%` }} /></div>
          </div>
        </div>
      ))}
      {generalTotal > 0 && (
        <div className="mt-5 rounded-2xl bg-[var(--ink-3)]/60 px-4 py-3 text-[14px] text-mute">
          <p><span className="text-bone">הוצאות כלליות של העסק</span>, חצי-חצי: <Num>{money(generalTotal)}</Num>, כלומר <Num>{money(generalTotal / Math.max(1, rows.length))}</Num> לכל אחת.</p>
          <p className="mt-1">{rows.map((r) => <span key={r.partner_id} className="me-4">{r.name} שילמה <Num>{money(generalBy(r.partner_id))}</Num></span>)}</p>
          <p className="mt-1 text-[13px] text-mute-2">זה כבר נכלל בחישוב למעלה.</p>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4 text-[14px] text-mute">
        <span>החודש: נכנס <Num>{money(monthInc)}</Num> · יצא <Num>{money(monthExp)}</Num></span>
        {owes && owed && <Button variant="ghost" className="!py-1.5 text-[14px]" onClick={() => setSettle(true)}>רישום התחשבנות</Button>}
      </div>
      <Modal open={settle} onClose={() => setSettle(false)} title="רישום התחשבנות">
        <SettlementForm from={owes?.partner_id} to={owed?.partner_id} amount={owes?.net_position} onDone={() => setSettle(false)} />
      </Modal>
    </Card>
  );
}

function Upcoming() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * 864e5);
  const meetings = useMeetings(start.toISOString(), end.toISOString());
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[24px] font-semibold">השבוע ביומן</h2>
        <Link to="/calendar" className="text-[15px] text-pink">ליומן ←</Link>
      </div>
      {!meetings.data?.length && <p className="text-mute">שבוע פנוי לפגישות. אולי זה הזמן לפנות ללקוח חדש?</p>}
      {meetings.data?.map((m) => (
        <div key={m.id} className="row-line flex items-center justify-between gap-3 py-3">
          <span>{m.title}{m.location && <span className="text-mute"> · {m.location}</span>}</span>
          <span className="shrink-0 text-[14px] text-mute">{dateTime(m.starts_at)}</span>
        </div>
      ))}
    </Card>
  );
}
