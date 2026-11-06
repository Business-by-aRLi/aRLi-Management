// The team calendar: week (time grid), month and agenda views over one shared calendar that is synced
// two-way with Google Calendar ("aRLi"). Events have a kind (meeting / work block / not available) and the
// people taking part. Google busy times of each partner show as faint blocks, tasks can be dragged into
// time, and "find a time" suggests slots when both of us are free.
// Navigation: arrows, the keyboard (← next, → previous, as time runs right to left in Hebrew; T today; D/W/M/L views),
// a finger swipe on phones and a two-finger swipe on trackpads. A swipe to the right brings the next period in from the left.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import {
  findFreeSlots, useBusy, useGoogleConnections, useMeetings, usePartners, useRemove, useRituals, useSave, useSyncStatus, useTasks,
  type Busy, type Meeting, type MeetingKind, type Partner, type Slot, type Task,
} from "../lib/data";
import { Button, Card, Eyebrow, Field, IconButton, Modal, Num, Segmented, Select, useConfirm } from "../components/ui";
import { Icon, type IconName } from "../components/icons";
import { MeetingForm, useMe } from "../components/forms";
import { hebDay, hebDayMonth, hebFull, hebRange, holidaysOn, isChag, type Holiday } from "../lib/jewish";

const BOT = "https://t.me/aRLi_Management_bot";
const DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const HOUR_PX = 52;
const FIRST_H = 7;
const LAST_H = 22;

type View = "day" | "week" | "month" | "agenda";
type Layer = "all" | "mine" | "other";
type Draft = { row?: Meeting; startsAt?: string; endsAt?: string; kind?: MeetingKind; taskId?: string; title?: string; projectId?: string; partnerIds?: string[] };

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localInput = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hm = (iso: string) => new Date(iso).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
const dayStart = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const endOf = (m: Meeting) => m.ends_at ?? new Date(new Date(m.starts_at).getTime() + 3600e3).toISOString();

const KIND: Record<MeetingKind, { label: string; icon: IconName; cls: string }> = {
  meeting: { label: "פגישה", icon: "meeting", cls: "bg-pink text-on-pink" },
  focus: { label: "בלוק עבודה", icon: "focus", cls: "bg-[var(--ink-3)] text-bone shadow-[inset_-3px_0_0_var(--pink-soft),inset_0_0_0_1px_var(--line-2)]" },
  away: { label: "לא זמינה", icon: "away", cls: "text-mute shadow-[inset_0_0_0_1px_var(--line-2)] bg-[repeating-linear-gradient(135deg,var(--ink-3)_0_6px,var(--ink-2)_6px_12px)]" },
};

const STEP: Record<View, number> = { day: 1, week: 7, month: 0, agenda: 14 };

// Horizontal swipe to move between periods. The content follows the finger; past the threshold it commits.
// RTL: the next period lies to the left, so a finger moving right pulls it in. Touches that start on an event
// (which has its own drag) or at the very screen edge (the system back gesture) are left alone.
function useSwipe(onShift: (n: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [dx, setDx] = useState(0);
  const cb = useRef(onShift);
  cb.current = onShift;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let sx = 0, sy = 0, t0 = 0, active = false, axis: "" | "x" | "y" = "";
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      active = e.touches.length === 1 && !(e.target as HTMLElement).closest("[data-noswipe]") && t.clientX > 20 && t.clientX < window.innerWidth - 20;
      if (!active) return;
      sx = t.clientX; sy = t.clientY; t0 = Date.now(); axis = "";
    };
    const move = (e: TouchEvent) => {
      if (!active) return;
      const x = e.touches[0].clientX - sx, y = e.touches[0].clientY - sy;
      if (!axis) { if (Math.abs(x) < 10 && Math.abs(y) < 10) return; axis = Math.abs(x) > Math.abs(y) * 1.3 ? "x" : "y"; }
      if (axis === "x") setDx(x);
    };
    const end = (e: TouchEvent) => {
      if (!active) return;
      active = false;
      setDx(0);
      if (axis !== "x") return;
      const x = e.changedTouches[0].clientX - sx;
      const fast = Math.abs(x) / Math.max(1, Date.now() - t0) > 0.45;
      if (Math.abs(x) > 72 || (Math.abs(x) > 32 && fast)) { navigator.vibrate?.(8); cb.current(x > 0 ? 1 : -1); }
    };
    const cancel = () => { active = false; setDx(0); };
    // Trackpad two-finger swipe (horizontal wheel). Natural scrolling: fingers to the right give deltaX < 0.
    let acc = 0, lock = 0;
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 2) { acc = 0; return; }
      e.preventDefault();
      if (Date.now() < lock) return;
      acc += e.deltaX;
      if (Math.abs(acc) > 90) { cb.current(acc < 0 ? 1 : -1); acc = 0; lock = Date.now() + 650; }
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", cancel);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end); el.removeEventListener("touchcancel", cancel); el.removeEventListener("wheel", wheel);
    };
  }, []);
  return { ref, dx };
}

// The label of where a swipe leads, at the edge the new period comes from.
function SwipePeek({ dx, label }: { dx: number; label: string }) {
  if (Math.abs(dx) < 16) return null;
  const ready = Math.abs(dx) > 72;
  return (
    <div aria-hidden className="pointer-events-none absolute top-3 z-30 flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[14px] font-semibold transition-colors duration-200"
      style={{ [dx > 0 ? "left" : "right"]: 8, opacity: Math.min(1, Math.abs(dx) / 72),
        background: ready ? "var(--pink)" : "var(--ink-3)", color: ready ? "var(--on-pink)" : "var(--bone)", boxShadow: "inset 0 0 0 1px var(--line-2), var(--lift-shadow)" }}>
      <Icon name={dx > 0 ? "chevronNext" : "chevronPrev"} size={16} />{label}
    </div>
  );
}

// Phone: the week around the chosen day, one tap to any day, with a dot where something is planned.
function WeekStrip({ anchor, view, events, deadlines, onPick, onWeek }: {
  anchor: Date; view: View; events: Meeting[]; deadlines: Task[]; onPick: (d: Date) => void; onWeek: (n: number) => void;
}) {
  const start = addDays(anchor, -anchor.getDay());
  const todayKey = ymd(new Date());
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div className="mt-1.5 flex items-center gap-0.5">
      <IconButton icon="chevronPrev" size={36} label="השבוע הקודם" onClick={() => onWeek(-1)} />
      <div className="grid flex-1 grid-cols-7">
        {days.map((d) => {
          const key = ymd(d);
          const sel = view === "day" && key === ymd(anchor);
          const n = events.filter((m) => ymd(new Date(m.starts_at)) === key).length;
          const due = deadlines.some((t) => t.due_on === key);
          return (
            <button key={key} type="button" onClick={() => onPick(d)} aria-pressed={sel} aria-current={key === todayKey ? "date" : undefined}
              aria-label={`${d.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })}${n ? `, ${n} אירועים` : ""}${due ? ", דדליין" : ""}`}
              className="press flex flex-col items-center gap-0.5 rounded-[14px] py-1">
              <span className={`text-[12px] ${key === todayKey ? "font-semibold text-pink-soft" : "text-mute"}`}>{DAYS[d.getDay()]}</span>
              <span className={`grid size-9 place-items-center rounded-full text-[16px] transition-colors duration-300 ${sel ? "bg-pink font-semibold text-on-pink" : key === todayKey ? "font-semibold text-pink-soft shadow-[inset_0_0_0_1.5px_var(--pink)]" : "text-bone"}`}><Num>{d.getDate()}</Num></span>
              <span className="flex h-1.5 gap-0.5" aria-hidden>
                {n > 0 && <span className="size-1.5 rounded-full bg-bone/70" />}
                {due && <span className="size-1.5 rounded-full bg-pink" />}
              </span>
            </button>
          );
        })}
      </div>
      <IconButton icon="chevronNext" size={36} label="השבוע הבא" onClick={() => onWeek(1)} />
    </div>
  );
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="mx-0.5 inline-grid min-w-6 place-items-center rounded-[6px] px-1.5 font-sans text-[12px] text-bone shadow-[inset_0_0_0_1px_var(--line-2),inset_0_-1px_0_var(--line-2)]">{children}</kbd>
);

// One line of momentum above the calendar: what is built into this period, and one invitation when it is empty.
function Momentum({ period, focusH, meetings, due, onBlock, compact }: { period: string; focusH: number; meetings: number; due: number; onBlock: () => void; compact?: boolean }) {
  const chip = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[13px] shadow-[inset_0_0_0_1px_var(--line)] sm:gap-2 sm:px-3.5 sm:py-1.5 sm:text-[14px]";
  return (
    <div className="no-scrollbar -mx-[var(--gutter)] flex items-center gap-2 overflow-x-auto px-[var(--gutter)] sm:mx-0 sm:flex-wrap sm:px-0" aria-label={`${period} ביומן`}>
      <span className={`shrink-0 text-[14px] font-medium text-mute ${compact ? "sr-only" : ""}`}>{period}:</span>
      <span className={chip}><Icon name="focus" size={15} className="text-pink-soft" /><Num>{focusH}</Num> שעות עבודה ממוקדת</span>
      <span className={chip}><Icon name="meeting" size={15} className="text-pink-soft" /><Num>{meetings}</Num> פגישות</span>
      {due > 0 && <span className={chip}><Icon name="flag" size={15} className="text-pink-soft" /><Num>{due}</Num> דדליינים</span>}
      {focusH === 0 && (
        <button type="button" onClick={onBlock} className="press inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[14px] font-medium text-pink-soft hover:bg-pink/10">
          <Icon name="plus" size={15} />לחסום זמן לבנייה
        </button>
      )}
    </div>
  );
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export default function CalendarPage() {
  const me = useMe();
  const partners = usePartners();
  const [view, setViewState] = useState<View>(() => (store.get("cal-view") as View) ?? (window.innerWidth < 640 ? "day" : "week"));
  const setView = (v: View) => { setViewState(v); store.set("cal-view", v); setSlide(null); };
  // Which way the content enters after a move, and a key that replays the entrance.
  const [slide, setSlide] = useState<null | "next" | "prev">(null);
  const [navKey, setNavKey] = useState(0);
  const [anchor, setAnchor] = useState(() => dayStart(new Date()));
  const [layer, setLayer] = useState<Layer>("all");
  const [showBusy, setShowBusy] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<Meeting | null>(null);
  const [finder, setFinder] = useState(false);
  const [filters, setFilters] = useState(false);

  // The visible range of each view.
  const range = useMemo(() => {
    if (view === "day") return { from: anchor, days: 1 };
    if (view === "week") { const s = addDays(anchor, -anchor.getDay()); return { from: s, days: 7 }; }
    if (view === "month") { const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1); return { from: addDays(first, -first.getDay()), days: 42 }; }
    return { from: anchor, days: 14 };
  }, [view, anchor]);
  const fromIso = range.from.toISOString();
  const toIso = addDays(range.from, range.days).toISOString();
  // The day view loads its whole week too, so the phone's week strip can show which days are busy.
  const weekFrom = addDays(anchor, -anchor.getDay());
  const qFrom = view === "day" ? weekFrom : range.from;
  const qTo = view === "day" ? addDays(weekFrom, 7).toISOString() : toIso;
  const meetings = useMeetings(new Date(qFrom.getTime() - 864e5).toISOString(), qTo);
  const busy = useBusy(fromIso, toIso);
  const tasks = useTasks();
  const rituals = useRituals();

  const other = partners.data?.find((p) => p.id !== me?.id);
  const inLayer = (ids: string[]) => layer === "all" || !ids?.length || ids.includes(layer === "mine" ? me?.id ?? "" : other?.id ?? "");
  const events = (meetings.data ?? []).filter((m) => inLayer(m.partner_ids));
  const busyShown = showBusy ? (busy.data ?? []).filter((b) => layer === "all" || b.partner_id === (layer === "mine" ? me?.id : other?.id)) : [];
  const deadlines = (tasks.data ?? []).filter((t) => t.due_on && t.status !== "done" && inLayer(t.assignee_partner_id ? [t.assignee_partner_id] : []));
  const ritualDays = (rituals.data ?? []).filter((r) => r.active && r.next_on).map((r) => ({ id: r.id, title: r.title, on: r.next_on! }));

  const target = (n: number) => view === "month" ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1) : addDays(anchor, n * STEP[view]);
  const go = (to: Date, dir: "next" | "prev" | null) => { setSlide(dir); setNavKey((k) => k + 1); setAnchor(to); };
  const shift = (n: number) => go(target(n), n > 0 ? "next" : "prev");
  const goToday = () => { const t = dayStart(new Date()); go(t, t > anchor ? "next" : t < anchor ? "prev" : null); };
  // What a swipe would land on, shown at the edge while the finger moves.
  const peek = (n: number) => {
    const t = target(n);
    if (view === "day") return t.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });
    if (view === "month") return t.toLocaleDateString("he-IL", { month: "long" });
    return n > 0 ? (view === "week" ? "השבוע הבא" : "השבועיים הבאים") : (view === "week" ? "השבוע הקודם" : "השבועיים הקודמים");
  };
  const title = view === "month"
    ? anchor.toLocaleDateString("he-IL", { month: "long", year: "numeric" })
    : view === "day"
      ? anchor.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })
      : `${range.from.toLocaleDateString("he-IL", { day: "numeric", month: "long" })} – ${addDays(range.from, range.days - 1).toLocaleDateString("he-IL", { day: "numeric", month: "long" })}`;
  const isToday = view === "day" && ymd(anchor) === ymd(new Date());
  const blockNew = () => setDraft({ kind: "focus", startsAt: `${ymd(anchor.getTime() < Date.now() ? new Date() : anchor)}T09:00` });
  const hebLabel = view === "day" ? hebFull(anchor) : view === "month" ? hebRange(new Date(anchor.getFullYear(), anchor.getMonth(), 1), new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)) : hebRange(range.from, addDays(range.from, range.days - 1));
  const todayMs = dayStart(new Date()).getTime();
  const onToday = todayMs >= range.from.getTime() && todayMs < new Date(toIso).getTime() && (view !== "month" || anchor.getMonth() === new Date().getMonth());
  const phoneTitle = view === "day"
    ? anchor.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })
    : view === "month" ? title
      : `${range.from.getDate()}–${addDays(range.from, range.days - 1).toLocaleDateString("he-IL", { day: "numeric", month: "long" })}`;

  const swipe = useSwipe(shift);
  // Keyboard: arrows move (RTL), T is today, D/W/M/L switch views. Not while typing or while a dialog is open.
  const keys = useRef({ shift, goToday, setView });
  keys.current = { shift, goToday, setView };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector("[role=dialog]")) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]")) return;
      const k = keys.current;
      const code = e.code;
      if (e.key === "ArrowLeft") k.shift(1);
      else if (e.key === "ArrowRight") k.shift(-1);
      else if (code === "KeyT") k.goToday();
      else if (code === "KeyD") k.setView("day");
      else if (code === "KeyW") k.setView("week");
      else if (code === "KeyM") k.setView("month");
      else if (code === "KeyL") k.setView("agenda");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The period at a glance: framed as momentum, not as load.
  const inRange = events.filter((m) => { const t = new Date(m.starts_at).getTime(); return t >= range.from.getTime() && t < new Date(toIso).getTime(); });
  const focusH = Math.round(inRange.filter((m) => m.kind === "focus" && !m.all_day).reduce((a, m) => a + (new Date(endOf(m)).getTime() - new Date(m.starts_at).getTime()), 0) / 3600e3 * 10) / 10;
  const meetN = inRange.filter((m) => m.kind === "meeting").length;
  const dueN = deadlines.filter((t) => t.due_on! >= ymd(range.from) && t.due_on! < ymd(new Date(toIso))).length;
  const period = { day: isToday ? "היום" : "ביום הזה", week: "בשבוע הזה", month: "בחודש הזה", agenda: "בשבועיים האלה" }[view];

  const save = useSave("meetings");
  const move = (m: Meeting, start: Date) => {
    const len = new Date(endOf(m)).getTime() - new Date(m.starts_at).getTime();
    save.mutate({ id: m.id, values: { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + len).toISOString(), reminded_at: null, followed_up_at: null } });
  };
  // A task dropped on the grid becomes a one-hour work block for whoever it belongs to.
  const blockTask = (t: Task, start: Date) => save.mutate({
    values: {
      title: t.title, kind: "focus", starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600e3).toISOString(),
      project_id: t.project_id, task_id: t.id, partner_ids: [t.assignee_partner_id ?? me?.id].filter(Boolean), created_by_partner_id: me?.id ?? null,
    },
  });

  return (
    // Desktop (lg): the page is exactly one screen tall; only the calendar body scrolls inside it.
    <div className="space-y-4 sm:space-y-6 lg:-mt-8 lg:flex lg:h-[calc(100dvh-10rem)] lg:min-h-[560px] lg:flex-col lg:gap-3 lg:space-y-0">
      {/* Phone: one compact bar that stays on top while the day scrolls, with a week strip to jump between days. */}
      <div className="cal-bar sticky top-0 z-30 -mx-[var(--gutter)] -mt-8 px-[var(--gutter)] pb-2 sm:hidden">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 aria-live="polite" className="truncate text-[22px] font-semibold leading-tight tracking-[-0.01em]">{phoneTitle}</h1>
            <p className="truncate text-[13px] text-mute">{hebLabel}{view === "day" && holidaysOn(ymd(anchor)).length ? ` · ${holidaysOn(ymd(anchor)).map((h) => h.name).join(", ")}` : ""}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {!onToday && <button type="button" onClick={goToday} className="press h-10 rounded-full px-3.5 text-[14px] font-semibold text-bone shadow-[inset_0_0_0_1px_var(--line-2)]">היום</button>}
            <IconButton icon="plus" tone="pink" size={40} label="אירוע חדש" onClick={() => setDraft({ startsAt: `${ymd(anchor.getTime() < Date.now() ? new Date() : anchor)}T09:00` })} />
          </div>
        </div>
        {view !== "month" && (
          <WeekStrip anchor={anchor} view={view} events={events} deadlines={deadlines}
            onPick={(d) => { go(d, d > anchor ? "next" : d < anchor ? "prev" : null); if (view !== "day") setView("day"); }}
            onWeek={(n) => go(addDays(anchor, n * 7), n > 0 ? "next" : "prev")} />
        )}
        {view === "month" && (
          <div className="mt-1.5 flex items-center justify-between">
            <IconButton icon="chevronPrev" size={40} label={`הקודם (${peek(-1)})`} onClick={() => shift(-1)} />
            <span className="text-[14px] text-mute">החליקי לחודש אחר</span>
            <IconButton icon="chevronNext" size={40} label={`הבא (${peek(1)})`} onClick={() => shift(1)} />
          </div>
        )}
      </div>

      {/* Tablet and desktop: title on one side, the period's momentum and the two actions on the other */}
      <div className="hidden shrink-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 sm:flex">
        <div>
          <Eyebrow>יומן משותף · {hebLabel}</Eyebrow>
          <h1 aria-live="polite" className="mt-1 text-[clamp(28px,3vw,40px)] font-semibold leading-[1.1] tracking-[-0.015em]">{title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="lg:hidden"><Momentum period={period} focusH={focusH} meetings={meetN} due={dueN} onBlock={blockNew} /></div>
          <Button variant="ghost" className="!py-2 text-[15px]" onClick={() => setFinder(true)}><Icon name="search" size={16} />מצאי זמן פנוי</Button>
          <Button arrow className="group" onClick={() => setDraft({ startsAt: `${ymd(anchor.getTime() < Date.now() ? new Date() : anchor)}T09:00` })}>אירוע חדש</Button>
        </div>
      </div>

      <div className="sm:hidden"><Momentum period={period} focusH={focusH} meetings={meetN} due={dueN} onBlock={blockNew} /></div>

      {/* The toolbar sits right on top of the calendar: move in time, pick a view, filter. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="מעבר בין תאריכים" className="hidden items-center rounded-full p-0.5 shadow-[inset_0_0_0_1px_var(--line-2)] sm:inline-flex">
            <IconButton icon="chevronPrev" size={40} label={`הקודם (${peek(-1)})`} onClick={() => shift(-1)} />
            <button type="button" onClick={goToday} aria-label="חזרה להיום"
              className="press h-10 rounded-full px-4 text-[15px] font-semibold text-bone transition-colors duration-300 hover:bg-[var(--hover-veil)]">היום</button>
            <IconButton icon="chevronNext" size={40} label={`הבא (${peek(1)})`} onClick={() => shift(1)} />
          </div>
          <Segmented label="תצוגה" value={view} onChange={setView} options={[["day", "יום"], ["week", "שבוע"], ["month", "חודש"], ["agenda", "רשימה"]]} />
          <button type="button" onClick={() => setFilters(!filters)} aria-expanded={filters} aria-controls="cal-filters"
            className="press inline-flex h-10 items-center gap-1 rounded-full px-3 text-[14px] font-medium text-mute shadow-[inset_0_0_0_1px_var(--line)] hover:text-bone sm:hidden">
            סינון<Icon name="chevronDown" size={16} className={`transition-transform duration-300 ${filters ? "rotate-180" : ""}`} />
          </button>
        </div>
        <div id="cal-filters" className={`${filters ? "flex" : "hidden"} w-full flex-wrap items-center justify-between gap-3 sm:flex sm:w-auto sm:flex-1`}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" className="!py-2 text-[15px] sm:!hidden" onClick={() => setFinder(true)}><Icon name="search" size={16} />מצאי זמן פנוי</Button>
          <Segmented label="של מי" value={layer} onChange={setLayer} options={[["all", "שתינו"], ["mine", "שלי"], ["other", other ? `של ${other.name}` : "שלה"]]} />
          <label className="flex items-center gap-2 px-2 text-[14px] text-mute">
            <input type="checkbox" checked={showBusy} onChange={(e) => setShowBusy(e.target.checked)} className="size-4 accent-[var(--pink)]" />
            תפוס מגוגל
          </label>
        </div>
        <div className="lg:hidden"><SyncBar partners={partners.data ?? []} /></div>
        <div className="hidden lg:block"><Momentum compact period={period} focusH={focusH} meetings={meetN} due={dueN} onBlock={blockNew} /></div>
        </div>
      </div>

      <div ref={swipe.ref} className="cal-swipe relative lg:min-h-0 lg:flex-1">
        <SwipePeek dx={swipe.dx} label={swipe.dx > 0 ? peek(1) : peek(-1)} />
        <div className="lg:h-full" style={{ transform: swipe.dx ? `translateX(${swipe.dx * 0.4}px)` : undefined, transition: swipe.dx ? "none" : "transform .3s var(--ease)" }}>
        <div key={`${view}-${navKey}`} className={`lg:h-full ${slide === "next" ? "cal-in-next" : slide === "prev" ? "cal-in-prev" : "animate-fade"}`}>
      {(view === "week" || view === "day") && (
        <div className="grid gap-6 lg:h-full lg:grid-cols-[1fr_260px] lg:grid-rows-[minmax(0,1fr)]">
          <WeekGrid days={Array.from({ length: range.days }, (_, i) => addDays(range.from, i))} onDayOpen={view === "week" ? (d) => { go(d, null); setView("day"); } : undefined} events={events} busy={busyShown}
            deadlines={deadlines} rituals={ritualDays} partners={partners.data ?? []}
            onSlot={(d) => setDraft({ startsAt: localInput(d) })} onOpen={setOpen} onMove={move}
            onDropTask={(id, d) => { const t = tasks.data?.find((x) => x.id === id); if (t) blockTask(t, d); }} />
          <TaskTray tasks={(tasks.data ?? []).filter((t) => t.status !== "done")} scheduled={new Set(events.map((m) => m.task_id).filter(Boolean) as string[])}
            onPick={(t) => setDraft({ kind: "focus", title: t.title, taskId: t.id, projectId: t.project_id ?? undefined, startsAt: `${ymd(new Date())}T09:00`, partnerIds: t.assignee_partner_id ? [t.assignee_partner_id] : undefined })} />
        </div>
      )}
      {view === "month" && <MonthGrid from={range.from} month={anchor.getMonth()} events={events} deadlines={deadlines} rituals={ritualDays}
        onDay={(d) => { go(d, null); setView("day"); }} onOpen={setOpen} />}
      {view === "agenda" && <Agenda from={range.from} days={range.days} events={events} deadlines={deadlines} rituals={ritualDays}
        partners={partners.data ?? []} onOpen={setOpen} onNew={(d) => setDraft({ startsAt: `${ymd(d)}T09:00` })} />}
        </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <Legend partners={partners.data ?? []} />
        <div className="hidden lg:block"><SyncBar partners={partners.data ?? []} /></div>
      </div>
      <p className="text-[13px] text-mute lg:hidden">מחליקים ימינה לתקופה הבאה ושמאלה לקודמת.</p>

      <Modal open={!!draft} onClose={() => setDraft(null)} title={draft?.row ? "עריכת אירוע" : draft?.kind === "focus" ? "בלוק עבודה" : "אירוע חדש"}>
        {draft && <MeetingForm key={draft.row?.id ?? `${draft.startsAt}-${draft.taskId}`} row={draft.row} startsAt={draft.startsAt} endsAt={draft.endsAt}
          kind={draft.kind} taskId={draft.taskId} title={draft.title} projectId={draft.projectId} partnerIds={draft.partnerIds} onDone={() => setDraft(null)} />}
      </Modal>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.title ?? ""}>
        {open && <EventDetail m={open} partners={partners.data ?? []} onEdit={() => { setDraft({ row: open }); setOpen(null); }} onClose={() => setOpen(null)} />}
      </Modal>
      <Modal open={finder} onClose={() => setFinder(false)} title="מתי אנחנו פנויות?">
        <FreeFinder partners={partners.data ?? []} onPick={(s, who) => { setFinder(false); setDraft({ startsAt: localInput(new Date(s.starts_at)), endsAt: localInput(new Date(s.ends_at)), partnerIds: who ? [who] : undefined }); }} />
      </Modal>
    </div>
  );
}

// ---------- connection status ----------
function SyncBar({ partners }: { partners: Partner[] }) {
  const conns = useGoogleConnections();
  const status = useSyncStatus();
  const connected = (id: string) => conns.data?.find((c) => c.partner_id === id)?.calendar;
  const last = status.data?.last_pull ? Math.max(0, Math.round((Date.now() - new Date(status.data.last_pull).getTime()) / 60000)) : null;
  const allOn = partners.length > 0 && partners.every((p) => connected(p.id));
  return (
    <div className="flex flex-wrap items-center gap-2 text-[14px]">
      <span className={`inline-flex items-center gap-1.5 ${status.data?.last_error ? "text-pink-soft" : "text-mute"}`} title={status.data?.last_error ?? undefined}>
        <Icon name="sync" size={16} />
        {status.data?.calendar_id
          ? status.data.last_error ? "בעיה בסנכרון עם Google" : `מסונכרן עם Google${last !== null ? ` · לפני ${last < 1 ? "רגע" : `${last} דק׳`}` : ""}`
          : "Google Calendar עוד לא מחובר"}
      </span>
      {partners.map((p) => (
        <span key={p.id} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] ${connected(p.id) ? "bg-pink/15 text-pink-soft" : "text-mute shadow-[inset_0_0_0_1px_var(--line-2)]"}`}>
          <span className="size-2 rounded-full" style={{ background: whoColor(p.id, partners) }} aria-hidden />{p.name}{connected(p.id) ? " ✓" : ""}
        </span>
      ))}
      {!allOn && <a href={`${BOT}?start=google`} target="_blank" rel="noreferrer" className="text-pink hover:text-pink-soft">חיבור דרך הבוט ←</a>}
    </div>
  );
}

function Legend({ partners }: { partners: Partner[] }) {
  return (
    <div className="flex flex-wrap gap-4 text-[13px] text-mute">
      {(Object.keys(KIND) as MeetingKind[]).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5"><span className={`inline-block h-3 w-5 rounded-[4px] ${KIND[k].cls}`} />{KIND[k].label}</span>
      ))}
      {partners.map((p) => {
        const c = whoColor(p.id, partners);
        return (
          <span key={p.id} className="inline-flex items-center gap-1.5" title={`תפוס ביומן הגוגל האישי של ${p.name}`}>
            <span className="inline-block h-3 w-5 rounded-[4px]" style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, boxShadow: `inset -3px 0 0 ${c}` }} />{p.name}, יומן אישי
          </span>
        );
      })}
      <span className="inline-flex items-center gap-1.5 text-pink-soft"><Icon name="flag" size={13} />דדליין</span>
      <span className="inline-flex items-center gap-1.5"><Icon name="rhythm" size={13} />טקס עסקי</span>
    </div>
  );
}

// Each partner's personal Google calendar has its own colour (tokens --who-1 / --who-2, light and dark).
const whoColor = (id: string, partners: Partner[]) => `var(--who-${(Math.max(0, partners.findIndex((p) => p.id === id)) % 2) + 1})`;

// A holiday line: quieter than events, a little brighter for a yom tov.
function HolidayLine({ h, size = 12 }: { h: Holiday; size?: number }) {
  return (
    <div className={`flex items-center gap-1 truncate ${h.chag ? "font-medium text-bone" : "text-mute"}`} style={{ fontSize: size }}>
      <Icon name="star" size={size} className="shrink-0 text-pink-soft" /><span className="truncate">{h.name}</span>
    </div>
  );
}

const initials = (ids: string[], partners: Partner[]) =>
  ids?.length ? ids.map((id) => partners.find((p) => p.id === id)?.name?.[0] ?? "").join("") : "";

// ---------- week ----------
type Placed = { m: Meeting; top: number; height: number; col: number; cols: number };

// Lay out one day's timed events: overlapping events share the width side by side.
function layoutDay(list: Meeting[], day: Date): Placed[] {
  const base = new Date(day); base.setHours(FIRST_H, 0, 0, 0);
  const items = list.map((m) => {
    const s = Math.max(new Date(m.starts_at).getTime(), base.getTime());
    const e = Math.min(new Date(endOf(m)).getTime(), base.getTime() + (LAST_H - FIRST_H) * 3600e3);
    return { m, s, e: Math.max(e, s + 20 * 60e3) };
  }).filter((x) => x.s < base.getTime() + (LAST_H - FIRST_H) * 3600e3).sort((a, b) => a.s - b.s || b.e - a.e);
  const out: Placed[] = [];
  let cluster: (typeof items[number] & { col: number })[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) out.push({ m: c.m, top: ((c.s - base.getTime()) / 3600e3) * HOUR_PX, height: ((c.e - c.s) / 3600e3) * HOUR_PX, col: c.col, cols });
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.e > it.s).map((c) => c.col));
    let col = 0; while (used.has(col)) col++;
    cluster.push({ ...it, col });
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return out;
}

function WeekGrid({ days, events, busy, deadlines, rituals, partners, onSlot, onOpen, onMove, onDropTask, onDayOpen }: {
  onDayOpen?: (d: Date) => void;
  days: Date[]; events: Meeting[]; busy: Busy[]; deadlines: Task[]; rituals: { id: string; title: string; on: string }[]; partners: Partner[];
  onSlot: (d: Date) => void; onOpen: (m: Meeting) => void; onMove: (m: Meeting, start: Date) => void; onDropTask: (taskId: string, start: Date) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: Math.max(0, (Math.min(now.getHours(), 17) - FIRST_H - 1) * HOUR_PX) }); }, []);
  const [drag, setDrag] = useState<null | { id: string; x: number; y: number; dx: number; dy: number; colW: number }>(null);
  const hours = Array.from({ length: LAST_H - FIRST_H }, (_, i) => FIRST_H + i);
  const todayKey = ymd(now);
  const single = days.length === 1;
  const cols = { gridTemplateColumns: `var(--cal-gutter) repeat(${days.length}, minmax(0, 1fr))` };
  const who = (ids: string[]) => ids?.length ? ids.map((id) => partners.find((p) => p.id === id)?.name).filter(Boolean).join(" ו") : "שתינו";

  // 15-minute steps; RTL, so moving the pointer left means a later day.
  const dragShift = (d: NonNullable<typeof drag>) => ({ days: -Math.round(d.dx / d.colW), minutes: Math.round(((d.dy / HOUR_PX) * 60) / 15) * 15 });
  const timeAt = (day: Date, offsetY: number) => {
    const mins = Math.max(0, Math.round(((offsetY / HOUR_PX) * 60) / 30) * 30);
    const d = new Date(day); d.setHours(FIRST_H, 0, 0, 0); d.setMinutes(mins); return d;
  };

  // On a touch screen a finger on an event scrolls the day or swipes to the next one, and a tap opens it;
  // moving it is done in the form. Dragging is for mouse and pen.
  const touchTap = useRef(false);
  function startDrag(e: ReactPointerEvent, m: Meeting) {
    touchTap.current = e.pointerType === "touch";
    if (touchTap.current || e.button !== 0) return;
    const col = (e.currentTarget as HTMLElement).closest("[data-day]") as HTMLElement | null;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: m.id, x: e.clientX, y: e.clientY, dx: 0, dy: 0, colW: col?.offsetWidth ?? 100 });
  }
  function endDrag(m: Meeting) {
    if (!drag) return;
    const moved = Math.abs(drag.dx) > 4 || Math.abs(drag.dy) > 4;
    const { days: dd, minutes } = dragShift(drag);
    setDrag(null);
    if (!moved) { onOpen(m); return; }
    if (dd === 0 && minutes === 0) return;
    const s = new Date(m.starts_at); s.setDate(s.getDate() + dd); s.setMinutes(s.getMinutes() + minutes);
    onMove(m, s);
  }

  return (
    <div className="bezel lg:h-full lg:min-h-0"><div className="core flex min-h-0 flex-col overflow-hidden !p-0">
      <div className="flex min-h-0 flex-1 flex-col [--cal-gutter:44px] sm:[--cal-gutter:56px]">
        <div className="flex min-h-0 flex-1 flex-col">
          {/* day headers + all-day row */}
          <div className="grid shrink-0 border-b border-[var(--line)]" style={cols}>
            <div />
            {days.map((d) => {
              const key = ymd(d);
              const allDay = events.filter((m) => m.all_day && ymd(new Date(m.starts_at)) <= key && ymd(new Date(endOf(m))) >= key);
              const due = deadlines.filter((t) => t.due_on === key);
              const rit = rituals.filter((r) => r.on === key);
              const hol = holidaysOn(key);
              return (
                <div key={key} className={`min-w-0 px-1 pb-1 pt-1 sm:pb-2 sm:pt-3 ${key === todayKey ? "bg-pink/[.06]" : ""}`}>
                  {(() => {
                    const label = d.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });
                    const inner = (<>
                      <span className={key === todayKey ? "font-semibold text-pink-soft" : ""}>{single ? d.toLocaleDateString("he-IL", { weekday: "long" }) : DAYS[d.getDay()]}</span>
                      <span className={`inline-grid size-8 place-items-center rounded-full text-[15px] ${key === todayKey ? "bg-pink font-semibold text-on-pink" : "text-bone"}`}><Num>{d.getDate()}</Num></span>
                      <span className="text-[11px] text-mute-2" aria-hidden>{single ? hebDayMonth(d) : hebDay(d)}</span>
                    </>);
                    const cls = `hidden sm:flex mx-auto mb-1.5 flex-col items-center gap-0.5 rounded-[12px] px-1 py-0.5 text-[13px] text-mute sm:flex-row sm:justify-center sm:gap-1.5 sm:text-[14px]`;
                    return onDayOpen
                      ? <button type="button" onClick={() => onDayOpen(d)} aria-label={`${label}, פתיחת היום`} aria-current={key === todayKey ? "date" : undefined} className={`press ${cls} hover:bg-[var(--hover-veil)]`}>{inner}</button>
                      : <div className={cls} aria-current={key === todayKey ? "date" : undefined}>{inner}</div>;
                  })()}
                  <div className="space-y-0.5">
                    {allDay.map((m) => (
                      <button key={m.id} onClick={() => onOpen(m)} aria-label={`${KIND[m.kind].label}, כל היום: ${m.title}`} className={`press block w-full truncate rounded-[6px] px-1.5 py-0.5 text-start text-[12px] ${KIND[m.kind].cls}`}>{m.title}</button>
                    ))}
                    {hol.map((h) => <HolidayLine key={h.name} h={h} />)}
                    {rit.map((r) => <div key={r.id} className="flex items-center gap-1 truncate text-[12px] text-mute"><Icon name="rhythm" size={12} className="shrink-0" /><span className="truncate">{r.title}</span></div>)}
                    {due.map((t) => <Link key={t.id} to="/tasks" className="flex items-center gap-1 truncate text-[12px] text-pink-soft"><Icon name="flag" size={12} className="shrink-0" /><span className="truncate">{t.title}</span></Link>)}
                  </div>
                </div>
              );
            })}
          </div>
          {/* time grid */}
          <div ref={scroller} className="sm:max-h-[68vh] sm:overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1">
            <div className="relative grid" style={{ ...cols, height: hours.length * HOUR_PX }}>
              <div className="relative">
                {hours.map((h, i) => <div key={h} className="absolute inset-x-0 pe-1.5 text-end text-[12px] text-mute sm:pe-2" style={{ top: i * HOUR_PX - 8 }}>{i > 0 && <Num>{`${pad(h)}:00`}</Num>}</div>)}
              </div>
              {days.map((d) => {
                const key = ymd(d);
                const placed = layoutDay(events.filter((m) => !m.all_day && ymd(new Date(m.starts_at)) === key), d);
                const base = new Date(d); base.setHours(FIRST_H, 0, 0, 0);
                const dayBusy = busy.filter((b) => ymd(new Date(b.starts_at)) === key || ymd(new Date(b.ends_at)) === key);
                const nowTop = key === todayKey ? ((now.getTime() - base.getTime()) / 3600e3) * HOUR_PX : -1;
                // Time already behind us today, and days already gone, sit under a quiet veil so the eye goes forward.
                const pastH = key < todayKey ? hours.length * HOUR_PX : key === todayKey ? Math.max(0, Math.min(hours.length * HOUR_PX, nowTop)) : 0;
                return (
                  <div key={key} data-day={key}
                    className={`relative border-s border-[var(--line)] ${d.getDay() === 6 || isChag(key) ? "bg-[var(--hover-veil)]" : key === todayKey ? "bg-pink/[.035]" : ""}`}
                    style={{ backgroundImage: `repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px ${HOUR_PX}px)` }}
                    onClick={(e) => { if (e.target === e.currentTarget) onSlot(timeAt(d, e.nativeEvent.offsetY)); }}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes("text/task")) e.preventDefault(); }}
                    onDrop={(e) => {
                      const id = e.dataTransfer.getData("text/task"); if (!id) return;
                      e.preventDefault();
                      const top = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
                      onDropTask(id, timeAt(d, e.clientY - top));
                    }}>
                    {pastH > 0 && <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 bg-[var(--ink)] opacity-40" style={{ height: pastH }} />}
                    {dayBusy.map((b, i) => {
                      const s = Math.max(new Date(b.starts_at).getTime(), base.getTime());
                      const e = Math.min(new Date(b.ends_at).getTime(), base.getTime() + hours.length * 3600e3);
                      if (e <= s) return null;
                      const name = partners.find((p) => p.id === b.partner_id)?.name ?? "";
                      const c = whoColor(b.partner_id, partners);
                      return (
                        <div key={i} className="pointer-events-none absolute inset-x-0.5 overflow-hidden rounded-[6px] px-1.5 pt-0.5 text-[12px] font-medium leading-tight"
                          style={{ top: ((s - base.getTime()) / 3600e3) * HOUR_PX, height: ((e - s) / 3600e3) * HOUR_PX,
                            background: `color-mix(in srgb, ${c} 16%, transparent)`, color: `color-mix(in srgb, ${c} 70%, var(--bone))`,
                            boxShadow: `inset -3px 0 0 ${c}, inset 0 0 0 1px color-mix(in srgb, ${c} 30%, transparent)` }}>{name} · ביומן האישי</div>
                      );
                    })}
                    {placed.map(({ m, top, height, col, cols }) => {
                      const dragging = drag?.id === m.id;
                      const ini = initials(m.partner_ids, partners);
                      return (
                        <button key={m.id}
                          onClick={() => { if (touchTap.current) { touchTap.current = false; onOpen(m); } }}
                          aria-label={`${KIND[m.kind].label}: ${m.title}, ${hm(m.starts_at)} עד ${hm(endOf(m))}, ${who(m.partner_ids)}${m.projects?.name ? `, ${m.projects.name}` : ""}`}
                          onPointerDown={(e) => startDrag(e, m)}
                          onPointerMove={(e) => dragging && setDrag({ ...drag!, dx: e.clientX - drag!.x, dy: e.clientY - drag!.y })}
                          onPointerUp={() => endDrag(m)}
                          onPointerCancel={() => setDrag(null)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(m); } }}
                          className={`absolute overflow-hidden [@media(pointer:fine)]:touch-none rounded-[8px] px-1.5 py-1 text-start text-[12px] leading-tight transition-shadow ${KIND[m.kind].cls} ${dragging ? "z-20 cursor-grabbing opacity-90 shadow-[var(--lift-shadow)]" : "z-10 cursor-grab hover:brightness-[1.06]"}`}
                          style={{
                            top: top + 1, height: Math.max(20, height - 2),
                            insetInlineStart: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)`,
                            transform: dragging ? `translate(${drag!.dx}px, ${drag!.dy}px)` : undefined,
                          }}>
                          <div className="flex items-start justify-between gap-1">
                            <span className="truncate font-semibold">{m.title}</span>
                            {ini && <span className="hidden shrink-0 text-[11px] opacity-80 sm:inline">{ini}</span>}
                          </div>
                          {height > 34 && <div className={`truncate opacity-80 ${single ? "" : "hidden sm:block"}`}><Num>{hm(m.starts_at)}</Num>{m.meet_link ? " · Meet" : m.location ? ` · ${m.location}` : ""}</div>}
                          {height > 52 && m.projects?.name && <div className="truncate opacity-70">{m.projects.name}</div>}
                        </button>
                      );
                    })}
                    {nowTop >= 0 && nowTop <= hours.length * HOUR_PX && (
                      <div className="pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-pink" style={{ top: nowTop }} aria-hidden>
                        <span className="absolute -top-1 -start-1 size-2.5 rounded-full bg-pink shadow-[0_0_0_3px_color-mix(in_srgb,var(--pink)_25%,transparent)]" />
                        {single && <span className="absolute -top-2.5 end-1 rounded-full bg-pink px-1.5 text-[11px] font-semibold leading-5 text-on-pink"><Num>{hm(now.toISOString())}</Num></span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[var(--line)] px-4 py-2 text-[13px] text-mute">
      <p title="אפשר גם לפתוח אירוע ולשנות את השעה בטופס.">לחיצה על שעה פנויה יוצרת אירוע · גוררים אירוע כדי להזיז{single ? "" : " · לחיצה על יום פותחת אותו"}</p>
      <p className="hidden lg:block" title="אפשר גם להחליק בשתי אצבעות על משטח המגע"><Kbd>←</Kbd><Kbd>→</Kbd> מעבר <Kbd>T</Kbd> היום <Kbd>D</Kbd><Kbd>W</Kbd><Kbd>M</Kbd><Kbd>L</Kbd> תצוגות</p>
      </div>
    </div></div>
  );
}

// Open tasks to block into time: drag onto the week, or tap to open the form.
function TaskTray({ tasks, scheduled, onPick }: { tasks: Task[]; scheduled: Set<string>; onPick: (t: Task) => void }) {
  const list = tasks.filter((t) => !scheduled.has(t.id)).sort((a, b) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999") || a.priority - b.priority).slice(0, 12);
  return (
    <Card className="h-fit lg:max-h-full lg:min-h-0 [&>.core]:min-h-0 [&>.core]:overflow-y-auto">
      <h2 className="text-[18px] font-semibold">לשבץ ביומן</h2>
      <p className="mb-3 mt-1 text-[14px] text-mute">משימה שיש לה זמן ביומן נעשית. גררי לשעה, או לחצי.</p>
      {!list.length && <p className="text-[14px] text-mute">כל המשימות הפתוחות כבר משובצות.</p>}
      <div className="space-y-1.5">
        {list.map((t) => (
          <button key={t.id} draggable onDragStart={(e) => { e.dataTransfer.setData("text/task", t.id); e.dataTransfer.effectAllowed = "copy"; }}
            onClick={() => onPick(t)}
            className="press flex w-full cursor-grab items-center gap-2 rounded-[10px] px-3 py-2 text-start text-[14px] shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-[var(--hover-veil)]">
            <Icon name="focus" size={15} className="shrink-0 text-pink-soft" />
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            {t.due_on && <span className="shrink-0 text-[12px] text-mute"><Num>{new Date(`${t.due_on}T12:00`).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" })}</Num></span>}
          </button>
        ))}
      </div>
    </Card>
  );
}

// ---------- month ----------
function MonthGrid({ from, month, events, deadlines, rituals, onDay, onOpen }: {
  from: Date; month: number; events: Meeting[]; deadlines: Task[]; rituals: { id: string; title: string; on: string }[];
  onDay: (d: Date) => void; onOpen: (m: Meeting) => void;
}) {
  const todayKey = ymd(new Date());
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  return (
    <Card className="lg:h-full [&>.core]:flex [&>.core]:min-h-0 [&>.core]:flex-col">
      <div className="grid grid-cols-7 gap-1 text-center text-[14px] font-medium text-mute" aria-hidden>{DAYS.map((d) => <div key={d} className="py-1">{d}</div>)}</div>
      <div className="grid grid-cols-7 gap-1 lg:min-h-0 lg:flex-1 lg:grid-rows-6">
        {days.map((d) => {
          const key = ymd(d);
          const list = events.filter((m) => ymd(new Date(m.starts_at)) === key || (m.all_day && ymd(new Date(m.starts_at)) <= key && ymd(new Date(endOf(m))) >= key));
          const due = deadlines.filter((t) => t.due_on === key);
          const rit = rituals.filter((r) => r.on === key);
          const hol = holidaysOn(key);
          return (
            // The cell is clickable with a pointer; the date button is the keyboard and screen-reader way in,
            // so the event buttons inside are not nested in another button.
            <div key={key} onClick={() => onDay(d)}
              className={`flex min-h-[64px] cursor-pointer flex-col items-start overflow-hidden rounded-[12px] p-1.5 text-start transition-colors duration-300 hover:bg-[var(--hover-veil)] sm:min-h-[104px] lg:min-h-0 ${key === todayKey ? "bg-pink/[.07] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--pink)_35%,transparent)]" : d.getDay() === 6 || isChag(key) ? "bg-[var(--hover-veil)]" : ""} ${d.getMonth() === month ? "" : "opacity-45"}`}>
              <div className="flex w-full items-center justify-between gap-1">
              <button type="button" onClick={(e) => { e.stopPropagation(); onDay(d); }} aria-current={key === todayKey ? "date" : undefined}
                aria-label={`${d.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })}, ${hebDayMonth(d)}${hol.length ? `, ${hol.map((h) => h.name).join(", ")}` : ""}${list.length ? `, ${list.length} אירועים` : ""}${due.length ? `, ${due.length} דדליינים` : ""}`}
                className={`press inline-grid size-8 place-items-center rounded-full text-[14px] hover:bg-[var(--hover-veil)] ${key === todayKey ? "bg-pink font-semibold text-on-pink hover:bg-pink-hover" : ""}`}><Num>{d.getDate()}</Num></button>
              <span aria-hidden className="ms-0.5 text-[11px] leading-none text-mute-2 sm:ms-1">{hebDay(d)}</span>
              </div>
              <div className="mt-1 hidden w-full min-w-0 space-y-0.5 sm:block">
                {hol.slice(0, 1).map((h) => <HolidayLine key={h.name} h={h} />)}
                {list.slice(0, 3).map((m) => (
                  <button key={m.id} onClick={(e) => { e.stopPropagation(); onOpen(m); }} aria-label={`${KIND[m.kind].label}: ${m.title}${m.all_day ? ", כל היום" : `, ${hm(m.starts_at)}`}`} className={`block w-full truncate rounded-[5px] px-1 text-start text-[12px] ${KIND[m.kind].cls}`}>
                    {!m.all_day && <Num className="me-1 opacity-85">{hm(m.starts_at)}</Num>}{m.title}
                  </button>
                ))}
                {list.length > 3 && <div className="text-[12px] text-mute">+{list.length - 3}</div>}
                {rit.slice(0, 1).map((r) => <div key={r.id} className="flex items-center gap-1 truncate text-[12px] text-mute"><Icon name="rhythm" size={12} className="shrink-0" /><span className="truncate">{r.title}</span></div>)}
                {due.slice(0, 1).map((t) => <div key={t.id} className="flex items-center gap-1 truncate text-[12px] text-pink-soft"><Icon name="flag" size={12} className="shrink-0" /><span className="truncate">{t.title}</span></div>)}
              </div>
              <div className="mt-1 flex gap-0.5 sm:hidden" aria-hidden>
                {list.some((m) => m.kind === "meeting") && <span className="size-1.5 rounded-full bg-pink" />}
                {list.some((m) => m.kind !== "meeting") && <span className="size-1.5 rounded-full bg-bone" />}
                {due.length > 0 && <span className="size-1.5 rounded-full bg-pink-soft" />}
                {hol.length > 0 && <Icon name="star" size={8} className="text-pink-soft" />}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------- agenda ----------
function Agenda({ from, days, events, deadlines, rituals, partners, onOpen, onNew }: {
  from: Date; days: number; events: Meeting[]; deadlines: Task[]; rituals: { id: string; title: string; on: string }[]; partners: Partner[];
  onOpen: (m: Meeting) => void; onNew: (d: Date) => void;
}) {
  const list = Array.from({ length: days }, (_, i) => addDays(from, i));
  return (
    <Card className="lg:h-full [&>.core]:min-h-0 [&>.core]:overflow-y-auto">
      {list.map((d) => {
        const key = ymd(d);
        const evs = events.filter((m) => ymd(new Date(m.starts_at)) === key || (m.all_day && ymd(new Date(m.starts_at)) <= key && ymd(new Date(endOf(m))) >= key));
        const due = deadlines.filter((t) => t.due_on === key);
        const rit = rituals.filter((r) => r.on === key);
        const hol = holidaysOn(key);
        const empty = !evs.length && !due.length && !rit.length && !hol.length;
        return (
          <section key={key} className="row-line py-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className={`text-[16px] font-semibold ${key === ymd(new Date()) ? "text-pink" : ""}`}>{d.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })}
                <span className="ms-2 text-[13px] font-normal text-mute">{hebDayMonth(d)}</span></h3>
              <IconButton icon="plus" label="אירוע ביום הזה" onClick={() => onNew(d)} />
            </div>
            {empty && <p className="text-[14px] text-mute">{d.getDay() === 6 ? "שבת שלום" : "יום פתוח. מקום טוב לבלוק עבודה."}</p>}
            <div className="space-y-1.5">
              {hol.map((h) => <div key={h.name} className="px-2"><HolidayLine h={h} size={14} /></div>)}
              {evs.map((m) => (
                <button key={m.id} onClick={() => onOpen(m)} className="press flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-start hover:bg-[var(--hover-veil)]">
                  <span className={`grid size-8 shrink-0 place-items-center rounded-[8px] ${KIND[m.kind].cls}`}><Icon name={KIND[m.kind].icon} size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.title}</span>
                    <span className="block truncate text-[13px] text-mute">
                      {m.all_day ? "כל היום" : <Num>{`${hm(m.starts_at)}–${hm(endOf(m))}`}</Num>}
                      {m.partner_ids?.length ? ` · ${m.partner_ids.map((id) => partners.find((p) => p.id === id)?.name).join(", ")}` : ""}
                      {m.projects?.name ? ` · ${m.projects.name}` : ""}
                    </span>
                  </span>
                  {m.meet_link && <Icon name="meeting" size={18} className="text-pink-soft" />}
                </button>
              ))}
              {rit.map((r) => <div key={r.id} className="flex items-center gap-2 px-2 text-[14px] text-mute"><Icon name="rhythm" size={15} />{r.title}</div>)}
              {due.map((t) => <div key={t.id} className="flex items-center gap-2 px-2 text-[14px] text-pink-soft"><Icon name="flag" size={15} />דדליין: {t.title}</div>)}
            </div>
          </section>
        );
      })}
    </Card>
  );
}

// ---------- event details ----------
function EventDetail({ m, partners, onEdit, onClose }: { m: Meeting; partners: Partner[]; onEdit: () => void; onClose: () => void }) {
  const remove = useRemove("meetings");
  const confirm = useConfirm();
  const who = m.partner_ids?.length ? m.partner_ids.map((id) => partners.find((p) => p.id === id)?.name).join(", ") : "שתינו";
  const when = m.all_day
    ? new Date(m.starts_at).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })
    : `${new Date(m.starts_at).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })}, ${hm(m.starts_at)}–${hm(endOf(m))}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[14px]">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 ${KIND[m.kind].cls}`}><Icon name={KIND[m.kind].icon} size={14} />{KIND[m.kind].label}</span>
        <span className="text-mute">{who}</span>
        {m.google_event_id && !m.needs_push && <span className="inline-flex items-center gap-1 text-mute"><Icon name="sync" size={14} />ב-Google</span>}
      </div>
      <p className="text-[17px]">{when}</p>
      {m.location && <p className="text-mute">{m.location}</p>}
      {m.projects?.name && <p className="text-mute">פרויקט: {m.project_id ? <Link className="text-pink hover:text-pink-soft" to={`/projects/${m.project_id}`}>{m.projects.name}</Link> : m.projects.name}</p>}
      {m.notes && <p className="whitespace-pre-line rounded-[12px] bg-[var(--ink)] p-3 text-[15px] shadow-[inset_0_0_0_1px_var(--line)]">{m.notes}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {m.meet_link && <a href={m.meet_link} target="_blank" rel="noreferrer"><Button type="button"><Icon name="meeting" size={16} />כניסה ל-Meet</Button></a>}
        <Button type="button" variant="ghost" onClick={onEdit}><Icon name="edit" size={16} />עריכה</Button>
        <Button type="button" variant="quiet" onClick={async () => {
          if (await confirm({ title: "למחוק את האירוע?", body: `${m.title}. הוא יימחק גם מיומן Google.` })) { remove.mutate(m.id); onClose(); }
        }}><Icon name="trash" size={16} />מחיקה</Button>
      </div>
    </div>
  );
}

// ---------- find a time ----------
function FreeFinder({ partners, onPick }: { partners: Partner[]; onPick: (s: Slot, who: string) => void }) {
  const [minutes, setMinutes] = useState("60");
  const [days, setDays] = useState("7");
  const [who, setWho] = useState("");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true); setError(null);
    try { setSlots(await findFreeSlots({ minutes: Number(minutes), days: Number(days), partners: who ? [who] : [] })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { run(); }, [minutes, days, who]);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="כמה זמן">
          <Select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
            <option value="30">חצי שעה</option><option value="60">שעה</option><option value="90">שעה וחצי</option><option value="120">שעתיים</option><option value="180">שלוש שעות</option>
          </Select>
        </Field>
        <Field label="מתי">
          <Select value={days} onChange={(e) => setDays(e.target.value)}><option value="7">בשבוע הקרוב</option><option value="14">בשבועיים הקרובים</option></Select>
        </Field>
        <Field label="למי">
          <Select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">לשתינו</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
      </div>
      <p className="text-[14px] text-mute">לפי היומן המשותף ולפי התפוס ביומני הגוגל האישיים. שעות עבודה: א׳-ה׳ <Num>9:00–18:00</Num>, ו׳ עד <Num>13:00</Num>.</p>
      {busy && <p className="text-mute">מחפשת…</p>}
      {error && <p className="text-error">{error}</p>}
      {slots && !busy && !slots.length && <p className="text-mute">לא מצאתי חלון פנוי. אפשר לבחור זמן קצר יותר או טווח ארוך יותר.</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {slots?.map((s) => (
          <button key={s.starts_at} onClick={() => onPick(s, who)}
            className="press rounded-[12px] px-4 py-3 text-start shadow-[inset_0_0_0_1px_var(--line-2)] hover:bg-[var(--hover-veil)] hover:shadow-[inset_0_0_0_1px_var(--pink)]">
            <span className="block text-[15px]">{new Date(s.starts_at).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "numeric" })}</span>
            <span className="block text-[14px] text-mute"><Num>{`${hm(s.starts_at)}–${hm(s.ends_at)}`}</Num></span>
          </button>
        ))}
      </div>
    </div>
  );
}
