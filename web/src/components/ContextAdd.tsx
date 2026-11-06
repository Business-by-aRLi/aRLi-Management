// Add from where you are: on a project or client page, every new expense, payment, task, hours or meeting
// opens with that project (and client) already filled in.
import { useState } from "react";
import { today } from "../lib/format";
import { Icon, type IconName } from "./icons";
import { Modal } from "./ui";
import { ExpenseForm, IncomeForm, MeetingForm, TaskForm, TimeForm, type Context } from "./forms";
import { DocumentUpload } from "./DocumentUpload";

export type AddKind = "expense" | "income" | "task" | "time" | "meeting" | "document";
const KINDS: Record<AddKind, { label: string; icon: IconName; title: string }> = {
  income: { label: "תשלום", icon: "income", title: "תשלום שהתקבל" },
  expense: { label: "הוצאה", icon: "expense", title: "הוצאה חדשה" },
  document: { label: "מסמך", icon: "receipt", title: "העלאת מסמך" },
  task: { label: "משימה", icon: "tasks", title: "משימה חדשה" },
  time: { label: "שעות", icon: "time", title: "דיווח שעות" },
  meeting: { label: "פגישה", icon: "meeting", title: "פגישה חדשה" },
};

// `projectId` is preselected; `context` (client pages) narrows the project list to that client's projects.
export function useContextAdd({ projectId, context, name }: { projectId?: string; context?: Context; name: string }) {
  const [kind, setKind] = useState<AddKind | null>(null);
  const close = () => setKind(null);
  const pid = projectId ?? "";
  const modal = (
    <Modal open={!!kind} onClose={close} title={kind ? `${KINDS[kind].title} · ${name}` : ""}>
      {kind === "expense" && <ExpenseForm onDone={close} initial={{ project_id: pid }} context={context} />}
      {kind === "income" && <IncomeForm onDone={close} initial={{ project_id: pid }} context={context} />}
      {kind === "task" && <TaskForm onDone={close} projectId={pid} startOn={today()} context={context} />}
      {kind === "time" && <TimeForm onDone={close} projectId={pid} context={context} />}
      {kind === "meeting" && <MeetingForm onDone={close} projectId={pid} context={context} />}
      {kind === "document" && <DocumentUpload onDone={close} projectId={projectId} context={context} />}
    </Modal>
  );
  return { open: setKind, modal };
}

// A row of small "+ X" chips under a page header.
export function AddChips({ kinds, onAdd }: { kinds: AddKind[]; onAdd: (k: AddKind) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="הוספה מהירה">
      {kinds.map((k) => (
        <button key={k} type="button" onClick={() => onAdd(k)}
          className="press inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[15px] font-medium text-bone/90 shadow-[inset_0_0_0_1px_var(--line-2)] transition-colors duration-300 hover:bg-[var(--hover-veil)] hover:text-pink-soft">
          <Icon name="plus" size={15} className="text-pink" />
          {KINDS[k].label}
        </button>
      ))}
    </div>
  );
}

// The small "+" at the end of a section heading (expenses, payments, tasks).
export function SectionAdd({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="press inline-flex items-center gap-1 text-[15px] text-pink hover:text-pink-soft">
      <Icon name="plus" size={16} />{label}
    </button>
  );
}
