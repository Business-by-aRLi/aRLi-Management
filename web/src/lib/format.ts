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
