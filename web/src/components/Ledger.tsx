import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  BIZ, BIZ_NAME, useBusinessLedger, useFinancials, useLedger, useLedgerSettings, usePartners, useSave, useSaveShares, useShares,
  type LedgerKind, type LedgerRow,
} from "../lib/data";
import { date, money } from "../lib/format";
import { Button, Card, Empty, ErrorNote, Field, Input, Loading, Modal, MonthSelect, Num, Segmented, Select } from "./ui";
import { SettlementForm } from "./forms";
import { must, supabase } from "../lib/supabase";
import { useQueryClient } from "@tanstack/react-query";

// Partner ledger (כרטסת). Every money event, oldest first, from one partner's side:
// זכות = she paid for the business, deposited money in it, or is entitled to part of an income.
// חובה = her share of an expense, or business money that reached her (a client paid her, a withdrawal).
// A positive balance means the business (or the other partner) owes her. The business account has its own card.

const KIND: Record<LedgerKind | "tax", string> = {
  expense: "הוצאה", income: "הכנסה", transfer: "העברה", withdrawal: "משיכה", deposit: "הפקדה", vat: "מע״מ", tax: "מסים",
};
type KindFilter = "all" | "income" | "expense" | "moves";
const KIND_FILTERS: [KindFilter, string][] = [["all", "הכל"], ["income", "הכנסות"], ["expense", "הוצאות"], ["moves", "משיכות והעברות"]];
const matches = (k: string, f: KindFilter) =>
  f === "all" || k === f || (f === "expense" && (k === "vat" || k === "tax")) || (f === "moves" && (k === "transfer" || k === "withdrawal" || k === "deposit"));

const round = (n: number) => Math.round(n * 100) / 100;
const side = (n: number) => (Math.abs(n) < 0.005 ? "מאוזנת" : n > 0 ? "זכות" : "חובה");

// One line in the table, for a partner or for the business account.
type Line = { key: string; on_date: string; kind: string; description: string; project_name?: string | null; meta: string; debit: number; credit: number; balance: number };

export function useLedgerTotals() {
  const ledger = useLedger();
  const partners = usePartners();
  return useMemo(() => (partners.data ?? []).map((p) => {
    const rows = (ledger.data ?? []).filter((r) => r.partner_id === p.id);
    const sum = (k: LedgerKind[], f: "credit" | "debit") => rows.filter((r) => k.includes(r.kind)).reduce((s, r) => s + Number(r[f]), 0);
    return {
      id: p.id, name: p.name,
      balance: round(rows.reduce((s, r) => s + Number(r.credit) - Number(r.debit), 0)),
      paid: sum(["expense", "vat"], "credit"), expenseShare: sum(["expense"], "debit"),
      entitled: sum(["income"], "credit"), received: sum(["income"], "debit"),
      moves: sum(["transfer", "withdrawal", "deposit"], "credit") - sum(["transfer", "withdrawal", "deposit"], "debit"),
    };
  }), [ledger.data, partners.data]);
}
type Totals = ReturnType<typeof useLedgerTotals>;

export function useBusinessBalance() {
  const biz = useBusinessLedger();
  const rows = biz.data ?? [];
  return { has: rows.length > 0, balance: rows.length ? Number(rows[rows.length - 1].balance) : 0 };
}

// What would settle things now: one partner paying the other, or a withdrawal from the business account.
function settleMove(totals: Totals) {
  const owed = totals.filter((t) => t.balance > 0.5);
  const owes = totals.filter((t) => t.balance < -0.5);
  if (owed.length === 1 && owes.length === 1) return { from: owes[0].id, to: owed[0].id, amount: round(Math.min(owed[0].balance, -owes[0].balance)) };
  return null;
}

// A calm summary: who is owed what, and what would settle it.
export function SettleLine({ totals }: { totals: Totals }) {
  const move = settleMove(totals);
  const name = (id: string) => totals.find((t) => t.id === id)?.name ?? "";
  if (totals.every((t) => Math.abs(t.balance) < 0.5)) return <p className="text-[15px] text-mute">אתן מאוזנות.</p>;
  if (move) return <p className="text-[15px]">כדי להתאזן, {name(move.from)} מעבירה ל{name(move.to)} <Num className="font-semibold">{money(move.amount)}</Num></p>;
  return (
    <p className="text-[15px]">
      {totals.filter((t) => Math.abs(t.balance) >= 0.5).map((t, i) => (
        <span key={t.id}>{i > 0 && " · "}{t.balance > 0 ? <>מגיע ל{t.name} <Num className="font-semibold">{money(t.balance)}</Num></> : <>{t.name} חייבת לעסק <Num className="font-semibold">{money(-t.balance)}</Num></>}</span>
      ))}
    </p>
  );
}

export function Ledger() {
  const ledger = useLedger();
  const bizLedger = useBusinessLedger();
  const partners = usePartners();
  const settings = useLedgerSettings();
  const totals = useLedgerTotals();
  const biz = useBusinessBalance();
  const [who, setWho] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [from, setFrom] = useState("");
  const [settle, setSettle] = useState<null | { from: string; to: string; amount?: number }>(null);
  const [rules, setRules] = useState(false);
  useEffect(() => { if (!who && partners.data?.length) setWho(partners.data.find((p) => p.name === "מירי")?.id ?? partners.data[0].id); }, [partners.data, who]);

  const isBiz = who === BIZ;
  const all: Line[] = useMemo(() => isBiz
    ? (bizLedger.data ?? []).map((r) => ({
        key: `${r.kind}-${r.ref_id}`, on_date: r.on_date, kind: r.kind, description: r.description,
        meta: r.kind === "withdrawal" ? "משיכה לשותפה" : r.kind === "deposit" ? "הפקדה של שותפה" : r.kind === "income" ? "נכנס לחשבון" : "יצא מהחשבון / מהאשראי",
        debit: Number(r.amount_out), credit: Number(r.amount_in), balance: Number(r.balance),
      }))
    : (ledger.data ?? []).filter((r) => r.partner_id === who).map((r) => ({
        key: `${r.kind}-${r.ref_id}`, on_date: r.on_date, kind: r.kind, description: r.description || KIND[r.kind], project_name: r.project_name,
        meta: metaOf(r), debit: Number(r.debit), credit: Number(r.credit), balance: Number(r.balance),
      })), [isBiz, bizLedger.data, ledger.data, who]);
  // From a chosen month on, the rows before it fold into one opening balance.
  const opening = useMemo(() => (from ? all.filter((r) => r.on_date < `${from}-01`) : []).reduce((s, r) => s + r.credit - r.debit, 0), [all, from]);
  const rows = useMemo(() => all.filter((r) => (!from || r.on_date >= `${from}-01`) && matches(r.kind, kind)), [all, from, kind]);

  if (ledger.isLoading || partners.isLoading) return <Loading />;
  if (ledger.error) return <ErrorNote error={ledger.error} />;

  const move = settleMove(totals);
  const title = isBiz ? BIZ_NAME : partners.data?.find((p) => p.id === who)?.name ?? "";
  const cutoff = settings.data?.new_split_from;

  function exportCsv() {
    const cell = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const line = (...v: unknown[]) => v.map(cell).join(",");
    const out = [line(`כרטסת ${title}`), line("תאריך", "סוג", "תיאור", "פרויקט", "פירוט", isBiz ? "יצא" : "חובה", isBiz ? "נכנס" : "זכות", "יתרה")];
    for (const r of all) out.push(line(r.on_date, KIND[r.kind as LedgerKind] ?? r.kind, r.description, r.project_name ?? "", r.meta, round(r.debit), round(r.credit), r.balance));
    const blob = new Blob(["﻿" + out.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `aRLi-כרטסת-${title}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <div className="grid min-w-0 gap-6">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          {totals.map((t) => (
            <button key={t.id} type="button" onClick={() => setWho(t.id)} aria-pressed={t.id === who}
              className={`press rounded-2xl px-4 py-3 text-start text-[14px] shadow-[inset_0_0_0_1px_var(--line)] ${t.id === who ? "bg-[var(--ink-3)]/70 shadow-[inset_0_0_0_1px_var(--line-2)]" : ""}`}>
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-[16px] font-medium">{t.name}</span>
                <span className="text-mute">{side(t.balance)}</span>
              </span>
              <Num className={`mt-1 block text-[26px] font-semibold ${t.balance > 0.005 ? "text-pink-soft" : ""}`}>{money(Math.abs(t.balance))}</Num>
              <span className="mt-2 grid gap-y-0.5 text-[13px] text-mute">
                <Stat label="שילמה מכיסה" n={t.paid} />
                <Stat label="חלקה בהוצאות" n={t.expenseShare} />
                <Stat label="מגיע לה מהכנסות" n={t.entitled} />
                <Stat label="הגיע אליה ישירות" n={t.received} />
              </span>
            </button>
          ))}
          <button type="button" onClick={() => setWho(BIZ)} aria-pressed={isBiz}
            className={`press rounded-2xl px-4 py-3 text-start text-[14px] shadow-[inset_0_0_0_1px_var(--line)] ${isBiz ? "bg-[var(--ink-3)]/70 shadow-[inset_0_0_0_1px_var(--line-2)]" : ""}`}>
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-[16px] font-medium">{BIZ_NAME}</span>
              <span className="text-mute">בנק ואשראי</span>
            </span>
            <Num className={`mt-1 block text-[26px] font-semibold ${biz.balance < -0.005 ? "text-error" : ""}`}>{money(round(biz.balance))}</Num>
            <span className="mt-2 block text-[13px] text-mute">{biz.has ? "כל מה שנכנס ויצא מהחשבון ומהאשראי של העסק" : "עוד אין תנועות. הכנסות והוצאות שנרשמות על חשבון העסק יופיעו כאן."}</span>
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <SettleLine totals={totals} />
          <div className="flex flex-wrap gap-2">
            {move && <Button variant="ghost" onClick={() => setSettle(move)}>רישום העברה</Button>}
            <Button variant="ghost" onClick={() => setSettle({ from: BIZ, to: totals.find((t) => t.balance > 0.5)?.id ?? "" })}>משיכה מהעסק</Button>
            <Button variant="quiet" onClick={() => setRules(true)}>חלוקות</Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[22px] font-semibold">הכרטסת של {title}</h2>
          <Button variant="quiet" onClick={exportCsv}>ייצוא לאקסל</Button>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Segmented label="סוג תנועה" value={kind} onChange={setKind} options={KIND_FILTERS} />
          <div className="w-44"><MonthSelect value={from} onChange={setFrom} back={24} /></div>
          {from && <span className="text-[13px] text-mute">מהחודש הזה והלאה</span>}
        </div>

        {!rows.length && <Empty>{isBiz && !biz.has ? "כשתרשמו הוצאה מהאשראי של העסק או הכנסה שנכנסה לחשבון, היא תופיע כאן." : "אין תנועות בטווח הזה."}</Empty>}
        {!!rows.length && (
          <>
            <div className="sm:hidden">
              {from && <div className="row-line flex justify-between py-2 text-[14px] text-mute"><span>יתרת פתיחה</span><Balance n={opening} biz={isBiz} /></div>}
              {rows.map((r) => <LineCard key={r.key} r={r} biz={isBiz} />)}
            </div>
            <div className="-mx-2 hidden overflow-x-auto sm:block">
              <table className="w-full text-[14px]">
                <thead className="text-[13px] text-mute">
                  <tr>
                    <th className="px-2 py-2 text-start font-normal">תאריך</th>
                    <th className="px-2 py-2 text-start font-normal">פירוט</th>
                    <th className="px-2 py-2 text-end font-normal">{isBiz ? "יצא" : "חובה"}</th>
                    <th className="px-2 py-2 text-end font-normal">{isBiz ? "נכנס" : "זכות"}</th>
                    <th className="px-2 py-2 text-end font-normal">יתרה</th>
                  </tr>
                </thead>
                <tbody>
                  {from && (
                    <tr className="border-t border-[var(--line)] text-mute">
                      <td className="px-2 py-2" /><td className="px-2 py-2">יתרת פתיחה</td><td /><td />
                      <td className="px-2 py-2 text-end"><Balance n={opening} biz={isBiz} /></td>
                    </tr>
                  )}
                  {rows.map((r) => <LineRow key={r.key} r={r} biz={isBiz} />)}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="mt-4 text-[13px] text-mute-2">
          {isBiz ? "יתרת החשבון לפי מה שנרשם במערכת. כדאי להשוות מדי פעם לדף הבנק."
            : <>זכות: מה ששילמה מכיסה בשביל העסק, מה שהפקידה, והחלק שלה מכל הכנסה. חובה: החלק שלה בכל הוצאה, וכסף של העסק שהגיע אליה (תשלום מלקוח או משיכה). הכל לפני מע״מ.
              {cutoff && <> עד <Num>{date(cutoff)}</Num> הכל לפי החלוקה הישנה (50/50 ופרויקטים לפי מה שהיה). מאז הוצאות לפי חלוקת העסק, והכנסות לפי החלוקה של הפרויקט.</>}</>}
        </p>
      </Card>

      <Modal open={!!settle} onClose={() => setSettle(null)} title={settle?.from === BIZ ? "משיכה מחשבון העסק" : "רישום העברה ביניכן"}>
        {settle && <SettlementForm from={settle.from} to={settle.to} amount={settle.amount} onDone={() => setSettle(null)} />}
      </Modal>
      <Modal open={rules} onClose={() => setRules(false)} title="חלוקות">
        <SplitRules />
      </Modal>
    </div>
  );
}

function Stat({ label, n }: { label: string; n: number }) {
  return <span className="flex justify-between gap-3"><span>{label}</span><Num className="text-bone">{money(round(n))}</Num></span>;
}

function metaOf(r: LedgerRow): string {
  const pct = `חלקה ${Number(r.share_pct ?? 0)}%`;
  return r.kind === "expense" ? `שילמה ${r.actor_id ? r.actor_name : "מחשבון העסק"} · ${money(r.total)} · ${pct}`
    : r.kind === "income" ? `${r.actor_id ? `התקבל אצל ${r.actor_name}` : "נכנס לחשבון העסק"} · ${money(r.total)} · ${pct}`
    : r.kind === "transfer" ? (r.actor_id === r.partner_id ? "העבירה לשותפה" : "קיבלה מהשותפה")
    : r.kind === "withdrawal" ? "משכה מחשבון העסק"
    : r.kind === "deposit" ? "הפקידה לחשבון העסק"
    : "שולם לרשות המסים מכיסה";
}

// Phone: one stacked row per movement.
function LineCard({ r, biz }: { r: Line; biz: boolean }) {
  const debit = r.debit > 0.004, credit = r.credit > 0.004;
  const [d, c] = biz ? ["יצא ", "נכנס "] : ["ח׳ ", "ז׳ "];
  return (
    <div className="row-line grid grid-cols-[1fr_auto] gap-x-3 py-2.5 text-[14px]">
      <span className="min-w-0">
        <span className="block truncate"><span className="text-mute">{KIND[r.kind as LedgerKind] ?? r.kind} · </span>{r.description}</span>
        <span className="block truncate text-[12px] text-mute"><Num>{date(r.on_date)}</Num>{r.project_name && <> · {r.project_name}</>} · {r.meta}</span>
      </span>
      <span className="text-end">
        <span className="block">
          {debit && <><span className="text-mute">{d}</span><Num>{money(round(r.debit))}</Num></>}
          {debit && credit && <br />}
          {credit && <><span className="text-mute">{c}</span><Num>{money(round(r.credit))}</Num></>}
        </span>
        <span className="block text-[12px] text-mute">יתרה <Balance n={r.balance} biz={biz} /></span>
      </span>
    </div>
  );
}

function LineRow({ r, biz }: { r: Line; biz: boolean }) {
  return (
    <tr className="border-t border-[var(--line)] align-top">
      <td className="whitespace-nowrap px-2 py-2.5 text-mute"><Num>{date(r.on_date)}</Num></td>
      <td className="px-2 py-2.5">
        <span className="block"><span className="text-mute">{KIND[r.kind as LedgerKind] ?? r.kind} · </span>{r.description}{r.project_name && <span className="text-mute"> · {r.project_name}</span>}</span>
        <span className="block text-[13px] text-mute">{r.meta}</span>
      </td>
      <td className="px-2 py-2.5 text-end">{r.debit > 0.004 && <Num>{money(round(r.debit))}</Num>}</td>
      <td className="px-2 py-2.5 text-end">{r.credit > 0.004 && <Num>{money(round(r.credit))}</Num>}</td>
      <td className="px-2 py-2.5 text-end"><Balance n={r.balance} biz={biz} /></td>
    </tr>
  );
}

function Balance({ n, biz }: { n: number; biz?: boolean }) {
  if (biz) return <Num className="whitespace-nowrap font-medium">{money(round(n))}</Num>;
  return <span className="whitespace-nowrap"><Num className="font-medium">{money(Math.abs(round(n)))}</Num> <span className="text-[12px] text-mute">{Math.abs(n) < 0.005 ? "" : n > 0 ? "זכ׳" : "ח׳"}</span></span>;
}

// The date the new split starts, the business share (expenses + income without a project) and each project's split.
function SplitRules() {
  const partners = usePartners();
  const shares = useShares();
  const fin = useFinancials();
  const settings = useLedgerSettings();
  const saveShares = useSaveShares();
  const savePartner = useSave("partners");
  const qc = useQueryClient();
  const list = partners.data ?? [];
  const [first, second] = list;
  const [biz, setBiz] = useState("");
  const [since, setSince] = useState("");
  useEffect(() => { if (first) setBiz(String(Number(first.business_share ?? 50))); }, [first?.business_share]);
  useEffect(() => { if (settings.data) setSince(settings.data.new_split_from); }, [settings.data?.new_split_from]);
  if (!first || !second) return <Loading />;

  const pctOf = (projectId: string) => Number(shares.data?.find((s) => s.project_id === projectId && s.partner_id === first.id)?.percent ?? 50);
  const hasFixed = (projectId: string) => !!shares.data?.some((s) => s.project_id === projectId && s.fixed_amount != null);
  const setProject = (projectId: string, pct: number) => saveShares.mutate([
    { project_id: projectId, partner_id: first.id, percent: pct, fixed_amount: null },
    { project_id: projectId, partner_id: second.id, percent: 100 - pct, fixed_amount: null },
  ]);
  const bizN = Number(biz);
  const dirty = bizN !== Number(first.business_share) || (!!since && since !== settings.data?.new_split_from);
  const projects = [...(fin.data ?? [])].filter((f) => f.status !== "archived" && f.status !== "closed")
    .sort((a, b) => Number(b.outstanding) - Number(a.outstanding) || a.name.localeCompare(b.name));

  return (
    <div className="grid gap-5">
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (!(bizN >= 0 && bizN <= 100)) return;
        await savePartner.mutateAsync({ id: first.id, values: { business_share: bizN } });
        await savePartner.mutateAsync({ id: second.id, values: { business_share: 100 - bizN } });
        if (since && since !== settings.data?.new_split_from) {
          must(await supabase.from("ledger_settings").update({ new_split_from: since }).eq("id", true));
          qc.invalidateQueries();
        }
      }}>
        <p className="text-[14px] text-mute">מהתאריך הזה, כל הוצאה וכל הכנסה שלא שייכת לפרויקט מתחלקות לפי החלוקה החדשה. מה שלפניו נשאר 50/50.</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40"><Field label="החל מ"><Input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></Field></div>
          <div className="w-28"><Field label={`${first.name} (%)`}><Input type="number" min="0" max="100" step="0.5" value={biz} onChange={(e) => setBiz(e.target.value)} /></Field></div>
          <p className="pb-3 text-[14px] text-mute">{second.name}: <Num>{bizN >= 0 && bizN <= 100 ? 100 - bizN : "?"}%</Num></p>
          <Button variant="ghost" disabled={savePartner.isPending || !dirty}>שמירה</Button>
        </div>
      </form>

      <div>
        <p className="mb-2 text-[14px] text-mute">תשלומים של פרויקט שמגיעים מהתאריך הזה מתחלקים לפי החלוקה שלו ({first.name} / {second.name}). תשלומים קודמים נשארים לפי מה שהיה.</p>
        <div className="max-h-[50dvh] overflow-y-auto">
          {projects.map((f) => {
            const pct = pctOf(f.project_id);
            const choice = hasFixed(f.project_id) ? "other" : pct === 62.5 ? "625" : pct === 50 ? "50" : "other";
            return (
              <div key={f.project_id} className="row-line flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 flex-1">
                  <Link to={`/projects/${f.project_id}`} className="block truncate hover:text-pink-soft">{f.name}</Link>
                  {Number(f.outstanding) > 0.005 && <span className="block text-[12px] text-mute">עוד לא שולם <Num>{money(f.outstanding)}</Num></span>}
                </span>
                {choice === "other" && <span className="text-[13px] text-mute">{hasFixed(f.project_id) ? "סכום קבוע" : `${pct}/${100 - pct}`}</span>}
                <div className="w-36"><Select aria-label={`חלוקה ב${f.name}`} value={choice}
                  onChange={(e) => e.target.value === "625" ? setProject(f.project_id, 62.5) : e.target.value === "50" ? setProject(f.project_id, 50) : undefined}>
                  <option value="625">62.5 / 37.5</option>
                  <option value="50">50 / 50</option>
                  <option value="other" disabled>אחר</option>
                </Select></div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
