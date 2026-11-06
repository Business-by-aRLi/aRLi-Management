// Hebrew dates and Jewish holidays (Israel schedule), computed locally with @hebcal/core: no network, no data.
import { HDate, HebrewCalendar, Locale, flags, gematriya } from "@hebcal/core";

export type Holiday = { name: string; chag: boolean };

// Leave out the very minor entries so the calendar stays calm; keep the national memorial and independence days.
const SKIP = /^(Pesach Sheni|Leil Selichot|Selichot|Purim Katan|Shushan Purim Katan|Chag HaBanot)/;
const MODERN_KEEP = /^(Yom HaShoah|Yom HaZikaron|Yom HaAtzma'ut|Yom Yerushalayim)$/;

const pad = (n: number) => String(n).padStart(2, "0");
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const byYear = new Map<number, Map<string, Holiday[]>>();
function yearMap(year: number) {
  let m = byYear.get(year);
  if (m) return m;
  m = new Map();
  const events = HebrewCalendar.calendar({ start: new Date(year, 0, 1), end: new Date(year, 11, 31), il: true, noSpecialShabbat: true, noRoshChodesh: true });
  for (const e of events) {
    const desc = e.getDesc();
    const f = e.getFlags();
    if (SKIP.test(desc)) continue;
    if (f & flags.MODERN_HOLIDAY && !MODERN_KEEP.test(desc)) continue;
    const k = key(e.getDate().greg());
    const list = m.get(k) ?? [];
    list.push({ name: e.render("he-x-NoNikud"), chag: !!(f & flags.CHAG) });
    m.set(k, list);
  }
  byYear.set(year, m);
  return m;
}

/** Holidays on a local date key "YYYY-MM-DD". */
export const holidaysOn = (ymd: string): Holiday[] => yearMap(Number(ymd.slice(0, 4))).get(ymd) ?? [];
export const isChag = (ymd: string) => holidaysOn(ymd).some((h) => h.chag);

const monthHe = (hd: HDate) => Locale.gettext(hd.getMonthName(), "he-x-NoNikud");
/** Day of the Hebrew month in letters: "כ״ו". */
export const hebDay = (d: Date) => gematriya(new HDate(d).getDate());
/** "כ״ו חשון" */
export const hebDayMonth = (d: Date) => { const hd = new HDate(d); return `${gematriya(hd.getDate())} ${monthHe(hd)}`; };
/** "כ״ו חשון תשפ״ז" */
export const hebFull = (d: Date) => new HDate(d).renderGematriya(true);
/** A range in Hebrew months: "חשון–כסלו תשפ״ז". */
export function hebRange(from: Date, to: Date) {
  const a = new HDate(from), b = new HDate(to);
  const year = gematriya(b.getFullYear() % 1000);
  return monthHe(a) === monthHe(b) ? `${monthHe(b)} ${year}` : `${monthHe(a)}–${monthHe(b)} ${year}`;
}
