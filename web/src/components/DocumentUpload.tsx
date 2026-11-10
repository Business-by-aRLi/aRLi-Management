// "Upload a document": drop an invoice / receipt (image or PDF), the system reads it,
// and the partner confirms or edits a prefilled expense or income form before saving.
import { useEffect, useRef, useState, type DragEvent } from "react";
import { deleteReceipt, parseDocument, uploadReceipt, type ParsedDocument } from "../lib/data";
import { date, money } from "../lib/format";
import { ExpenseForm, IncomeForm, type Context } from "./forms";
import { Segmented } from "./ui";

const MAX_MB = 15;
const isDate = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);

type State =
  | { step: "pick"; error?: string }
  | { step: "reading"; file: File; url: string }
  | { step: "review"; file: File; url: string; path: string; parsed: ParsedDocument | null; error?: string };

// `projectId` comes from the page it was opened on (a project page), and wins over the project the reader guessed.
export function DocumentUpload({ onDone, projectId, context }: { onDone: () => void; projectId?: string; context?: Context }) {
  const [state, setState] = useState<State>({ step: "pick" });
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // An uploaded file that was never saved with a record is removed when the window closes.
  const pending = useRef<string | null>(null);
  const preview = useRef<string | null>(null);
  useEffect(() => () => {
    if (pending.current) void deleteReceipt(pending.current);
    if (preview.current) URL.revokeObjectURL(preview.current);
  }, []);

  async function handle(file?: File | null) {
    if (!file) return;
    if (!/^(image\/|application\/pdf)/.test(file.type)) return setState({ step: "pick", error: "אפשר להעלות תמונה או PDF." });
    if (file.size > MAX_MB * 1024 * 1024) return setState({ step: "pick", error: `הקובץ גדול מ-${MAX_MB}MB.` });
    if (preview.current) URL.revokeObjectURL(preview.current);
    const url = (preview.current = URL.createObjectURL(file));
    setState({ step: "reading", file, url });
    let path: string;
    try {
      path = await uploadReceipt(file);
      pending.current = path;
    } catch (e) {
      return setState({ step: "pick", error: `ההעלאה נכשלה: ${(e as Error).message}` });
    }
    try {
      const parsed = await parseDocument(path);
      setKind(parsed.kind === "income" ? "income" : "expense");
      setState({ step: "review", file, url, path, parsed });
    } catch (e) {
      setState({ step: "review", file, url, path, parsed: null, error: (e as Error).message });
    }
  }

  const saved = () => { pending.current = null; onDone(); };
  const cancel = () => onDone(); // the unmount cleanup removes the unused upload

  if (state.step === "pick") {
    const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); void handle(e.dataTransfer.files?.[0]); };
    return (
      <div>
        <button type="button" onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
          className={`grid w-full cursor-pointer place-items-center gap-2 rounded-[1.25rem] border border-dashed px-6 py-12 text-center transition-colors duration-300 ${drag ? "border-pink bg-pink/10" : "border-[var(--line-2)] hover:bg-[var(--hover-veil)]"}`}>
          <span className="text-[18px] font-semibold">גררי לכאן חשבונית או קבלה</span>
          <span className="text-[15px] text-mute">או לחצי לבחירת קובץ. תמונה או PDF, עד {MAX_MB}MB</span>
        </button>
        <input ref={input} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => handle(e.target.files?.[0])} />
        {state.error && <p className="mt-3 text-[14px] text-error">{state.error}</p>}
        <p className="mt-4 text-[14px] text-mute-2">המערכת קוראת את הסכום, התאריך, הספק או הלקוח ומספר המסמך, ומציעה פרויקט. את בודקת ומאשרת לפני השמירה.</p>
      </div>
    );
  }

  const thumb = <Preview file={state.file} url={state.url} />;

  if (state.step === "reading") {
    return (
      <div className="grid gap-4">
        {thumb}
        <div className="flex items-center gap-3 py-6 text-mute">
          <span className="size-5 animate-spin rounded-full border-2 border-[var(--line-2)] border-t-pink" aria-hidden />
          קוראת את המסמך…
        </div>
      </div>
    );
  }

  const p = state.parsed;
  const foreign = p && p.currency !== "ILS" && p.amount ? `${p.amount} ${p.currency}` : "";
  const amount = p?.amount && !foreign ? String(p.amount) : "";
  const notes = [foreign && `סכום מקורי: ${foreign}`].filter(Boolean).join(" · ");
  const desc = p?.description || p?.counterparty || "";

  return (
    <div className="grid gap-4">
      {thumb}
      <Notes state={state} foreign={foreign} />
      <Segmented label="סוג תנועה" value={kind} onChange={setKind} options={[["expense", "הוצאה"], ["income", "הכנסה"]]} />
      {kind === "expense" ? (
        <ExpenseForm key="expense" receiptPath={state.path} onDone={saved} onCancel={cancel} context={context} initial={{
          amount, description: desc, vendor: p?.counterparty ?? "", ...(isDate(p?.date) ? { spent_on: p!.date } : {}), project_id: projectId ?? p?.project_id ?? "",
          category: p?.category ?? "", reference: p?.invoice_number ?? "", notes,
          // a foreign currency invoice carries no Israeli VAT; otherwise what the document says
          ...(foreign ? { vat_doc: "no_vat" as const } : p?.doc_vat_kind && p.doc_vat_kind !== "unknown" ? { vat_doc: p.doc_vat_kind } : {}),
          ...(!foreign && p?.doc_vat_kind === "tax_invoice" && Number(p.vat_amount) > 0 ? { vat_amount: String(p.vat_amount) } : {}),
          allocation_number: p?.allocation_number ?? "", supplier_tax_id: p?.supplier_tax_id ?? "",
        }} />
      ) : (
        <IncomeForm key="income" receiptPath={state.path} onDone={saved} onCancel={cancel} context={context} initial={{
          amount, ...(isDate(p?.date) ? { received_on: p!.date } : {}), project_id: projectId ?? p?.project_id ?? "",
          method: p?.payment_method ?? "", reference: p?.invoice_number ?? "",
          notes: [p?.counterparty && `לקוח: ${p.counterparty}`, notes].filter(Boolean).join(" · "),
        }} />
      )}
    </div>
  );
}

function Preview({ file, url }: { file: File; url: string }) {
  const isPdf = file.type === "application/pdf";
  return (
    <div className="flex items-center gap-3 rounded-2xl p-2 shadow-[inset_0_0_0_1px_var(--line-2)]">
      {isPdf
        ? <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-[var(--ink-3)] text-[13px] font-semibold text-mute">PDF</span>
        : <img src={url} alt="" className="size-14 shrink-0 rounded-xl object-cover" />}
      <span className="min-w-0 flex-1 truncate text-[15px]">{file.name}</span>
      <a href={url} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-[15px] font-medium text-mute hover:text-bone">פתיחה</a>
    </div>
  );
}

function Notes({ state, foreign }: { state: Extract<State, { step: "review" }>; foreign: string }) {
  const p = state.parsed;
  const lines: string[] = [];
  if (state.error) lines.push(`${state.error} המסמך כבר מצורף.`);
  if (p && !p.is_financial_document) lines.push("זה לא נראה כמו חשבונית או קבלה. כדאי לבדוק את הפרטים.");
  if (p && p.confidence === "low") lines.push("חלק מהפרטים לא היו ברורים במסמך. כדאי לבדוק.");
  if (foreign) lines.push(`הסכום במסמך הוא ${foreign}. כתבי כמה זה יצא בשקלים (למשל מהחיוב בכרטיס).`);
  if (p?.note) lines.push(p.note);
  p?.duplicates.forEach((d) => lines.push(`ייתכן שזה כבר נרשם: ${d.table === "income" ? "הכנסה" : "הוצאה"} של ${money(d.amount)} מ-${date(d.date)}.`));
  if (!lines.length) return <p className="text-[15px] text-pink-soft">קראתי את המסמך. בדקי שהכול נכון ושמרי.</p>;
  return (
    <ul className="grid gap-1 rounded-2xl bg-pink/10 px-4 py-3 text-[14px]">
      {lines.map((l, i) => <li key={i}>{l}</li>)}
    </ul>
  );
}
