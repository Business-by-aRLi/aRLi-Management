// Leads CRM: who is on the way to us, what we sent them, and who needs a follow-up today.
import { useMemo, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useLeads, usePartners, useQuotes, useSave, type Lead, type Quote } from "../lib/data";
import { addDays, daysBetween, date, LEAD_SOURCES, LEAD_STAGE, LEAD_STAGES, money, OPEN_LEAD_STAGES, QUOTE_STATUS, quoteState, today } from "../lib/format";
import { Button, Card, Empty, Field, Input, Loading, Modal, Num, PageTitle, Pill, SearchInput, Segmented, Select, Textarea } from "../components/ui";
import { Icon } from "../components/icons";
import { useMe } from "../components/forms";
import { ContactLink } from "./Clients";

// The newest live quote of each lead (a cancelled one does not count).
export function latestQuotes(quotes: Quote[]) {
  const m = new Map<string, Quote>();
  for (const q of quotes) if (q.lead_id && q.status !== "cancelled" && !m.has(q.lead_id)) m.set(q.lead_id, q);
  return m;
}

export default function Leads() {
  const leads = useLeads();
  const quotes = useQuotes();
  const [tab, setTab] = useState<"board" | "quotes">("board");
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const save = useSave("leads");
  const latest = useMemo(() => latestQuotes(quotes.data ?? []), [quotes.data]);
  if (leads.isLoading || quotes.isLoading) return <Loading />;

  const all = leads.data ?? [];
  const qtext = query.trim().toLowerCase();
  const list = all.filter((l) => !qtext || [l.name, l.company, l.phone, l.email, l.source].some((v) => v?.toLowerCase().includes(qtext)));
  const open = all.filter((l) => OPEN_LEAD_STAGES.includes(l.stage));
  const won = all.filter((l) => l.stage === "won").length, lost = all.filter((l) => l.stage === "lost").length;
  const valueOf = (l: Lead) => Number(latest.get(l.id)?.total ?? l.estimated_value ?? 0);
  const pipeline = open.reduce((s, l) => s + valueOf(l), 0);
  const waiting = (quotes.data ?? []).filter((q) => ["sent", "viewed"].includes(quoteState(q)));
  const due = open.filter((l) => l.next_follow_up_on && l.next_follow_up_on <= today())
    .sort((a, b) => a.next_follow_up_on!.localeCompare(b.next_follow_up_on!));

  return (
    <div className="space-y-8">
      <PageTitle eyebrow="לידים והצעות" title="מי בדרך אלינו." action={<Button arrow className="group" onClick={() => setAdding(true)}>ליד חדש</Button>} />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="לידים פתוחים" value={String(open.length)} />
        <Stat label="שווי בצנרת" value={money(pipeline)} />
        <Stat label="הצעות מחכות לתשובה" value={String(waiting.length)} sub={waiting.length ? money(waiting.reduce((s, q) => s + Number(q.total), 0)) : undefined} />
        <Stat label="אחוז סגירה" value={won + lost ? `${Math.round((won / (won + lost)) * 100)}%` : "—"} sub={won + lost ? `${won} נסגרו מתוך ${won + lost}` : undefined} />
      </section>

      <FollowUps due={due} latest={latest} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="תצוגה" value={tab} onChange={setTab} options={[["board", "לוח לידים"], ["quotes", "כל ההצעות"]]} />
        {tab === "board" && <SearchInput value={query} onChange={setQuery} placeholder="חיפוש ליד" />}
      </div>

      {tab === "board" ? (
        <>
          {!all.length ? <Empty>עוד אין לידים. כל פנייה חדשה מתחילה כאן, ב"ליד חדש".</Empty> : (
            <Board leads={list} latest={latest} onMove={(id, stage) => save.mutate({ id, values: { stage } })} />
          )}
          {(won + lost > 0) && (
            <div>
              <button className="press text-[15px] text-mute hover:text-bone" onClick={() => setShowClosed(!showClosed)}>
                {showClosed ? "הסתרת הסגורים" : `הצגת הסגורים · ${won} נסגרו, ${lost} לא רלוונטיים`}
              </button>
              {showClosed && (
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {list.filter((l) => !OPEN_LEAD_STAGES.includes(l.stage)).map((l) => <LeadCard key={l.id} l={l} q={latest.get(l.id)} />)}
                </div>
              )}
            </div>
          )}
        </>
      ) : <QuotesList quotes={quotes.data ?? []} />}

      <Modal open={adding} onClose={() => setAdding(false)} title="ליד חדש"><LeadForm onDone={() => setAdding(false)} /></Modal>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <div className="text-[14px] text-mute">{label}</div>
      <Num className="mt-1 block text-[clamp(22px,2.4vw,30px)] font-semibold leading-tight">{value}</Num>
      {sub && <div className="mt-0.5 text-[13px] text-mute-2">{sub}</div>}
    </Card>
  );
}

// Today's follow-ups first: one tap logs what was done and sets the next date.
function FollowUps({ due, latest }: { due: Lead[]; latest: Map<string, Quote> }) {
  const [touch, setTouch] = useState<Lead | null>(null);
  return (
    <Card>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[22px] font-semibold">מעקב היום</h2>
        <span className="text-[14px] text-mute">{due.length ? `${due.length} מחכים לך` : "הכול מטופל"}</span>
      </div>
      {!due.length ? <p className="text-mute">אין פולואפים להיום. זה זמן טוב לליד חדש.</p> : (
        <ul>
          {due.map((l) => {
            const late = daysBetween(l.next_follow_up_on!, today());
            const q = latest.get(l.id);
            return (
              <li key={l.id} className="row-line flex flex-wrap items-center justify-between gap-3 py-3">
                <Link to={`/leads/${l.id}`} className="min-w-0 flex-1 hover:text-pink-soft">
                  <span className="font-semibold">{l.company || l.name}</span>
                  {l.company && <span className="text-mute"> · {l.name}</span>}
                  <span className="block truncate text-[14px] text-mute">
                    {late > 0 ? <span className="text-pink-soft">באיחור של {late} {late === 1 ? "יום" : "ימים"}</span> : "היום"}
                    {l.follow_up_note ? ` · ${l.follow_up_note}` : ""}
                    {q ? ` · הצעה ${QUOTE_STATUS[quoteState(q)]}${q.view_count ? ` (${q.view_count} צפיות)` : ""}` : ""}
                  </span>
                </Link>
                <div className="flex items-center gap-2">
                  {l.phone && <a href={waLink(l.phone)} target="_blank" rel="noreferrer" className="press rounded-full px-3 py-1.5 text-[14px] text-bone/85 shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-[var(--hover-veil)]">וואטסאפ</a>}
                  <Button variant="ghost" className="!px-4 !py-1.5 text-[14px]" onClick={() => setTouch(l)}><Icon name="check" size={16} />טיפלתי</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={!!touch} onClose={() => setTouch(null)} title={touch ? `מה היה עם ${touch.company || touch.name}?` : ""}>
        {touch && <TouchForm lead={touch} onDone={() => setTouch(null)} />}
      </Modal>
    </Card>
  );
}

// Log a touch (call, message, note) and set when to come back. Used from the list and from the lead page.
export function TouchForm({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  const me = useMe();
  const saveAct = useSave("lead_activities");
  const saveLead = useSave("leads");
  const [kind, setKind] = useState<"call" | "whatsapp" | "email" | "note">("call");
  const [body, setBody] = useState("");
  const [next, setNext] = useState(addDays(today(), 3));
  const [note, setNote] = useState("");
  return (
    <form className="grid gap-4" onSubmit={async (e) => {
      e.preventDefault();
      if (body.trim()) await saveAct.mutateAsync({ values: { lead_id: lead.id, kind, body: body.trim(), partner_id: me?.id ?? null } });
      await saveLead.mutateAsync({ id: lead.id, values: {
        next_follow_up_on: next || null, follow_up_note: note.trim() || null,
        ...(lead.stage === "new" ? { stage: "contacted" } : {}),
      } });
      onDone();
    }}>
      <Segmented label="סוג" value={kind} onChange={setKind} options={[["call", "שיחה"], ["whatsapp", "וואטסאפ"], ["email", "מייל"], ["note", "הערה"]]} />
      <Field label="מה נאמר?"><Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="למשל: ביקש לחשוב עד יום ראשון" /></Field>
      <NextDate value={next} onChange={setNext} />
      <Field label="על מה לחזור"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="לא חובה" /></Field>
      <div className="flex gap-3"><Button arrow className="group" disabled={saveAct.isPending || saveLead.isPending}>שמירה</Button><Button type="button" variant="quiet" onClick={onDone}>ביטול</Button></div>
    </form>
  );
}

export function NextDate({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const picks: [string, number][] = [["מחר", 1], ["עוד 3 ימים", 3], ["שבוע", 7], ["שבועיים", 14]];
  return (
    <Field label="פולואפ הבא" hint="תזכורת מהמזכירה בטלגרם ב-9:00 באותו יום">
      <div className="mb-2 flex flex-wrap gap-2">
        {picks.map(([l, n]) => {
          const d = addDays(today(), n);
          return <button type="button" key={n} onClick={() => onChange(d)}
            className={`press rounded-full px-3 py-1 text-[14px] font-medium shadow-[inset_0_0_0_1px_var(--line-2)] ${value === d ? "bg-pink/15 text-pink-soft" : "text-mute hover:text-bone"}`}>{l}</button>;
        })}
        <button type="button" onClick={() => onChange("")} className={`press rounded-full px-3 py-1 text-[14px] font-medium shadow-[inset_0_0_0_1px_var(--line-2)] ${!value ? "bg-pink/15 text-pink-soft" : "text-mute hover:text-bone"}`}>בלי</button>
      </div>
      <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

// Columns for the open stages. On a computer a card can be dragged to another column.
function Board({ leads, latest, onMove }: { leads: Lead[]; latest: Map<string, Quote>; onMove: (id: string, stage: string) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const cols = LEAD_STAGES.filter(([k]) => OPEN_LEAD_STAGES.includes(k));
  return (
    <div className="-mx-[var(--gutter)] flex snap-x gap-3 overflow-x-auto px-[var(--gutter)] pb-2 no-scrollbar lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0">
      {cols.map(([k, label]) => {
        const mine = leads.filter((l) => l.stage === k);
        return (
          <section key={k} aria-label={label}
            onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver(null)}
            onDrop={(e: DragEvent) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/lead"); if (id) onMove(id, k); }}
            className={`w-[82vw] max-w-[340px] shrink-0 snap-start rounded-[var(--radius-box)] p-2 transition-colors sm:w-[300px] lg:w-auto lg:max-w-none ${over === k ? "bg-pink/10" : "bg-[var(--bezel)]"} shadow-[inset_0_0_0_1px_var(--line)]`}>
            <header className="flex items-baseline justify-between px-2 pb-2 pt-1">
              <h3 className="text-[16px] font-semibold">{label}</h3>
              <Num className="text-[14px] text-mute">{mine.length}</Num>
            </header>
            <div className="grid gap-2">
              {mine.map((l) => <LeadCard key={l.id} l={l} q={latest.get(l.id)} draggable />)}
              {!mine.length && <p className="px-2 py-6 text-center text-[14px] text-mute-2">ריק</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const QUOTE_TONE: Record<string, string> = { viewed: "text-pink-soft", approved: "text-pink-soft", rejected: "text-mute", expired: "text-mute" };

function LeadCard({ l, q, draggable }: { l: Lead; q?: Quote; draggable?: boolean }) {
  const due = l.next_follow_up_on && OPEN_LEAD_STAGES.includes(l.stage) ? daysBetween(today(), l.next_follow_up_on) : null;
  const state = q ? quoteState(q) : null;
  return (
    <Link to={`/leads/${l.id}`} draggable={draggable} onDragStart={(e) => e.dataTransfer.setData("text/lead", l.id)}
      className="press lift block rounded-[var(--radius-inner)] bg-[var(--ink-2)] p-4 shadow-[inset_0_0_0_1px_var(--line)] hover:shadow-[inset_0_0_0_1px_var(--line-2)]">
      <div className="font-semibold leading-snug">{l.company || l.name}</div>
      {l.company && <div className="text-[14px] text-mute">{l.name}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        {(q || l.estimated_value) && <Num className="text-bone">{money(q?.total ?? l.estimated_value)}</Num>}
        {q && state && <span className={`inline-flex items-center gap-1 ${QUOTE_TONE[state] ?? "text-mute"}`}>
          <Icon name={q.kind === "portal" ? "link" : "quote"} size={14} />{QUOTE_STATUS[state]}{q.view_count > 1 ? ` ×${q.view_count}` : ""}
        </span>}
        {due !== null && <span className={due <= 0 ? "text-pink-soft" : "text-mute"}>{due < 0 ? "פולואפ באיחור" : due === 0 ? "פולואפ היום" : `פולואפ ${date(l.next_follow_up_on)}`}</span>}
        {!OPEN_LEAD_STAGES.includes(l.stage) && <Pill>{LEAD_STAGE[l.stage]}</Pill>}
      </div>
    </Link>
  );
}

function QuotesList({ quotes }: { quotes: Quote[] }) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const list = quotes.filter((q) => filter === "all" || ["draft", "sent", "viewed"].includes(quoteState(q)));
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="סינון" value={filter} onChange={setFilter} options={[["open", "פתוחות"], ["all", "הכול"]]} />
      </div>
      {!list.length ? <Empty>אין הצעות {filter === "open" ? "פתוחות" : ""}. הצעה נפתחת מתוך כרטיס ליד.</Empty> : (
        <ul>
          {list.map((q) => {
            const s = quoteState(q);
            return (
              <li key={q.id} className="row-line">
                <Link to={`/quotes/${q.id}`} className="row-btn flex flex-wrap items-center justify-between gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 font-semibold"><Icon name={q.kind === "portal" ? "link" : "quote"} size={16} className="text-mute" />{q.title}</span>
                    <span className="block text-[14px] text-mute">
                      <Num>{q.number}</Num> · {q.leads?.company || q.leads?.name || q.clients?.name || q.recipient_name || "בלי ליד"}
                      {q.sent_at ? ` · נשלחה ${date(q.sent_at)}` : ""}{q.viewed_at ? ` · נצפתה ${q.view_count} פעמים` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <Num className="font-semibold">{money(q.total)}</Num>
                    <span className={`text-[14px] font-medium ${QUOTE_TONE[s] ?? "text-mute"}`}>{QUOTE_STATUS[s]}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export const waLink = (phone: string, text?: string) => {
  const digits = phone.replace(/\D/g, "");
  const intl = digits.startsWith("0") ? `972${digits.slice(1)}` : digits;
  return `https://wa.me/${intl}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
};

export function LeadForm({ lead, onDone }: { lead?: Lead; onDone: (id?: string) => void }) {
  const partners = usePartners();
  const save = useSave("leads");
  const [f, setF] = useState({
    name: lead?.name ?? "", company: lead?.company ?? "", phone: lead?.phone ?? "", email: lead?.email ?? "",
    source: lead?.source ?? "", estimated_value: lead?.estimated_value?.toString() ?? "", owner_partner_id: lead?.owner_partner_id ?? "",
    notes: lead?.notes ?? "", next_follow_up_on: lead ? lead.next_follow_up_on ?? "" : addDays(today(), 1),
  });
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      setError("");
      const values = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]));
      try { await save.mutateAsync({ id: lead?.id, values }); onDone(); }
      catch (err) { setError((err as Error).message); }
    }}>
      <Field label="שם"><Input required value={f.name} onChange={set("name")} /></Field>
      <Field label="עסק / ארגון"><Input value={f.company} onChange={set("company")} /></Field>
      <Field label="טלפון"><Input type="tel" dir="ltr" className="text-start" value={f.phone} onChange={set("phone")} /></Field>
      <Field label="מייל"><Input type="email" dir="ltr" className="text-start" value={f.email} onChange={set("email")} /></Field>
      <Field label="מאיפה הגיע">
        <Select value={f.source} onChange={set("source")}>
          <option value="">לא ידוע</option>
          {LEAD_SOURCES.map((s) => <option key={s}>{s}</option>)}
          {f.source && !LEAD_SOURCES.includes(f.source) && <option>{f.source}</option>}
        </Select>
      </Field>
      <Field label="שווי משוער"><Input type="number" min={0} inputMode="decimal" value={f.estimated_value} onChange={set("estimated_value")} /></Field>
      <Field label="מי מטפלת">
        <Select value={f.owner_partner_id} onChange={set("owner_partner_id")}>
          <option value="">שתינו</option>
          {partners.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </Field>
      {!lead && <Field label="פולואפ ראשון"><Input type="date" value={f.next_follow_up_on} onChange={set("next_follow_up_on")} /></Field>}
      <div className="sm:col-span-2"><Field label="מה הוא צריך"><Textarea value={f.notes} onChange={set("notes")} /></Field></div>
      {error && <p className="sm:col-span-2 text-[14px] text-error">{error}</p>}
      <div className="sm:col-span-2 flex gap-3">
        <Button arrow className="group" disabled={save.isPending}>{lead ? "שמירה" : "הוספה"}</Button>
        <Button type="button" variant="quiet" onClick={() => onDone()}>ביטול</Button>
      </div>
    </form>
  );
}

export { ContactLink };
