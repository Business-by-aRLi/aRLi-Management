// Add/edit forms. Each form gets an optional existing row; without one it creates a new row.
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { today } from "../lib/format";
import { uploadReceipt, usePartners, useProjects, useSave, useWorkPlans, type Expense, type Income, type Task, type Meeting } from "../lib/data";
import { Button, Field, Input, Select, Textarea } from "./ui";

// The partner who is signed in, used as the default payer/receiver/assignee.
export function useMe() {
  const partners = usePartners();
  const user = useQuery({ queryKey: ["user"], queryFn: async () => (await supabase.auth.getUser()).data.user });
  return partners.data?.find((p) => p.user_id === user.data?.id) ?? null;
}

function PartnerSelect({ value, onChange, allowNone }: { value: string; onChange: (v: string) => void; allowNone?: string }) {
  const partners = usePartners();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">{allowNone}</option>}
      {partners.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
  );
}

function ProjectSelect({ value, onChange, none = "כללי לעסק (חצי-חצי)" }: { value: string; onChange: (v: string) => void; none?: string }) {
  const projects = useProjects();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {projects.data?.filter((p) => p.status !== "closed" || p.id === value).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </Select>
  );
}

function Actions({ pending, error, onCancel }: { pending: boolean; error: unknown; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-2">
      <Button arrow className="group" disabled={pending}>{pending ? "שומרת…" : "שמירה"}</Button>
      <Button type="button" variant="quiet" onClick={onCancel}>ביטול</Button>
      {!!error && <span className="text-[14px] text-error">{(error as Error).message}</span>}
    </div>
  );
}

const nullIfEmpty = (v: string) => (v === "" ? null : v);

type ExpenseFields = { amount: string; description: string; spent_on: string; project_id: string; paid_by_partner_id: string; category: string; reference: string; notes: string };
type IncomeFields = { amount: string; received_on: string; project_id: string; received_by_partner_id: string; method: string; reference: string; notes: string };

// `initial` prefills a new row (from a parsed document); `receiptPath` is a document that is already uploaded;
// `onCancel` runs instead of onDone when the partner cancels (so an unused upload can be removed).
export function ExpenseForm({ row, onDone, initial, receiptPath, onCancel }: {
  row?: Expense; onDone: () => void; initial?: Partial<ExpenseFields>; receiptPath?: string; onCancel?: () => void;
}) {
  const me = useMe();
  const save = useSave("expenses");
  const [f, setF] = useState<ExpenseFields>({
    amount: row?.amount?.toString() ?? "", description: row?.description ?? "", spent_on: row?.spent_on ?? today(),
    project_id: row?.project_id ?? "", paid_by_partner_id: row?.paid_by_partner_id ?? "", category: row?.category ?? "",
    reference: row?.reference ?? "", notes: row?.notes ?? "", ...initial,
  });
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => { if (!f.paid_by_partner_id && me) setF((s) => ({ ...s, paid_by_partner_id: me.id })); }, [me]);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const receipt_path = file ? await uploadReceipt(file) : receiptPath ?? row?.receipt_path ?? null;
    await save.mutateAsync({
      id: row?.id,
      values: {
        amount: Number(f.amount), description: f.description, spent_on: f.spent_on, project_id: nullIfEmpty(f.project_id),
        paid_by_partner_id: f.paid_by_partner_id, category: nullIfEmpty(f.category), reference: nullIfEmpty(f.reference),
        notes: nullIfEmpty(f.notes), receipt_path,
      },
    });
    onDone();
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="סכום (₪)"><Input required type="number" step="0.01" min="0.01" inputMode="decimal" value={f.amount} onChange={(e) => set("amount")(e.target.value)} /></Field>
      <Field label="תאריך"><Input required type="date" value={f.spent_on} onChange={(e) => set("spent_on")(e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="על מה"><Input required value={f.description} onChange={(e) => set("description")(e.target.value)} /></Field></div>
      <Field label="פרויקט"><ProjectSelect value={f.project_id} onChange={set("project_id")} /></Field>
      <Field label="מי שילמה"><PartnerSelect value={f.paid_by_partner_id} onChange={set("paid_by_partner_id")} /></Field>
      <Field label="קטגוריה"><Input value={f.category} onChange={(e) => set("category")(e.target.value)} placeholder="תוכנה, ציוד, נסיעות…" /></Field>
      <Field label="אסמכתה"><Input value={f.reference} onChange={(e) => set("reference")(e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="הערות"><Input value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field></div>
      {!receiptPath && <div className="sm:col-span-2"><ReceiptInput hasExisting={!!row?.receipt_path} file={file} setFile={setFile} /></div>}
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onCancel ?? onDone} /></div>
    </form>
  );
}

export function IncomeForm({ row, onDone, initial, receiptPath, onCancel }: {
  row?: Income; onDone: () => void; initial?: Partial<IncomeFields>; receiptPath?: string; onCancel?: () => void;
}) {
  const me = useMe();
  const projects = useProjects();
  const save = useSave("income");
  const [f, setF] = useState<IncomeFields>({
    amount: row?.amount?.toString() ?? "", received_on: row?.received_on ?? today(), project_id: row?.project_id ?? "",
    received_by_partner_id: row?.received_by_partner_id ?? "", method: row?.method ?? "", reference: row?.reference ?? "",
    notes: row?.notes ?? "", ...initial,
  });
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => { if (!f.received_by_partner_id && me) setF((s) => ({ ...s, received_by_partner_id: me.id })); }, [me]);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const client_id = projects.data?.find((p) => p.id === f.project_id)?.client_id ?? null;
    const receipt_path = file ? await uploadReceipt(file) : receiptPath ?? row?.receipt_path ?? null;
    await save.mutateAsync({
      id: row?.id,
      values: {
        amount: Number(f.amount), received_on: f.received_on, project_id: nullIfEmpty(f.project_id), client_id,
        received_by_partner_id: f.received_by_partner_id, method: nullIfEmpty(f.method), reference: nullIfEmpty(f.reference),
        notes: nullIfEmpty(f.notes), receipt_path,
      },
    });
    onDone();
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="סכום (₪)"><Input required type="number" step="0.01" min="0.01" inputMode="decimal" value={f.amount} onChange={(e) => set("amount")(e.target.value)} /></Field>
      <Field label="תאריך"><Input required type="date" value={f.received_on} onChange={(e) => set("received_on")(e.target.value)} /></Field>
      <Field label="פרויקט"><ProjectSelect value={f.project_id} onChange={set("project_id")} none="בלי פרויקט" /></Field>
      <Field label="מי קיבלה"><PartnerSelect value={f.received_by_partner_id} onChange={set("received_by_partner_id")} /></Field>
      <Field label="אמצעי תשלום"><Input value={f.method} onChange={(e) => set("method")(e.target.value)} placeholder="העברה, ביט, צ׳ק…" /></Field>
      <Field label="אסמכתה"><Input value={f.reference} onChange={(e) => set("reference")(e.target.value)} /></Field>
      <Field label="הערות"><Input value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field>
      {!receiptPath && <div className="sm:col-span-2"><ReceiptInput hasExisting={!!row?.receipt_path} file={file} setFile={setFile} label="מסמך" /></div>}
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onCancel ?? onDone} /></div>
    </form>
  );
}

function ReceiptInput({ hasExisting, file, setFile, label = "קבלה" }: { hasExisting: boolean; file: File | null; setFile: (f: File | null) => void; label?: string }) {
  return (
    <Field label={label} hint={hasExisting && !file ? "כבר יש מסמך מצורף. בחירת קובץ חדש תחליף אותו." : "תמונה או PDF"}>
      <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[14px] text-mute file:me-3 file:rounded-full file:border-0 file:bg-[var(--ink-3)] file:px-4 file:py-2 file:text-bone" />
    </Field>
  );
}

export function SettlementForm({ from, to, amount, onDone }: { from?: string; to?: string; amount?: number; onDone: () => void }) {
  const save = useSave("settlements");
  const [f, setF] = useState({ amount: amount ? amount.toFixed(2) : "", from_partner_id: from ?? "", to_partner_id: to ?? "", settled_on: today(), notes: "" });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.mutateAsync({ values: { ...f, amount: Number(f.amount), notes: nullIfEmpty(f.notes) } });
    onDone();
  }
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="ממי"><PartnerSelect value={f.from_partner_id} onChange={set("from_partner_id")} allowNone="בחרי" /></Field>
      <Field label="למי"><PartnerSelect value={f.to_partner_id} onChange={set("to_partner_id")} allowNone="בחרי" /></Field>
      <Field label="סכום (₪)"><Input required type="number" step="0.01" min="0.01" value={f.amount} onChange={(e) => set("amount")(e.target.value)} /></Field>
      <Field label="תאריך"><Input required type="date" value={f.settled_on} onChange={(e) => set("settled_on")(e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="הערות"><Input value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field></div>
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onDone} /></div>
    </form>
  );
}

export function TaskForm({ row, projectId, startOn, onDone }: { row?: Task; projectId?: string; startOn?: string; onDone: () => void }) {
  const save = useSave("tasks");
  const plans = useWorkPlans();
  const [f, setF] = useState({
    title: row?.title ?? "", description: row?.description ?? "", project_id: row?.project_id ?? projectId ?? "",
    assignee_partner_id: row?.assignee_partner_id ?? "", due_on: row?.due_on ?? "", priority: String(row?.priority ?? 2),
    start_on: row?.start_on ?? startOn ?? "", work_plan_id: row?.work_plan_id ?? "",
  });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.mutateAsync({
      id: row?.id,
      values: {
        title: f.title, description: nullIfEmpty(f.description), project_id: nullIfEmpty(f.project_id),
        assignee_partner_id: nullIfEmpty(f.assignee_partner_id), due_on: nullIfEmpty(f.due_on), priority: Number(f.priority),
        start_on: nullIfEmpty(f.start_on), work_plan_id: nullIfEmpty(f.work_plan_id),
        ...(row && f.due_on !== row.due_on ? { reminded_on: null } : {}),
      },
    });
    onDone();
  }
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="משימה"><Input required value={f.title} onChange={(e) => set("title")(e.target.value)} /></Field></div>
      <Field label="פרויקט"><ProjectSelect value={f.project_id} onChange={set("project_id")} none="בלי פרויקט" /></Field>
      <Field label="אחראית"><PartnerSelect value={f.assignee_partner_id} onChange={set("assignee_partner_id")} allowNone="שתינו" /></Field>
      <Field label="מתחילה"><Input type="date" value={f.start_on} onChange={(e) => set("start_on")(e.target.value)} /></Field>
      <Field label="דדליין"><Input type="date" value={f.due_on} onChange={(e) => set("due_on")(e.target.value)} /></Field>
      <Field label="שייכת ליעד">
        <Select value={f.work_plan_id} onChange={(e) => set("work_plan_id")(e.target.value)}>
          <option value="">בלי יעד</option>
          {plans.data?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </Select>
      </Field>
      <Field label="עדיפות">
        <Select value={f.priority} onChange={(e) => set("priority")(e.target.value)}>
          <option value="1">גבוהה</option><option value="2">רגילה</option><option value="3">נמוכה</option>
        </Select>
      </Field>
      <div className="sm:col-span-2"><Field label="פירוט"><Textarea value={f.description} onChange={(e) => set("description")(e.target.value)} /></Field></div>
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onDone} /></div>
    </form>
  );
}

// datetime-local works in the browser's own time zone, which for both partners is Israel.
const toLocalInput = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

export function MeetingForm({ row, onDone }: { row?: Meeting & { project_id?: string | null; notes?: string | null }; onDone: () => void }) {
  const me = useMe();
  const save = useSave("meetings");
  const [f, setF] = useState({
    title: row?.title ?? "", starts_at: toLocalInput(row?.starts_at), ends_at: toLocalInput(row?.ends_at),
    location: row?.location ?? "", project_id: row?.project_id ?? "", notes: row?.notes ?? "",
  });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.mutateAsync({
      id: row?.id,
      values: {
        title: f.title, starts_at: new Date(f.starts_at).toISOString(), ends_at: f.ends_at ? new Date(f.ends_at).toISOString() : null,
        location: nullIfEmpty(f.location), project_id: nullIfEmpty(f.project_id), notes: nullIfEmpty(f.notes),
        ...(row ? { reminded_at: null } : { created_by_partner_id: me?.id ?? null }),
      },
    });
    onDone();
  }
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="כותרת"><Input required value={f.title} onChange={(e) => set("title")(e.target.value)} /></Field></div>
      <Field label="מתחילה"><Input required type="datetime-local" value={f.starts_at} onChange={(e) => set("starts_at")(e.target.value)} /></Field>
      <Field label="נגמרת"><Input type="datetime-local" value={f.ends_at} onChange={(e) => set("ends_at")(e.target.value)} /></Field>
      <Field label="מקום / קישור"><Input value={f.location} onChange={(e) => set("location")(e.target.value)} /></Field>
      <Field label="פרויקט"><ProjectSelect value={f.project_id} onChange={set("project_id")} none="בלי פרויקט" /></Field>
      <div className="sm:col-span-2"><Field label="הערות"><Textarea value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field></div>
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onDone} /></div>
    </form>
  );
}

export function TimeForm({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const save = useSave("time_entries");
  const [f, setF] = useState({ hours: "", project_id: "", kind: "work", work_date: today(), description: "", partner_id: "" });
  useEffect(() => { if (!f.partner_id && me) setF((s) => ({ ...s, partner_id: me.id })); }, [me]);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.mutateAsync({
      values: {
        minutes: Math.round(Number(f.hours) * 60), project_id: nullIfEmpty(f.project_id), kind: f.kind,
        work_date: f.work_date, description: nullIfEmpty(f.description), partner_id: f.partner_id,
      },
    });
    onDone();
  }
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="שעות"><Input required type="number" step="0.25" min="0.25" inputMode="decimal" value={f.hours} onChange={(e) => set("hours")(e.target.value)} /></Field>
      <Field label="תאריך"><Input required type="date" value={f.work_date} onChange={(e) => set("work_date")(e.target.value)} /></Field>
      <Field label="פרויקט"><ProjectSelect value={f.project_id} onChange={set("project_id")} none="כללי" /></Field>
      <Field label="סוג">
        <Select value={f.kind} onChange={(e) => set("kind")(e.target.value)}><option value="work">עבודה</option><option value="learning">למידה</option></Select>
      </Field>
      <Field label="מי"><PartnerSelect value={f.partner_id} onChange={set("partner_id")} /></Field>
      <Field label="מה עשיתי"><Input value={f.description} onChange={(e) => set("description")(e.target.value)} /></Field>
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onDone} /></div>
    </form>
  );
}

export function PlanForm({ row, onDone }: { row?: { id: string; title: string; period_start: string | null; period_end: string | null; goals: string | null }; onDone: () => void }) {
  const save = useSave("work_plans");
  const now = new Date();
  const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const qEnd = new Date(qStart.getFullYear(), qStart.getMonth() + 3, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const [f, setF] = useState({
    title: row?.title ?? "", period_start: row?.period_start ?? iso(qStart), period_end: row?.period_end ?? iso(qEnd), goals: row?.goals ?? "",
  });
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      await save.mutateAsync({ id: row?.id, values: { ...f, goals: nullIfEmpty(f.goals) } });
      onDone();
    }}>
      <div className="sm:col-span-2"><Field label="היעד"><Input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="למשל: 3 לקוחות חדשים עד סוף הרבעון" /></Field></div>
      <Field label="מ־"><Input type="date" value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })} /></Field>
      <Field label="עד"><Input type="date" value={f.period_end} onChange={(e) => setF({ ...f, period_end: e.target.value })} /></Field>
      <div className="sm:col-span-2"><Field label="למה זה חשוב, ואיך נדע שהצלחנו"><Textarea value={f.goals} onChange={(e) => setF({ ...f, goals: e.target.value })} /></Field></div>
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onDone} /></div>
    </form>
  );
}
