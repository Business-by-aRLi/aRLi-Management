// Pickers that can also create what is missing, right where you are: pick a project or goal from the list,
// or choose "+ חדש…", type a name, and it is created on the spot and selected, without leaving the form.
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjects, useWorkPlans } from "../lib/data";
import { must, supabase } from "../lib/supabase";
import { isArchived, PROJECT_TAG, today } from "../lib/format";
import { Button, Input, Select } from "./ui";

const NEW = "__new";

function CreatableSelect({ label, value, onChange, options, none, addLabel, placeholder, onCreate, extra }: {
  label: string; value: string; onChange: (id: string) => void; options: { id: string; name: string }[];
  none?: string; addLabel: string; placeholder: string; onCreate: (name: string) => Promise<string>; extra?: ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    if (!name.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      const id = await onCreate(name.trim());
      onChange(id);
      setAdding(false);
      setName("");
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  if (!adding) {
    return (
      <Select aria-label={label} value={value} onChange={(e) => (e.target.value === NEW ? setAdding(true) : onChange(e.target.value))}>
        {none !== undefined && <option value="">{none}</option>}
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        <option value={NEW}>{addLabel}</option>
      </Select>
    );
  }
  // Not a <form>: it sits inside the outer form. Enter creates instead of submitting the outer form,
  // and the name is required, so the outer form cannot be saved while a half-typed new item is open.
  return (
    <div className="grid gap-2 rounded-[14px] p-3 shadow-[inset_0_0_0_1px_var(--line-2)]">
      <Input autoFocus required aria-label={placeholder} placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } }} />
      {extra}
      <div className="flex items-center gap-2">
        <Button type="button" className="!px-4 !py-1.5 text-[14px]" disabled={pending || !name.trim()} onClick={create}>{pending ? "יוצרת…" : "יצירה"}</Button>
        <Button type="button" variant="quiet" className="!px-3 !py-1.5 text-[14px]" onClick={() => { setAdding(false); setName(""); setError(""); }}>ביטול</Button>
        {error && <span className="text-[13px] text-error">{error}</span>}
      </div>
    </div>
  );
}

// `only` limits the list (a client's projects); a project created here is linked to `clientId`.
export function ProjectPicker({ value, onChange, none = "כללי לעסק (חצי-חצי)", only, clientId }: {
  value: string; onChange: (id: string) => void; none?: string; only?: string[]; clientId?: string;
}) {
  const qc = useQueryClient();
  const projects = useProjects();
  const [type, setType] = useState("client");
  const options = (projects.data ?? []).filter((p) => (!isArchived(p.status) && (!only || only.includes(p.id))) || p.id === value);
  return (
    <CreatableSelect label="פרויקט" value={value} onChange={onChange} options={options} none={none}
      addLabel="+ פרויקט חדש…" placeholder="שם הפרויקט"
      extra={
        <Select aria-label="תגית" value={type} onChange={(e) => setType(e.target.value)}>
          {Object.entries(PROJECT_TAG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      }
      onCreate={async (name) => {
        const row = must(await supabase.from("projects").insert({ name, type, client_id: clientId ?? null, started_on: today() }).select("id").single()) as { id: string };
        await qc.invalidateQueries({ queryKey: ["projects"] });
        void qc.invalidateQueries({ queryKey: ["financials"] });
        return row.id;
      }} />
  );
}

export function currentQuarter() {
  const now = new Date();
  const start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: iso(start), end: iso(end) };
}

export function PlanPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const qc = useQueryClient();
  const plans = useWorkPlans();
  const t = today();
  const options = (plans.data ?? []).filter((p) => !p.period_end || p.period_end >= t || p.id === value).map((p) => ({ id: p.id, name: p.title }));
  return (
    <CreatableSelect label="יעד" value={value} onChange={onChange} options={options} none="בלי יעד"
      addLabel="+ יעד חדש…" placeholder="היעד, למשל 3 לקוחות חדשים"
      onCreate={async (title) => {
        const q = currentQuarter();
        const row = must(await supabase.from("work_plans").insert({ title, period_start: q.start, period_end: q.end }).select("id").single()) as { id: string };
        await qc.invalidateQueries({ queryKey: ["work_plans"] });
        return row.id;
      }} />
  );
}
