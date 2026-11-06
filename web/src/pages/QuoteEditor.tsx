// Build a quote, send it from here, and follow what the client does with it.
// Two forms, chosen per quote: a branded document the client approves on, or the interactive portal.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useLeads, useProposal, useQuoteItems, useQuotes, useRemove, useSave, useSaveQuote, quoteUrl,
  type Lead, type Proposal, type Quote, type QuoteItem, type QuoteSection,
} from "../lib/data";
import { must, supabase } from "../lib/supabase";
import { addDays, date, dateTime, money, QUOTE_STATUS, quoteState, quoteTotals, today } from "../lib/format";
import { Button, Card, Eyebrow, Field, Input, Loading, Modal, Num, Pill, Segmented, Select, Textarea, useConfirm } from "../components/ui";
import { Icon } from "../components/icons";
import { ProjectPicker } from "../components/Pickers";
import { useMe } from "../components/forms";
import { QuoteDocument } from "../components/QuoteDocument";
import { waLink } from "./Leads";

// The bespoke experiences the portal knows how to show. A new one is built with Claude in the portal's repo.
export const PORTAL_TEMPLATES: [string, string][] = [["luxury-tours", "Luxury Tours (שאלון + הצעה נבנית)"], ["tillis", "TILLI'S (סטודיו, פרקים)"]];

const DEFAULT_SECTIONS: QuoteSection[] = [
  { title: "איך זה עובד", body: "" }, { title: "מה כלול", body: "" }, { title: "לא כלול", body: "" },
];
const blankItem = (): QuoteItem => ({ description: "", details: "", quantity: 1, unit_price: 0, recurring: false });

type Form = {
  kind: "document" | "portal"; portal_template: string; lead_id: string; project_id: string; recipient_name: string; title: string;
  intro: string; issued_on: string; valid_until: string; discount_type: "amount" | "percent"; discount_value: string;
  include_vat: boolean; vat_rate: string; payment_terms: string; timeline: string; notes: string;
};

function initialForm(q: Quote | undefined, lead: Lead | undefined, kind: string): Form {
  return {
    kind: (q?.kind ?? (kind === "portal" ? "portal" : "document")) as Form["kind"],
    portal_template: q?.portal_template ?? PORTAL_TEMPLATES[0][0],
    lead_id: q?.lead_id ?? lead?.id ?? "", project_id: q?.project_id ?? lead?.project_id ?? "",
    recipient_name: q?.recipient_name ?? (lead ? lead.company || lead.name : ""),
    title: q?.title ?? "", intro: q?.intro ?? "", issued_on: q?.issued_on ?? today(), valid_until: q?.valid_until ?? addDays(today(), 30),
    discount_type: q?.discount_type ?? "amount", discount_value: String(q?.discount_value ?? 0),
    include_vat: q?.include_vat ?? true, vat_rate: String(q?.vat_rate ?? 18),
    payment_terms: q?.payment_terms ?? "50% באישור ההצעה, 50% במסירה.", timeline: q?.timeline ?? "", notes: q?.notes ?? "",
  };
}

export default function QuoteEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const quotes = useQuotes();
  const leads = useLeads();
  const items = useQuoteItems(id);
  const q = quotes.data?.find((x) => x.id === id);
  const lead = leads.data?.find((l) => l.id === (q?.lead_id ?? params.get("lead")));
  if (quotes.isLoading || leads.isLoading || (id && items.isLoading)) return <Loading />;
  if (id && !q) return <p className="text-mute">ההצעה לא נמצאה.</p>;
  return <Editor key={id ?? "new"} q={q} lead={lead} items={items.data ?? []} kind={params.get("kind") ?? "document"} />;
}

function Editor({ q, lead, items: savedItems, kind }: { q?: Quote; lead?: Lead; items: QuoteItem[]; kind: string }) {
  const nav = useNavigate();
  const me = useMe();
  const save = useSaveQuote();
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(() => initialForm(q, lead, kind));
  const [items, setItems] = useState<QuoteItem[]>(() => savedItems.length ? savedItems.map((i) => ({ ...i, details: i.details ?? "" })) : [blankItem()]);
  const [sections, setSections] = useState<QuoteSection[]>(() => q ? q.sections ?? [] : f.kind === "document" ? DEFAULT_SECTIONS : []);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState(0);
  const set = <K extends keyof Form>(k: K) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value as Form[K] }));
  const portal = f.kind === "portal";
  const proposal = useProposal(q?.id, portal);
  const totals = quoteTotals(items, f.discount_type, Number(f.discount_value), f.include_vat, Number(f.vat_rate));
  const dirty = useMemo(() => JSON.stringify([f, items, sections]), [f, items, sections]);
  const [cleanAt, setCleanAt] = useState(dirty);
  useEffect(() => { if (savedAt) setCleanAt(dirty); }, [savedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const unsaved = !q || dirty !== cleanAt;
  const state = q ? quoteState(q) : "draft";
  const locked = !!q && ["approved", "rejected", "cancelled"].includes(q.status);

  const persist = async () => {
    setError("");
    if (!f.title.trim()) { setError("חסרה כותרת להצעה."); return null; }
    const values: Record<string, unknown> = {
      kind: f.kind, portal_template: portal ? f.portal_template || null : null, lead_id: f.lead_id || null, project_id: f.project_id || null,
      recipient_name: f.recipient_name.trim() || null, title: f.title.trim(), intro: f.intro.trim() || null,
      sections: sections.filter((s) => s.title.trim()).map((s) => ({ title: s.title.trim(), body: s.body.trim() })),
      issued_on: f.issued_on, valid_until: f.valid_until, discount_type: f.discount_type, discount_value: Number(f.discount_value) || 0,
      include_vat: f.include_vat, vat_rate: Number(f.vat_rate) || 0, payment_terms: f.payment_terms.trim() || null,
      timeline: f.timeline.trim() || null, notes: f.notes.trim() || null,
      ...(q ? {} : { created_by_partner_id: me?.id ?? null }),
    };
    try {
      const newId = await save.mutateAsync({ id: q?.id, values, items });
      // The portal shows the client's name from its link row; keep it in step with the quote.
      if (portal && q) must(await supabase.from("proposal_links").update({ client_name: f.recipient_name.trim() || f.title.trim(), template: f.portal_template }).eq("quote_id", q.id));
      setSavedAt(Date.now());
      if (!q) nav(`/quotes/${newId}`, { replace: true });
      return newId;
    } catch (e) { setError((e as Error).message); return null; }
  };

  const doc = {
    number: q?.number ?? "טיוטה", recipient_name: f.recipient_name || null, title: f.title, intro: f.intro || null, sections,
    issued_on: f.issued_on, valid_until: f.valid_until, discount_type: f.discount_type, discount_value: Number(f.discount_value) || 0,
    include_vat: f.include_vat, vat_rate: Number(f.vat_rate) || 0, payment_terms: f.payment_terms || null, timeline: f.timeline || null, items,
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {lead ? <Link to={`/leads/${lead.id}`} className="text-[15px] text-mute hover:text-bone">→ {lead.company || lead.name}</Link>
            : <Link to="/leads" className="text-[15px] text-mute hover:text-bone">→ לידים</Link>}
          <Eyebrow>{portal ? "פורטל הצעה אינטראקטיבי" : "מסמך הצעת מחיר"}{q ? ` · ${q.number}` : ""}</Eyebrow>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-[clamp(28px,3.7vw,48px)] font-semibold leading-[1.1] tracking-[-0.015em]">
            {f.title || (q ? q.title : "הצעה חדשה")}
            {q && <Pill tone={["viewed", "approved"].includes(state) ? "pink" : "mute"}>{QUOTE_STATUS[state]}</Pill>}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {unsaved && !locked && <Button variant="ghost" disabled={save.isPending} onClick={persist}>{q ? "שמירת שינויים" : "שמירה כטיוטה"}</Button>}
          {!locked && <Button arrow className="group" disabled={save.isPending} onClick={async () => { const ok = unsaved ? await persist() : q?.id; if (ok) setSending(true); }}>
            {q?.sent_at ? "שליחה שוב" : "שליחה ללקוח"}
          </Button>}
        </div>
      </header>
      {error && <p className="-mt-4 text-[14px] text-error">{error}</p>}

      {!q && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[15px] text-mute">סוג ההצעה</span>
          <Segmented label="סוג ההצעה" value={f.kind} onChange={(k) => { setF({ ...f, kind: k }); if (k === "document" && !sections.length) setSections(DEFAULT_SECTIONS); }}
            options={[["document", "מסמך ממותג"], ["portal", "פורטל אינטראקטיבי"]]} />
        </div>
      )}

      {q && <Tracking q={q} proposal={portal ? proposal.data : undefined} lead={lead} onSend={() => setSending(true)} />}

      {portal ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <Card>
            <h2 className="mb-4 text-[22px] font-semibold">הגדרות הפורטל</h2>
            <fieldset disabled={locked} className="grid gap-4">
              <Field label="כותרת (למעקב שלנו)"><Input value={f.title} onChange={set("title")} placeholder="למשל: פורטל Luxury Tours" /></Field>
              <Field label="שם הלקוח כפי שיופיע בפורטל"><Input value={f.recipient_name} onChange={set("recipient_name")} /></Field>
              <Field label="החוויה" hint="כל פורטל נתפר ללקוח. לקוח חדש? בונים לו חוויה עם Claude בריפו של הפורטל, ואז היא מופיעה כאן.">
                <Select value={f.portal_template} onChange={set("portal_template")}>
                  {PORTAL_TEMPLATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  {f.portal_template && !PORTAL_TEMPLATES.some(([k]) => k === f.portal_template) && <option value={f.portal_template}>{f.portal_template}</option>}
                </Select>
              </Field>
              <Field label="סכום ההצעה, לפני מע״מ" hint="למעקב ולצנרת. המחירים שהלקוח רואה כתובים בתוכן הפורטל.">
                <Input type="number" min={0} inputMode="decimal" value={items[0]?.unit_price || ""}
                  onChange={(e) => setItems([{ ...(items[0] ?? blankItem()), description: items[0]?.description || "הצעה", quantity: 1, unit_price: Number(e.target.value) }])} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="כולל מע״מ?"><Select value={f.include_vat ? "1" : "0"} onChange={(e) => setF({ ...f, include_vat: e.target.value === "1" })}><option value="1">מוסיפים מע״מ</option><option value="0">בלי מע״מ</option></Select></Field>
                <Field label="בתוקף עד"><Input type="date" value={f.valid_until} onChange={set("valid_until")} /></Field>
              </div>
              <ProjectPicker value={f.project_id} onChange={(v) => setF({ ...f, project_id: v })} none="בלי פרויקט עדיין" />
              <Field label="הערות פנימיות"><Textarea value={f.notes} onChange={set("notes")} /></Field>
            </fieldset>
          </Card>
          {q && proposal.data && <PortalIntel p={proposal.data} />}
        </div>
      ) : (
        <>
          <div className="lg:hidden"><Segmented label="תצוגה" value={view} onChange={setView} options={[["edit", "עריכה"], ["preview", "כמו שהלקוח רואה"]]} /></div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-start">
            <div className={`space-y-6 ${view === "preview" ? "hidden lg:block" : ""}`}>
              <fieldset disabled={locked} className="space-y-6">
                <Card>
                  <h2 className="mb-4 text-[22px] font-semibold">הפתיחה</h2>
                  <div className="grid gap-4">
                    <Field label="עבור"><Input value={f.recipient_name} onChange={set("recipient_name")} placeholder="שם הלקוח או העסק" /></Field>
                    <Field label="כותרת" hint="משפט אחד שמדבר על התוצאה בשביל הלקוח, לא על המוצר"><Input value={f.title} onChange={set("title")} placeholder="פחות עבודה שחורה במשרד" /></Field>
                    <Field label="פסקת פתיחה"><Textarea rows={3} value={f.intro} onChange={set("intro")} /></Field>
                  </div>
                </Card>
                <ItemsCard items={items} setItems={setItems} f={f} setF={setF} totals={totals} />
                <SectionsCard sections={sections} setSections={setSections} />
                <Card>
                  <h2 className="mb-4 text-[22px] font-semibold">תנאים</h2>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2"><Field label="תנאי תשלום"><Input value={f.payment_terms} onChange={set("payment_terms")} /></Field></div>
                    <div className="sm:col-span-2"><Field label="לוח זמנים"><Textarea rows={2} value={f.timeline} onChange={set("timeline")} placeholder="כשבועיים מקבלת הגישות" /></Field></div>
                    <Field label="תאריך ההצעה"><Input type="date" value={f.issued_on} onChange={set("issued_on")} /></Field>
                    <Field label="בתוקף עד"><Input type="date" value={f.valid_until} onChange={set("valid_until")} /></Field>
                    <div className="sm:col-span-2"><ProjectPicker value={f.project_id} onChange={(v) => setF({ ...f, project_id: v })} none="בלי פרויקט עדיין (ייפתח באישור)" /></div>
                    <div className="sm:col-span-2"><Field label="הערות פנימיות" hint="רק לנו, הלקוח לא רואה"><Textarea value={f.notes} onChange={set("notes")} /></Field></div>
                  </div>
                </Card>
              </fieldset>
            </div>
            <div className={`lg:sticky lg:top-28 ${view === "edit" ? "hidden lg:block" : ""}`}>
              <div className="overflow-hidden rounded-[var(--radius-box)] shadow-[0_0_0_1px_var(--line-2)]">
                <div className="max-h-[calc(100dvh-140px)] overflow-y-auto"><QuoteDocument q={doc} /></div>
              </div>
              <p className="mt-2 text-center text-[13px] text-mute">תצוגה חיה. הלקוח רואה את זה עם כפתור אישור בסוף.</p>
            </div>
          </div>
        </>
      )}

      {q && <DangerZone q={q} />}

      {q && sending && (
        <Modal open onClose={() => setSending(false)} title={portal ? "שליחת הפורטל" : "שליחת ההצעה"}>
          <SendForm q={q} lead={lead} portalToken={proposal.data?.link?.token} onDone={async () => { setSending(false); await qc.invalidateQueries(); }} />
        </Modal>
      )}
    </div>
  );
}

function ItemsCard({ items, setItems, f, setF, totals }: {
  items: QuoteItem[]; setItems: (i: QuoteItem[]) => void; f: Form; setF: (f: Form) => void; totals: ReturnType<typeof quoteTotals>;
}) {
  const upd = (n: number, patch: Partial<QuoteItem>) => setItems(items.map((it, k) => (k === n ? { ...it, ...patch } : it)));
  const move = (n: number, d: number) => { const c = [...items]; const [x] = c.splice(n, 1); c.splice(n + d, 0, x); setItems(c); };
  return (
    <Card>
      <h2 className="mb-4 text-[22px] font-semibold">מה מציעים ובכמה</h2>
      <div className="space-y-4">
        {items.map((it, n) => (
          <div key={n} className="rounded-[18px] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
            <div className="grid gap-3 grid-cols-[1fr_64px_100px]">
              <Input aria-label="תיאור" placeholder="למשל: בנייה והקמה מלאה" value={it.description} onChange={(e) => upd(n, { description: e.target.value })} />
              <Input aria-label="כמות" type="number" min={0} step="any" inputMode="decimal" value={it.quantity} onChange={(e) => upd(n, { quantity: Number(e.target.value) })} />
              <Input aria-label="מחיר ליחידה" type="number" step="any" inputMode="decimal" placeholder="מחיר" value={it.unit_price || ""} onChange={(e) => upd(n, { unit_price: Number(e.target.value) })} />
            </div>
            <Input className="mt-2" aria-label="פירוט" placeholder="פירוט קצר (לא חובה)" value={it.details ?? ""} onChange={(e) => upd(n, { details: e.target.value })} />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[14px]">
              <label className="inline-flex cursor-pointer items-center gap-2 text-mute">
                <input type="checkbox" checked={it.recurring} onChange={(e) => upd(n, { recurring: e.target.checked })} className="accent-[var(--pink)]" />תשלום חודשי
              </label>
              <span className="flex items-center gap-1">
                <Num className="me-2 text-mute">{money((Number(it.quantity) || 0) * (Number(it.unit_price) || 0))}</Num>
                {n > 0 && <button type="button" className="press px-2 text-mute hover:text-bone" aria-label="למעלה" onClick={() => move(n, -1)}>↑</button>}
                {n < items.length - 1 && <button type="button" className="press px-2 text-mute hover:text-bone" aria-label="למטה" onClick={() => move(n, 1)}>↓</button>}
                {items.length > 1 && <button type="button" className="press px-2 text-mute hover:text-error" aria-label="הסרה" onClick={() => setItems(items.filter((_, k) => k !== n))}><Icon name="trash" size={16} /></button>}
              </span>
            </div>
          </div>
        ))}
        <Button type="button" variant="quiet" onClick={() => setItems([...items, blankItem()])}><Icon name="plus" size={16} />שורה</Button>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <Field label="הנחה">
          <div className="grid grid-cols-[1fr_84px] gap-2">
            <Input type="number" min={0} step="any" value={f.discount_value} onChange={(e) => setF({ ...f, discount_value: e.target.value })} />
            <Select aria-label="סוג הנחה" value={f.discount_type} onChange={(e) => setF({ ...f, discount_type: e.target.value as Form["discount_type"] })}><option value="amount">₪</option><option value="percent">%</option></Select>
          </div>
        </Field>
        <Field label="מע״מ"><Select value={f.include_vat ? "1" : "0"} onChange={(e) => setF({ ...f, include_vat: e.target.value === "1" })}><option value="1">מוסיפים</option><option value="0">בלי</option></Select></Field>
        {f.include_vat && <Field label="שיעור"><Input type="number" step="any" value={f.vat_rate} onChange={(e) => setF({ ...f, vat_rate: e.target.value })} /></Field>}
      </div>
      <div className="mt-5 flex items-baseline justify-between shadow-[inset_0_1px_0_var(--line)] pt-4">
        <span className="text-mute">לתשלום{f.include_vat ? " כולל מע״מ" : ""}</span>
        <Num className="text-[28px] font-semibold">{money(totals.total)}</Num>
      </div>
      {totals.monthly > 0 && <p className="text-end text-[14px] text-mute">ועוד <Num>{money(totals.monthly)}</Num> לחודש</p>}
    </Card>
  );
}

function SectionsCard({ sections, setSections }: { sections: QuoteSection[]; setSections: (s: QuoteSection[]) => void }) {
  const upd = (n: number, patch: Partial<QuoteSection>) => setSections(sections.map((s, k) => (k === n ? { ...s, ...patch } : s)));
  const ideas = ["איך זה עובד", "מה כלול", "לא כלול", "חיבור ועלויות", "השלב הבא", "למה אנחנו"];
  const unused = ideas.filter((t) => !sections.some((s) => s.title === t));
  return (
    <Card>
      <h2 className="text-[22px] font-semibold">פרקים</h2>
      <p className="mb-4 text-[14px] text-mute">פרק ריק לא מופיע בהצעה. שורה חדשה בטקסט נשמרת כשורה חדשה.</p>
      <div className="space-y-4">
        {sections.map((s, n) => (
          <div key={n} className="grid gap-2">
            <div className="flex gap-2">
              <Input aria-label="כותרת הפרק" value={s.title} onChange={(e) => upd(n, { title: e.target.value })} />
              <button type="button" className="press px-2 text-mute hover:text-error" aria-label="הסרת הפרק" onClick={() => setSections(sections.filter((_, k) => k !== n))}><Icon name="trash" size={16} /></button>
            </div>
            <Textarea aria-label={`תוכן: ${s.title}`} rows={3} value={s.body} onChange={(e) => upd(n, { body: e.target.value })} />
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {unused.map((t) => <button type="button" key={t} onClick={() => setSections([...sections, { title: t, body: "" }])}
          className="press rounded-full px-3 py-1 text-[14px] font-medium text-mute shadow-[inset_0_0_0_1px_var(--line-2)] hover:text-bone">+ {t}</button>)}
        <button type="button" onClick={() => setSections([...sections, { title: "פרק חדש", body: "" }])}
          className="press rounded-full px-3 py-1 text-[14px] font-medium text-mute shadow-[inset_0_0_0_1px_var(--line-2)] hover:text-bone">+ פרק אחר</button>
      </div>
    </Card>
  );
}

// Where the quote stands, step by step, with the follow-up actions next to it.
function Tracking({ q, proposal, lead, onSend }: { q: Quote; proposal?: Proposal; lead?: Lead; onSend: () => void }) {
  const save = useSave("quotes");
  const confirm = useConfirm();
  const state = quoteState(q);
  const portal = q.kind === "portal";
  const last = proposal?.sessions[0]?.last_seen_at ?? proposal?.sessions[0]?.started_at;
  const steps: [string, string | null, string?][] = [
    ["נוצרה", q.created_at],
    ["נשלחה", q.sent_at, q.sent_via ? ({ whatsapp: "בוואטסאפ", email: "במייל", link: "בקישור" } as Record<string, string>)[q.sent_via] : undefined],
    ["נפתחה", q.viewed_at, q.view_count ? `${q.view_count} פעמים${last && portal ? `, לאחרונה ${dateTime(last)}` : ""}` : undefined],
    ...(portal ? [["שלח סיכום", q.submitted_at, q.meeting_id ? "וקבע פגישה ביומן" : undefined] as [string, string | null, string?]] : []),
    [q.status === "rejected" ? "נדחתה" : "אושרה", q.responded_at, q.signer_name ? `על ידי ${q.signer_name}` : undefined],
  ];
  const mark = async (status: "approved" | "rejected") => {
    const ok = await confirm({
      title: status === "approved" ? "לסמן שהלקוח אישר?" : "לסמן שהלקוח דחה?",
      body: status === "approved" ? "הליד ייסגר כ״נסגר״, ייפתח לקוח ופרויקט בשלב הקמה אם עוד אין." : "ההצעה תיסגר. הליד נשאר פתוח, ואפשר לשלוח הצעה חדשה.",
      yes: status === "approved" ? "כן, אישר" : "כן, דחה",
    });
    if (ok) await save.mutateAsync({ id: q.id, values: { status, responded_at: new Date().toISOString() } });
  };
  const daysSinceSent = q.sent_at ? Math.floor((Date.now() - new Date(q.sent_at).getTime()) / 86_400_000) : 0;
  return (
    <Card>
      <ol className="grid gap-4 sm:grid-cols-4 lg:grid-cols-5">
        {steps.map(([label, at, sub], i) => (
          <li key={i} className={`${at ? "" : "opacity-45"}`}>
            <span className={`block h-1.5 rounded-full ${at ? "bg-pink" : "bg-[var(--line-2)]"}`} />
            <span className="mt-2 block text-[15px] font-semibold">{label}</span>
            <span className="block text-[13px] text-mute">{at ? dateTime(at) : "עוד לא"}{sub ? ` · ${sub}` : ""}</span>
          </li>
        ))}
      </ol>
      {["sent", "viewed"].includes(q.status) && (
        <div className="mt-5 flex flex-wrap items-center gap-2 shadow-[inset_0_1px_0_var(--line)] pt-4">
          <span className="me-auto text-[15px] text-mute">
            {state === "expired" ? "התוקף עבר. אפשר להאריך ולשלוח שוב." : q.viewed_at ? "הלקוח ראה את ההצעה. זה הזמן להרים טלפון." : daysSinceSent >= 2 ? `נשלחה לפני ${daysSinceSent} ימים ועוד לא נפתחה. כדאי לבדוק שהקישור הגיע.` : "מחכות לתשובה."}
          </span>
          {lead?.phone && <a className="press rounded-full px-4 py-1.5 text-[14px] font-medium shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-[var(--hover-veil)]" target="_blank" rel="noreferrer"
            href={waLink(lead.phone, `היי ${lead.name}, רציתי לשמוע מה דעתך על ההצעה ששלחנו 🙂`)}>הודעת פולואפ</a>}
          <Button variant="ghost" className="!px-4 !py-1.5 text-[14px]" onClick={onSend}>שליחה שוב</Button>
          <Button variant="ghost" className="!px-4 !py-1.5 text-[14px]" onClick={() => mark("approved")}>אישר</Button>
          <Button variant="quiet" className="text-[14px]" onClick={() => mark("rejected")}>דחה</Button>
        </div>
      )}
      {q.response_note && <p className="mt-4 rounded-[14px] bg-[var(--ink-3)] p-3 text-[15px]">הלקוח כתב: {q.response_note}</p>}
    </Card>
  );
}

// What the client did inside the portal: every visit, the answers, the chapters, the summary and the meeting.
function PortalIntel({ p }: { p: Proposal }) {
  if (!p.link) return null;
  const completed = p.sessions.filter((s) => s.completed_at).length;
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[22px] font-semibold">מה הלקוח עשה בפורטל</h2>
        <span className="text-[14px] text-mute">{p.sessions.length} כניסות · {completed} עד הסוף</span>
      </div>
      {!p.sessions.length ? <p className="text-mute">עוד לא נכנסו לפורטל. כשהלקוח יפתח את הקישור, תופיע כאן כל כניסה, מה ענה ואיפה התעכב.</p> : (
        <div className="space-y-5">
          {p.sessions.map((s) => {
            const ev = p.events.filter((e) => e.session_id === s.id);
            const end = s.last_seen_at ?? ev.at(-1)?.created_at ?? s.started_at;
            const mins = Math.max(0, Math.round((new Date(end).getTime() - new Date(s.started_at).getTime()) / 60_000));
            const answers = new Map<string, { q: string; a: string; changed: boolean }>();
            for (const e of ev.filter((x) => x.type === "answer")) {
              const pl = e.payload ?? {};
              const qid = String(pl.question ?? "");
              const labels = Array.isArray(pl.value_labels) ? pl.value_labels as string[] : Array.isArray(pl.value) ? (pl.value as string[]).map((v) => v.replace(/^custom:/, "")) : [];
              answers.set(qid, { q: String(pl.question_label ?? qid), a: labels.join(", "), changed: answers.has(qid) || !!pl.changed });
            }
            const chapters = [...new Set(ev.filter((e) => e.type === "chapter_view" || e.type === "step_view").map((e) => String(e.payload?.chapter_label ?? e.payload?.chapter ?? e.payload?.step ?? "")))].filter(Boolean);
            const submit = ev.find((e) => e.type === "submit");
            const summary = (submit?.payload?.summary ?? []) as { q?: string; a?: string }[];
            const slot = submit?.payload?.slot as { display?: string } | null | undefined;
            const device = /iphone|android|mobile/i.test(s.user_agent ?? "") ? "טלפון" : s.user_agent ? "מחשב" : "";
            return (
              <div key={s.id} className="rounded-[18px] p-4 shadow-[inset_0_0_0_1px_var(--line)]">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">{dateTime(s.started_at)}</span>
                  <span className="text-[13px] text-mute">{mins} דק׳{device ? ` · ${device}` : ""}{s.locale ? ` · ${s.locale === "en" ? "אנגלית" : "עברית"}` : ""}{s.completed_at ? " · הגיע לסוף" : ""}</span>
                </div>
                {chapters.length > 0 && <p className="mt-2 text-[14px] text-mute">ראה: {chapters.join(" · ")}</p>}
                {(summary.length ? summary.map((x) => ({ q: x.q ?? "", a: x.a ?? "", changed: false })) : [...answers.values()]).length > 0 && (
                  <dl className="mt-3 grid gap-2 text-[14px]">
                    {(summary.length ? summary.map((x) => ({ q: x.q ?? "", a: x.a ?? "", changed: false })) : [...answers.values()]).map((x, i) => (
                      <div key={i}><dt className="text-mute">{x.q}</dt><dd>{x.a || "—"}{x.changed && <span className="text-pink-soft"> · שינה תשובה</span>}</dd></div>
                    ))}
                  </dl>
                )}
                {submit && <p className="mt-3 text-[14px] text-pink-soft">שלח סיכום{slot?.display ? ` וקבע פגישה: ${slot.display}` : ", בלי מועד לפגישה"}</p>}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function SendForm({ q, lead, portalToken, onDone }: { q: Quote; lead?: Lead; portalToken?: string | null; onDone: () => void }) {
  const save = useSave("quotes");
  const saveLead = useSave("leads");
  const url = quoteUrl(q, portalToken);
  const first = (lead?.name ?? q.recipient_name ?? "").split(" ")[0];
  const [text, setText] = useState(q.kind === "portal"
    ? `היי ${first}, הכנו בשבילך הצעה אישית. כמה שאלות קצרות, וההצעה נבנית לפי מה שחשוב לך:\n${url}`
    : `היי ${first}, מצרפת את הצעת המחיר שלנו: ${q.title}.\nאפשר לעיין ולאשר ישירות בקישור:\n${url}`);
  const [phone, setPhone] = useState(lead?.phone ?? "");
  const [email, setEmail] = useState(lead?.email ?? "");
  const [copied, setCopied] = useState(false);
  const [follow, setFollow] = useState(true);

  // Sending marks the quote as sent (which moves the lead and the project on) and sets a follow-up in 3 days.
  const markSent = async (via: string) => {
    await save.mutateAsync({ id: q.id, values: { status: q.status === "draft" ? "sent" : q.status, sent_at: new Date().toISOString(), sent_via: via } });
    if (lead && follow) await saveLead.mutateAsync({ id: lead.id, values: { next_follow_up_on: addDays(today(), 3), follow_up_note: `פולואפ על ההצעה ${q.number}` } });
  };
  return (
    <div className="grid gap-4">
      <Field label="ההודעה"><Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="וואטסאפ"><Input type="tel" dir="ltr" className="text-start" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050..." /></Field>
        <Field label="מייל"><Input type="email" dir="ltr" className="text-start" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      </div>
      <label className="inline-flex cursor-pointer items-center gap-2 text-[15px] text-mute">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[var(--pink)]" />לקבוע פולואפ בעוד 3 ימים (תזכורת בטלגרם)
      </label>
      <div className="flex flex-wrap gap-2">
        <a className={`press inline-flex items-center gap-2 rounded-full bg-pink px-5 py-2.5 font-semibold text-on-pink hover:bg-pink-hover ${phone ? "" : "pointer-events-none opacity-50"}`}
          href={phone ? waLink(phone, text) : undefined} target="_blank" rel="noreferrer" onClick={async () => { await markSent("whatsapp"); onDone(); }}>
          <Icon name="send" size={17} />וואטסאפ
        </a>
        <a className={`press inline-flex items-center gap-2 rounded-full px-5 py-2.5 font-semibold shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-[var(--hover-veil)] ${email ? "" : "pointer-events-none opacity-50"}`}
          href={email ? `mailto:${email}?subject=${encodeURIComponent(`הצעת מחיר מ-aRLi: ${q.title}`)}&body=${encodeURIComponent(text)}` : undefined}
          onClick={async () => { await markSent("email"); onDone(); }}>
          <Icon name="mail" size={17} />מייל
        </a>
        <Button variant="ghost" onClick={async () => {
          try { await navigator.clipboard.writeText(url); setCopied(true); } catch { /* the link is also shown below */ }
          await markSent("link");
        }}><Icon name="copy" size={17} />{copied ? "הקישור הועתק" : "העתקת קישור"}</Button>
      </div>
      <p className="break-all text-[13px] text-mute" dir="ltr">{url}</p>
      <a href={url} target="_blank" rel="noreferrer" className="text-[14px] text-pink-soft hover:underline">
        <Icon name="eye" size={15} className="me-1 inline" />{q.kind === "portal" ? "לפתוח את הפורטל (כניסה שלך נספרת כצפייה)" : "לראות כמו הלקוח (הצפייה שלך לא נספרת)"}
      </a>
      {copied && <Button variant="quiet" onClick={onDone}>סגירה</Button>}
    </div>
  );
}

function DangerZone({ q }: { q: Quote }) {
  const nav = useNavigate();
  const save = useSave("quotes");
  const remove = useRemove("quotes");
  const saveQuote = useSaveQuote();
  const items = useQuoteItems(q.id);
  const confirm = useConfirm();
  return (
    <div className="flex flex-wrap gap-3 text-[14px]">
      <button className="text-mute hover:text-bone" onClick={async () => {
        const { id: _id, number: _n, status: _s, public_token: _t, sent_at: _a, sent_via: _v, viewed_at: _w, view_count: _c, responded_at: _r,
          signer_name: _sn, response_note: _rn, submitted_at: _sa, meeting_id: _m, created_at: _ca, leads: _l, clients: _cl, projects: _p, subtotal: _st, total: _tt, ...rest } = q;
        const id = await saveQuote.mutateAsync({ values: { ...rest, issued_on: today(), valid_until: addDays(today(), 30), title: `${q.title} (עותק)` }, items: items.data ?? [] });
        nav(`/quotes/${id}`);
      }}>שכפול</button>
      {q.status !== "cancelled" && q.status !== "approved" && (
        <button className="text-mute hover:text-bone" onClick={async () => {
          if (await confirm({ title: "לבטל את ההצעה?", body: "הקישור יפסיק לעבוד אצל הלקוח.", yes: "כן, לבטל" })) {
            await save.mutateAsync({ id: q.id, values: { status: "cancelled" } });
            if (q.kind === "portal") await supabase.from("proposal_links").update({ is_active: false }).eq("quote_id", q.id);
          }
        }}>ביטול ההצעה</button>
      )}
      {q.status === "draft" && (
        <button className="text-mute hover:text-error" onClick={async () => {
          if (await confirm({ title: "למחוק את הטיוטה?" })) { await remove.mutateAsync(q.id); nav(q.lead_id ? `/leads/${q.lead_id}` : "/leads"); }
        }}>מחיקה</button>
      )}
    </div>
  );
}
