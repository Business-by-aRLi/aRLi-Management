import { useState } from "react";
import { useSave, useTasks, useRemove, type Task } from "../lib/data";
import { date, TASK_STATUS, today } from "../lib/format";
import { Button, Card, Loading, Modal, Num, PageTitle, Pill } from "../components/ui";
import { TaskForm } from "../components/forms";

const COLUMNS = ["todo", "in_progress", "done"] as const;
const NEXT: Record<string, string> = { todo: "in_progress", in_progress: "done", done: "todo" };

export default function Tasks() {
  const { data, isLoading } = useTasks();
  const save = useSave("tasks");
  const remove = useRemove("tasks");
  const [modal, setModal] = useState<null | { row?: Task }>(null);
  const t = today();
  if (isLoading) return <Loading />;

  const move = (task: Task) => save.mutate({
    id: task.id, values: { status: NEXT[task.status], completed_at: NEXT[task.status] === "done" ? new Date().toISOString() : null },
  });

  return (
    <div>
      <PageTitle eyebrow="משימות" title="מה עושים עכשיו." action={<Button arrow className="group" onClick={() => setModal({})}>משימה חדשה</Button>} />
      <div className="grid gap-6 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const list = (data ?? []).filter((x) => x.status === col)
            .sort((a, b) => a.priority - b.priority || (a.due_on ?? "9").localeCompare(b.due_on ?? "9"));
          return (
            <section key={col}>
              <h2 className="mb-3 flex items-center gap-2 text-[20px] font-semibold">{TASK_STATUS[col]} <span className="font-mono text-[14px] text-mute"><Num>{list.length}</Num></span></h2>
              <div className="space-y-3">
                {(col === "done" ? list.slice(0, 15) : list).map((x) => (
                  <Card key={x.id}>
                    <div className="flex items-start justify-between gap-3">
                      <button className="text-start text-[17px] font-medium hover:text-pink-soft" onClick={() => setModal({ row: x })}>{x.title}</button>
                      {x.priority === 1 && <Pill tone="pink">דחוף</Pill>}
                    </div>
                    <div className="mt-1 text-[14px] text-mute">
                      {[x.projects?.name, x.partners?.name ?? "שתיכן"].filter(Boolean).join(" · ")}
                      {x.due_on && <> · <span className={x.due_on < t && col !== "done" ? "text-pink-soft" : ""}><Num>{date(x.due_on)}</Num></span></>}
                    </div>
                    <div className="mt-3 flex gap-1">
                      <Button variant="quiet" className="!px-0 me-3" onClick={() => move(x)}>{col === "done" ? "החזרה" : `ל${TASK_STATUS[NEXT[col]]} ←`}</Button>
                      {col === "done" && <Button variant="quiet" onClick={() => remove.mutate(x.id)}>מחיקה</Button>}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.row ? "עריכת משימה" : "משימה חדשה"}>
        <TaskForm row={modal?.row} onDone={() => setModal(null)} />
      </Modal>
    </div>
  );
}
