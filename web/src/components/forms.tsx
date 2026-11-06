// Add/edit forms. Each form gets an optional existing row; without one it creates a new row.
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { today } from "../lib/format";
import { uploadReceipt, useExpenses, usePartners, useProjects, useSave, type Expense, type Income, type Task, type Meeting, type MeetingKind } from "../lib/data";
import { Button, Field, Input, Segmented, Select, Textarea } from "./ui";
import { currentQuarter, PlanPicker, ProjectPicker } from "./Pickers";

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
// `only`/`clientId` come from a client page: the project list is that client's projects, and a new one is linked to them.
export type Context = { only?: string[]; clientId?: string };

export function ExpenseForm({ row, onDone, initial, receiptPath, onCancel, context }: {
  row?: Expense; onDone: () => void; initial?: Partial<ExpenseFields>; receiptPath?: string; onCancel?: () => void; context?: Context;
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
      <Field label="פרויקט"><ProjectPicker value={f.project_id} onChange={set("project_id")} {...context} /></Field>
      <Field label="מי שילמה"><PartnerSelect value={f.paid_by_partner_id} onChange={set("paid_by_partner_id")} /></Field>
      <Field label="קטגוריה"><Input list="expense-categories" value={f.category} onChange={(e) => set("category")(e.target.value)} placeholder="תוכנה, ציוד, נסיעות…" /><CategoryList /></Field>
      <Field label="אסמכתה"><Input value={f.reference} onChange={(e) => set("reference")(e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="הערות"><Input value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field></div>
      {!receiptPath && <div className="sm:col-span-2"><ReceiptInput hasExisting={!!row?.receipt_path} file={file} setFile={setFile} /></div>}
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onCancel ?? onDone} /></div>
    </form>
  );
}

export function IncomeForm({ row, onDone, initial, receiptPath, onCancel, context }: {
  row?: Income; onDone: () => void; initial?: Partial<IncomeFields>; receiptPath?: string; onCancel?: () => void; context?: Context;
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
    // The payer is the project's client; without a project, the client page we came from (or the one already saved).
    const client_id = projects.data?.find((p) => p.id === f.project_id)?.client_id ?? context?.clientId ?? row?.client_id ?? null;
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
      <Field label="פרויקט"><ProjectPicker value={f.project_id} onChange={set("project_id")} none="בלי פרויקט" {...context} /></Field>
      <Field label="מי קיבלה"><PartnerSelect value={f.received_by_partner_id} onChange={set("received_by_partner_id")} /></Field>
      <Field label="אמצעי תשלום"><Input value={f.method} onChange={(e) => set("method")(e.target.value)} placeholder="העברה, ביט, צ׳ק…" /></Field>
      <Field label="אסמכתה"><Input value={f.reference} onChange={(e) => set("reference")(e.target.value)} /></Field>
      <Field label="הערות"><Input value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field>
      {!receiptPath && <div className="sm:col-span-2"><ReceiptInput hasExisting={!!row?.receipt_path} file={file} setFile={setFile} label="מסמך" /></div>}
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onCancel ?? onDone} /></div>
    </form>
  );
}

// The categories already in use, offered as suggestions; a new one is just typed.
function CategoryList() {
  const expenses = useExpenses();
  const cats = [...new Set((expenses.data ?? []).map((e) => e.category?.trim()).filter(Boolean))] as string[];
  return <datalist id="expense-categories">{cats.sort((a, b) => a.localeCompare(b, "he")).map((c) => <option key={c} value={c} />)}</datalist>;
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

export function TaskForm({ row, projectId, startOn, workPlanId, title, onDone, onCancel, context }: {
  row?: Task; projectId?: string; startOn?: string; workPlanId?: string; title?: string; onDone: () => void; onCancel?: () => void; context?: Context;
}) {
  const save = useSave("tasks");
  const me = useMe();
  const [f, setF] = useState({
    title: row?.title ?? title ?? "", description: row?.description ?? "", project_id: row?.project_id ?? projectId ?? "",
    assignee_partner_id: row?.assignee_partner_id ?? "", due_on: row?.due_on ?? "", priority: String(row?.priority ?? 2),
    start_on: row?.start_on ?? startOn ?? "", work_plan_id: row?.work_plan_id ?? workPlanId ?? "",
  });
  const [priv, setPriv] = useState(row?.is_private ?? false);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.mutateAsync({
      id: row?.id,
      values: {
        title: f.title, description: nullIfEmpty(f.description), project_id: nullIfEmpty(f.project_id),
        // A private task belongs to whoever marks it private; only she sees it.
        assignee_partner_id: priv ? (row?.is_private ? row.assignee_partner_id : me?.id ?? null) : nullIfEmpty(f.assignee_partner_id),
        is_private: priv, due_on: nullIfEmpty(f.due_on), priority: Number(f.priority),
        start_on: nullIfEmpty(f.start_on), work_plan_id: nullIfEmpty(f.work_plan_id),
        ...(row && f.due_on !== row.due_on ? { reminded_on: null } : {}),
      },
    });
    onDone();
  }
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="משימה"><Input required value={f.title} onChange={(e) => set("title")(e.target.value)} /></Field></div>
      <Field label="פרויקט"><ProjectPicker value={f.project_id} onChange={set("project_id")} none="בלי פרויקט" {...context} /></Field>
      {!priv && <Field label="אחראית"><PartnerSelect value={f.assignee_partner_id} onChange={set("assignee_partner_id")} allowNone="שתינו" /></Field>}
      <Field label="מתחילה"><Input type="date" value={f.start_on} onChange={(e) => set("start_on")(e.target.value)} /></Field>
      <Field label="דדליין"><Input type="date" value={f.due_on} onChange={(e) => set("due_on")(e.target.value)} /></Field>
      <Field label="שייכת ליעד"><PlanPicker value={f.work_plan_id} onChange={set("work_plan_id")} /></Field>
      <Field label="עדיפות">
        <Select value={f.priority} onChange={(e) => set("priority")(e.target.value)}>
          <option value="1">גבוהה</option><option value="2">רגילה</option><option value="3">נמוכה</option>
        </Select>
      </Field>
      <div className="sm:col-span-2"><Field label="פירוט"><Textarea value={f.description} onChange={(e) => set("description")(e.target.value)} /></Field></div>
      <label className="flex items-center gap-2 text-[15px] sm:col-span-2">
        <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="size-4 accent-[var(--pink)]" />
        משימה אישית, רק אני רואה אותה
      </label>
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onCancel ?? onDone} /></div>
    </form>
  );
}

// datetime-local works in the browser's own time zone, which for both partners is Israel.
const toLocalInput = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

const KIND_OPTIONS: [MeetingKind, string][] = [["meeting", "פגישה"], ["focus", "בלוק עבודה"], ["away", "לא זמינה"]];
const addHour = (local: string) => (local ? toLocalInput(new Date(new Date(local).getTime() + 3600e3).toISOString()) : "");

// What overlaps a time for the people taking part: events in the shared calendar and busy times from Google.
function useConflicts(startsLocal: string, endsLocal: string, partnerIds: string[], skipId?: string, allDay?: boolean) {
  const start = startsLocal && !allDay ? new Date(startsLocal).toISOString() : "";
  const end = start ? new Date(endsLocal || addHour(startsLocal)).toISOString() : "";
  const partners = usePartners();
  return useQuery({
    queryKey: ["conflicts", start, end, partnerIds.join(","), skipId],
    enabled: !!start && end > start,
    queryFn: async () => {
      const who = partnerIds.length ? partnerIds : (partners.data ?? []).map((p) => p.id);
      const [ev, busy] = await Promise.all([
        supabase.from("meetings").select("id,title,starts_at,ends_at,partner_ids,all_day").lt("starts_at", end)
          .gte("starts_at", new Date(new Date(start).getTime() - 864e5).toISOString()),
        supabase.from("partner_busy").select("partner_id,starts_at,ends_at").lt("starts_at", end).gt("ends_at", start),
      ]);
      const out: string[] = [];
      for (const m of (ev.data ?? []) as Meeting[]) {
        const mEnd = m.ends_at ?? new Date(new Date(m.starts_at).getTime() + 3600e3).toISOString();
        if (m.id === skipId || m.all_day || mEnd <= start) continue;
        if (m.partner_ids?.length && !m.partner_ids.some((x) => who.includes(x))) continue;
        out.push(`${m.title} (${new Date(m.starts_at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })})`);
      }
      for (const b of busy.data ?? []) {
        if (who.includes(b.partner_id)) out.push(`${partners.data?.find((p) => p.id === b.partner_id)?.name ?? ""} תפוסה ביומן האישי`);
      }
      return [...new Set(out)];
    },
  });
}

// One form for every calendar event. `startsAt`/`endsAt` (datetime-local text), `projectId`, `kind`, `taskId` and `title`
// prefill a new event: the slot picked in the calendar, the project page, a task being blocked into time.
export function MeetingForm({ row, onDone, startsAt, endsAt, projectId, context, kind, taskId, title, partnerIds }: {
  row?: Meeting; onDone: () => void; startsAt?: string; endsAt?: string; projectId?: string; context?: Context;
  kind?: MeetingKind; taskId?: string; title?: string; partnerIds?: string[];
}) {
  const me = useMe();
  const partners = usePartners();
  const save = useSave("meetings");
  const [f, setF] = useState({
    title: row?.title ?? title ?? "", starts_at: row ? toLocalInput(row.starts_at) : startsAt ?? "",
    ends_at: row ? toLocalInput(row.ends_at) : endsAt ?? (startsAt ? addHour(startsAt) : ""),
    location: row?.location ?? "", project_id: row?.project_id ?? projectId ?? "", notes: row?.notes ?? "",
    kind: (row?.kind ?? kind ?? "meeting") as MeetingKind,
  });
  // "" = both of us; otherwise one partner's id.
  const [who, setWho] = useState<string>(row ? (row.partner_ids?.length === 1 ? row.partner_ids[0] : "") : partnerIds?.length === 1 ? partnerIds[0] : "");
  useEffect(() => { if (!row && !partnerIds && f.kind !== "meeting" && !who && me) setWho(me.id); }, [f.kind, me]);
  const [allDay, setAllDay] = useState(row?.all_day ?? false);
  const [meet, setMeet] = useState(!!row?.meet_link || (!row && f.kind === "meeting"));
  const set = (k: keyof typeof f) => (v: string) => setF((s) => {
    const next = { ...s, [k]: v };
    // Moving the start keeps the length.
    if (k === "starts_at" && s.starts_at && s.ends_at && v) {
      next.ends_at = toLocalInput(new Date(new Date(v).getTime() + (new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime())).toISOString());
    } else if (k === "starts_at" && !s.ends_at) next.ends_at = addHour(v);
    return next;
  });
  const partnerList = who ? [who] : [];
  const conflicts = useConflicts(f.starts_at, f.ends_at, partnerList, row?.id, allDay);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const start = allDay ? new Date(`${f.starts_at.slice(0, 10)}T12:00`) : new Date(f.starts_at);
    const end = allDay ? new Date(`${(f.ends_at || f.starts_at).slice(0, 10)}T12:00`) : f.ends_at ? new Date(f.ends_at) : null;
    await save.mutateAsync({
      id: row?.id,
      values: {
        title: f.title, starts_at: start.toISOString(), ends_at: end ? end.toISOString() : null,
        location: nullIfEmpty(f.location), project_id: nullIfEmpty(f.project_id), notes: nullIfEmpty(f.notes),
        kind: f.kind, partner_ids: partnerList, all_day: allDay,
        want_meet: f.kind === "meeting" && meet && !row?.meet_link,
        ...(row ? { reminded_at: null, followed_up_at: null } : { created_by_partner_id: me?.id ?? null, task_id: taskId ?? null }),
      },
    });
    onDone();
  }
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Segmented label="סוג האירוע" value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={KIND_OPTIONS} />
      </div>
      <div className="sm:col-span-2"><Field label={f.kind === "focus" ? "על מה עובדים" : f.kind === "away" ? "למה (רק אתן רואות)" : "כותרת"}>
        <Input required value={f.title} placeholder={f.kind === "away" ? "חופש, רופא, אישי" : ""} onChange={(e) => set("title")(e.target.value)} />
      </Field></div>
      <Field label="מתחילה"><Input required type={allDay ? "date" : "datetime-local"} value={allDay ? f.starts_at.slice(0, 10) : f.starts_at}
        onChange={(e) => set("starts_at")(allDay ? `${e.target.value}T09:00` : e.target.value)} /></Field>
      <Field label="נגמרת"><Input type={allDay ? "date" : "datetime-local"} value={allDay ? f.ends_at.slice(0, 10) : f.ends_at}
        onChange={(e) => setF({ ...f, ends_at: allDay ? `${e.target.value}T10:00` : e.target.value })} /></Field>
      <label className="flex items-center gap-2 text-[15px] sm:col-span-2">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="size-4 accent-[var(--pink)]" />
        כל היום
      </label>
      <Field label="מי">
        <Select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">שתינו</option>
          {partners.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </Field>
      {f.kind !== "away" && <Field label="פרויקט"><ProjectPicker value={f.project_id} onChange={set("project_id")} none="בלי פרויקט" {...context} /></Field>}
      {f.kind === "meeting" && <>
        <Field label="מקום / קישור"><Input value={f.location} onChange={(e) => set("location")(e.target.value)} /></Field>
        <label className="flex items-center gap-2 self-end pb-3 text-[15px]">
          <input type="checkbox" checked={meet} disabled={!!row?.meet_link} onChange={(e) => setMeet(e.target.checked)} className="size-4 accent-[var(--pink)]" />
          {row?.meet_link ? "יש קישור Google Meet" : "ליצור קישור Google Meet"}
        </label>
      </>}
      <div className="sm:col-span-2"><Field label={f.kind === "meeting" ? "אג'נדה והערות" : "הערות"}><Textarea value={f.notes} onChange={(e) => set("notes")(e.target.value)} /></Field></div>
      {!!conflicts.data?.length && (
        <div className="rounded-[12px] bg-pink/10 px-4 py-3 text-[14px] text-pink-soft sm:col-span-2" role="status">
          חופף ל: {conflicts.data.join(" · ")}. אפשר לשמור בכל זאת.
        </div>
      )}
      <div className="sm:col-span-2"><Actions pending={save.isPending} error={save.error} onCancel={onDone} /></div>
    </form>
  );
}

export function TimeForm({ onDone, projectId, context }: { onDone: () => void; projectId?: string; context?: Context }) {
  const me = useMe();
  const save = useSave("time_entries");
  const [f, setF] = useState({ hours: "", project_id: projectId ?? "", kind: "work", work_date: today(), description: "", partner_id: "" });
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
      <Field label="פרויקט"><ProjectPicker value={f.project_id} onChange={set("project_id")} none="כללי" {...context} /></Field>
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
  const q = currentQuarter();
  const [f, setF] = useState({
    title: row?.title ?? "", period_start: row?.period_start ?? q.start, period_end: row?.period_end ?? q.end, goals: row?.goals ?? "",
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
