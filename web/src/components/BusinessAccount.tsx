import { useMemo, useState } from "react";
import { BIZ, BIZ_NAME, useBusinessLedger, usePartners, type BusinessRow } from "../lib/data";
import { date, money } from "../lib/format";
import { Button, Card, Empty, ErrorNote, Loading, Modal, MonthSelect, Num, Segmented } from "./ui";
import { SettlementForm, useBizFrom } from "./forms";
import { KIND, LineCard, LineRow, round, type Line } from "./Ledger";

// The business's own account: the bank account and the business credit card. It belongs to neither partner.
// Money in: client payments that reached the account, and partner deposits. Money out: card expenses, taxes,
// and withdrawals to a partner. The partners' ledger (כרטסת) is a separate tab.

type Filter = "all" | "in" | "out" | "moves";
const FILTERS: [Filter, string][] = [["all", "הכל"], ["in", "נכנס"], ["out", "יצא"], ["moves", "משיכות והפקדות"]];
const pass = (r: BusinessRow, f: Filter) =>
  f === "all" || (f === "in" && Number(r.amount_in) > 0) || (f === "out" && Number(r.amount_out) > 0) || (f === "moves" && (r.kind === "withdrawal" || r.kind === "deposit"));

const META: Record<BusinessRow["kind"], string> = {
  income: "תשלום מלקוח שנכנס לחשבון", expense: "שולם באשראי / מהחשבון", tax: "תשלום לרשויות מהחשבון",
  withdrawal: "משיכה לשותפה", deposit: "הפקדה של שותפה",
};

export function BusinessAccount() {
  const ledger = useBusinessLedger();
  const partners = usePartners();
  const opened = useBizFrom();
  const [month, setMonth] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [move, setMove] = useState<null | { from: string; to: string }>(null);

  const all = ledger.data ?? [];
  const balance = all.length ? Number(all[all.length - 1].balance) : 0;
  const inMonth = (r: BusinessRow) => !month || r.on_date.startsWith(month);
  const sums = useMemo(() => {
    const rows = all.filter(inMonth);
    const s = (k: BusinessRow["kind"][], f: "amount_in" | "amount_out") => round(rows.filter((r) => k.includes(r.kind)).reduce((t, r) => t + Number(r[f]), 0));
    return { income: s(["income"], "amount_in"), spent: s(["expense", "tax"], "amount_out"), out: s(["withdrawal"], "amount_out"), in: s(["deposit"], "amount_in") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, month]);
  const opening = useMemo(() => (month ? all.filter((r) => r.on_date < `${month}-01`) : []).reduce((t, r) => t + Number(r.amount_in) - Number(r.amount_out), 0), [all, month]);
  const rows: Line[] = useMemo(() => all.filter((r) => inMonth(r) && pass(r, filter)).map((r) => ({
    key: `${r.kind}-${r.ref_id}`, on_date: r.on_date, kind: r.kind, description: r.description, meta: META[r.kind],
    debit: Number(r.amount_out), credit: Number(r.amount_in), balance: Number(r.balance),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })).reverse(), [all, month, filter]);

  if (ledger.isLoading) return <Loading />;
  if (ledger.error) return <ErrorNote error={ledger.error} />;
  const first = partners.data?.[0]?.id ?? "";

  return (
    <div className="grid min-w-0 gap-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[14px] text-mute">{BIZ_NAME} · בנק ואשראי עסקי · פעיל מ-<Num>{date(opened)}</Num></p>
            <Num className={`mt-1 block text-[34px] font-semibold ${balance < -0.005 ? "text-error" : ""}`}>{money(round(balance))}</Num>
            <p className="text-[13px] text-mute-2">היתרה לפי מה שנרשם. כדאי להשוות מדי פעם לדף הבנק.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setMove({ from: first, to: BIZ })}>הפקדה לחשבון</Button>
            <Button variant="ghost" onClick={() => setMove({ from: BIZ, to: first })}>משיכה מהחשבון</Button>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="נכנס מלקוחות" n={sums.income} />
          <Tile label="הוצאות באשראי ומסים" n={sums.spent} />
          <Tile label="הופקד ע״י שותפות" n={sums.in} />
          <Tile label="נמשך לשותפות" n={sums.out} />
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="me-auto text-[22px] font-semibold">דף תנועות</h2>
          <Segmented label="סוג תנועה" value={filter} onChange={setFilter} options={FILTERS} />
          <div className="w-44"><MonthSelect value={month} onChange={setMonth} back={24} /></div>
        </div>
        {!rows.length && <Empty>{all.length ? "אין תנועות בטווח הזה." : "כשתרשמו הוצאה באשראי של העסק, או תשלום מלקוח שנכנס לחשבון, הוא יופיע כאן."}</Empty>}
        {!!rows.length && (
          <>
            <div className="sm:hidden">{rows.map((r) => <LineCard key={r.key} r={r} biz />)}</div>
            <div className="-mx-2 hidden overflow-x-auto sm:block">
              <table className="w-full text-[14px]">
                <thead className="text-[13px] text-mute">
                  <tr>
                    <th className="px-2 py-2 text-start font-normal">תאריך</th>
                    <th className="px-2 py-2 text-start font-normal">פירוט</th>
                    <th className="px-2 py-2 text-end font-normal">יצא</th>
                    <th className="px-2 py-2 text-end font-normal">נכנס</th>
                    <th className="px-2 py-2 text-end font-normal">יתרה</th>
                  </tr>
                </thead>
                <tbody>{rows.map((r) => <LineRow key={r.key} r={r} biz />)}</tbody>
              </table>
            </div>
            {month && <p className="mt-3 text-[13px] text-mute">יתרה בתחילת החודש <Num className="text-bone">{money(round(opening))}</Num></p>}
          </>
        )}
        <p className="mt-4 text-[13px] text-mute-2">
          מה שנרשם על {BIZ_NAME} לא נזקף לאף אחת מכן כ״שילמה מכיסה״. בכרטסת כל אחת נושאת רק את החלק שלה בהוצאה.
          {" "}{KIND.withdrawal} מהחשבון נרשמת אצל השותפה שקיבלה, ו{KIND.deposit} נרשמת לזכותה.
        </p>
      </Card>

      <Modal open={!!move} onClose={() => setMove(null)} title={move?.from === BIZ ? "משיכה מחשבון העסק" : "הפקדה לחשבון העסק"}>
        {move && <SettlementForm from={move.from} to={move.to} onDone={() => setMove(null)} />}
      </Modal>
    </div>
  );
}

function Tile({ label, n }: { label: string; n: number }) {
  return (
    <div className="rounded-2xl px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]">
      <p className="text-[13px] text-mute">{label}</p>
      <Num className="mt-1 block text-[20px] font-semibold">{money(n)}</Num>
    </div>
  );
}
