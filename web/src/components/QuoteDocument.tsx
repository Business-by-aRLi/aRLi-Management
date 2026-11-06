// aRLi's quote as the client sees it: a paper document in the brand's design (hairlines, one pink, one peak at the price).
// Used for the live preview while editing and for the public page the client opens.
import type { ReactNode } from "react";
import type { QuoteItem, QuoteSection } from "../lib/data";
import { date, money, quoteTotals } from "../lib/format";

export type QuoteDocData = {
  number: string; recipient_name: string | null; title: string; intro: string | null; sections: QuoteSection[];
  issued_on: string; valid_until: string; discount_type: string; discount_value: number; include_vat: boolean; vat_rate: number;
  payment_terms: string | null; timeline: string | null; items: QuoteItem[];
};

export function QuoteDocument({ q, children }: { q: QuoteDocData; children?: ReactNode }) {
  const t = quoteTotals(q.items, q.discount_type, q.discount_value, q.include_vat, q.vat_rate);
  const oneTime = q.items.filter((i) => !i.recurring && i.description.trim());
  const monthly = q.items.filter((i) => i.recurring && i.description.trim());
  const sections = q.sections.filter((s) => s.title.trim() && s.body.trim());
  const days = Math.max(0, Math.round((new Date(`${q.valid_until}T12:00:00`).getTime() - new Date(`${q.issued_on}T12:00:00`).getTime()) / 86_400_000));
  let n = 0;
  const num = () => String(++n).padStart(2, "0");
  return (
    <article className="qdoc">
      <div className="q-page">
        <div className="q-top">
          <span className="q-logo" aria-label="aRLi">aRL<i>i</i></span>
          <div className="q-meta"><span>הצעת מחיר <bdi>{q.number}</bdi></span><bdi>{date(q.issued_on)}</bdi><span>בתוקף {days} יום</span></div>
        </div>

        <div className="q-hero">
          <div className="q-for">{q.recipient_name && <>עבור<b>{q.recipient_name}</b></>}</div>
          <div>
            <h1>{q.title || "כותרת ההצעה"}</h1>
            {q.intro && <p className="q-lead">{q.intro}</p>}
          </div>
        </div>

        {sections.map((s, i) => (
          <div className="q-sec" key={i}>
            <h2><span className="n">{num()}</span>{s.title}</h2>
            <p className="q-body">{s.body}</p>
          </div>
        ))}

        <div className="q-sec">
          <h2><span className="n">{num()}</span>המחיר</h2>
          <div>
            {oneTime.length > 1 && (
              <table className="q-items"><tbody>
                {oneTime.map((i, k) => (
                  <tr key={k}>
                    <td>{i.description}{Number(i.quantity) !== 1 && <> <bdi className="num">× {i.quantity}</bdi></>}{i.details && <small>{i.details}</small>}</td>
                    <td className="v"><bdi>{money(Number(i.quantity) * Number(i.unit_price))}</bdi></td>
                  </tr>
                ))}
              </tbody></table>
            )}
            {(t.discount > 0 || q.include_vat) && (
              <div className="q-sum">
                <span>סה״כ לפני {t.discount > 0 ? "הנחה" : "מע״מ"}</span><b><bdi>{money(t.subtotal)}</bdi></b>
                {t.discount > 0 && <><span>הנחה{q.discount_type === "percent" ? ` ${q.discount_value}%` : ""}</span><b><bdi>−{money(t.discount)}</bdi></b></>}
                {q.include_vat && <><span>מע״מ {q.vat_rate}%</span><b><bdi>{money(t.vat)}</bdi></b></>}
              </div>
            )}
            <div className="q-price">
              <div className="what">
                {oneTime.length === 1 ? oneTime[0].description : "סה״כ להצעה"}
                <small>{oneTime.length === 1 && oneTime[0].details ? oneTime[0].details : "תשלום חד-פעמי"}{q.include_vat ? ", כולל מע״מ" : ""}</small>
              </div>
              <div className="amt"><bdi>{money(t.total).replace(" ₪", "")}</bdi><span style={{ fontSize: ".45em" }}>₪</span></div>
              {q.payment_terms && <p className="terms"><b>תנאי תשלום:</b> {q.payment_terms}</p>}
            </div>
            {monthly.length > 0 && (
              <div className="q-extras">
                {monthly.map((i, k) => <span key={k}>{i.description}: <bdi>{money(Number(i.quantity) * Number(i.unit_price))}</bdi> לחודש{i.details ? ` · ${i.details}` : ""}</span>)}
              </div>
            )}
          </div>
        </div>

        {q.timeline && (
          <div className="q-sec">
            <h2><span className="n">{num()}</span>לוח זמנים</h2>
            <p className="q-body">{q.timeline}</p>
          </div>
        )}

        {children}

        <div className="q-foot"><span>ארלי · מערכות AI ואוטומציות לעסקים</span><bdi>arli.co.il</bdi></div>
      </div>
    </article>
  );
}
