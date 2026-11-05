import { useMemo, useState } from "react";
import { useMeetings, useRemove, useTasks, type Meeting } from "../lib/data";
import { Button, Card, IconButton, Modal, Num, PageTitle, useConfirm } from "../components/ui";
import { Icon } from "../components/icons";
import { MeetingForm } from "../components/forms";

const DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });

// Month grid starting on Sunday, as in Israel.
export default function CalendarPage() {
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d; });
  const gridStart = new Date(cursor); gridStart.setDate(1 - cursor.getDay());
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 42);
  const meetings = useMeetings(gridStart.toISOString(), gridEnd.toISOString());
  const tasks = useTasks();
  const remove = useRemove("meetings");
  const confirm = useConfirm();
  const [modal, setModal] = useState<null | { row?: Meeting }>(null);
  const [selected, setSelected] = useState(ymd(new Date()));

  const byDay = useMemo(() => {
    const m: Record<string, { meetings: Meeting[]; deadlines: string[] }> = {};
    for (const x of meetings.data ?? []) (m[ymd(new Date(x.starts_at))] ??= { meetings: [], deadlines: [] }).meetings.push(x);
    for (const t of tasks.data ?? []) if (t.due_on && t.status !== "done") (m[t.due_on] ??= { meetings: [], deadlines: [] }).deadlines.push(t.title);
    return m;
  }, [meetings.data, tasks.data]);

  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; });
  const shift = (n: number) => { const d = new Date(cursor); d.setMonth(d.getMonth() + n); setCursor(d); };
  const todayKey = ymd(new Date());
  const sel = byDay[selected];

  return (
    <div className="space-y-6">
      <PageTitle eyebrow="יומן" title={cursor.toLocaleDateString("he-IL", { month: "long", year: "numeric" })} action={
        <div className="flex flex-wrap items-center gap-2">
          <IconButton icon="chevronPrev" tone="ghost" size={44} label="חודש קודם" onClick={() => shift(-1)} />
          <IconButton icon="chevronNext" tone="ghost" size={44} label="חודש הבא" onClick={() => shift(1)} />
          <Button arrow className="group" onClick={() => setModal({})}>פגישה חדשה</Button>
        </div>
      } />

      <Card>
        <div className="grid grid-cols-7 gap-1 text-center text-[14px] text-mute">{DAYS.map((d) => <div key={d} className="py-1">{d}</div>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((d) => {
            const key = ymd(d); const info = byDay[key];
            const inMonth = d.getMonth() === cursor.getMonth();
            return (
              <button key={key} onClick={() => setSelected(key)}
                className={`press flex min-h-[64px] flex-col items-start justify-start rounded-[12px] p-1.5 text-start transition-colors sm:min-h-[96px] ${selected === key ? "bg-[var(--ink-3)] shadow-[inset_0_0_0_1px_var(--line-2)]" : "hover:bg-[var(--hover-veil)]"} ${inMonth ? "" : "opacity-35"}`}>
                <span className={`inline-grid size-7 place-items-center rounded-full text-[14px] ${key === todayKey ? "bg-pink text-ink font-semibold" : ""}`}><Num>{d.getDate()}</Num></span>
                <div className="mt-1 hidden w-full min-w-0 space-y-0.5 sm:block">
                  {info?.meetings.slice(0, 2).map((m) => <div key={m.id} className="truncate text-[12px] text-bone"><Num>{time(m.starts_at)}</Num> {m.title}</div>)}
                  {info?.deadlines.slice(0, 1).map((t) => <div key={t} className="flex items-center gap-1 truncate text-[12px] text-pink-soft"><Icon name="flag" size={12} className="shrink-0" /><span className="truncate">{t}</span></div>)}
                </div>
                {info && <div className="mt-1 flex gap-0.5 sm:hidden">{info.meetings.length > 0 && <span className="size-1.5 rounded-full bg-bone" />}{info.deadlines.length > 0 && <span className="size-1.5 rounded-full bg-pink" />}</div>}
              </button>
            );
          })}
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-[22px] font-semibold">{new Date(`${selected}T12:00:00`).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })}</h2>
        {!sel && <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-mute">יום פנוי.</p><Button variant="ghost" className="!py-1.5 text-[14px]" onClick={() => setModal({})}><Icon name="plus" size={16} />פגישה חדשה</Button></div>}
        {sel?.meetings.map((m) => (
          <div key={m.id} className="row-line flex flex-wrap items-center justify-between gap-3 py-3">
            <span><Num>{time(m.starts_at)}</Num> · {m.title}{m.location && <span className="text-mute"> · {m.location}</span>}{m.projects?.name && <span className="text-mute"> · {m.projects.name}</span>}</span>
            <span className="flex gap-1">
              <IconButton icon="edit" label="עריכת הפגישה" onClick={() => setModal({ row: m })} />
              <IconButton icon="trash" label="מחיקת הפגישה" onClick={async () => (await confirm({ title: "למחוק את הפגישה?", body: m.title })) && remove.mutate(m.id)} />
            </span>
          </div>
        ))}
        {sel?.deadlines.map((t) => <div key={t} className="row-line flex items-center gap-2 py-3 text-pink-soft"><Icon name="flag" size={16} />דדליין: {t}</div>)}
      </Card>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.row ? "עריכת פגישה" : "פגישה חדשה"}>
        <MeetingForm row={modal?.row} onDone={() => setModal(null)} />
      </Modal>
    </div>
  );
}
