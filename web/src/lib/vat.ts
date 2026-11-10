// VAT periods and the numbers of one VAT report, for an עוסק מורשה. Pure functions, no database.
import type { Expense, SalesDocument, TaxProfile } from "./data";

const pad = (n: number) => String(n).padStart(2, "0");
const ym = (y: number, m: number) => `${y}-${pad(m)}-01`; // m is 1..12
const HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
export const r2 = (n: number) => Math.round(n * 100) / 100;

export const VAT_TYPES = [8, 9];
export const DOC_NAME: Record<number, string> = { 6: "קבלה", 8: "חשבונית מס", 9: "חשבונית מס קבלה" };

// The first day of the reporting period a date falls in. A two-month period starts in an odd month (Jan–Feb, Mar–Apr…).
export function periodOf(iso: string, p: Pick<TaxProfile, "vat_period">): string {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return ym(y, p.vat_period === "bimonthly" ? m - ((m - 1) % 2) : m);
}
export const periodMonths = (p: Pick<TaxProfile, "vat_period">) => (p.vat_period === "bimonthly" ? 2 : 1);
export function addMonths(start: string, n: number) {
  const y = +start.slice(0, 4), m = +start.slice(5, 7) - 1 + n;
  return ym(y + Math.floor(m / 12), (((m % 12) + 12) % 12) + 1);
}
// Last day of the period (inclusive).
export function periodEnd(start: string, p: Pick<TaxProfile, "vat_period">) {
  const next = addMonths(start, periodMonths(p));
  const d = new Date(`${next}T12:00:00`); d.setDate(0);
  return d.toISOString().slice(0, 10);
}
export const inPeriod = (iso: string, start: string, p: Pick<TaxProfile, "vat_period">) => iso >= start && iso <= periodEnd(start, p);
// The report and payment are due on the 15th of the month after the period (online reporting often gets a few more days).
export const dueDate = (start: string, p: Pick<TaxProfile, "vat_period">) => addMonths(start, periodMonths(p)).slice(0, 8) + "15";
export function periodLabel(start: string, p: Pick<TaxProfile, "vat_period">) {
  const y = start.slice(0, 4), m = +start.slice(5, 7) - 1;
  return p.vat_period === "bimonthly" ? `${HE_MONTHS[m]}–${HE_MONTHS[(m + 1) % 12]} ${y}` : `${HE_MONTHS[m]} ${y}`;
}
// Every period from the move to מורשה until the current one, newest first.
export function periods(p: TaxProfile, todayIso: string): string[] {
  const out: string[] = [];
  const first = periodOf(p.licensed_from, p), last = periodOf(todayIso, p);
  for (let s = last; s >= first && out.length < 60; s = addMonths(s, -periodMonths(p))) out.push(s);
  return out.length ? out : [first];
}

// The VAT printed on an expense's invoice (entered, or the rate inside the total), and the part that may be claimed.
export const expenseVat = (e: Expense, rate: number) =>
  e.vat_doc !== "tax_invoice" ? 0 : e.vat_amount != null ? Number(e.vat_amount) : r2(Number(e.amount) * rate / (100 + rate));
export const claimable = (e: BookExpense, rate: number) =>
  e.allocationMissing ? 0 : r2(expenseVat(e, rate) * Number(e.vat_claim_pct ?? 100) / 100);
export const expensePeriod = (e: Expense, p: TaxProfile) => e.vat_period_start ? periodOf(e.vat_period_start, p) : periodOf(e.spent_on, p);

// From 2026 a tax invoice above the threshold (before VAT) needs an allocation number (מספר הקצאה) from the tax
// authority, or its VAT cannot be claimed: 10,000 ₪ from January 2026, 5,000 ₪ from June 2026.
export function allocationThreshold(iso: string) {
  if (iso >= "2026-06-01") return 5000;
  if (iso >= "2026-01-01") return 10000;
  if (iso >= "2025-01-01") return 20000;
  return 25000;
}
export function needsAllocation(e: Expense, rate: number) {
  if (e.vat_doc !== "tax_invoice") return false;
  const net = Number(e.amount) - expenseVat(e, rate);
  return net > allocationThreshold(e.spent_on) && !e.allocation_number?.trim();
}

// An expense inside a report: allocationMissing = a tax invoice above the threshold with no allocation number.
export type BookExpense = Expense & { allocationMissing?: boolean };

export type VatReport = {
  start: string; end: string; due: string;
  taxableNet: number; outputVat: number; exemptNet: number; turnover: number;
  inputAssets: number; inputOther: number; toPay: number; advance: number | null;
  sales: SalesDocument[]; expenses: BookExpense[]; unchecked: BookExpense[]; noAllocation: BookExpense[]; noFile: BookExpense[];
};

export function vatReport(start: string, p: TaxProfile, sales: SalesDocument[], expenses: Expense[]): VatReport {
  const rate = Number(p.vat_rate);
  const s = sales.filter((d) => VAT_TYPES.includes(d.doc_type) && inPeriod(d.issued_on, start, p));
  const fromLicensed = expenses.filter((e) => e.spent_on >= p.licensed_from);
  const ex = fromLicensed.filter((e) => expensePeriod(e, p) === start)
    .map((e) => ({ ...e, allocationMissing: needsAllocation(e, rate) }));
  const withVat = ex.filter((e) => e.vat_doc === "tax_invoice");
  const taxable = s.filter((d) => Number(d.vat) > 0), exempt = s.filter((d) => !(Number(d.vat) > 0));
  const sum = <T,>(rows: T[], f: (r: T) => number) => r2(rows.reduce((a, r) => a + f(r), 0));
  const outputVat = sum(taxable, (d) => Number(d.vat));
  const inputAssets = sum(withVat.filter((e) => e.is_asset), (e) => claimable(e, rate));
  const inputOther = sum(withVat.filter((e) => !e.is_asset), (e) => claimable(e, rate));
  const turnover = sum(s, (d) => Number(d.net));
  return {
    start, end: periodEnd(start, p), due: dueDate(start, p),
    taxableNet: sum(taxable, (d) => Number(d.net)), outputVat, exemptNet: sum(exempt, (d) => Number(d.net)), turnover,
    inputAssets, inputOther, toPay: r2(outputVat - inputAssets - inputOther),
    advance: p.advance_rate != null ? r2(turnover * Number(p.advance_rate) / 100) : null,
    sales: s, expenses: ex,
    unchecked: ex.filter((e) => !e.vat_doc),
    noAllocation: ex.filter((e) => e.allocationMissing),
    noFile: withVat.filter((e) => !e.receipt_path),
  };
}

// One CSV the accountant can open in Excel (UTF-8 with BOM, so Hebrew shows right).
export function reportCsv(r: VatReport, p: TaxProfile, partnerName: (id: string | null) => string): string {
  const rate = Number(p.vat_rate);
  const cell = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const line = (...v: unknown[]) => v.map(cell).join(",");
  const out = [
    line(`דוח מע"מ ${periodLabel(r.start, p)}`, `${r.start} עד ${r.end}`),
    line("מספר עוסק", p.vat_file_number ?? ""),
    "",
    line("סיכום", "סכום"),
    line("עסקאות חייבות (לפני מע\"מ)", r.taxableNet),
    line("מע\"מ עסקאות", r.outputVat),
    line("עסקאות פטורות / בשיעור אפס", r.exemptNet),
    line("מע\"מ תשומות ציוד", r.inputAssets),
    line("מע\"מ תשומות אחרות", r.inputOther),
    line("לתשלום (שלילי = החזר)", r.toPay),
    ...(r.advance != null ? [line(`מקדמת מס הכנסה (${p.advance_rate}% מהמחזור)`, r.advance)] : []),
    "",
    line("מסמכי מכירה"),
    line("תאריך", "סוג", "מספר", "לקוח", "לפני מע\"מ", "מע\"מ", "סה\"כ", "קישור"),
    ...r.sales.map((d) => line(d.issued_on, DOC_NAME[d.doc_type] ?? d.doc_type, d.doc_number, d.clients?.name ?? d.customer_name ?? "", d.net, d.vat, d.total, d.pdf_url ?? "")),
    "",
    line("הוצאות"),
    line("תאריך", "ספק", "ע.מ ספק", "על מה", "אסמכתה", "מספר הקצאה", "סה\"כ", "מע\"מ בחשבונית", "% מוכר", "מע\"מ לקיזוז", "ציוד", "סוג מסמך", "שילמה", "יש קובץ"),
    ...r.expenses.map((e) => line(e.spent_on, e.vendor ?? "", e.supplier_tax_id ?? "", e.description, e.reference ?? "", e.allocation_number ?? "",
      e.amount, expenseVat(e, rate), e.vat_doc === "tax_invoice" ? e.vat_claim_pct ?? 100 : "", claimable(e, rate), e.is_asset ? "כן" : "",
      e.vat_doc === "tax_invoice" ? "חשבונית מס" : e.vat_doc === "no_vat" ? "בלי מע\"מ" : "לא נבדק", partnerName(e.paid_by_partner_id), e.receipt_path ? "כן" : "לא")),
  ];
  return "﻿" + out.join("\n");
}
