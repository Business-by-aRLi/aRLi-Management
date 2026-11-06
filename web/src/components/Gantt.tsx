// Monthly Gantt: a row per project, a bar per task from its start to its deadline.
// In RTL the day columns run right-to-left, like a Hebrew calendar.
// Tasks that don't overlap share a lane, so a project with many small tasks stays compact.
// When a bar is too short for its title, the title sits beside the bar instead of being cut.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, Task } from "../lib/data";
import { isArchived, TASK_STATUS } from "../lib/format";
import { Button, IconButton, Modal, Num } from "./ui";
import { Icon } from "./icons";
import { TaskForm } from "./forms";

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const LABEL_W = 132;
const COL_W = 30; // approximate day width, used to decide if a title fits inside its bar
const textDays = (title: string) => Math.ceil((title.length * 7.4 + 28) / COL_W);

type Placed = Task & { from: number; to: number; lane: number; late: boolean; label?: { from: number; to: number; side: "after" | "before" } };
type Row = { key: string; label: string; projectId?: string; lanes: number; tasks: Placed[] };

export default function Gantt({ tasks, projects, month, onMonth }: {
  tasks: Task[]; projects: Project[]; month: Date; onMonth: (d: Date) => void;
}) {
  const [modal, setModal] = useState<null | { row?: Task; projectId?: string; startOn?: string }>(null);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const first = ymd(month);
  const last = ymd(new Date(month.getFullYear(), month.getMonth(), days));
  const todayKey = ymd(new Date());
  const todayCol = todayKey >= first && todayKey <= last ? new Date().getDate() : null;
  const scroller = useRef<HTMLDivElement>(null);
  const todayCell = useRef<HTMLDivElement>(null);

  // On a narrow screen, bring today into view instead of always opening on the 1st.
  useEffect(() => {
    const box = scroller.current, cell = todayCell.current;
    if (!box || !cell || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect(), c = cell.getBoundingClientRect();
    box.scrollBy({ left: c.left + c.width / 2 - (b.left + (b.width + LABEL_W) / 2) });
  }, [first, todayCol]);

  const rows = useMemo<Row[]>(() => {
    const byProject = new Map<string, { key: string; label: string; projectId?: string; tasks: (Task & { from: number; to: number; late: boolean })[] }>();
    for (const t of tasks) {
      const start = t.start_on ?? (t.due_on && t.created_at.slice(0, 10) < t.due_on ? t.created_at.slice(0, 10) : t.due_on);
      const end = t.due_on ?? t.start_on;
      if (!start || !end || end < first || start > last) continue;
      const from = start < first ? 1 : Number(start.slice(8, 10));
      const to = end > last ? days : Number(end.slice(8, 10));
      const key = t.project_id ?? "none";
      if (!byProject.has(key)) byProject.set(key, { key, label: t.projects?.name ?? "כללי", projectId: t.project_id ?? undefined, tasks: [] });
      byProject.get(key)!.tasks.push({ ...t, from, to: Math.max(from, to), late: t.status !== "done" && !!t.due_on && t.due_on < todayKey });
    }
    // Active client projects show even when empty, so it is obvious where nothing is planned yet.
    for (const p of projects.filter((p) => !isArchived(p.status) && p.type === "client")) {
      if (!byProject.has(p.id)) byProject.set(p.id, { key: p.id, label: p.name, projectId: p.id, tasks: [] });
    }
    return [...byProject.values()].map((r) => {
      // Greedy lane packing: each task takes the first lane that is free over its days (title included).
      const laneEnds: number[] = [];
      const placed = [...r.tasks].sort((a, b) => a.from - b.from || b.to - a.to).map((t) => {
        const span = t.to - t.from + 1, need = textDays(t.title);
        let label: Placed["label"];
        let occFrom = t.from, occTo = t.to;
        if (span < need) {
          if (t.to + need <= days) { label = { from: t.to + 1, to: t.to + need, side: "after" }; occTo = t.to + need; }
          else { const f = Math.max(1, t.from - need); label = { from: f, to: t.from - 1, side: "before" }; occFrom = f; }
        }
        let lane = laneEnds.findIndex((end) => end < occFrom);
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
        laneEnds[lane] = occTo;
        return { ...t, lane, label };
      });
      return { key: r.key, label: r.label, projectId: r.projectId, lanes: Math.max(1, laneEnds.length), tasks: placed };
    }).sort((a, b) => b.tasks.length - a.tasks.length);
  }, [tasks, projects, first, last, days, todayKey]);

  const cols = `${LABEL_W}px repeat(${days}, minmax(28px, 1fr))`;
  const shift = (n: number) => onMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const weekend = (day: number) => { const g = new Date(month.getFullYear(), month.getMonth(), day).getDay(); return g === 5 || g === 6; };
  const isCurrent = todayCol !== null;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <IconButton icon="chevronPrev" tone="ghost" label="חודש קודם" onClick={() => shift(-1)} />
          <h3 className="min-w-[9ch] text-center text-[20px] font-semibold">{month.toLocaleDateString("he-IL", { month: "long", year: "numeric" })}</h3>
          <IconButton icon="chevronNext" tone="ghost" label="חודש הבא" onClick={() => shift(1)} />
          {!isCurrent && <Button variant="quiet" className="text-pink" onClick={() => onMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>להיום</Button>}
        </div>
        <div className="flex items-center gap-4 text-[13px] text-mute">
          <Legend className="bg-pink" label="בעבודה" />
          <Legend className="bg-[var(--ink-3)] shadow-[inset_0_0_0_1.5px_var(--pink)]" label="לביצוע" />
          <Legend className="bg-pink-soft/25" label="בוצע" />
          <Button className="!py-1.5 !px-4 text-[14px]" onClick={() => setModal({})}><Icon name="plus" size={16} />משימה</Button>
        </div>
      </div>

      <div ref={scroller} className="-mx-2 overflow-x-auto px-2 pb-2 no-scrollbar">
        <div style={{ minWidth: LABEL_W + days * 28 }} className="relative">
          {/* Day header */}
          <div className="grid items-end text-center text-[12px] text-mute-2" style={{ gridTemplateColumns: cols }}>
            <div className="sticky start-0 z-20 h-full bg-[var(--ink-2)]" />
            {Array.from({ length: days }, (_, i) => {
              const d = new Date(month.getFullYear(), month.getMonth(), i + 1);
              return (
                <div key={i} ref={todayCol === i + 1 ? todayCell : undefined} className={`pb-2 ${weekend(i + 1) ? "opacity-45" : ""}`}>
                  <div className="text-[10px]">{"אבגדהוש"[d.getDay()]}</div>
                  <div className={`mx-auto grid size-6 place-items-center rounded-full ${todayCol === i + 1 ? "bg-pink font-semibold text-on-pink" : ""}`}><Num>{i + 1}</Num></div>
                </div>
              );
            })}
          </div>

          {rows.length === 0 && <div className="py-10 text-center text-mute">החודש עוד ריק. זה הזמן לתכנן משהו טוב.</div>}

          {rows.map((r) => (
            <div key={r.key} className="group/row grid items-center py-1.5 shadow-[inset_0_1px_0_var(--line)]" style={{ gridTemplateColumns: cols, gridAutoRows: "32px" }}>
              <button className="sticky start-0 z-20 h-full self-stretch bg-[var(--ink-2)] pe-3 text-start text-[15px] font-medium leading-tight hover:text-pink-soft"
                style={{ gridColumn: 1, gridRow: `1 / span ${r.lanes}` }}
                onClick={() => setModal({ projectId: r.projectId })} title={`משימה חדשה ב${r.label}`}>
                <span className="line-clamp-2">{r.label}</span>
                <span className={`mt-0.5 items-center gap-1 text-[12px] font-normal text-mute-2 ${r.tasks.length === 0 ? "flex" : "hidden group-hover/row:flex"}`}><Icon name="plus" size={12} />משימה</span>
              </button>
              {/* Today line */}
              {todayCol && <div className="pointer-events-none h-full w-px justify-self-center bg-pink/60" style={{ gridColumn: todayCol + 1, gridRow: `1 / span ${r.lanes}` }} />}
              {r.tasks.map((t) => {
                const open = () => setModal({ row: t });
                const tip = `${t.title} · ${TASK_STATUS[t.status]}${t.partners?.name ? ` · ${t.partners.name}` : ""}${t.late ? " · באיחור" : ""}`;
                return [
                  <button key={t.id} onClick={open} title={tip} aria-label={tip}
                    className={`relative z-10 mx-0.5 flex h-[26px] items-center gap-1 overflow-hidden rounded-full px-2.5 text-start text-[13px] font-medium transition-transform duration-300 hover:-translate-y-px
                      ${t.status === "done" ? "bg-pink-soft/25 text-bone/70"
                        : t.status === "in_progress" ? "bg-pink text-on-pink"
                        : "bg-[var(--ink-3)] text-bone shadow-[inset_0_0_0_1.5px_var(--pink)]"}
                      ${t.late ? "ring-2 ring-pink-soft ring-offset-2 ring-offset-[var(--ink-2)]" : ""}`}
                    style={{ gridColumn: `${t.from + 1} / ${t.to + 2}`, gridRow: t.lane + 1 }}>
                    {t.status === "done" && <Icon name="check" size={14} className="shrink-0" />}
                    {!t.label && <span className="truncate">{t.title}</span>}
                  </button>,
                  t.label && (
                    <button key={`${t.id}-l`} onClick={open} tabIndex={-1}
                      className={`z-10 truncate px-1.5 text-[13px] hover:text-bone ${t.status === "done" ? "text-mute-2" : "text-mute"} ${t.label.side === "before" ? "text-end" : "text-start"}`}
                      style={{ gridColumn: `${t.label.from + 1} / ${t.label.to + 2}`, gridRow: t.lane + 1 }}>
                      {t.title}
                    </button>
                  ),
                ];
              })}
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
