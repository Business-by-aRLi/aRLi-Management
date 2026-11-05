import { useState } from "react";
import { Link } from "react-router-dom";
import { useFinancials, useProjects, useSave } from "../lib/data";
import { money, PROJECT_STATUS, PROJECT_TYPE, today } from "../lib/format";
import { Button, Card, Field, Input, Loading, Modal, Num, PageTitle, Pill, Select } from "../components/ui";
import { supabase, must } from "../lib/supabase";

const GROUPS = [["client", "לקוחות"], ["business", "עסקי"], ["learning", "למידה"]] as const;

export default function Projects() {
  const projects = useProjects();
  const fin = useFinancials();
  const [adding, setAdding] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  if (projects.isLoading) return <Loading />;
  const f = (id: string) => fin.data?.find((x) => x.project_id === id);

  return (
    <div>
      <PageTitle eyebrow="פרויקטים" title="מה פתוח, ומה הוא מכניס." action={
        <div className="flex gap-2">
          <Button variant="quiet" onClick={() => setShowClosed(!showClosed)}>{showClosed ? "הסתרת סגורים" : "הצגת סגורים"}</Button>
          <Button arrow className="group" onClick={() => setAdding(true)}>פרויקט חדש</Button>
        </div>
      } />
      <div className="space-y-10">
        {GROUPS.map(([type, label]) => {
          const list = projects.data?.filter((p) => p.type === type && (showClosed || p.status !== "closed")) ?? [];
          if (!list.length) return null;
          return (
            <section key={type}>
              <h2 className="mb-3 text-[22px] font-semibold">{label}</h2>
              <Card>
                {list.map((p) => (
                  <Link key={p.id} to={`/projects/${p.id}`} className="row-line flex flex-wrap items-center justify-between gap-3 py-3 hover:text-pink-soft">
                    <span className="flex items-center gap-3">
                      <span className="font-medium">{p.name}</span>
                      {p.clients?.name && <span className="text-mute">· {p.clients.name}</span>}
                      <Pill tone={p.status === "active" ? "pink" : "mute"}>{PROJECT_STATUS[p.status]}</Pill>
                    </span>
                    <span className="text-[15px] text-mute">רווח <span className="text-bone"><Num>{money(f(p.id)?.profit)}</Num></span></span>
                  </Link>
                ))}
              </Card>
            </section>
          );
        })}
      </div>
      <Modal open={adding} onClose={() => setAdding(false)} title="פרויקט חדש"><NewProject onDone={() => setAdding(false)} /></Modal>
    </div>
  );
}

function NewProject({ onDone }: { onDone: () => void }) {
  const save = useSave("projects");
  const [f, setF] = useState({ name: "", type: "client", client: "", agreed_price: "" });
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      let client_id: string | null = null;
      if (f.client.trim()) {
        const found = must(await supabase.from("clients").select("id").ilike("name", f.client.trim()).maybeSingle()) as { id: string } | null;
        client_id = found?.id ?? (must(await supabase.from("clients").insert({ name: f.client.trim() }).select("id").single()) as { id: string }).id;
      }
      await save.mutateAsync({ values: { name: f.name, type: f.type, client_id, agreed_price: f.agreed_price ? Number(f.agreed_price) : null, started_on: today() } });
      onDone();
    }}>
      <div className="sm:col-span-2"><Field label="שם"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
      <Field label="סוג">
        <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {Object.entries(PROJECT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <Field label="לקוח" hint="לקוח חדש ייווצר אוטומטית"><Input value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} /></Field>
      <Field label="מחיר מוסכם (₪)"><Input type="number" value={f.agreed_price} onChange={(e) => setF({ ...f, agreed_price: e.target.value })} /></Field>
      <div className="sm:col-span-2 flex gap-3">
        <Button arrow className="group" disabled={save.isPending}>יצירה</Button>
        <Button type="button" variant="quiet" onClick={onDone}>ביטול</Button>
      </div>
      <p className="sm:col-span-2 text-[14px] text-mute-2">חלוקת הרווח מתחילה בחצי-חצי, ואפשר לשנות אותה בדף הפרויקט.</p>
    </form>
  );
}
