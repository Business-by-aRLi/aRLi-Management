import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useClients, useFinancials, useIncome, useProjects, useRemove, useTasks, useTime } from "../lib/data";
import { date, money } from "../lib/format";
import { Button, Card, Eyebrow, Loading, Modal, Num, useConfirm } from "../components/ui";
import { ClientForm, clientTotals, ContactLink } from "./Clients";
import { NewProject, ProjectCard } from "./Projects";

export default function ClientPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const clients = useClients();
  const projects = useProjects();
  const fin = useFinancials();
  const income = useIncome();
  const tasks = useTasks();
  const time = useTime();
  const remove = useRemove("clients");
  const [adding, setAdding] = useState(false);
  const c = clients.data?.find((x) => x.id === id);
  if (clients.isLoading || projects.isLoading) return <Loading />;
  if (!c) return <p className="text-mute">הלקוח לא נמצא.</p>;

  const t = clientTotals(c.id, projects.data ?? [], fin.data ?? []);
  const ids = new Set(t.projects.map((p) => p.id));
  const payments = (income.data ?? []).filter((i) => (i.project_id && ids.has(i.project_id)) || i.client_id === c.id);

  return (
    <div className="space-y-10">
      <header>
        <Link to="/clients" className="text-[15px] text-mute hover:text-bone">→ לקוחות</Link>
        <Eyebrow>{c.contact_name ? `איש קשר: ${c.contact_name}` : "לקוח"}</Eyebrow>
        <h1 className="mt-1 text-[clamp(34px,5.2vw,80px)] font-semibold leading-[1.05] tracking-[-0.02em]">{c.name}</h1>
        {(c.phone || c.email) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {c.phone && <ContactLink href={`tel:${c.phone}`} icon="phone"><Num>{c.phone}</Num></ContactLink>}
            {c.email && <ContactLink href={`mailto:${c.email}`} icon="mail">{c.email}</ContactLink>}
          </div>
        )}
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="פרויקטים פעילים" value={String(t.active)} />
        <Stat label="שולם עד היום" value={money(t.paid)} />
        <Stat label="נשאר לגבות" value={money(t.open)} />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-[22px] font-semibold">פרויקטים</h2>
          <Button variant="ghost" onClick={() => setAdding(true)}>פרויקט חדש ללקוח</Button>
        </div>
        {!t.projects.length ? <Card><p className="text-mute">עוד אין פרויקטים ללקוח הזה.</p></Card> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {t.projects.map((p) => (
              <ProjectCard key={p.id} p={p} f={fin.data?.find((x) => x.project_id === p.id)}
                tasks={tasks.data?.filter((x) => x.project_id === p.id && x.status !== "done").length ?? 0}
                minutes={(time.data ?? []).filter((x) => x.project_id === p.id).reduce((s, x) => s + x.minutes, 0)} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-[22px] font-semibold">תשלומים</h2>
          {!payments.length && <p className="text-mute">עוד לא התקבלו תשלומים.</p>}
          {payments.map((i) => (
            <div key={i.id} className="row-line flex justify-between gap-3 py-2.5">
              <span>{i.projects?.name ?? "כללי"} <span className="text-mute">· {i.partners?.name ? `אצל ${i.partners.name}` : "לעסק"} · <Num>{date(i.received_on)}</Num></span></span>
              <Num>{money(i.amount)}</Num>
            </div>
          ))}
        </Card>
        <Card>
          <h2 className="mb-5 text-[22px] font-semibold">פרטי הלקוח</h2>
          <ClientForm key={c.id} client={c} />
          <button className="mt-6 text-[14px] text-mute hover:text-error" onClick={async () => {
            const ok = await confirm({
              title: `למחוק את ${c.name}?`,
              body: t.projects.length ? `הפרויקטים שלו (${t.projects.length}) יישארו, רק בלי לקוח.` : undefined,
            });
            if (ok) { await remove.mutateAsync(c.id); nav("/clients"); }
          }}>מחיקת הלקוח</button>
        </Card>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title={`פרויקט חדש ל${c.name}`}>
        <NewProject clientId={c.id} onDone={() => setAdding(false)} />
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-[clamp(26px,2.4vw,36px)] font-light text-pink"><Num>{value}</Num></div>
      <div className="text-mute">{label}</div>
    </Card>
  );
}
