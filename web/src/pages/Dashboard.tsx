import { useState } from "react";
import { Link } from "react-router-dom";
import { useBalances, useExpenses, useFinancials, useIncome, useMeetings, useTasks } from "../lib/data";
import { dateTime, date, money, today } from "../lib/format";
import { Button, Card, Eyebrow, Modal, Num } from "../components/ui";
import { SettlementForm } from "../components/forms";

export default function Dashboard() {
  const balances = useBalances();
  const expenses = useExpenses();
  const income = useIncome();
  const financials = useFinancials();
  const tasks = useTasks();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(dayStart.getTime() + 7 * 864e5);
  const meetings = useMeetings(dayStart.toISOString(), weekEnd.toISOString());
  const [settle, setSettle] = useState(false);

  const owes = balances.data?.find((b) => b.net_position > 0.005);
  const owed = balances.data?.find((b) => b.net_position < -0.005);
  const month = today().slice(0, 7);
  const sum = (rows?: { amount: number }[]) => (rows ?? []).reduce((s, r) => s + Number(r.amount), 0);
  const monthExp = sum(expenses.data?.filter((e) => e.spent_on.startsWith(month)));
  const monthInc = sum(income.data?.filter((i) => i.received_on.startsWith(month)));
  const t = today();
  const lateTasks = tasks.data?.filter((x) => x.status !== "done" && x.due_on && x.due_on < t) ?? [];
  const dueSoon = tasks.data?.filter((x) => x.status !== "done" && x.due_on && x.due_on >= t && x.due_on <= weekEnd.toISOString().slice(0, 10)) ?? [];
  const active = financials.data?.filter((f) => f.status === "active" && f.type === "client") ?? [];

  return (
    <div className="space-y-14">
      {/* The one design move: the balance as a headline sentence */}
      <section>
        <Eyebrow>המאזן ביניכן</Eyebrow>
        <h1 className="mt-2 max-w-[18ch] text-[clamp(40px,6.4vw,108px)] font-semibold leading-[1.03] tracking-[-0.025em]">
          {balances.isLoading ? "…" : owes && owed ? (
            <>{owes.name} חייבת ל{owed.name} <span className="text-pink"><Num>{money(owes.net_position)}</Num>.</span></>
          ) : (
            <>אתן <span className="text-pink">מאוזנות.</span></>
          )}
        </h1>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {owes && owed && <Button arrow className="group" onClick={() => setSettle(true)}>רישום התחשבנות</Button>}
          <Link to="/money"><Button variant="ghost">לכל התנועות</Button></Link>
        </div>
        {balances.data && (
          <p className="mt-6 max-w-2xl text-[15px] text-mute">
            {balances.data.map((b) => (
              <span key={b.partner_id} className="me-6 inline-block">
                {b.name}: מגיע לה <Num>{money(b.entitled)}</Num>, מחזיקה <Num>{money(b.held)}</Num>
              </span>
            ))}
          </p>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="הכנסות החודש" value={money(monthInc)} />
        <Stat label="הוצאות החודש" value={money(monthExp)} />
        <Stat label="פרויקטים פעילים ללקוחות" value={String(active.length)} />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-[24px] font-semibold">מה מחכה לכן</h2>
          {lateTasks.length + dueSoon.length === 0 && <p className="text-mute">אין משימות דחופות השבוע.</p>}
          {[...lateTasks, ...dueSoon].map((x) => (
            <div key={x.id} className="row-line flex items-center justify-between gap-3 py-3">
              <span>{x.title}{x.projects?.name && <span className="text-mute"> · {x.projects.name}</span>}</span>
              <span className={`shrink-0 text-[14px] ${x.due_on! < t ? "text-pink-soft" : "text-mute"}`}>
                {x.due_on! < t ? "באיחור · " : ""}<Num>{date(x.due_on)}</Num>
              </span>
            </div>
          ))}
          <Link to="/tasks" className="mt-3 inline-block text-[15px] text-pink">לכל המשימות ←</Link>
        </Card>
        <Card>
          <h2 className="mb-4 text-[24px] font-semibold">השבוע ביומן</h2>
          {!meetings.data?.length && <p className="text-mute">אין פגישות בשבוע הקרוב.</p>}
          {meetings.data?.map((m) => (
            <div key={m.id} className="row-line flex items-center justify-between gap-3 py-3">
              <span>{m.title}{m.location && <span className="text-mute"> · {m.location}</span>}</span>
              <span className="shrink-0 text-[14px] text-mute">{dateTime(m.starts_at)}</span>
            </div>
          ))}
          <Link to="/calendar" className="mt-3 inline-block text-[15px] text-pink">ליומן ←</Link>
        </Card>
      </section>

      <section>
        <h2 className="mb-4 text-[24px] font-semibold">פרויקטים פעילים</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {financials.data?.filter((f) => f.status === "active").map((f) => (
            <Link key={f.project_id} to={`/projects/${f.project_id}`} className="block transition-transform duration-500 hover:-translate-y-0.5">
              <Card>
                <div className="text-[19px] font-semibold">{f.name}</div>
                <div className="mt-3 text-[clamp(26px,2.4vw,34px)] font-light text-pink"><Num>{money(f.profit)}</Num></div>
                <div className="text-[14px] text-mute">רווח · הכנסות <Num>{money(f.income)}</Num> · הוצאות <Num>{money(f.expenses)}</Num></div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <Modal open={settle} onClose={() => setSettle(false)} title="רישום התחשבנות">
        <SettlementForm from={owes?.partner_id} to={owed?.partner_id} amount={owes?.net_position} onDone={() => setSettle(false)} />
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-[clamp(30px,3vw,44px)] font-light text-pink"><Num>{value}</Num></div>
      <div className="text-mute">{label}</div>
    </Card>
  );
}
