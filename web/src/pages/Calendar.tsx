// The team calendar: week (time grid), month and agenda views over one shared calendar that is synced
// two-way with Google Calendar ("aRLi"). Events have a kind (meeting / work block / not available) and the
// people taking part. Google busy times of each partner show as faint blocks, tasks can be dragged into
// time, and "find a time" suggests slots when both of us are free.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router-dom";
import {
  findFreeSlots, useBusy, useGoogleConnections, useMeetings, usePartners, useRemove, useRituals, useSave, useSyncStatus, useTasks,
  type Busy, type Meeting, type MeetingKind, type Partner, type Slot, type Task,
} from "../lib/data";
import { Button, Card, Field, IconButton, Modal, Num, PageTitle, Segmented, Select, useConfirm } from "../components/ui";
import { Icon, type IconName } from "../components/icons";
import { MeetingForm, useMe } from "../components/forms";

const BOT = "https://t.me/aRLi_Management_bot";
const DAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const HOUR_PX = 52;
const FIRST_H = 7;
const LAST_H = 22;

type View = "week" | "month" | "agenda";
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
  meeting: { label: "פגישה", icon: "meeting", cls: "bg-pink text-ink" },
  focus: { label: "בלוק עבודה", icon: "focus", cls: "bg-[var(--ink-3)] text-bone shadow-[inset_-3px_0_0_var(--pink-soft),inset_0_0_0_1px_var(--line-2)]" },
  away: { label: "לא זמינה", icon: "away", cls: "text-mute shadow-[inset_0_0_0_1px_var(--line-2)] bg-[repeating-linear-gradient(135deg,var(--ink-3)_0_6px,var(--ink-2)_6px_12px)]" },
};

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export default function CalendarPage() {
  const me = useMe();
  const partners = usePartners();
  const [view, setViewState] = useState<View>(() => (store.get("cal-view") as View) ?? (window.innerWidth < 640 ? "agenda" : "week"));
  const setView = (v: View) => { setViewState(v); store.set("cal-view", v); };
  const [anchor, setAnchor] = useState(() => dayStart(new Date()));
  const [layer, setLayer] = useState<Layer>("all");
  const [showBusy, setShowBusy] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<Meeting | null>(null);
  const [finder, setFinder] = useState(false);

  // The visible range of each view.
  const range = useMemo(() => {
    if (view === "week") { const s = addDays(anchor, -anchor.getDay()); return { from: s, days: 7 }; }
    if (view === "month") { const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1); return { from: addDays(first, -first.getDay()), days: 42 }; }
    return { from: anchor, days: 14 };
  }, [view, anchor]);
  const fromIso = range.from.toISOString();
  const toIso = addDays(range.from, range.days).toISOString();
  const meetings = useMeetings(new Date(range.from.getTime() - 864e5).toISOString(), toIso);
  const busy = useBusy(fromIso, toIso);
  const tasks = useTasks();
  const rituals = useRituals();

  const other = partners.data?.find((p) => p.id !== me?.id);
  const inLayer = (ids: string[]) => layer === "all" || !ids?.length || ids.includes(layer === "mine" ? me?.id ?? "" : other?.id ?? "");
  const events = (meetings.data ?? []).filter((m) => inLayer(m.partner_ids));
  const busyShown = showBusy ? (busy.data ?? []).filter((b) => layer === "all" || b.partner_id === (layer === "mine" ? me?.id : other?.id)) : [];
  const deadlines = (tasks.data ?? []).filter((t) => t.due_on && t.status !== "done" && inLayer(t.assignee_partner_id ? [t.assignee_partner_id] : []));
  const ritualDays = (rituals.data ?? []).filter((r) => r.active && r.next_on).map((r) => ({ id: r.id, title: r.title, on: r.next_on! }));

  const shift = (n: number) => {
    if (view === "month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
    else setAnchor(addDays(anchor, n * (view === "week" ? 7 : 14)));
  };
  const title = view === "month"
    ? anchor.toLocaleDateString("he-IL", { month: "long", year: "numeric" })
    : `${range.from.toLocaleDateString("he-IL", { day: "numeric", month: "long" })} – ${addDays(range.from, range.days - 1).toLocaleDateString("he-IL", { day: "numeric", month: "long" })}`;

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
    <div className="space-y-6">
      <PageTitle eyebrow="יומן משותף" title={title} action={
        <div className="flex flex-wrap items-center gap-2">
          <IconButton icon="chevronPrev" tone="ghost" size={44} label="הקודם" onClick={() => shift(-1)} />
          <Button variant="ghost" className="!py-2 text-[15px]" onClick={() => setAnchor(dayStart(new Date()))}>היום</Button>
          <IconButton icon="chevronNext" tone="ghost" size={44} label="הבא" onClick={() => shift(1)} />
          <Button variant="ghost" className="!py-2 text-[15px]" onClick={() => setFinder(true)}><Icon name="search" size={16} />מצאי זמן פנוי</Button>
          <Button arrow className="group" onClick={() => setDraft({ startsAt: `${ymd(anchor.getTime() < Date.now() ? new Date() : anchor)}T09:00` })}>אירוע חדש</Button>
        </div>
      } />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="תצוגה" value={view} onChange={setView} options={[["week", "שבוע"], ["month", "חודש"], ["agenda", "רשימה"]]} />
          <Segmented label="של מי" value={layer} onChange={setLayer} options={[["all", "שתינו"], ["mine", "שלי"], ["other", other ? `של ${other.name}` : "שלה"]]} />
          <label className="flex items-center gap-2 px-2 text-[14px] text-mute">
            <input type="checkbox" checked={showBusy} onChange={(e) => setShowBusy(e.target.checked)} className="size-4 accent-[var(--pink)]" />
            תפוס מגוגל
          </label>
        </div>
        <SyncBar partners={partners.data ?? []} />
      </div>

      <Legend />

      {view === "week" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
          <WeekGrid days={Array.from({ length: 7 }, (_, i) => addDays(range.from, i))} events={events} busy={busyShown}
            deadlines={deadlines} rituals={ritualDays} partners={partners.data ?? []}
            onSlot={(d) => setDraft({ startsAt: localInput(d) })} onOpen={setOpen} onMove={move}
            onDropTask={(id, d) => { const t = tasks.data?.find((x) => x.id === id); if (t) blockTask(t, d); }} />
          <TaskTray tasks={(tasks.data ?? []).filter((t) => t.status !== "done")} scheduled={new Set(events.map((m) => m.task_id).filter(Boolean) as string[])}
            onPick={(t) => setDraft({ kind: "focus", title: t.title, taskId: t.id, projectId: t.project_id ?? undefined, startsAt: `${ymd(new Date())}T09:00`, partnerIds: t.assignee_partner_id ? [t.assignee_partner_id] : undefined })} />
        </div>
      )}
      {view === "month" && <MonthGrid from={range.from} month={anchor.getMonth()} events={events} deadlines={deadlines} rituals={ritualDays}
        onDay={(d) => { setAnchor(d); setView("week"); }} onOpen={setOpen} />}
      {view === "agenda" && <Agenda from={range.from} days={range.days} events={events} deadlines={deadlines} rituals={ritualDays}
        partners={partners.data ?? []} onOpen={setOpen} onNew={(d) => setDraft({ startsAt: `${ymd(d)}T09:00` })} />}

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
        <span key={p.id} className={`rounded-full px-2.5 py-0.5 text-[13px] ${connected(p.id) ? "bg-pink/15 text-pink-soft" : "text-mute shadow-[inset_0_0_0_1px_var(--line-2)]"}`}>
          {p.name}{connected(p.id) ? " ✓" : ""}
        </span>
      ))}
      {!allOn && <a href={`${BOT}?start=google`} target="_blank" rel="noreferrer" className="text-pink hover:text-pink-soft">חיבור דרך הבוט ←</a>}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-4 text-[13px] text-mute">
      {(Object.keys(KIND) as MeetingKind[]).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5"><span className={`inline-block h-3 w-5 rounded-[4px] ${KIND[k].cls}`} />{KIND[k].label}</span>
      ))}
      <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-[4px] bg-[var(--hover-veil)] shadow-[inset_0_0_0_1px_var(--line)]" />תפוס ביומן אישי</span>
      <span className="inline-flex items-center gap-1.5 text-pink-soft"><Icon name="flag" size={13} />דדליין</span>
      <span className="inline-flex items-center gap-1.5"><Icon name="rhythm" size={13} />טקס עסקי</span>
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

function WeekGrid({ days, events, busy, deadlines, rituals, partners, onSlot, onOpen, onMove, onDropTask }: {
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

  // 15-minute steps; RTL, so moving the pointer left means a later day.
  const dragShift = (d: NonNullable<typeof drag>) => ({ days: -Math.round(d.dx / d.colW), minutes: Math.round(((d.dy / HOUR_PX) * 60) / 15) * 15 });
  const timeAt = (day: Date, offsetY: number) => {
    const mins = Math.max(0, Math.round(((offsetY / HOUR_PX) * 60) / 30) * 30);
    const d = new Date(day); d.setHours(FIRST_H, 0, 0, 0); d.setMinutes(mins); return d;
  };

  function startDrag(e: ReactPointerEvent, m: Meeting) {
    if (e.button !== 0) return;
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
    <Card className="!p-0 overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          {/* day headers + all-day row */}
          <div className="grid grid-cols-[52px_repeat(7,1fr)] border-b border-[var(--line)]">
            <div />
            {days.map((d) => {
              const key = ymd(d);
              const allDay = events.filter((m) => m.all_day && ymd(new Date(m.starts_at)) <= key && ymd(new Date(endOf(m))) >= key);
              const due = deadlines.filter((t) => t.due_on === key);
              const rit = rituals.filter((r) => r.on === key);
              return (
                <div key={key} className={`min-w-0 px-1 pb-2 pt-3 ${d.getDay() === 6 ? "opacity-50" : ""}`}>
                  <div className="mb-1.5 flex items-baseline justify-center gap-1.5 text-[14px] text-mute">
                    {DAYS[d.getDay()]}
                    <span className={`inline-grid size-7 place-items-center rounded-full text-[15px] ${key === todayKey ? "bg-pink font-semibold text-ink" : "text-bone"}`}><Num>{d.getDate()}</Num></span>
                  </div>
                  <div className="space-y-0.5">
                    {allDay.map((m) => (
                      <button key={m.id} onClick={() => onOpen(m)} className={`press block w-full truncate rounded-[6px] px-1.5 py-0.5 text-start text-[12px] ${KIND[m.kind].cls}`}>{m.title}</button>
                    ))}
                    {rit.map((r) => <div key={r.id} className="flex items-center gap-1 truncate text-[12px] text-mute"><Icon name="rhythm" size={12} className="shrink-0" /><span className="truncate">{r.title}</span></div>)}
                    {due.map((t) => <Link key={t.id} to="/tasks" className="flex items-center gap-1 truncate text-[12px] text-pink-soft"><Icon name="flag" size={12} className="shrink-0" /><span className="truncate">{t.title}</span></Link>)}
                  </div>
                </div>
              );
            })}
          </div>
          {/* time grid */}
          <div ref={scroller} className="max-h-[68vh] overflow-y-auto">
            <div className="relative grid grid-cols-[52px_repeat(7,1fr)]" style={{ height: hours.length * HOUR_PX }}>
              <div className="relative">
                {hours.map((h, i) => <div key={h} className="absolute inset-x-0 pe-2 text-end text-[12px] text-mute" style={{ top: i * HOUR_PX - 7 }}>{i > 0 && <Num>{`${pad(h)}:00`}</Num>}</div>)}
              </div>
              {days.map((d) => {
                const key = ymd(d);
                const placed = layoutDay(events.filter((m) => !m.all_day && ymd(new Date(m.starts_at)) === key), d);
                const base = new Date(d); base.setHours(FIRST_H, 0, 0, 0);
                const dayBusy = busy.filter((b) => ymd(new Date(b.starts_at)) === key || ymd(new Date(b.ends_at)) === key);
                const nowTop = key === todayKey ? ((now.getTime() - base.getTime()) / 3600e3) * HOUR_PX : -1;
                return (
                  <div key={key} data-day={key}
                    className={`relative border-s border-[var(--line)] ${d.getDay() === 6 ? "bg-[var(--hover-veil)]" : ""}`}
                    style={{ backgroundImage: `repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px ${HOUR_PX}px)` }}
                    onClick={(e) => { if (e.target === e.currentTarget) onSlot(timeAt(d, e.nativeEvent.offsetY)); }}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes("text/task")) e.preventDefault(); }}
                    onDrop={(e) => {
                      const id = e.dataTransfer.getData("text/task"); if (!id) return;
                      e.preventDefault();
                      const top = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
                      onDropTask(id, timeAt(d, e.clientY - top));
                    }}>
                    {dayBusy.map((b, i) => {
                      const s = Math.max(new Date(b.starts_at).getTime(), base.getTime());
                      const e = Math.min(new Date(b.ends_at).getTime(), base.getTime() + hours.length * 3600e3);
                      if (e <= s) return null;
                      const name = partners.find((p) => p.id === b.partner_id)?.name ?? "";
                      return (
                        <div key={i} className="pointer-events-none absolute inset-x-0.5 overflow-hidden rounded-[6px] bg-[var(--hover-veil)] px-1 text-[11px] text-mute shadow-[inset_0_0_0_1px_var(--line)]"
                          style={{ top: ((s - base.getTime()) / 3600e3) * HOUR_PX, height: ((e - s) / 3600e3) * HOUR_PX }}>תפוסה · {name}</div>
                      );
                    })}
                    {placed.map(({ m, top, height, col, cols }) => {
                      const dragging = drag?.id === m.id;
                      const who = initials(m.partner_ids, partners);
                      return (
                        <button key={m.id}
                          onPointerDown={(e) => startDrag(e, m)}
                          onPointerMove={(e) => dragging && setDrag({ ...drag!, dx: e.clientX - drag!.x, dy: e.clientY - drag!.y })}
                          onPointerUp={() => endDrag(m)}
                          onPointerCancel={() => setDrag(null)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(m); } }}
                          className={`absolute touch-none overflow-hidden rounded-[8px] px-1.5 py-1 text-start text-[12px] leading-tight transition-shadow ${KIND[m.kind].cls} ${dragging ? "z-20 cursor-grabbing opacity-90 shadow-[0_12px_30px_-10px_rgba(0,0,0,.8)]" : "z-10 cursor-grab"}`}
                          style={{
                            top: top + 1, height: Math.max(20, height - 2),
                            insetInlineStart: `calc(${(col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)`,
                            transform: dragging ? `translate(${drag!.dx}px, ${drag!.dy}px)` : undefined,
                          }}>
                          <div className="flex items-start justify-between gap-1">
                            <span className="truncate font-semibold">{m.title}</span>
                            {who && <span className="shrink-0 text-[11px] opacity-80">{who}</span>}
                          </div>
                          {height > 34 && <div className="truncate opacity-80"><Num>{hm(m.starts_at)}</Num>{m.meet_link ? " · Meet" : m.location ? ` · ${m.location}` : ""}</div>}
                          {height > 52 && m.projects?.name && <div className="truncate opacity-70">{m.projects.name}</div>}
                        </button>
                      );
                    })}
                    {nowTop >= 0 && nowTop <= hours.length * HOUR_PX && (
                      <div className="pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-pink" style={{ top: nowTop }}><span className="absolute -top-1 -start-1 size-2.5 rounded-full bg-pink" /></div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <p className="border-t border-[var(--line)] px-4 py-2.5 text-[13px] text-mute">לחיצה על שעה פנויה יוצרת אירוע. גוררים אירוע כדי להזיז אותו, וגוררים משימה מהצד כדי לחסום לה זמן.</p>
    </Card>
  );
}

// Open tasks to block into time: drag onto the week, or tap to open the form.
function TaskTray({ tasks, scheduled, onPick }: { tasks: Task[]; scheduled: Set<string>; onPick: (t: Task) => void }) {
  const list = tasks.filter((t) => !scheduled.has(t.id)).sort((a, b) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999") || a.priority - b.priority).slice(0, 12);
  return (
    <Card className="h-fit">
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
    <Card>
      <div className="grid grid-cols-7 gap-1 text-center text-[14px] text-mute">{DAYS.map((d) => <div key={d} className="py-1">{d}</div>)}</div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const key = ymd(d);
          const list = events.filter((m) => ymd(new Date(m.starts_at)) === key || (m.all_day && ymd(new Date(m.starts_at)) <= key && ymd(new Date(endOf(m))) >= key));
          const due = deadlines.filter((t) => t.due_on === key);
          const rit = rituals.filter((r) => r.on === key);
          return (
            <div key={key} role="button" tabIndex={0} onClick={() => onDay(d)} onKeyDown={(e) => e.key === "Enter" && onDay(d)}
              className={`press flex min-h-[64px] cursor-pointer flex-col items-start rounded-[12px] p-1.5 text-start hover:bg-[var(--hover-veil)] sm:min-h-[104px] ${d.getMonth() === month ? "" : "opacity-35"}`}>
              <span className={`inline-grid size-7 place-items-center rounded-full text-[14px] ${key === todayKey ? "bg-pink font-semibold text-ink" : ""}`}><Num>{d.getDate()}</Num></span>
              <div className="mt-1 hidden w-full min-w-0 space-y-0.5 sm:block">
                {list.slice(0, 3).map((m) => (
                  <button key={m.id} onClick={(e) => { e.stopPropagation(); onOpen(m); }} className={`block w-full truncate rounded-[5px] px-1 text-start text-[12px] ${KIND[m.kind].cls}`}>
                    {!m.all_day && <Num>{hm(m.starts_at)} </Num>}{m.title}
                  </button>
                ))}
                {list.length > 3 && <div className="text-[12px] text-mute">+{list.length - 3}</div>}
                {rit.slice(0, 1).map((r) => <div key={r.id} className="flex items-center gap-1 truncate text-[12px] text-mute"><Icon name="rhythm" size={12} className="shrink-0" /><span className="truncate">{r.title}</span></div>)}
                {due.slice(0, 1).map((t) => <div key={t.id} className="flex items-center gap-1 truncate text-[12px] text-pink-soft"><Icon name="flag" size={12} className="shrink-0" /><span className="truncate">{t.title}</span></div>)}
              </div>
              <div className="mt-1 flex gap-0.5 sm:hidden">
                {list.some((m) => m.kind === "meeting") && <span className="size-1.5 rounded-full bg-pink" />}
                {list.some((m) => m.kind !== "meeting") && <span className="size-1.5 rounded-full bg-bone" />}
                {due.length > 0 && <span className="size-1.5 rounded-full bg-pink-soft" />}
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
    <Card>
      {list.map((d) => {
        const key = ymd(d);
        const evs = events.filter((m) => ymd(new Date(m.starts_at)) === key || (m.all_day && ymd(new Date(m.starts_at)) <= key && ymd(new Date(endOf(m))) >= key));
        const due = deadlines.filter((t) => t.due_on === key);
        const rit = rituals.filter((r) => r.on === key);
        const empty = !evs.length && !due.length && !rit.length;
        return (
          <section key={key} className="row-line py-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className={`text-[16px] font-semibold ${key === ymd(new Date()) ? "text-pink" : ""}`}>{d.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" })}</h3>
              <IconButton icon="plus" label="אירוע ביום הזה" onClick={() => onNew(d)} />
            </div>
            {empty && <p className="text-[14px] text-mute">{d.getDay() === 6 ? "שבת שלום" : "יום פתוח. מקום טוב לבלוק עבודה."}</p>}
            <div className="space-y-1.5">
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
