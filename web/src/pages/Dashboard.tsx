// Home: a place for growth. Momentum first, then the month's plan, goals and ideas.
// The partner balance lives in one calm module, not in the headline.
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useBusinessSummary, usePartnerSummary, useExpenses, useIdeas, useIncome, useMeetings, useProjects, useRemove, useSave, useTasks, useTime, useWorkPlans,
  type Idea, type WorkPlan,
} from "../lib/data";
import { money, today } from "../lib/format";
import { Button, Card, Eyebrow, IconButton, Input, Modal, Num, Pill, useConfirm } from "../components/ui";
import { Icon } from "../components/icons";
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
      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Momentum value={String(doneThisMonth)} label="משימות שסגרנו החודש" ring={monthTasks.length ? doneThisMonth / Math.max(1, doneThisMonth + openThisMonth) : 0} />
        <Momentum value={String(openThisMonth)} label="משימות בדרך החודש" />
        <Momentum value={money(monthIncome)} label="נכנס החודש" />
        <Momentum value={`${Math.round(createMinutes / 60)}`} suffix="ש׳" label="שעות יצירה החודש" />
      </section>

      {/* The month's plan */}
      <Card>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-[clamp(24px,2.2vw,32px)] font-semibold">התוכנית של החודש</h2>
          <Link to="/tasks" className="shrink-0 text-[15px] text-pink hover:text-pink-soft">לוח משימות ←</Link>
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
      <div className="relative">
        {ring !== undefined && (
          <svg viewBox="0 0 36 36" className="absolute top-0 end-0 size-9 -rotate-90 sm:size-11" role="img" aria-label={`${Math.round(ring * 100)}% מהמשימות של החודש נסגרו`}>
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--line-2)" strokeWidth="3.5" />
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--pink)" strokeWidth="3.5" strokeLinecap="round"
              strokeDasharray={`${ring * 97.4} 97.4`} style={{ transition: "stroke-dasharray .8s var(--ease)" }} />
          </svg>
        )}
        <div className="text-[clamp(30px,2.8vw,42px)] font-light leading-none text-pink"><Num>{value}</Num>{suffix && <span className="ms-1 text-[0.5em]">{suffix}</span>}</div>
        <div className="mt-2.5 text-[15px] leading-snug text-mute">{label}</div>
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
        <Button variant="quiet" className="!text-pink hover:!text-pink-soft" onClick={() => setModal({})}><Icon name="plus" size={16} />יעד</Button>
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
          <button key={p.id} onClick={() => setModal({ row: p })} className="row-line row-btn block w-[calc(100%+20px)] py-4 text-start">
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
  const confirm = useConfirm();
  const [title, setTitle] = useState("");
  const visible = ideas.filter((i) => i.status !== "parked").slice(0, 8);

  return (
    <Card>
      <h2 className="text-[24px] font-semibold">יוזמות ורעיונות</h2>
      <p className="mb-4 text-[15px] text-mute">כל רעיון נכנס לכאן, גם אם הוא רק התחלה. לחיצה על התגית מקדמת אותו שלב.</p>
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
            <button className="press" onClick={() => save.mutate({ id: i.id, values: { status: IDEA_NEXT[i.status] } })} title={`להעביר ל"${IDEA_STATUS[IDEA_NEXT[i.status]]}"`}>
              <Pill tone={i.status === "go" ? "pink" : "mute"}>{IDEA_STATUS[i.status]}</Pill>
            </button>
            <IconButton icon="trash" size={32} label="מחיקת הרעיון" onClick={async () => (await confirm({ title: "למחוק את הרעיון?", body: i.title })) && remove.mutate(i.id)} />
          </span>
        </div>
      ))}
    </Card>
  );
}

// The settlement, between three parties: the business, Miri and Riki. Nobody "holds" money:
// each partner invested, the business made a profit, and each partner received money.
export function BalanceModule() {
  const partners = usePartnerSummary();
  const business = useBusinessSummary();
  const [settle, setSettle] = useState(false);
  const rows = partners.data ?? [];
  const biz = business.data;
  const gets = rows.find((r) => r.balance > 0.005);   // still has money coming to her
  const gives = rows.find((r) => r.balance < -0.005); // received more than her part

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[24px] font-semibold">התחשבנות</h2>
        <Link to="/money" className="text-[15px] text-pink hover:text-pink-soft">לכספים ←</Link>
      </div>
      <div className="mb-4" />

      {biz && (
        <div className="mb-5 rounded-2xl bg-[var(--ink-3)]/60 px-4 py-3">
          <div className="flex items-baseline justify-between"><span className="font-medium">העסק</span>
            <span className="text-[13px] text-mute">רווח כולל</span></div>
          <div className={`mt-1 text-[28px] font-semibold ${biz.profit < 0 ? "text-error" : ""}`}><Num>{money(biz.profit)}</Num></div>
          <p className="mt-1 text-[13px] text-mute">
            הכנסות <Num>{money(biz.income)}</Num> · הוצאות פרויקטים <Num>{money(biz.project_expenses)}</Num> · השקעות כלליות <Num>{money(biz.general_expenses)}</Num>
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.partner_id} className="rounded-2xl border border-[var(--line)] px-4 py-3 text-[14px]">
            <p className="mb-2 text-[16px] font-medium">{r.name}</p>
            <Line label="השקיעה" value={r.invested} />
            <Line label="חלקה ברווח" value={r.profit_share} />
            <Line label="קיבלה" value={r.received} />
            <div className="mt-2 flex justify-between border-t border-[var(--line)] pt-2">
              <span className="text-mute">{r.balance > 0.005 ? "עוד מגיע לה" : r.balance < -0.005 ? "קיבלה מעבר לחלקה" : "מאוזנת"}</span>
              <Num className={r.balance > 0.005 ? "text-pink" : ""}>{money(Math.abs(r.balance))}</Num>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[13px] text-mute-2">
        <span>הוצאות כלליות נחשבות השקעה בעסק ומתחלקות חצי-חצי. רווח מפרויקט מתחלק לפי החלוקה שלו.</span>
        {gets && gives && <Button variant="ghost" className="!py-1.5 text-[14px]" onClick={() => setSettle(true)}>רישום העברה</Button>}
      </div>
      <Modal open={settle} onClose={() => setSettle(false)} title="רישום העברה בין השותפות">
        <SettlementForm from={gives?.partner_id} to={gets?.partner_id} amount={gets?.balance} onDone={() => setSettle(false)} />
      </Modal>
    </Card>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return <div className="flex justify-between py-0.5"><span className="text-mute">{label}</span><Num>{money(value)}</Num></div>;
}

function Upcoming() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 7 * 864e5);
  const meetings = useMeetings(start.toISOString(), end.toISOString());
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[24px] font-semibold">השבוע ביומן</h2>
        <Link to="/calendar" className="text-[15px] text-pink hover:text-pink-soft">ליומן ←</Link>
      </div>
      {!meetings.data?.length && <p className="text-mute">שבוע פנוי לפגישות. אולי זה הזמן לפנות ללקוח חדש?</p>}
      {meetings.data?.map((m) => (
        <div key={m.id} className="row-line flex items-center gap-4 py-3">
          <span className="grid w-12 shrink-0 place-items-center rounded-[14px] bg-[var(--ink-3)] py-1.5 leading-tight shadow-[inset_0_0_0_1px_var(--line)]">
            <span className="text-[12px] text-mute">{new Date(m.starts_at).toLocaleDateString("he-IL", { weekday: "short" })}</span>
            <span className="text-[18px] font-semibold"><Num>{new Date(m.starts_at).getDate()}</Num></span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{m.title}</span>
            <span className="block text-[14px] text-mute"><Num>{new Date(m.starts_at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}</Num>{m.location && ` · ${m.location}`}</span>
          </span>
        </div>
      ))}
    </Card>
  );
}
