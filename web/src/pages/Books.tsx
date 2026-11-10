// Mini bookkeeping for an עוסק מורשה: the VAT report per period, input VAT on expenses, documents from
// Yesh Invoice, VAT and מקדמות paid, and one file for the accountant.
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  receiptUrl, useExpenses, useInvoiceSync, usePartners, useRemove, useSalesDocuments, useSave, useSaveTaxProfile,
  useTaxPayments, useTaxProfile, type Expense, type SalesDocument, type TaxKind, type TaxPayment, type TaxProfile,
} from "../lib/data";
import { date, money, today } from "../lib/format";
import {
  allocationThreshold, claimable, DOC_NAME, expenseVat, periodLabel, periodOf, periods, r2, reportCsv, vatReport,
  type BookExpense, type VatReport,
} from "../lib/vat";
import { Button, Card, Empty, ErrorNote, Field, IconButton, Input, Loading, Modal, Num, PageTitle, Pill, Segmented, Select, useConfirm } from "../components/ui";
import { ExpenseForm, useMe } from "../components/forms";

type Tab = "period" | "sales" | "payments" | "settings";
const TABS: [Tab, string][] = [["period", "דוח תקופתי"], ["sales", "מסמכי מכירה"], ["payments", "תשלומים"], ["settings", "הגדרות ומדריך"]];
const KIND: Record<TaxKind, string> = { vat: "מע״מ", income_tax_advance: "מקדמת מס הכנסה", national_insurance: "ביטוח לאומי" };

export default function Books() {
  const profile = useTaxProfile();
  const sync = useInvoiceSync();
  const [tab, setTab] = useState<Tab>("period");
  if (profile.isLoading) return <Loading />;
  if (profile.error) return <ErrorNote error={profile.error} />;
  const p = profile.data;
  return (
    <div>
      <PageTitle eyebrow="הנהלת חשבונות" title="מע״מ, מקדמות, וסדר לרו״ח." action={
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" disabled={sync.isPending} onClick={() => sync.mutate({})}>{sync.isPending ? "מסנכרנת…" : "סנכרון מיש חשבונית"}</Button>
          {sync.data?.report && <span className="text-[14px] text-mute">{sync.data.report}</span>}
          {sync.error && <span className="text-[14px] text-error">{(sync.error as Error).message}</span>}
        </div>
      } />
      {!p ? <Card><Empty>עוד לא הוגדר תיק מע״מ. צריך להריץ את קובץ ה-SQL של הנהלת החשבונות.</Empty></Card> : <>
        <div className="mb-6"><Segmented label="מסך" value={tab} onChange={setTab} options={TABS} /></div>
        {tab === "period" && <PeriodView p={p} />}
        {tab === "sales" && <SalesView p={p} />}
        {tab === "payments" && <PaymentsView p={p} />}
        {tab === "settings" && <SettingsView p={p} />}
      </>}
    </div>
  );
}

function PeriodSelect({ p, value, onChange }: { p: TaxProfile; value: string; onChange: (v: string) => void }) {
  return (
    <Select aria-label="תקופת דיווח" value={value} onChange={(e) => onChange(e.target.value)} className="!w-auto">
      {periods(p, today()).map((s) => <option key={s} value={s}>{periodLabel(s, p)}</option>)}
    </Select>
  );
}

function PeriodView({ p }: { p: TaxProfile }) {
  const sales = useSalesDocuments(), expenses = useExpenses(), payments = useTaxPayments(), partners = usePartners();
  const [start, setStart] = useState(() => periodOf(today(), p) < p.licensed_from ? periodOf(p.licensed_from, p) : periodOf(today(), p));
  const [editing, setEditing] = useState<Expense | null>(null);
  const [paying, setPaying] = useState<null | { kind: TaxKind; amount: number }>(null);
  const r = useMemo(() => vatReport(start, p, sales.data ?? [], expenses.data ?? []), [start, p, sales.data, expenses.data]);
  if (sales.isLoading || expenses.isLoading) return <Loading />;
  if (sales.error || expenses.error) return <ErrorNote error={sales.error ?? expenses.error} />;
  const paid = (kind: TaxKind) => (payments.data ?? []).filter((x) => x.kind === kind && x.period_start === start);
  const name = (id: string | null) => partners.data?.find((x) => x.id === id)?.name ?? "";
  const open = r.due >= today();

  function exportCsv() {
    const blob = new Blob([reportCsv(r, p, name)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `aRLi-מעמ-${r.start.slice(0, 7)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PeriodSelect p={p} value={start} onChange={setStart} />
        <Button variant="ghost" onClick={exportCsv}>קובץ לרו״ח (Excel)</Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <p className="text-mute">{r.toPay >= 0 ? "מע״מ לתשלום" : "מע״מ להחזר"} · {periodLabel(start, p)}</p>
          <p className="mt-1 text-[clamp(34px,4vw,52px)] font-semibold leading-none"><Num>{money(Math.abs(r.toPay))}</Num></p>
          <p className="mt-3 text-[15px] text-mute">
            {paid("vat").length ? <>דווח ושולם <Num>{date(paid("vat")[0].paid_on)}</Num>{paid("vat")[0].reference && <> · אישור <Num>{paid("vat")[0].reference}</Num></>}</>
              : <>לדווח ולשלם עד <Num className="text-bone">{date(r.due)}</Num>{!open && <span className="text-pink"> · עבר המועד</span>}</>}
          </p>
          <div className="mt-6 grid gap-0">
            <Line label="עסקאות חייבות (לפני מע״מ)" value={r.taxableNet} />
            <Line label="מע״מ עסקאות" value={r.outputVat} strong />
            {r.exemptNet > 0 && <Line label="עסקאות פטורות / בשיעור אפס" value={r.exemptNet} />}
            <Line label="מע״מ תשומות ציוד" value={-r.inputAssets} />
            <Line label="מע״מ תשומות אחרות" value={-r.inputOther} />
            <Line label={r.toPay >= 0 ? "לתשלום" : "להחזר"} value={Math.abs(r.toPay)} strong />
          </div>
          {!paid("vat").length && <Button className="mt-6" onClick={() => setPaying({ kind: "vat", amount: r.toPay })}>דיווחתי ושילמתי</Button>}
        </Card>

        <Card>
          <p className="text-mute">מקדמת מס הכנסה</p>
          {r.advance != null ? <>
            <p className="mt-1 text-[clamp(28px,3vw,40px)] font-semibold leading-none"><Num>{money(r.advance)}</Num></p>
            <p className="mt-3 text-[15px] text-mute"><Num>{p.advance_rate}%</Num> מהמחזור (<Num>{money(r.turnover)}</Num> לפני מע״מ). משלמים יחד עם דוח המע״מ.</p>
            {paid("income_tax_advance").length
              ? <p className="mt-3 text-[15px]">שולם <Num>{date(paid("income_tax_advance")[0].paid_on)}</Num></p>
              : <Button variant="ghost" className="mt-5" onClick={() => setPaying({ kind: "income_tax_advance", amount: r.advance! })}>רישום תשלום מקדמה</Button>}
          </> : <p className="mt-3 text-[15px] text-mute">את אחוז המקדמות קובע מס הכנסה במכתב לעוסק (או באזור האישי). מכניסים אותו בהגדרות, והסכום יחושב כאן מהמחזור. מחזור התקופה: <Num className="text-bone">{money(r.turnover)}</Num>.</p>}
        </Card>
      </div>

      <Checks r={r} p={p} onEdit={setEditing} />

      <Card>
        <h2 className="mb-1 text-[20px] font-semibold">הוצאות התקופה</h2>
        <p className="mb-4 text-[14px] text-mute-2">מע״מ מקזזים רק מחשבונית מס על שם העסק. אפשר לקזז עד חצי שנה אחרי תאריך החשבונית, כך שחשבונית שנשכחה עוברת לתקופה הבאה.</p>
        {!r.expenses.length && <Empty>אין הוצאות בתקופה הזו.</Empty>}
        {r.expenses.map((e) => <ExpenseRow key={e.id} e={e} rate={Number(p.vat_rate)} onEdit={() => setEditing(e)} />)}
      </Card>

      <SalesList docs={r.sales} p={p} title="מסמכי מכירה בתקופה" empty="אין חשבוניות מס בתקופה הזו. הן נכנסות מיש חשבונית כל 3 שעות." />

      <Modal open={!!editing} onClose={() => setEditing(null)} title="עריכת הוצאה">
        {editing && <ExpenseForm row={editing} onDone={() => setEditing(null)} />}
      </Modal>
      <Modal open={!!paying} onClose={() => setPaying(null)} title={paying ? `תשלום ${KIND[paying.kind]}` : ""}>
        {paying && <PaymentForm p={p} initial={{ kind: paying.kind, period_start: start, amount: paying.amount }} onDone={() => setPaying(null)} />}
      </Modal>
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={`row-line flex items-center justify-between gap-4 py-2.5 ${strong ? "font-semibold" : "text-mute"}`}>
      <span>{label}</span><Num className={strong ? "text-bone" : ""}>{money(value || 0)}</Num>
    </div>
  );
}

// What still needs a look before the report: expenses not checked, big invoices with no allocation number, no file.
function Checks({ r, p, onEdit }: { r: VatReport; p: TaxProfile; onEdit: (e: Expense) => void }) {
  const save = useSave("expenses");
  const rate = Number(p.vat_rate);
  if (!r.unchecked.length && !r.noAllocation.length && !r.noFile.length) {
    return r.expenses.length ? <Card><p className="flex items-center gap-2"><Pill tone="pink">מוכן</Pill> כל ההוצאות של התקופה נבדקו.</p></Card> : null;
  }
  const quick = (e: Expense, vat_doc: "tax_invoice" | "no_vat") => save.mutate({ id: e.id, values: {
    vat_doc, vat_amount: vat_doc === "no_vat" ? 0 : e.vat_amount ?? r2(Number(e.amount) * rate / (100 + rate)),
  } });
  return (
    <Card>
      <h2 className="mb-1 text-[20px] font-semibold">לבדיקה לפני הדוח</h2>
      {!!r.unchecked.length && <>
        <p className="mb-2 mt-3 text-[15px] text-mute">יש להן חשבונית מס על שם העסק? <Num>{r.unchecked.length}</Num> הוצאות</p>
        {r.unchecked.map((e) => (
          <div key={e.id} className="row-line flex flex-wrap items-center gap-2 py-2.5">
            <button className="row-btn min-w-0 flex-1 text-start" onClick={() => onEdit(e)}>
              <span className="block truncate">{e.vendor ? `${e.vendor} · ` : ""}{e.description}</span>
              <span className="text-[14px] text-mute"><Num>{date(e.spent_on)}</Num> · <Num>{money(e.amount)}</Num></span>
            </button>
            <Button variant="ghost" className="!px-4 !py-1.5 text-[14px]" onClick={() => quick(e, "tax_invoice")}>חשבונית מס</Button>
            <Button variant="quiet" onClick={() => quick(e, "no_vat")}>בלי מע״מ</Button>
          </div>
        ))}
      </>}
      {!!r.noAllocation.length && <>
        <p className="mb-2 mt-5 text-[15px] text-mute">חסר מספר הקצאה (חשבונית מעל <Num>{money(allocationThreshold(r.start))}</Num> לפני מע״מ). בלעדיו המע״מ לא נספר בקיזוז. מבקשים מהספק.</p>
        {r.noAllocation.map((e) => <ExpenseRow key={e.id} e={e} rate={rate} onEdit={() => onEdit(e)} />)}
      </>}
      {!!r.noFile.length && <>
        <p className="mb-2 mt-5 text-[15px] text-mute">חשבונית מס בלי קובץ מצורף. רו״ח צריך את המקור.</p>
        {r.noFile.map((e) => <ExpenseRow key={e.id} e={e} rate={rate} onEdit={() => onEdit(e)} />)}
      </>}
    </Card>
  );
}

function ExpenseRow({ e, rate, onEdit }: { e: BookExpense; rate: number; onEdit: () => void }) {
  const vat = expenseVat(e, rate), claim = claimable(e, rate);
  return (
    <div className="row-line flex items-center gap-2">
      <button onClick={onEdit} className="row-btn grid min-w-0 flex-1 grid-cols-[1fr_auto] items-center gap-x-4 py-3 text-start sm:grid-cols-[78px_1fr_auto]">
        <span className="order-2 col-span-2 text-[13px] text-mute sm:order-none sm:col-span-1 sm:text-[14px]"><Num>{date(e.spent_on)}</Num></span>
        <span className="min-w-0">
          <span className="block truncate">{e.vendor ? `${e.vendor} · ` : ""}{e.description}</span>
          <span className="block truncate text-[14px] text-mute">
            {e.vat_doc === "tax_invoice" ? <>מע״מ <Num>{money(vat)}</Num>{claim !== vat && <> · לקיזוז <Num>{money(claim)}</Num></>}{e.is_asset && " · ציוד"}{e.allocationMissing && <span className="text-pink"> · חסר מספר הקצאה</span>}</>
              : e.vat_doc === "no_vat" ? "בלי מע״מ לקיזוז" : <span className="text-pink">לבדיקה</span>}
          </span>
        </span>
        <span className="font-medium"><Num>{money(e.amount)}</Num></span>
      </button>
      {e.receipt_path && <IconButton icon="receipt" label="פתיחת החשבונית" onClick={async () => { const u = await receiptUrl(e.receipt_path!); if (u) window.open(u, "_blank"); }} />}
    </div>
  );
}

function SalesList({ docs, p, title, empty }: { docs: SalesDocument[]; p: TaxProfile; title: string; empty: string }) {
  const [editing, setEditing] = useState<SalesDocument | null>(null);
  return (
    <Card>
      <h2 className="mb-4 text-[20px] font-semibold">{title}</h2>
      {!docs.length && <Empty>{empty}</Empty>}
      {docs.map((d) => (
        <div key={d.id} className="row-line flex items-center gap-2">
          <button onClick={() => setEditing(d)} title="תיקון המע״מ" className="row-btn grid min-w-0 flex-1 grid-cols-[1fr_auto] items-center gap-x-4 py-3 text-start sm:grid-cols-[78px_1fr_auto]">
            <span className="order-2 col-span-2 text-[13px] text-mute sm:order-none sm:col-span-1 sm:text-[14px]"><Num>{date(d.issued_on)}</Num></span>
            <span className="min-w-0">
              <span className="block truncate">{d.clients?.name ?? d.customer_name ?? "לקוח"}</span>
              <span className="block truncate text-[14px] text-mute">{DOC_NAME[d.doc_type] ?? "מסמך"} <Num>{d.doc_number}</Num>
                {d.doc_type === 6 ? " · המע״מ מדווח לפי חשבונית המס" : <> · מע״מ <Num>{money(d.vat)}</Num>{d.vat_manual && " (תוקן)"}</>}
                {d.issued_on < p.licensed_from && " · לפני עוסק מורשה"}</span>
            </span>
            <span className="font-medium"><Num>{money(d.total)}</Num></span>
          </button>
          {d.pdf_url && <IconButton icon="receipt" label="פתיחת המסמך ביש חשבונית" onClick={() => window.open(d.pdf_url!, "_blank", "noopener")} />}
        </div>
      ))}
      <Modal open={!!editing} onClose={() => setEditing(null)} title="מע״מ במסמך">
        {editing && <SalesVatForm d={editing} p={p} onDone={() => setEditing(null)} />}
      </Modal>
    </Card>
  );
}

// The sync estimates the VAT from the rate; a 0% document (a client abroad) or a different number is fixed here.
function SalesVatForm({ d, p, onDone }: { d: SalesDocument; p: TaxProfile; onDone: () => void }) {
  const save = useSave("sales_documents");
  const [vat, setVat] = useState(String(d.vat));
  const rate = Number(p.vat_rate);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.mutateAsync({ id: d.id, values: { vat: Number(vat) || 0, vat_manual: true } });
    onDone();
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <p className="text-mute">{DOC_NAME[d.doc_type]} <Num>{d.doc_number}</Num> · {d.customer_name} · סה״כ <Num>{money(d.total)}</Num></p>
      <Field label="מע״מ במסמך (₪)" hint="כמו שמופיע במסמך ביש חשבונית. הסנכרון לא ידרוס מספר שתוקן כאן.">
        <Input type="number" step="0.01" min="0" value={vat} onChange={(e) => setVat(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="quiet" onClick={() => setVat("0")}>0% (לקוח בחו״ל / פטור)</Button>
        <Button type="button" variant="quiet" onClick={() => setVat(String(r2(Number(d.total) * rate / (100 + rate))))}>{rate}% מתוך הסכום</Button>
      </div>
      <div className="flex gap-3"><Button arrow className="group" disabled={save.isPending}>שמירה</Button><Button type="button" variant="quiet" onClick={onDone}>ביטול</Button></div>
    </form>
  );
}

function SalesView({ p }: { p: TaxProfile }) {
  const sales = useSalesDocuments();
  const [type, setType] = useState("all");
  const [start, setStart] = useState("");
  if (sales.isLoading) return <Loading />;
  if (sales.error) return <ErrorNote error={sales.error} />;
  const docs = (sales.data ?? []).filter((d) => (type === "all" || String(d.doc_type) === type) && (!start || periodOf(d.issued_on, p) === start));
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-3">
        <Select aria-label="סוג מסמך" className="!w-auto" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">כל המסמכים</option><option value="8">חשבוניות מס</option><option value="9">חשבוניות מס קבלה</option><option value="6">קבלות</option>
        </Select>
        <Select aria-label="תקופה" className="!w-auto" value={start} onChange={(e) => setStart(e.target.value)}>
          <option value="">כל התקופות</option>
          {periods(p, today()).map((s) => <option key={s} value={s}>{periodLabel(s, p)}</option>)}
        </Select>
      </div>
      <SalesList docs={docs} p={p} title={`${docs.length} מסמכים`} empty="עוד לא נכנסו מסמכים מיש חשבונית. אפשר ללחוץ על סנכרון למעלה." />
    </div>
  );
}

function PaymentsView({ p }: { p: TaxProfile }) {
  const payments = useTaxPayments(), partners = usePartners();
  const remove = useRemove("tax_payments");
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  if (payments.isLoading) return <Loading />;
  const name = (id: string | null) => partners.data?.find((x) => x.id === id)?.name ?? "";
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[15px] text-mute-2">כל דוח ותשלום לרשויות: מע״מ, מקדמות מס הכנסה וביטוח לאומי.</p>
        <Button variant="ghost" onClick={() => setAdding(true)}>תשלום חדש</Button>
      </div>
      {!payments.data?.length && <Empty>עוד לא נרשמו תשלומים.</Empty>}
      {payments.data?.map((x) => (
        <div key={x.id} className="row-line flex items-center justify-between gap-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block">{KIND[x.kind]} · {periodLabel(x.period_start, p)}</span>
            <span className="block text-[14px] text-mute">{x.paid_on ? <>שולם <Num>{date(x.paid_on)}</Num></> : "לא שולם"}{x.paid_by_partner_id && ` · ${name(x.paid_by_partner_id)}`}{x.reference && <> · <Num>{x.reference}</Num></>}</span>
          </span>
          <span className="font-medium"><Num>{money(x.amount)}</Num></span>
          <IconButton icon="trash" label="מחיקת התשלום" onClick={async () => (await confirm({ title: "למחוק את התשלום?", body: `${KIND[x.kind]}, ${money(x.amount)}` })) && remove.mutate(x.id)} />
        </div>
      ))}
      <Modal open={adding} onClose={() => setAdding(false)} title="תשלום חדש">
        <PaymentForm p={p} onDone={() => setAdding(false)} />
      </Modal>
    </Card>
  );
}

function PaymentForm({ p, initial, onDone }: { p: TaxProfile; initial?: Partial<TaxPayment>; onDone: () => void }) {
  const me = useMe(), partners = usePartners();
  const save = useSave("tax_payments");
  const [f, setF] = useState({
    kind: (initial?.kind ?? "vat") as TaxKind, period_start: initial?.period_start ?? periodOf(today(), p),
    amount: initial?.amount != null ? String(initial.amount) : "", paid_on: today(), paid_by_partner_id: "", reference: "",
  });
  const payer = f.paid_by_partner_id || me?.id || "";
  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.mutateAsync({ values: { ...f, amount: Number(f.amount), paid_by_partner_id: payer || null, reference: f.reference.trim() || null } });
    onDone();
  }
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <Field label="מה">
        <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as TaxKind })}>
          {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      </Field>
      <Field label="תקופה">
        <Select value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })}>
          {periods(p, today()).map((s) => <option key={s} value={s}>{periodLabel(s, p)}</option>)}
        </Select>
      </Field>
      <Field label="סכום (₪)" hint="החזר מע״מ: סכום שלילי"><Input required type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      <Field label="תאריך תשלום"><Input type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} /></Field>
      <Field label="מי שילמה">
        <Select value={payer} onChange={(e) => setF({ ...f, paid_by_partner_id: e.target.value })}>
          {partners.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
      </Field>
      <Field label="מספר אישור"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
        <Button arrow className="group" disabled={save.isPending}>שמירה</Button>
        <Button type="button" variant="quiet" onClick={onDone}>ביטול</Button>
        {!!save.error && <span className="text-[14px] text-error">{(save.error as Error).message}</span>}
      </div>
    </form>
  );
}

function SettingsView({ p }: { p: TaxProfile }) {
  const partners = usePartners();
  const save = useSaveTaxProfile();
  const [f, setF] = useState({
    vat_status: p.vat_status, licensed_from: p.licensed_from, vat_rate: String(p.vat_rate), vat_period: p.vat_period,
    advance_rate: p.advance_rate?.toString() ?? "", owner_partner_id: p.owner_partner_id ?? "", vat_file_number: p.vat_file_number ?? "",
    accountant_name: p.accountant_name ?? "", accountant_email: p.accountant_email ?? "",
  });
  const [saved, setSaved] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await save.mutateAsync({
      ...f, vat_rate: Number(f.vat_rate) || 18, advance_rate: f.advance_rate === "" ? null : Number(f.advance_rate),
      owner_partner_id: f.owner_partner_id || null, vat_file_number: f.vat_file_number.trim() || null,
      accountant_name: f.accountant_name.trim() || null, accountant_email: f.accountant_email.trim() || null,
    });
    setSaved(true);
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setSaved(false); setF({ ...f, [k]: e.target.value }); };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <h2 className="mb-4 text-[20px] font-semibold">תיק העוסק</h2>
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <Field label="סטטוס">
            <Select value={f.vat_status} onChange={set("vat_status")}><option value="licensed">עוסק מורשה</option><option value="exempt">עוסק פטור</option></Select>
          </Field>
          <Field label="מורשה מתאריך"><Input type="date" required value={f.licensed_from} onChange={set("licensed_from")} /></Field>
          <Field label="דיווח מע״מ" hint="כמו שכתוב בתעודת עוסק מורשה">
            <Select value={f.vat_period} onChange={set("vat_period")}><option value="bimonthly">כל חודשיים</option><option value="monthly">כל חודש</option></Select>
          </Field>
          <Field label="שיעור מע״מ (%)"><Input type="number" step="0.01" value={f.vat_rate} onChange={set("vat_rate")} /></Field>
          <Field label="מקדמות מס הכנסה (% מהמחזור)" hint="מהמכתב של מס הכנסה. ריק = עוד לא נקבע"><Input type="number" step="0.01" min="0" value={f.advance_rate} onChange={set("advance_rate")} /></Field>
          <Field label="מספר עוסק"><Input inputMode="numeric" value={f.vat_file_number} onChange={set("vat_file_number")} /></Field>
          <Field label="התיק על שם">
            <Select value={f.owner_partner_id} onChange={set("owner_partner_id")}>
              <option value="">לא נבחר</option>{partners.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          <Field label="רו״ח / יועץ מס"><Input value={f.accountant_name} onChange={set("accountant_name")} /></Field>
          <div className="sm:col-span-2"><Field label="מייל של רו״ח"><Input type="email" dir="ltr" value={f.accountant_email} onChange={set("accountant_email")} /></Field></div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
            <Button arrow className="group" disabled={save.isPending}>שמירה</Button>
            {saved && <span className="text-[14px] text-mute">נשמר</span>}
            {!!save.error && <span className="text-[14px] text-error">{(save.error as Error).message}</span>}
          </div>
        </form>
      </Card>
      <Guide p={p} />
    </div>
  );
}

// The short version of what a small עוסק מורשה has to do. General guidance, the accountant has the last word.
function Guide({ p }: { p: TaxProfile }) {
  const items: [string, ReactNode][] = [
    ["כל הכנסה: חשבונית מס", "מעכשיו מוציאים ללקוח חשבונית מס, או חשבונית מס קבלה כשהכסף כבר התקבל. המחיר ללקוח עסקי הוא לפני מע״מ, ומוסיפים 18%. קבלה לבד כבר לא מספיקה."],
    ["דוח מע״מ", `${p.vat_period === "bimonthly" ? "כל חודשיים" : "כל חודש"}, עד ה-15 בחודש שאחרי התקופה (בדיווח מקוון יש בדרך כלל כמה ימים נוספים). מדווחים גם כשאין פעילות. משלמים את ההפרש בין המע״מ שגבינו למע״מ ששילמנו.`],
    ["קיזוז מע״מ על הוצאות", "רק מחשבונית מס על שם העסק ועם מספר העוסק. קבלה, עוסק פטור וספקים מחו״ל (Vercel, OpenAI, Google) לא נותנים מע״מ לקיזוז. אפשר לקזז עד חצי שנה מתאריך החשבונית."],
    ["מספר הקצאה", "חשבונית מעל 5,000 ₪ לפני מע״מ (מיוני 2026) צריכה מספר הקצאה מרשות המסים. בלעדיו הלקוח לא יכול לקזז, ואנחנו לא יכולות לקזז מספק. יש חשבונית מבקשת אותו לבד."],
    ["הוצאות מעורבות", "טלפון נייד ורכב: בדרך כלל שני שליש מהמע״מ, ורכב בשימוש מעורב רבע. כיבוד, מתנות והוצאות פרטיות: בלי קיזוז. בית כעסק: לפי החלק העסקי, בתיאום עם רו״ח."],
    ["מקדמות מס הכנסה", "אחוז קבוע מהמחזור שמס הכנסה קובע, משולם יחד עם דוח המע״מ. וגם ביטוח לאומי לעצמאית, מקדמה חודשית לפי הכנסה צפויה."],
    ["מה רו״ח צריך", "כל המסמכים שהוצאנו (יש חשבונית שומר), כל החשבוניות מספקים עם הקבצים, ותשלומי מע״מ ומקדמות. כאן: \"קובץ לרו״ח\" בכל תקופה, ואת המסמכים עצמם הוא יכול לקבל גם ישירות מיש חשבונית."],
    ["שתי שותפות, תיק אחד", "חשבונית מספק צריכה להיות על שם העוסק שבתיק, גם כשריקי משלמת מהחשבון שלה. אחרת המע״מ שבה לא ניתן לקיזוז."],
  ];
  return (
    <Card>
      <h2 className="mb-4 text-[20px] font-semibold">מה עוסק מורשה צריך לעשות</h2>
      <div className="grid gap-4">
        {items.map(([t, b]) => (
          <div key={t}>
            <p className="font-medium">{t}</p>
            <p className="mt-0.5 text-[15px] text-mute">{b}</p>
          </div>
        ))}
      </div>
      <p className="mt-5 text-[13px] text-mute-2">זה סיכום כללי לעסק קטן. בכל שאלה של מקרה מסוים, רו״ח קובע.</p>
    </Card>
  );
}
