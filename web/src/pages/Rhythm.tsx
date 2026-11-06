// "Our rhythm": the business rituals the secretary reminds about, and the principle sentences
// that rotate on the home screen. Both are editable here.
import { useState } from "react";
import { usePrinciples, useRemove, useRituals, useSave, type Principle, type Ritual } from "../lib/data";
import { Button, Card, Field, IconButton, Input, Loading, Modal, Num, PageTitle, Pill, Select, Textarea, useConfirm } from "../components/ui";
import { Icon } from "../components/icons";
import { CADENCE, WEEKDAYS, whenLabel } from "../components/Coaching";

const THEMES: [string, string][] = [["goals", "יעדים ופוקוס"], ["execution", "ביצוע ומשימות"], ["growth", "מוטיבציה וצמיחה"], ["partnership", "שותפות, כסף ולקוחות"]];
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2026, i, 1).toLocaleDateString("he-IL", { month: "long" }));

function whenText(r: Ritual) {
  const day = r.weekday != null ? `יום ${WEEKDAYS[r.weekday]}` : "";
  switch (r.cadence) {
    case "daily": return "ראשון עד חמישי";
    case "weekly": return `כל ${day}`;
    case "monthly": return `${day} הראשון בחודש`;
    case "quarterly": return `${day} האחרון ברבעון`;
    case "yearly": return `${day} השני ב${MONTHS[(r.month ?? 12) - 1]}`;
  }
}

export default function Rhythm() {
  const rituals = useRituals();
  const principles = usePrinciples();
  const save = useSave("rituals");
  const [edit, setEdit] = useState<Ritual | null>(null);
  const [pEdit, setPEdit] = useState<null | { row?: Principle }>(null);

  if (rituals.isLoading || principles.isLoading) return <Loading />;
  return (
    <div className="space-y-10">
      <PageTitle eyebrow="הקצב שלנו" title={<>קצב קבוע, <span className="text-pink">צמיחה קבועה.</span></>} />

      <section className="space-y-3">
        <p className="max-w-[62ch] text-mute">המזכירה שולחת תזכורת לשתיכן בטלגרם ביום ובשעה של כל טקס, ולטקסים הגדולים גם כמה ימים מראש. אפשר לכבות, להזיז או לערוך כל טקס.</p>
        <div className="grid gap-4 md:grid-cols-2">
          {(rituals.data ?? []).map((r) => (
            <Card key={r.id} className={r.active ? "" : "opacity-60"}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[21px] font-semibold">{r.title}</h2>
                  <div className="mt-1 text-[14px] text-mute">
                    {whenText(r)} · <Num>{r.at_time.slice(0, 5)}</Num>{r.duration && ` · ${r.duration}`}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton icon="edit" label={`עריכת ${r.title}`} onClick={() => setEdit(r)} />
                  <button role="switch" aria-checked={r.active} aria-label={`${r.title} פעיל`}
                    onClick={() => save.mutate({ id: r.id, values: { active: !r.active } })}
                    className={`press relative h-7 w-12 rounded-full transition-colors ${r.active ? "bg-pink" : "bg-[var(--ink-3)] shadow-[inset_0_0_0_1px_var(--line-2)]"}`}>
                    <span className={`absolute top-1 size-5 rounded-full bg-bone transition-all ${r.active ? "start-6" : "start-1"}`} />
                  </button>
                </div>
              </div>
              {r.description && <p className="mt-3 text-[15px] leading-relaxed text-mute">{r.description}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-mute-2">
                {r.active && r.next_on && <span>הבא: <span className="text-bone">{whenLabel(r.next_on)}</span></span>}
                {r.lead_days > 0 && <span>· תזכורת <Num>{r.lead_days}</Num> ימים מראש</span>}
                {r.source && <Pill>{r.source}</Pill>}
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[clamp(24px,2.2vw,32px)] font-semibold">משפטי היסוד</h2>
          <Button variant="quiet" className="!text-pink hover:!text-pink-soft" onClick={() => setPEdit({})}><Icon name="plus" size={16} />משפט</Button>
        </div>
        <p className="max-w-[62ch] text-mute">משפט אחד מופיע בכל כניסה למסך הבית. משפטים עם כוכב מופיעים יותר, וסביב כל טקס עולים המשפטים שקשורים אליו.</p>
        <div className="grid gap-6 lg:grid-cols-2">
          {THEMES.map(([theme, label]) => (
            <Card key={theme}>
              <h3 className="mb-2 text-[18px] font-semibold">{label}</h3>
              {(principles.data ?? []).filter((p) => p.theme === theme).map((p) => (
                <PrincipleRow key={p.id} p={p} onEdit={() => setPEdit({ row: p })} />
              ))}
            </Card>
          ))}
        </div>
      </section>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `עריכת ${edit.title}` : ""}>
        {edit && <RitualForm row={edit} onDone={() => setEdit(null)} />}
      </Modal>
      <Modal open={!!pEdit} onClose={() => setPEdit(null)} title={pEdit?.row ? "עריכת משפט" : "משפט חדש"}>
        {pEdit && <PrincipleForm row={pEdit.row} rituals={rituals.data ?? []} onDone={() => setPEdit(null)} />}
      </Modal>
    </div>
  );
}

function PrincipleRow({ p, onEdit }: { p: Principle; onEdit: () => void }) {
  const save = useSave("principles");
  return (
    <div className={`row-line flex items-start gap-2 py-3 ${p.active ? "" : "opacity-50"}`}>
      <button className={`press mt-0.5 shrink-0 ${p.favorite ? "text-pink" : "text-mute-2 hover:text-mute"}`}
        aria-label={p.favorite ? "להסיר כוכב" : "לסמן בכוכב"} aria-pressed={p.favorite}
        onClick={() => save.mutate({ id: p.id, values: { favorite: !p.favorite } })}>
        <Icon name="star" size={17} fill={p.favorite ? "currentColor" : "none"} />
      </button>
      <button className="press min-w-0 flex-1 text-start" onClick={onEdit}>
        <span className="block">{p.text}</span>
        {p.why && <span className="mt-0.5 block text-[13px] text-mute-2">{p.why}</span>}
      </button>
    </div>
  );
}

function RitualForm({ row, onDone }: { row: Ritual; onDone: () => void }) {
  const save = useSave("rituals");
  const [f, setF] = useState({
    title: row.title, description: row.description ?? "", weekday: row.weekday ?? 0, month: row.month ?? 12,
    at_time: row.at_time.slice(0, 5), lead_days: row.lead_days, duration: row.duration ?? "",
  });
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      await save.mutateAsync({ id: row.id, values: {
        title: f.title, description: f.description || null, duration: f.duration || null, at_time: f.at_time, lead_days: Number(f.lead_days),
        weekday: row.cadence === "daily" ? null : Number(f.weekday), month: row.cadence === "yearly" ? Number(f.month) : null,
      } });
      onDone();
    }}>
      <div className="sm:col-span-2"><Field label="שם"><Input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
      {row.cadence !== "daily" && (
        <Field label="יום" hint={CADENCE[row.cadence]}>
          <Select value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>
            {WEEKDAYS.slice(0, 5).map((d, i) => <option key={i} value={i}>{d}</option>)}
          </Select>
        </Field>
      )}
      {row.cadence === "yearly" && (
        <Field label="חודש">
          <Select value={f.month} onChange={(e) => setF({ ...f, month: Number(e.target.value) })}>
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </Select>
        </Field>
      )}
      <Field label="שעה"><Input type="time" required value={f.at_time} onChange={(e) => setF({ ...f, at_time: e.target.value })} /></Field>
      <Field label="תזכורת מראש (ימים)" hint="0 = רק ביום עצמו"><Input type="number" min={0} max={14} value={f.lead_days} onChange={(e) => setF({ ...f, lead_days: Number(e.target.value) })} /></Field>
      <Field label="משך"><Input value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} placeholder="למשל: 30 דקות" /></Field>
      <div className="sm:col-span-2"><Field label="סדר היום (נשלח עם התזכורת)"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="quiet" onClick={onDone}>ביטול</Button>
        <Button type="submit" disabled={save.isPending}>שמירה</Button>
      </div>
    </form>
  );
}

function PrincipleForm({ row, rituals, onDone }: { row?: Principle; rituals: Ritual[]; onDone: () => void }) {
  const save = useSave("principles");
  const remove = useRemove("principles");
  const confirm = useConfirm();
  const [f, setF] = useState({ text: row?.text ?? "", why: row?.why ?? "", theme: row?.theme ?? "goals", ritual_key: row?.ritual_key ?? "", active: row?.active ?? true });
  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      await save.mutateAsync({ id: row?.id, values: { text: f.text, why: f.why || null, theme: f.theme, ritual_key: f.ritual_key || null, active: f.active } });
      onDone();
    }}>
      <div className="sm:col-span-2"><Field label="המשפט"><Textarea required value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field></div>
      <div className="sm:col-span-2"><Field label="מה עומד מאחוריו"><Input value={f.why} onChange={(e) => setF({ ...f, why: e.target.value })} placeholder="היסוד או המקור, בשורה אחת" /></Field></div>
      <Field label="נושא">
        <Select value={f.theme} onChange={(e) => setF({ ...f, theme: e.target.value })}>
          {THEMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      </Field>
      <Field label="קשור לטקס">
        <Select value={f.ritual_key} onChange={(e) => setF({ ...f, ritual_key: e.target.value })}>
          <option value="">כללי</option>
          {rituals.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
        </Select>
      </Field>
      <label className="flex items-center gap-2 sm:col-span-2">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
        <span>מופיע במסך הבית</span>
      </label>
      <div className="flex justify-between gap-2 sm:col-span-2">
        {row ? (
          <Button type="button" variant="quiet" className="!text-mute hover:!text-bone" onClick={async () => {
            if (await confirm({ title: "למחוק את המשפט?", yes: "כן, למחוק" })) { await remove.mutateAsync(row.id); onDone(); }
          }}><Icon name="trash" size={16} />מחיקה</Button>
        ) : <span />}
        <div className="flex gap-2">
          <Button type="button" variant="quiet" onClick={onDone}>ביטול</Button>
          <Button type="submit" disabled={save.isPending}>שמירה</Button>
        </div>
      </div>
    </form>
  );
}
