// The coaching layer on the home screen: a principle sentence that changes on every visit,
// and the next ritual in the business rhythm (weekly sync, monthly brief, quarterly goals...).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePrinciples, useRituals, useSave, type Principle, type Ritual } from "../lib/data";
import { today } from "../lib/format";
import { Button, Card, Num, Pill } from "./ui";
import { Icon } from "./icons";

const FALLBACK = "מה הדבר האחד שיקדם אותנו הכי הרבה השבוע?";
const LAST_KEY = "arli.lastPrinciple";

export const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
export const CADENCE: Record<Ritual["cadence"], string> = {
  daily: "כל יום עבודה", weekly: "כל שבוע", monthly: "כל חודש", quarterly: "כל רבעון", yearly: "כל שנה",
};

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// When a ritual is today or in its heads-up window, its principles come up more often.
function pick(principles: Principle[], rituals: Ritual[]): Principle | undefined {
  const t = today();
  const near = new Set(rituals.filter((r) => r.active && r.next_on && daysBetween(t, r.next_on) <= Math.max(1, r.lead_days)).map((r) => r.key));
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* private mode */ }
  const pool = principles.filter((p) => p.active && (p.id !== last || principles.length < 2));
  if (!pool.length) return undefined;
  const weight = (p: Principle) => (p.favorite ? 2 : 1) * (p.ritual_key && near.has(p.ritual_key) ? 4 : 1);
  let roll = Math.random() * pool.reduce((s, p) => s + weight(p), 0);
  const chosen = pool.find((p) => (roll -= weight(p)) <= 0) ?? pool[0];
  try { localStorage.setItem(LAST_KEY, chosen.id); } catch { /* ignore */ }
  return chosen;
}

export function PrincipleLine() {
  const principles = usePrinciples();
  const rituals = useRituals();
  const save = useSave("principles");
  const [open, setOpen] = useState(false);
  const ready = principles.isSuccess && rituals.isSuccess;
  // One pick per visit to the home screen.
  const chosenId = useMemo(() => (ready ? pick(principles.data ?? [], rituals.data ?? [])?.id : undefined), [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = principles.data?.find((x) => x.id === chosenId);

  return (
    <div className="mt-4 max-w-[52ch]">
      <div className="flex items-start gap-2">
        <button className="press text-start text-[clamp(18px,1.5vw,22px)] font-light text-mute hover:text-bone" onClick={() => p?.why && setOpen(!open)}
          aria-expanded={open} title={p?.why ? "מה עומד מאחורי המשפט" : undefined}>
          {p?.text ?? (ready ? FALLBACK : " ")}
        </button>
        {p && (
          <button className={`press mt-1 shrink-0 ${p.favorite ? "text-pink" : "text-mute-2 hover:text-mute"}`}
            aria-label={p.favorite ? "להסיר מהמועדפים" : "אהבתי, להציג יותר"} aria-pressed={p.favorite}
            onClick={() => save.mutate({ id: p.id, values: { favorite: !p.favorite } })}>
            <Icon name="star" size={18} fill={p.favorite ? "currentColor" : "none"} />
          </button>
        )}
      </div>
      {open && p?.why && (
        <p className="mt-2 text-[14px] text-mute-2">
          {p.why} <Link to="/rhythm" className="text-pink hover:text-pink-soft">כל היסודות ←</Link>
        </p>
      )}
    </div>
  );
}

export function whenLabel(on: string) {
  const d = daysBetween(today(), on);
  if (d === 0) return "היום";
  if (d === 1) return "מחר";
  const dt = new Date(on + "T12:00:00");
  const day = `יום ${WEEKDAYS[dt.getDay()]}, ${dt.toLocaleDateString("he-IL", { day: "numeric", month: "numeric" })}`;
  return d < 7 ? day : `${day} (בעוד ${d} ימים)`;
}

export function NextRitual() {
  const rituals = useRituals();
  const save = useSave("rituals");
  const t = today();
  const next = (rituals.data ?? [])
    .filter((r) => r.active && r.next_on && !(r.next_on === t && r.last_done_on === t))
    .sort((a, b) => (a.next_on! < b.next_on! ? -1 : a.next_on! > b.next_on! ? 1 : a.sort - b.sort))[0];
  if (!rituals.isSuccess) return null;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] text-mute"><Icon name="rhythm" size={17} className="text-pink" />הטקס הבא בקצב שלנו</div>
          {next ? (
            <>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-[24px] font-semibold">{next.title}</h2>
                <span className="text-[17px] text-pink">{whenLabel(next.next_on!)}</span>
                <span className="text-[14px] text-mute"><Num>{next.at_time.slice(0, 5)}</Num>{next.duration && ` · ${next.duration}`}</span>
              </div>
              {next.description && <p className="mt-2 max-w-[70ch] text-[15px] leading-relaxed text-mute">{next.description}</p>}
            </>
          ) : (
            <p className="mt-2 text-mute">אין טקסים פעילים. אפשר להפעיל אותם בעמוד הקצב.</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {next && next.next_on === t && (
            <Button variant="ghost" className="!py-1.5 text-[14px]" disabled={save.isPending}
              onClick={() => save.mutate({ id: next.id, values: { last_done_on: t } })}>
              <Icon name="check" size={16} />עשינו
            </Button>
          )}
          <Link to="/rhythm" className="text-[15px] text-pink hover:text-pink-soft">הקצב שלנו ←</Link>
        </div>
      </div>
      {next?.source && <div className="mt-3"><Pill>{next.source}</Pill></div>}
    </Card>
  );
}
