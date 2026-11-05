import { useMemo, useState } from "react";
import {
  receiptUrl, useExpenses, useIncome, usePartners, useProjects, useRecurring, useRemove, useSave, useSettlements,
  type Expense, type Income, type RecurringCost,
} from "../lib/data";
import { date, money } from "../lib/format";
import { Button, Card, Empty, ErrorNote, Field, IconButton, Input, Loading, Modal, MonthSelect, Num, PageTitle, Segmented, Select, useConfirm } from "../components/ui";
import { ExpenseForm, IncomeForm, SettlementForm } from "../components/forms";

type Tab = "expenses" | "income" | "settlements" | "recurring";
const TABS: [Tab, string][] = [["expenses", "הוצאות"], ["income", "הכנסות"], ["settlements", "התחשבנויות"], ["recurring", "שוטפות"]];

export default function Money() {
  const [tab, setTab] = useState<Tab>("expenses");
  const [modal, setModal] = useState<null | { kind: Tab; row?: Expense | Income | RecurringCost }>(null);
  const close = () => setModal(null);

  return (
    <div>
      <PageTitle eyebrow="כספים" title="כל תנועה, ומי שילמה." action={
        <div className="flex flex-wrap gap-2">
          <Button arrow className="group" onClick={() => setModal({ kind: "expenses" })}>הוצאה</Button>
          <Button variant="ghost" onClick={() => setModal({ kind: "income" })}>הכנסה</Button>
          <Button variant="ghost" onClick={() => setModal({ kind: "settlements" })}>התחשבנות</Button>
        </div>
      } />

      <div className="mb-6"><Segmented label="סוג תנועה" value={tab} onChange={setTab} options={TABS} /></div>

      {tab === "expenses" && <ExpensesList onEdit={(row) => setModal({ kind: "expenses", row })} />}
      {tab === "income" && <IncomeList onEdit={(row) => setModal({ kind: "income", row })} />}
      {tab === "settlements" && <SettlementsList />}
      {tab === "recurring" && <RecurringList onEdit={(row) => setModal({ kind: "recurring", row })} onAdd={() => setModal({ kind: "recurring" })} />}

      <Modal open={modal?.kind === "expenses"} onClose={close} title={modal?.row ? "עריכת הוצאה" : "הוצאה חדשה"}>
        <ExpenseForm row={modal?.row as Expense | undefined} onDone={close} />
      </Modal>
      <Modal open={modal?.kind === "income"} onClose={close} title={modal?.row ? "עריכת הכנסה" : "הכנסה חדשה"}>
        <IncomeForm row={modal?.row as Income | undefined} onDone={close} />
      </Modal>
      <Modal open={modal?.kind === "settlements"} onClose={close} title="התחשבנות חדשה">
        <SettlementForm onDone={close} />
      </Modal>
      <Modal open={modal?.kind === "recurring"} onClose={close} title={modal?.row ? "עריכת עלות שוטפת" : "עלות שוטפת חדשה"}>
        <RecurringForm row={modal?.row as RecurringCost | undefined} onDone={close} />
      </Modal>
    </div>
  );
}

function Filters({ projectId, setProjectId, partnerId, setPartnerId, month, setMonth }: {
  projectId: string; setProjectId: (v: string) => void; partnerId: string; setPartnerId: (v: string) => void; month: string; setMonth: (v: string) => void;
}) {
  const projects = useProjects();
  const partners = usePartners();
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Select aria-label="פרויקט" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">כל הפרויקטים</option><option value="none">כללי לעסק</option>
        {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      <Select aria-label="שותפה" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
        <option value="">שתיהן</option>
        {partners.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      <div className="col-span-2 sm:col-span-1"><MonthSelect value={month} onChange={setMonth} /></div>
    </div>
  );
}

function ExpensesList({ onEdit }: { onEdit: (r: Expense) => void }) {
  const { data, isLoading, error } = useExpenses();
  const remove = useRemove("expenses");
  const confirm = useConfirm();
  const [projectId, setProjectId] = useState(""); const [partnerId, setPartnerId] = useState(""); const [month, setMonth] = useState("");
  const rows = useMemo(() => (data ?? []).filter((r) =>
    (!projectId || (projectId === "none" ? !r.project_id : r.project_id === projectId)) &&
    (!partnerId || r.paid_by_partner_id === partnerId) && (!month || r.spent_on.startsWith(month))), [data, projectId, partnerId, month]);
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;

  return (
    <Card>
      <Filters {...{ projectId, setProjectId, partnerId, setPartnerId, month, setMonth }} />
      <Total rows={rows} />
      {!rows.length && <Empty>אין הוצאות. אפשר להוסיף כאן או לשלוח לבוט צילום חשבונית.</Empty>}
      {rows.map((r) => (
        <Row key={r.id} date={r.spent_on} amount={r.amount} onEdit={() => onEdit(r)}
          title={r.description}
          meta={<>{r.projects?.name ?? "כללי"} · שילמה {r.partners?.name ?? "?"}{r.reference && <> · <Num>#{r.reference}</Num></>}</>}
          actions={<>
            {r.receipt_path && <IconButton icon="receipt" label="פתיחת הקבלה" onClick={async () => { const u = await receiptUrl(r.receipt_path!); if (u) window.open(u, "_blank"); }} />}
            <IconButton icon="trash" label="מחיקת ההוצאה" onClick={async () => (await confirm({ title: "למחוק את ההוצאה?", body: `${r.description}, ${money(r.amount)}` })) && remove.mutate(r.id)} />
          </>} />
      ))}
    </Card>
  );
}

function IncomeList({ onEdit }: { onEdit: (r: Income) => void }) {
  const { data, isLoading, error } = useIncome();
  const remove = useRemove("income");
  const confirm = useConfirm();
  const [projectId, setProjectId] = useState(""); const [partnerId, setPartnerId] = useState(""); const [month, setMonth] = useState("");
  const rows = useMemo(() => (data ?? []).filter((r) =>
    (!projectId || (projectId === "none" ? !r.project_id : r.project_id === projectId)) &&
    (!partnerId || r.received_by_partner_id === partnerId) && (!month || r.received_on.startsWith(month))), [data, projectId, partnerId, month]);
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  return (
    <Card>
      <Filters {...{ projectId, setProjectId, partnerId, setPartnerId, month, setMonth }} />
      <Total rows={rows} />
      {!rows.length && <Empty>עוד אין הכנסות רשומות.</Empty>}
      {rows.map((r) => (
        <Row key={r.id} date={r.received_on} amount={r.amount} positive onEdit={() => onEdit(r)}
          title={r.projects?.name ?? "בלי פרויקט"}
          meta={<>התקבל אצל {r.partners?.name ?? "?"}{r.method ? ` · ${r.method}` : ""}</>}
          actions={<IconButton icon="trash" label="מחיקת ההכנסה" onClick={async () => (await confirm({ title: "למחוק את ההכנסה?", body: money(r.amount) })) && remove.mutate(r.id)} />} />
      ))}
    </Card>
  );
}

function SettlementsList() {
  const { data, isLoading } = useSettlements();
  const partners = usePartners();
  const remove = useRemove("settlements");
  const confirm = useConfirm();
  const name = (id: string) => partners.data?.find((p) => p.id === id)?.name ?? "?";
  if (isLoading) return <Loading />;
  return (
    <Card>
      {!data?.length && <Empty>עוד לא נרשמו העברות ביניכן.</Empty>}
      {data?.map((r) => (
        <div key={r.id} className="row-line flex items-center justify-between gap-4 py-3">
          <span className="text-[14px] text-mute"><Num>{date(r.settled_on)}</Num></span>
          <span className="flex-1">{name(r.from_partner_id)} העבירה ל{name(r.to_partner_id)}{r.notes && <span className="text-mute"> · {r.notes}</span>}</span>
          <span className="font-medium"><Num>{money(r.amount)}</Num></span>
          <IconButton icon="trash" label="מחיקת ההתחשבנות" onClick={async () => (await confirm({ title: "למחוק את ההתחשבנות?", body: money(r.amount) })) && remove.mutate(r.id)} />
        </div>
      ))}
    </Card>
  );
}

function RecurringList({ onEdit, onAdd }: { onEdit: (r: RecurringCost) => void; onAdd: () => void }) {
  const { data, isLoading } = useRecurring();
  const partners = usePartners();
  if (isLoading) return <Loading />;
  const monthly = (data ?? []).filter((r) => r.active).reduce((s, r) => s + (r.frequency === "yearly" ? r.amount / 12 : Number(r.amount)), 0);
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-mute">סה״כ בחודש: <span className="text-bone"><Num>{money(monthly)}</Num></span></p>
        <Button variant="ghost" onClick={onAdd}>עלות שוטפת חדשה</Button>
      </div>
      <p className="mb-4 text-[14px] text-mute-2">זו רשימה לתכנון. כל תשלום בפועל נרשם כהוצאה רגילה, כדי שייכנס למאזן.</p>
      {!data?.length && <Empty>למשל מנויים ל-Supabase, Lovable, דומיינים.</Empty>}
      {data?.map((r) => (
        <button key={r.id} onClick={() => onEdit(r)} className={`row-line row-btn flex w-[calc(100%+20px)] items-center justify-between gap-4 py-3 text-start ${r.active ? "" : "opacity-50"}`}>
          <span className="flex-1">{r.name}<span className="text-mute"> · {r.frequency === "yearly" ? "שנתי" : "חודשי"} · משלמת {partners.data?.find((p) => p.id === r.paid_by_partner_id)?.name ?? "?"}</span></span>
          <span className="font-medium"><Num>{money(r.amount)}</Num></span>
        </button>
      ))}
    </Card>
  );
}

function RecurringForm({ row, onDone }: { row?: RecurringCost; onDone: () => void }) {
  const partners = usePartners();
  const save = useSave("recurring_costs");
  const [f, setF] = useState({
    name: row?.name ?? "", amount: row?.amount?.toString() ?? "", frequency: row?.frequency ?? "monthly",
    paid_by_partner_id: row?.paid_by_partner_id ?? "", active: row?.active ?? true,
  });
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      await save.mutateAsync({ id: row?.id, values: { ...f, amount: Number(f.amount), paid_by_partner_id: f.paid_by_partner_id || null } });
      onDone();
    }}>
      <div className="sm:col-span-2"><Field label="שם"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
      <Field label="סכום (₪)"><Input required type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      <Field label="תדירות">
        <Select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="monthly">חודשי</option><option value="yearly">שנתי</option></Select>
      </Field>
      <Field label="מי משלמת">
        <Select value={f.paid_by_partner_id} onChange={(e) => setF({ ...f, paid_by_partner_id: e.target.value })}>
          <option value="">בחרי</option>{partners.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </Field>
      <Field label="פעיל">
        <Select value={f.active ? "1" : "0"} onChange={(e) => setF({ ...f, active: e.target.value === "1" })}><option value="1">כן</option><option value="0">לא</option></Select>
      </Field>
      <div className="sm:col-span-2 flex gap-3">
        <Button arrow className="group" disabled={save.isPending}>שמירה</Button>
        <Button type="button" variant="quiet" onClick={onDone}>ביטול</Button>
      </div>
    </form>
  );
}

function Total({ rows }: { rows: { amount: number }[] }) {
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  return <p className="mb-2 text-[15px] text-mute"><Num>{rows.length}</Num> תנועות · סה״כ <span className="text-bone"><Num>{money(total)}</Num></span></p>;
}

// One money row: tap anywhere to edit; the receipt and delete stay as quiet icons at the end.
function Row({ date: d, title, meta, amount, positive, onEdit, actions }: {
  date: string; title: string; meta: React.ReactNode; amount: number; positive?: boolean; onEdit: () => void; actions: React.ReactNode;
}) {
  return (
    <div className="row-line flex items-center gap-2">
      <button onClick={onEdit} title="עריכה" className="row-btn grid min-w-0 flex-1 grid-cols-[1fr_auto] items-center gap-x-4 py-3 text-start sm:grid-cols-[78px_1fr_auto]">
        <span className="order-2 col-span-2 text-[13px] text-mute sm:order-none sm:col-span-1 sm:text-[14px]"><Num>{date(d)}</Num></span>
        <span className="min-w-0">
          <span className="block truncate">{title}</span>
          <span className="block truncate text-[14px] text-mute">{meta}</span>
        </span>
        <span className={`font-medium ${positive ? "text-pink-soft" : ""}`}><Num>{positive ? "+" : ""}{money(amount)}</Num></span>
      </button>
      <span className="flex shrink-0">{actions}</span>
    </div>
  );
}
