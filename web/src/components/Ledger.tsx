import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useFinancials, useLedger, usePartners, useSave, useSaveShares, useShares, type LedgerKind, type LedgerRow } from "../lib/data";
import { date, money } from "../lib/format";
import { Button, Card, Empty, ErrorNote, Field, Input, Loading, Modal, MonthSelect, Num, Segmented, Select } from "./ui";
import { SettlementForm } from "./forms";

// Partner ledger (כרטסת). Every money event, oldest first, from one partner's side:
// זכות = she paid for the business, sent a transfer, or is entitled to part of an income.
// חובה = her share of an expense, or business money that reached her. A positive balance means she is owed.

const KIND: Record<LedgerKind, string> = { expense: "הוצאה", income: "הכנסה", transfer: "העברה", vat: "מע״מ" };
type KindFilter = "all" | LedgerKind;
const KIND_FILTERS: [KindFilter, string][] = [["all", "הכל"], ["income", "הכנסות"], ["expense", "הוצאות"], ["transfer", "העברות"]];

const round = (n: number) => Math.round(n * 100) / 100;
const side = (n: number) => (Math.abs(n) < 0.005 ? "מאוזנת" : n > 0 ? "זכות" : "חובה");

export function useLedgerTotals() {
  const ledger = useLedger();
  const partners = usePartners();
  return useMemo(() => (partners.data ?? []).map((p) => {
    const rows = (ledger.data ?? []).filter((r) => r.partner_id === p.id);
    const sum = (k: LedgerKind, f: "credit" | "debit") => rows.filter((r) => r.kind === k).reduce((s, r) => s + Number(r[f]), 0);
    return {
      id: p.id, name: p.name,
      balance: round(rows.reduce((s, r) => s + Number(r.credit) - Number(r.debit), 0)),
      paid: sum("expense", "credit") + sum("vat", "credit"), expenseShare: sum("expense", "debit"),
      entitled: sum("income", "credit"), received: sum("income", "debit"),
      sent: sum("transfer", "credit"), got: sum("transfer", "debit"),
    };
  }), [ledger.data, partners.data]);
}

// One calm line: who should transfer how much to settle up.
export function SettleLine({ totals }: { totals: ReturnType<typeof useLedgerTotals> }) {
  const owed = totals.find((t) => t.balance > 0.5);
  const owes = totals.find((t) => t.balance < -0.5);
  if (!owed || !owes) return <p className="text-[15px] text-mute">אתן מאוזנות.</p>;
  const amount = Math.min(owed.balance, -owes.balance);
  return <p className="text-[15px]">כדי להתאזן, {owes.name} מעבירה ל{owed.name} <Num className="font-semibold">{money(amount)}</Num></p>;
}

export function Ledger() {
  const ledger = useLedger();
  const partners = usePartners();
  const totals = useLedgerTotals();
  const [who, setWho] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [from, setFrom] = useState("");
  const [settle, setSettle] = useState(false);
  const [rules, setRules] = useState(false);
  useEffect(() => { if (!who && partners.data?.length) setWho(partners.data.find((p) => p.name === "מירי")?.id ?? partners.data[0].id); }, [partners.data, who]);

  const mine = useMemo(() => (ledger.data ?? []).filter((r) => r.partner_id === who), [ledger.data, who]);
  // From a chosen month on, the rows before it fold into one opening balance.
  const opening = useMemo(() => (from ? mine.filter((r) => r.on_date < `${from}-01`) : []).reduce((s, r) => s + Number(r.credit) - Number(r.debit), 0), [mine, from]);
  const rows = useMemo(() => mine.filter((r) => (!from || r.on_date >= `${from}-01`) && (kind === "all" || r.kind === kind || (kind === "expense" && r.kind === "vat"))), [mine, from, kind]);

  if (ledger.isLoading || partners.isLoading) return <Loading />;
  if (ledger.error) return <ErrorNote error={ledger.error} />;

  const me = totals.find((t) => t.id === who);
  const owed = totals.find((t) => t.balance > 0.5);
  const owes = totals.find((t) => t.balance < -0.5);
  const name = (id: string) => partners.data?.find((p) => p.id === id)?.name ?? "";

  function exportCsv() {
    const cell = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const line = (...v: unknown[]) => v.map(cell).join(",");
    const out = [line(`כרטסת ${name(who)}`), line("תאריך", "סוג", "תיאור", "פרויקט", "מי", "סכום מלא", "חלק %", "חובה", "זכות", "יתרה")];
    for (const r of mine) out.push(line(r.on_date, KIND[r.kind], r.description, r.project_name ?? "", r.actor_name ?? "", r.total, r.share_pct ?? "", round(r.debit), round(r.credit), r.balance));
    const blob = new Blob(["﻿" + out.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `aRLi-כרטסת-${name(who)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <div className="grid min-w-0 gap-6">
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          {totals.map((t) => (
            <button key={t.id} type="button" onClick={() => setWho(t.id)}
              className={`press rounded-2xl px-4 py-3 text-start text-[14px] shadow-[inset_0_0_0_1px_var(--line)] ${t.id === who ? "bg-[var(--ink-3)]/70 shadow-[inset_0_0_0_1px_var(--line-2)]" : ""}`}>
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-[16px] font-medium">{t.name}</span>
                <span className="text-mute">{side(t.balance)}</span>
              </span>
              <Num className={`mt-1 block text-[26px] font-semibold ${t.balance > 0.005 ? "text-pink-soft" : ""}`}>{money(Math.abs(t.balance))}</Num>
              <span className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[13px] text-mute">
                <span>שילמה מכיסה <Num className="text-bone">{money(round(t.paid))}</Num></span>
                <span>חלקה בהוצאות <Num className="text-bone">{money(round(t.expenseShare))}</Num></span>
                <span>מגיע לה מהכנסות <Num className="text-bone">{money(round(t.entitled))}</Num></span>
                <span>הכנסות שהגיעו אליה <Num className="text-bone">{money(round(t.received))}</Num></span>
              </span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <SettleLine totals={totals} />
          <div className="flex flex-wrap gap-2">
            {owed && owes && <Button variant="ghost" onClick={() => setSettle(true)}>רישום העברה</Button>}
            <Button variant="quiet" onClick={() => setRules(true)}>חלוקות</Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[22px] font-semibold">הכרטסת של {name(who)}</h2>
          <Button variant="quiet" onClick={exportCsv}>ייצוא לאקסל</Button>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Segmented label="סוג תנועה" value={kind} onChange={setKind} options={KIND_FILTERS} />
          <div className="w-44"><MonthSelect value={from} onChange={setFrom} back={24} /></div>
          {from && <span className="text-[13px] text-mute">מהחודש הזה והלאה</span>}
        </div>

        {!rows.length && <Empty>אין תנועות בטווח הזה.</Empty>}
        {!!rows.length && (
          <>
          <div className="sm:hidden">
            {from && <div className="row-line flex justify-between py-2 text-[14px] text-mute"><span>יתרת פתיחה</span><Balance n={opening} /></div>}
            {rows.map((r) => <LedgerCard key={`${r.kind}-${r.ref_id}`} r={r} />)}
          </div>
          <div className="-mx-2 hidden overflow-x-auto sm:block">
            <table className="w-full text-[14px]">
              <thead className="text-[13px] text-mute">
                <tr>
                  <th className="px-2 py-2 text-start font-normal">תאריך</th>
                  <th className="px-2 py-2 text-start font-normal">פירוט</th>
                  <th className="px-2 py-2 text-end font-normal">חובה</th>
                  <th className="px-2 py-2 text-end font-normal">זכות</th>
                  <th className="px-2 py-2 text-end font-normal">יתרה</th>
                </tr>
              </thead>
              <tbody>
                {from && (
                  <tr className="border-t border-[var(--line)] text-mute">
                    <td className="px-2 py-2" />
                    <td className="px-2 py-2">יתרת פתיחה</td>
                    <td /><td />
                    <td className="px-2 py-2 text-end"><Balance n={opening} /></td>
                  </tr>
                )}
                {rows.map((r) => <LedgerLine key={`${r.kind}-${r.ref_id}`} r={r} />)}
              </tbody>
            </table>
          </div>
          </>
        )}
        <p className="mt-4 text-[13px] text-mute-2">
          זכות: מה ששילמה בשביל העסק, העברות ששלחה, והחלק שלה מכל הכנסה. חובה: החלק שלה בכל הוצאה, וכסף של העסק שהגיע אליה.
          הכל לפני מע״מ, חוץ מהכסף שעבר בפועל. {me && <>יתרה {side(me.balance)} של <Num>{money(Math.abs(me.balance))}</Num>.</>}
        </p>
      </Card>

      <Modal open={settle} onClose={() => setSettle(false)} title="רישום העברה ביניכן">
        {owed && owes && <SettlementForm from={owes.id} to={owed.id} amount={Math.min(owed.balance, -owes.balance)} onDone={() => setSettle(false)} />}
      </Modal>
      <Modal open={rules} onClose={() => setRules(false)} title="חלוקות">
        <SplitRules />
      </Modal>
    </div>
  );
}

function metaOf(r: LedgerRow): string {
  return r.kind === "expense" ? `שילמה ${r.actor_name ?? "?"} · ${money(r.total)} · חלקה ${Number(r.share_pct ?? 0)}%`
    : r.kind === "income" ? `התקבל אצל ${r.actor_name ?? "?"} · ${money(r.total)} · חלקה ${Number(r.share_pct ?? 0)}%`
    : r.kind === "transfer" ? (r.actor_id === r.partner_id ? "העבירה לשותפה" : "קיבלה מהשותפה")
    : "שולם לרשות המסים";
}

// Phone: one stacked row per movement.
function LedgerCard({ r }: { r: LedgerRow }) {
  const debit = Number(r.debit) > 0.004, credit = Number(r.credit) > 0.004;
  return (
    <div className="row-line grid grid-cols-[1fr_auto] gap-x-3 py-2.5 text-[14px]">
      <span className="min-w-0">
        <span className="block truncate"><span className="text-mute">{KIND[r.kind]} · </span>{r.description}</span>
        <span className="block truncate text-[12px] text-mute"><Num>{date(r.on_date)}</Num>{r.project_name && <> · {r.project_name}</>} · {metaOf(r)}</span>
      </span>
      <span className="text-end">
        <span className="block">{debit && <span className="text-mute">ח׳ </span>}{debit && <Num>{money(round(r.debit))}</Num>}{debit && credit && <br />}{credit && <span className="text-mute">ז׳ </span>}{credit && <Num>{money(round(r.credit))}</Num>}</span>
        <span className="block text-[12px] text-mute">יתרה <Balance n={Number(r.balance)} /></span>
      </span>
    </div>
  );
}

function LedgerLine({ r }: { r: LedgerRow }) {
  const meta = metaOf(r);
  return (
    <tr className="border-t border-[var(--line)] align-top">
      <td className="whitespace-nowrap px-2 py-2.5 text-mute"><Num>{date(r.on_date)}</Num></td>
      <td className="px-2 py-2.5">
        <span className="block"><span className="text-mute">{KIND[r.kind]} · </span>{r.description}{r.project_name && <span className="text-mute"> · {r.project_name}</span>}</span>
        <span className="block text-[13px] text-mute">{meta}</span>
      </td>
      <td className="px-2 py-2.5 text-end">{Number(r.debit) > 0.004 && <Num>{money(round(r.debit))}</Num>}</td>
      <td className="px-2 py-2.5 text-end">{Number(r.credit) > 0.004 && <Num>{money(round(r.credit))}</Num>}</td>
      <td className="px-2 py-2.5 text-end"><Balance n={Number(r.balance)} /></td>
    </tr>
  );
}

function Balance({ n }: { n: number }) {
  return <span className="whitespace-nowrap"><Num className="font-medium">{money(Math.abs(round(n)))}</Num> <span className="text-[12px] text-mute">{Math.abs(n) < 0.005 ? "" : n > 0 ? "זכ׳" : "ח׳"}</span></span>;
}

// The business share (expenses + income without a project) and each project's split, in one place.
function SplitRules() {
  const partners = usePartners();
  const shares = useShares();
  const fin = useFinancials();
  const saveShares = useSaveShares();
  const savePartner = useSave("partners");
  const list = partners.data ?? [];
  const [first, second] = list;
  const [biz, setBiz] = useState("");
  useEffect(() => { if (first) setBiz(String(Number(first.business_share ?? 50))); }, [first?.business_share]);
  if (!first || !second) return <Loading />;

  const pctOf = (projectId: string) => Number(shares.data?.find((s) => s.project_id === projectId && s.partner_id === first.id)?.percent ?? 50);
  const hasFixed = (projectId: string) => !!shares.data?.some((s) => s.project_id === projectId && s.fixed_amount != null);
  const setProject = (projectId: string, pct: number) => saveShares.mutate([
    { project_id: projectId, partner_id: first.id, percent: pct, fixed_amount: null },
    { project_id: projectId, partner_id: second.id, percent: 100 - pct, fixed_amount: null },
  ]);
  const bizN = Number(biz);
  const projects = [...(fin.data ?? [])].sort((a, b) => Number(b.income) - Number(a.income) || a.name.localeCompare(b.name));

  return (
    <div className="grid gap-5">
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        if (!(bizN >= 0 && bizN <= 100)) return;
        await savePartner.mutateAsync({ id: first.id, values: { business_share: bizN } });
        await savePartner.mutateAsync({ id: second.id, values: { business_share: 100 - bizN } });
      }}>
        <p className="text-[14px] text-mute">כל הוצאה, וכל הכנסה שלא שייכת לפרויקט, מתחלקת לפי החלוקה הזו.</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-32"><Field label={`${first.name} (%)`}><Input type="number" min="0" max="100" step="0.5" value={biz} onChange={(e) => setBiz(e.target.value)} /></Field></div>
          <p className="pb-3 text-[14px] text-mute">{second.name}: <Num>{bizN >= 0 && bizN <= 100 ? 100 - bizN : "?"}%</Num></p>
          <Button variant="ghost" disabled={savePartner.isPending || bizN === Number(first.business_share)}>שמירה</Button>
        </div>
      </form>

      <div>
        <p className="mb-2 text-[14px] text-mute">הכנסה של פרויקט מתחלקת לפי החלוקה שלו ({first.name} / {second.name}).</p>
        <div className="max-h-[50dvh] overflow-y-auto">
          {projects.map((f) => {
            const pct = pctOf(f.project_id);
            const choice = hasFixed(f.project_id) ? "other" : pct === 62.5 ? "625" : pct === 50 ? "50" : "other";
            return (
              <div key={f.project_id} className="row-line flex flex-wrap items-center justify-between gap-2 py-2">
                <Link to={`/projects/${f.project_id}`} className="min-w-0 flex-1 truncate hover:text-pink-soft">{f.name}</Link>
                {choice === "other"
                  ? <span className="text-[13px] text-mute">{hasFixed(f.project_id) ? "סכום קבוע" : `${pct}/${100 - pct}`} · <Link className="text-pink" to={`/projects/${f.project_id}`}>לעריכה</Link></span>
                  : null}
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
