import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useFinancials, useProjects, useSave, useTasks, useTime, type Financials, type Project } from "../lib/data";
import { hours, money, PROJECT_STATUS, PROJECT_TAG, today } from "../lib/format";
import { Button, Empty, Field, Input, Loading, Modal, Num, PageTitle, Pill, Progress, SearchInput, Segmented, Select, Tag } from "../components/ui";
import { ClientPicker, resolveClient, type ClientChoice } from "../components/ClientPicker";

type StatusFilter = "open" | "closed" | "all";
const STATUS_ORDER: Record<string, number> = { active: 0, paused: 1, closed: 2 };

export default function Projects() {
  const projects = useProjects();
  const fin = useFinancials();
  const tasks = useTasks();
  const time = useTime();
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("open");
  const [tag, setTag] = useState("");
  const [query, setQuery] = useState("");

  const byStatus = useMemo(() => (projects.data ?? []).filter((p) =>
    status === "all" ? true : status === "closed" ? p.status === "closed" : p.status !== "closed"), [projects.data, status]);
  if (projects.isLoading) return <Loading />;

  const q = query.trim().toLowerCase();
  const list = byStatus
    .filter((p) => !tag || p.type === tag)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.clients?.name?.toLowerCase().includes(q))
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.name.localeCompare(b.name, "he"));
  const count = (t: string) => byStatus.filter((p) => p.type === t).length;
  const openTasks = (id: string) => tasks.data?.filter((t) => t.project_id === id && t.status !== "done").length ?? 0;
  const minutes = (id: string) => (time.data ?? []).filter((t) => t.project_id === id).reduce((s, t) => s + t.minutes, 0);

  return (
    <div>
      <PageTitle eyebrow="פרויקטים" title="מה אנחנו בונות עכשיו." action={
        <Button arrow className="group" onClick={() => setAdding(true)}>פרויקט חדש</Button>
      } />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <SearchInput value={query} onChange={setQuery} placeholder="חיפוש פרויקט או לקוח" />
        <Segmented label="סטטוס" value={status} onChange={setStatus} options={[["open", "פתוחים"], ["closed", "סגורים"], ["all", "הכל"]]} />
        <div className="flex flex-wrap gap-2" role="group" aria-label="סינון לפי תגית">
          <TagChip active={!tag} onClick={() => setTag("")}>הכל <Num className="text-mute">{byStatus.length}</Num></TagChip>
          {Object.entries(PROJECT_TAG).map(([k, v]) => count(k) > 0 && (
            <TagChip key={k} active={tag === k} onClick={() => setTag(tag === k ? "" : k)}>{v} <Num className="text-mute">{count(k)}</Num></TagChip>
          ))}
        </div>
      </div>

      {!list.length ? <Empty>אין פרויקטים שמתאימים לחיפוש.</Empty> : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((p) => (
            <ProjectCard key={p.id} p={p} f={fin.data?.find((x) => x.project_id === p.id)} tasks={openTasks(p.id)} minutes={minutes(p.id)} />
          ))}
        </div>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="פרויקט חדש"><NewProject onDone={() => setAdding(false)} /></Modal>
    </div>
  );
}

function TagChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={`press inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[15px] font-medium transition-colors duration-300 ${active ? "bg-pink/15 text-pink-soft shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--pink)_35%,transparent)]" : "text-mute shadow-[inset_0_0_0_1px_var(--line)] hover:text-bone"}`}>
      {children}
    </button>
  );
}

export function ProjectCard({ p, f, tasks, minutes }: { p: Project; f?: Financials; tasks: number; minutes: number }) {
  const income = Number(f?.income ?? 0);
  const price = p.agreed_price != null ? Number(p.agreed_price) : null;
  return (
    <Link to={`/projects/${p.id}`} className={`bezel lift group block ${p.status === "closed" ? "opacity-60" : ""}`}>
      <div className="core flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <Tag type={p.type} label={PROJECT_TAG[p.type] ?? p.type} />
          {p.status !== "active" && <Pill>{PROJECT_STATUS[p.status]}</Pill>}
        </div>
        <div>
          <h2 className="text-[24px] font-semibold leading-tight transition-colors group-hover:text-pink-soft">{p.name}</h2>
          <p className="mt-0.5 text-[15px] text-mute">{p.clients?.name ?? "בלי לקוח"}</p>
        </div>
        {price != null && price > 0 && (
          <div className="grid gap-1.5">
            <Progress value={income} max={price} />
            <p className="text-[14px] text-mute">נגבו <Num className="text-bone">{money(income)}</Num> מתוך <Num>{money(price)}</Num></p>
          </div>
        )}
        <div className="mt-auto grid grid-cols-3 gap-2 pt-1 text-[14px] text-mute shadow-[inset_0_1px_0_var(--line)]">
          <span className="pt-3">רווח<br /><Num className="text-[16px] text-bone">{money(f?.profit)}</Num></span>
          <span className="pt-3">משימות<br /><Num className="text-[16px] text-bone">{tasks}</Num></span>
          <span className="pt-3">זמן<br /><Num className="text-[16px] text-bone">{hours(minutes)}</Num></span>
        </div>
      </div>
    </Link>
  );
}

export function NewProject({ onDone, onCancel, clientId, name = "", type = "client" }: { onDone: () => void; onCancel?: () => void; clientId?: string; name?: string; type?: string }) {
  const save = useSave("projects");
  const [f, setF] = useState({ name, type, agreed_price: "" });
  const [client, setClient] = useState<ClientChoice>({ id: clientId ?? "", newName: "" });
  const [error, setError] = useState("");
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      setError("");
      try {
        const client_id = await resolveClient(client);
        await save.mutateAsync({ values: { name: f.name.trim(), type: f.type, client_id, agreed_price: f.agreed_price ? Number(f.agreed_price) : null, started_on: today() } });
        onDone();
      } catch (err) { setError((err as Error).message); }
    }}>
      <div className="sm:col-span-2"><Field label="שם"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
      <Field label="תגית">
        <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {Object.entries(PROJECT_TAG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <Field label="לקוח"><ClientPicker value={client} onChange={setClient} /></Field>
      <Field label="מחיר מוסכם (₪)"><Input type="number" inputMode="decimal" value={f.agreed_price} onChange={(e) => setF({ ...f, agreed_price: e.target.value })} /></Field>
      {error && <p className="sm:col-span-2 text-[14px] text-error">{error}</p>}
      <div className="sm:col-span-2 flex gap-3">
        <Button arrow className="group" disabled={save.isPending}>יצירה</Button>
        <Button type="button" variant="quiet" onClick={onCancel ?? onDone}>ביטול</Button>
      </div>
      <p className="sm:col-span-2 text-[14px] text-mute-2">חלוקת הרווח מתחילה בחצי-חצי, ואפשר לשנות אותה בדף הפרויקט.</p>
    </form>
  );
}
