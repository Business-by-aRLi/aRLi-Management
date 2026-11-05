import { useMemo, useState } from "react";
import { useRemove, useTime } from "../lib/data";
import { date, hours } from "../lib/format";
import { Button, Card, Empty, Input, Loading, Modal, Num, PageTitle } from "../components/ui";
import { TimeForm } from "../components/forms";

export default function TimePage() {
  const { data, isLoading } = useTime();
  const remove = useRemove("time_entries");
  const [adding, setAdding] = useState(false);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const rows = useMemo(() => (data ?? []).filter((r) => !month || r.work_date.startsWith(month)), [data, month]);

  // Summary: hours per partner, split into work and learning
  const summary = useMemo(() => {
    const m: Record<string, { work: number; learning: number }> = {};
    for (const r of rows) {
      const k = r.partners?.name ?? "?";
      m[k] ??= { work: 0, learning: 0 };
      m[k][r.kind as "work" | "learning"] += r.minutes;
    }
    return Object.entries(m);
  }, [rows]);
  const byProject = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.projects?.name ?? "כללי"] = (m[r.projects?.name ?? "כללי"] ?? 0) + r.minutes;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const max = Math.max(1, ...byProject.map(([, m]) => m));

  if (isLoading) return <Loading />;
  return (
    <div className="space-y-8">
      <PageTitle eyebrow="זמן" title="לאן הולכות השעות." action={<Button arrow className="group" onClick={() => setAdding(true)}>דיווח שעות</Button>} />
      <div className="max-w-xs"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div>

      <div className="grid gap-4 sm:grid-cols-2">
        {summary.map(([name, s]) => (
          <Card key={name}>
            <div className="text-[19px] font-semibold">{name}</div>
            <div className="mt-2 text-[clamp(28px,2.6vw,40px)] font-light text-pink"><Num>{hours(s.work + s.learning)}</Num></div>
            <div className="text-mute">עבודה <Num>{hours(s.work)}</Num> · למידה <Num>{hours(s.learning)}</Num></div>
          </Card>
        ))}
      </div>

      {!!byProject.length && (
        <Card>
          <h2 className="mb-4 text-[22px] font-semibold">לפי פרויקט</h2>
          {byProject.map(([name, m]) => (
            <div key={name} className="mb-3">
              <div className="mb-1 flex justify-between text-[15px]"><span>{name}</span><span className="text-mute"><Num>{hours(m)}</Num></span></div>
              <div className="h-1.5 rounded-full bg-[var(--ink-3)]"><div className="h-full rounded-full bg-pink" style={{ width: `${(m / max) * 100}%` }} /></div>
            </div>
          ))}
        </Card>
      )}

      <Card>
        {!rows.length && <Empty>עוד אין דיווחים בחודש הזה. אפשר גם לכתוב לבוט "עבדתי שעתיים על מגדלור".</Empty>}
        {rows.map((r) => (
          <div key={r.id} className="row-line flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-[14px] text-mute"><Num>{date(r.work_date)}</Num></span>
            <span className="flex-1">{r.projects?.name ?? "כללי"}<span className="text-mute"> · {r.partners?.name} · {r.kind === "learning" ? "למידה" : "עבודה"}{r.description ? ` · ${r.description}` : ""}</span></span>
            <Num>{hours(r.minutes)}</Num>
            <Button variant="quiet" onClick={() => confirm("למחוק?") && remove.mutate(r.id)}>מחיקה</Button>
          </div>
        ))}
      </Card>
      <Modal open={adding} onClose={() => setAdding(false)} title="דיווח שעות"><TimeForm onDone={() => setAdding(false)} /></Modal>
    </div>
  );
}
