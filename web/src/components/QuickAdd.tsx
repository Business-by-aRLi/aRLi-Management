// One "+" for everything: pick what to add, then the right form opens in the same dialog.
import { useState } from "react";
import { useSave } from "../lib/data";
import { Icon, type IconName } from "./icons";
import { Button, Field, Input, Modal } from "./ui";
import { ExpenseForm, IncomeForm, MeetingForm, TaskForm, TimeForm, useMe } from "./forms";
import { today } from "../lib/format";

type Kind = "task" | "expense" | "income" | "time" | "meeting" | "idea";
const KINDS: [Kind, string, IconName][] = [
  ["task", "משימה", "tasks"], ["expense", "הוצאה", "expense"], ["income", "הכנסה", "income"],
  ["time", "שעות", "time"], ["meeting", "פגישה", "meeting"], ["idea", "רעיון", "idea"],
];
const TITLES: Record<Kind, string> = { task: "משימה חדשה", expense: "הוצאה חדשה", income: "הכנסה חדשה", time: "דיווח שעות", meeting: "פגישה חדשה", idea: "רעיון חדש" };

export function QuickAdd({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const close = () => { setKind(null); onClose(); };
  return (
    <Modal open={open} onClose={close} title={kind ? TITLES[kind] : "מה מוסיפים?"}>
      {!kind && (
        <div className="grid grid-cols-3 gap-2">
          {KINDS.map(([k, label, icon]) => (
            <button key={k} onClick={() => setKind(k)}
              className="press lift flex flex-col items-center gap-2 rounded-[18px] bg-[var(--ink-3)] px-2 py-5 text-[15px] font-medium shadow-[inset_0_0_0_1px_var(--line)] hover:text-pink-soft">
              <span className="grid size-11 place-items-center rounded-full bg-pink/15 text-pink-soft"><Icon name={icon} size={22} /></span>
              {label}
            </button>
          ))}
        </div>
      )}
      {kind === "task" && <TaskForm startOn={today()} onDone={close} />}
      {kind === "expense" && <ExpenseForm onDone={close} />}
      {kind === "income" && <IncomeForm onDone={close} />}
      {kind === "time" && <TimeForm onDone={close} />}
      {kind === "meeting" && <MeetingForm onDone={close} />}
      {kind === "idea" && <IdeaForm onDone={close} />}
    </Modal>
  );
}

function IdeaForm({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const save = useSave("ideas");
  const [title, setTitle] = useState("");
  return (
    <form className="grid gap-4" onSubmit={async (e) => {
      e.preventDefault();
      if (!title.trim()) return;
      await save.mutateAsync({ values: { title: title.trim(), created_by_partner_id: me?.id ?? null } });
      onDone();
    }}>
      <Field label="מה הרעיון?" hint="גם חצי רעיון נחשב. אפשר לפתח אותו אחר כך."><Input required value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <div className="flex gap-3"><Button arrow className="group" disabled={save.isPending}>שמירה</Button><Button type="button" variant="quiet" onClick={onDone}>ביטול</Button></div>
    </form>
  );
}
