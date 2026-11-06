export const money = (n: number | string | null | undefined) =>
  `${Number(n ?? 0).toLocaleString("he-IL", { maximumFractionDigits: 2 })} ₪`;

export const date = (d: string | null | undefined) =>
  d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" }) : "";

export const dateTime = (d: string) =>
  new Date(d).toLocaleString("he-IL", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

export const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} ש׳`;

// Today in Israel as YYYY-MM-DD
export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());

// A project's type is shown as a tag on it, not as a separate section.
export const PROJECT_TAG: Record<string, string> = { client: "לקוח", business: "עסקי", learning: "למידה" };
export const PROJECT_TYPE = PROJECT_TAG;
// Project lifecycle, in order. "paused" and "closed" are old values, shown as archive.
export const PROJECT_STAGES = [["planning", "בתכנון"], ["setup", "בהקמה"], ["implementation", "בהטמעה"], ["active", "פעיל"], ["archived", "ארכיון"]] as const;
export const PROJECT_STATUS: Record<string, string> = { ...Object.fromEntries(PROJECT_STAGES), paused: "ארכיון", closed: "ארכיון" };
export const isArchived = (status: string) => status === "archived" || status === "closed" || status === "paused";
export const stageIndex = (status: string) => isArchived(status) ? 4 : Math.max(0, PROJECT_STAGES.findIndex(([k]) => k === status));
export const TASK_STATUS: Record<string, string> = { todo: "לביצוע", in_progress: "בעבודה", done: "בוצע" };

// Leads move left to right; "won" and "lost" close them.
export const LEAD_STAGES = [["new", "חדש"], ["contacted", "בשיחה"], ["meeting", "פגישה"], ["quote_sent", "נשלחה הצעה"], ["won", "נסגר"], ["lost", "לא רלוונטי"]] as const;
export const LEAD_STAGE: Record<string, string> = Object.fromEntries(LEAD_STAGES);
export const OPEN_LEAD_STAGES = ["new", "contacted", "meeting", "quote_sent"];
export const LEAD_SOURCES = ["המלצה", "אתר", "וואטסאפ", "פייסבוק", "אינסטגרם", "נטוורקינג", "לקוח קיים", "אחר"];
export const ACTIVITY_KIND: Record<string, string> = { note: "הערה", call: "שיחה", whatsapp: "וואטסאפ", email: "מייל", meeting: "פגישה", stage: "שלב", quote: "הצעה" };
export const QUOTE_STATUS: Record<string, string> = { draft: "טיוטה", sent: "נשלחה", viewed: "נצפתה", approved: "אושרה", rejected: "נדחתה", cancelled: "בוטלה", expired: "פג תוקף" };
// "Expired" is not stored: a sent quote past its date simply reads as expired.
export const quoteState = (q: { status: string; valid_until: string }) =>
  (q.status === "sent" || q.status === "viewed") && q.valid_until < today() ? "expired" : q.status;
export const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
// Days between two YYYY-MM-DD dates (b - a).
export const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000);
// Quote totals, the same way the database computes them (used for the live preview while editing).
export function quoteTotals(items: { quantity: number; unit_price: number; recurring: boolean }[], discountType: string, discountValue: number, includeVat: boolean, vatRate: number) {
  const subtotal = items.filter((i) => !i.recurring).reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);
  const discount = discountType === "percent" ? subtotal * (Number(discountValue) || 0) / 100 : Number(discountValue) || 0;
  const net = Math.max(0, subtotal - discount);
  const vat = includeVat ? net * (Number(vatRate) || 0) / 100 : 0;
  const monthly = items.filter((i) => i.recurring).reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0);
  return { subtotal, discount, net, vat, total: Math.round((net + vat) * 100) / 100, monthly };
}
