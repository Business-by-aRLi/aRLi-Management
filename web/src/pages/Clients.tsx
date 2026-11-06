import { useState } from "react";
import { Link } from "react-router-dom";
import { useClients, useFinancials, useProjects, useSave, type Client, type Financials, type Project } from "../lib/data";
import { isArchived, money } from "../lib/format";
import { Button, Empty, Field, Input, Loading, Modal, Num, PageTitle, SearchInput, Textarea } from "../components/ui";
import { Icon } from "../components/icons";

// What a client has paid and what is still open, from the projects linked to them.
export function clientTotals(clientId: string, projects: Project[], fin: Financials[]) {
  const mine = projects.filter((p) => p.client_id === clientId);
  let paid = 0, open = 0;
  for (const p of mine) {
    const inc = Number(fin.find((f) => f.project_id === p.id)?.income ?? 0);
    paid += inc;
    if (p.agreed_price != null && !isArchived(p.status)) open += Math.max(0, Number(p.agreed_price) - inc);
  }
  return { projects: mine, active: mine.filter((p) => !isArchived(p.status)).length, paid, open };
}

export default function Clients() {
  const clients = useClients();
  const projects = useProjects();
  const fin = useFinancials();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  if (clients.isLoading) return <Loading />;

  const q = query.trim().toLowerCase();
  const list = (clients.data ?? []).filter((c) => !q || [c.name, c.contact_name, c.email, c.phone].some((v) => v?.toLowerCase().includes(q)));

  return (
    <div>
      <PageTitle eyebrow="לקוחות" title="עם מי אנחנו יוצרות." action={
        <Button arrow className="group" onClick={() => setAdding(true)}>לקוח חדש</Button>
      } />
      <div className="mb-6"><SearchInput value={query} onChange={setQuery} placeholder="חיפוש לפי שם, איש קשר או טלפון" /></div>

      {!list.length ? <Empty>{clients.data?.length ? "אין לקוחות שמתאימים לחיפוש." : "עוד אין לקוחות. מוסיפים כאן, או ביצירת פרויקט."}</Empty> : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => <ClientCard key={c.id} c={c} t={clientTotals(c.id, projects.data ?? [], fin.data ?? [])} />)}
        </div>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="לקוח חדש"><ClientForm onDone={() => setAdding(false)} /></Modal>
    </div>
  );
}

function ClientCard({ c, t }: { c: Client; t: ReturnType<typeof clientTotals> }) {
  return (
    <div className="bezel lift group relative">
      <div className="core flex flex-col gap-4">
        <div>
          {/* The name's link covers the whole card; the phone and mail links sit above it */}
          <Link to={`/clients/${c.id}`} className="text-[24px] font-semibold leading-tight transition-colors after:absolute after:inset-0 after:rounded-[var(--radius-box)] group-hover:text-pink-soft">{c.name}</Link>
          <p className="mt-0.5 text-[15px] text-mute">{c.contact_name ?? " "}</p>
        </div>
        {(c.phone || c.email) && (
          <div className="relative z-10 flex flex-wrap gap-2">
            {c.phone && <ContactLink href={`tel:${c.phone}`} icon="phone"><Num>{c.phone}</Num></ContactLink>}
            {c.email && <ContactLink href={`mailto:${c.email}`} icon="mail">{c.email}</ContactLink>}
          </div>
        )}
        <div className="mt-auto grid grid-cols-3 gap-2 text-[14px] text-mute shadow-[inset_0_1px_0_var(--line)]">
          <span className="pt-3">פרויקטים<br /><Num className="text-[16px] text-bone">{t.projects.length}</Num></span>
          <span className="pt-3">שולם<br /><Num className="text-[16px] text-bone">{money(t.paid)}</Num></span>
          <span className="pt-3">נשאר לגבות<br /><Num className={`text-[16px] ${t.open > 0 ? "text-pink-soft" : "text-bone"}`}>{money(t.open)}</Num></span>
        </div>
      </div>
    </div>
  );
}

export function ContactLink({ href, icon, children }: { href: string; icon: "phone" | "mail"; children: React.ReactNode }) {
  return (
    <a href={href} className="press inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-3 py-1 text-[14px] text-bone/85 shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-[var(--hover-veil)]">
      <Icon name={icon} size={15} className="shrink-0 text-mute" /><span className="truncate">{children}</span>
    </a>
  );
}

export function ClientForm({ client, onDone }: { client?: Client; onDone?: () => void }) {
  const save = useSave("clients");
  const [f, setF] = useState({
    name: client?.name ?? "", contact_name: client?.contact_name ?? "", phone: client?.phone ?? "", email: client?.email ?? "", notes: client?.notes ?? "",
  });
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      setError("");
      const values = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]));
      try { await save.mutateAsync({ id: client?.id, values }); onDone?.(); }
      catch (err) { setError(/duplicate|unique/i.test((err as Error).message) ? "כבר יש לקוח בשם הזה." : (err as Error).message); }
    }}>
      <Field label="שם הלקוח"><Input required value={f.name} onChange={set("name")} /></Field>
      <Field label="איש/אשת קשר"><Input value={f.contact_name} onChange={set("contact_name")} /></Field>
      <Field label="טלפון"><Input type="tel" dir="ltr" className="text-start" value={f.phone} onChange={set("phone")} /></Field>
      <Field label="מייל"><Input type="email" dir="ltr" className="text-start" value={f.email} onChange={set("email")} /></Field>
      <div className="sm:col-span-2"><Field label="הערות"><Textarea value={f.notes} onChange={set("notes")} /></Field></div>
      {error && <p className="sm:col-span-2 text-[14px] text-error">{error}</p>}
      <div className="sm:col-span-2 flex gap-3">
        {client ? <Button variant="ghost" disabled={save.isPending}>{save.isSuccess ? "נשמר" : "שמירה"}</Button>
          : <Button arrow className="group" disabled={save.isPending}>הוספה</Button>}
        {onDone && <Button type="button" variant="quiet" onClick={onDone}>ביטול</Button>}
      </div>
    </form>
  );
}
