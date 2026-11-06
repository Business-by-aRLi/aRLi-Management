// One lead: where it stands, the quotes we sent and how they were received, every touch, and the next follow-up.
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useLeadActivities, useLeads, usePartners, useQuotes, useRemove, useSave, type Lead } from "../lib/data";
import { must, supabase } from "../lib/supabase";
import { ACTIVITY_KIND, date, dateTime, daysBetween, LEAD_STAGE, LEAD_STAGES, money, QUOTE_STATUS, quoteState, today } from "../lib/format";
import { Button, Card, Eyebrow, Field, Input, Loading, Modal, Num, Pill, useConfirm } from "../components/ui";
import { Icon } from "../components/icons";
import { ContactLink, LeadForm, NextDate, TouchForm, waLink } from "./Leads";

export default function LeadPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const leads = useLeads();
  const quotes = useQuotes();
  const acts = useLeadActivities(id);
  const save = useSave("leads");
  const remove = useRemove("leads");
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [touch, setTouch] = useState(false);
  const [losing, setLosing] = useState(false);
  const l = leads.data?.find((x) => x.id === id);
  if (leads.isLoading) return <Loading />;
  if (!l) return <p className="text-mute">הליד לא נמצא.</p>;
  const mine = (quotes.data ?? []).filter((q) => q.lead_id === l.id);

  const setStage = async (stage: string) => {
    if (stage === l.stage) return;
    if (stage === "lost") return setLosing(true);
    await save.mutateAsync({ id: l.id, values: { stage } });
  };

  return (
    <div className="space-y-8">
      <header>
        <Link to="/leads" className="text-[15px] text-mute hover:text-bone">→ לידים</Link>
        <Eyebrow>{l.company ? l.name : l.source ? `הגיע דרך ${l.source}` : "ליד"}</Eyebrow>
        <h1 className="mt-1 text-[clamp(34px,5.2vw,72px)] font-semibold leading-[1.05] tracking-[-0.02em]">{l.company || l.name}</h1>
        <div className="mt-4 flex flex-wrap gap-2">
          {l.phone && <ContactLink href={`tel:${l.phone}`} icon="phone"><Num>{l.phone}</Num></ContactLink>}
          {l.phone && <a href={waLink(l.phone)} target="_blank" rel="noreferrer" className="press inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[14px] text-bone/85 shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-[var(--hover-veil)]">וואטסאפ</a>}
          {l.email && <ContactLink href={`mailto:${l.email}`} icon="mail">{l.email}</ContactLink>}
          <Button variant="ghost" className="!px-4 !py-1 text-[14px]" onClick={() => setTouch(true)}><Icon name="plus" size={15} />שיחה / הערה</Button>
        </div>
      </header>

      <StageBar stage={l.stage} onChange={setStage} disabled={save.isPending} />
      {l.stage === "lost" && l.lost_reason && <p className="-mt-4 text-[15px] text-mute">למה: {l.lost_reason}</p>}
      {(l.client_id || l.project_id) && (
        <p className="-mt-4 flex flex-wrap gap-3 text-[15px]">
          {l.client_id && <Link className="text-pink-soft hover:underline" to={`/clients/${l.client_id}`}>כרטיס הלקוח ←</Link>}
          {l.project_id && <Link className="text-pink-soft hover:underline" to={`/projects/${l.project_id}`}>הפרויקט ←</Link>}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          <Card>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[22px] font-semibold">הצעות</h2>
              <div className="flex flex-wrap gap-2">
                <Button className="!px-4 !py-1.5 text-[15px]" onClick={() => nav(`/quotes/new?lead=${l.id}&kind=document`)}><Icon name="quote" size={16} />מסמך הצעה</Button>
                <Button variant="ghost" className="!px-4 !py-1.5 text-[15px]" onClick={() => nav(`/quotes/new?lead=${l.id}&kind=portal`)}><Icon name="link" size={16} />פורטל אינטראקטיבי</Button>
              </div>
            </div>
            {!mine.length ? <p className="text-mute">עוד לא נשלחה הצעה. מסמך מתאים להצעה ישירה, פורטל מתאים כשרוצים שהלקוח יענה ויגלה את ההצעה בעצמו.</p> : (
              <ul>
                {mine.map((q) => {
                  const s = quoteState(q);
                  return (
                    <li key={q.id} className="row-line">
                      <Link to={`/quotes/${q.id}`} className="row-btn flex flex-wrap items-center justify-between gap-3 py-3">
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 font-semibold"><Icon name={q.kind === "portal" ? "link" : "quote"} size={16} className="text-mute" />{q.title}</span>
                          <span className="block text-[14px] text-mute">
                            {q.kind === "portal" ? "פורטל" : "מסמך"} · <Num>{q.number}</Num>
                            {q.sent_at ? ` · נשלחה ${date(q.sent_at)}` : ""}
                            {q.view_count ? ` · נפתחה ${q.view_count} פעמים, לאחרונה ${date(q.viewed_at)}` : q.sent_at ? " · עוד לא נפתחה" : ""}
                            {q.submitted_at ? " · שלח סיכום" : ""}
                          </span>
                        </span>
                        <span className="flex items-center gap-3"><Num className="font-semibold">{money(q.total)}</Num><Pill tone={["viewed", "approved"].includes(s) ? "pink" : "mute"}>{QUOTE_STATUS[s]}</Pill></span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-4 text-[22px] font-semibold">מה היה עד עכשיו</h2>
            {!acts.data?.length ? <p className="text-mute">עוד אין כלום. כל שיחה, הודעה ושינוי בהצעה יופיעו כאן.</p> : (
              <ol className="space-y-4">
                {acts.data.map((a) => (
                  <li key={a.id} className="flex gap-3">
                    <span className={`mt-2 size-2 shrink-0 rounded-full ${a.kind === "quote" ? "bg-pink" : a.kind === "stage" ? "bg-mute-2" : "bg-bone"}`} aria-hidden />
                    <div className="min-w-0">
                      <p className="whitespace-pre-line">{a.body}</p>
                      <p className="text-[13px] text-mute">{ACTIVITY_KIND[a.kind]} · {dateTime(a.created_at)}{a.partners?.name ? ` · ${a.partners.name}` : ""}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <FollowUpCard l={l} />
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[22px] font-semibold">פרטים</h2>
              <Button variant="quiet" onClick={() => setEditing(true)}><Icon name="edit" size={16} />עריכה</Button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[15px]">
              <dt className="text-mute">שווי משוער</dt><dd><Num>{l.estimated_value != null ? money(l.estimated_value) : "—"}</Num></dd>
              <dt className="text-mute">מקור</dt><dd>{l.source ?? "—"}</dd>
              <dt className="text-mute">מטפלת</dt><dd>{l.partners?.name ?? "שתינו"}</dd>
              <dt className="text-mute">נפתח</dt><dd>{date(l.created_at)}</dd>
              <dt className="text-mute">בשלב הזה</dt><dd>{daysBetween(l.stage_changed_at.slice(0, 10), today())} ימים</dd>
            </dl>
            {l.notes && <p className="mt-4 whitespace-pre-line text-[15px]">{l.notes}</p>}
            {l.stage === "won" && !l.client_id && <ConvertToClient l={l} />}
            <button className="mt-6 text-[14px] text-mute hover:text-error" onClick={async () => {
              if (await confirm({ title: `למחוק את ${l.company || l.name}?`, body: "ההיסטוריה של הליד תימחק. הצעות שנשלחו נשארות, בלי שיוך לליד." })) {
                await remove.mutateAsync(l.id); nav("/leads");
              }
            }}>מחיקת הליד</button>
          </Card>
        </div>
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title="עריכת ליד"><LeadForm lead={l} onDone={() => setEditing(false)} /></Modal>
      <Modal open={touch} onClose={() => setTouch(false)} title="שיחה, הודעה או הערה"><TouchForm lead={l} onDone={() => setTouch(false)} /></Modal>
      <Modal open={losing} onClose={() => setLosing(false)} title="למה זה לא התקדם?"><LostForm l={l} onDone={() => setLosing(false)} /></Modal>
    </div>
  );
}

function StageBar({ stage, onChange, disabled }: { stage: string; onChange: (s: string) => void; disabled?: boolean }) {
  const flow = LEAD_STAGES.slice(0, 5);
  const at = flow.findIndex(([k]) => k === stage);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ol className="flex flex-1 basis-[460px] gap-1.5" aria-label="שלב הליד">
        {flow.map(([k, v], i) => (
          <li key={k} className="flex-1">
            <button type="button" disabled={disabled} aria-current={i === at ? "step" : undefined} onClick={() => onChange(k)} className="press group w-full text-start disabled:pointer-events-none">
              <span className={`block h-1.5 rounded-full transition-colors duration-500 ${at >= 0 && i <= at ? "bg-pink" : "bg-[var(--line-2)] group-hover:bg-[var(--mute-2)]"}`} />
              <span className={`mt-2 block text-[14px] font-medium ${i === at ? "text-bone" : "text-mute group-hover:text-bone"}`}>{v}</span>
            </button>
          </li>
        ))}
      </ol>
      <button type="button" disabled={disabled} onClick={() => onChange(stage === "lost" ? "contacted" : "lost")}
        className={`press rounded-full px-3.5 py-1.5 text-[14px] font-medium shadow-[inset_0_0_0_1px_var(--line-2)] ${stage === "lost" ? "bg-[var(--ink-3)] text-bone" : "text-mute hover:text-bone"}`}>
        {stage === "lost" ? "לא רלוונטי · להחזיר" : LEAD_STAGE.lost}
      </button>
    </div>
  );
}

function FollowUpCard({ l }: { l: Lead }) {
  const save = useSave("leads");
  const partners = usePartners();
  const [next, setNext] = useState(l.next_follow_up_on ?? "");
  const [note, setNote] = useState(l.follow_up_note ?? "");
  const dirty = next !== (l.next_follow_up_on ?? "") || note !== (l.follow_up_note ?? "");
  const closed = l.stage === "won" || l.stage === "lost";
  const late = l.next_follow_up_on ? daysBetween(l.next_follow_up_on, today()) : 0;
  return (
    <Card>
      <h2 className="text-[22px] font-semibold">פולואפ</h2>
      {closed ? <p className="mt-2 text-mute">הליד סגור, אין צורך בפולואפ.</p> : (
        <>
          <p className={`mb-4 mt-1 text-[15px] ${late > 0 ? "text-pink-soft" : "text-mute"}`}>
            {l.next_follow_up_on ? (late > 0 ? `באיחור של ${late} ימים` : late === 0 ? "היום" : `ב-${date(l.next_follow_up_on)}`) : "לא נקבע"}
            {l.next_follow_up_on && ` · ${partners.data?.find((p) => p.id === l.owner_partner_id)?.name ?? "לשתיכן"}`}
          </p>
          <div className="grid gap-4">
            <NextDate value={next} onChange={setNext} />
            <Field label="על מה לחזור"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            {dirty && <div><Button arrow className="group" disabled={save.isPending}
              onClick={() => save.mutate({ id: l.id, values: { next_follow_up_on: next || null, follow_up_note: note.trim() || null } })}>שמירה</Button></div>}
          </div>
        </>
      )}
    </Card>
  );
}

function LostForm({ l, onDone }: { l: Lead; onDone: () => void }) {
  const save = useSave("leads");
  const [reason, setReason] = useState("");
  const reasons = ["המחיר", "התזמון", "בחר מישהו אחר", "לא ענה", "לא מתאים לנו"];
  return (
    <form className="grid gap-4" onSubmit={async (e) => { e.preventDefault(); await save.mutateAsync({ id: l.id, values: { stage: "lost", lost_reason: reason.trim() || null } }); onDone(); }}>
      <div className="flex flex-wrap gap-2">
        {reasons.map((r) => <button type="button" key={r} onClick={() => setReason(r)} className={`press rounded-full px-3 py-1 text-[14px] font-medium shadow-[inset_0_0_0_1px_var(--line-2)] ${reason === r ? "bg-pink/15 text-pink-soft" : "text-mute hover:text-bone"}`}>{r}</button>)}
      </div>
      <Field label="במילים שלך" hint="עוזר לנו ללמוד מה לשפר בהצעות הבאות"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex gap-3"><Button arrow className="group" disabled={save.isPending}>סגירת הליד</Button><Button type="button" variant="quiet" onClick={onDone}>ביטול</Button></div>
    </form>
  );
}

// A lead closed by hand (not through an approved quote) can still become a client with a project.
function ConvertToClient({ l }: { l: Lead }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="mt-5 rounded-[18px] bg-pink/10 p-4">
      <p className="text-[15px]">הליד נסגר. להפוך אותו ללקוח עם פרויקט בשלב הקמה?</p>
      {error && <p className="mt-2 text-[14px] text-error">{error}</p>}
      <Button className="mt-3 !px-4 !py-1.5 text-[15px]" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          const name = l.company || l.name;
          const existing = must(await supabase.from("clients").select("id").ilike("name", name).maybeSingle()) as { id: string } | null;
          const client = existing ?? must(await supabase.from("clients").insert({ name, contact_name: l.company ? l.name : null, phone: l.phone, email: l.email }).select("id").single()) as { id: string };
          const project = l.project_id ? { id: l.project_id } : must(await supabase.from("projects")
            .insert({ name, type: "client", status: "setup", client_id: client.id, agreed_price: l.estimated_value, started_on: today() }).select("id").single()) as { id: string };
          must(await supabase.from("leads").update({ client_id: client.id, project_id: project.id }).eq("id", l.id));
          await qc.invalidateQueries();
        } catch (e) { setError(/duplicate|unique/i.test((e as Error).message) ? "כבר יש פרויקט בשם הזה. אפשר לקשר ידנית מכרטיס הפרויקט." : (e as Error).message); }
        finally { setBusy(false); }
      }}>כן, ללקוח ולפרויקט</Button>
    </div>
  );
}
