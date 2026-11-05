// Monthly Gantt: a row per project, a bar per task from its start to its deadline.
// In RTL the day columns run right-to-left, like a Hebrew calendar.
import { useMemo, useState } from "react";
import type { Project, Task } from "../lib/data";
import { TASK_STATUS } from "../lib/format";
import { Button, Modal, Num } from "./ui";
import { TaskForm } from "./forms";

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const LABEL_W = 150;

type Row = { key: string; label: string; projectId?: string; tasks: (Task & { from: number; to: number; late: boolean })[] };

export default function Gantt({ tasks, projects, month, onMonth }: {
  tasks: Task[]; projects: Project[]; month: Date; onMonth: (d: Date) => void;
}) {
  const [modal, setModal] = useState<null | { row?: Task; projectId?: string; startOn?: string }>(null);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const first = ymd(month);
  const last = ymd(new Date(month.getFullYear(), month.getMonth(), days));
  const todayKey = ymd(new Date());
  const todayCol = todayKey >= first && todayKey <= last ? new Date().getDate() : null;

  const rows = useMemo<Row[]>(() => {
    const byProject = new Map<string, Row>();
    for (const t of tasks) {
      const start = t.start_on ?? (t.due_on && t.created_at.slice(0, 10) < t.due_on ? t.created_at.slice(0, 10) : t.due_on);
      const end = t.due_on ?? t.start_on;
      if (!start || !end || end < first || start > last) continue;
      const from = start < first ? 1 : Number(start.slice(8, 10));
      const to = end > last ? days : Number(end.slice(8, 10));
      const key = t.project_id ?? "none";
      if (!byProject.has(key)) {
        byProject.set(key, { key, label: t.projects?.name ?? "כללי", projectId: t.project_id ?? undefined, tasks: [] });
      }
      byProject.get(key)!.tasks.push({ ...t, from, to: Math.max(from, to), late: t.status !== "done" && !!t.due_on && t.due_on < todayKey });
    }
    // Active client projects show even when empty, so it is obvious where nothing is planned yet.
    for (const p of projects.filter((p) => p.status === "active" && p.type === "client")) {
      if (!byProject.has(p.id)) byProject.set(p.id, { key: p.id, label: p.name, projectId: p.id, tasks: [] });
    }
    return [...byProject.values()].sort((a, b) => b.tasks.length - a.tasks.length);
  }, [tasks, projects, first, last, days, todayKey]);

  const cols = `${LABEL_W}px repeat(${days}, minmax(26px, 1fr))`;
  const shift = (n: number) => onMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" className="!px-4" onClick={() => shift(-1)} aria-label="חודש קודם">→</Button>
          <h3 className="min-w-[9ch] text-center text-[22px] font-semibold">{month.toLocaleDateString("he-IL", { month: "long", year: "numeric" })}</h3>
          <Button variant="ghost" className="!px-4" onClick={() => shift(1)} aria-label="חודש הבא">←</Button>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-mute">
          <Legend className="bg-pink" label="בעבודה" />
          <Legend className="bg-[var(--ink-3)] shadow-[inset_0_0_0_1px_var(--pink)]" label="לביצוע" />
          <Legend className="bg-pink-soft/35" label="בוצע" />
          <Button variant="primary" className="!py-1.5 !px-4 text-[14px]" onClick={() => setModal({})}>+ משימה</Button>
        </div>
      </div>

      <div className="overflow-x-auto pb-2">
        <div style={{ minWidth: LABEL_W + days * 26 }} className="relative">
          {/* Day header */}
          <div className="grid items-end text-center text-[12px] text-mute-2" style={{ gridTemplateColumns: cols }}>
            <div />
            {Array.from({ length: days }, (_, i) => {
              const d = new Date(month.getFullYear(), month.getMonth(), i + 1);
              const weekend = d.getDay() === 5 || d.getDay() === 6;
              return (
                <div key={i} className={`pb-2 ${weekend ? "opacity-50" : ""}`}>
                  <div className="text-[10px]">{"אבגדהוש"[d.getDay()]}</div>
                  <div className={`mx-auto grid size-6 place-items-center rounded-full ${todayCol === i + 1 ? "bg-pink font-semibold text-ink" : ""}`}><Num>{i + 1}</Num></div>
                </div>
              );
            })}
          </div>

          {rows.length === 0 && <div className="py-10 text-center text-mute">החודש עוד ריק. זה הזמן לתכנן משהו טוב.</div>}

          {rows.map((r) => (
            <div key={r.key} className="grid items-center py-1.5 shadow-[inset_0_1px_0_var(--line)]" style={{ gridTemplateColumns: cols, gridAutoRows: "34px" }}>
              <button className="truncate pe-3 text-start text-[15px] font-medium hover:text-pink-soft" style={{ gridColumn: 1, gridRow: `1 / span ${Math.max(1, r.tasks.length)}` }}
                onClick={() => setModal({ projectId: r.projectId })} title="משימה חדשה בפרויקט">
                {r.label}
                {r.tasks.length === 0 && <span className="block text-[12px] font-normal text-mute-2">+ להוסיף משימה</span>}
              </button>
              {/* Today line */}
              {todayCol && <div className="pointer-events-none h-full w-px justify-self-center bg-pink/50" style={{ gridColumn: todayCol + 1, gridRow: `1 / span ${Math.max(1, r.tasks.length)}` }} />}
              {r.tasks.map((t, i) => (
                <button key={t.id} onClick={() => setModal({ row: t })} title={`${t.title} · ${TASK_STATUS[t.status]}`}
                  className={`relative z-10 mx-0.5 h-[26px] truncate rounded-full px-3 text-start text-[13px] font-medium transition-transform duration-300 hover:-translate-y-px
                    ${t.status === "done" ? "bg-pink-soft/25 text-bone/70 line-through decoration-bone/30"
                      : t.status === "in_progress" ? "bg-pink text-ink"
                      : "bg-[var(--ink-3)] text-bone shadow-[inset_0_0_0_1px_var(--pink)]"}
                    ${t.late ? "ring-2 ring-pink-soft ring-offset-2 ring-offset-[var(--ink-2)]" : ""}`}
                  style={{ gridColumn: `${t.from + 1} / ${t.to + 2}`, gridRow: i + 1 }}>
                  {t.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.row ? "עריכת משימה" : "משימה חדשה"}>
        <TaskForm row={modal?.row} projectId={modal?.projectId} startOn={modal?.row ? undefined : todayKey} onDone={() => setModal(null)} />
      </Modal>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return <span className="hidden items-center gap-1.5 sm:inline-flex"><span className={`inline-block h-2.5 w-5 rounded-full ${className}`} />{label}</span>;
}
