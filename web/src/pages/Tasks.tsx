import { useState } from "react";
import { usePartners, useSave, useTasks, useRemove, type Task } from "../lib/data";
import { date, TASK_STATUS, today } from "../lib/format";
import { Button, Card, Empty, IconButton, Loading, Modal, Num, PageTitle, Pill, Segmented, useConfirm } from "../components/ui";
import { TaskForm, useMe } from "../components/forms";

const COLUMNS = ["todo", "in_progress", "done"] as const;
type Col = (typeof COLUMNS)[number];
const NEXT: Record<string, string> = { todo: "in_progress", in_progress: "done", done: "todo" };
const MOVE_LABEL: Record<string, string> = { todo: "להתחיל", in_progress: "סיימתי", done: "להחזיר" };

export default function Tasks() {
  const { data, isLoading } = useTasks();
  const partners = usePartners();
  const me = useMe();
  const save = useSave("tasks");
  const remove = useRemove("tasks");
  const confirm = useConfirm();
  const [modal, setModal] = useState<null | { row?: Task }>(null);
  const [who, setWho] = useState("all");
  const [phoneCol, setPhoneCol] = useState<Col>("todo");
  const t = today();
  if (isLoading) return <Loading />;

  const move = (task: Task) => save.mutate({
    id: task.id, values: { status: NEXT[task.status], completed_at: NEXT[task.status] === "done" ? new Date().toISOString() : null },
  });
  // A task with no assignee belongs to both partners, so it shows under each.
  const mine = (x: Task) => who === "all" || !x.assignee_partner_id || x.assignee_partner_id === who;
  const list = (col: Col) => (data ?? []).filter((x) => x.status === col && mine(x))
    .sort((a, b) => a.priority - b.priority || (a.due_on ?? "9").localeCompare(b.due_on ?? "9"));
  const whoOptions: [string, string][] = [["all", "הכל"], ...(partners.data ?? []).map((p): [string, string] => [p.id, p.id === me?.id ? "שלי" : `של ${p.name}`])];

  return (
    <div>
      <PageTitle eyebrow="משימות" title="מה עושים עכשיו." action={<Button arrow className="group" onClick={() => setModal({})}>משימה חדשה</Button>} />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Segmented label="של מי" value={who} onChange={setWho} options={whoOptions} />
        <div className="lg:hidden">
          <Segmented label="סטטוס" value={phoneCol} onChange={setPhoneCol}
            options={COLUMNS.map((c): [Col, string] => [c, `${TASK_STATUS[c]} ${list(c).length}`])} />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const items = list(col);
          return (
            <section key={col} className={col === phoneCol ? "" : "hidden lg:block"}>
              <h2 className="mb-3 hidden items-center gap-2 text-[20px] font-semibold lg:flex">{TASK_STATUS[col]} <span className="font-mono text-[14px] text-mute"><Num>{items.length}</Num></span></h2>
              {!items.length && <Card><Empty>{col === "done" ? "עוד לא נסגרו משימות." : col === "in_progress" ? "שום דבר לא בעבודה כרגע." : "אין משימות פתוחות. יפה."}</Empty></Card>}
              <div className="space-y-3">
                {(col === "done" ? items.slice(0, 15) : items).map((x) => {
                  const late = !!x.due_on && x.due_on < t && col !== "done";
                  return (
                    <div key={x.id} className="lift">
                      <Card>
                        <div className="flex items-start justify-between gap-3">
                          <button className="text-start text-[17px] font-medium leading-snug hover:text-pink-soft" onClick={() => setModal({ row: x })}>{x.title}</button>
                          <span className="flex shrink-0 gap-1">
                            {late && <Pill tone="pink">באיחור</Pill>}
                            {!late && x.priority === 1 && col !== "done" && <Pill tone="pink">דחוף</Pill>}
                          </span>
                        </div>
                        <div className="mt-1 text-[14px] text-mute">
                          {[x.projects?.name, x.partners?.name ?? "שתינו"].filter(Boolean).join(" · ")}
                          {x.due_on && <> · <span className={late ? "text-pink-soft" : ""}><Num>{date(x.due_on)}</Num></span></>}
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <Button variant="ghost" className="!px-4 !py-1.5 text-[14px]" onClick={() => move(x)}>{MOVE_LABEL[col]}</Button>
                          {col === "done" && <IconButton icon="trash" label="מחיקת המשימה" onClick={async () => (await confirm({ title: "למחוק את המשימה?", body: x.title })) && remove.mutate(x.id)} />}
                        </div>
                      </Card>
                    </div>
                  );
                })}
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
